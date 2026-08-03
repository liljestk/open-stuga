#!/usr/bin/env python3
"""Verify an independently signed TUF publication without handling private keys."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse


HOST_UPDATER_ROOT = (
    Path(__file__).resolve().parents[1] / "deploy" / "rpi" / "host-updater"
)
sys.path.insert(0, str(HOST_UPDATER_ROOT))

from stugu_host_updater.contracts import TargetContract  # noqa: E402
from stugu_host_updater.rauc import InspectedBundle, RaucClient  # noqa: E402
from stugu_host_updater.repository import require_root_policy  # noqa: E402


SHA256 = re.compile(r"^[0-9a-f]{64}$")
TARGET = re.compile(r"^[A-Za-z0-9._/-]{1,240}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$")
RECEIPT_SCHEMA = "stugu-host-tuf-publication-receipt/v1"
MAXIMUM_ROOT_VERSION = 32
RAUC_COMPATIBLE = "stugu-rpi4-usb:stugu-gpt-ab-v2:arm64"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def https_base(value: str, label: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"{label} must be an HTTPS base URL without credentials")
    return value.rstrip("/") + "/"


def bounded_regular_bytes(path: Path, label: str, maximum: int) -> bytes:
    if "\n" in str(path) or "\r" in str(path):
        raise ValueError(f"{label} path contains a line break")
    if path.is_symlink():
        raise ValueError(f"{label} is not a readable regular file")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"{label} is not a readable regular file") from error
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode) or not 0 < status.st_size <= maximum:
            raise ValueError(f"{label} is empty, non-regular, or oversized")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            data = handle.read(maximum + 1)
        after = os.fstat(descriptor)
        if (
            len(data) != status.st_size
            or len(data) > maximum
            or (status.st_dev, status.st_ino, status.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
            or status.st_mtime_ns != after.st_mtime_ns
            or status.st_ctime_ns != after.st_ctime_ns
        ):
            raise ValueError(f"{label} changed while it was read")
        return data
    finally:
        os.close(descriptor)


def snapshot_regular_file(
    source: Path, destination: Path, label: str, maximum: int
) -> tuple[int, str]:
    """Copy one stable regular-file input into the verifier's private workspace."""
    if source.is_symlink():
        raise ValueError(f"{label} is not a readable regular file")
    read_flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    source_descriptor = os.open(source, read_flags)
    destination_descriptor: int | None = None
    try:
        before = os.fstat(source_descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
            raise ValueError(f"{label} is empty, non-regular, or oversized")
        destination_descriptor = os.open(
            destination,
            os.O_CREAT
            | os.O_EXCL
            | os.O_WRONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o400,
        )
        digest = hashlib.sha256()
        copied = 0
        while copied <= maximum:
            block = os.read(source_descriptor, min(1024 * 1024, maximum + 1 - copied))
            if not block:
                break
            digest.update(block)
            copied += len(block)
            remaining = memoryview(block)
            while remaining:
                written = os.write(destination_descriptor, remaining)
                if written <= 0:
                    raise OSError("short verifier snapshot write")
                remaining = remaining[written:]
        os.fsync(destination_descriptor)
        after = os.fstat(source_descriptor)
        if (
            copied > maximum
            or copied != before.st_size
            or (before.st_dev, before.st_ino, before.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ValueError(f"{label} changed while it was snapshotted")
        return copied, digest.hexdigest()
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        os.close(source_descriptor)


def inspect_rauc_bundle(bundle: Path, keyring: Path, work: Path) -> InspectedBundle:
    """Verify the RAUC chain and every file in its signed release contract."""
    keyring_copy = work / "rauc-ca.pem"
    keyring_copy.write_bytes(
        bounded_regular_bytes(keyring, "RAUC keyring", 1024 * 1024)
    )
    keyring_copy.chmod(0o600)
    backend = work / "rauc-boot-backend"
    backend.write_text("#!/bin/sh\nprintf 'a\\n'\n", encoding="utf-8")
    backend.chmod(0o700)
    config = work / "rauc-system.conf"
    config.write_text(
        "\n".join(
            (
                "[system]",
                f"compatible={RAUC_COMPATIBLE}",
                "bootloader=custom",
                "activate-installed=false",
                "bundle-formats=-plain",
                "",
                "[keyring]",
                f"path={keyring_copy}",
                "check-purpose=codesign",
                "",
                "[handlers]",
                f"bootloader-custom-backend={backend}",
                "",
            )
        ),
        encoding="utf-8",
    )
    inspected = RaucClient(keyring_copy, config_path=config).inspect(
        bundle,
        "stugu-host-manifest.json",
        extraction_root=work / "rauc-extract",
    )
    if inspected.compatible != RAUC_COMPATIBLE:
        raise ValueError("RAUC compatible string is not the production Pi 4 layout")
    return inspected


def parse_request(data: bytes) -> dict[str, object]:
    value = json.loads(data.decode("utf-8"))
    expected = {"schema", "targetPath", "length", "hashes", "custom"}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("TUF target request shape is invalid")
    if value.get("schema") != "stugu-tuf-target-request/v1":
        raise ValueError("TUF target request schema is unsupported")
    target = value.get("targetPath")
    if (
        not isinstance(target, str)
        or not TARGET.fullmatch(target)
        or target.startswith(("/", "."))
        or ".." in target.split("/")
    ):
        raise ValueError("TUF target path is unsafe")
    length = value.get("length")
    if (
        isinstance(length, bool)
        or not isinstance(length, int)
        or not 0 < length <= 4 * 1024**3
    ):
        raise ValueError("TUF target length is invalid")
    hashes = value.get("hashes")
    if (
        not isinstance(hashes, dict)
        or set(hashes) != {"sha256"}
        or not SHA256.fullmatch(str(hashes["sha256"]))
    ):
        raise ValueError("TUF target digest is invalid")
    custom = value.get("custom")
    if not isinstance(custom, dict) or set(custom) != {"stugu"}:
        raise ValueError("TUF target custom metadata is invalid")
    stugu = custom.get("stugu")
    expected_custom = {
        "schema",
        "channel",
        "manifestSha256",
        "product",
        "layout",
        "hostGeneration",
        "version",
        "bootSha256",
        "rootSha256",
    }
    if not isinstance(stugu, dict) or set(stugu) != expected_custom:
        raise ValueError("TUF target routing metadata shape is invalid")
    channel = stugu.get("channel")
    generation = stugu.get("hostGeneration")
    if (
        stugu.get("schema") != "stugu-host-target/v1"
        or channel not in {"stable", "preview"}
        or value["targetPath"] != f"channels/{channel}/stugu-rpi4-usb.raucb"
        or stugu.get("product") != "stugu-rpi4-usb"
        or stugu.get("layout") != "stugu-gpt-ab-v2"
        or not isinstance(stugu.get("version"), str)
        or not VERSION.fullmatch(stugu["version"])
        or isinstance(generation, bool)
        or not isinstance(generation, int)
        or not 1 <= generation <= 2**53 - 1
        or any(
            not SHA256.fullmatch(str(stugu.get(name)))
            for name in ("manifestSha256", "bootSha256", "rootSha256")
        )
    ):
        raise ValueError("TUF target routing metadata is invalid")
    return value


def load_request(path: Path) -> dict[str, object]:
    return parse_request(bounded_regular_bytes(path, "TUF target request", 128 * 1024))


def metadata_versions(directory: Path) -> dict[str, int]:
    result: dict[str, int] = {}
    for path in directory.glob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            version = value["signed"]["version"]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
            continue
        if isinstance(version, int) and not isinstance(version, bool) and version > 0:
            result[path.stem] = version
    return dict(sorted(result.items()))


def target_role_versions(directory: Path, target_path: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for path in directory.glob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            signed = value["signed"]
            version = signed["version"]
            targets = signed["targets"]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
            continue
        if (
            signed.get("_type") == "targets"
            and isinstance(version, int)
            and not isinstance(version, bool)
            and version > 0
            and isinstance(targets, dict)
            and target_path in targets
        ):
            result[path.stem] = version
    return dict(sorted(result.items()))


def load_receipt(path: Path) -> dict[str, object]:
    value = json.loads(
        bounded_regular_bytes(path, "previous publication receipt", 64 * 1024).decode(
            "utf-8"
        )
    )
    expected = {
        "schema",
        "verifiedAt",
        "immutableRootSha256",
        "requestSha256",
        "targetPath",
        "targetLength",
        "targetSha256",
        "targetChannel",
        "targetVersion",
        "hostGeneration",
        "manifestSha256",
        "raucManifestHash",
        "metadataVersions",
        "targetRoleVersions",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value.get("schema") != RECEIPT_SCHEMA
    ):
        raise ValueError("Previous publication receipt shape is invalid")
    versions = value.get("metadataVersions")
    target_versions = value.get("targetRoleVersions")
    if any(
        not isinstance(items, dict)
        or not items
        or any(
            not isinstance(name, str)
            or not name
            or isinstance(version, bool)
            or not isinstance(version, int)
            or version < 1
            for name, version in items.items()
        )
        for items in (versions, target_versions)
    ):
        raise ValueError("Previous publication metadata versions are invalid")
    if any(
        not SHA256.fullmatch(str(value.get(field)))
        for field in (
            "immutableRootSha256",
            "requestSha256",
            "targetSha256",
            "manifestSha256",
            "raucManifestHash",
        )
    ):
        raise ValueError("Previous publication receipt digest is invalid")
    channel = value.get("targetChannel")
    target_path = value.get("targetPath")
    length = value.get("targetLength")
    generation = value.get("hostGeneration")
    if (
        channel not in {"stable", "preview"}
        or target_path != f"channels/{channel}/stugu-rpi4-usb.raucb"
        or isinstance(length, bool)
        or not isinstance(length, int)
        or not 0 < length <= 4 * 1024**3
        or isinstance(generation, bool)
        or not isinstance(generation, int)
        or not 1 <= generation <= 2**53 - 1
        or not isinstance(value.get("targetVersion"), str)
        or not VERSION.fullmatch(value["targetVersion"])
    ):
        raise ValueError("Previous publication receipt target identity is invalid")
    return value


def require_publication_progress(
    current: dict[str, int],
    target_roles: dict[str, int],
    previous: dict[str, object] | None,
    request: dict[str, object],
    *,
    initial_publication: bool = False,
) -> None:
    if any(
        not isinstance(current.get(role), int) or current[role] < 1
        for role in ("root", "timestamp", "snapshot", "targets")
    ):
        raise ValueError(
            "Published repository lacks required top-level metadata versions"
        )
    if not target_roles:
        raise ValueError("No signed targets role contains the published host target")
    if previous is None:
        if not initial_publication:
            raise ValueError(
                "A previous receipt or explicit initial-publication ceremony is required"
            )
        if any(
            current[role] != 1 for role in ("timestamp", "snapshot", "targets")
        ) or any(version != 1 for version in target_roles.values()):
            raise ValueError(
                "Initial publication requires version 1 repository and target-role metadata"
            )
        return
    if initial_publication:
        raise ValueError("Initial-publication mode cannot use a previous receipt")
    stugu = request["custom"]["stugu"]  # type: ignore[index]
    assert isinstance(stugu, dict)
    if previous["targetPath"] != request["targetPath"]:
        raise ValueError(
            "Previous publication receipt belongs to another update channel"
        )
    generation = stugu["hostGeneration"]
    assert isinstance(generation, int)
    previous_generation = previous["hostGeneration"]
    assert isinstance(previous_generation, int)
    if generation < previous_generation:
        raise ValueError("Published host generation rolled back")
    if generation == previous_generation and (
        stugu["manifestSha256"] != previous["manifestSha256"]
        or stugu["version"] != previous["targetVersion"]
        or request["length"] != previous["targetLength"]
        or request["hashes"]["sha256"] != previous["targetSha256"]  # type: ignore[index]
    ):
        raise ValueError(
            "Published host generation equivocates with the previous receipt"
        )
    old = previous["metadataVersions"]
    assert isinstance(old, dict)
    for role, old_version in old.items():
        if role not in current or current[role] < old_version:
            raise ValueError(f"Published TUF {role} metadata rolled back")
    for role in ("timestamp", "snapshot"):
        old_version = old.get(role)
        if isinstance(old_version, int) and current[role] <= old_version:
            raise ValueError(f"Published TUF {role} metadata did not advance")
    old_target_roles = previous["targetRoleVersions"]
    assert isinstance(old_target_roles, dict)
    shared = set(target_roles) & set(old_target_roles)
    if not shared or not any(
        target_roles[role] > old_target_roles[role] for role in shared
    ):
        raise ValueError("The signed role containing the host target did not advance")


def write_exclusive(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )
    descriptor = os.open(
        path,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_CLOEXEC", 0),
        0o444,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
    if os.name == "posix":
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def extend_root_chain(
    immutable_root: bytes,
    metadata_url: str,
    metadata_type: object,
    root_type: object,
) -> tuple[bytes, int]:
    """Revalidate every published root transition from immutable v1."""
    trusted = metadata_type[root_type].from_bytes(immutable_root)  # type: ignore[index]
    trusted_bytes = immutable_root
    version = 1
    for expected in range(2, MAXIMUM_ROOT_VERSION + 2):
        request = urllib.request.Request(
            urljoin(metadata_url, f"{expected}.root.json"),
            headers={"User-Agent": "stugu-host-publication-verifier/1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > 512 * 1024:
                    raise ValueError(f"TUF root {expected} exceeds the size limit")
                candidate_bytes = response.read(512 * 1024 + 1)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                break
            raise ValueError(f"Cannot fetch TUF root {expected}") from error
        except (OSError, ValueError) as error:
            raise ValueError(f"Cannot fetch TUF root {expected}") from error
        if len(candidate_bytes) > 512 * 1024:
            raise ValueError(f"TUF root {expected} exceeds the size limit")
        try:
            candidate_json = json.loads(candidate_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"TUF root {expected} is malformed") from error
        require_root_policy(candidate_json, expected)
        try:
            candidate = metadata_type[root_type].from_bytes(candidate_bytes)  # type: ignore[index]
            if candidate.signed.version != expected:
                raise ValueError("root version is not sequential")
            trusted.signed.verify_delegate(
                "root", candidate.signed_bytes, candidate.signatures
            )
            candidate.signed.verify_delegate(
                "root", candidate.signed_bytes, candidate.signatures
            )
        except Exception as error:
            raise ValueError(
                f"TUF root {expected} failed old/new threshold verification"
            ) from error
        if expected > MAXIMUM_ROOT_VERSION:
            raise ValueError("TUF root chain exceeds the verifier bound")
        trusted = candidate
        trusted_bytes = candidate_bytes
        version = expected
    return trusted_bytes, version


def verify(args: argparse.Namespace) -> dict[str, object]:
    try:
        from tuf.api.metadata import Metadata, Root
        from tuf.ngclient import Updater
        from tuf.ngclient.config import UpdaterConfig
    except ImportError as error:
        raise RuntimeError("python3-tuf is required") from error

    request_bytes = bounded_regular_bytes(
        args.request, "TUF target request", 128 * 1024
    )
    request = parse_request(request_bytes)
    immutable_root = bounded_regular_bytes(args.root, "TUF root v1", 512 * 1024)
    root_json = json.loads(immutable_root.decode("utf-8"))
    require_root_policy(root_json, 1)
    try:
        trusted_root = Metadata[Root].from_bytes(immutable_root)
        trusted_root.signed.verify_delegate(
            "root", trusted_root.signed_bytes, trusted_root.signatures
        )
    except Exception as error:
        raise ValueError("Immutable TUF root v1 self-signatures are invalid") from error
    previous = load_receipt(args.previous_receipt) if args.previous_receipt else None
    root_sha256 = hashlib.sha256(immutable_root).hexdigest()
    if previous is not None and previous["immutableRootSha256"] != root_sha256:
        raise ValueError("Previous publication receipt uses another immutable TUF root")
    metadata_url = https_base(args.metadata_url, "metadata URL")

    with tempfile.TemporaryDirectory(prefix="stugu-tuf-verify-") as temporary:
        base = Path(temporary)
        bundle = base / "approved.raucb"
        bundle_size, bundle_hash = snapshot_regular_file(
            args.bundle, bundle, "local RAUC bundle", 4 * 1024**3
        )
        if (
            bundle_size != request["length"]
            or bundle_hash != request["hashes"]["sha256"]
        ):
            raise ValueError("Local RAUC bundle does not match its TUF request")
        inspected = inspect_rauc_bundle(bundle, args.rauc_keyring, base)
        stugu = request["custom"]["stugu"]  # type: ignore[index]
        assert isinstance(stugu, dict)
        target_contract = TargetContract.parse(request["custom"])
        target_contract.require_matches(inspected.manifest, str(stugu["channel"]))

        latest_root, _ = extend_root_chain(immutable_root, metadata_url, Metadata, Root)
        metadata = base / "metadata"
        targets = base / "targets"
        metadata.mkdir(mode=0o700)
        targets.mkdir(mode=0o700)
        (metadata / "root.json").write_bytes(latest_root)
        updater = Updater(
            metadata_dir=str(metadata),
            metadata_base_url=metadata_url,
            target_dir=str(targets),
            target_base_url=https_base(args.targets_url, "targets URL"),
            config=UpdaterConfig(
                max_root_rotations=0,
                max_delegations=16,
                root_max_length=512 * 1024,
                timestamp_max_length=64 * 1024,
                snapshot_max_length=2 * 1024 * 1024,
                targets_max_length=4 * 1024 * 1024,
                prefix_targets_with_hash=True,
                app_user_agent="stugu-host-publication-verifier/1",
            ),
        )
        updater.refresh()
        info = updater.get_targetinfo(str(request["targetPath"]))
        if info is None:
            raise ValueError(
                "Published TUF metadata does not contain the requested target"
            )
        published_hashes = {
            str(name): str(digest) for name, digest in info.hashes.items()
        }
        if (
            info.length != request["length"]
            or published_hashes != request["hashes"]
            or info.custom != request["custom"]
        ):
            raise ValueError(
                "Published TUF target metadata differs from the approved request"
            )
        downloaded = Path(updater.download_target(info))
        if (
            downloaded.stat().st_size != bundle_size
            or file_sha256(downloaded) != bundle_hash
        ):
            raise ValueError(
                "Published TUF target bytes differ from the signed RAUC bundle"
            )
        versions = metadata_versions(metadata)
        role_versions = target_role_versions(metadata, str(request["targetPath"]))
        require_publication_progress(
            versions,
            role_versions,
            previous,
            request,
            initial_publication=args.initial_publication,
        )

    receipt = {
        "schema": RECEIPT_SCHEMA,
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "immutableRootSha256": root_sha256,
        "requestSha256": hashlib.sha256(request_bytes).hexdigest(),
        "targetPath": request["targetPath"],
        "targetLength": bundle_size,
        "targetSha256": bundle_hash,
        "targetChannel": stugu["channel"],
        "targetVersion": stugu["version"],
        "hostGeneration": stugu["hostGeneration"],
        "manifestSha256": stugu["manifestSha256"],
        "raucManifestHash": inspected.rauc_manifest_hash,
        "metadataVersions": versions,
        "targetRoleVersions": role_versions,
    }
    write_exclusive(args.receipt, receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--metadata-url", required=True)
    parser.add_argument("--targets-url", required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--rauc-keyring", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    history = parser.add_mutually_exclusive_group(required=True)
    history.add_argument("--previous-receipt", type=Path)
    history.add_argument("--initial-publication", action="store_true")
    args = parser.parse_args()
    for path in (args.root, args.request, args.bundle, args.rauc_keyring):
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            parser.error(f"missing or empty input: {path}")
    if args.previous_receipt and (
        args.previous_receipt.is_symlink()
        or not args.previous_receipt.is_file()
        or args.previous_receipt.stat().st_size == 0
    ):
        parser.error(f"missing or empty previous receipt: {args.previous_receipt}")
    receipt = verify(args)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
