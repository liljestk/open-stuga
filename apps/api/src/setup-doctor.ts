import type { SensorLabelDescriptor, SetupDoctorCheck, SetupDoctorReport } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import type { DataOperationsService } from "./data-operations.js";
import type { RuntimeStatus } from "./services.js";
import type { TelemetryArchiveWorker } from "./timeseries/archive-worker.js";

export class SetupDoctor {
  constructor(
    private readonly database: ClimateDatabase,
    private readonly config: AppConfig,
    private readonly runtimeStatus: RuntimeStatus,
    private readonly dataOperations: DataOperationsService,
    private readonly archive: TelemetryArchiveWorker | null,
  ) {}

  report(now = new Date()): SetupDoctorReport {
    const checks: SetupDoctorCheck[] = [];
    const integrity = this.database.db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    const foreignKeys = this.database.db.prepare("PRAGMA foreign_key_check").all();
    checks.push({ id: "sqlite-integrity", category: "storage", status: integrity.every((row) => row.quick_check === "ok") && foreignKeys.length === 0 ? "pass" : "fail",
      title: "Control database integrity", detail: foreignKeys.length === 0 ? "SQLite integrity and foreign-key checks pass." : `${foreignKeys.length} foreign-key issue(s) need repair.`, action: foreignKeys.length ? "Restore from a verified backup or inspect the integrity runbook." : null });
    const archive = this.archive?.status();
    checks.push({ id: "timescale-archive", category: "telemetry", status: !this.config.timeseriesEnabled ? "not-applicable" : archive?.phase === "ready" && archive.caughtUp ? "pass" : "warning",
      title: "Long-term telemetry archive", detail: !this.config.timeseriesEnabled ? "TimescaleDB is disabled." : archive?.caughtUp ? "TimescaleDB is ready and caught up." : `Archive state: ${archive?.phase ?? "starting"}.`,
      action: this.config.timeseriesEnabled && !archive?.caughtUp ? "Check archive diagnostics and database connectivity." : null });
    const sensors = this.database.listSensors().filter((sensor) => sensor.enabled);
    const latest = this.database.latestMeasurementSamples();
    const freshSensorIds = new Set(latest.filter((sample) => now.getTime() - Date.parse(sample.timestamp) <= 15 * 60_000 && sample.quality !== "stale").map((sample) => sample.sensorId));
    checks.push({ id: "sensor-coverage", category: "sensors", status: sensors.length === 0 ? "fail" : freshSensorIds.size === sensors.length ? "pass" : "warning",
      title: "Sensor coverage", detail: `${freshSensorIds.size} of ${sensors.length} enabled sensors have fresh measurements.`,
      action: sensors.length === 0 ? "Add or discover at least one sensor." : freshSensorIds.size < sensors.length ? "Inspect stale sensors and their integration connection." : null });
    const unbound = sensors.filter((sensor) => Object.keys(sensor.measurementEntityIds ?? {}).length === 0 && !sensor.tpLinkDeviceId);
    checks.push({ id: "sensor-bindings", category: "sensors", status: unbound.length === 0 ? "pass" : "warning",
      title: "Entity and device mapping", detail: unbound.length ? `${unbound.length} sensor(s) have no saved live-data binding.` : "Every enabled sensor has a live-data binding.",
      action: unbound.length ? "Use the bulk mapping assistant to connect the remaining sensors." : null });
    const integration = this.runtimeStatus.value;
    const configured = integration.homeAssistant.configured || integration.tpLink.configured;
    checks.push({ id: "integration", category: "integration", status: configured ? "pass" : "warning", title: "Live integration",
      detail: configured ? "At least one Home Assistant or TP-Link connection is configured." : "No live Home Assistant or TP-Link connection is configured.",
      action: configured ? null : "Run guided integration setup." });
    const notificationsConfigured = Boolean(this.config.alertWebhookUrl || (this.config.telegramBotToken && this.config.telegramChatId));
    checks.push({ id: "notification-route", category: "notifications", status: notificationsConfigured ? "pass" : "warning",
      title: "Notification route", detail: notificationsConfigured ? "At least one outbound notification route is configured." : "No outbound alert destination is configured.",
      action: notificationsConfigured ? null : "Configure Telegram or a signed webhook." });
    if (this.config.alertWebhookUrl) checks.push({ id: "webhook-signing", category: "security", status: this.config.alertWebhookSigningSecret ? "pass" : "warning",
      title: "Webhook signing", detail: this.config.alertWebhookSigningSecret ? "Webhook requests are signed with HMAC-SHA256." : "Webhook signing is not configured.",
      action: this.config.alertWebhookSigningSecret ? null : "Set a 32-byte ALERT_WEBHOOK_SIGNING_SECRET." });
    const backup = this.dataOperations.backupStatus();
    const recentBackup = backup.latestVerifiedBackupAt && now.getTime() - Date.parse(backup.latestVerifiedBackupAt) < 48 * 3_600_000;
    checks.push({ id: "backup", category: "recovery", status: recentBackup ? "pass" : "warning", title: "Verified backup",
      detail: backup.latestVerifiedBackupAt ? `Latest verified backup: ${backup.latestVerifiedBackupAt}.` : "No verified backup is recorded.",
      action: recentBackup ? null : "Run a backup and verify the result." });
    const recentDrill = backup.latestRestoreDrillAt && now.getTime() - Date.parse(backup.latestRestoreDrillAt) < 45 * 86_400_000;
    checks.push({ id: "restore-drill", category: "recovery", status: recentDrill ? "pass" : "warning", title: "Restore drill",
      detail: backup.latestRestoreDrillAt ? `Latest isolated restore drill: ${backup.latestRestoreDrillAt}.` : "No isolated restore drill is recorded.",
      action: recentDrill ? null : "Keep the backup scheduler running so it can perform an isolated restore drill." });
    const overall = checks.some((check) => check.status === "fail") ? "blocked"
      : checks.some((check) => check.status === "warning") ? "attention" : "ready";
    return { generatedAt: now.toISOString(), overall, checks };
  }

  sensorLabel(sensorId: string): SensorLabelDescriptor | null {
    const sensor = this.database.getSensor(sensorId);
    if (!sensor) return null;
    const house = this.database.getHouse(sensor.houseId);
    if (!house) return null;
    return {
      sensorId: sensor.id,
      sensorName: sensor.name,
      houseName: house.name,
      roomName: sensor.room || null,
      setupUri: `stuga://sensor/${encodeURIComponent(sensor.id)}?house=${encodeURIComponent(house.id)}`,
    };
  }
}
