"""Strict validation for the durable native host-update journal."""

from __future__ import annotations

import uuid

from .boottransitions import BootTransition
from .contracts import (
    CHANNELS,
    HEX_SHA256,
    MAX_JSON_INTEGER,
    ReleaseManifest,
    validate_target_path,
)
from .errors import ContractError, TrustError, UpdaterError
from .health import valid_health_evidence


JOURNAL_SCHEMA = "stugu-host-update-journal/v1"
REUSABLE_PHASES = frozenset({"complete", "cancelled", "returned"})
INTENT_PHASES = frozenset(
    {"activation-intent", "probation-intent", "success-intent", "return-intent"}
)
JOURNAL_PHASES = (
    REUSABLE_PHASES
    | INTENT_PHASES
    | frozenset(
        {
            "prepared",
            "installed",
            "pending",
            "probation",
            "failed",
            "recovery-needed",
        }
    )
)


def validate_host_journal(
    value: object, *, product: str, layout: str
) -> dict[str, object] | None:
    if value is None:
        return None
    required = {
        "schema",
        "operationId",
        "phase",
        "createdAt",
        "updatedAt",
        "channel",
        "targetPath",
        "targetLength",
        "targetSha256",
        "bundlePath",
        "raucManifestHash",
        "manifest",
        "manifestSha256",
        "sourceSlot",
        "targetSlot",
        "sourceGeneration",
        "sourceManifestSha256",
        "targetGeneration",
        "persistentPartuuid",
        "slotPartuuids",
        "trialCount",
        "repair",
    }
    optional = {
        "bootTransition",
        "health",
        "intentId",
        "rollbackReason",
        "rollbackError",
    }
    legacy_unbound_source = (
        isinstance(value, dict)
        and value.get("schema") == JOURNAL_SCHEMA
        and "sourceManifestSha256" not in value
    )
    if legacy_unbound_source:
        value = {**value, "sourceManifestSha256": "0" * 64}
    if (
        not isinstance(value, dict)
        or set(value) - required - optional
        or required - set(value)
        or value.get("schema") != JOURNAL_SCHEMA
        or value.get("phase") not in JOURNAL_PHASES
    ):
        raise TrustError("Persistent host-update journal is invalid")
    try:
        operation_id = str(uuid.UUID(str(value["operationId"])))
        persistent = str(uuid.UUID(str(value["persistentPartuuid"])))
    except ValueError as error:
        raise TrustError(
            "Persistent host-update journal identity is invalid"
        ) from error
    if (
        operation_id != value["operationId"]
        or persistent != value["persistentPartuuid"]
    ):
        raise TrustError("Persistent host-update journal identity is not canonical")
    if "intentId" in value:
        try:
            intent_id = str(uuid.UUID(str(value["intentId"])))
        except ValueError as error:
            raise TrustError(
                "Persistent host-update journal intent is invalid"
            ) from error
        if intent_id != value["intentId"]:
            raise TrustError("Persistent host-update journal intent is not canonical")
    channel = value["channel"]
    try:
        target_path = validate_target_path(value["targetPath"])
    except ContractError as error:
        raise TrustError("Persistent host-update journal target is invalid") from error
    if channel not in CHANNELS - {"recovery"} or target_path != value["targetPath"]:
        raise TrustError("Persistent host-update journal target is invalid")
    integers = (
        value["targetLength"],
        value["sourceGeneration"],
        value["targetGeneration"],
        value["trialCount"],
    )
    if (
        any(
            isinstance(item, bool)
            or not isinstance(item, int)
            or not 0 <= item <= MAX_JSON_INTEGER
            for item in integers
        )
        or not 0 < int(value["targetLength"]) <= 8 * 1024**3
    ):
        raise TrustError("Persistent host-update journal counters are invalid")
    if not isinstance(value["repair"], bool):
        raise TrustError("Persistent host-update journal repair mode is invalid")
    phase = str(value["phase"])
    trial_count = int(value["trialCount"])
    phase_trials = {
        "prepared": {0},
        "installed": {0},
        "pending": {0, 1},
        "probation": {2},
        "activation-intent": {0},
        "probation-intent": {2},
        "success-intent": {2},
        "complete": {2},
        "cancelled": {0},
    }
    if phase in phase_trials and trial_count not in phase_trials[phase]:
        raise TrustError("Persistent host-update journal trial state is invalid")
    transition = value.get("bootTransition")
    if phase in INTENT_PHASES:
        expected_kind = {
            "activation-intent": "activate",
            "probation-intent": "probation",
            "success-intent": "success",
            "return-intent": "return",
        }[phase]
        if BootTransition.parse(transition).kind != expected_kind:
            raise TrustError("Persistent boot transition intent is inconsistent")
    elif transition is not None:
        raise TrustError("Persistent journal has an unexpected boot transition")
    if value["sourceSlot"] not in {"a", "b"} or value["targetSlot"] not in {
        "a",
        "b",
    }:
        raise TrustError("Persistent host-update journal slot is invalid")
    if value["sourceSlot"] == value["targetSlot"]:
        raise TrustError("Persistent host-update journal slots overlap")
    for field in (
        "targetSha256",
        "raucManifestHash",
        "manifestSha256",
        "sourceManifestSha256",
    ):
        if not isinstance(value[field], str) or not HEX_SHA256.fullmatch(
            str(value[field])
        ):
            raise TrustError("Persistent host-update journal digest is invalid")
    slots = value["slotPartuuids"]
    expected_slots = {"sourceBoot", "sourceSystem", "targetBoot", "targetSystem"}
    if not isinstance(slots, dict) or set(slots) != expected_slots:
        raise TrustError(
            "Persistent host-update journal partition identities are invalid"
        )
    try:
        canonical_slots = [
            str(uuid.UUID(str(slots[name]))) for name in sorted(expected_slots)
        ]
    except ValueError as error:
        raise TrustError(
            "Persistent host-update journal partition UUID is invalid"
        ) from error
    if (
        canonical_slots != [slots[name] for name in sorted(expected_slots)]
        or len(set(canonical_slots)) != 4
    ):
        raise TrustError("Persistent host-update journal partition UUIDs are ambiguous")
    manifest = ReleaseManifest.parse(value.get("manifest"))
    if (
        manifest.digest != value["manifestSha256"]
        or manifest.host_generation != value["targetGeneration"]
        or manifest.product != product
        or manifest.layout != layout
    ):
        raise TrustError("Persistent host-update journal manifest is inconsistent")
    if "health" in value and not valid_health_evidence(value["health"]):
        raise TrustError("Persistent host-update journal health evidence is invalid")
    if legacy_unbound_source and phase not in REUSABLE_PHASES:
        return {
            **value,
            "phase": "recovery-needed",
            "rollbackReason": "legacy-source-manifest-unbound",
            "rollbackError": "SOURCE_MANIFEST_UNBOUND",
        }
    return value


def require_expected_staged_identity(
    journal: dict[str, object],
    *,
    intent_id: str | None,
    expected_operation_id: str | None,
    expected_version: str | None,
    expected_generation: int | None,
    expected_manifest_sha256: str | None,
) -> None:
    manifest = ReleaseManifest.parse(journal.get("manifest"))
    expected = (
        intent_id,
        expected_operation_id,
        expected_version,
        expected_generation,
        expected_manifest_sha256,
    )
    if all(value is None for value in expected):
        return
    actual = (
        journal.get("intentId"),
        journal.get("operationId"),
        manifest.version,
        journal.get("targetGeneration"),
        journal.get("manifestSha256"),
    )
    if any(value is None for value in expected) or actual != expected:
        raise UpdaterError(
            "STALE_CONFIRMATION",
            "The staged host update changed; review it before continuing",
        )
