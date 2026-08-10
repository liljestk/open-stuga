#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { affectedTestPlan } from "./tooling/affected-tests.mjs";
import {
  localVerificationCacheKey,
  validateLocalVerificationReceipt,
} from "./tooling/receipt-contracts.mjs";
import {
  ToolFailure,
  appendLog,
  boundedJson,
  changedFiles,
  failureText,
  logPathFor,
  repositorySnapshot,
  runLogged,
  sha256File,
  stateDirectory,
  verifyReceiptChecksum,
  writeJsonReceipt,
} from "./tooling/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Run lean local verification with exact-input receipts.

Usage:
  npm run verify:local -- --fast [--base-ref REF]
  npm run verify:local -- --full [--base-ref REF]

Modes:
  --fast  Check the diff, architecture and types, then affected tests.
  --full  Reuse or run the authoritative local CI once for the exact worktree.

Receipts and detailed logs are written outside Git under the Stugu tooling state
directory. Set STUGU_TOOLING_STATE_DIR to choose another outside-worktree path.
`;
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = { help: false, baseRef: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--base-ref":
        options.baseRef = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--fast":
      case "--full": {
        const mode = argument.slice(2);
        if (options.mode && options.mode !== mode) throw new Error("Choose exactly one of --fast or --full");
        options.mode = mode;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help && !options.mode) throw new Error("Choose exactly one of --fast or --full");
  return options;
}

function verificationKey(mode, snapshot, base) {
  return localVerificationCacheKey({
    mode,
    commit: snapshot.commit,
    worktreeSha256: snapshot.worktreeSha256,
    lockfileSha256: snapshot.lockfileSha256,
    configurationSha256: snapshot.configurationSha256,
    baseCommit: base.baseCommit,
    mergeBase: base.mergeBase,
  });
}

export function verificationReceiptPath(repositoryRoot, mode, version, snapshot, base, env = process.env) {
  const key = verificationKey(mode, snapshot, base);
  return {
    key,
    path: join(
      stateDirectory(repositoryRoot, env),
      "receipts",
      "local",
      mode,
      snapshot.commit,
      key,
      `stugu-${version}-${mode}-verification.json`,
    ),
  };
}

export function findMatchingFullReceipt(repositoryRoot, snapshot, baseRef = "origin/main", env = process.env) {
  const version = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).version;
  const changes = changedFiles(repositoryRoot, baseRef);
  const candidate = verificationReceiptPath(repositoryRoot, "full", version, snapshot, changes, env);
  try {
    verifyReceiptChecksum(candidate.path, "full CI receipt");
    return {
      ...candidate,
      receipt: validateLocalVerificationReceipt(
        boundedJson(candidate.path, "full CI receipt"),
        { mode: "full", snapshot, projectVersion: version },
      ),
    };
  } catch {
    return null;
  }
}

function untrackedWhitespace(repositoryRoot, paths) {
  const problems = [];
  for (const path of paths) {
    let bytes;
    try {
      bytes = readFileSync(resolve(repositoryRoot, path));
    } catch {
      continue;
    }
    if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (/[\t ]+$/u.test(line)) problems.push(`${path}:${index + 1}: trailing whitespace`);
      if (/^(?:<{7}|={7}|>{7})(?: |$)/u.test(line)) problems.push(`${path}:${index + 1}: conflict marker`);
      if (problems.length >= 50) return problems;
    }
  }
  return problems;
}

function receiptBase(changes) {
  return { ref: changes.baseRef, commit: changes.baseCommit, mergeBase: changes.mergeBase };
}

function receiptWorktree(snapshot) {
  return {
    sha256: snapshot.worktreeSha256,
    dirty: snapshot.dirty,
    statusSha256: snapshot.statusSha256,
    trackedDiffSha256: snapshot.trackedDiffSha256,
  };
}

function receiptInputs(snapshot) {
  return {
    lockfileSha256: snapshot.lockfileSha256,
    configurationSha256: snapshot.configurationSha256,
  };
}

function assertUnchanged(before, after, logPath) {
  if (before.commit !== after.commit || before.worktreeSha256 !== after.worktreeSha256) {
    throw new ToolFailure(
      "VERIFY_WORKTREE_CHANGED",
      "The commit or worktree changed while verification was running.",
      "Stop concurrent edits, then rerun the same verify:local command.",
      logPath,
    );
  }
}

async function checkedStep(step, context) {
  console.log(`[verify:${context.mode}] ${step.label}`);
  const startedAt = Date.now();
  const result = await runLogged({
    command: step.command,
    args: step.args,
    cwd: root,
    logPath: context.logPath,
    timeoutMs: step.timeoutMs ?? 0,
    capture: true,
  });
  const record = {
    id: step.id,
    label: step.label,
    status: result.status === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
  };
  context.checks.push(record);
  if (result.status !== 0) {
    const dependenciesMissing = /ERR_MODULE_NOT_FOUND|Cannot find package|could not determine executable/iu.test(result.output);
    throw new ToolFailure(
      dependenciesMissing ? `VERIFY_${context.mode.toUpperCase()}_DEPENDENCIES` : `VERIFY_${context.mode.toUpperCase()}_${step.id}`,
      dependenciesMissing
        ? `${step.label} could not start because locked Node dependencies are missing.`
        : `${step.label} failed${result.timedOut ? " after its timeout" : ""}.`,
      dependenciesMissing ? "npm ci" : step.next,
      context.logPath,
    );
  }
}

async function runFast({ version, snapshot, changes, receiptPath, key, logPath }) {
  const startedAt = new Date();
  const context = { mode: "fast", checks: [], logPath };
  await checkedStep({
    id: "DIFF",
    label: "Diff check",
    command: "git",
    args: ["diff", "--check", changes.mergeBase, "--"],
    next: `git diff --check ${changes.mergeBase} --`,
  }, context);
  const whitespace = untrackedWhitespace(root, changes.untrackedFiles);
  if (whitespace.length > 0) {
    appendLog(logPath, `${whitespace.join("\n")}\n`);
    throw new ToolFailure(
      "VERIFY_FAST_DIFF",
      `${whitespace.length} untracked-file whitespace or conflict-marker issue(s) were found.`,
      "Fix the first path listed in the detailed log, then rerun fast verification.",
      logPath,
    );
  }
  await checkedStep({
    id: "TYPECHECK",
    label: "Architecture and type checks",
    command: "npm",
    args: ["run", "typecheck"],
    next: "npm run typecheck",
  }, context);
  const tests = affectedTestPlan(changes.files, changes.mergeBase);
  for (const test of tests) await checkedStep(test, context);

  const finishedAt = new Date();
  const after = repositorySnapshot(root);
  assertUnchanged(snapshot, after, logPath);
  const receipt = {
    schema: "stugu-local-verification/v1",
    mode: "fast",
    result: "passed",
    projectVersion: version,
    commit: snapshot.commit,
    worktree: receiptWorktree(snapshot),
    inputs: receiptInputs(snapshot),
    base: receiptBase(changes),
    cacheKey: key,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    authoritativeCi: null,
    checks: context.checks,
    affectedFiles: changes.files,
    limitations: [],
  };
  validateLocalVerificationReceipt(receipt, { mode: "fast", snapshot, projectVersion: version });
  return { receipt, written: writeJsonReceipt(receiptPath, receipt) };
}

async function runFull({ version, options, snapshot, changes, receiptPath, key, logPath, env }) {
  const startedAt = new Date();
  const evidenceDirectory = join(stateDirectory(root, env), "evidence", "local-ci", key);
  const localReceiptPath = join(evidenceDirectory, `stugu-${version}-authoritative-local-ci.json`);
  const localChecksumPath = `${localReceiptPath}.sha256`;
  console.log("[verify:full] Authoritative local CI");
  const result = await runLogged({
    command: "npm",
    args: [
      "run", "ci:local", "--",
      "--base-ref", options.baseRef,
      "--report", localReceiptPath,
      "--checksum", localChecksumPath,
    ],
    cwd: root,
    env,
    logPath,
    onLine: (line) => {
      const match = /^\[local CI\] (.+)$/u.exec(line);
      if (match) console.log(`[verify:full] ${match[1]}`);
    },
  });
  let authoritative;
  try {
    authoritative = boundedJson(localReceiptPath, "authoritative local CI receipt", 8 * 1024 * 1024);
  } catch (error) {
    throw new ToolFailure(
      "VERIFY_FULL_START",
      result.timedOut ? "Authoritative local CI timed out before writing a receipt." : "Authoritative local CI did not write a valid receipt.",
      "Inspect the detailed log, fix the startup prerequisite, then rerun full verification.",
      logPath,
      { cause: error },
    );
  }
  const authoritativeSha256 = sha256File(localReceiptPath);
  let checksum;
  try {
    checksum = readFileSync(localChecksumPath, "utf8");
  } catch (error) {
    throw new ToolFailure(
      "VERIFY_FULL_RECEIPT",
      "Authoritative local CI did not write its receipt checksum.",
      "Inspect the detailed log, then rerun full verification.",
      logPath,
      { cause: error },
    );
  }
  if (authoritative.schemaVersion !== 1
    || authoritative.projectVersion !== version
    || authoritative.commit !== snapshot.commit
    || authoritative.workingTreeDirty !== snapshot.dirty
    || !Array.isArray(authoritative.checks)
    || authoritative.checks.length === 0
    || authoritative.checks.some((check) => typeof check?.id !== "string"
      || typeof check?.name !== "string"
      || !Number.isSafeInteger(check?.status)
      || !Number.isSafeInteger(check?.durationMs))
    || checksum !== `${authoritativeSha256}  ${localReceiptPath.split(/[\\/]/u).at(-1)}\n`) {
    throw new ToolFailure(
      "VERIFY_FULL_RECEIPT",
      "Authoritative local CI wrote evidence that does not match the exact verification inputs.",
      "Inspect the detailed log, then rerun full verification.",
      logPath,
    );
  }
  const checks = authoritative.checks.map((check) => ({
    id: check.id,
    label: check.name,
    status: check.status === 0 ? "passed" : "failed",
    durationMs: check.durationMs,
  }));
  const failed = authoritative.checks.find((check) => check.status !== 0);
  if (result.status !== 0 || authoritative.result !== "passed" || failed) {
    throw new ToolFailure(
      `VERIFY_FULL_${failed?.id ?? "CI"}`,
      failed ? `${failed.name} failed.` : "Authoritative local CI failed.",
      failed
        ? `Fix the first ${failed.id} error shown in the detailed log.`
        : "Inspect the detailed log and rerun full verification.",
      logPath,
    );
  }
  const after = repositorySnapshot(root);
  assertUnchanged(snapshot, after, logPath);
  const finishedAt = new Date();
  const receipt = {
    schema: "stugu-local-verification/v1",
    mode: "full",
    result: "passed",
    projectVersion: version,
    commit: snapshot.commit,
    worktree: receiptWorktree(snapshot),
    inputs: receiptInputs(snapshot),
    base: receiptBase(changes),
    cacheKey: key,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    authoritativeCi: {
      schemaVersion: authoritative.schemaVersion,
      receiptSha256: authoritativeSha256,
      result: authoritative.result,
    },
    checks,
    affectedFiles: changes.files,
    limitations: authoritative.limitations ?? [],
  };
  validateLocalVerificationReceipt(receipt, { mode: "full", snapshot, projectVersion: version });
  return { receipt, written: writeJsonReceipt(receiptPath, receipt) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const logPath = logPathFor(root, "verify-local", env);
  try {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure("VERIFY_USAGE", error instanceof Error ? error.message : String(error), "npm run verify:local -- --fast", logPath);
  }
  if (options.help) {
    console.log(usage());
    return null;
  }
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  let snapshot;
  let changes;
  try {
    snapshot = repositorySnapshot(root);
    changes = changedFiles(root, options.baseRef);
  } catch (error) {
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure(
      "VERIFY_GIT_STATE",
      error instanceof Error ? error.message : String(error),
      options.baseRef === "origin/main" ? "git fetch origin main" : `git fetch origin ${options.baseRef}`,
      logPath,
    );
  }
  const candidate = verificationReceiptPath(root, options.mode, version, snapshot, changes, env);
  try {
    verifyReceiptChecksum(candidate.path, `${options.mode} verification receipt`);
    const cached = validateLocalVerificationReceipt(
      boundedJson(candidate.path, `${options.mode} verification receipt`),
      { mode: options.mode, snapshot, projectVersion: version },
    );
    console.log(`${options.mode === "full" ? "Full CI" : "Fast verification"} reused for ${snapshot.commit.slice(0, 12)}.`);
    console.log(`Receipt: ${candidate.path}`);
    return { receipt: cached, path: candidate.path, reused: true };
  } catch {
    // No exact valid cache entry; run the selected verification once.
  }

  const output = options.mode === "fast"
    ? await runFast({ version, snapshot, changes, receiptPath: candidate.path, key: candidate.key, logPath })
    : await runFull({ version, options, snapshot, changes, receiptPath: candidate.path, key: candidate.key, logPath, env });
  console.log(`${options.mode === "full" ? "Full CI" : "Fast verification"} passed for ${snapshot.commit.slice(0, 12)}.`);
  console.log(`Receipt: ${output.written.path}`);
  return { ...output, path: output.written.path, reused: false };
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure(
      "VERIFY_INTERNAL",
      error instanceof Error ? error.message : String(error),
      "Inspect the detailed log, fix the first invalid input, then rerun the same verification mode.",
      logPath,
      { cause: error },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(failureText(error, { code: "VERIFY_FAILED", next: "npm run verify:local -- --fast" }));
    process.exitCode = 1;
  });
}
