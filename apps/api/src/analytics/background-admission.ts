import type { HostSystemHealth } from "@climate-twin/contracts";

/**
 * Conservative appliance gate for optional CPU/database work. It is evaluated
 * when the shared low-priority lease reaches the front of the queue, not when
 * the job was originally scheduled.
 */
export function hostAllowsBackgroundWork(health: HostSystemHealth): boolean {
  if (health.cpu.state !== "healthy" || health.cpu.eventLoop.state !== "healthy") return false;
  if (health.memory.state !== "healthy" || health.storage.state !== "healthy"
    || health.database.state !== "healthy") return false;
  if (health.cpu.processUsagePercent !== null && health.cpu.processUsagePercent >= 50) return false;
  if (health.cpu.usagePercent !== null && health.cpu.usagePercent >= 70) return false;
  const telemetry = health.database.telemetry;
  if (telemetry.enabled && telemetry.state !== "healthy") return false;
  if ((telemetry.pool?.waiting ?? 0) > 0 || (telemetry.queries?.active ?? 0) > 0) return false;
  return true;
}
