import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
// The review threshold is intentionally advisory: a focused module may be
// naturally large, and forcing a split at an arbitrary line creates worse
// boundaries. The hard ceiling still rejects genuinely unreviewable files.
const reviewLines = 600;
const maximumLines = 1_200;
const sourceRoots = [
  "apps",
  "packages",
  "scripts",
  "config",
  "deploy",
];
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".css",
  ".scss",
  ".html",
  ".sql",
  ".sh",
  ".ps1",
]);
const ignoredDirectories = new Set(["__pycache__", "build", "coverage", "dist", "node_modules", ".tmp-runtime"]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const warnings = [];
const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const path of await sourceFiles(join(root, sourceRoot))) {
    const text = await readFile(path, "utf8");
    const lines = text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length;
    const record = { path: relative(root, path), lines };
    if (lines > maximumLines) violations.push(record);
    else if (lines > reviewLines) warnings.push(record);
  }
}

if (warnings.length) {
  warnings.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  console.warn(
    `Source files above ${reviewLines} physical lines need a cohesion review (advisory):`,
  );
  for (const warning of warnings) {
    console.warn(`  ${warning.lines.toString().padStart(5)}  ${warning.path}`);
  }
}

if (violations.length) {
  violations.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  console.error(`Source files must not exceed the hard ceiling of ${maximumLines} physical lines:`);
  for (const violation of violations) console.error(`  ${violation.lines.toString().padStart(5)}  ${violation.path}`);
  process.exitCode = 1;
} else {
  console.log(
    `Source file size check passed (${reviewLines}-line review threshold; ${maximumLines}-line hard ceiling).`,
  );
}
