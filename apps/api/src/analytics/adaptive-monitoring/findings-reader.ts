import type {
  AdaptiveEvidencePurpose, AdaptiveFindingDetail, AdaptiveFindingRevision, AdaptiveFindingsPage, AdaptiveFindingState,
  AdaptiveMetric, AdaptiveSettingsScope, AdaptiveShadowFinding,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";

interface EpisodeRow {
  epoch_id: string;
  purpose: AdaptiveEvidencePurpose;
  property_id: string;
  sensor_id: string;
  metric: AdaptiveMetric;
  direction: "higher" | "lower";
  revision: number;
  state: AdaptiveFindingState;
  target_hour: number;
  recorded_at: number;
}

const EPOCH_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const EPISODE_ID = /^([a-f0-9-]+)\.(higher|lower)$/;
const revisionsFrom = `WITH revisions AS (
  SELECT e.id AS epoch_id, e.purpose, e.property_id, e.sensor_id, e.metric, r.direction, r.revision, r.state, r.target_hour, r.recorded_at
  FROM adaptive_evidence_epochs e JOIN adaptive_climate_episode_revisions r ON r.epoch_id = e.id
  WHERE e.house_id = ? AND e.data_mode = ?
  UNION ALL
  SELECT e.id, e.purpose, e.property_id, e.sensor_id, e.metric, r.direction, r.revision, r.state, r.target_hour, r.recorded_at
  FROM adaptive_evidence_epochs e JOIN adaptive_reference_episode_revisions r ON r.epoch_id = e.id
  WHERE e.house_id = ? AND e.data_mode = ?
)`;

interface PageOptions {
  actor: string;
  limit: number;
  cursor?: string;
  state?: AdaptiveFindingState;
  metric?: AdaptiveMetric;
  visible: (id: string) => boolean;
}

function invalidCursor(): HttpError {
  return new HttpError(400, "INVALID_ADAPTIVE_CURSOR", "Invalid Adaptive Home findings cursor");
}

function decodeCursor(raw: string | undefined, signature: string): string {
  if (!raw) return "";
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== signature
      || typeof value[1] !== "string" || !episodeParts(value[1])) throw invalidCursor();
    return value[1];
  } catch {
    throw invalidCursor();
  }
}

function episodeParts(id: string): [string, string] | null {
  const match = EPISODE_ID.exec(id);
  return match?.[1] && EPOCH_ID.test(match[1]) ? [match[1], match[2]!] : null;
}

function revision(row: EpisodeRow): AdaptiveFindingRevision {
  return {
    revision: row.revision, state: row.state,
    evidenceAt: new Date(row.target_hour).toISOString(), recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

function finding(database: ClimateDatabase, scope: AdaptiveSettingsScope, row: EpisodeRow): AdaptiveShadowFinding {
  const current = database.readAdaptiveEvidenceEpoch({ ...scope, sensorId: row.sensor_id, metric: row.metric, purpose: row.purpose });
  return {
    ...revision(row), id: `${row.epoch_id}.${row.direction}`, epochId: row.epoch_id, epochCurrent: current?.id === row.epoch_id,
    houseId: scope.houseId, propertyId: row.property_id, sensorId: row.sensor_id, kind: row.purpose, metric: row.metric,
    direction: row.direction, severity: "notice",
  };
}

export function adaptiveFindingsPage(database: ClimateDatabase, scope: AdaptiveSettingsScope, options: PageOptions): AdaptiveFindingsPage {
  return database.transaction(() => {
    const settings = database.adaptiveMonitoringSettings(scope);
    // Bind the cursor to the account, route scope, filters and current consent.
    const signature = JSON.stringify([options.actor, scope.houseId, scope.dataMode, settings.revision, options.state, options.metric]);
    const after = decodeCursor(options.cursor, signature);
    const rows = database.db.prepare(`${revisionsFrom}, latest AS (
        SELECT revisions.*, row_number() OVER (PARTITION BY epoch_id, direction ORDER BY revision DESC) AS sequence
        FROM revisions
      )
      SELECT * FROM latest WHERE sequence = 1 AND epoch_id || '.' || direction > ?
        AND (? IS NULL OR state = ?) AND (? IS NULL OR metric = ?)
      ORDER BY epoch_id, direction LIMIT ?`).all(
      scope.houseId, scope.dataMode, scope.houseId, scope.dataMode, after,
      options.state ?? null, options.state ?? null, options.metric ?? null, options.metric ?? null, options.limit + 1,
    ) as unknown as EpisodeRow[];
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.filter((row) => options.visible(row.sensor_id)).map((row) => finding(database, scope, row)),
      nextCursor: rows.length > options.limit && last
        ? Buffer.from(JSON.stringify([signature, `${last.epoch_id}.${last.direction}`])).toString("base64url") : null,
    };
  });
}

interface DetailOptions {
  id: string;
  before: number;
  limit: number;
  visible: (id: string) => boolean;
}

export function adaptiveFindingDetail(database: ClimateDatabase, scope: AdaptiveSettingsScope, options: DetailOptions): AdaptiveFindingDetail | null {
  return database.transaction(() => {
    database.adaptiveMonitoringSettings(scope);
    const parts = episodeParts(options.id);
    if (!parts) return null;
    const [epochId, direction] = parts;
    const parameters = [scope.houseId, scope.dataMode, scope.houseId, scope.dataMode, epochId, direction];
    const prefix = `${revisionsFrom} SELECT * FROM revisions WHERE epoch_id = ? AND direction = ?`;
    const latest = database.db.prepare(`${prefix} ORDER BY revision DESC LIMIT 1`).get(...parameters) as
      unknown as EpisodeRow | undefined;
    if (!latest || !options.visible(latest.sensor_id)) return null;
    const rows = database.db.prepare(`${prefix} AND revision < ? ORDER BY revision DESC LIMIT ?`)
      .all(...parameters, options.before, options.limit + 1) as unknown as EpisodeRow[];
    const items = rows.slice(0, options.limit).map(revision);
    return {
      finding: finding(database, scope, latest),
      revisions: { items, nextBeforeRevision: rows.length > options.limit ? items.at(-1)!.revision : null },
    };
  });
}
