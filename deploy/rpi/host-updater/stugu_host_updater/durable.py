"""Power-loss-conscious persistent JSON, audit, and anti-rollback state."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
from typing import Iterator, Mapping

from .contracts import MAX_JSON_INTEGER, canonical_json, decode_json
from .errors import ContractError, TrustError, UpdaterError

try:
    import fcntl
except ImportError:  # pragma: no cover - production is Linux
    fcntl = None  # type: ignore[assignment]


def fsync_directory(path: Path) -> None:
    if os.name != "posix":  # Tests run on Windows; production is Linux.
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        fsync_directory(path.parent)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def atomic_json(path: Path, value: object, *, mode: int = 0o600) -> None:
    atomic_write(path, canonical_json(value) + b"\n", mode=mode)


def read_bounded_regular(
    path: Path, *, maximum: int, missing_ok: bool = False
) -> bytes | None:
    """Read a pinned regular file without following symlinks or overallocating."""
    if path.is_symlink():
        raise ContractError(f"{path.name} is not a readable regular file")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise
    except OSError as error:
        raise ContractError(f"{path.name} is not a readable regular file") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ContractError(f"{path.name} is non-regular or oversized")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining:
            block = os.read(descriptor, min(1024 * 1024, remaining))
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino, before.st_size)
        final_identity = (after.st_dev, after.st_ino, after.st_size)
        if (
            len(data) > maximum
            or len(data) != before.st_size
            or identity != final_identity
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ContractError(f"{path.name} changed while it was read")
        return data
    finally:
        os.close(descriptor)


def read_json(path: Path, *, maximum: int = 256 * 1024) -> object:
    data = read_bounded_regular(path, maximum=maximum, missing_ok=True)
    if data is None:
        return None
    assert isinstance(data, bytes)
    return decode_json(data, maximum=maximum, label=path.name)


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    if fcntl is None:
        raise UpdaterError("PLATFORM_UNSUPPORTED", "Updater locks require Linux")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise UpdaterError(
                "UPDATE_BUSY", "Another appliance mutation is active"
            ) from error
        yield
    finally:
        os.close(descriptor)


LEASE_SCHEMA = "stugu-mutation-lock/v1"
LEASE_STALE_SECONDS = 2 * 60 * 60
BOOT_ID_PATTERN = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"


def _boot_id() -> str:
    try:
        value = (
            Path("/proc/sys/kernel/random/boot_id")
            .read_text(encoding="ascii")
            .strip()
            .lower()
        )
    except (OSError, UnicodeDecodeError):
        return "unknown"
    return value if re.fullmatch(BOOT_ID_PATTERN, value) else "unknown"


def _reclaim_stale_lease(path: Path, current_boot_id: str) -> bool:
    if path.is_symlink():
        return False
    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return False
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 256:
            return False
        data = os.read(descriptor, 257)
        after = os.fstat(descriptor)
    except OSError:
        return False
    finally:
        os.close(descriptor)
    if (
        (before.st_dev, before.st_ino, before.st_size)
        != (after.st_dev, after.st_ino, after.st_size)
        or len(data) != before.st_size
        or len(data) > 256
    ):
        return False
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return False
    match = re.fullmatch(
        rf"{re.escape(LEASE_SCHEMA)} (?:host-updater|container-updater) "
        rf"({BOOT_ID_PATTERN}|unknown) [0-9]+\r?\n",
        text,
    )
    recorded_boot_id = match.group(1) if match else "unknown"
    foreign_boot = (
        current_boot_id != "unknown"
        and recorded_boot_id != "unknown"
        and recorded_boot_id != current_boot_id
    )
    stale_heartbeat = time.time() - after.st_mtime > LEASE_STALE_SECONDS
    if not foreign_boot and not stale_heartbeat:
        return False
    try:
        current = path.stat(follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
            return False
        path.unlink()
        fsync_directory(path.parent)
        return True
    except OSError:
        return False


def _refresh_lease_heartbeat(descriptor: int, path: Path) -> bool:
    """Refresh the owned lease without following a replacement symlink."""
    try:
        if os.utime in os.supports_fd:
            os.utime(descriptor)
            return True
        if os.utime in os.supports_follow_symlinks:
            os.utime(path, follow_symlinks=False)
            return True
    except (NotImplementedError, OSError):
        return False
    # Windows cannot unlink the still-open lease, so its descriptor remains the
    # interlock even though that platform cannot refresh timestamps securely.
    return os.name == "nt"


@contextmanager
def exclusive_file_lease(
    path: Path, *, heartbeat_seconds: float = 30.0
) -> Iterator[None]:
    """Coordinate with the container update agent's O_EXCL mutation lock.

    The heartbeat keeps its two-hour stale-lock recovery from stealing a live
    host update during a slow bundle download. The inode check prevents this
    owner from unlinking a replacement lock.
    """
    if heartbeat_seconds <= 0:
        raise ValueError("heartbeat_seconds must be positive")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_CLOEXEC", 0)
    current_boot_id = _boot_id()
    descriptor: int | None = None
    for attempt in range(2):
        try:
            descriptor = os.open(path, flags, 0o640)
            break
        except FileExistsError as error:
            if attempt == 0 and _reclaim_stale_lease(path, current_boot_id):
                continue
            raise UpdaterError(
                "MUTATION_INTERLOCK", "Another appliance mutation is active"
            ) from error
    if descriptor is None:  # pragma: no cover - loop either opens or raises
        raise UpdaterError("MUTATION_INTERLOCK", "Another appliance mutation is active")
    identity = os.fstat(descriptor)
    stop = threading.Event()

    def owns_path() -> bool:
        try:
            current = path.stat(follow_symlinks=False)
        except FileNotFoundError:
            return False
        return (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino)

    def heartbeat() -> None:
        while not stop.wait(heartbeat_seconds):
            try:
                if not owns_path():
                    return
                if not _refresh_lease_heartbeat(descriptor, path):
                    return
            except (NotImplementedError, OSError):
                return

    thread: threading.Thread | None = None
    try:
        payload = (
            f"{LEASE_SCHEMA} host-updater {current_boot_id} {os.getpid()}\n".encode(
                "ascii"
            )
        )
        if os.write(descriptor, payload) != len(payload):
            raise OSError("short mutation-lock write")
        os.fsync(descriptor)
        fsync_directory(path.parent)
        thread = threading.Thread(
            target=heartbeat, name="stugu-update-lock-heartbeat", daemon=True
        )
        thread.start()
        yield
    finally:
        stop.set()
        if thread is not None:
            thread.join(timeout=max(1.0, heartbeat_seconds + 1.0))
        # Windows cannot unlink an open file; after close the O_EXCL path still
        # prevents a replacement until this exact inode is removed.
        os.close(descriptor)
        if owns_path():
            path.unlink()
            fsync_directory(path.parent)


class AuditLog:
    def __init__(self, path: Path, maximum_bytes: int = 4 * 1024 * 1024) -> None:
        self.path = path
        self.maximum_bytes = maximum_bytes

    def append(self, event: Mapping[str, object]) -> None:
        payload = canonical_json(event) + b"\n"
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if (
            self.path.exists()
            and self.path.stat().st_size + len(payload) > self.maximum_bytes
        ):
            archive = self.path.with_suffix(self.path.suffix + ".1")
            archive.unlink(missing_ok=True)
            os.replace(self.path, archive)
            fsync_directory(self.path.parent)
        descriptor = os.open(
            self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_CLOEXEC, 0o600
        )
        try:
            remaining = memoryview(payload)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise OSError("short audit-log write")
                remaining = remaining[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        fsync_directory(self.path.parent)


@dataclass(frozen=True)
class TrustState:
    sequence: int
    immutable_root_sha256: str
    highest_host_generation: int
    highest_manifest_sha256: str | None
    fallback_host_generation: int | None
    maximum_trusted_time: int
    metadata_versions: Mapping[str, int]
    root_chain_length: int

    @classmethod
    def initial(cls, immutable_root: bytes) -> "TrustState":
        return cls(
            0, hashlib.sha256(immutable_root).hexdigest(), 0, None, None, 0, {}, 1
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "schema": "stugu-host-trust-state/v1",
            "sequence": self.sequence,
            "immutableRootSha256": self.immutable_root_sha256,
            "highestHostGeneration": self.highest_host_generation,
            "highestManifestSha256": self.highest_manifest_sha256,
            "fallbackHostGeneration": self.fallback_host_generation,
            "maximumTrustedTime": self.maximum_trusted_time,
            "metadataVersions": dict(self.metadata_versions),
            "rootChainLength": self.root_chain_length,
        }

    def next(self, **changes: object) -> "TrustState":
        values: dict[str, object] = {
            "sequence": self.sequence + 1,
            "immutable_root_sha256": self.immutable_root_sha256,
            "highest_host_generation": self.highest_host_generation,
            "highest_manifest_sha256": self.highest_manifest_sha256,
            "fallback_host_generation": self.fallback_host_generation,
            "maximum_trusted_time": self.maximum_trusted_time,
            "metadata_versions": self.metadata_versions,
            "root_chain_length": self.root_chain_length,
        }
        values.update(changes)
        return TrustState(**values)  # type: ignore[arg-type]


class RedundantTrustStore:
    """Two independently checksummed copies; the highest valid sequence wins."""

    def __init__(self, directory: Path, immutable_root: bytes) -> None:
        self.directory = directory
        self.immutable_root = immutable_root
        self.expected_root_sha = hashlib.sha256(immutable_root).hexdigest()

    def _paths(self) -> tuple[Path, Path]:
        return (
            self.directory / "trust-state.0.json",
            self.directory / "trust-state.1.json",
        )

    def _decode(self, path: Path) -> TrustState | None:
        try:
            value = read_json(path, maximum=64 * 1024)
        except (ContractError, OSError):
            return None
        if value is None:
            return None
        if not isinstance(value, dict) or set(value) != {"payload", "sha256"}:
            return None
        payload = value.get("payload")
        if (
            not isinstance(payload, dict)
            or value.get("sha256")
            != hashlib.sha256(canonical_json(payload)).hexdigest()
        ):
            return None
        expected = {
            "schema",
            "sequence",
            "immutableRootSha256",
            "highestHostGeneration",
            "highestManifestSha256",
            "fallbackHostGeneration",
            "maximumTrustedTime",
            "metadataVersions",
            "rootChainLength",
        }
        if (
            set(payload) != expected
            or payload.get("schema") != "stugu-host-trust-state/v1"
        ):
            return None
        bounded_fields = (
            (payload.get("sequence"), 2**63 - 1),
            (payload.get("highestHostGeneration"), MAX_JSON_INTEGER),
            (payload.get("maximumTrustedTime"), 2**63 - 1),
            (payload.get("rootChainLength"), 32),
        )
        if (
            any(
                isinstance(item, bool)
                or not isinstance(item, int)
                or not 0 <= item <= maximum
                for item, maximum in bounded_fields
            )
            or payload.get("rootChainLength", 0) < 1
        ):
            return None
        fallback = payload.get("fallbackHostGeneration")
        if fallback is not None and (
            isinstance(fallback, bool)
            or not isinstance(fallback, int)
            or not 0 <= fallback <= payload["highestHostGeneration"]
        ):
            return None
        manifest_sha = payload.get("highestManifestSha256")
        if manifest_sha is not None and (
            not isinstance(manifest_sha, str)
            or len(manifest_sha) != 64
            or any(character not in "0123456789abcdef" for character in manifest_sha)
        ):
            return None
        versions = payload.get("metadataVersions")
        if (
            not isinstance(versions, dict)
            or len(versions) > 32
            or any(
                not isinstance(key, str)
                or not key
                or len(key) > 80
                or any(
                    character
                    not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
                    for character in key
                )
                or isinstance(number, bool)
                or not isinstance(number, int)
                or number < 0
                or number > 2**31 - 1
                for key, number in versions.items()
            )
        ):
            return None
        return TrustState(
            sequence=payload["sequence"],
            immutable_root_sha256=str(payload.get("immutableRootSha256")),
            highest_host_generation=payload["highestHostGeneration"],
            highest_manifest_sha256=manifest_sha,
            fallback_host_generation=fallback,
            maximum_trusted_time=payload["maximumTrustedTime"],
            metadata_versions=versions,
            root_chain_length=payload["rootChainLength"],
        )

    def load(self) -> TrustState:
        states = [
            state for path in self._paths() if (state := self._decode(path)) is not None
        ]
        if not states:
            if any(path.exists() for path in self._paths()):
                raise TrustError("Both persistent trust-state copies are invalid")
            return TrustState.initial(self.immutable_root)
        highest_sequence = max(state.sequence for state in states)
        newest = [state for state in states if state.sequence == highest_sequence]
        if len(newest) > 1 and any(state != newest[0] for state in newest[1:]):
            raise TrustError(
                "Persistent trust-state copies conflict at the same sequence"
            )
        state = newest[0]
        if state.immutable_root_sha256 != self.expected_root_sha:
            raise TrustError(
                "Persistent trust state is anchored to a different immutable root"
            )
        return state

    def write(self, state: TrustState) -> None:
        current = self.load()
        if state.sequence != current.sequence + 1:
            raise TrustError("Trust-state sequence did not advance exactly once")
        if state.immutable_root_sha256 != current.immutable_root_sha256:
            raise TrustError("Trust state cannot change its immutable root anchor")
        if state.highest_host_generation < current.highest_host_generation:
            raise TrustError(
                "Trust state cannot lower the host-generation high-water mark"
            )
        if state.maximum_trusted_time < current.maximum_trusted_time:
            raise TrustError(
                "Trust state cannot lower the trusted-time high-water mark"
            )
        if state.root_chain_length < current.root_chain_length:
            raise TrustError("Trust state cannot shorten the accepted TUF root chain")
        if (
            state.fallback_host_generation is not None
            and state.fallback_host_generation > state.highest_host_generation
        ):
            raise TrustError(
                "Fallback generation cannot exceed the accepted host generation"
            )
        for role, version in current.metadata_versions.items():
            if state.metadata_versions.get(role, -1) < version:
                raise TrustError(f"Trust state cannot lower TUF {role} metadata")
        if (
            state.highest_host_generation == current.highest_host_generation
            and current.highest_manifest_sha256 is not None
            and state.highest_manifest_sha256 != current.highest_manifest_sha256
        ):
            raise TrustError("Trust state cannot equivocate within one host generation")
        target = self._paths()[state.sequence % 2]
        payload = state.to_payload()
        atomic_json(
            target,
            {
                "payload": payload,
                "sha256": hashlib.sha256(canonical_json(payload)).hexdigest(),
            },
        )
        if self._decode(target) != state:
            raise TrustError("Trust-state read-back verification failed")
