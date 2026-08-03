from __future__ import annotations


def release_manifest(
    generation: int = 42, *, rollback: str = "automatic"
) -> dict[str, object]:
    return {
        "schema": "stugu-host-release/v1",
        "product": "stugu-rpi4-usb",
        "hostGeneration": generation,
        "version": "1.2.3",
        "layout": "stugu-gpt-ab-v2",
        "hardware": {"models": ["raspberry-pi-4"], "minEeprom": "2026-01-01"},
        "updater": {"minContract": 4, "resultContract": 4},
        "bootShim": {"minGeneration": 1, "requiresRecoveryClassUpdate": False},
        "data": {
            "epoch": 7,
            "readableEpochs": [6, 7],
            "writableEpoch": 7,
            "rollback": rollback,
        },
        "runtimeState": {"dockerEpoch": 2, "tailscaleEpoch": 1},
        "containers": {
            "releaseSchema": 3,
            "manifestFile": "stugu-release-manifest-v1.json",
            "manifestSha256": "c" * 64,
        },
        "rollback": {"minimumFallbackGeneration": generation - 1},
        "artifacts": {
            "bootSha256": "a" * 64,
            "bootSize": 256 * 1024 * 1024,
            "rootSha256": "b" * 64,
            "rootSize": 3 * 1024 * 1024 * 1024,
        },
        "supplyChain": {
            "sbomFile": "stugu-host-sbom.spdx.json",
            "sbomSha256": "d" * 64,
            "provenanceFile": "stugu-host-provenance.intoto.jsonl",
            "provenanceSha256": "e" * 64,
            "sourceCommit": "f" * 40,
        },
        "migrations": [],
    }


def target_custom(manifest) -> dict[str, object]:
    return {
        "stugu": {
            "schema": "stugu-host-target/v1",
            "channel": "stable",
            "manifestSha256": manifest.digest,
            "product": manifest.product,
            "layout": manifest.layout,
            "hostGeneration": manifest.host_generation,
            "version": manifest.version,
            "bootSha256": manifest.artifacts.boot_sha256,
            "rootSha256": manifest.artifacts.root_sha256,
        }
    }
