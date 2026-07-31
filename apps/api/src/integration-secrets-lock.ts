import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export function pendingIntegrationSecretsPath(path: string): string {
  return `${path}.pending`;
}

export function withIntegrationSecretsLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${process.pid}:${randomUUID()}\n`, { encoding: "utf8" });
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        descriptor = null;
        try { unlinkSync(lockPath); } catch { /* Preserve the lock initialization error. */ }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ownerText = readFileSync(lockPath, "utf8");
        const owner = Number.parseInt(ownerText.trim(), 10);
        const ownerRecorded = Number.isSafeInteger(owner) && owner > 0;
        let ownerAlive = true;
        if (ownerRecorded) {
          try { process.kill(owner, 0); } catch (ownerError) {
            ownerAlive = (ownerError as NodeJS.ErrnoException).code === "EPERM";
          }
        }
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if ((ownerRecorded && !ownerAlive)
          || age > (ownerRecorded ? STALE_LOCK_MS : LOCK_TIMEOUT_MS)) {
          if (readFileSync(lockPath, "utf8") === ownerText) unlinkSync(lockPath);
          continue;
        }
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting to update the integration secrets file");
      Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch { /* A stale-lock recovery may already have removed it. */ }
  }
}
