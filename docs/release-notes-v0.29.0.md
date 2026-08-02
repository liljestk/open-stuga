# Stugu 0.29.0

Stugu 0.29.0 introduces lossless telemetry storage designed for years of
high-rate sensor data. Raw samples remain available at full granularity, while
normal charts and analytics use bounded, quality-aware rollups and caches.

## Highlights

- Lossless TimescaleDB raw history with compressed older chunks and smart
  1-minute, 5-minute, hourly, and daily retrieval.
- Reset-safe power and energy calculations without loading complete histories
  into Raspberry Pi memory.
- Raw browser export and keyset-paged archive retrieval when full detail is
  needed.
- System storage settings for managed storage, local SSD paths, and mounted NAS
  recovery storage.
- Storage-capacity forecasting, warning/critical alerts, recovery notices, and
  expanded Prometheus/database metrics.
- Restore-tested local and encrypted Cloudflare recovery sets with NAS mount
  sentinels and fail-closed capacity checks.

## Upgrade notes

The upgrade creates or repairs Timescale rollups and compression policies. It
does not delete or downsample raw telemetry. Keep PostgreSQL on local block/SSD
storage; use NAS for recovery sets. Any external path must already be mounted
and included in `STUGA_STORAGE_ALLOWED_ROOTS` before selecting it in System
settings. Storage moves are journaled, verified, and retain the previous source
for manual recovery.
