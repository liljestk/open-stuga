#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { committedBaseline, compareCounts } from "./tooling/quality-ratchets.mjs";

export const BASELINE_PATH = "scripts/baselines/unused-symbols.json";
// TS6133/6196: declared but never read/used; TS6138: unread parameter property;
// TS6192/6198/6199/6205: every import, destructured element, variable or type
// parameter in one declaration is unused.
export const UNUSED_SYMBOL_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS(\d+): /u;
const SHOWN_DIAGNOSTICS = 60;
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function usage() {
  return `Ratchet unused imports, locals and parameters per file.

Usage:
  npm run check:unused [-- --base-ref REF]
  npm run check:unused -- --update

Runs tsc --noUnusedLocals --noUnusedParameters for every TypeScript workspace
and compares each file's count with ${BASELINE_PATH}. A count may fall but never
rise, and a file missing from the baseline must have none. --update lowers the
baseline to the current counts; it refuses while any count is above it. The
baseline itself may only shrink relative to the merge base with REF
(default origin/main).
`;
}

export function parseArguments(argv) {
  const options = { help: false, update: false, baseRef: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--update") options.update = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--base-ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--base-ref needs a value");
      options.baseRef = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

// Splits tsc --pretty false output into unused-symbol diagnostics per file and
// every other diagnostic, keeping indented continuation lines with their head.
export function parseDiagnostics(output) {
  const unused = {};
  const other = [];
  let previous = null;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = DIAGNOSTIC.exec(line);
    if (!match) {
      if (/^\s/u.test(line) && previous === "other") other[other.length - 1] += `\n${line}`;
      else if (!/^\s/u.test(line)) {
        other.push(line);
        previous = "other";
      }
      continue;
    }
    if (UNUSED_SYMBOL_CODES.has(Number(match[2]))) {
      const path = match[1].replaceAll("\\", "/");
      (unused[path] ??= []).push(line);
      previous = "unused";
    } else {
      other.push(line);
      previous = "other";
    }
  }
  return { unused, other };
}

export function countsByFile(unused) {
  return Object.fromEntries(Object.entries(unused).map(([path, lines]) => [path, lines.length]));
}

export function typeScriptWorkspaces(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const directories = [];
  for (const pattern of workspaces) {
    const candidates = pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern];
    directories.push(...candidates.filter((directory) => existsSync(join(root, directory, "tsconfig.json"))));
  }
  return directories.sort();
}

function runTsc(root, workspace) {
  // No --incremental: whether an import counts as referenced depends on which
  // files the checker visited first, so a partial recheck reports different
  // counts (one TS6192 per declaration becomes one TS6196 per specifier).
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      tsc,
      "--noEmit",
      "-p", `${workspace}/tsconfig.json`,
      "--noUnusedLocals",
      "--noUnusedParameters",
      "--pretty", "false",
    ], { cwd: root, windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ workspace, status, output }));
  });
}

async function census(root) {
  const queue = typeScriptWorkspaces(root);
  const results = [];
  const worker = async () => {
    while (queue.length) results.push(await runTsc(root, queue.shift()));
  };
  const limit = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  await Promise.all(Array.from({ length: limit }, worker));

  const unused = {};
  const problems = [];
  for (const result of results.sort((left, right) => left.workspace.localeCompare(right.workspace))) {
    const parsed = parseDiagnostics(result.output);
    Object.assign(unused, parsed.unused);
    // tsc exits 1 or 2 when it reports diagnostics; anything else, or a failure
    // with nothing parsed, means the compiler did not run the project.
    const ran = result.status === 0 || ((result.status === 1 || result.status === 2)
      && (parsed.other.length > 0 || Object.keys(parsed.unused).length > 0));
    if (!ran) problems.push(`${result.workspace}: tsc exited ${result.status}\n${result.output.trim()}`);
    else if (parsed.other.length) problems.push(...parsed.other.map((line) => `${result.workspace}: ${line}`));
  }
  return { unused, problems };
}

function readBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error(`${BASELINE_PATH} must contain a "files" object of per-file counts`);
  }
  return value.files;
}

export function baselineDocument(counts) {
  const files = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
  return `${JSON.stringify({
    $comment: "Unused imports, locals and parameters per file (tsc --noUnusedLocals --noUnusedParameters). "
      + "Counts may only fall; npm run check:unused -- --update locks in reductions.",
    files,
  }, null, 2)}\n`;
}

const total = (counts) => Object.values(counts).reduce((sum, count) => sum + count, 0);
const plural = (count, noun) => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const { unused, problems } = await census(root);
  if (problems.length) {
    console.error("TypeScript reported errors other than unused symbols, so the unused-symbol count is not reliable.");
    console.error("Run `npm run typecheck` (it builds the packages and generates Worker types) and fix these first:");
    for (const problem of problems.slice(0, SHOWN_DIAGNOSTICS)) console.error(`  ${problem}`);
    if (problems.length > SHOWN_DIAGNOSTICS) console.error(`  ... ${problems.length - SHOWN_DIAGNOSTICS} more`);
    return 1;
  }
  const counts = countsByFile(unused);
  const baseline = readBaseline(root);

  if (options.update) {
    if (baseline) {
      const { increases } = compareCounts(baseline, counts);
      if (increases.length) {
        console.error(`--update only locks in reductions; ${plural(increases.length, "file")} rose above ${BASELINE_PATH}.`);
        console.error("Run `npm run check:unused` to list them, remove those unused symbols, then update again.");
        return 1;
      }
    }
    mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
    writeFileSync(join(root, BASELINE_PATH), baselineDocument(counts));
    console.log(`${baseline ? "Lowered" : "Created"} ${BASELINE_PATH}: ${plural(total(counts), "unused symbol")} in ${plural(Object.keys(counts).length, "file")}.`);
    return 0;
  }

  if (!baseline) {
    console.error(`${BASELINE_PATH} is missing. Create it once with \`npm run check:unused -- --update\`.`);
    return 1;
  }

  let failed = false;
  const committed = committedBaseline(root, BASELINE_PATH, options.baseRef);
  if (committed.skipped) console.log(`Note: ${committed.skipped}.`);
  else if (committed.value) {
    const { increases } = compareCounts(committed.value.files ?? {}, baseline);
    if (increases.length) {
      failed = true;
      console.error(`${BASELINE_PATH} may only shrink, but it allows more than ${options.baseRef} (merge base ${committed.commit.slice(0, 12)}):`);
      for (const item of increases) console.error(`  ${item.path}: ${item.actual} (was ${item.allowed})`);
      console.error("Restore those entries and remove the unused symbols instead.");
    }
  }

  const { increases, decreases } = compareCounts(baseline, counts);
  if (increases.length) {
    failed = true;
    console.error(`Unused imports, locals or parameters rose in ${plural(increases.length, "file")}:`);
    let shown = 0;
    for (const item of increases) {
      console.error(`  ${item.path}: ${item.actual} (baseline ${item.allowed})`);
      for (const line of unused[item.path]) {
        if (shown++ < SHOWN_DIAGNOSTICS) console.error(`    ${line}`);
      }
    }
    if (shown > SHOWN_DIAGNOSTICS) console.error(`    ... ${shown - SHOWN_DIAGNOSTICS} more diagnostics`);
    console.error("Import only what the file uses and delete dead locals. A parameter that must stay for its");
    console.error("signature can be renamed with a leading underscore. See CLAUDE.md, \"Code quality\".");
  }
  if (failed) return 1;

  console.log(`Unused-symbol check passed: ${plural(total(counts), "unused symbol")} in ${plural(Object.keys(counts).length, "file")}, none above the baseline.`);
  if (decreases.length) {
    const removed = decreases.reduce((sum, item) => sum + item.allowed - item.actual, 0);
    console.log(`${plural(removed, "unused symbol")} fewer than the baseline in ${plural(decreases.length, "file")}. Lock in the gain:`);
    console.log("  npm run check:unused -- --update");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
