# Stugu 0.39.1 responsive analytics and appliance diagnostics

Stugu 0.39.1 is an application-only corrective release for the Raspberry Pi
appliance. It removes avoidable analytics fan-out from Data & analytics, keeps
expensive detail work behind deliberate actions, and corrects the appliance
doctor's storage assessment.

## What changed

- Selected sensor history now loads through one cancellable, bounded analytics
  request backed by the existing Timescale rollups. Forecasts remain bounded,
  and abandoned browser requests stop consuming server capacity.
- Sensor and opening source tables load lazily, paginate their rows, and build
  CSV files only when requested, reducing initial CPU, memory, and response
  work on the appliance.
- Opening-history windows remain stable while a request is running, page
  refreshes no longer trigger an unnecessary Home Performance recomputation,
  and related API/live-connection failures appear as one recovery notice.
- The Raspberry Pi doctor measures the writable `/persistent` data volume when
  available. The immutable root slot can correctly report zero free space
  without creating a false storage-capacity failure.

## Upgrade impact

This patch changes application containers and repository diagnostics only.
Existing telemetry, databases, configuration, and durable analytics are
retained. There is no schema rewrite, signed host update, or factory-image
requirement.
