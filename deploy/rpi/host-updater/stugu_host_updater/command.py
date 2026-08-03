"""Bounded subprocess execution without a shell."""

from __future__ import annotations

from dataclasses import dataclass
import json
import subprocess
from typing import Mapping, Sequence

from .errors import UpdaterError


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    returncode: int

    def json(self, label: str) -> object:
        try:
            return json.loads(self.stdout)
        except json.JSONDecodeError as error:
            raise UpdaterError(
                "PLATFORM_RESPONSE_INVALID", f"{label} returned invalid JSON"
            ) from error


class CommandRunner:
    def run(
        self,
        argv: Sequence[str],
        *,
        timeout: int = 60,
        check: bool = True,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        if not argv or any(
            not isinstance(item, str) or "\x00" in item for item in argv
        ):
            raise ValueError("command arguments must be non-empty strings")
        try:
            process = subprocess.run(
                list(argv),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                env=dict(env) if env is not None else None,
            )
        except subprocess.TimeoutExpired as error:
            raise UpdaterError(
                "COMMAND_TIMEOUT", f"{argv[0]} did not finish in time"
            ) from error
        except OSError as error:
            raise UpdaterError(
                "COMMAND_UNAVAILABLE", f"Cannot execute {argv[0]}"
            ) from error
        result = CommandResult(
            process.stdout[-1024 * 1024 :],
            process.stderr[-64 * 1024 :],
            process.returncode,
        )
        if check and result.returncode != 0:
            detail = (
                result.stderr.strip().splitlines()[-1]
                if result.stderr.strip()
                else "command failed"
            )
            raise UpdaterError("COMMAND_FAILED", f"{argv[0]} failed: {detail[:300]}")
        return result
