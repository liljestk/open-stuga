export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for direct TP-Link bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
