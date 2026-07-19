# Experimental spatial-layer engine

Stuga's spatial-layer engine is an optional, local-only research runtime. It
turns persisted environmental measurements into versioned semantic layers for
the house and property overviews. The same snapshot is rendered in the 2D plan,
the stacked 3D building view, and property-level views.

It is deliberately outside the telemetry core:

- canonical house/property geometry and sensor records are read from core
  SQLite through a read-only input port;
- raw history is read through the shared `HybridTelemetryReader`, which presents
  the SQLite hot buffer and Timescale archive as one logical telemetry source;
- experimental overlays/configuration, rolling state, jobs, model runs, ground
  truth, and derived snapshots live in `experimental-spatial-layers.sqlite`;
- the spatial database does not duplicate core Property/sensor masters or raw
  telemetry samples;
- derived values are never inserted as measurements and never enter alerts or
  actuator/control decisions;
- a disabled, slow, corrupt, or failing research engine cannot stop ingestion;
- the engine runs only as an optional local API component.

## Runtime flow

```text
core adapters -> core SQLite hot buffer -> checkpointed archive -> TimescaleDB
                    |                                             |
                    +---------- HybridTelemetryReader <-----------+
                    |                     |
        canonical topology               v
                    +------> read-only spatial input adapter
                                      |
                                      v
                         failure-isolated engine host
                    registry / scheduler / spatial SQLite
                                      |
                                      v
                       versioned spatial-layer snapshots
                         /              |             \
                    house 2D        house 3D      property views
```

The hybrid reader always consults SQLite, merges Timescale rows when the archive
is ready or synchronizing, and lets SQLite win natural-key overlaps. With local
retention disabled, an archive fault can fall back to the complete SQLite copy
without making the experimental engine a second telemetry store.

The measurement bus may wake the scheduler, but it is not the durable source of
work. A persisted watermark and bounded look-back make restarts and late samples
replayable.

## Layer catalogue

The initial engine registry contains:

- sensor-quality evidence;
- temperature, relative-humidity, absolute-humidity, and humidity-ratio zone
  layers;
- experimental, event-conditioned inter-zone climate-propagation evidence;
- research-grade sustained unexplained zone activity.

The Home renderer also has two opt-in, client-only preview adapters owned by this
experimental surface: the sensor-constrained air-movement estimate and the
sensor-support volume. They use core measurements through read-only client
inputs and do not write snapshots or derived measurements back into either
database. They are non-authoritative previews, distinct from stored backend
inference. Their toggles and legends are visually grouped with the research engine, never with
regular monitoring controls.

Propagation is not an airflow meter. It reports ordered evidence from distinct
temperature/humidity-ratio events on configured topology connections. It never
emits velocity, volume flow, or current air direction. Unexplained activity is
not a motion detector: it masks changes explained by propagation or configured
context and does not emit people trails, identities, or counts.

## Renderer-neutral snapshots

Engines return entity-keyed values rather than SVG paths, Three.js objects, or
animation speeds. A snapshot identifies its scope and coordinate-frame version,
then carries zone, connection, and point values with evidence scores, reason
codes, model/config versions, the input digest, inference window, quality, and
warnings. The web renderers map the same semantic snapshot onto floor polygons,
extruded room volumes, connection anchors, house footprints, and site points.

Backend style hints are limited to semantic direction, palette family, and
qualification. Decorative motion remains a client concern and must respect the
user's reduced-motion preference.

## Configuration and state

The spatial database holds immutable overlay/configuration versions,
effective-dated sensor-zone bindings and calibrations, context events, engine assignments,
ground-truth labels, durable jobs/checkpoints, model runs, and append-only
derived snapshot revisions. Canonical Properties, Homes, floor plans, sensors,
and raw samples remain in the shared core/telemetry stores and are referenced by
ID rather than copied here. A changed input digest supersedes an earlier
revision; the old revision remains auditable.

Each state partition includes the core SQLite database's persisted,
non-sensitive archive-source UUID and the active demo/live mode. Because that
identity travels with the core database, moving or renaming its file does not
disconnect existing spatial configuration, calibrations, or snapshots. On the
first upgraded start, rows using the former path-derived identity are re-keyed
in one spatial SQLite transaction. Demo and real namespaces remain separate.
If both the legacy and UUID target for the same mode contain state, migration
refuses to merge them and the optional spatial runtime stays unavailable until
the collision is resolved; neither partition is modified.

When the core database crosses its one-way demo-to-real boundary, the engine
switches partitions before serving or computing more snapshots. Demo state can
never be returned in real mode.

`RETENTION_DAYS=0` remains mandatory for the core SQLite telemetry buffer. The
shared reader makes regular raw-history and spatial measurement-window reads
archive-aware, but retention cannot be enabled until every remaining reader,
pagination/logical cursor, and per-family coverage watermark is archive-aware
and degraded old-range behavior is explicit. The separate
`SPATIAL_LAYERS_RETENTION_DAYS` setting applies only to derived operational
history (snapshots and completed model runs/jobs); it never deletes spatial
configuration, calibration, labels, core facts, or raw samples.

Relevant environment variables are:

```text
SPATIAL_LAYERS_ENABLED=true
SPATIAL_LAYERS_DATABASE_PATH=./data/experimental-spatial-layers.sqlite
SPATIAL_LAYERS_INTERVAL_MS=60000
SPATIAL_LAYERS_RETENTION_DAYS=30
```

## API and live delivery

The local v1 API exposes the engine catalogue, house/property current and
historical snapshots, model health, configuration, calibration, context and
ground-truth commands. A bounded SSE stream announces completed snapshot IDs;
clients fetch stored snapshots rather than receiving per-frame graphics.

All endpoints are optional-capability endpoints. A disabled engine reports an
explicit unavailable/disabled state instead of making the core house and
property pages fail.

## Scientific and safety boundary

Evidence strength and data quality are not probabilities. A probability is
exposed only if a named calibration artifact exists. Missing, stale, carried,
uncalibrated, or placement-risk data lowers quality or causes abstention.
House-wide events and configured HVAC, door/window, cooking, shower, sauna,
dehumidifier, solar, and persistent environmental-source contexts suppress
overconfident interpretations.

Research layers are display-only. They are not security, life-safety,
occupancy-counting, or unattended-control inputs.
