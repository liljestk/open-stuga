"""Pure boot-record transitions and exact durable-state predicates."""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import replace
import hashlib

from .bootcontrol import BootRecord, SlotState
from .contracts import HEX_SHA256, MAX_JSON_INTEGER
from .errors import TrustError


TRANSITION_KINDS = frozenset({"activate", "probation", "success", "return"})


def boot_record_sha256(record: BootRecord) -> str:
    return hashlib.sha256(record.encode()).hexdigest()


@dataclass(frozen=True)
class BootTransition:
    kind: str
    from_sequence: int
    from_sha256: str
    to_sequence: int
    to_sha256: str

    @classmethod
    def create(
        cls, kind: str, before: BootRecord, after: BootRecord
    ) -> "BootTransition":
        if kind not in TRANSITION_KINDS or after.sequence != before.sequence + 1:
            raise TrustError("Boot transition intent is invalid")
        return cls(
            kind,
            before.sequence,
            boot_record_sha256(before),
            after.sequence,
            boot_record_sha256(after),
        )

    @classmethod
    def parse(cls, value: object) -> "BootTransition":
        expected = {
            "schema",
            "kind",
            "fromSequence",
            "fromSha256",
            "toSequence",
            "toSha256",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or value.get("schema") != "stugu-boot-transition/v1"
            or value.get("kind") not in TRANSITION_KINDS
        ):
            raise TrustError("Boot transition intent is invalid")
        sequences = (value.get("fromSequence"), value.get("toSequence"))
        digests = (value.get("fromSha256"), value.get("toSha256"))
        if (
            any(
                isinstance(item, bool)
                or not isinstance(item, int)
                or not 0 <= item <= MAX_JSON_INTEGER
                for item in sequences
            )
            or sequences[1] != sequences[0] + 1
            or any(
                not isinstance(item, str) or not HEX_SHA256.fullmatch(item)
                for item in digests
            )
        ):
            raise TrustError("Boot transition intent is invalid")
        return cls(
            str(value["kind"]),
            int(value["fromSequence"]),
            str(value["fromSha256"]),
            int(value["toSequence"]),
            str(value["toSha256"]),
        )

    def json(self) -> dict[str, object]:
        return {
            "schema": "stugu-boot-transition/v1",
            "kind": self.kind,
            "fromSequence": self.from_sequence,
            "fromSha256": self.from_sha256,
            "toSequence": self.to_sequence,
            "toSha256": self.to_sha256,
        }

    def matches_from(self, record: BootRecord) -> bool:
        return (
            record.sequence == self.from_sequence
            and boot_record_sha256(record) == self.from_sha256
        )

    def matches_to(self, record: BootRecord) -> bool:
        return (
            record.sequence == self.to_sequence
            and boot_record_sha256(record) == self.to_sha256
        )


def source_is_usable(
    record: BootRecord,
    *,
    source: str,
    generation: int,
    manifest_sha256: str,
) -> bool:
    state = record.slots[source]
    return (
        state.generation == generation
        and state.manifest_sha256 == manifest_sha256
        and state.successful
    )


def is_clean_source_record(
    record: BootRecord,
    *,
    source: str,
    generation: int,
    manifest_sha256: str,
) -> bool:
    return (
        source_is_usable(
            record,
            source=source,
            generation=generation,
            manifest_sha256=manifest_sha256,
        )
        and record.committed == source
        and record.pending is None
        and record.state in {"successful", "fallback"}
    )


def is_pending_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    source_generation: int,
    source_manifest_sha256: str,
    target_generation: int,
    manifest_sha256: str,
    tries_remaining: int,
) -> bool:
    target_state = record.slots[target]
    return (
        source_is_usable(
            record,
            source=source,
            generation=source_generation,
            manifest_sha256=source_manifest_sha256,
        )
        and record.committed == source
        and record.pending == target
        and record.fallback == source
        and record.state == "pending"
        and target_state.generation == target_generation
        and target_state.manifest_sha256 == manifest_sha256
        and not target_state.successful
        and target_state.tries_remaining == tries_remaining
    )


def is_probation_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    source_generation: int,
    source_manifest_sha256: str,
    target_generation: int,
    manifest_sha256: str,
    tries_remaining: int,
) -> bool:
    target_state = record.slots[target]
    return (
        source_is_usable(
            record,
            source=source,
            generation=source_generation,
            manifest_sha256=source_manifest_sha256,
        )
        and record.committed == target
        and record.pending is None
        and record.fallback == source
        and record.state == "probation"
        and target_state.generation == target_generation
        and target_state.manifest_sha256 == manifest_sha256
        and not target_state.successful
        and target_state.tries_remaining == tries_remaining
    )


def is_successful_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    source_generation: int,
    source_manifest_sha256: str,
    target_generation: int,
    manifest_sha256: str,
) -> bool:
    target_state = record.slots[target]
    return (
        source_is_usable(
            record,
            source=source,
            generation=source_generation,
            manifest_sha256=source_manifest_sha256,
        )
        and record.committed == target
        and record.pending is None
        and record.fallback == source
        and record.state == "successful"
        and target_state.generation == target_generation
        and target_state.manifest_sha256 == manifest_sha256
        and target_state.successful
        and target_state.tries_remaining == 3
    )


def pending_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    generation: int,
    manifest_sha256: str,
) -> BootRecord:
    slots = dict(record.slots)
    slots[target] = SlotState(generation, manifest_sha256, False, 2)
    return replace(
        record,
        sequence=record.sequence + 1,
        committed=source,
        pending=target,
        fallback=source,
        state="pending",
        slots=slots,
    )


def probation_record(record: BootRecord, *, source: str, target: str) -> BootRecord:
    slots = dict(record.slots)
    slots[target] = replace(slots[target], successful=False, tries_remaining=3)
    return replace(
        record,
        sequence=record.sequence + 1,
        committed=target,
        pending=None,
        fallback=source,
        state="probation",
        slots=slots,
    )


def successful_record(record: BootRecord, *, target: str) -> BootRecord:
    slots = dict(record.slots)
    slots[target] = replace(slots[target], successful=True, tries_remaining=3)
    return replace(
        record,
        sequence=record.sequence + 1,
        state="successful",
        slots=slots,
    )


def selector_consumed_transition_matches(
    transition: BootTransition, record: BootRecord, *, slot: str
) -> bool:
    """Match the selector's exact sequence increment and sole try decrement."""
    state = record.slots[slot]
    if record.sequence != transition.to_sequence + 1 or state.tries_remaining >= 7:
        return False
    slots = dict(record.slots)
    slots[slot] = replace(state, tries_remaining=state.tries_remaining + 1)
    intended = replace(record, sequence=transition.to_sequence, slots=slots)
    return transition.matches_to(intended)


def require_trial_record(
    record: BootRecord,
    *,
    source: str,
    target: str,
    source_generation: int,
    source_manifest_sha256: str,
    generation: int,
    manifest_sha256: str,
    phase: str,
    trial_count: int,
) -> None:
    expected_tries = {("pending", 0): 1, ("pending", 1): 0, ("probation", 2): 2}
    tries_remaining = expected_tries.get((phase, trial_count))
    if tries_remaining is None:
        raise TrustError("Boot shim did not durably account for the expected trial")
    predicate = is_probation_record if phase == "probation" else is_pending_record
    if not predicate(
        record,
        source=source,
        target=target,
        source_generation=source_generation,
        source_manifest_sha256=source_manifest_sha256,
        target_generation=generation,
        manifest_sha256=manifest_sha256,
        tries_remaining=tries_remaining,
    ):
        raise TrustError("Boot shim did not durably account for the expected trial")


def fallback_record(record: BootRecord, source: str, target: str) -> BootRecord:
    slots = dict(record.slots)
    slots[source] = replace(slots[source], successful=True, tries_remaining=3)
    slots[target] = replace(slots[target], successful=False, tries_remaining=0)
    return replace(
        record,
        sequence=record.sequence + 1,
        committed=source,
        pending=None,
        fallback=target,
        state="fallback",
        slots=slots,
    )
