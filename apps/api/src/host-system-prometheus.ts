import type { HostSystemHealth } from "@climate-twin/contracts";

function metricLine(name: string, value: number | null): string[] {
  return value === null || !Number.isFinite(value) ? [] : [`${name} ${value}`];
}

function escapedLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function hostSystemPrometheusMetrics(health: HostSystemHealth): string {
  const lines = [
    "# HELP stugu_host_info Static information about the Stugu host.",
    "# TYPE stugu_host_info gauge",
    `stugu_host_info{platform="${escapedLabel(health.platform)}",architecture="${escapedLabel(health.architecture)}",release="${escapedLabel(health.release)}"} 1`,
    "# HELP stugu_host_cpu_usage_percent Host CPU time spent outside the idle state.",
    "# TYPE stugu_host_cpu_usage_percent gauge",
    ...metricLine("stugu_host_cpu_usage_percent", health.cpu.usagePercent),
    "# HELP stugu_process_cpu_usage_percent CPU used by the Stugu API process as a percentage of one logical core.",
    "# TYPE stugu_process_cpu_usage_percent gauge",
    ...metricLine("stugu_process_cpu_usage_percent", health.cpu.processUsagePercent),
    "# HELP stugu_host_load_average Host load average over one, five, and fifteen minutes.",
    "# TYPE stugu_host_load_average gauge",
    `stugu_host_load_average{window="1m"} ${health.cpu.loadAverage[0]}`,
    `stugu_host_load_average{window="5m"} ${health.cpu.loadAverage[1]}`,
    `stugu_host_load_average{window="15m"} ${health.cpu.loadAverage[2]}`,
    "# HELP stugu_host_cpu_temperature_celsius Host CPU thermal-zone temperature when available.",
    "# TYPE stugu_host_cpu_temperature_celsius gauge",
    ...metricLine("stugu_host_cpu_temperature_celsius", health.cpu.temperatureCelsius),
    "# HELP stugu_process_event_loop_delay_seconds Delay before the Stugu API event loop can run scheduled work.",
    "# TYPE stugu_process_event_loop_delay_seconds gauge",
    ...metricLine(
      'stugu_process_event_loop_delay_seconds{statistic="p95"}',
      health.cpu.eventLoop.p95Milliseconds === null ? null : health.cpu.eventLoop.p95Milliseconds / 1_000,
    ),
    ...metricLine(
      'stugu_process_event_loop_delay_seconds{statistic="max"}',
      health.cpu.eventLoop.maxMilliseconds === null ? null : health.cpu.eventLoop.maxMilliseconds / 1_000,
    ),
    "# HELP stugu_host_memory_bytes Host or container memory by state.",
    "# TYPE stugu_host_memory_bytes gauge",
    `stugu_host_memory_bytes{state="total",scope="${health.memory.scope}"} ${health.memory.totalBytes}`,
    `stugu_host_memory_bytes{state="used",scope="${health.memory.scope}"} ${health.memory.usedBytes}`,
    `stugu_host_memory_bytes{state="available",scope="${health.memory.scope}"} ${health.memory.availableBytes}`,
    "# HELP stugu_process_resident_memory_bytes Resident memory used by the Stugu API process.",
    "# TYPE stugu_process_resident_memory_bytes gauge",
    `stugu_process_resident_memory_bytes ${health.memory.processResidentBytes}`,
    "# HELP stugu_host_storage_bytes Stugu data-volume storage by state.",
    "# TYPE stugu_host_storage_bytes gauge",
    ...metricLine('stugu_host_storage_bytes{state="total"}', health.storage.totalBytes),
    ...metricLine('stugu_host_storage_bytes{state="used"}', health.storage.usedBytes),
    ...metricLine('stugu_host_storage_bytes{state="available"}', health.storage.availableBytes),
    "# HELP stugu_host_uptime_seconds Host uptime.",
    "# TYPE stugu_host_uptime_seconds gauge",
    `stugu_host_uptime_seconds ${health.hostUptimeSeconds}`,
    "# HELP stugu_service_uptime_seconds Stugu API process uptime.",
    "# TYPE stugu_service_uptime_seconds gauge",
    `stugu_service_uptime_seconds ${health.serviceUptimeSeconds}`,
    "# HELP stugu_host_alert_active Whether a sustained built-in host alert is active.",
    "# TYPE stugu_host_alert_active gauge",
  ];
  for (const metric of ["cpu", "event-loop", "memory", "storage", "temperature"] as const) {
    for (const severity of ["warning", "critical"] as const) {
      const active = health.alerts.some((alert) => alert.metric === metric && alert.severity === severity);
      lines.push(`stugu_host_alert_active{metric="${metric}",severity="${severity}"} ${active ? 1 : 0}`);
    }
  }
  lines.push(
    "# HELP stugu_host_health_state Current combined host-health state.",
    "# TYPE stugu_host_health_state gauge",
  );
  for (const state of ["healthy", "warning", "critical", "unknown"] as const) {
    lines.push(`stugu_host_health_state{state="${state}"} ${health.state === state ? 1 : 0}`);
  }
  lines.push(
    "# HELP stugu_host_sample_timestamp_seconds Unix timestamp of the sample.",
    "# TYPE stugu_host_sample_timestamp_seconds gauge",
    `stugu_host_sample_timestamp_seconds ${Date.parse(health.sampledAt) / 1_000}`,
  );
  return `${lines.join("\n")}\n`;
}
