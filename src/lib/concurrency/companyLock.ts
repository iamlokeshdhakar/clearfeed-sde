const DEFAULT_WAIT_TIMEOUT_MS = 2000;

const queues = new Map<string, Promise<void>>();

export class CompanyLockTimeoutError extends Error {
  constructor(companyId: string) {
    super(`Timed out waiting for the company lock: ${companyId}`);
    this.name = "CompanyLockTimeoutError";
  }
}

export interface WithCompanyLockOptions {
  /** Overridable for tests; production callers keep the 2-second default. */
  waitTimeoutMs?: number;
}

/**
 * Serializes work per company through an in-process FIFO queue.
 *
 * A caller waits at most `waitTimeoutMs` for its turn; the wait timer never
 * runs once `fn` has started. A caller that times out never runs `fn`, never
 * releases the current holder, and never lets later callers pass the actual
 * holder: its slot in the chain is a pass-through to whoever it was really
 * waiting on.
 */
export function withCompanyLock<T>(
  companyId: string,
  fn: () => Promise<T>,
  options: WithCompanyLockOptions = {},
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const myGate = queues.get(companyId) ?? Promise.resolve();

  let settleMyTail: () => void;
  const myTail = new Promise<void>((resolve) => {
    settleMyTail = resolve;
  });
  queues.set(companyId, myTail);

  return new Promise<T>((resolveOuter, rejectOuter) => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Pass our slot through to whatever we were actually waiting on, so
      // later callers still wait for the real holder instead of being
      // released early or stuck forever behind us.
      myGate.then(settleMyTail);
      rejectOuter(new CompanyLockTimeoutError(companyId));
    }, waitTimeoutMs);

    myGate.then(async () => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      try {
        const result = await fn();
        resolveOuter(result);
      } catch (error) {
        rejectOuter(error);
      } finally {
        settleMyTail();
      }
    });
  });
}
