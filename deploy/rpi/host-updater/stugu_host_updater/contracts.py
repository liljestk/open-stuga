"""Strict signed-release and daemon-protocol contracts.

The parser intentionally rejects unknown fields. A future contract must use a
new schema identifier instead of silently changing the meaning of v1.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Mapping

from .errors import ContractError


HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$")
TARGET_PATH = re.compile(r"^[A-Za-z0-9._/-]{1,240}$")
PLAIN_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
CHANNELS = frozenset({"stable", "preview", "recovery"})
ROLLBACK_POLICIES = frozenset({"automatic", "restore-required", "forbidden"})
MAX_JSON_INTEGER = 2**53 - 1


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def decode_json(data: bytes, *, maximum: int, label: str) -> object:
    if len(data) > maximum:
        raise ContractError(f"{label} exceeds {maximum} bytes")
    try:
        text = data.decode("utf-8")
        value = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError(f"{label} is not valid UTF-8 JSON") from error
    return value


def _object(
    value: object,
    path: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> Mapping[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ContractError(f"{path} must be an object")
    keys = set(value)
    missing = required - keys
    unknown = keys - required - (optional or set())
    if missing:
        raise ContractError(f"{path} is missing {', '.join(sorted(missing))}")
    if unknown:
        raise ContractError(
            f"{path} contains unknown fields: {', '.join(sorted(unknown))}"
        )
    return value


def _string(value: object, path: str, *, maximum: int = 160) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or not value.isascii()
    ):
        raise ContractError(f"{path} must be non-empty bounded ASCII text")
    return value


def _integer(
    value: object, path: str, *, minimum: int = 0, maximum: int = 2**63 - 1
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ContractError(
            f"{path} must be an integer between {minimum} and {maximum}"
        )
    return value


def _sha(value: object, path: str) -> str:
    result = _string(value, path, maximum=64)
    if not HEX_SHA256.fullmatch(result):
        raise ContractError(f"{path} must be a lowercase SHA-256 digest")
    return result


def _integer_list(value: object, path: str) -> tuple[int, ...]:
    if not isinstance(value, list) or not value or len(value) > 16:
        raise ContractError(f"{path} must be a non-empty bounded array")
    result = tuple(_integer(item, f"{path}[]", maximum=2**31 - 1) for item in value)
    if len(set(result)) != len(result) or tuple(sorted(result)) != result:
        raise ContractError(f"{path} must contain unique ascending values")
    return result


@dataclass(frozen=True)
class DataContract:
    epoch: int
    readable_epochs: tuple[int, ...]
    writable_epoch: int
    rollback: str

    @classmethod
    def parse(cls, value: object) -> "DataContract":
        data = _object(
            value,
            "data",
            required={"epoch", "readableEpochs", "writableEpoch", "rollback"},
        )
        epoch = _integer(data["epoch"], "data.epoch", maximum=2**31 - 1)
        readable = _integer_list(data["readableEpochs"], "data.readableEpochs")
        writable = _integer(
            data["writableEpoch"], "data.writableEpoch", maximum=2**31 - 1
        )
        rollback = _string(data["rollback"], "data.rollback", maximum=32)
        if rollback not in ROLLBACK_POLICIES:
            raise ContractError("data.rollback is unsupported")
        if epoch not in readable or writable != epoch:
            raise ContractError("data epoch must be readable and equal writableEpoch")
        return cls(epoch, readable, writable, rollback)

    def permits_automatic_from(self, source_epoch: int) -> bool:
        return self.rollback == "automatic" and source_epoch in self.readable_epochs


@dataclass(frozen=True)
class RuntimeContract:
    docker_epoch: int
    tailscale_epoch: int

    @classmethod
    def parse(cls, value: object) -> "RuntimeContract":
        data = _object(
            value, "runtimeState", required={"dockerEpoch", "tailscaleEpoch"}
        )
        return cls(
            _integer(
                data["dockerEpoch"], "runtimeState.dockerEpoch", maximum=2**31 - 1
            ),
            _integer(
                data["tailscaleEpoch"], "runtimeState.tailscaleEpoch", maximum=2**31 - 1
            ),
        )


@dataclass(frozen=True)
class ArtifactContract:
    boot_sha256: str
    boot_size: int
    root_sha256: str
    root_size: int

    @classmethod
    def parse(cls, value: object) -> "ArtifactContract":
        data = _object(
            value,
            "artifacts",
            required={"bootSha256", "bootSize", "rootSha256", "rootSize"},
        )
        return cls(
            _sha(data["bootSha256"], "artifacts.bootSha256"),
            _integer(
                data["bootSize"],
                "artifacts.bootSize",
                minimum=4096,
                maximum=256 * 1024**2,
            ),
            _sha(data["rootSha256"], "artifacts.rootSha256"),
            _integer(
                data["rootSize"],
                "artifacts.rootSize",
                minimum=4096,
                maximum=3 * 1024**3,
            ),
        )


@dataclass(frozen=True)
class SupplyChainContract:
    sbom_file: str
    sbom_sha256: str
    provenance_file: str
    provenance_sha256: str
    source_commit: str

    @classmethod
    def parse(cls, value: object) -> "SupplyChainContract":
        data = _object(
            value,
            "supplyChain",
            required={
                "sbomFile",
                "sbomSha256",
                "provenanceFile",
                "provenanceSha256",
                "sourceCommit",
            },
        )
        sbom_file = _string(data["sbomFile"], "supplyChain.sbomFile", maximum=80)
        provenance_file = _string(
            data["provenanceFile"], "supplyChain.provenanceFile", maximum=80
        )
        if not PLAIN_FILE.fullmatch(sbom_file) or not PLAIN_FILE.fullmatch(
            provenance_file
        ):
            raise ContractError("supply-chain filenames must be plain filenames")
        commit = _string(data["sourceCommit"], "supplyChain.sourceCommit", maximum=64)
        if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            raise ContractError("supplyChain.sourceCommit must be a Git object digest")
        return cls(
            sbom_file,
            _sha(data["sbomSha256"], "supplyChain.sbomSha256"),
            provenance_file,
            _sha(data["provenanceSha256"], "supplyChain.provenanceSha256"),
            commit,
        )


@dataclass(frozen=True)
class MigrationContract:
    identifier: str
    filename: str
    sha256: str
    kind: str
    backward_compatible: bool

    @classmethod
    def parse_many(cls, value: object) -> tuple["MigrationContract", ...]:
        if not isinstance(value, list) or len(value) > 32:
            raise ContractError("migrations must be a bounded array")
        result: list[MigrationContract] = []
        for index, item in enumerate(value):
            data = _object(
                item,
                f"migrations[{index}]",
                required={"id", "filename", "sha256", "kind", "backwardCompatible"},
            )
            identifier = _string(data["id"], f"migrations[{index}].id", maximum=64)
            filename = _string(
                data["filename"], f"migrations[{index}].filename", maximum=80
            )
            kind = _string(data["kind"], f"migrations[{index}].kind", maximum=32)
            compatible = data["backwardCompatible"]
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", identifier):
                raise ContractError("migration id is invalid")
            if not PLAIN_FILE.fullmatch(filename) or not filename.startswith(
                "migration-"
            ):
                raise ContractError("migration filename is invalid")
            if kind not in {"sqlite", "timescale", "filesystem", "host-config"}:
                raise ContractError("migration kind is unsupported")
            if not isinstance(compatible, bool):
                raise ContractError("migration backwardCompatible must be boolean")
            result.append(
                cls(
                    identifier,
                    filename,
                    _sha(data["sha256"], "migration sha256"),
                    kind,
                    compatible,
                )
            )
        if len({item.identifier for item in result}) != len(result) or len(
            {item.filename for item in result}
        ) != len(result):
            raise ContractError("migration ids and filenames must be unique")
        return tuple(result)


@dataclass(frozen=True)
class ReleaseManifest:
    raw: Mapping[str, Any]
    product: str
    host_generation: int
    version: str
    layout: str
    models: tuple[str, ...]
    min_eeprom: str
    min_contract: int
    result_contract: int
    boot_shim_generation: int
    recovery_class_update: bool
    data: DataContract
    runtime: RuntimeContract
    container_release_schema: int
    container_manifest_file: str
    container_manifest_sha256: str
    minimum_fallback_generation: int
    artifacts: ArtifactContract
    supply_chain: SupplyChainContract
    migrations: tuple[MigrationContract, ...]

    @classmethod
    def from_bytes(cls, data: bytes) -> "ReleaseManifest":
        return cls.parse(
            decode_json(data, maximum=64 * 1024, label="host release manifest")
        )

    @classmethod
    def parse(cls, value: object) -> "ReleaseManifest":
        raw = _object(
            value,
            "release",
            required={
                "schema",
                "product",
                "hostGeneration",
                "version",
                "layout",
                "hardware",
                "updater",
                "bootShim",
                "data",
                "runtimeState",
                "containers",
                "rollback",
                "artifacts",
                "supplyChain",
                "migrations",
            },
        )
        if raw["schema"] != "stugu-host-release/v1":
            raise ContractError("release.schema is unsupported")
        product = _string(raw["product"], "product")
        layout = _string(raw["layout"], "layout")
        version = _string(raw["version"], "version", maximum=64)
        if not VERSION.fullmatch(version):
            raise ContractError("version is invalid")

        hardware = _object(
            raw["hardware"], "hardware", required={"models", "minEeprom"}
        )
        models_value = hardware["models"]
        if not isinstance(models_value, list) or not 1 <= len(models_value) <= 8:
            raise ContractError("hardware.models must be a bounded non-empty array")
        models = tuple(
            _string(model, "hardware.models[]", maximum=64) for model in models_value
        )
        if len(set(models)) != len(models):
            raise ContractError("hardware.models contains duplicates")

        updater = _object(
            raw["updater"], "updater", required={"minContract", "resultContract"}
        )
        shim = _object(
            raw["bootShim"],
            "bootShim",
            required={"minGeneration", "requiresRecoveryClassUpdate"},
        )
        if not isinstance(shim["requiresRecoveryClassUpdate"], bool):
            raise ContractError("bootShim.requiresRecoveryClassUpdate must be boolean")
        containers = _object(
            raw["containers"],
            "containers",
            required={"releaseSchema", "manifestFile", "manifestSha256"},
        )
        container_manifest_file = _string(
            containers["manifestFile"], "containers.manifestFile", maximum=80
        )
        if not PLAIN_FILE.fullmatch(container_manifest_file):
            raise ContractError("containers.manifestFile must be a plain filename")
        rollback = _object(
            raw["rollback"],
            "rollback",
            required={"minimumFallbackGeneration"},
        )

        generation = _integer(
            raw["hostGeneration"], "hostGeneration", maximum=MAX_JSON_INTEGER
        )
        fallback = _integer(
            rollback["minimumFallbackGeneration"],
            "rollback.minimumFallbackGeneration",
            maximum=MAX_JSON_INTEGER,
        )
        if fallback > generation:
            raise ContractError(
                "minimum fallback generation cannot exceed target generation"
            )
        minimum_contract = _integer(
            updater["minContract"], "updater.minContract", maximum=255
        )
        result_contract = _integer(
            updater["resultContract"], "updater.resultContract", maximum=255
        )
        if result_contract < minimum_contract:
            raise ContractError(
                "updater.resultContract cannot be below updater.minContract"
            )
        supply_chain = SupplyChainContract.parse(raw["supplyChain"])
        migrations = MigrationContract.parse_many(raw["migrations"])
        payload_names = [
            "stugu-host-manifest.json",
            "manifest.raucm",
            "boot.vfat",
            "system.erofs",
            container_manifest_file,
            supply_chain.sbom_file,
            supply_chain.provenance_file,
            *(migration.filename for migration in migrations),
        ]
        if len(set(payload_names)) != len(payload_names):
            raise ContractError("signed bundle payload filenames must be distinct")
        return cls(
            raw=raw,
            product=product,
            host_generation=generation,
            version=version,
            layout=layout,
            models=models,
            min_eeprom=_string(hardware["minEeprom"], "hardware.minEeprom", maximum=64),
            min_contract=minimum_contract,
            result_contract=result_contract,
            boot_shim_generation=_integer(
                shim["minGeneration"], "bootShim.minGeneration", maximum=2**31 - 1
            ),
            recovery_class_update=shim["requiresRecoveryClassUpdate"],
            data=DataContract.parse(raw["data"]),
            runtime=RuntimeContract.parse(raw["runtimeState"]),
            container_release_schema=_integer(
                containers["releaseSchema"], "containers.releaseSchema", maximum=255
            ),
            container_manifest_file=container_manifest_file,
            container_manifest_sha256=_sha(
                containers["manifestSha256"], "containers.manifestSha256"
            ),
            minimum_fallback_generation=fallback,
            artifacts=ArtifactContract.parse(raw["artifacts"]),
            supply_chain=supply_chain,
            migrations=migrations,
        )

    @property
    def digest(self) -> str:
        return sha256_bytes(canonical_json(self.raw))


@dataclass(frozen=True)
class TargetContract:
    channel: str
    manifest_sha256: str
    product: str
    layout: str
    host_generation: int
    version: str
    boot_sha256: str
    root_sha256: str

    @classmethod
    def parse(cls, value: object) -> "TargetContract":
        outer = _object(value, "target.custom", required={"stugu"})
        data = _object(
            outer["stugu"],
            "target.custom.stugu",
            required={
                "schema",
                "channel",
                "manifestSha256",
                "product",
                "layout",
                "hostGeneration",
                "version",
                "bootSha256",
                "rootSha256",
            },
        )
        if data["schema"] != "stugu-host-target/v1":
            raise ContractError("target custom schema is unsupported")
        channel = _string(data["channel"], "target.custom.stugu.channel", maximum=16)
        if channel not in CHANNELS:
            raise ContractError("target channel is unsupported")
        version = _string(data["version"], "target custom version", maximum=64)
        if not VERSION.fullmatch(version):
            raise ContractError("target custom version is invalid")
        return cls(
            channel=channel,
            manifest_sha256=_sha(data["manifestSha256"], "target manifest digest"),
            product=_string(data["product"], "target product"),
            layout=_string(data["layout"], "target layout"),
            host_generation=_integer(
                data["hostGeneration"], "target generation", maximum=MAX_JSON_INTEGER
            ),
            version=version,
            boot_sha256=_sha(data["bootSha256"], "target boot digest"),
            root_sha256=_sha(data["rootSha256"], "target root digest"),
        )

    def require_matches(self, manifest: ReleaseManifest, channel: str) -> None:
        expected = (
            channel,
            manifest.digest,
            manifest.product,
            manifest.layout,
            manifest.host_generation,
            manifest.version,
            manifest.artifacts.boot_sha256,
            manifest.artifacts.root_sha256,
        )
        actual = (
            self.channel,
            self.manifest_sha256,
            self.product,
            self.layout,
            self.host_generation,
            self.version,
            self.boot_sha256,
            self.root_sha256,
        )
        if actual != expected:
            raise ContractError(
                "TUF routing metadata does not match the RAUC-signed manifest"
            )


def validate_target_path(value: object) -> str:
    path = _string(value, "target path", maximum=240)
    if (
        not TARGET_PATH.fullmatch(path)
        or path.startswith(("/", "."))
        or ".." in path.split("/")
    ):
        raise ContractError("target path is not repository-relative")
    return path


def validate_request(value: object) -> dict[str, object]:
    data = _object(
        value,
        "request",
        required={"schema", "operation"},
        optional={"channel", "confirm", "repair"},
    )
    if data["schema"] != "stugu-host-update-request/v1":
        raise ContractError("request schema is unsupported")
    operation = data["operation"]
    allowed = {
        "check",
        "stage",
        "activate",
        "cancel",
        "status",
        "hardware-id",
        "export-diagnostics",
        "reconcile",
    }
    if operation not in allowed:
        raise ContractError("request operation is unsupported")
    result: dict[str, object] = {"schema": data["schema"], "operation": operation}
    if operation in {"check", "stage"}:
        channel = data.get("channel", "stable")
        if channel not in CHANNELS - {"recovery"}:
            raise ContractError("normal requests support stable or preview channels")
        result["channel"] = channel
    elif "channel" in data:
        raise ContractError("channel is valid only for check or stage")
    if "confirm" in data and operation != "activate":
        raise ContractError("confirm is valid only for activate")
    if "repair" in data and operation != "stage":
        raise ContractError("repair is valid only for stage")
    for flag in ("confirm", "repair"):
        if flag in data:
            if not isinstance(data[flag], bool):
                raise ContractError(f"request.{flag} must be boolean")
            result[flag] = data[flag]
    return result
