import { sha256 } from "./runtime.mjs";

const targetPattern = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/u;

export function validateSshTarget(target) {
  if (typeof target !== "string" || target.startsWith("-") || !targetPattern.test(target)) {
    throw new Error("--target must be an SSH host or USER@HOST without spaces or options");
  }
  return target;
}

export function targetSelectorSha256(target) {
  return sha256(validateSshTarget(target).trim());
}
