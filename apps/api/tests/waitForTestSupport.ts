import { expect, vi } from "vitest";

/**
 * One budget for waits on spawned helper processes and background loops: a
 * loaded machine slows the child process, not the behaviour under test. It
 * stays under Vitest's 5 s test timeout so a miss reports the condition.
 */
export const CHILD_PROCESS_TIMEOUT_MS = 4_000;

/** Resolves once `predicate` holds, polling every 10 ms, and fails after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = CHILD_PROCESS_TIMEOUT_MS): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 10 });
}
