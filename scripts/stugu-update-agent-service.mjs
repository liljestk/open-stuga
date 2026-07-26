#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);

function serviceId(root, platform) {
  const identity = platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

function checkedText(value, label) {
  if (/[\0\r\n]/u.test(value)) throw new Error(`${label} contains unsupported control characters`);
  return value;
}

function atomicWrite(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function updateEnvironmentAssignment(path, key, value) {
  if (!existsSync(path)) throw new Error(`Missing ${path}; run Stugu setup first`);
  const source = readFileSync(path, "utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "mu");
  const next = pattern.test(source)
    ? source.replace(pattern, assignment)
    : `${source ? source.replace(/\r?\n?$/u, newline) : ""}${assignment}${newline}`;
  if (next !== source) atomicWrite(path, next, statSync(path).mode);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
}

function runChecked(runner, command, args, options = {}) {
  const result = runner(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed while configuring the update-agent service`);
  }
}

function powershellLiteral(value) {
  return `'${checkedText(value, "Service value").replaceAll("'", "''")}'`;
}

function windowsCommandArgument(value) {
  const text = checkedText(value, "Service argument");
  if (!/[\s"]/u.test(text)) return text;
  let quoted = "\"";
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === "\"") {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      quoted += `${"\\".repeat(backslashes)}${character}`;
      backslashes = 0;
    }
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function systemdArgument(value) {
  return `"${checkedText(value, "Service argument")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "$$")
    .replaceAll("%", "%%")}"`;
}

function xml(value) {
  return checkedText(value, "Service value")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function updateAgentServiceDefinition(root, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Automatic update-agent service installation is not supported on ${platform}`);
  }
  const absoluteRoot = checkedText(resolve(root), "Project path");
  const id = serviceId(absoluteRoot, platform);
  const executable = resolve(options.nodeExecutable ?? process.execPath);
  const arguments_ = [
    `--env-file-if-exists=${join(absoluteRoot, ".env")}`,
    join(absoluteRoot, "scripts", "stugu-update-agent.mjs"),
    `--project-directory=${absoluteRoot}`,
  ];

  if (platform === "win32") {
    const taskName = `Stugu Update Agent (${id})`;
    const actionArguments = arguments_.map(windowsCommandArgument).join(" ");
    const source = [
      "$ErrorActionPreference = 'Stop'",
      `$taskName = ${powershellLiteral(taskName)}`,
      "$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(executable)} -Argument ${powershellLiteral(actionArguments)} -WorkingDirectory ${powershellLiteral(absoluteRoot)}`,
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser",
      "$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited",
      "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
      "if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {",
      "  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
      "}",
      "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Installs trusted Stugu container releases for this project.' -Force | Out-Null",
      "Start-ScheduledTask -TaskName $taskName",
      "",
    ].join("\r\n");
    return {
      id,
      install: {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(source, "utf16le").toString("base64"),
        ],
        command: "powershell.exe",
      },
      kind: "Windows per-user scheduled task",
      name: taskName,
      platform,
      remove: {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from([
            "$ErrorActionPreference = 'Stop'",
            `$taskName = ${powershellLiteral(taskName)}`,
            "if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {",
            "  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
            "  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false",
            "}",
            "",
          ].join("\r\n"), "utf16le").toString("base64"),
        ],
        command: "powershell.exe",
      },
    };
  }

  if (platform === "linux") {
    const homeDirectory = resolve(options.homeDirectory ?? homedir());
    const name = `stugu-update-agent-${id}.service`;
    const path = join(homeDirectory, ".config", "systemd", "user", name);
    const content = `[Unit]
Description=Stugu Docker update agent for ${absoluteRoot}

[Service]
Type=simple
WorkingDirectory=${systemdArgument(absoluteRoot)}
ExecStart=${[executable, ...arguments_].map(systemdArgument).join(" ")}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    return {
      content,
      id,
      kind: "systemd per-user service",
      name,
      path,
      platform,
    };
  }

  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const label = `io.open-stuga.update-agent.${id}`;
  const path = join(homeDirectory, "Library", "LaunchAgents", `${label}.plist`);
  const logDirectory = join(absoluteRoot, "data", "update-agent-service");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[executable, ...arguments_].map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(absoluteRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDirectory, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDirectory, "stderr.log"))}</string>
</dict>
</plist>
`;
  return {
    content,
    id,
    kind: "macOS per-user LaunchAgent",
    label,
    logDirectory,
    name: label,
    path,
    platform,
  };
}

export function installUpdateAgentService(root = projectRoot, dependencies = {}) {
  const definition = updateAgentServiceDefinition(root, dependencies);
  const runner = dependencies.runner ?? run;
  const writer = dependencies.writer ?? atomicWrite;

  if (definition.platform === "win32") {
    runChecked(runner, definition.install.command, definition.install.args, { cwd: resolve(root) });
  } else if (definition.platform === "linux") {
    const groupId = dependencies.groupId ?? process.getgid?.();
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new Error("Could not determine the Linux update-agent account group");
    }
    updateEnvironmentAssignment(
      join(resolve(root), ".env"),
      "STUGA_UPDATE_OPERATIONS_GID",
      String(groupId),
    );
    runChecked(
      runner,
      "docker",
      ["compose", "run", "--rm", "--no-deps", "update-operations-init"],
      { cwd: resolve(root) },
    );
    writer(definition.path, definition.content, 0o600);
    runChecked(runner, "systemctl", ["--user", "daemon-reload"]);
    runChecked(runner, "systemctl", ["--user", "enable", definition.name]);
    runChecked(runner, "systemctl", ["--user", "restart", definition.name]);
  } else {
    mkdirSync(definition.logDirectory, { recursive: true });
    writer(definition.path, definition.content, 0o600);
    const target = `gui/${dependencies.uid ?? process.getuid?.()}`;
    runner("launchctl", ["bootout", target, definition.path], { quiet: true });
    runChecked(runner, "launchctl", ["bootstrap", target, definition.path]);
    runChecked(runner, "launchctl", ["kickstart", "-k", `${target}/${definition.label}`]);
  }

  return definition;
}

export function uninstallUpdateAgentService(root = projectRoot, dependencies = {}) {
  const definition = updateAgentServiceDefinition(root, dependencies);
  const runner = dependencies.runner ?? run;

  if (definition.platform === "win32") {
    runChecked(runner, definition.remove.command, definition.remove.args, { cwd: resolve(root) });
  } else if (definition.platform === "linux") {
    runner("systemctl", ["--user", "disable", "--now", definition.name], { quiet: true });
    rmSync(definition.path, { force: true });
    runChecked(runner, "systemctl", ["--user", "daemon-reload"]);
  } else {
    const target = `gui/${dependencies.uid ?? process.getuid?.()}`;
    runner("launchctl", ["bootout", target, definition.path], { quiet: true });
    rmSync(definition.path, { force: true });
  }
  return definition;
}

async function main(args) {
  const action = args[0] ?? "install";
  if (action !== "install" && action !== "uninstall") {
    throw new Error("Usage: node scripts/stugu-update-agent-service.mjs [install|uninstall]");
  }
  const definition = action === "install"
    ? installUpdateAgentService()
    : uninstallUpdateAgentService();
  console.log(`${action === "install" ? "Installed and started" : "Removed"} ${definition.kind}: ${definition.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
