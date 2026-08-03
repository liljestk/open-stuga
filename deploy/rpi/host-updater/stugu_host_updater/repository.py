"""TUF 1.0 client with immutable bootstrap and retained root history."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import shutil
import urllib.error
import urllib.request
from urllib.parse import urljoin

from .contracts import TargetContract
from .durable import atomic_write, read_bounded_regular
from .errors import ContractError, PreflightError, TrustError, UpdaterError


ROOT_ROLES = {"root", "targets", "snapshot", "timestamp"}


def require_root_policy(value: object, expected_version: int) -> None:
    """Require the fixed production key-separation policy for every TUF root."""
    if not isinstance(value, dict) or set(value) != {"signed", "signatures"}:
        raise TrustError("TUF root envelope is invalid")
    signed = value.get("signed")
    if (
        not isinstance(signed, dict)
        or signed.get("_type") != "root"
        or signed.get("version") != expected_version
        or signed.get("consistent_snapshot") is not True
    ):
        raise TrustError(f"TUF root {expected_version} policy header is invalid")
    roles = signed.get("roles")
    keys = signed.get("keys")
    if (
        not isinstance(roles, dict)
        or set(roles) != ROOT_ROLES
        or not isinstance(keys, dict)
    ):
        raise TrustError(f"TUF root {expected_version} roles or keys are invalid")

    role_keys: dict[str, set[str]] = {}
    for role_name, minimum_threshold, minimum_keys in (
        ("root", 2, 3),
        ("targets", 2, 3),
        ("snapshot", 1, 1),
        ("timestamp", 1, 1),
    ):
        role = roles.get(role_name)
        if not isinstance(role, dict) or set(role) != {"keyids", "threshold"}:
            raise TrustError(f"TUF root {expected_version} role {role_name} is invalid")
        keyids = role.get("keyids")
        threshold = role.get("threshold")
        if (
            not isinstance(keyids, list)
            or len(keyids) < minimum_keys
            or any(not isinstance(keyid, str) or not keyid for keyid in keyids)
            or not isinstance(threshold, int)
            or isinstance(threshold, bool)
            or threshold < minimum_threshold
            or threshold > len(keyids)
            or len(set(keyids)) != len(keyids)
            or any(keyid not in keys for keyid in keyids)
        ):
            raise TrustError(
                f"TUF root {expected_version} role {role_name} has an unsafe key policy"
            )
        role_keys[role_name] = set(keyids)

    for left_index, left in enumerate(role_keys):
        for right in list(role_keys)[left_index + 1 :]:
            if role_keys[left] & role_keys[right]:
                raise TrustError(
                    f"TUF root {expected_version} roles {left} and {right} share keys"
                )

    signatures = value.get("signatures")
    signed_root_keys = (
        {
            signature.get("keyid")
            for signature in signatures
            if isinstance(signature, dict)
        }
        if isinstance(signatures, list)
        else set()
    )
    root_role = roles["root"]
    root_threshold = root_role["threshold"]
    assert isinstance(root_threshold, int)
    if len(role_keys["root"] & signed_root_keys) < root_threshold:
        raise TrustError(
            f"TUF root {expected_version} lacks its declared root signature threshold"
        )


@dataclass(frozen=True)
class VerifiedTarget:
    path: str
    length: int
    hashes: dict[str, str]
    custom: TargetContract
    metadata_versions: dict[str, int]
    root_chain_length: int


class RootChain:
    def __init__(
        self, immutable_root: bytes, directory: Path, maximum_roots: int = 32
    ) -> None:
        self.immutable_root = immutable_root
        self.directory = directory
        self.maximum_roots = maximum_roots

    @staticmethod
    def _metadata_module():
        try:
            from tuf.api.metadata import Metadata, Root
        except ImportError as error:
            raise TrustError("python-tuf is not installed") from error
        return Metadata, Root

    def _parse(self, data: bytes, expected_version: int):
        Metadata, Root = self._metadata_module()
        try:
            value = json.loads(data.decode("utf-8"))
            require_root_policy(value, expected_version)
            metadata = Metadata[Root].from_bytes(data)
        except Exception as error:
            if isinstance(error, TrustError):
                raise
            raise TrustError(f"TUF root {expected_version} is malformed") from error
        if metadata.signed.version != expected_version:
            raise TrustError(
                f"TUF root chain is not sequential at version {expected_version}"
            )
        return metadata

    def validate_cached(self) -> tuple[object, int, bytes]:
        trusted = self._parse(self.immutable_root, 1)
        version = 1
        trusted_bytes = self.immutable_root
        cached_versions: list[int] = []
        for path in self.directory.glob("*.root.json"):
            match = re.fullmatch(r"([1-9][0-9]*)\.root\.json", path.name)
            if match is None:
                raise TrustError("TUF root-chain directory contains an unexpected file")
            cached_version = int(match.group(1))
            if cached_version < 2 or cached_version > self.maximum_roots:
                raise TrustError(
                    "TUF root-chain version is outside the configured bound"
                )
            cached_versions.append(cached_version)
        cached_versions.sort()
        if cached_versions and cached_versions != list(
            range(2, cached_versions[-1] + 1)
        ):
            raise TrustError("TUF root chain contains a version gap")
        for expected in range(2, self.maximum_roots + 1):
            path = self.directory / f"{expected}.root.json"
            if not path.exists():
                break
            try:
                data = read_bounded_regular(path, maximum=512 * 1024)
            except (OSError, ContractError) as error:
                raise TrustError(
                    f"TUF root {expected} is not a bounded regular file"
                ) from error
            assert isinstance(data, bytes)
            candidate = self._parse(data, expected)
            try:
                trusted.signed.verify_delegate(
                    "root", candidate.signed_bytes, candidate.signatures
                )
                candidate.signed.verify_delegate(
                    "root", candidate.signed_bytes, candidate.signatures
                )
            except Exception as error:
                raise TrustError(
                    f"TUF root {expected} failed old/new threshold verification"
                ) from error
            trusted = candidate
            version = expected
            trusted_bytes = data
        return trusted, version, trusted_bytes

    def extend(self, metadata_base_url: str) -> tuple[bytes, int]:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        trusted, version, trusted_bytes = self.validate_cached()
        # Probe one version beyond the retained bound. Root N remains usable at
        # the bound, but a valid N+1 requires a recovery-class client update.
        for expected in range(version + 1, self.maximum_roots + 2):
            url = urljoin(metadata_base_url, f"{expected}.root.json")
            request = urllib.request.Request(
                url, headers={"User-Agent": "stugu-host-updater/1"}
            )
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    declared = response.headers.get("Content-Length")
                    if declared and int(declared) > 512 * 1024:
                        raise TrustError(
                            f"TUF root {expected} exceeds the configured size limit"
                        )
                    data = response.read(512 * 1024 + 1)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    break
                raise UpdaterError(
                    "METADATA_FETCH_FAILED", "Could not fetch TUF root metadata"
                ) from error
            except (OSError, ValueError) as error:
                raise UpdaterError(
                    "METADATA_FETCH_FAILED", "Could not fetch TUF root metadata"
                ) from error
            if len(data) > 512 * 1024:
                raise TrustError(
                    f"TUF root {expected} exceeds the configured size limit"
                )
            candidate = self._parse(data, expected)
            try:
                trusted.signed.verify_delegate(
                    "root", candidate.signed_bytes, candidate.signatures
                )
                candidate.signed.verify_delegate(
                    "root", candidate.signed_bytes, candidate.signatures
                )
            except Exception as error:
                raise TrustError(
                    f"TUF root {expected} failed old/new threshold verification"
                ) from error
            if expected > self.maximum_roots:
                raise TrustError("TUF root chain exceeds the configured maximum")
            atomic_write(self.directory / f"{expected}.root.json", data, mode=0o600)
            trusted = candidate
            version = expected
            trusted_bytes = data
        self.validate_cached()
        return trusted_bytes, version


class TufRepository:
    def __init__(
        self,
        *,
        metadata_base_url: str,
        target_base_url: str,
        metadata_dir: Path,
        target_dir: Path,
        immutable_root: bytes,
        maximum_target_bytes: int,
    ) -> None:
        self.metadata_base_url = metadata_base_url
        self.target_base_url = target_base_url
        self.metadata_dir = metadata_dir
        self.target_dir = target_dir
        self.immutable_root = immutable_root
        self.maximum_target_bytes = maximum_target_bytes
        self.root_chain = RootChain(immutable_root, metadata_dir / "root-chain")
        self._updater = None

    @staticmethod
    def _load_client():
        try:
            from tuf.ngclient import Updater
            from tuf.ngclient.config import UpdaterConfig
        except ImportError as error:
            raise TrustError("python-tuf is not installed") from error
        return Updater, UpdaterConfig

    def refresh(self) -> None:
        trusted_root, _ = self.root_chain.extend(self.metadata_base_url)
        self.metadata_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # python-tuf 5.1 loads its bootstrap from metadata_dir/root.json.
        # RootChain has already revalidated every old/new threshold transition
        # from immutable v1, so install exactly that latest root and prevent the
        # ngclient from performing an unretained parallel root rotation.
        atomic_write(self.metadata_dir / "root.json", trusted_root, mode=0o600)
        Updater, ClientConfig = self._load_client()
        config = ClientConfig(
            max_root_rotations=0,
            max_delegations=16,
            root_max_length=512 * 1024,
            timestamp_max_length=64 * 1024,
            snapshot_max_length=2 * 1024 * 1024,
            targets_max_length=4 * 1024 * 1024,
            prefix_targets_with_hash=True,
            app_user_agent="stugu-host-updater/1",
        )
        try:
            self._updater = Updater(
                metadata_dir=str(self.metadata_dir),
                metadata_base_url=self.metadata_base_url,
                target_dir=str(self.target_dir),
                target_base_url=self.target_base_url,
                config=config,
            )
            self._updater.refresh()
        except Exception as error:
            raise TrustError("TUF metadata refresh or verification failed") from error

    def _metadata_versions(self) -> dict[str, int]:
        versions: dict[str, int] = {}
        for path in sorted(self.metadata_dir.glob("*.json")):
            name = path.stem
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", name) or len(versions) >= 32:
                continue
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                version = value["signed"]["version"]
            except (
                OSError,
                UnicodeDecodeError,
                json.JSONDecodeError,
                KeyError,
                TypeError,
            ):
                continue
            if (
                isinstance(version, int)
                and not isinstance(version, bool)
                and version >= 0
            ):
                versions[name] = version
        return versions

    def target(self, path: str) -> VerifiedTarget:
        if self._updater is None:
            self.refresh()
        try:
            info = self._updater.get_targetinfo(path)
        except Exception as error:
            raise TrustError("TUF target lookup failed") from error
        if info is None:
            raise UpdaterError(
                "UPDATE_NOT_FOUND", "No signed host update target is available"
            )
        length = getattr(info, "length", None)
        hashes = getattr(info, "hashes", None)
        custom = getattr(info, "custom", None)
        if (
            not isinstance(length, int)
            or length <= 0
            or length > self.maximum_target_bytes
        ):
            raise TrustError("TUF target length is outside the appliance limit")
        if (
            not isinstance(hashes, dict)
            or not isinstance(hashes.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", hashes["sha256"])
        ):
            raise TrustError("TUF target does not include SHA-256")
        chain_length = self.root_chain.validate_cached()[1]
        versions = self._metadata_versions()
        versions["root"] = chain_length
        if any(
            isinstance(versions.get(role), bool)
            or not isinstance(versions.get(role), int)
            or int(versions[role]) < 1
            for role in ("root", "timestamp", "snapshot", "targets")
        ):
            raise TrustError(
                "TUF client did not retain all top-level metadata versions"
            )
        return VerifiedTarget(
            path,
            length,
            {str(key): str(value) for key, value in hashes.items()},
            TargetContract.parse(custom),
            versions,
            chain_length,
        )

    def download(self, verified: VerifiedTarget) -> Path:
        if self._updater is None:
            raise RuntimeError("target must be resolved before download")
        free = shutil.disk_usage(self.target_dir).free
        if free < verified.length + 256 * 1024**2:
            raise PreflightError(
                "STAGING_SPACE_LOW", "Not enough space to stage this update"
            )
        try:
            info = self._updater.get_targetinfo(verified.path)
            if info is None:
                raise TrustError("TUF target disappeared during staging")
            current_length = getattr(info, "length", None)
            current_hashes = getattr(info, "hashes", None)
            current_custom = getattr(info, "custom", None)
            if (
                current_length != verified.length
                or not isinstance(current_hashes, dict)
                or current_hashes.get("sha256") != verified.hashes["sha256"]
                or TargetContract.parse(current_custom) != verified.custom
            ):
                raise TrustError("TUF target changed after authorization")
            cached = self._updater.find_cached_target(info)
            result = cached or self._updater.download_target(info)
        except Exception as error:
            if isinstance(error, UpdaterError):
                raise
            raise TrustError(
                "TUF target download or full-file verification failed"
            ) from error
        path = Path(result).resolve()
        target_root = self.target_dir.resolve()
        if path != target_root and target_root not in path.parents:
            raise TrustError(
                "TUF client returned a cache path outside its target directory"
            )
        if path.stat().st_size != verified.length:
            raise TrustError("Verified target length changed after download")
        return path
