import {
  ADAPTIVE_DEFAULTS, ADAPTIVE_MONITORING_VERSION, type AdaptiveSettingsPatch, type DataMode, type AdaptiveSettings, type AdaptiveKind,
  type AdaptiveSnapshot, type AdaptiveStream, type AdaptiveFinding, type AdaptiveReviewInput, type House,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { maximum, minimum } from "@climate-twin/analytics-kernel";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { HttpError } from "../../http-error.js";
import { runAdaptiveFitIsolated } from "../derived-artifacts/fit-isolate.js";
import { analyseAdaptiveHour } from "./policy.js";
import { AdaptiveMonitoringStore, adaptiveDigest } from "./store.js";
import { adaptiveFingerprint, patchAdaptiveSettings, synchronizeAdaptiveStreams } from "./scope.js";
import { readAdaptiveHour, comparablePeerValue } from "./hour-reader.js";
import { ownAdaptiveReview, reviewAdaptiveFinding } from "./reviews.js";
import { updateAdaptiveEpisode } from "./episodes.js";
import { HOUR, DAY, type AdaptiveStoredStream, type AdaptiveHour, type AdaptiveInputBudget } from "./evidence.js";

export interface AdaptiveServiceOptions {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  canTrain(houseId: string): boolean;
  now?: () => number;
  onError?: (error: unknown) => void;
}
export interface AdaptiveViewer { actor: string | null; admin: boolean; visibleSensor(id: string): boolean }
export class AdaptiveMonitoringService {
  readonly store: AdaptiveMonitoringStore;
  readonly now: () => number;
  constructor(readonly options: AdaptiveServiceOptions) {
    this.store = new AdaptiveMonitoringStore(options.database);
    this.now = options.now ?? Date.now;
  }
  activeMode(): DataMode { return this.options.database.isRealDataMode() ? "live" : "demo"; }
  assertMode(mode: DataMode): void {
    if (mode !== this.activeMode()) throw new HttpError(409, "ANALYTICS_DATA_MODE_MISMATCH", "Refresh this Home in the active data mode");
  }
  settings(houseId: string, body: AdaptiveSettingsPatch, actor: string): AdaptiveSettings {
    this.assertMode(body.dataMode);
    const house = this.options.database.getHouse(houseId);
    if (!house) throw new HttpError(404, "NOT_FOUND", "Home not found");
    if (!this.options.canTrain(houseId)) throw new HttpError(403, "ADAPTIVE_REMOTE_READ_ONLY", "Learning is owned by this Home's installation");
    const next = patchAdaptiveSettings(this.store, { house, mode: body.dataMode, patch: body, actor, now: new Date(this.now()).toISOString() });
    if (next.mode !== "off") synchronizeAdaptiveStreams(this.store, { house, mode: body.dataMode, settings: next, now: new Date(this.now()).toISOString() });
    return next;
  }
  invalidate(): void {
    const mode = this.activeMode();
    for (const id of this.store.settingsHomes(mode)) {
      const house = this.options.database.getHouse(id);
      const settings = this.store.settings(id, mode);
      if (house && settings.mode !== "off" && this.options.canTrain(id)) {
        synchronizeAdaptiveStreams(this.store, { house, settings, mode, now: new Date(this.now()).toISOString() });
      }
    }
  }
  streamsToProcess(): AdaptiveStoredStream[] {
    const mode = this.activeMode();
    const result: AdaptiveStoredStream[] = [];
    for (const id of this.store.settingsHomes(mode)) {
      const house = this.options.database.getHouse(id);
      const settings = this.store.settings(id, mode);
      if (!house || settings.mode === "off" || !this.options.canTrain(id)) continue;
      result.push(...synchronizeAdaptiveStreams(this.store, { house, settings, mode, now: new Date(this.now()).toISOString() }));
    }
    return result.sort((a, b) => a.stream.id.localeCompare(b.stream.id));
  }
  visibleStreams(house: House, mode: DataMode, viewer: AdaptiveViewer): AdaptiveStream[] {
    const settings = this.store.settings(house.id, mode);
    if (!viewer.admin && settings.mode !== "advisory") return [];
    const sensors = this.options.database.listSensors(house.id);
    const now = this.now();
    return this.store.streams(house.id, mode).filter(s => viewer.visibleSensor(s.stream.sensorId)).map(s => {
      const sensor = this.options.database.getSensor(s.stream.sensorId);
      const current = sensor && s.fingerprint === adaptiveFingerprint(sensor, { house, settings, sensors });
      const references = settings.referenceGroups.find(g => g.sensorId === s.stream.sensorId);
      const peersVisible = !references || references.peerIds.every(viewer.visibleSensor);
      if (!current || !peersVisible) return { ...s.stream, state: "collecting" as const, reason: "scope-changed", evaluation: null };
      if (settings.mode === "off") return { ...s.stream, state: "disabled" as const, reason: "disabled" };
      const stale = s.stream.evaluatedThrough && now - Date.parse(s.stream.evaluatedThrough) > 3 * HOUR;
      return { ...s.stream, ...(stale ? { state: "stale" as const, reason: "evidence-delayed" } : {}),
        evaluation: viewer.admin ? s.stream.evaluation : null };
    });
  }
  visibleFindings(house: House, mode: DataMode, viewer: AdaptiveViewer): AdaptiveFinding[] {
    const settings = this.store.settings(house.id, mode);
    if (settings.mode === "off") return [];
    const streams = new Map(this.visibleStreams(house, mode, viewer).map(s => [s.id, s]));
    const epochs = new Map([...streams.values()].map(s => [JSON.stringify([s.sensorId, s.kind, s.metric]), s]));
    return this.store.findings(house.id, mode).filter(f => {
      const stream = epochs.get(JSON.stringify([f.sensorId, f.kind, f.metric]));
      return stream && stream.reason !== "scope-changed" && viewer.visibleSensor(f.sensorId)
        && f.sourceIds.every(viewer.visibleSensor) && (viewer.admin || f.state !== "candidate")
        && (viewer.admin || settings.mode === "advisory");
    }).map(f => ownAdaptiveReview(this.store, { ...f, freshness: this.now() - Date.parse(f.lastEvidenceAt) > 3 * HOUR ? "stale" : f.freshness }, viewer.admin ? viewer.actor : null));
  }
  snapshot(house: House, input: { mode: DataMode; viewer: AdaptiveViewer; kind?: AdaptiveKind | undefined; streamCursor?: string | undefined; findingCursor?: string | undefined }): AdaptiveSnapshot {
    this.assertMode(input.mode);
    const settings = this.store.settings(house.id, input.mode);
    const streams = this.visibleStreams(house, input.mode, input.viewer).filter(s => !input.kind || s.kind === input.kind);
    const findings = this.visibleFindings(house, input.mode, input.viewer).filter(f => !input.kind || f.kind === input.kind);
    const times = streams.flatMap(s => s.evaluatedThrough ? [s.evaluatedThrough] : []).sort();
    const evaluatedThrough = times[0] ?? null;
    const ready = streams.filter(s => s.state === "ready").length;
    const state = adaptiveSnapshotState(settings, streams);
    const now = new Date(this.now()).toISOString();
    const identity = adaptiveDigest([settings, streams, findings.map(f => [f.id, f.revision]), input.viewer.actor]);
    const binding = [house.id, input.mode, input.kind, identity];
    return { apiVersion: "1.0", dataMode: input.mode, houseId: house.id, generatedAt: now,
      evaluatedAt: evaluatedThrough ?? now, evaluatedThrough, completeness: ready === streams.length && streams.length > 0 ? "complete" : "partial",
      warnings: state === "ready" || state === "disabled" ? [] : [{ code: "ADAPTIVE_MONITORING_INCOMPLETE", message: "Learning evidence is incomplete" }],
      provenance: { algorithmKey: "adaptive-monitoring", algorithmVersion: ADAPTIVE_MONITORING_VERSION, evaluatedAt: now,
        sourceIds: [...new Set(streams.map(s => s.sensorId))] },
      settings: input.viewer.admin ? settings : { ...settings, referenceGroups: [], promotionReceiptId: null }, state,
      reason: settings.mode === "off" ? "disabled" : !streams.length ? "no-supported-streams" : state,
      streams: adaptivePage(streams, { cursor: input.streamCursor, binding: [...binding, "streams"], limit: 50 }),
      findings: adaptivePage(findings, { cursor: input.findingCursor, binding: [...binding, "findings"], limit: 50, key: adaptiveFindingKey }),
      counts: { streams: streams.length, ready, findings: findings.length } };
  }
  review(house: House, input: { id: string; body: AdaptiveReviewInput; actor: string }): AdaptiveFinding {
    this.assertMode(input.body.dataMode);
    if (!this.options.canTrain(house.id)) throw new HttpError(403, "ADAPTIVE_REMOTE_READ_ONLY", "Learning evidence is read-only");
    const finding = this.store.findings(house.id, input.body.dataMode).find(f => f.id === input.id);
    const stream = this.store.streams(house.id, input.body.dataMode).find(s => s.stream.epoch === finding?.epoch && s.stream.sensorId === finding?.sensorId
      && s.stream.kind === finding.kind && s.stream.metric === finding.metric);
    if (!finding || !stream) throw new HttpError(404, "NOT_FOUND", "Finding not found");
    return reviewAdaptiveFinding(this.store, { finding, streamId: stream.stream.id, mode: input.body.dataMode,
      actor: input.actor, now: new Date(this.now()).toISOString(), body: input.body });
  }
  async process(stored: AdaptiveStoredStream, signal: AbortSignal, budget: AdaptiveInputBudget = { remaining: ADAPTIVE_DEFAULTS.maximumInputSamples }): Promise<void> {
    const now = this.now();
    const mode = this.activeMode();
    const house = this.options.database.getHouse(stored.houseId);
    const settings = this.store.settings(stored.houseId, mode);
    const end = Math.floor((now - 5 * 60_000) / HOUR) * HOUR;
    if (!house || settings.mode === "off" || !this.options.canTrain(house.id) || end - HOUR < Date.parse(stored.stream.epochStartedAt)
      || (stored.stream.evaluatedThrough && Date.parse(stored.stream.evaluatedThrough) >= end)) return;
    if (stored.stream.kind === "sensor-comparison" && !this.peerEvidence(stored, end).ready) return;
    const id = this.store.claim(stored, { hour: end, revision: settings.revision, now });
    if (!id) return;
    if (this.store.atCapacity(stored, mode)) {
      stored.stream.state = "paused"; stored.stream.reason = "storage-budget";
      this.store.saveStream(stored, mode);
      this.store.finishJob(id, "failed", new Date(now).toISOString());
      return;
    }
    try {
      await this.compute(stored, { house, mode, settings, end, now, signal, id, budget });
    } catch (e) {
      this.store.finishJob(id, "failed", new Date(this.now()).toISOString());
      if (signal.aborted) throw e;
      this.processingFailed(stored, { mode, settings, error: e });
    }
  }
  private processingFailed(stored: AdaptiveStoredStream, input: { mode: DataMode; settings: AdaptiveSettings; error: unknown }): void {
    const status = input.error instanceof HttpError && input.error.code === "ADAPTIVE_INPUT_LIMIT"
      ? { state: "paused" as const, reason: "input-budget" } : { state: "failed" as const, reason: "processing-failed" };
    const next = { ...stored, stream: { ...stored.stream, ...status } };
    const current = this.store.streams(stored.houseId, input.mode).find(s => s.stream.id === stored.stream.id);
    if (this.store.settings(stored.houseId, input.mode).revision === input.settings.revision && current?.stream.epoch === stored.stream.epoch
      && current.fingerprint === stored.fingerprint) this.store.saveStream(next, input.mode);
    if (status.state === "failed") this.options.onError?.(input.error);
  }
  private async compute(stored: AdaptiveStoredStream, input: {
    house: House; mode: DataMode; settings: AdaptiveSettings; end: number; now: number; signal: AbortSignal; id: string; budget: AdaptiveInputBudget;
  }): Promise<void> {
    const hours = this.store.hours(stored, input.now);
    const pending = hours.find(h => h.time === input.end);
    const current = await readAdaptiveHour(this.options, { stored, house: input.house, mode: input.mode,
      end: input.end, now: input.now, signal: input.signal, budget: input.budget });
    current.predictions = pending?.predictions ?? {};
    current.persistence = pending?.persistence ?? null;
    current.seasonal = pending?.seasonal ?? null;
    if (stored.stream.kind === "sensor-comparison") {
      const peers = this.peerEvidence(stored, input.end);
      current.peer = peers.value; current.peerSpread = peers.spread;
    }
    const past = hours.filter(h => h.time < input.end);
    const analysis = analyseAdaptiveHour(stored, { hours: past, current });
    const all = [...past, analysis.hour];
    const predictions = stored.stream.kind === "climate-departure" ? await runAdaptiveFitIsolated({
      metric: stored.stream.metric, hours: all, until: input.now, frozenAt: analysis.runtime.frozenAt,
      anchorBefore: analysis.runtime.calibrationBefore, targetTime: input.end + HOUR }, input.signal) : {};
    input.signal.throwIfAborted();
    const nextHour: AdaptiveHour = { ...current, time: input.end + HOUR, availableAt: input.now, value: null,
      predictions, persistence: current.value, seasonal: all.find(h => h.time === input.end + HOUR - DAY)?.value ?? null,
      score: null, excluded: false };
    this.options.database.transaction(() => {
      this.assertPublishable(stored, input);
      const candidate = analysis.hour.predictions[analysis.selected ?? "daily-profile"];
      if (candidate) analysis.runtime.modelId = this.store.saveModel(stored, {
        algorithmVersion: ADAPTIVE_MONITORING_VERSION, family: analysis.selected,
        cutoff: candidate.cutoff, parameters: candidate.parameters,
        inputDigest: adaptiveDigest(all.filter(h => h.time <= candidate.cutoff && h.time >= candidate.cutoff - 14 * DAY)
          .map(h => ({ time: h.time, value: h.value, outdoor: h.outdoor, guarded: h.guarded, availableAt: h.availableAt }))),
        sourceId: this.options.database.telemetryArchiveSourceId() }, new Date(input.now).toISOString());
      if (stored.stream.kind === "sensor-comparison" && analysis.runtime.referenceBaseline && !analysis.runtime.modelId) {
        const baseline = all.filter(h => h.time < Date.parse(stored.stream.epochStartedAt) + 14 * DAY && !h.guarded && h.value !== null && h.peer !== null);
        analysis.runtime.modelId = this.store.saveModel(stored, { algorithmVersion: ADAPTIVE_MONITORING_VERSION,
          family: "reference-offset", baselineDigest: adaptiveDigest(baseline), parameters: analysis.runtime.referenceBaseline,
          sourceId: this.options.database.telemetryArchiveSourceId() }, new Date(input.now).toISOString());
      }
      this.store.saveHour(stored, analysis.hour);
      this.store.saveHour(stored, nextHour, true);
      const next: AdaptiveStoredStream = { ...stored, runtime: analysis.runtime, stream: { ...stored.stream,
        evaluatedThrough: new Date(input.end).toISOString(), state: analysis.state, reason: analysis.reason,
        usableHours: all.filter(h => h.value !== null && !h.guarded).length, evaluation: analysis.evaluation } };
      this.store.saveStream(next, input.mode);
      updateAdaptiveEpisode(this.store, { stored: next, analysis, house: input.house, settings: input.settings, mode: input.mode, now: input.now });
      this.store.finishJob(input.id, "succeeded", new Date(input.now).toISOString());
    });
  }
  private peerEvidence(stored: AdaptiveStoredStream, end: number): { ready: boolean; value: number | null; spread: number | null } {
    const absent = { ready: true, value: null, spread: null };
    const mode = this.activeMode();
    const group = this.store.settings(stored.houseId, mode).referenceGroups.find(g => g.sensorId === stored.stream.sensorId);
    if (!group) return absent;
    const streams = this.store.streams(stored.houseId, mode).filter(s => s.stream.kind === "climate-departure" && s.stream.metric === "temperature");
    const peers = group.peerIds.map(id => streams.find(s => s.stream.sensorId === id));
    if (peers.some(p => !p)) return absent;
    if (peers.some(p => !p?.stream.evaluatedThrough || Date.parse(p.stream.evaluatedThrough) < end)) return { ...absent, ready: false };
    const values = peers.map(p => this.store.hours(p!, end).find(h => h.time === end)?.value ?? null);
    if (values.some(v => v === null)) return absent;
    const baseline = this.store.hours(stored, end).filter(h => !h.guarded && h.time < Date.parse(stored.stream.epochStartedAt) + 14 * DAY)
      .flatMap(h => h.peerSpread == null ? [] : [h.peerSpread]);
    const numbers = values as number[];
    return { ready: true, value: comparablePeerValue(numbers, stored.runtime.referenceBaseline ? [stored.runtime.referenceBaseline.peerSpread] : baseline),
      spread: maximum(numbers)! - minimum(numbers)! };
  }
  private assertPublishable(stored: AdaptiveStoredStream, input: {
    house: House; mode: DataMode; settings: AdaptiveSettings; id: string; signal: AbortSignal;
  }): void {
    input.signal.throwIfAborted();
    const currentHouse = this.options.database.getHouse(stored.houseId);
    const sensor = this.options.database.getSensor(stored.stream.sensorId);
    const settings = this.store.settings(stored.houseId, input.mode);
    const stream = this.store.streams(stored.houseId, input.mode).find(s => s.stream.id === stored.stream.id);
    if (this.activeMode() !== input.mode || !currentHouse || !sensor || !this.options.canTrain(stored.houseId)
      || settings.mode === "off" || settings.revision !== input.settings.revision || stream?.stream.epoch !== stored.stream.epoch
      || adaptiveFingerprint(sensor, { house: currentHouse, settings, sensors: this.options.database.listSensors(currentHouse.id) }) !== stored.fingerprint
      || !this.store.jobCurrent(input.id, stored.stream.epoch, settings.revision)) {
      throw new HttpError(409, "ADAPTIVE_PUBLICATION_FENCED", "Learning evidence changed while the job was running");
    }
  }
}
export function adaptiveFindingKey(finding: AdaptiveFinding): string {
  return `${String(8_640_000_000_000_000 - Date.parse(finding.lastEvidenceAt)).padStart(16, "0")}:${finding.id}`;
}
export function adaptiveCursorAfter(input: { cursor?: string | undefined; binding: unknown[] }): string {
  const binding = adaptiveDigest(input.binding);
  let after = "";
  if (input.cursor) {
    try {
      const v: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (!v || typeof v !== "object" || !("binding" in v) || v.binding !== binding || !("after" in v) || typeof v.after !== "string") throw new Error();
      after = v.after;
    } catch { throw new HttpError(409, "ADAPTIVE_CURSOR_CONFLICT", "Refresh this list to continue"); }
  }
  return after;
}
export function adaptivePage<T extends { id: string }>(items: T[], input: {
  cursor?: string | undefined; binding: unknown[]; limit: number; key?: (item: T) => string;
}) {
  const after = adaptiveCursorAfter(input);
  const binding = adaptiveDigest(input.binding);
  const key = input.key ?? ((item: T) => item.id);
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b))).filter(i => !after || key(i).localeCompare(after) > 0);
  const page = sorted.slice(0, input.limit);
  return { items: page, nextCursor: sorted.length > input.limit ? Buffer.from(JSON.stringify({ binding, after: key(page.at(-1)!) })).toString("base64url") : null };
}

function adaptiveSnapshotState(settings: AdaptiveSettings, streams: AdaptiveStream[]): AdaptiveSnapshot["state"] {
  if (settings.mode === "off") return "disabled";
  if (!streams.length) return "collecting";
  if (streams.every(s => s.state === "ready")) return "ready";
  for (const state of ["failed", "paused", "stale"] as const) if (streams.some(s => s.state === state)) return state;
  return "collecting";
}
