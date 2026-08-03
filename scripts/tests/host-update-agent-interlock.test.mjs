import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAgentConfig } from "../stugu-update-agent.mjs";
import {
  acquireLock,
  hostUpdateInterlock,
  pendingWork,
  releaseLock,
} from "../stugu-update-agent/update-loop.mjs";

test("container mutations fail closed while a host-update journal is nonterminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-host-update-interlock-"));
  try {
    const operationsDirectory = join(directory, "operations");
    const journalPath = join(directory, "host-journal.json");
    mkdirSync(operationsDirectory);
    writeFileSync(join(operationsDirectory, "request-test.json"), JSON.stringify({
      requestedAt: "2026-08-02T08:00:00.000Z",
    }));
    const config = readAgentConfig({
      STUGA_PROJECT_DIRECTORY: directory,
      SYSTEM_UPDATE_OPERATIONS_DIRECTORY: operationsDirectory,
      SYSTEM_UPDATE_RUNTIME: "raspberry-pi",
      STUGA_HOST_UPDATE_JOURNAL: journalPath,
    }, directory);
    assert.equal(config.hostUpdateJournal, journalPath);
    writeFileSync(journalPath, JSON.stringify({
      schema: "stugu-host-update-journal/v1",
      phase: "installed",
    }));
    assert.equal(hostUpdateInterlock(config)?.reason, "host-update-active");
    assert.equal(pendingWork(config), null);
    writeFileSync(journalPath, JSON.stringify({
      schema: "stugu-host-update-journal/v1",
      phase: "complete",
    }));
    assert.equal(hostUpdateInterlock(config), null);
    assert.equal(pendingWork(config)?.kind, "update");
    writeFileSync(journalPath, "{");
    assert.equal(hostUpdateInterlock(config)?.reason, "host-update-active");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("container mutation lease is exclusive and releases only its own inode", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-agent-lease-"));
  try {
    const config = { operationsDirectory: directory };
    const first = acquireLock(config);
    assert.ok(first);
    assert.match(
      readFileSync(join(directory, "agent.lock"), "ascii"),
      /^stugu-mutation-lock\/v1 container-updater (?:unknown|[0-9a-f-]+) [0-9]+\r?\n$/u,
    );
    assert.equal(acquireLock(config), null);
    releaseLock(first);
    assert.equal(existsSync(join(directory, "agent.lock")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed mutation-lease boot identity cannot trigger immediate reclaim", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-agent-malformed-lease-"));
  try {
    const path = join(directory, "agent.lock");
    writeFileSync(path, `${"stugu-mutation-lock/v1"} host-updater deadbeef 7\n`);
    assert.equal(acquireLock({ operationsDirectory: directory }), null);
    assert.match(readFileSync(path, "ascii"), / deadbeef 7\r?\n$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
