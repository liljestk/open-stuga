import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function isWindowsDirectorySyncUnsupported(error: unknown): boolean {
  if (process.platform !== "win32" || !(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(String(error.code));
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Windows does not consistently permit opening or flushing directory
    // handles. The file itself was still flushed before the atomic rename.
    if (!isWindowsDirectorySyncUnsupported(error)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Persist a new file without exposing partial contents. The payload reaches
 * stable storage before the rename, and the directory entry is then flushed
 * where the platform supports directory fsync.
 */
export function durableAtomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; mode?: number } = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", options.mode ?? 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, data, options.encoding ? { encoding: options.encoding } : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    temporaryExists = false;
    syncDirectory(directory);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists && existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
