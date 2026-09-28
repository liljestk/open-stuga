#!/usr/bin/env python3
"""Bounded, read-only Stugu appliance evidence collector.

This file is streamed over one SSH connection. It emits one JSON object and
never prints environment variables, configuration values, database rows, or
raw logs.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import platform
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


STARTED = time.monotonic()
MAX_OUTPUT = 256 * 1024
SAFE_VERSION = re.compile(r"^[0-9A-Za-z._+-]{1,100}$")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()


def run(
    arguments: list[str], timeout: float = 3.0, input_text: str | None = None
) -> dict[str, Any]:
    started = time.monotonic()

    def probe(outcome: str, status: int | None = None) -> dict[str, Any]:
        # Only fixed classifications survive the collector; command text and
        # stderr can contain host paths, configuration, or application data.
        return {
            "outcome": outcome,
            "durationMs": round((time.monotonic() - started) * 1000),
            "exitCode": status,
        }

    try:
        completed = subprocess.run(
            arguments,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={
                "PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin"),
                "LANG": "C.UTF-8",
            },
        )
        stdout = completed.stdout[:MAX_OUTPUT]
        stderr = completed.stderr[:MAX_OUTPUT]
        outcome = "success" if completed.returncode == 0 else "failed"
        if completed.returncode != 0:
            if re.search(
                r"permission denied|operation not permitted|a password is required|"
                r"no tty present|not allowed to execute|not in the sudoers|"
                r"a terminal is required",
                stderr,
                flags=re.IGNORECASE,
            ):
                outcome = "permission-denied"
            elif completed.returncode == 127:
                outcome = "not-found"
        return {
            "ok": completed.returncode == 0,
            "status": completed.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "probe": probe(outcome, completed.returncode),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "ok": False,
            "status": None,
            "stdout": "",
            "stderr": type(error).__name__,
            "probe": probe(
                "timeout" if isinstance(error, subprocess.TimeoutExpired)
                else "not-found" if isinstance(error, FileNotFoundError)
                else "permission-denied" if isinstance(error, PermissionError)
                else "failed"
            ),
        }


def read_text(path: str, maximum: int = 16_384) -> str | None:
    try:
        value = Path(path).read_text(encoding="utf-8", errors="replace")
        return value[:maximum]
    except OSError:
        return None


def parse_key_values(value: str | None, allowed: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in (value or "").splitlines():
        key, separator, raw = line.partition("=")
        if not separator:
            key, separator, raw = line.partition(":")
        key = key.strip()
        raw = raw.strip()
        if separator and key in allowed and len(raw) <= 200:
            result[key] = raw
    return result


def filesystem_snapshot(path: str) -> dict[str, Any]:
    try:
        disk = os.statvfs(path)
    except OSError:
        return {"available": False}
    mounted = run(
        [
            "findmnt",
            "--noheadings",
            "--output",
            "FSTYPE,OPTIONS",
            "--target",
            path,
        ],
        timeout=1.5,
    )
    fields = mounted["stdout"].strip().split(None, 1) if mounted["ok"] else []
    filesystem_type = fields[0][:40] if fields else None
    options = fields[1].split(",") if len(fields) == 2 else []
    return {
        "available": True,
        "totalBytes": disk.f_blocks * disk.f_frsize,
        "availableBytes": disk.f_bavail * disk.f_frsize,
        "filesystemType": filesystem_type,
        "readOnly": bool(disk.f_flag & os.ST_RDONLY) or "ro" in options,
    }


def system_snapshot() -> dict[str, Any]:
    memory = parse_key_values(read_text("/proc/meminfo"), {"MemTotal", "MemAvailable"})
    root = filesystem_snapshot("/")
    persistent = filesystem_snapshot("/persistent")
    load = os.getloadavg()
    return {
        "architecture": platform.machine(),
        "kernel": platform.release()[:100],
        "cpuCount": os.cpu_count(),
        "loadAverage": [round(item, 2) for item in load],
        "memoryTotalBytes": int(memory.get("MemTotal", "0 kB").split()[0]) * 1024,
        "memoryAvailableBytes": int(memory.get("MemAvailable", "0 kB").split()[0])
        * 1024,
        "rootTotalBytes": root.get("totalBytes"),
        "rootAvailableBytes": root.get("availableBytes"),
        "rootFilesystemType": root.get("filesystemType"),
        "rootReadOnly": root.get("readOnly"),
        "persistentTotalBytes": persistent.get("totalBytes"),
        "persistentAvailableBytes": persistent.get("availableBytes"),
        "persistentFilesystemType": persistent.get("filesystemType"),
        "persistentReadOnly": persistent.get("readOnly"),
    }


def service_snapshot() -> dict[str, Any]:
    result = run(
        [
            "systemctl",
            "show",
            "stugu.service",
            "--no-pager",
            "--property=ActiveState,SubState,NRestarts,ExecMainStatus,ActiveEnterTimestampMonotonic",
        ]
    )
    values = parse_key_values(
        result["stdout"],
        {
            "ActiveState",
            "SubState",
            "NRestarts",
            "ExecMainStatus",
            "ActiveEnterTimestampMonotonic",
        },
    )
    return {"available": result["ok"], "probes": {"service": result["probe"]}, **values}


def docker_snapshot() -> dict[str, Any]:
    listed = run(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            "label=com.docker.compose.project=stugu",
            "--format",
            "{{json .}}",
        ],
        timeout=3.5,
    )
    probes = {"dockerList": listed["probe"]}
    if not listed["ok"]:
        return {"available": False, "containers": [], "stats": [], "probes": probes}
    containers: list[dict[str, Any]] = []
    names: list[str] = []
    for line in listed["stdout"].splitlines()[:40]:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = str(item.get("Names", ""))[:120]
        names.append(name)
        containers.append(
            {
                "name": name,
                "image": str(item.get("Image", ""))[:300],
                "state": str(item.get("State", "unknown"))[:40],
                "status": str(item.get("Status", ""))[:160],
            }
        )
    inspected: dict[str, dict[str, Any]] = {}
    if names:
        values = run(
            [
                "docker",
                "inspect",
                "--format",
                "{{.Name}}\\t{{.Image}}\\t{{.RestartCount}}\\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\\t{{.State.ExitCode}}\\t{{.HostConfig.RestartPolicy.Name}}",
                *names,
            ],
            timeout=3.5,
        )
        probes["dockerInspect"] = values["probe"]
        for line in values["stdout"].splitlines()[:40]:
            fields = line.split("\t")
            if len(fields) == 6:
                inspected[fields[0].lstrip("/")] = {
                    "imageId": fields[1],
                    "restartCount": fields[2],
                    "health": fields[3],
                    "exitCode": fields[4],
                    "restartPolicy": fields[5],
                }
    for item in containers:
        details = inspected.get(item["name"], {})
        item["imageId"] = str(details.get("imageId", ""))[:80]
        item["restartCount"] = int(details.get("restartCount", 0) or 0)
        item["health"] = str(details.get("health", "none"))[:40]
        item["exitCode"] = int(details.get("exitCode", 0) or 0)
        item["restartPolicy"] = str(details.get("restartPolicy", ""))[:40]
    stats: list[dict[str, str]] = []
    if names:
        sampled = run(
            [
                "docker",
                "stats",
                "--no-stream",
                "--format",
                "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}",
                *names,
            ],
            timeout=4.0,
        )
        probes["dockerStats"] = sampled["probe"]
        for line in sampled["stdout"].splitlines()[:40]:
            fields = line.split("\t")
            if len(fields) == 3:
                stats.append(
                    {
                        "name": fields[0][:120],
                        "cpu": fields[1][:40],
                        "memory": fields[2][:100],
                    }
                )
    return {
        "available": True,
        "inspectAvailable": not names or values["ok"],
        "containers": containers,
        "stats": stats,
        "probes": probes,
    }


def health_snapshot() -> dict[str, Any]:
    started = time.monotonic()
    http_status: int | None = None

    def result(outcome: str, available: bool = False, **values: Any) -> dict[str, Any]:
        return {
            "available": available,
            **values,
            "probe": {
                "outcome": outcome,
                "durationMs": round((time.monotonic() - started) * 1000),
                "httpStatus": http_status,
            },
        }

    request = urllib.request.Request(
        "http://127.0.0.1:8080/api/v1/health", headers={"Accept": "application/json"}
    )
    try:
        try:
            response = urllib.request.urlopen(request, timeout=2.5)
        except urllib.error.HTTPError as error:
            # A degraded 503 can still contain useful, allowlisted health data.
            response = error
        with response:
            http_status = response.status
            body = response.read(MAX_OUTPUT + 1)
            if len(body) > MAX_OUTPUT:
                return result("invalid-response")
            value = json.loads(body)
            if not isinstance(value, dict):
                return result("invalid-response")
            allowed = {
                "status",
                "systemVersion",
                "apiVersion",
                "database",
                "telemetryArchive",
                "cache",
                "analytics",
                "timeseriesPool",
                "timeseriesQueries",
                "eventLoopLagMs",
                "uptimeSeconds",
            }
            return result(
                "success" if 200 <= http_status < 300 else "http-error",
                True,
                **{key: value[key] for key in allowed if key in value},
            )
    except (OSError, ValueError, urllib.error.URLError) as error:
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        outcome = (
            "timeout"
            if isinstance(reason, TimeoutError)
            else "invalid-response"
            if isinstance(error, ValueError)
            else "connection-error"
        )
        return result(outcome)


DATABASE_SCRIPT = r"""
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/data/climate-twin.sqlite", { readOnly: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
function rows(table, columns = "1", where = "") {
  if (!tables.has(table)) return { available: false, count: 0, capped: false, values: [] };
  const values = db.prepare(`SELECT ${columns} FROM ${table} ${where} LIMIT 101`).all();
  return { available: true, count: Math.min(values.length, 100), capped: values.length > 100, values: values.slice(0, 100) };
}
const alert = rows("alert_evaluation_queue");
const pendingNotifications = rows("notification_outbox", "1", "WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL");
const deadLetteredNotifications = rows("notification_outbox", "1", "WHERE delivered_at IS NULL AND dead_lettered_at IS NOT NULL AND abandoned_at IS NULL");
const tapo = rows("tapo_history_export_jobs", "status", "WHERE status NOT IN ('completed', 'cancelled')");
const sources = rows("sensor_source_metrics", "source");
const heat = rows("heat_pump_state_current");
const devices = rows("connected_device_state_current");
const gateways = rows("external_source_gateways", "adapter, enabled");
const result = {
  available: true,
  queues: {
    alertEvaluation: { count: alert.count, capped: alert.capped },
    notifications: {
      count: pendingNotifications.count,
      capped: pendingNotifications.capped,
      deadLettered: deadLetteredNotifications.count,
      deadLetteredCapped: deadLetteredNotifications.capped,
    },
    tapoExports: {
      count: tapo.count,
      capped: tapo.capped,
      needsAttention: tapo.values.filter((row) => row.status === "needs-attention").length,
    },
  },
  integrations: {
    homeAssistantMetrics: sources.values.filter((row) => row.source === "home-assistant").length,
    tpLinkMetrics: sources.values.filter((row) => row.source === "tp-link").length,
    sourceMetricsCapped: sources.capped,
    heatPumpConnections: heat.count,
    heatPumpConnectionsCapped: heat.capped,
    connectedDevices: devices.count,
    connectedDevicesCapped: devices.capped,
    externalGateways: gateways.values.map((row) => ({ adapter: String(row.adapter).slice(0, 64), enabled: row.enabled === 1 })),
    externalGatewaysCapped: gateways.capped,
  },
};
if (process.argv.includes("--deep")) {
  result.integrity = {
    quickCheck: db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]).slice(0, 20),
    foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().slice(0, 100).length,
  };
}
console.log(JSON.stringify(result));
db.close();
"""


def api_container_lookup() -> tuple[str, dict[str, Any]]:
    container = run(
        [
            "docker",
            "ps",
            "--filter",
            "label=com.docker.compose.project=stugu",
            "--filter",
            "label=com.docker.compose.service=api",
            "--format",
            "{{.Names}}",
        ]
    )
    name = (
        container["stdout"].splitlines()[0].strip()
        if container["ok"] and container["stdout"].strip()
        else ""
    )
    return name, container["probe"]


def database_snapshot(deep: bool) -> dict[str, Any]:
    name, lookup = api_container_lookup()
    probes = {"databaseLookup": lookup}
    if not name:
        return {"available": False, "reason": "api-container-unavailable", "probes": probes}
    arguments = ["docker", "exec", name, "node", "-e", DATABASE_SCRIPT]
    if deep:
        arguments.extend(["--", "--deep"])
    result = run(arguments, timeout=12.0 if deep else 3.5)
    probes["databaseQuery"] = result["probe"]
    try:
        value = json.loads(result["stdout"])
        return (
            {**value, "probes": probes}
            if result["ok"] and isinstance(value, dict)
            else {"available": False, "reason": "query-failed", "probes": probes}
        )
    except json.JSONDecodeError:
        return {"available": False, "reason": "query-failed", "probes": probes}


def updater_snapshot() -> dict[str, Any]:
    hardware = run(["stuguctl", "host-update", "hardware-id"], timeout=3.0)
    status = run(["stuguctl", "host-update", "status"], timeout=3.0)
    try:
        hardware_value = json.loads(hardware["stdout"])
    except json.JSONDecodeError:
        hardware_value = {}
    try:
        status_value = json.loads(status["stdout"])
    except json.JSONDecodeError:
        status_value = {}
    fingerprint = str(hardware_value.get("fingerprint", ""))
    allowed_status = {
        "schema",
        "phase",
        "detail",
        "errorCode",
        "updatedAt",
        "targetVersion",
        "targetGeneration",
        "targetSlot",
        "journalPhase",
        "health",
        "rollbackReason",
        "rollbackError",
    }
    return {
        "available": hardware["ok"] and status["ok"],
        "probes": {"updaterHardware": hardware["probe"], "updaterStatus": status["probe"]},
        "hardwareFingerprint": fingerprint
        if re.fullmatch(r"sha256:[0-9a-f]{64}", fingerprint)
        else None,
        "status": {
            key: status_value[key] for key in allowed_status if key in status_value
        },
    }


def versions_snapshot() -> dict[str, Any]:
    host = (read_text("/etc/stugu-version", 200) or "").strip()
    release = parse_key_values(
        read_text("/persistent/stugu/release-status"),
        {"version", "healthy_at", "failed_version", "failed_at"},
    )
    return {
        "host": host if SAFE_VERSION.fullmatch(host) else None,
        "release": release,
    }


API_LOG_LIMIT = 160
API_LOG_PATTERNS = {
    "sqlite-lock": r"\bSQLITE_(?:BUSY|LOCKED)\b|database (?:is |table is )?locked",
    "storage-io": r"\b(?:SQLITE_IOERR|SQLITE_FULL|ENOSPC|EROFS)\b|disk I/O error|no space left|read-only file system",
    "memory": r"heap out of memory|allocation failed|\b(?:ENOMEM|OOM)\b|out of memory",
    "database-timeout": r"statement timeout|query (?:read )?timeout|connection (?:acquisition )?timeout",
    "connection": r"\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH)\b|connection terminated|too many clients|remaining connection slots",
    "analytics-capacity": r"ANALYTICS_BUSY|AnalyticsCapacityError|analytics capacity is temporarily full",
    "archive": r"telemetry.archive.*(?:unavailable|failed)|(?:initialize|reconciliation).*(?:archive|TimescaleDB)",
    "runtime": r"(?:Type|Range|Reference|Syntax)Error:|uncaught|unhandled",
}


def summarize_api_logs(raw: str) -> dict[str, Any]:
    """Reduce transient log text to fixed categories; no raw content survives."""
    lines = [line for line in raw[:MAX_OUTPUT].splitlines() if line.strip()][
        :API_LOG_LIMIT
    ]
    categories: dict[str, int] = {}
    for line in lines:
        matches = [
            category
            for category, pattern in API_LOG_PATTERNS.items()
            if re.search(pattern, line, flags=re.IGNORECASE)
        ]
        if not matches and re.search(
            r"\b(?:error|fatal|failed|failure)\b", line, flags=re.IGNORECASE
        ):
            matches = ["other-error"]
        for category in matches:
            categories[category] = categories.get(category, 0) + 1
    return {
        "records": len(lines),
        "categories": categories,
        "capped": len(raw) >= MAX_OUTPUT or len(lines) >= API_LOG_LIMIT,
    }


def api_logs_snapshot() -> dict[str, Any]:
    name, lookup = api_container_lookup()
    probes = {"apiLogsLookup": lookup}
    if not name:
        return {"available": False, "reason": "api-container-unavailable", "probes": probes}
    result = run(
        ["docker", "logs", "--since=15m", f"--tail={API_LOG_LIMIT}", name],
        timeout=4.0,
    )
    probes["apiLogsRead"] = result["probe"]
    if not result["ok"]:
        return {"available": False, "reason": "log-read-unavailable", "probes": probes}
    # Docker places application stderr in its own stderr even on success.
    summary = summarize_api_logs(result["stdout"] + "\n" + result["stderr"])
    return {"available": True, "windowMinutes": 15, "probes": probes, **summary}


def logs_snapshot() -> dict[str, Any]:
    result = run(
        [
            "journalctl",
            "--unit=stugu.service",
            "--no-pager",
            "--output=json",
            "--lines=120",
            "--since=-24 hours",
        ],
        timeout=5.0,
    )
    priorities: dict[str, int] = {}
    message_hashes: list[str] = []
    for line in result["stdout"].splitlines()[:120]:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        priority = str(item.get("PRIORITY", "unknown"))[:20]
        priorities[priority] = priorities.get(priority, 0) + 1
        if priority in {"0", "1", "2", "3"}:
            message_hashes.append(digest(str(item.get("MESSAGE", "")))[:16])
    return {
        "available": result["ok"],
        "probes": {"journal": result["probe"]},
        "priorities": priorities,
        "errorMessageHashes": message_hashes[:20],
    }


def identity(updater: dict[str, Any]) -> dict[str, Any]:
    machine = (read_text("/etc/machine-id", 200) or "unavailable").strip()
    hostname = platform.node() or "unavailable"
    hardware = updater.get("hardwareFingerprint")
    if not hardware:
        serial = (
            read_text("/proc/device-tree/serial-number", 200) or "unavailable"
        ).strip("\x00\n ")
        model = (read_text("/proc/device-tree/model", 500) or platform.machine()).strip(
            "\x00\n "
        )
        hardware = f"sha256:{digest(f'{machine}|{serial}|{model}')}"
    return {
        "machineIdSha256": digest(machine),
        "hostnameSha256": digest(hostname),
        "hardwareFingerprint": hardware,
    }


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--deep", action="store_true")
    options = parser.parse_args()
    tasks = {
        "system": system_snapshot,
        "service": service_snapshot,
        "docker": docker_snapshot,
        "health": health_snapshot,
        "database": lambda: database_snapshot(options.deep),
        "updater": updater_snapshot,
        "versions": versions_snapshot,
    }
    if options.deep:
        tasks["logs"] = logs_snapshot
        tasks["apiLogs"] = api_logs_snapshot
    results: dict[str, Any] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        pending = {name: executor.submit(function) for name, function in tasks.items()}
        for name, future in pending.items():
            try:
                results[name] = future.result(timeout=13.0 if options.deep else 6.0)
            except (
                Exception
            ) as error:  # Keep one optional collector from hiding the rest.
                results[name] = {"available": False, "reason": type(error).__name__}
    updater = results["updater"]
    output = {
        "schema": "stugu-rpi-doctor-evidence/v1",
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationMs": round((time.monotonic() - STARTED) * 1000),
        "deep": options.deep,
        "identity": identity(updater),
        **results,
    }
    print(json.dumps(output, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
