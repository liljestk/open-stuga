import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));

export function privateAdaptivePath(value: string): string {
  const path = resolve(value);
  const within = relative(checkout, path);
  const outside = within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within);
  if (!isAbsolute(value) || !outside) throw new Error("Use absolute paths and keep private evaluation files and databases outside the checkout");
  return path;
}
