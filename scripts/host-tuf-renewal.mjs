#!/usr/bin/env node
// Installs, runs and inspects the scheduled job that keeps the host-update
// feed's TUF metadata from expiring (scripts/host-tuf-renewal.py). It runs on
// the operator machine that holds the signing keys; this script only checks
// that the key files exist by name and never reads them.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = {
  renewer: join(repository, "scripts", "host-tuf-renewal.py"),
  e2e: join(repository, "scripts", "tests", "host-tuf-renewal-e2e.py"),
  requirements: join(repository, "scripts", "host-tuf-renewal.requirements.txt"),
};
export const TASK_PATH = "\\Stugu\\";
export const TASK_NAME = "Host TUF renewal";
const COMMANDS = new Set(["install", "status", "run", "check", "uninstall", "help"]);
// A healthy install runs daily; three quiet days mean the task is not running.
const STALE_RUN_MS = 3 * 24 * 60 * 60 * 1000;

const USAGE = `Usage: npm run host-tuf-renewal -- <command> [options]

  install --key-directory DIR [--time HH:MM] [--python EXE] [--dry-run]
      Install a pinned copy of the renewer in its own virtual environment,
      prove it with the end-to-end test and a read-only feed check, then
      register the daily scheduled task (Windows) or print a cron line.
  status     Show the installed copy, the last run and the scheduled task.
  run        Run the installed renewer once now and publish what is due.
  check      Read-only feed check with the installed renewer (no keys used).
  uninstall  Remove the scheduled task; keeps the install and run history.
`;

export function parseArguments(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command, keyDirectory: null, time: "12:30", python: null, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--key-directory") options.keyDirectory = resolve(value());
    else if (flag === "--time") options.time = value();
    else if (flag === "--python") options.python = value();
    else if (flag === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!COMMANDS.has(options.command)) throw new Error(`Unknown command ${options.command}`);
  if (options.command === "install" && !options.keyDirectory) {
    throw new Error("install needs --key-directory");
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(options.time)) throw new Error("--time must be HH:MM");
  return options;
}

export function installLayout(env = process.env, platform = process.platform) {
  const windows = platform === "win32";
  const base = windows
    ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Stugu")
    : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "stugu");
  const root = join(base, "host-tuf-renewal");
  const venv = join(root, "venv");
  const bin = join(root, "bin");
  return {
    windows,
    root,
    venv,
    bin,
    state: join(root, "state"),
    record: join(root, "install.json"),
    renewer: join(bin, "host-tuf-renewal.py"),
    e2e: join(bin, "host-tuf-renewal-e2e.py"),
    requirements: join(bin, "host-tuf-renewal.requirements.txt"),
    python: windows ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python3"),
    // pythonw has no console window, so the daily task never flashes one.
    pythonw: windows ? join(venv, "Scripts", "pythonw.exe") : join(venv, "bin", "python3"),
  };
}

export function renewArguments(layout, keyDirectory, command = "renew") {
  return [
    "-I",
    layout.renewer,
    command,
    ...(command === "renew" ? ["--publish"] : []),
    "--key-directory",
    keyDirectory,
    "--state-dir",
    layout.state,
  ];
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function windowsArguments(argumentsList) {
  return argumentsList.map((argument) => (/[\s"]/u.test(argument) ? `"${argument}"` : argument)).join(" ");
}

export function taskXml({ layout, keyDirectory, time, userId, startDate }) {
  const command = escapeXml(layout.pythonw);
  const commandArguments = escapeXml(windowsArguments(renewArguments(layout, keyDirectory)));
  const user = escapeXml(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Renews the Stugu host-update feed's TUF metadata before it expires. Installed by npm run host-tuf-renewal -- install; see docs/host-update-release.md.</Description>
    <URI>${escapeXml(`${TASK_PATH}${TASK_NAME}`)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startDate}T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT15M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${commandArguments}</Arguments>
      <WorkingDirectory>${escapeXml(layout.root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function cronLine(layout, keyDirectory, time) {
  const [hour, minute] = time.split(":").map(Number);
  const quoted = [layout.pythonw, ...renewArguments(layout, keyDirectory)].map((part) => `'${part.replaceAll("'", "'\\''")}'`);
  return `${minute} ${hour} * * * ${quoted.join(" ")}`;
}

export function summarizeStatus({ record, lastRun, task, now = Date.now() }) {
  const problems = [];
  if (!record) problems.push("the renewer is not installed");
  if (record && !task) problems.push("no scheduled task is registered");
  if (task && task.state === "Disabled") problems.push("the scheduled task is disabled");
  if (!lastRun) problems.push("the renewer has not run yet");
  else {
    if (!lastRun.ok) problems.push(`the last run failed: ${lastRun.error}`);
    const finished = Date.parse(lastRun.finishedAt ?? "");
    if (!Number.isFinite(finished) || now - finished > STALE_RUN_MS) {
      problems.push(`the last run finished ${lastRun.finishedAt ?? "at an unknown time"}, over three days ago`);
    }
    if (lastRun.warning) problems.push(lastRun.warning);
  }
  return { healthy: problems.length === 0, problems };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function execute(command, args, { capture = false, env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, what) {
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status})${result.stderr ? `: ${result.stderr.trim().split("\n").at(-1)}` : ""}`);
  }
  return result;
}

function powershell(script, env) {
  return execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { capture: true, env });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function requireKeyDirectory(directory) {
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const missing = ["root.json", "tuf-targets-*.pem", "tuf-snapshot-*.pem", "tuf-timestamp-*.pem"].filter((pattern) => {
    const expression = new RegExp(`^${pattern.replaceAll(".", "\\.").replace("*", "\\d+")}$`, "u");
    return !names.some((name) => expression.test(name));
  });
  if (missing.length) throw new Error(`${directory} lacks ${missing.join(", ")}`);
}

function sourceIdentity() {
  const head = execute("git", ["rev-parse", "HEAD"], { capture: true });
  const dirty = execute("git", ["status", "--porcelain", "--", ...Object.values(SOURCES)], { capture: true });
  return {
    sourceCommit: head.status === 0 ? head.stdout.trim() : null,
    sourceModified: dirty.status !== 0 || dirty.stdout.trim() !== "",
  };
}

function prepareEnvironment(layout, python) {
  mkdirSync(layout.bin, { recursive: true });
  mkdirSync(layout.state, { recursive: true });
  copyFileSync(SOURCES.renewer, layout.renewer);
  copyFileSync(SOURCES.e2e, layout.e2e);
  copyFileSync(SOURCES.requirements, layout.requirements);
  if (!existsSync(layout.python)) {
    requireSuccess(execute(python, ["-m", "venv", layout.venv]), "Creating the virtual environment");
  }
  requireSuccess(
    execute(layout.python, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--require-virtualenv", "-r", layout.requirements]),
    "Installing the pinned Python packages",
  );
  console.log("Proving the installed renewer with its end-to-end test...");
  requireSuccess(execute(layout.python, ["-I", layout.e2e, "--renewer", layout.renewer]), "The end-to-end test");
}

function registerTask(layout, xml) {
  const file = join(layout.root, "task.xml");
  writeFileSync(file, `\ufeff${xml}`, "utf16le");
  requireSuccess(
    powershell(
      "Register-ScheduledTask -TaskPath $env:STUGU_TASK_PATH -TaskName $env:STUGU_TASK_NAME -Xml (Get-Content -Raw -LiteralPath $env:STUGU_TASK_XML) -Force | Out-Null",
      { STUGU_TASK_PATH: TASK_PATH, STUGU_TASK_NAME: TASK_NAME, STUGU_TASK_XML: file },
    ),
    "Registering the scheduled task",
  );
}

function scheduledTask() {
  const result = powershell(
    "$task = Get-ScheduledTask -TaskPath $env:STUGU_TASK_PATH -TaskName $env:STUGU_TASK_NAME -ErrorAction SilentlyContinue; if ($task) { $info = $task | Get-ScheduledTaskInfo; [pscustomobject]@{ state = [string]$task.State; lastRunTime = $info.LastRunTime.ToUniversalTime().ToString('o'); lastTaskResult = $info.LastTaskResult; nextRunTime = $info.NextRunTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }",
    { STUGU_TASK_PATH: TASK_PATH, STUGU_TASK_NAME: TASK_NAME },
  );
  return result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function install(options, layout) {
  requireKeyDirectory(options.keyDirectory);
  const userId = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  const startDate = new Date().toISOString().slice(0, 10);
  const xml = taskXml({ layout, keyDirectory: options.keyDirectory, time: options.time, userId, startDate });
  if (options.dryRun) {
    console.log(`Would install into ${layout.root} and register ${TASK_PATH}${TASK_NAME}:\n`);
    console.log(layout.windows ? xml : cronLine(layout, options.keyDirectory, options.time));
    return 0;
  }
  prepareEnvironment(layout, options.python ?? (layout.windows ? "python" : "python3"));
  writeFileSync(
    layout.record,
    `${JSON.stringify({
      schema: "stugu-host-tuf-renewal-install/v1",
      installedAt: new Date().toISOString(),
      ...sourceIdentity(),
      renewerSha256: sha256File(layout.renewer),
      requirementsSha256: sha256File(layout.requirements),
      keyDirectory: options.keyDirectory,
      time: options.time,
    }, null, 2)}\n`,
  );
  console.log("Checking the public feed with the installed renewer (read-only)...");
  const check = execute(layout.python, renewArguments(layout, options.keyDirectory, "check"));
  if (check.status !== 0) console.log("The feed needs attention; the scheduled run renews what is due.");
  if (!layout.windows) {
    console.log(`Add this line with crontab -e:\n${cronLine(layout, options.keyDirectory, options.time)}`);
    return 0;
  }
  registerTask(layout, xml);
  console.log(`Registered ${TASK_PATH}${TASK_NAME}: daily at ${options.time} and after logon, catching up missed runs.`);
  return 0;
}

function status(layout) {
  const record = readJson(layout.record);
  const lastRun = readJson(join(layout.state, "last-run.json"));
  const task = layout.windows ? scheduledTask() : null;
  console.log(JSON.stringify({ install: record, task, lastRun }, null, 2));
  const summary = summarizeStatus({ record, lastRun, task: layout.windows ? task : { state: "cron" } });
  console.log(summary.healthy ? "\nHealthy." : `\nNeeds attention:\n- ${summary.problems.join("\n- ")}`);
  return summary.healthy ? 0 : 1;
}

function runInstalled(layout, command) {
  const record = readJson(layout.record);
  if (!record) throw new Error("The renewer is not installed; run install first.");
  return execute(layout.python, renewArguments(layout, record.keyDirectory, command)).status ?? 1;
}

function uninstall(layout) {
  if (!layout.windows) {
    console.log("Remove the host-tuf-renewal line with crontab -e.");
    return 0;
  }
  requireSuccess(
    powershell(
      "Unregister-ScheduledTask -TaskPath $env:STUGU_TASK_PATH -TaskName $env:STUGU_TASK_NAME -Confirm:$false -ErrorAction Stop",
      { STUGU_TASK_PATH: TASK_PATH, STUGU_TASK_NAME: TASK_NAME },
    ),
    "Removing the scheduled task",
  );
  console.log(`Removed ${TASK_PATH}${TASK_NAME}; ${layout.root} is kept.`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const layout = installLayout();
  switch (options.command) {
    case "install":
      return install(options, layout);
    case "status":
      return status(layout);
    case "run":
      return runInstalled(layout, "renew");
    case "check":
      return runInstalled(layout, "check");
    case "uninstall":
      return uninstall(layout);
    default:
      console.log(USAGE);
      return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
