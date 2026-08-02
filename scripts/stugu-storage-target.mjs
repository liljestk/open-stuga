import { readFileSync } from "node:fs";
import { join } from "node:path";

export function assertStorageTarget(root, expectedTargetId) {
  const expected = expectedTargetId?.trim() ?? "";
  if (!expected) return;
  if (!/^[0-9a-f-]{36}$/iu.test(expected)) throw new Error("Configured backup storage target id is invalid");
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(join(root, ".stugu-storage-target.json"), "utf8"));
  } catch {
    throw new Error("Configured backup storage is not mounted");
  }
  if (sentinel?.schema !== "stugu-storage-target/v1"
    || sentinel.targetId !== expected || sentinel.kind !== "backups") {
    throw new Error("Mounted backup storage does not match the configured target");
  }
}
