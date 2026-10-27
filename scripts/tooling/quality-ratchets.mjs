import { capture } from "./runtime.mjs";

// Shared rules for the code-quality ratchets. A baseline records legacy debt
// that may shrink but never grow: the checks compare the worktree against the
// baseline, and the baseline against the copy committed at the merge base.

// Mechanically split modules carry a sequence number instead of a domain name:
// `part-02.ts`, `07-route-handlers.ts`, `setup.part-02.test.mjs`,
// `paths-03.ts` and `Page.02-page-2.test.tsx`. Ordered system files such as
// udev rules and patch series use other extensions.
const NUMBERED_NAME = /(?:^(?:part-?\d+|\d{2,}-)|[.-]part-?\d+[.-]|-\d{2,}\.(?:[cm]?[jt]sx?|s?css|py)$|\.\d{2,}(?:-|\.test\.))/u;
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?|s?css|py)$/u;

export function isNumberedModule(path) {
  const name = path.split("/").at(-1);
  return MODULE_EXTENSION.test(name) && NUMBERED_NAME.test(name);
}

/**
 * `baseFiles` lists every file at the merge base. A path may join the baseline
 * only when it existed there: old debt a widened detector now sees, not a new
 * module.
 */
export function numberedModuleViolations({ found, legacy, maximum, baseLegacy = null, baseFiles = null, baselinePath }) {
  const violations = [];
  const present = new Set(found);
  const allowed = new Set(legacy);
  for (const path of found) {
    if (!allowed.has(path)) {
      violations.push(`${path}: new numbered module; name the module after the domain it owns`);
    }
  }
  for (const path of legacy) {
    if (!present.has(path)) {
      violations.push(`${path}: legacy numbered module is gone; remove it from ${baselinePath}`);
    }
  }
  if (found.length > maximum) {
    violations.push(
      `numbered-module debt increased from ${maximum} to ${found.length}; `
        + "new mechanically named modules are forbidden repository-wide",
    );
  }
  if (baseLegacy) {
    const base = new Set(baseLegacy);
    for (const path of legacy) {
      if (!base.has(path) && !baseFiles?.has(path)) {
        violations.push(`${baselinePath}: may only shrink, but it gained ${path}`);
      }
    }
  }
  return violations;
}

// Compares per-file counts against what is allowed. A path missing from the
// allowed map is allowed zero, so any new file with debt is an increase.
export function compareCounts(allowed, actual) {
  const increases = [];
  const decreases = [];
  for (const path of [...new Set([...Object.keys(allowed), ...Object.keys(actual)])].sort()) {
    const limit = allowed[path] ?? 0;
    const count = actual[path] ?? 0;
    if (count > limit) increases.push({ path, allowed: limit, actual: count });
    else if (count < limit) decreases.push({ path, allowed: limit, actual: count });
  }
  return { increases, decreases };
}

// Reads a baseline file as committed at the merge base with `baseRef`. Returns
// `{ skipped }` when Git or the ref is unavailable (container builds, shallow
// clones), and `value: null` when the base predates the baseline file.
/** Every file path in a commit's tree, or null when the commit is unknown. */
export function filesAtCommit(repositoryRoot, commit) {
  if (!commit) return null;
  try {
    return new Set(String(capture("git", ["ls-tree", "-r", "--name-only", commit], { cwd: repositoryRoot }))
      .split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

export function committedBaseline(repositoryRoot, path, baseRef = "origin/main") {
  let commit;
  try {
    const base = String(capture("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repositoryRoot })).trim();
    commit = String(capture("git", ["merge-base", "HEAD", base], { cwd: repositoryRoot })).trim();
  } catch {
    return { skipped: `${baseRef} is not available, so baseline growth was not compared` };
  }
  let text;
  try {
    text = capture("git", ["show", `${commit}:${path}`], { cwd: repositoryRoot });
  } catch {
    return { commit, value: null };
  }
  return { commit, value: JSON.parse(text) };
}
