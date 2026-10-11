import { describe, expect, it } from "vitest";
import { CompanyLockTimeoutError, withCompanyLock } from "./companyLock";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withCompanyLock", () => {
  it("serializes calls for the same company", async () => {
    const events: string[] = [];
    const companyId = `co-${Math.random()}`;

    const first = withCompanyLock(companyId, async () => {
      events.push("first-start");
      await delay(30);
      events.push("first-end");
    });
    const second = withCompanyLock(companyId, async () => {
      events.push("second-start");
      await delay(5);
      events.push("second-end");
    });

    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("does not serialize calls for different companies", async () => {
    const events: string[] = [];

    const a = withCompanyLock(`co-a-${Math.random()}`, async () => {
      events.push("a-start");
      await delay(30);
      events.push("a-end");
    });
    const b = withCompanyLock(`co-b-${Math.random()}`, async () => {
      events.push("b-start");
      await delay(5);
      events.push("b-end");
    });

    await Promise.all([a, b]);
    // b finishes before a because they run concurrently on separate locks.
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });

  it("rejects a waiter that exceeds the wait timeout and never runs its work", async () => {
    const companyId = `co-${Math.random()}`;
    let secondRan = false;

    const holder = withCompanyLock(companyId, async () => {
      await delay(100);
    });
    const waiter = withCompanyLock(
      companyId,
      async () => {
        secondRan = true;
      },
      { waitTimeoutMs: 20 },
    );

    await expect(waiter).rejects.toBeInstanceOf(CompanyLockTimeoutError);
    await holder;
    expect(secondRan).toBe(false);
  });

  it("still waits for the real holder when a caller ahead of it timed out", async () => {
    const companyId = `co-${Math.random()}`;
    const events: string[] = [];

    const holder = withCompanyLock(companyId, async () => {
      events.push("holder-start");
      await delay(80);
      events.push("holder-end");
    });
    const timedOutWaiter = withCompanyLock(
      companyId,
      async () => {
        events.push("should-never-run");
      },
      { waitTimeoutMs: 10 },
    );
    const laterCaller = withCompanyLock(companyId, async () => {
      events.push("later-start");
    });

    await expect(timedOutWaiter).rejects.toBeInstanceOf(
      CompanyLockTimeoutError,
    );
    await Promise.all([holder, laterCaller]);

    expect(events).toEqual(["holder-start", "holder-end", "later-start"]);
  });

  it("releases the lock for the next caller even when the holder's work throws", async () => {
    const companyId = `co-${Math.random()}`;
    let secondRan = false;

    await expect(
      withCompanyLock(companyId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await withCompanyLock(companyId, async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(true);
  });
});
