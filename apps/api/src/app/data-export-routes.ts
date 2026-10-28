import { withResponseSignal } from "./response-signal.js";
import type { DataExportPrivacyLevel } from "@climate-twin/contracts";
import { HttpError } from "../http-error.js";
import { enumValue } from "../request-fields.js";
import { requireWorkspaceAdmin } from "./support/local-sessions.js";
import type { ClimateDatabase } from "../db.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** On-demand data exports and database backups. */
export function registerDataExportRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/data-export/preview`, requireWorkspaceAdmin, async (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel");
      const includeTelemetry = request.query.includeTelemetry === "true";
      const preview = await withResponseSignal(response, signal => context.dataOperations.preview(privacyLevel, includeTelemetry, signal));
      response.json({ preview });
    });
  context.app.get(`${context.prefix}/data-export`, requireWorkspaceAdmin, async (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel") as DataExportPrivacyLevel;
      const includeTelemetry = request.query.includeTelemetry === "true";
      if (includeTelemetry && context.telemetryArchive) {
        throw new HttpError(409, "ARCHIVE_EXPORT_REQUIRES_BACKUP", "A raw telemetry JSON export is unavailable after SQLite hot retention; use a verified backup, which includes both SQLite and TimescaleDB");
      }
      const generatedAt = new Date().toISOString();
      const preview = await withResponseSignal(response, signal => context.dataOperations.preview(privacyLevel, includeTelemetry, signal));
      const controlPlane = context.dataOperations.bundle(privacyLevel);
      context.dataOperations.audit("export.started", { privacyLevel, includeTelemetry });
      response.status(200);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="stugu-export-${generatedAt.replace(/[:.]/g, "-")}.json"`);
      response.setHeader("cache-control", "no-store");
      response.flushHeaders();
      const write = async (chunk: string): Promise<boolean> => {
        if (response.destroyed || request.destroyed) return false;
        if (response.write(chunk)) return true;
        await new Promise<void>((resolve) => response.once("drain", resolve));
        return !response.destroyed && !request.destroyed;
      };
      const head = JSON.stringify({
        schemaVersion: "stugu.export/v1",
        generatedAt,
        privacyLevel,
        includesTelemetry: includeTelemetry,
        privacyPreview: preview,
        data: controlPlane,
      });
      if (!includeTelemetry) {
        response.end(head);
        context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
        return;
      }
      if (!await write(`${head.slice(0, -1)},"telemetry":{`)) return;
      if (!await writeTelemetryTables(context.database, write)) return;
      response.end("}}");
      context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
    });
  context.app.get(`${context.prefix}/backups/status`, requireWorkspaceAdmin, (_request, response) => {
      response.json({ backup: context.dataOperations.backupStatus() });
    });
  context.app.post(`${context.prefix}/backups`, requireWorkspaceAdmin, (_request, response) => {
      response.status(202).json({ backup: context.dataOperations.requestBackup() });
    });
}

const EXPORTED_TELEMETRY_TABLES = [
  "measurement_samples",
  "readings",
  "outdoor_temperature_samples",
  "electricity_price_points",
  "heat_pump_state_history",
] as const;

/**
 * Streams each telemetry table as a `"table":[rows]` member of the open
 * telemetry object. Returns false as soon as the client goes away.
 */
async function writeTelemetryTables(database: ClimateDatabase, write: (chunk: string) => Promise<boolean>): Promise<boolean> {
  for (const [tableIndex, table] of EXPORTED_TELEMETRY_TABLES.entries()) {
    if (!await write(`${tableIndex === 0 ? "" : ","}${JSON.stringify(table)}:[`)) return false;
    let first = true;
    for (const row of database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
      if (!await write(`${first ? "" : ","}${JSON.stringify(row)}`)) return false;
      first = false;
    }
    if (!await write("]")) return false;
  }
  return true;
}
