from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from stugu_host_updater.metrics import MetricsExporter


class MetricsTests(unittest.TestCase):
    def test_counters_survive_restart_and_text_contains_no_detail(self) -> None:
        with TemporaryDirectory() as directory:
            exporter = MetricsExporter(Path(directory))
            exporter.update("checking", {"detail": "secret", "targetGeneration": 42})
            MetricsExporter(Path(directory)).update(
                "complete", {"targetGeneration": 42}
            )
            text = (Path(directory) / "metrics.prom").read_text(encoding="ascii")
            self.assertIn('event="checks"} 1', text)
            self.assertIn('event="commits"} 1', text)
            self.assertIn("stugu_host_update_target_generation 42", text)
            self.assertNotIn("secret", text)


if __name__ == "__main__":
    unittest.main()
