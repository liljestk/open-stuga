import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { feedback, npmInvocation, parsePayload, turnChanged } from "../agent-stop-gate.mjs";
import {
  BASELINE_PATH,
  baselineDocument,
  countsByFile,
  parseArguments,
  parseDiagnostics,
} from "../check-unused-symbols.mjs";
import {
  committedBaseline,
  compareCounts,
  isNumberedModule,
  numberedModuleViolations,
} from "../tooling/quality-ratchets.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root, ...args) {
  const result = spawnSync("git", [
    "-c", "user.name=Stugu Test",
    "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("tsc output is split into unused symbols per file and every other diagnostic", () => {
  const { unused, other } = parseDiagnostics([
    "apps/web/src/a.ts(1,10): error TS6133: 'x' is declared but its value is never read.",
    "apps/web/src/a.ts(2,1): error TS6192: All imports in import declaration are unused.",
    "apps\\api\\src\\b.ts(3,5): error TS6196: 'Shape' is declared but never used.",
    "apps/api/src/b.ts(9,3): error TS6138: Property 'store' is declared but its value is never read.",
    "apps/api/src/c.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "  Types of property 'id' are incompatible.",
    "error TS5083: Cannot read file 'missing/tsconfig.json'.",
    "",
  ].join("\r\n"));
  assert.deepEqual(countsByFile(unused), { "apps/web/src/a.ts": 2, "apps/api/src/b.ts": 2 });
  assert.equal(other.length, 2);
  assert.match(other[0], /TS2322[\s\S]*Types of property 'id'/u);
  assert.match(other[1], /^error TS5083/u);
});

test("counts may fall but never rise, and a file outside the baseline may have none", () => {
  const { increases, decreases } = compareCounts(
    { "a.ts": 3, "b.ts": 2, "gone.ts": 1 },
    { "a.ts": 4, "b.ts": 1, "new.ts": 1 },
  );
  assert.deepEqual(increases, [
    { path: "a.ts", allowed: 3, actual: 4 },
    { path: "new.ts", allowed: 0, actual: 1 },
  ]);
  assert.deepEqual(decreases, [
    { path: "b.ts", allowed: 2, actual: 1 },
    { path: "gone.ts", allowed: 1, actual: 0 },
  ]);
});

test("the baseline document is sorted and keeps only files with debt", () => {
  const document = JSON.parse(baselineDocument({ "z.ts": 2, "a.ts": 0, "m.ts": 1 }));
  assert.deepEqual(Object.entries(document.files), [["m.ts", 1], ["z.ts", 2]]);
  assert.deepEqual(parseArguments(["--update", "--base-ref", "upstream/main"]), {
    help: false,
    update: true,
    baseRef: "upstream/main",
  });
  assert.throws(() => parseArguments(["--base-ref"]), /needs a value/u);
  assert.throws(() => parseArguments(["--force"]), /Unknown argument/u);
});

test("numbered modules are recognised by name and code extension only", () => {
  for (const path of [
    "apps/api/src/app/part-07.ts",
    "apps/web/src/airflowSimulation/01-climate-sample.ts",
    "apps/web/src/styles/global/12-setup.css",
    "apps/api/src/mcp-server/07-mcp-tool-definitions-part02.ts",
    "scripts/tests/setup.part-02.test.mjs",
    "apps/api/python/part3.py",
    "packages/contracts/src/sensor-part-2.tsx",
  ]) assert.equal(isNumberedModule(path), true, path);
  for (const path of [
    "apps/web/src/counterpart-2.ts",
    "apps/web/src/3-way-merge.ts",
    "apps/web/src/2d-plan.ts",
    "apps/api/src/analytics/home-monitoring/model.ts",
    "deploy/rpi/assets/70-stugu-gpio.rules",
    "deploy/nexus433/patches/0001-modern-compiler-cstdint.patch",
  ]) assert.equal(isNumberedModule(path), false, path);
});

test("a new numbered module anywhere fails, and the legacy list may only shrink", () => {
  const baselinePath = "scripts/baselines/numbered-modules.json";
  assert.deepEqual(numberedModuleViolations({
    found: ["a/part-01.ts", "b/02-x.ts"],
    legacy: ["a/part-01.ts", "b/02-x.ts"],
    maximum: 2,
    baseLegacy: ["a/part-01.ts", "b/02-x.ts", "c/part-03.ts"],
    baselinePath,
  }), []);
  const violations = numberedModuleViolations({
    found: ["a/part-01.ts", "d/04-new.ts"],
    legacy: ["a/part-01.ts", "b/02-x.ts", "e/part-09.ts"],
    maximum: 1,
    baseLegacy: ["a/part-01.ts", "b/02-x.ts"],
    baselinePath,
  });
  assert.ok(violations.includes("d/04-new.ts: new numbered module; name the module after the domain it owns"));
  assert.ok(violations.some((line) => line.startsWith("b/02-x.ts: legacy numbered module is gone")));
  assert.ok(violations.some((line) => line.startsWith("numbered-module debt increased from 1 to 2")));
  assert.ok(violations.includes(`${baselinePath}: may only shrink, but it gained e/part-09.ts`));
});

test("committed baselines are read at the merge base, and skipped without the ref", (t) => {
  const root = temporaryDirectory(t, "stugu-ratchet-git-");
  git(root, "init", "-q", "-b", "main");
  write(root, "baseline.json", JSON.stringify({ files: { "a.ts": 2 } }));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "baseline");
  git(root, "checkout", "-q", "-b", "work");
  write(root, "baseline.json", JSON.stringify({ files: { "a.ts": 9 } }));
  git(root, "commit", "-q", "-am", "raise");

  const committed = committedBaseline(root, "baseline.json", "main");
  assert.deepEqual(committed.value, { files: { "a.ts": 2 } });
  assert.match(committed.commit, /^[0-9a-f]{40}$/u);
  assert.equal(committedBaseline(root, "absent.json", "main").value, null);
  assert.match(committedBaseline(root, "baseline.json", "origin/missing").skipped, /not available/u);
});

function unusedFixture(t) {
  const root = temporaryDirectory(t, "stugu-unused-");
  write(root, "package.json", JSON.stringify({ private: true, workspaces: ["libs/*"] }));
  write(root, "libs/a/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true },
    include: ["src"],
  }));
  write(root, "libs/a/src/util.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
  write(root, "libs/a/src/index.ts", [
    "import { one, two } from \"./util\";",
    "export function scale(value: number, unusedFactor: number): number {",
    "  return value * one;",
    "}",
    "",
  ].join("\n"));
  write(root, "libs/no-typescript/package.json", "{}");
  return root;
}

function checkUnused(root, ...args) {
  const result = spawnSync(process.execPath, [join(scripts, "check-unused-symbols.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const baselineFiles = (root) => JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")).files;

test("the unused-symbol ratchet creates, enforces and lowers its baseline", (t) => {
  const root = unusedFixture(t);
  assert.match(checkUnused(root).output, /is missing/u);

  let run = checkUnused(root, "--update");
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(baselineFiles(root), { "libs/a/src/index.ts": 2 });
  assert.equal(checkUnused(root).status, 0);

  write(root, "libs/a/src/index.ts", [
    "import { one, two, three } from \"./util\";",
    "export function scale(value: number, unusedFactor: number): number {",
    "  return value * one;",
    "}",
    "",
  ].join("\n"));
  run = checkUnused(root);
  assert.equal(run.status, 1);
  assert.match(run.output, /libs\/a\/src\/index\.ts: 3 \(baseline 2\)/u);
  assert.match(run.output, /'three' is declared but its value is never read/u);
  run = checkUnused(root, "--update");
  assert.equal(run.status, 1);
  assert.match(run.output, /only locks in reductions/u);
  assert.deepEqual(baselineFiles(root), { "libs/a/src/index.ts": 2 });

  write(root, "libs/a/src/index.ts", "import { one } from \"./util\";\nexport const scaled = one * 2;\n");
  run = checkUnused(root);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /2 unused symbols fewer than the baseline in 1 file/u);
  assert.match(run.output, /npm run check:unused -- --update/u);
  assert.equal(checkUnused(root, "--update").status, 0);
  assert.deepEqual(baselineFiles(root), {});

  write(root, "libs/a/src/extra.ts", "import { two } from \"./util\";\nexport const extra = 1;\n");
  run = checkUnused(root);
  assert.equal(run.status, 1);
  assert.match(run.output, /libs\/a\/src\/extra\.ts: 1 \(baseline 0\)/u);

  write(root, "libs/a/src/extra.ts", "export const extra: number = \"text\";\n");
  run = checkUnused(root);
  assert.equal(run.status, 1);
  assert.match(run.output, /errors other than unused symbols/u);
  assert.match(run.output, /TS2322/u);
});

test("the unused-symbol baseline may not be raised by hand", (t) => {
  const root = unusedFixture(t);
  assert.equal(checkUnused(root, "--update").status, 0);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "baseline");
  git(root, "checkout", "-q", "-b", "work");
  write(root, "libs/a/src/index.ts", [
    "import { one, two, three } from \"./util\";",
    "export function scale(value: number, unusedFactor: number): number {",
    "  return value * one;",
    "}",
    "",
  ].join("\n"));
  write(root, BASELINE_PATH, baselineDocument({ "libs/a/src/index.ts": 3 }));

  const run = checkUnused(root, "--base-ref", "main");
  assert.equal(run.status, 1);
  assert.match(run.output, /may only shrink/u);
  assert.match(run.output, /libs\/a\/src\/index\.ts: 3 \(was 2\)/u);
});

test("the stop gate verifies only turns that changed the worktree", () => {
  const snapshot = { dirty: true, worktreeSha256: "b".repeat(64) };
  assert.equal(turnChanged({ root: "/repo", worktreeSha256: "a".repeat(64) }, snapshot, "/repo"), true);
  assert.equal(turnChanged({ root: "/repo", worktreeSha256: "b".repeat(64) }, snapshot, "/repo"), false);
  assert.equal(turnChanged({ root: "/other", worktreeSha256: "b".repeat(64) }, snapshot, "/repo"), true);
  assert.equal(turnChanged(null, { ...snapshot, dirty: false }, "/repo"), false);
  const npmCli = join(scripts, "check-unused-symbols.mjs");
  assert.deepEqual(npmInvocation(["run", "x"], { env: { npm_execpath: npmCli }, platform: "win32", execPath: "node.exe" }), {
    command: "node.exe",
    args: [npmCli, "run", "x"],
  });
  assert.deepEqual(npmInvocation(["run", "x"], { env: {}, platform: "linux", execPath: "/usr/bin/node" }), {
    command: "npm",
    args: ["run", "x"],
  });
  assert.deepEqual(parsePayload("not json"), {});
  assert.deepEqual(parsePayload("{\"session_id\":\"s\"}"), { session_id: "s" });

  const message = feedback("FAIL VERIFY_FAST_TYPECHECK\nLog: x.log", `${"noise\n".repeat(5000)}TS6133 the real cause`);
  assert.ok(message.length <= 12_000);
  assert.match(message, /^`npm run verify:local -- --fast` failed/u);
  assert.match(message, /FAIL VERIFY_FAST_TYPECHECK/u);
  assert.match(message, /TS6133 the real cause$/u);
});

test("the stop gate blocks with exit 2 while fast verification fails", (t) => {
  const root = temporaryDirectory(t, "stugu-stop-gate-repo-");
  const state = temporaryDirectory(t, "stugu-stop-gate-state-");
  write(root, "package.json", JSON.stringify({ private: true, scripts: { "verify:local": "node scripts/verify-local.mjs" } }));
  write(root, "scripts/verify-local.mjs", [
    "if (!process.env.npm_execpath) throw new Error(\"run through npm\");",
    "import { appendFileSync, existsSync, writeFileSync } from \"node:fs\";",
    "appendFileSync(process.env.STOP_GATE_RUNS, \"run\\n\");",
    "if (existsSync(\"broken.ts\")) {",
    "  writeFileSync(process.env.STOP_GATE_LOG, \"> npm run typecheck\\nbroken.ts(1,7): error TS6133: 'x' is declared but its value is never read.\\n\");",
    "  console.error(`FAIL VERIFY_FAST_TYPECHECK\\nLog: ${process.env.STOP_GATE_LOG}`);",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");

  const runs = join(state, "runs.txt");
  writeFileSync(runs, "");
  const env = { ...process.env, STUGU_TOOLING_STATE_DIR: join(state, "tooling"), STOP_GATE_RUNS: runs, STOP_GATE_LOG: join(state, "verify.log") };
  delete env.STUGU_STOP_GATE;
  const hook = (mode, payload = { session_id: "session-1", cwd: root }, extra = {}) => spawnSync(
    process.execPath,
    [join(scripts, "agent-stop-gate.mjs"), mode],
    { cwd: root, env: { ...env, ...extra }, input: JSON.stringify(payload), encoding: "utf8" },
  );
  const runCount = () => readFileSync(runs, "utf8").split("\n").filter(Boolean).length;

  let result = hook("record");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(hook("check").status, 0);
  assert.equal(runCount(), 0, "a turn that changed nothing must not verify");

  write(root, "broken.ts", "const x = 1;\n");
  result = hook("check");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /`npm run verify:local -- --fast` failed/u);
  assert.match(result.stderr, /'x' is declared but its value is never read/u);
  assert.equal(runCount(), 1);
  assert.equal(hook("check", undefined, { STUGU_STOP_GATE: "off" }).status, 0);
  assert.equal(runCount(), 1);

  rmSync(join(root, "broken.ts"));
  write(root, "fixed.ts", "export const x = 1;\n");
  assert.equal(hook("check").status, 0);
  assert.equal(runCount(), 2);

  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "work");
  assert.equal(hook("check").status, 0, "a committed change still counts as this turn's work");
  assert.equal(runCount(), 3);
  assert.equal(hook("check", { session_id: "session-2", cwd: root }).status, 0);
  assert.equal(runCount(), 3, "without a prompt fingerprint only a dirty tree verifies");

  assert.equal(hook("check", { session_id: "session-1", cwd: state }).status, 0);
  assert.equal(runCount(), 3, "folders outside a Stugu checkout are ignored");
});
