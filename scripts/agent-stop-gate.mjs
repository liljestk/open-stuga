#!/usr/bin/env node

// Claude Code hooks (wired in .claude/settings.json) that keep an agent turn
// from ending while `npm run verify:local -- --fast` fails.
//
//   record  UserPromptSubmit: fingerprint the worktree when a prompt arrives.
//   check   Stop: if the turn changed that fingerprint (edits or commits), run
//           fast verification; on failure exit 2, which makes Claude Code feed
//           stderr back to the agent and keep the turn going.
//
// A turn that changed nothing skips verification, so questions stay fast.
// STUGU_STOP_GATE=off in Claude Code's environment disables both hooks.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { capture, repositorySnapshot, stateDirectory } from "./tooling/runtime.mjs";

const FEEDBACK_CHARACTERS = 12_000;
const LOG_LINES = 150;

export function parsePayload(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

// The Stugu checkout containing `directory`, or null for any other folder.
export function repositoryRoot(directory) {
  try {
    const root = resolve(String(capture("git", ["rev-parse", "--show-toplevel"], { cwd: directory })).trim());
    return existsSync(join(root, "scripts", "verify-local.mjs")) ? root : null;
  } catch {
    return null;
  }
}

function fingerprintPath(root, sessionId, env) {
  const name = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 120) || "unknown-session";
  return join(stateDirectory(root, env), "agent-stop-gate", `${name}.json`);
}

// Without a fingerprint from the prompt (the hook arrived mid-session), any
// uncommitted change counts as this turn's work.
export function turnChanged(recorded, snapshot, root) {
  if (recorded?.root === root && typeof recorded.worktreeSha256 === "string") {
    return recorded.worktreeSha256 !== snapshot.worktreeSha256;
  }
  return snapshot.dirty;
}

export function feedback(output, logText = "") {
  const head = [
    "`npm run verify:local -- --fast` failed, so this turn cannot end yet.",
    "Fix the cause below, then finish the turn again; every finish reruns the verification.",
    "",
    output.trim(),
  ].join("\n");
  const tail = logText.split(/\r?\n/u).slice(-LOG_LINES).join("\n").trim();
  if (!tail) return head.slice(0, FEEDBACK_CHARACTERS);
  const room = FEEDBACK_CHARACTERS - head.length - 40;
  if (room <= 0) return head.slice(0, FEEDBACK_CHARACTERS);
  const shown = tail.length <= room ? tail : `…${tail.slice(-(room - 1))}`;
  return `${head}\n\nEnd of the detailed log:\n${shown}`;
}

function record(payload, env) {
  const root = repositoryRoot(payload.cwd ?? process.cwd());
  if (!root) return 0;
  const path = fingerprintPath(root, payload.session_id, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    root,
    worktreeSha256: repositorySnapshot(root).worktreeSha256,
    recordedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return 0;
}

function check(payload, env, stderr) {
  const root = repositoryRoot(payload.cwd ?? process.cwd());
  if (!root) return 0;
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(fingerprintPath(root, payload.session_id, env), "utf8"));
  } catch {
    // No prompt fingerprint for this session.
  }
  if (!turnChanged(recorded, repositorySnapshot(root), root)) return 0;

  const result = spawnSync(process.execPath, [join(root, "scripts", "verify-local.mjs"), "--fast"], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status === 0) return 0;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  let logText = "";
  const logPath = /^Log: (.+)$/mu.exec(output)?.[1]?.trim();
  if (logPath && existsSync(logPath)) logText = readFileSync(logPath, "utf8");
  stderr.write(`${feedback(output, logText)}\n`);
  return 2;
}

export function main(argv = process.argv.slice(2), { env = process.env, input = "", stderr = process.stderr } = {}) {
  if (env.STUGU_STOP_GATE === "off") return 0;
  const payload = parsePayload(input);
  if (argv[0] === "record") {
    // Never hold up a prompt: a failed fingerprint only means the Stop hook
    // falls back to checking whenever the tree is dirty.
    try {
      return record(payload, env);
    } catch {
      return 0;
    }
  }
  if (argv[0] === "check") return check(payload, env, stderr);
  stderr.write("Usage: node scripts/agent-stop-gate.mjs record|check < hook-input.json\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { input: readFileSync(0, "utf8") });
}
