import { createHash, randomUUID } from "node:crypto";
import {
  isAdaptiveSettings, isAdaptiveStream, isAdaptiveFinding, ADAPTIVE_MONITORING_VERSION,
  type AdaptiveSettings, type AdaptiveFinding, type AdaptivePromotionReceipt,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";
import type { AdaptiveStoredStream, AdaptiveHour, AdaptiveStreamRuntime } from "./evidence.js";
import { DAY } from "./evidence.js";

export const adaptiveDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function defaultAdaptiveSettings(): AdaptiveSettings {
  return { revision: 0, mode: "off", enabledAt: null, referenceGroups: [], promotionReceiptId: null };
}
function parse<T>(text: string, guard: (v: unknown) => v is T): T {
  const value: unknown = JSON.parse(text);
  if (!guard(value)) throw new HttpError(503, "ADAPTIVE_STORE_INVALID", "Learning evidence could not be read");
  return value;
}
interface StreamRow { stream_json: string; runtime_json: string; house_id: string; fingerprint: string }
export class AdaptiveMonitoringStore {
  constructor(readonly database: ClimateDatabase) {}

  settings(houseId: string, mode: string): AdaptiveSettings {
    const row = this.database.db.prepare("SELECT settings_json FROM adaptive_settings WHERE house_id = ? AND data_mode = ?")
      .get(houseId, mode) as { settings_json: string } | undefined;
    return row ? parse(row.settings_json, isAdaptiveSettings) : defaultAdaptiveSettings();
  }
  settingsHomes(mode: string): string[] {
    return (this.database.db.prepare("SELECT house_id FROM adaptive_settings WHERE data_mode = ? ORDER BY house_id")
      .all(mode) as Array<{ house_id: string }>).map(r => r.house_id);
  }
  saveSettings(houseId: string, input: { mode: string; settings: AdaptiveSettings; baseRevision: number; actor: string; now: string }): void {
    this.database.transaction(() => {
      if (this.settings(houseId, input.mode).revision !== input.baseRevision) throw new HttpError(409, "ADAPTIVE_REVISION_CONFLICT", "Refresh the learning settings and retry");
      this.database.db.prepare(`INSERT INTO adaptive_settings(house_id,data_mode,revision,settings_json) VALUES(?,?,?,?)
        ON CONFLICT(house_id) DO UPDATE SET data_mode=excluded.data_mode,revision=excluded.revision,settings_json=excluded.settings_json`)
        .run(houseId, input.mode, input.settings.revision, JSON.stringify(input.settings));
      this.audit(houseId, { actor: input.actor, now: input.now, action: "settings", detail: input.settings });
    });
  }
  audit(houseId: string, input: { actor: string; now: string; action: string; detail: unknown }): void {
    this.database.db.prepare("INSERT INTO adaptive_audit(house_id,actor_id,recorded_at,action,detail_json) VALUES(?,?,?,?,?)")
      .run(houseId, input.actor, input.now, input.action, JSON.stringify(input.detail));
  }
  streams(houseId: string, mode: string): AdaptiveStoredStream[] {
    const rows = this.database.db.prepare("SELECT stream_json,runtime_json,house_id,fingerprint FROM adaptive_streams WHERE house_id=? AND data_mode=? ORDER BY id")
      .all(houseId, mode) as unknown as StreamRow[];
    return rows.map(r => ({ stream: parse(r.stream_json, isAdaptiveStream), houseId: r.house_id,
      fingerprint: r.fingerprint, runtime: JSON.parse(r.runtime_json) as AdaptiveStreamRuntime }));
  }
  saveStream(stored: AdaptiveStoredStream, mode: string): void {
    const s = stored.stream;
    this.database.db.prepare(`INSERT INTO adaptive_streams(id,house_id,sensor_id,data_mode,epoch,fingerprint,started_at,processed_at,stream_json,runtime_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,fingerprint=excluded.fingerprint,
      started_at=excluded.started_at,processed_at=excluded.processed_at,stream_json=excluded.stream_json,runtime_json=excluded.runtime_json`)
      .run(s.id, stored.houseId, s.sensorId, mode, s.epoch, stored.fingerprint, s.epochStartedAt, s.evaluatedThrough,
        JSON.stringify(s), JSON.stringify(stored.runtime));
  }
  reset(stored: AdaptiveStoredStream, input: { mode: string; fingerprint: string; now: string }): AdaptiveStoredStream {
    this.expire(stored.stream.id, input.now);
    const next: AdaptiveStoredStream = { ...stored, fingerprint: input.fingerprint,
      stream: { ...stored.stream, epoch: randomUUID(), epochStartedAt: input.now, state: "collecting",
        reason: "new-evidence-epoch", usableHours: 0, evaluatedThrough: null, evaluation: null },
      runtime: { selected: null, frozenAt: null, calibrationBefore: null, modelId: null } };
    this.saveStream(next, input.mode);
    return next;
  }
  hours(stored: AdaptiveStoredStream, now: number): AdaptiveHour[] {
    const rows = this.database.db.prepare(`SELECT evidence_json FROM adaptive_hours WHERE stream_id=? AND epoch=?
      AND observed_at >= ? ORDER BY observed_at LIMIT 2200`).all(stored.stream.id, stored.stream.epoch,
      new Date(Math.max(Date.parse(stored.stream.epochStartedAt), now - 90 * DAY)).toISOString()) as Array<{ evidence_json: string }>;
    return rows.map(r => JSON.parse(r.evidence_json) as AdaptiveHour);
  }
  saveHour(stored: AdaptiveStoredStream, hour: AdaptiveHour, pending = false): void {
    const update = pending ? "DO NOTHING" : "DO UPDATE SET available_at=excluded.available_at,evidence_json=excluded.evidence_json";
    this.database.db.prepare(`INSERT INTO adaptive_hours(stream_id,epoch,observed_at,available_at,evidence_json) VALUES(?,?,?,?,?)
      ON CONFLICT(stream_id,epoch,observed_at) ${update}`)
      .run(stored.stream.id, stored.stream.epoch, new Date(hour.time).toISOString(), new Date(hour.availableAt).toISOString(), JSON.stringify(hour));
  }
  claim(stored: AdaptiveStoredStream, input: { hour: number; revision: number; now: number }): string | null {
    const id = adaptiveDigest([stored.stream.id, stored.stream.epoch, input.hour]);
    return this.database.transaction(() => {
      const row = this.database.db.prepare("SELECT status,lease_until FROM adaptive_jobs WHERE id=?").get(id) as { status: string; lease_until: string } | undefined;
      if (row?.status === "succeeded" || (row?.status === "running" && Date.parse(row.lease_until) > input.now)) return null;
      this.database.db.prepare(`INSERT INTO adaptive_jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        status='running',settings_revision=excluded.settings_revision,lease_until=excluded.lease_until,updated_at=excluded.updated_at`)
        .run(id, stored.stream.id, stored.stream.epoch, input.revision, "running", new Date(input.now + 120_000).toISOString(), new Date(input.now).toISOString());
      return id;
    });
  }
  finishJob(id: string, status: "succeeded" | "failed", now: string): void {
    this.database.db.prepare("UPDATE adaptive_jobs SET status=?,updated_at=? WHERE id=?").run(status, now, id);
  }
  jobCurrent(id: string, epoch: string, revision: number): boolean {
    return Boolean(this.database.db.prepare("SELECT 1 FROM adaptive_jobs WHERE id=? AND epoch=? AND settings_revision=? AND status='running'")
      .get(id, epoch, revision));
  }
  saveModel(stored: AdaptiveStoredStream, detail: unknown, now: string): string {
    const id = adaptiveDigest([ADAPTIVE_MONITORING_VERSION, stored.stream.epoch, detail]);
    this.database.db.prepare("INSERT OR IGNORE INTO adaptive_models VALUES(?,?,?,?,?)")
      .run(id, stored.stream.id, stored.stream.epoch, now, JSON.stringify(detail));
    return id;
  }
  findings(houseId: string, mode: string): AdaptiveFinding[] {
    return (this.database.db.prepare("SELECT finding_json FROM adaptive_findings WHERE house_id=? AND data_mode=? ORDER BY id LIMIT 10001")
      .all(houseId, mode) as Array<{ finding_json: string }>).map(r => parse(r.finding_json, isAdaptiveFinding));
  }
  saveFinding(finding: AdaptiveFinding, streamId: string, mode: string): void {
    this.database.db.prepare(`INSERT INTO adaptive_findings VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at,finding_json=excluded.finding_json`)
      .run(finding.id, finding.houseId, streamId, mode, finding.epoch, finding.revision, finding.state, finding.recordedAt, JSON.stringify(finding));
    this.database.db.prepare("INSERT INTO adaptive_finding_revisions VALUES(?,?,?,?)")
      .run(finding.id, finding.revision, finding.recordedAt, JSON.stringify(finding));
  }
  expire(streamId: string, now: string): void {
    const rows = this.database.db.prepare("SELECT finding_json,data_mode FROM adaptive_findings WHERE stream_id=? AND state IN ('candidate','presented')")
      .all(streamId) as Array<{ finding_json: string; data_mode: string }>;
    for (const row of rows) {
      const f = parse(row.finding_json, isAdaptiveFinding);
      this.saveFinding({ ...f, revision: f.revision + 1, state: "expired", freshness: "stale", recordedAt: now }, streamId, row.data_mode);
    }
  }
  receipt(id: string): AdaptivePromotionReceipt | null {
    const row = this.database.db.prepare("SELECT receipt_json FROM adaptive_promotion_receipts WHERE id=?").get(id) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as AdaptivePromotionReceipt : null;
  }
  purgeOtherMode(mode: string): void {
    this.database.transaction(() => {
      this.database.db.prepare("DELETE FROM adaptive_audit WHERE house_id IN (SELECT house_id FROM adaptive_settings WHERE data_mode <> ?)").run(mode);
      for (const table of ["adaptive_findings", "adaptive_streams", "adaptive_settings"]) {
        this.database.db.prepare(`DELETE FROM ${table} WHERE data_mode <> ?`).run(mode);
      }
      this.database.db.exec("DELETE FROM adaptive_promotion_receipts");
    });
  }
  atCapacity(stored: AdaptiveStoredStream, mode: string): boolean {
    this.database.db.prepare(`DELETE FROM adaptive_models WHERE stream_id=? AND id NOT IN
      (SELECT json_extract(finding_json,'$.modelId') FROM adaptive_findings WHERE state IN ('candidate','presented'))
      AND id NOT IN (SELECT json_extract(runtime_json,'$.modelId') FROM adaptive_streams WHERE json_extract(runtime_json,'$.modelId') IS NOT NULL)
      AND id NOT IN (SELECT id FROM adaptive_models WHERE stream_id=? ORDER BY created_at DESC,id DESC LIMIT 127)`)
      .run(stored.stream.id, stored.stream.id);
    const models = Number((this.database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_models WHERE stream_id=?")
      .get(stored.stream.id) as { count: number }).count);
    const findings = Number((this.database.db.prepare("SELECT COUNT(*) AS count FROM adaptive_findings WHERE house_id=? AND data_mode=?")
      .get(stored.houseId, mode) as { count: number }).count);
    return models >= 128 || findings >= 10_000;
  }
  retain(now: number): void {
    this.database.transaction(() => {
      this.database.db.prepare(`DELETE FROM adaptive_findings WHERE state IN ('resolved','expired') AND updated_at < ?
        AND id NOT IN (SELECT finding_id FROM adaptive_reviews)`).run(new Date(now - 365 * DAY).toISOString());
      this.database.db.prepare("DELETE FROM adaptive_hours WHERE observed_at < ?").run(new Date(now - 90 * DAY).toISOString());
      this.database.db.prepare("DELETE FROM adaptive_jobs WHERE (status <> 'running' OR lease_until < ?) AND updated_at < ?")
        .run(new Date(now).toISOString(), new Date(now - 7 * DAY).toISOString());
      this.database.db.prepare(`DELETE FROM adaptive_models WHERE created_at < ? AND id NOT IN
        (SELECT json_extract(finding_json,'$.modelId') FROM adaptive_findings WHERE state IN ('candidate','presented'))
        AND id NOT IN (SELECT json_extract(runtime_json,'$.modelId') FROM adaptive_streams WHERE json_extract(runtime_json,'$.modelId') IS NOT NULL)`)
        .run(new Date(now - 365 * DAY).toISOString());
      this.database.db.prepare(`DELETE FROM adaptive_finding_revisions WHERE recorded_at < ? AND finding_id IN
        (SELECT id FROM adaptive_findings WHERE state IN ('resolved','expired'))`).run(new Date(now - 365 * DAY).toISOString());
    });
  }
}
