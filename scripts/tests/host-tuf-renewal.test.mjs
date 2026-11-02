import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cronLine,
  installLayout,
  parseArguments,
  renewArguments,
  summarizeStatus,
  taskXml,
} from "../host-tuf-renewal.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const windowsLayout = installLayout({ LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local" }, "win32");

test("parses install options and rejects incomplete commands", () => {
  const options = parseArguments(["install", "--key-directory", "keys", "--time", "07:05"]);
  assert.equal(options.command, "install");
  assert.equal(options.keyDirectory, resolve("keys"));
  assert.equal(options.time, "07:05");
  assert.equal(parseArguments([]).command, "help");
  assert.throws(() => parseArguments(["install"]), /needs --key-directory/u);
  assert.throws(() => parseArguments(["install", "--key-directory"]), /needs a value/u);
  assert.throws(() => parseArguments(["status", "--time", "25:00"]), /HH:MM/u);
  assert.throws(() => parseArguments(["publish"]), /Unknown command/u);
});

test("installs into a per-user directory with a windowless task interpreter", () => {
  assert.equal(windowsLayout.root, join("C:\\Users\\op\\AppData\\Local", "Stugu", "host-tuf-renewal"));
  assert.match(windowsLayout.pythonw, /pythonw\.exe$/u);
  const linux = installLayout({ XDG_DATA_HOME: "/home/op/.data" }, "linux");
  assert.equal(linux.root, join("/home/op/.data", "stugu", "host-tuf-renewal"));
  assert.equal(linux.pythonw, linux.python);
});

test("the scheduled run publishes from the pinned copy and records its state", () => {
  const args = renewArguments(windowsLayout, "D:\\keys");
  assert.deepEqual(args.slice(0, 4), ["-I", windowsLayout.renewer, "renew", "--publish"]);
  assert.deepEqual(args.slice(-4), ["--key-directory", "D:\\keys", "--state-dir", windowsLayout.state]);
  const check = renewArguments(windowsLayout, "D:\\keys", "check");
  assert.equal(check.includes("--publish"), false);
});

test("the task catches up missed runs, never elevates, and escapes its values", () => {
  const xml = taskXml({
    layout: windowsLayout,
    keyDirectory: "D:\\Signing & Keys",
    time: "12:30",
    userId: "HOST\\op",
    startDate: "2026-11-02",
  });
  assert.match(xml, /<StartBoundary>2026-11-02T12:30:00<\/StartBoundary>/u);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/u);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(xml, /--key-directory &#34;D:\\Signing &#38; Keys&#34;/u);
  assert.doesNotMatch(xml, /Signing & Keys/u);
});

test("the cron line quotes every path", () => {
  const layout = installLayout({ XDG_DATA_HOME: "/data" }, "linux");
  const line = cronLine(layout, "/keys/it's here", "04:07");
  assert.match(line, /^7 4 \* \* \* '/u);
  assert.match(line, /'\/keys\/it'\\''s here'/u);
});

test("status flags a missing, failed, stale or warning run", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const record = { schema: "stugu-host-tuf-renewal-install/v1" };
  const task = { state: "Ready" };
  const recent = { ok: true, outcome: "current", finishedAt: "2026-11-10T11:00:00Z" };
  assert.deepEqual(summarizeStatus({ record, task, lastRun: recent, now }), { healthy: true, problems: [] });
  assert.match(summarizeStatus({ record: null, task: null, lastRun: null, now }).problems.join(), /not installed/u);
  assert.match(summarizeStatus({ record, task: null, lastRun: recent, now }).problems.join(), /no scheduled task/u);
  const failed = { ...recent, ok: false, error: "git push failed: denied" };
  assert.match(summarizeStatus({ record, task, lastRun: failed, now }).problems.join(), /git push failed/u);
  const stale = { ...recent, finishedAt: "2026-11-01T11:00:00Z" };
  assert.match(summarizeStatus({ record, task, lastRun: stale, now }).problems.join(), /over three days ago/u);
  const warned = { ...recent, warning: "root v1 expires within 180 days" };
  assert.equal(summarizeStatus({ record, task, lastRun: warned, now }).healthy, false);
});

function pythonWithTuf() {
  for (const python of ["python3", "python"]) {
    const probe = spawnSync(python, ["-c", "import securesystemslib, cryptography, tuf; print(tuf.__version__)"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (probe.status === 0) return { python, tufMajor: Number(probe.stdout.trim().split(".")[0]) };
  }
  return null;
}

const runtime = pythonWithTuf();
const skip = !runtime
  ? "python-tuf is not installed; local CI runs this test in Debian Trixie"
  : process.platform === "win32" && runtime.tufMajor >= 6
    ? "python-tuf 6+ needs symlink privileges on Windows; the renewer pins 5.1 and local CI runs this test in Debian Trixie"
    : false;

test("the renewer renews, publishes and refuses correctly end to end", { skip, timeout: 300_000 }, () => {
  const result = spawnSync(runtime.python, [join(repository, "scripts", "tests", "host-tuf-renewal-e2e.py")], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /HOST TUF RENEWAL E2E PASSED/u);
});
