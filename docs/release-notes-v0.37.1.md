# Stugu 0.37.1 spatial read-path hardening

Stugu 0.37.1 is an application-only corrective release for the Raspberry Pi
appliance. It keeps the experimental spatial archive out of normal House-page
work and bounds the remaining opt-in reads.

## What changed

- Ordinary House summary, live-map, replay, and analytics views do not query the
  spatial archive.
- Spatial data starts loading only when the nested **Spatial Layer Lab** is
  opened and stops polling when the lab is closed. A timed inference session,
  once explicitly started, continues independently in the governed background.
- The lab's current-layer and health status share one current-snapshot lookup.
- Latest-run health lookups use a scope-, engine-, and start-time index, avoiding
  an API-thread scan and temporary sort across retained run history.

## Upgrade impact

First start creates one idempotent index over the spatial inference-run table.
The production-shaped archive measured for this release contains about 40,500
run rows; the index is approximately 4.5 MiB. No spatial jobs, snapshots,
configuration, raw data, or telemetry are removed. No inference session starts
automatically, and no signed host update is required.
