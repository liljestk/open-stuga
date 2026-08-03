"""Non-activating RAUC custom backend.

RAUC may record installability, but only stugu-host-updated can mutate the
boot-control records. With activate-installed=false, set-primary is unexpected
and deliberately rejected.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys

from .durable import atomic_json, read_json


STATE = Path(
    os.environ.get("STUGU_RAUC_SLOT_STATE", "/persistent/stugu/rauc/slot-state.json")
)


def _load() -> dict[str, str]:
    value = read_json(STATE, maximum=16 * 1024)
    if value is None:
        return {"a": "good", "b": "good"}
    if not isinstance(value, dict) or value.get("schema") != "stugu-rauc-slot-state/v1":
        raise RuntimeError("RAUC slot state is invalid")
    slots = value.get("slots")
    if (
        not isinstance(slots, dict)
        or set(slots) != {"a", "b"}
        or any(item not in {"good", "bad"} for item in slots.values())
    ):
        raise RuntimeError("RAUC slot state is invalid")
    return {"a": slots["a"], "b": slots["b"]}


def _active() -> str:
    active = Path(os.path.realpath("/dev/disk/by-slot/active/system"))
    for suffix in ("a", "b"):
        if Path(os.path.realpath(f"/dev/disk/by-slot/{suffix}/system")) == active:
            return suffix
    raise RuntimeError("active slot is unknown")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args == ["get-primary"] or args == ["get-current"]:
            print(_active())
            return 0
        if len(args) == 2 and args[0] == "get-state" and args[1] in {"a", "b"}:
            print(_load()[args[1]])
            return 0
        if (
            len(args) == 3
            and args[0] == "set-state"
            and args[1] in {"a", "b"}
            and args[2] in {"good", "bad"}
        ):
            state = _load()
            state[args[1]] = args[2]
            atomic_json(STATE, {"schema": "stugu-rauc-slot-state/v1", "slots": state})
            return 0
        if args and args[0] == "set-primary":
            print("activation is owned by stugu-host-updated", file=sys.stderr)
            return 2
        print("unsupported RAUC bootloader operation", file=sys.stderr)
        return 2
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
