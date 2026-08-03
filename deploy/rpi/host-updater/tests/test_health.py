from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from stugu_host_updater.errors import UpdaterError
from stugu_host_updater.health import (
    qualification_watchdog_seconds,
    runtime_watchdog_status,
)


class HealthPolicyTests(unittest.TestCase):
    def test_exact_device_preview_may_explicitly_disable_the_watchdog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qualification.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "stugu-pi4-qualification/v1",
                        "activationEnabled": True,
                        "watchdogSeconds": 0,
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(qualification_watchdog_seconds(path), 0)
        self.assertEqual(runtime_watchdog_status(0, "0"), "disabled-by-policy")

    def test_watchdog_policy_must_match_the_running_system(self) -> None:
        self.assertEqual(runtime_watchdog_status(5, "5s"), "passed")
        with self.assertRaisesRegex(UpdaterError, "not active"):
            runtime_watchdog_status(5, "0us")
        with self.assertRaisesRegex(UpdaterError, "despite"):
            runtime_watchdog_status(0, "5s")

    def test_disabled_or_malformed_qualification_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qualification.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "stugu-pi4-qualification/v1",
                        "activationEnabled": False,
                        "watchdogSeconds": 0,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(UpdaterError, "watchdog policy"):
                qualification_watchdog_seconds(path)


if __name__ == "__main__":
    unittest.main()
