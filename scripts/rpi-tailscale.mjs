#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_OPERATOR = "stugu";
const PERSISTENT_STATE_PATH = "[/shared/var/lib/tailscale]";

const REMOTE_INSPECTION = String.raw`
import json
import socket
import subprocess

def run(arguments):
    completed = subprocess.run(arguments, capture_output=True, text=True, check=False)
    return {
        "code": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }

def first_line(result):
    text = result["stdout"] or result["stderr"]
    return text.splitlines()[0][:300] if text else ""

version = run(["cat", "/etc/stugu-version"])
enabled = run(["systemctl", "is-enabled", "tailscaled.service"])
active = run(["systemctl", "is-active", "tailscaled.service"])
addresses = run(["tailscale", "ip", "-4"])
status = run(["tailscale", "status", "--peers=false"])
mount = run(["findmnt", "-no", "SOURCE,FSTYPE,OPTIONS", "/var/lib/tailscale"])
preferences = run(["tailscale", "debug", "prefs"])

operator = None
if preferences["code"] == 0 and preferences["stdout"]:
    try:
        operator = json.loads(preferences["stdout"]).get("OperatorUser")
    except (json.JSONDecodeError, AttributeError):
        operator = None

mount_fields = mount["stdout"].split(None, 2)
print(json.dumps({
    "hostname": socket.gethostname(),
    "osVersion": first_line(version),
    "serviceEnabled": first_line(enabled),
    "serviceActive": first_line(active),
    "addresses": [line for line in addresses["stdout"].splitlines() if line],
    "status": "Connected" if addresses["stdout"] else first_line(status),
    "mount": {
        "source": mount_fields[0] if len(mount_fields) > 0 else "",
        "filesystem": mount_fields[1] if len(mount_fields) > 1 else "",
        "options": mount_fields[2] if len(mount_fields) > 2 else "",
    },
    "operator": operator,
}))
`;

function help() {
  return `Check or repair Tailscale on a Stugu Raspberry Pi appliance

Usage:
  npm run rpi:tailscale -- check [options]
  npm run rpi:tailscale -- repair [options]

Commands:
  check    Inspect the service, persistent state mount, operator, and Tailnet login.
           This command is read-only and exits 1 when repair is needed.
  repair   Run the appliance's guarded one-time Tailnet login, then check again.
           It refuses to continue when the service or persistent mount is broken.

Options:
  --target <user@host>       SSH target (default: stugu@stugu.local)
  --identity-file <path>     Recovery SSH key (default: ~/.ssh/stuga_appliance)
  --ssh-port <port>          SSH port (default: 22)
  --known-hosts <path>       Use a dedicated known_hosts file
  --json                     Machine-readable output for check
  -h, --help                 Show this help

SSH host-key checking is always strict. Verify a new appliance fingerprint through
the trusted console and record it before using this command. Repair never removes
old Tailnet devices or changes Tailnet policy.
`;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function safeSshTarget(value) {
  if (typeof value !== "string" || value.startsWith("-") || value.includes(" ") || value.includes("\0")) {
    throw new Error("--target must be a safe SSH user/host without spaces or options");
  }
  const target = /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}@)?(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.%]+\])$/u;
  if (!target.test(value)) {
    throw new Error("--target must look like user@hostname, an IP address, or a bracketed IPv6 address");
  }
  return value;
}

function regularFile(path, label, fileExists = existsSync, fileStat = statSync) {
  if (!fileExists(path) || !fileStat(path).isFile()) {
    throw new Error(`${label} does not exist or is not a regular file: ${path}`);
  }
  return path;
}

export function parseRpiTailscaleArguments(argv, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const home = context.home ?? homedir();
  const fileExists = context.exists ?? existsSync;
  const fileStat = context.stat ?? statSync;
  const first = argv[0];
  const options = {
    command: first,
    target: "stugu@stugu.local",
    identityFile: resolve(home, ".ssh", "stuga_appliance"),
    sshPort: 22,
    json: false,
    help: first === undefined || first === "-h" || first === "--help",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (["--target", "--identity-file", "--ssh-port", "--known-hosts"].includes(argument)) {
      const key = {
        "--target": "target",
        "--identity-file": "identityFile",
        "--ssh-port": "sshPort",
        "--known-hosts": "knownHosts",
      }[argument];
      options[key] = valueAfter(argv, index, argument);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!["check", "repair"].includes(options.command)) {
    throw new Error("First argument must be check or repair");
  }
  if (options.command === "repair" && options.json) {
    throw new Error("--json is only available with check because repair is interactive");
  }
  options.target = safeSshTarget(options.target);
  options.identityFile = regularFile(
    resolve(cwd, options.identityFile),
    "SSH identity file",
    fileExists,
    fileStat,
  );
  options.sshPort = Number(options.sshPort);
  if (!Number.isInteger(options.sshPort) || options.sshPort < 1 || options.sshPort > 65_535) {
    throw new Error("--ssh-port must be from 1 to 65535");
  }
  if (options.knownHosts) {
    options.knownHosts = regularFile(
      resolve(cwd, options.knownHosts),
      "known_hosts file",
      fileExists,
      fileStat,
    );
  }
  return options;
}

export function sshArguments(options) {
  return [
    "-p", String(options.sshPort),
    "-i", options.identityFile,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    ...(options.knownHosts ? ["-o", `UserKnownHostsFile=${options.knownHosts}`] : []),
  ];
}

export function runProcess(executable, arguments_, { input, interactive = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    if (interactive) {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) accept({ stdout: "", stderr: "" });
        else reject(new Error(`${executable} exited with ${code}`));
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(`${executable} exited with ${code}: ${stderr.trim().slice(0, 2_000) || stdout.trim().slice(0, 2_000)}`));
    });
    child.stdin.end(input ?? "");
  });
}

function parseLastJson(output) {
  for (const line of String(output).trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* SSH banners may precede the result. */ }
  }
  throw new Error("The appliance did not return Tailscale diagnostics");
}

export async function inspectRpiTailscale(options, dependencies = {}) {
  const run = dependencies.runProcess ?? runProcess;
  const result = await run(
    "ssh",
    [...sshArguments(options), options.target, "python3", "-"],
    { input: REMOTE_INSPECTION },
  );
  return parseLastJson(result.stdout);
}

export function assessRpiTailscale(diagnostics) {
  const issues = [];
  const serviceEnabled = diagnostics.serviceEnabled === "enabled";
  const serviceActive = diagnostics.serviceActive === "active";
  const statePersistent = String(diagnostics.mount?.source ?? "").includes(PERSISTENT_STATE_PATH);
  const connected = Array.isArray(diagnostics.addresses) && diagnostics.addresses.length > 0;
  const operatorReady = diagnostics.operator === EXPECTED_OPERATOR;
  if (!serviceEnabled) issues.push(`tailscaled.service is ${diagnostics.serviceEnabled || "not enabled"}`);
  if (!serviceActive) issues.push(`tailscaled.service is ${diagnostics.serviceActive || "not active"}`);
  if (!statePersistent) issues.push("/var/lib/tailscale is not mounted from the persistent shared partition");
  if (!connected) issues.push(diagnostics.status || "the Pi is not logged in to Tailscale");
  if (!operatorReady) issues.push(`Tailscale operator is ${diagnostics.operator || "not set"}; expected ${EXPECTED_OPERATOR}`);
  return {
    ...diagnostics,
    healthy: issues.length === 0,
    repairable: serviceEnabled && serviceActive && statePersistent,
    connected,
    statePersistent,
    operatorReady,
    issues,
  };
}

export function formatRpiTailscaleReport(report) {
  const lines = [
    `Raspberry Pi Tailscale: ${report.healthy ? "PASS" : "NEEDS REPAIR"}`,
    `Host: ${report.hostname || "unknown"}${report.osVersion ? ` (Stugu ${report.osVersion})` : ""}`,
    `Service: ${report.serviceEnabled || "unknown"}, ${report.serviceActive || "unknown"}`,
    `Persistent state: ${report.statePersistent ? "mounted" : "missing"}${report.mount?.source ? ` (${report.mount.source})` : ""}`,
    `Tailnet: ${report.connected ? report.addresses.join(", ") : report.status || "not connected"}`,
    `Operator: ${report.operator || "not set"}`,
  ];
  if (report.issues.length > 0) {
    lines.push("Issues:", ...report.issues.map((issue) => `- ${issue}`));
  }
  return lines.join("\n");
}

export async function runRpiTailscale(options, dependencies = {}) {
  const inspect = dependencies.inspect ?? inspectRpiTailscale;
  const run = dependencies.runProcess ?? runProcess;
  const write = dependencies.write ?? ((message) => process.stdout.write(`${message}\n`));
  let report = assessRpiTailscale(await inspect(options, { runProcess: run }));
  if (options.command === "check" || report.healthy) {
    write(options.json ? JSON.stringify(report) : formatRpiTailscaleReport(report));
    return report.healthy ? 0 : 1;
  }
  if (!report.repairable) {
    write(formatRpiTailscaleReport(report));
    throw new Error("Repair stopped because the Tailscale service or persistent state mount needs host maintenance");
  }
  write("Starting the guarded Tailnet login. Open the printed URL and approve this Pi.");
  await run(
    "ssh",
    [...sshArguments(options), options.target, "stuguctl", "tailscale", "up"],
    { interactive: true },
  );
  report = assessRpiTailscale(await inspect(options, { runProcess: run }));
  write(formatRpiTailscaleReport(report));
  if (!report.healthy) throw new Error("Tailscale repair completed, but verification still failed");
  return 0;
}

async function main() {
  try {
    const options = parseRpiTailscaleArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help());
      return;
    }
    process.exitCode = await runRpiTailscale(options);
  } catch (error) {
    process.stderr.write(`Raspberry Pi Tailscale check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
