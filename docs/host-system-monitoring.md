# Host system monitoring

Owners and administrators can open **Advanced → System** to see whether the
Stugu host needs attention. The page summarizes host and Stugu API CPU use,
API event-loop responsiveness, load, memory, storage on the Stugu database
volume, service and host uptime, and CPU temperature when the operating system
exposes a thermal sensor.

The monitor is container-aware. When Linux cgroup limits are present, memory
use reflects the Stugu container's limit instead of the whole machine.
Storage reflects the filesystem that holds the configured Stugu database.

## Built-in alerts

Stugu presents only active conditions and removes them after recovery:

| Resource | Warning | Critical |
| --- | --- | --- |
| Host or Stugu API CPU | at least 85% for 5 minutes | at least 95% for 2 minutes |
| API event-loop p95 delay | at least 250 ms for 2 minutes | at least 1,000 ms for 30 seconds |
| Memory | at least 85% for 5 minutes | at least 95% for 2 minutes |
| Storage | at least 85% used or 5 GiB available | at least 95% used or 1 GiB available |
| Temperature | at least 75 °C for 2 minutes | at least 85 °C for 30 seconds |

Storage alerts are immediate because a full data volume can stop writes.
Sustained windows prevent brief CPU, API scheduling, memory, or temperature
spikes from becoming alerts. API process CPU is expressed as a percentage of
one logical core, so a saturated Node.js core remains visible on a multi-core
host. Active host alerts also appear on the workspace **Alerts** page for
Owners and Admins.

## Prometheus metrics

Prometheus-compatible metrics are available at:

```text
GET /api/v1/system/metrics
```

A signed-in Owner or Admin can open the endpoint. For an external collector,
configure `INGEST_API_KEY` and send it as either `X-API-Key` or a Bearer token.
That machine key can read this metrics endpoint and use the existing telemetry
ingestion endpoints; it cannot read the JSON health endpoint or other browser
APIs.

Example Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: stugu-host
    metrics_path: /api/v1/system/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials: YOUR_INGEST_API_KEY
    static_configs:
      - targets:
          - stugu.example.com
```

The endpoint exposes host and API process CPU use, load, event-loop p95 and
maximum delay, temperature when available, host or container memory, API
process memory, database-volume storage, uptime, sample freshness, combined
health state, and active built-in alert gauges. External alerting can use the
interpreted gauge directly:

```yaml
groups:
  - name: stugu-host
    rules:
      - alert: StuguHostNeedsAttention
        expr: stugu_host_alert_active == 1
        for: 1m
        annotations:
          summary: Stugu host needs attention

      - alert: StuguHostMetricsStale
        expr: time() - stugu_host_sample_timestamp_seconds > 180
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: Stugu host metrics are stale
```

Keep the machine key in the collector's secret store and do not place it in a
browser URL, dashboard, or repository.

The structured Owner/Admin endpoint at `GET /api/v1/system/health` is intended
for the Stugu UI and integrations that use an authenticated local session.
