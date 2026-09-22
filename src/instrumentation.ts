declare global {
  var __retryWorkerInterval: ReturnType<typeof setInterval> | undefined;
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Guards against re-registering a second interval on `next dev` hot
  // reloads: `register()` isn't documented to be a strict per-process
  // singleton, so we defend with a global flag the same way the Prisma
  // client singleton does.
  if (globalThis.__retryWorkerInterval) {
    return;
  }

  const { runRetrySweep, RETRY_INTERVAL_MS } = await import(
    "@/lib/retry/batchProcessor"
  );

  globalThis.__retryWorkerInterval = setInterval(() => {
    runRetrySweep().catch((error) => {
      console.error("[retry-worker] scheduled sweep failed", error);
    });
  }, RETRY_INTERVAL_MS);
}
