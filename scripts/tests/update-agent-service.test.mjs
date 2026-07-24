import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  installUpdateAgentService,
  uninstallUpdateAgentService,
  updateAgentServiceDefinition,
} from "../stuga-update-agent-service.mjs";

test("Windows installs a limited per-user task and starts it immediately", () => {
  const root = join(tmpdir(), "Stuga service test");
  const calls = [];
  const definition = installUpdateAgentService(root, {
    nodeExecutable: process.execPath,
    platform: "win32",
    runner: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    },
  });
  const encoded = definition.install.args.at(-1);
  const source = Buffer.from(encoded, "base64").toString("utf16le");

  assert.equal(definition.kind, "Windows per-user scheduled task");
  assert.match(source, /New-ScheduledTaskTrigger -AtLogOn/u);
  assert.match(source, /-RunLevel Limited/u);
  assert.doesNotMatch(source, /-RunLevel Highest/u);
  assert.match(source, /Start-ScheduledTask/u);
  assert.match(source, /--project-directory=/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "powershell.exe");
});

test("Linux installs, enables, and can remove a systemd user service", (t) => {
  const root = mkdtempSync(join(tmpdir(), "stuga-update-project-"));
  const homeDirectory = mkdtempSync(join(tmpdir(), "stuga-update-home-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDirectory, { recursive: true, force: true });
  });
  const calls = [];
  writeFileSync(join(root, ".env"), "STUGA_UPDATE_OPERATIONS_GID=1000\n", "utf8");
  const dependencies = {
    groupId: 4321,
    homeDirectory,
    nodeExecutable: process.execPath,
    platform: "linux",
    runner: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    },
  };

  const definition = installUpdateAgentService(root, dependencies);
  const unit = readFileSync(definition.path, "utf8");
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "STUGA_UPDATE_OPERATIONS_GID=4321\n");
  assert.match(unit, /\[Service\][\s\S]*Restart=always/u);
  assert.match(unit, /--env-file-if-exists=/u);
  assert.match(unit, /--project-directory=/u);
  assert.deepEqual(calls, [
    ["docker", "compose", "run", "--rm", "--no-deps", "update-operations-init"],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", definition.name],
    ["systemctl", "--user", "restart", definition.name],
  ]);

  uninstallUpdateAgentService(root, dependencies);
  assert.equal(existsSync(definition.path), false);
  assert.deepEqual(calls.slice(4), [
    ["systemctl", "--user", "disable", "--now", definition.name],
    ["systemctl", "--user", "daemon-reload"],
  ]);
});

test("macOS definition is a per-user LaunchAgent with explicit program arguments", () => {
  const root = join(tmpdir(), "Stuga & home");
  const definition = updateAgentServiceDefinition(root, {
    homeDirectory: tmpdir(),
    nodeExecutable: process.execPath,
    platform: "darwin",
  });

  assert.equal(definition.kind, "macOS per-user LaunchAgent");
  assert.match(definition.content, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(definition.content, /<key>KeepAlive<\/key>\s*<true\/>/u);
  assert.match(definition.content, /--project-directory=/u);
  assert.match(definition.content, /&amp;/u);
});

test("service installation rejects unsupported platforms", () => {
  assert.throws(
    () => updateAgentServiceDefinition(".", { platform: "freebsd" }),
    /not supported/u,
  );
});
