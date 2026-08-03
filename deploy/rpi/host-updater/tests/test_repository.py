from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
import urllib.error
from unittest.mock import patch

from stugu_host_updater.errors import TrustError
from stugu_host_updater.contracts import ReleaseManifest, TargetContract
from stugu_host_updater.repository import (
    RootChain,
    TufRepository,
    VerifiedTarget,
    require_root_policy,
)

from .support import release_manifest, target_custom


class _Signed:
    def __init__(self, version: int) -> None:
        self.version = version

    def verify_delegate(self, *_: object) -> None:
        return None


class _Metadata:
    def __init__(self, version: int) -> None:
        self.signed = _Signed(version)
        self.signed_bytes = str(version).encode()
        self.signatures: list[object] = []


class _RootChain(RootChain):
    def _parse(self, data: bytes, expected_version: int) -> _Metadata:
        if int(data.decode()) != expected_version:
            raise TrustError("not sequential")
        return _Metadata(expected_version)


class RootChainTests(unittest.TestCase):
    def test_every_root_must_retain_production_thresholds_and_separate_keys(
        self,
    ) -> None:
        role_keyids = {
            "root": ["root-1", "root-2", "root-3"],
            "targets": ["targets-1", "targets-2", "targets-3"],
            "snapshot": ["snapshot-1"],
            "timestamp": ["timestamp-1"],
        }
        root = {
            "signed": {
                "_type": "root",
                "version": 2,
                "consistent_snapshot": True,
                "roles": {
                    role: {
                        "keyids": keyids,
                        "threshold": 2 if role in {"root", "targets"} else 1,
                    }
                    for role, keyids in role_keyids.items()
                },
                "keys": {
                    keyid: {"keytype": "unused-by-policy-test"}
                    for keyids in role_keyids.values()
                    for keyid in keyids
                },
            },
            "signatures": [{"keyid": "root-1"}, {"keyid": "root-2"}],
        }
        require_root_policy(root, 2)

        weakened = root.copy()
        weakened["signed"] = root["signed"].copy()
        weakened["signed"]["roles"] = root["signed"]["roles"].copy()
        weakened["signed"]["roles"]["targets"] = {
            "keyids": ["targets-1"],
            "threshold": 1,
        }
        with self.assertRaisesRegex(TrustError, "unsafe key policy"):
            require_root_policy(weakened, 2)

        shared = root.copy()
        shared["signed"] = root["signed"].copy()
        shared["signed"]["roles"] = root["signed"]["roles"].copy()
        shared["signed"]["roles"]["timestamp"] = {
            "keyids": ["snapshot-1"],
            "threshold": 1,
        }
        with self.assertRaisesRegex(TrustError, "share keys"):
            require_root_policy(shared, 2)

    def test_latest_root_bytes_are_returned_after_revalidating_from_v1(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "2.root.json").write_bytes(b"2")
            (path / "3.root.json").write_bytes(b"3")
            _, version, latest = _RootChain(b"1", path).validate_cached()
            self.assertEqual(version, 3)
            self.assertEqual(latest, b"3")

    def test_any_cached_root_gap_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "2.root.json").write_bytes(b"2")
            (path / "4.root.json").write_bytes(b"4")
            with self.assertRaisesRegex(TrustError, "gap"):
                _RootChain(b"1", path).validate_cached()

    def test_root_at_the_retained_bound_remains_usable_when_no_new_root_exists(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "2.root.json").write_bytes(b"2")
            (path / "3.root.json").write_bytes(b"3")
            not_found = urllib.error.HTTPError(
                "https://updates.example.test/4.root.json", 404, "missing", {}, None
            )
            with patch("urllib.request.urlopen", side_effect=not_found):
                latest, version = _RootChain(b"1", path, maximum_roots=3).extend(
                    "https://updates.example.test/metadata/"
                )
            self.assertEqual((latest, version), (b"3", 3))

    def test_python_tuf_is_bootstrapped_from_latest_validated_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = TufRepository(
                metadata_base_url="https://updates.example.test/metadata/",
                target_base_url="https://updates.example.test/targets/",
                metadata_dir=base / "metadata",
                target_dir=base / "targets",
                immutable_root=b"root-v1",
                maximum_target_bytes=1024,
            )

            class Chain:
                def extend(self, _: str) -> tuple[bytes, int]:
                    return b"root-v3", 3

            observed: dict[str, object] = {}

            class Config:
                def __init__(self, **options: object) -> None:
                    observed["config_options"] = options

            class Updater:
                def __init__(self, **kwargs: object) -> None:
                    observed.update(kwargs)

                def refresh(self) -> None:
                    observed["refreshed"] = True

            repository.root_chain = Chain()  # type: ignore[assignment]
            repository._load_client = lambda: (Updater, Config)  # type: ignore[method-assign]
            repository.refresh()
            self.assertNotIn("bootstrap", observed)
            self.assertEqual((base / "metadata" / "root.json").read_bytes(), b"root-v3")
            self.assertEqual(
                observed["config_options"]["max_root_rotations"],
                0,  # type: ignore[index]
            )
            self.assertIs(observed["refreshed"], True)

    def test_download_rejects_target_metadata_changed_after_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = TufRepository(
                metadata_base_url="https://updates.example.test/metadata/",
                target_base_url="https://updates.example.test/targets/",
                metadata_dir=base / "metadata",
                target_dir=base / "targets",
                immutable_root=b"root-v1",
                maximum_target_bytes=1024,
            )
            manifest = ReleaseManifest.parse(release_manifest())
            contract = TargetContract.parse(target_custom(manifest))
            verified = VerifiedTarget(
                "channels/stable/bundle.raucb",
                100,
                {"sha256": "a" * 64},
                contract,
                {},
                1,
            )
            repository.target_dir.mkdir()
            repository._updater = type(
                "Updater",
                (),
                {
                    "get_targetinfo": lambda _self, _path: SimpleNamespace(
                        length=101,
                        hashes={"sha256": "a" * 64},
                        custom=target_custom(manifest),
                    ),
                },
            )()
            with self.assertRaisesRegex(TrustError, "changed after authorization"):
                repository.download(verified)


if __name__ == "__main__":
    unittest.main()
