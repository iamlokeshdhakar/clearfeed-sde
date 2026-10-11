import { expect, test } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
} from "../src/lib/testing/fixtures";

let companyId: string;

test.beforeAll(async () => {
  const company = await createCompany({
    name: "E2E Coverage Co",
    supportTimezone: "UTC",
    maxActiveTicketsPerAgent: 3,
  });
  companyId = company.id;
  await createAgent(companyId, { name: "E2E Agent" });
  // Required hours span the whole of Monday, so the page starts fully gapped.
  await prisma.requiredSupportHours.create({
    data: { companyId, dayOfWeek: 1, startMinute: 0, endMinute: 23 * 60 + 59 },
  });
});

test.afterAll(async () => {
  await cleanupCompany(companyId);
  await prisma.$disconnect();
});

/**
 * Reads the total gap minutes from the "Uncovered Gap Breakdown" heading,
 * e.g. "Uncovered Gap Breakdown (7 gaps · 1439 mins)". This is the one place
 * the page always renders the current total, regardless of whether the gap
 * list itself or the "Perfect Support Coverage!" empty state is showing.
 */
async function readTotalGapMinutes(
  page: import("@playwright/test").Page,
): Promise<number> {
  const heading = page.getByRole("heading", {
    name: /Uncovered Gap Breakdown/,
  });
  await expect(heading).toBeVisible();
  const text = await heading.textContent();
  const match = text?.match(/·\s*(\d+)\s*mins\)/);
  return match ? Number(match[1]) : Number.NaN;
}

test("creating an overnight window shows its marker and shrinks a coverage gap", async ({
  page,
}) => {
  await page.goto(`/companies/${companyId}/coverage`);
  const initialMinutes = await readTotalGapMinutes(page);
  expect(initialMinutes).toBeGreaterThan(0);

  await page.goto(`/companies/${companyId}/availability`);
  await page.getByRole("button", { name: "Add Availability Window" }).click();
  await page.getByRole("checkbox", { name: "Monday" }).check();
  await page.getByLabel("Start Time").fill("22:00");
  await page.getByLabel("End Time").fill("06:00");
  await page.getByLabel("Shift Timezone").click();
  await page.getByPlaceholder("Search timezones...").fill("Europe/London");
  await page
    .getByRole("option", { name: "Europe/London", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "E2E Agent" }).check();
  await page.getByRole("button", { name: "Save Window" }).click();

  await expect(page.getByText("22:00 – 06:00")).toBeVisible();
  // exact: the dialog's own helper text ("Overnight Window: shift wraps
  // around...") can still be present in the DOM after closing and would
  // otherwise match too; this targets the card's Overnight badge specifically.
  await expect(page.getByText("Overnight", { exact: true })).toBeVisible();

  await page.goto(`/companies/${companyId}/coverage`);
  await expect
    .poll(() => readTotalGapMinutes(page))
    .toBeLessThan(initialMinutes);
});
