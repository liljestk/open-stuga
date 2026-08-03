"""Immutable daemon configuration."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from urllib.parse import urlparse

from .contracts import CHANNELS, MAX_JSON_INTEGER, validate_target_path
from .durable import read_bounded_regular
from .errors import ContractError


@dataclass(frozen=True)
class Paths:
    state: Path
    cache: Path
    immutable_root: Path
    rauc_keyring: Path
    qualification: Path
    socket: Path
    lock: Path
    persistent_mount: Path
    release_manifest_name: str


@dataclass(frozen=True)
class UpdaterConfig:
    metadata_base_url: str
    target_base_url: str
    targets: dict[str, str]
    product: str
    layout: str
    model: str
    host_generation: int
    updater_contract: int
    boot_shim_generation: int
    data_epoch: int
    readable_data_epochs: tuple[int, ...]
    docker_epoch: int
    tailscale_epoch: int
    maximum_bundle_bytes: int
    paths: Paths

    @classmethod
    def load(cls, path: Path) -> "UpdaterConfig":
        try:
            data = read_bounded_regular(path, maximum=128 * 1024)
            assert isinstance(data, bytes)
            value = json.loads(data.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContractError(
                f"Cannot load updater configuration: {error}"
            ) from error
        return cls.parse(value)

    @classmethod
    def parse(cls, value: object) -> "UpdaterConfig":
        if not isinstance(value, dict):
            raise ContractError("updater configuration must be an object")
        expected = {
            "schema",
            "metadataBaseUrl",
            "targetBaseUrl",
            "targets",
            "product",
            "layout",
            "model",
            "hostGeneration",
            "updaterContract",
            "bootShimGeneration",
            "dataEpoch",
            "readableDataEpochs",
            "runtimeState",
            "maximumBundleBytes",
            "paths",
        }
        if (
            set(value) != expected
            or value.get("schema") != "stugu-host-updater-config/v1"
        ):
            raise ContractError("updater configuration fields or schema are invalid")

        def bounded_text(item: object, label: str, maximum: int = 512) -> str:
            if (
                not isinstance(item, str)
                or not item
                or len(item) > maximum
                or not item.isascii()
            ):
                raise ContractError(f"{label} must be bounded ASCII text")
            return item

        def number(item: object, label: str, maximum: int = 2**31 - 1) -> int:
            if (
                isinstance(item, bool)
                or not isinstance(item, int)
                or not 0 <= item <= maximum
            ):
                raise ContractError(f"{label} must be a bounded non-negative integer")
            return item

        def https_url(item: object, label: str) -> str:
            result = bounded_text(item, label)
            parsed = urlparse(result)
            if (
                parsed.scheme != "https"
                or not parsed.netloc
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ContractError(
                    f"{label} must be an HTTPS base URL without credentials"
                )
            return result.rstrip("/") + "/"

        targets = value["targets"]
        if (
            not isinstance(targets, dict)
            or not targets
            or set(targets) - (CHANNELS - {"recovery"})
        ):
            raise ContractError("targets must map supported normal channels")
        parsed_targets = {
            str(channel): validate_target_path(target)
            for channel, target in targets.items()
        }
        if "stable" not in parsed_targets:
            raise ContractError("targets must define the stable channel")

        runtime = value["runtimeState"]
        if not isinstance(runtime, dict) or set(runtime) != {
            "dockerEpoch",
            "tailscaleEpoch",
        }:
            raise ContractError("runtimeState fields are invalid")
        readable_value = value["readableDataEpochs"]
        if (
            not isinstance(readable_value, list)
            or not readable_value
            or len(readable_value) > 16
        ):
            raise ContractError("readableDataEpochs must be a bounded non-empty array")
        readable = tuple(
            number(item, "readableDataEpochs[]") for item in readable_value
        )
        if (
            tuple(sorted(set(readable))) != readable
            or value["dataEpoch"] not in readable
        ):
            raise ContractError(
                "readableDataEpochs must be unique, ascending, and include dataEpoch"
            )
        path_values = value["paths"]
        expected_paths = {
            "state",
            "cache",
            "immutableRoot",
            "raucKeyring",
            "qualification",
            "socket",
            "lock",
            "persistentMount",
            "releaseManifestName",
        }
        if not isinstance(path_values, dict) or set(path_values) != expected_paths:
            raise ContractError("configuration paths are invalid")

        def absolute_path(name: str) -> Path:
            result = Path(bounded_text(path_values[name], f"paths.{name}"))
            if not result.is_absolute() or ".." in result.parts:
                raise ContractError(f"paths.{name} must be absolute")
            return result

        manifest_name = bounded_text(
            path_values["releaseManifestName"], "paths.releaseManifestName", 80
        )
        if (
            "/" in manifest_name
            or "\\" in manifest_name
            or manifest_name in {".", ".."}
        ):
            raise ContractError("release manifest name must be a plain filename")

        host_generation = number(
            value["hostGeneration"], "hostGeneration", MAX_JSON_INTEGER
        )
        updater_contract = number(value["updaterContract"], "updaterContract", 255)
        boot_shim_generation = number(value["bootShimGeneration"], "bootShimGeneration")
        maximum_bundle_bytes = number(
            value["maximumBundleBytes"], "maximumBundleBytes", 8 * 1024**3
        )
        if host_generation < 1 or updater_contract < 3 or boot_shim_generation < 1:
            raise ContractError(
                "host, updater, and boot-shim generations are below supported floors"
            )
        if maximum_bundle_bytes < 4096:
            raise ContractError(
                "maximumBundleBytes is below the minimum signed bundle size"
            )

        return cls(
            metadata_base_url=https_url(value["metadataBaseUrl"], "metadataBaseUrl"),
            target_base_url=https_url(value["targetBaseUrl"], "targetBaseUrl"),
            targets=parsed_targets,
            product=bounded_text(value["product"], "product", 80),
            layout=bounded_text(value["layout"], "layout", 80),
            model=bounded_text(value["model"], "model", 80),
            host_generation=host_generation,
            updater_contract=updater_contract,
            boot_shim_generation=boot_shim_generation,
            data_epoch=number(value["dataEpoch"], "dataEpoch"),
            readable_data_epochs=readable,
            docker_epoch=number(runtime["dockerEpoch"], "runtimeState.dockerEpoch"),
            tailscale_epoch=number(
                runtime["tailscaleEpoch"], "runtimeState.tailscaleEpoch"
            ),
            maximum_bundle_bytes=maximum_bundle_bytes,
            paths=Paths(
                state=absolute_path("state"),
                cache=absolute_path("cache"),
                immutable_root=absolute_path("immutableRoot"),
                rauc_keyring=absolute_path("raucKeyring"),
                qualification=absolute_path("qualification"),
                socket=absolute_path("socket"),
                lock=absolute_path("lock"),
                persistent_mount=absolute_path("persistentMount"),
                release_manifest_name=manifest_name,
            ),
        )
