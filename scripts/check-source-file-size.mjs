import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const maximumLines = 600;
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

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const path of await sourceFiles(join(root, sourceRoot))) {
    const text = await readFile(path, "utf8");
    const lines = text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length;
    if (lines > maximumLines) violations.push({ path: relative(root, path), lines });
  }
}

if (violations.length) {
  violations.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  console.error(`Source files must not exceed ${maximumLines} physical lines:`);
  for (const violation of violations) console.error(`  ${violation.lines.toString().padStart(5)}  ${violation.path}`);
  process.exitCode = 1;
} else {
  console.log(`Source file size check passed (maximum ${maximumLines} lines).`);
}
