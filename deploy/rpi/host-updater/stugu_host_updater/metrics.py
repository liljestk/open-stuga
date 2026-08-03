"""Bounded Prometheus textfile metrics for host-update operations."""

from __future__ import annotations

from pathlib import Path
from typing import Mapping

from .durable import atomic_json, atomic_write, read_json


COUNTERS = {
    "checking": "checks",
    "downloading": "stages",
    "restarting": "activations",
    "verifying": "trials",
    "complete": "commits",
    "returned": "rollbacks",
    "failed": "failures",
    "recovery-needed": "recovery_needed",
}


class MetricsExporter:
    def __init__(self, directory: Path) -> None:
        self.state_path = directory / "metrics-state.json"
        self.text_path = directory / "metrics.prom"

    def _load(self) -> dict[str, int]:
        try:
            value = read_json(self.state_path, maximum=32 * 1024)
        except Exception:
            return {}
        if (
            not isinstance(value, dict)
            or value.get("schema") != "stugu-host-update-metrics/v1"
        ):
            return {}
        counters = value.get("counters")
        if not isinstance(counters, dict) or any(
            not isinstance(name, str)
            or isinstance(number, bool)
            or not isinstance(number, int)
            or number < 0
            for name, number in counters.items()
        ):
            return {}
        return dict(counters)

    def update(self, phase: str, status: Mapping[str, object]) -> None:
        counters = self._load()
        counter = COUNTERS.get(phase)
        if counter:
            counters[counter] = counters.get(counter, 0) + 1
        atomic_json(
            self.state_path,
            {"schema": "stugu-host-update-metrics/v1", "counters": counters},
            mode=0o640,
        )
        lines = [
            "# HELP stugu_host_update_events_total Host updater state-transition events.",
            "# TYPE stugu_host_update_events_total counter",
        ]
        for name in sorted(set(COUNTERS.values()) | set(counters)):
            lines.append(
                f'stugu_host_update_events_total{{event="{name}"}} {counters.get(name, 0)}'
            )
        lines.extend(
            [
                "# HELP stugu_host_update_phase Current host updater phase.",
                "# TYPE stugu_host_update_phase gauge",
                f'stugu_host_update_phase{{phase="{phase}"}} 1',
                "# HELP stugu_host_update_target_generation Selected target generation.",
                "# TYPE stugu_host_update_target_generation gauge",
                f"stugu_host_update_target_generation {self._number(status.get('targetGeneration'))}",
                "# HELP stugu_host_update_bytes_total Signed target size in bytes.",
                "# TYPE stugu_host_update_bytes_total gauge",
                f"stugu_host_update_bytes_total {self._number(status.get('bytesTotal', status.get('bytes')))}",
                "# HELP stugu_host_update_bytes_complete Verified target bytes downloaded.",
                "# TYPE stugu_host_update_bytes_complete gauge",
                f"stugu_host_update_bytes_complete {self._number(status.get('bytesComplete'))}",
            ]
        )
        atomic_write(
            self.text_path, ("\n".join(lines) + "\n").encode("ascii"), mode=0o640
        )

    @staticmethod
    def _number(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return 0
        return value
