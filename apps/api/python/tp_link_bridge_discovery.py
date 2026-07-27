# ruff: noqa: F403, F405
"""TP-Link bridge implementation domain."""

from __future__ import annotations

from tp_link_bridge_common import *
from tp_link_bridge_recovery import *
from tp_link_bridge_runtime import *


async def _inspect_discovered_source(
    host: str,
    device: Any,
    can_authenticate: bool,
    semaphore: asyncio.Semaphore,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        model = str(device.model).upper().split("(", 1)[0].strip()
        source_type: str | None = "hub" if model in {"H100", "H200"} else None
        if source_type is None:
            energy_snapshots = direct_energy_snapshots(device)
            if not energy_snapshots:
                try:
                    async with semaphore:
                        await device.update(update_children=True)
                    energy_snapshots = direct_energy_snapshots(device)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    if not can_authenticate:
                        return None, None
                    return (
                        None,
                        f"TP-Link device at {host} could not be checked for energy monitoring: {str(error)[:200]}",
                    )
            if not energy_snapshots:
                return None, None
            source_type = "energy-device"
        try:
            alias = device.alias
        except Exception:
            alias = None
        return (
            {
                "host": host,
                "model": model,
                "alias": str(alias) if alias is not None else None,
                "sourceType": source_type,
            },
            None,
        )
    finally:
        try:
            await device.disconnect()
        except Exception:
            pass


async def discover_sources(username: str, password: str) -> None:
    credentials = (
        {"username": username, "password": password} if username and password else {}
    )
    configured_targets = [
        target.strip()
        for target in os.environ.get("TP_LINK_DISCOVERY_TARGETS", "").split(",")
        if target.strip()
    ]
    targets: list[str | None] = list(dict.fromkeys(configured_targets)) or [None]
    attempts = [
        Discover.discover(
            discovery_timeout=5,
            timeout=10,
            **({"target": target} if target else {}),
            **credentials,
        )
        for target in targets
    ]
    results = await asyncio.gather(*attempts, return_exceptions=True)
    devices: dict[str, Any] = {}
    failures: list[tuple[str | None, BaseException]] = []
    for target, result in zip(targets, results, strict=True):
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            failures.append((target, result))
            continue
        for host, device in result.items():
            if host in devices:
                try:
                    await device.disconnect()
                except Exception:
                    pass
                continue
            devices[host] = device
    if not devices and len(failures) == len(results):
        raise RuntimeError(str(failures[0][1]))
    semaphore = asyncio.Semaphore(16)
    inspected = await asyncio.gather(
        *(
            _inspect_discovered_source(
                host, device, bool(username and password), semaphore
            )
            for host, device in devices.items()
        )
    )
    sources = [source for source, _warning in inspected if source is not None]
    warnings = [
        f"TP-Link discovery via {target or 'the default broadcast'} failed: {str(error)[:200]}"
        for target, error in failures
    ]
    warnings.extend(warning for _source, warning in inspected if warning is not None)
    recovery_hosts = list(
        dict.fromkeys(
            host.strip()
            for host in os.environ.get("TP_LINK_RECOVERY_HOSTS", "").split(",")
            if host.strip()
        )
    )
    if recovery_hosts and username and password:
        # Docker networks may pass only some LAN broadcasts. Always supplement
        # them with a bounded same-/24 unicast scan around saved sources so a
        # responding H200 cannot mask a legacy HS110 or another energy device.
        known_hosts = {source["host"] for source in sources}
        direct_targets = [host for host in recovery_hosts if host not in known_hosts]
        recovered = (
            await scan_recovery_subnets(
                recovery_hosts, username, password, targets=direct_targets
            )
            if direct_targets
            else []
        )
        known_hosts.update(result["host"] for result in recovered)
        subnet_targets = [
            host for host in recovery_targets(recovery_hosts) if host not in known_hosts
        ]
        recovered.extend(
            await scan_recovery_subnets(
                recovery_hosts, username, password, targets=subnet_targets
            )
        )
        for result in recovered:
            if result["host"] in {source["host"] for source in sources}:
                continue
            sources.append(
                {
                    "host": result["host"],
                    "model": result["model"],
                    "alias": result["alias"],
                    "sourceType": result["sourceType"],
                }
            )
    emit(
        {
            "type": "discovery",
            "sources": sorted(sources, key=lambda item: item["host"]),
            "warnings": warnings,
        }
    )
