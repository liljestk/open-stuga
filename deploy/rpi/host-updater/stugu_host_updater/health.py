"""Candidate health gates used before every trial and final success mark."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import time

from .command import CommandRunner
from .config import UpdaterConfig
from .durable import read_bounded_regular
from .errors import UpdaterError
from .platform import ApplianceDisk


@dataclass(frozen=True)
class HealthResult:
    checks: dict[str, str]


HEALTH_EVIDENCE_VALUES = {
    "slot": frozenset({"passed"}),
    "generation": frozenset({"passed"}),
    "root": frozenset({"passed"}),
    "persistent": frozenset({"passed"}),
    "bootconfig": frozenset({"passed"}),
    "clock": frozenset({"passed"}),
    "watchdog": frozenset({"passed", "disabled-by-policy"}),
    "containerRuntime": frozenset({"passed"}),
    "containers": frozenset({"passed"}),
    "sqlite": frozenset({"passed"}),
    "tailscale": frozenset({"passed"}),
    "application": frozenset({"passed"}),
}


def valid_health_evidence(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == set(HEALTH_EVIDENCE_VALUES)
        and all(
            isinstance(result, str) and result in HEALTH_EVIDENCE_VALUES[check]
            for check, result in value.items()
        )
    )


def qualification_watchdog_seconds(path: Path) -> int:
    try:
        data = read_bounded_regular(path, maximum=64 * 1024)
        assert isinstance(data, bytes)
        value = json.loads(data.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, UpdaterError) as error:
        raise UpdaterError(
            "HEALTH_QUALIFICATION_INVALID",
            "The immutable hardware qualification cannot be read",
        ) from error
    seconds = value.get("watchdogSeconds") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("schema") != "stugu-pi4-qualification/v1"
        or value.get("activationEnabled") is not True
        or isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or not 0 <= seconds <= 15
    ):
        raise UpdaterError(
            "HEALTH_QUALIFICATION_INVALID",
            "The immutable hardware qualification has no watchdog policy",
        )
    return seconds


def runtime_watchdog_status(required_seconds: int, runtime_value: str) -> str:
    inactive = not runtime_value or runtime_value in {"0", "0us", "infinity"}
    if required_seconds > 0 and inactive:
        raise UpdaterError(
            "HEALTH_WATCHDOG_INACTIVE", "The qualified system watchdog is not active"
        )
    if required_seconds == 0 and not inactive:
        raise UpdaterError(
            "HEALTH_WATCHDOG_POLICY_MISMATCH",
            "The system watchdog is active despite the qualification policy",
        )
    return "disabled-by-policy" if inactive else "passed"


class HealthChecker:
    def __init__(
        self, config: UpdaterConfig, runner: CommandRunner | None = None
    ) -> None:
        self.config = config
        self.runner = runner or CommandRunner()

    def _unit(self, name: str) -> None:
        result = self.runner.run(
            ["systemctl", "is-active", "--quiet", name], timeout=20, check=False
        )
        if result.returncode != 0:
            raise UpdaterError(
                "HEALTH_UNIT_FAILED", f"Required service {name} is not active"
            )

    def _mount(
        self, target: Path, expected_source: Path, fstype: str, option: str
    ) -> None:
        value = self.runner.run(
            ["findmnt", "--json", "--output", "SOURCE,FSTYPE,OPTIONS", str(target)],
            timeout=15,
        ).json(f"{target} mount")
        filesystems = value.get("filesystems") if isinstance(value, dict) else None
        if (
            not isinstance(filesystems, list)
            or len(filesystems) != 1
            or not isinstance(filesystems[0], dict)
        ):
            raise UpdaterError(
                "HEALTH_MOUNT_INVALID", f"Mount {target} cannot be verified"
            )
        mount = filesystems[0]
        options = str(mount.get("options") or "").split(",")
        if (
            Path(os.path.realpath(str(mount.get("source") or ""))) != expected_source
            or mount.get("fstype") != fstype
            or option not in options
        ):
            raise UpdaterError(
                "HEALTH_MOUNT_MISMATCH",
                f"Mount {target} differs from the appliance contract",
            )

    def _healthy_container(self, service: str) -> str:
        result = self.runner.run(
            [
                "docker",
                "ps",
                "--filter",
                "label=com.docker.compose.project=stugu",
                "--filter",
                f"label=com.docker.compose.service={service}",
                "--format",
                "{{.ID}}",
            ],
            timeout=30,
        )
        identifiers = [
            line.strip() for line in result.stdout.splitlines() if line.strip()
        ]
        if len(identifiers) != 1:
            raise UpdaterError(
                "HEALTH_CONTAINER_MISSING", f"Expected one running {service} container"
            )
        status = self.runner.run(
            [
                "docker",
                "inspect",
                "--format",
                "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                identifiers[0],
            ],
            timeout=30,
        ).stdout.strip()
        if status != "running healthy":
            raise UpdaterError(
                "HEALTH_CONTAINER_UNHEALTHY",
                f"Required container {service} is not healthy",
            )
        return identifiers[0]

    def run(
        self,
        disk: ApplianceDisk,
        expected_slot: str,
        expected_generation: int,
        minimum_trusted_time: int = 0,
    ) -> HealthResult:
        if disk.active_slot != expected_slot:
            raise UpdaterError(
                "HEALTH_SLOT_MISMATCH", "Candidate booted from an unexpected slot"
            )
        generation_path = Path("/etc/stugu-host-generation")
        try:
            actual_generation = int(generation_path.read_text(encoding="ascii").strip())
        except (OSError, UnicodeDecodeError, ValueError) as error:
            raise UpdaterError(
                "HEALTH_GENERATION_UNKNOWN", "Candidate host generation is unavailable"
            ) from error
        if actual_generation != expected_generation:
            raise UpdaterError(
                "HEALTH_GENERATION_MISMATCH",
                "Candidate host generation does not match the signed release",
            )
        self._mount(Path("/"), disk.slot(expected_slot, "system").path, "erofs", "ro")
        self._mount(
            self.config.paths.persistent_mount,
            disk.partitions["persistent"].path,
            "ext4",
            "rw",
        )
        self._mount(Path("/bootfs"), disk.partitions["bootconfig"].path, "vfat", "ro")
        if not os.access(self.config.paths.persistent_mount, os.W_OK):
            raise UpdaterError(
                "HEALTH_PERSISTENT_READ_ONLY",
                "Persistent appliance data is not writable",
            )
        if int(time.time()) < minimum_trusted_time:
            raise UpdaterError(
                "HEALTH_CLOCK_ROLLBACK",
                "Candidate clock is earlier than the trusted update time",
            )
        watchdog = self.runner.run(
            ["systemctl", "show", "--property=RuntimeWatchdogUSec", "--value"],
            timeout=10,
        ).stdout.strip()
        watchdog_status = runtime_watchdog_status(
            qualification_watchdog_seconds(self.config.paths.qualification), watchdog
        )
        for unit in (
            "containerd.service",
            "docker.service",
            "stugu.service",
            "tailscaled.service",
        ):
            self._unit(unit)
        self.runner.run(
            ["docker", "info", "--format", "{{json .ServerVersion}}"], timeout=30
        )
        api = self._healthy_container("api")
        self._healthy_container("timescaledb")
        self._healthy_container("web")
        sqlite_check = (
            "import { DatabaseSync } from 'node:sqlite';"
            "const db=new DatabaseSync('/app/data/climate-twin.sqlite',{readOnly:true});"
            "const q=db.prepare('PRAGMA quick_check').get();"
            "const f=db.prepare('PRAGMA foreign_key_check').all();"
            "if(q.quick_check!=='ok'||f.length!==0)process.exit(1);db.close();"
        )
        self.runner.run(
            [
                "docker",
                "exec",
                "--workdir",
                "/app",
                api,
                "node",
                "--input-type=module",
                "--eval",
                sqlite_check,
            ],
            timeout=180,
        )
        return HealthResult(
            {
                "slot": "passed",
                "generation": "passed",
                "root": "passed",
                "persistent": "passed",
                "bootconfig": "passed",
                "clock": "passed",
                "watchdog": watchdog_status,
                "containerRuntime": "passed",
                "containers": "passed",
                "sqlite": "passed",
                "tailscale": "passed",
                "application": "passed",
            }
        )
