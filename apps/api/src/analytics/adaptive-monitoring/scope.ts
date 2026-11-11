import { randomUUID } from "node:crypto";
import {
  isAdaptivePromotionReceipt, adaptiveReferenceDeviceKey, ADAPTIVE_DEFAULTS, ADAPTIVE_METRICS, ADAPTIVE_MONITORING_VERSION,
  type AdaptiveSettings, type AdaptiveReferenceGroup, type AdaptiveSettingsPatch, type DataMode, type House, type Sensor,
} from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import type { AdaptiveStoredStream } from "./evidence.js";
import { adaptiveDigest, type AdaptiveMonitoringStore } from "./store.js";

export const adaptiveConfigurationDigest = () => adaptiveDigest([ADAPTIVE_MONITORING_VERSION, ADAPTIVE_DEFAULTS]);
function sensorMetrics(sensor: Sensor) {
  return new Set([...sensor.recordedMeasurementIds ?? [], ...Object.keys(sensor.measurementEntityIds ?? {}),
    ...(sensor.temperatureEntityId ? ["temperature"] : []), ...(sensor.humidityEntityId ? ["humidity"] : [])]);
}
function placement(sensor: Sensor) {
  return [sensor.houseId, sensor.floorId,
    sensor.roomId ?? sensor.room, sensor.x, sensor.y, sensor.z, sensor.model, sensor.enabled,
    sensor.tpLinkConnectionId, sensor.tpLinkDeviceId, sensor.temperatureEntityId, sensor.humidityEntityId,
    sensor.measurementEntityIds];
}
export function adaptiveFingerprint(sensor: Sensor, input: { house: House; settings: AdaptiveSettings; sensors: Sensor[] }): string {
  const { house, settings } = input;
  const peers = settings.referenceGroups.filter(g => g.sensorId === sensor.id).flatMap(g => g.peerIds).map(id => {
    const peer = input.sensors.find(s => s.id === id); return peer ? placement(peer) : null;
  });
  return adaptiveDigest([house.propertyId, house.location, house.timezone, placement(sensor), peers,
    settings.referenceGroups, settings.enabledAt, ADAPTIVE_MONITORING_VERSION]);
}
export function validateReferenceGroups(groups: AdaptiveReferenceGroup[], sensors: Sensor[]): void {
  const seen = new Set<string>();
  for (const group of groups) {
    const target = sensors.find(s => s.id === group.sensorId && s.enabled && sensorMetrics(s).has("temperature"));
    const peers = group.peerIds.map(id => sensors.find(s => s.id === id && s.enabled && sensorMetrics(s).has("temperature")));
    if (!target || peers.some(p => !p) || group.peerIds.includes(target.id) || new Set(group.peerIds).size !== group.peerIds.length
      || seen.has(target.id) || group.peerIds.length < (group.designatedReference ? 1 : 2)
      || (group.designatedReference && group.peerIds.length !== 1)) {
      throw new HttpError(422, "ADAPTIVE_REFERENCE_INVALID", "Choose independent enabled reference sensors in this Home");
    }
    const keys = [target, ...peers.filter((s): s is Sensor => Boolean(s))].map(adaptiveReferenceDeviceKey);
    if (keys.some(k => k === null) || new Set(keys).size !== keys.length) {
      throw new HttpError(422, "ADAPTIVE_REFERENCE_IDENTITY_UNKNOWN", "Reference sensors need distinct physical source bindings");
    }
    seen.add(target.id);
  }
}
export function assertPromotion(store: AdaptiveMonitoringStore, receiptId: string | null, mode: DataMode): void {
  const r = receiptId ? store.receipt(receiptId) : null;
  if (!isAdaptivePromotionReceipt(r) || r.algorithmVersion !== ADAPTIVE_MONITORING_VERSION || r.configurationDigest !== adaptiveConfigurationDigest()
    || r.dataMode !== mode || r.homeWeeks < 8 || r.homes < 3 || r.reviewedFraction < 0.8
    || r.falseEpisodesPerHomeWeek > 1 || r.baselineImprovement < 0.25 || r.recall < 0.8
    || r.scoredFraction < 0.8 || !r.resourceBudgetsPassed || !r.heatingActiveAndInactive
    || !r.capabilities.length || r.capabilities.some(c => c.reviewedEvents < 10)) {
    throw new HttpError(422, "ADAPTIVE_PROMOTION_UNQUALIFIED", "Prospective evaluation and appliance evidence are required before advisory use");
  }
}
export function patchAdaptiveSettings(store: AdaptiveMonitoringStore, input: {
  house: House; mode: DataMode; patch: AdaptiveSettingsPatch; actor: string; now: string;
}): AdaptiveSettings {
  const old = store.settings(input.house.id, input.mode);
  const next: AdaptiveSettings = { ...old, revision: old.revision + 1,
    mode: input.patch.mode ?? old.mode, referenceGroups: input.patch.referenceGroups ?? old.referenceGroups,
    promotionReceiptId: input.patch.promotionReceiptId ?? old.promotionReceiptId };
  validateReferenceGroups(next.referenceGroups, store.database.listSensors(input.house.id));
  if (next.mode === "advisory") assertPromotion(store, next.promotionReceiptId, input.mode);
  if (old.mode === "off" && next.mode !== "off") next.enabledAt = input.now;
  if (input.patch.resetBaseline && !store.database.getSensor(input.patch.resetBaseline.sensorId)) {
    throw new HttpError(404, "NOT_FOUND", "Sensor not found");
  }
  return store.database.transaction(() => {
    store.saveSettings(input.house.id, { mode: input.mode, settings: next, baseRevision: input.patch.baseRevision,
      actor: input.actor, now: input.now });
    if (input.patch.resetBaseline) {
      const affected = store.streams(input.house.id, input.mode).filter(s => s.stream.sensorId === input.patch.resetBaseline!.sensorId);
      if (!affected.length) throw new HttpError(422, "ADAPTIVE_RESET_SCOPE", "Choose a monitored sensor in this Home");
      for (const stream of affected) store.reset(stream, { mode: input.mode, fingerprint: stream.fingerprint, now: input.now });
      store.audit(input.house.id, { actor: input.actor, now: input.now, action: "baseline-reset", detail: input.patch.resetBaseline });
    }
    return next;
  });
}
type SynchronizeInput = { house: House; settings: AdaptiveSettings; mode: DataMode; now: string };
function sensorStreams(store: AdaptiveMonitoringStore, sensor: Sensor, input: SynchronizeInput & { sensors: Sensor[] }): AdaptiveStoredStream[] {
  const known = sensorMetrics(sensor);
  return ADAPTIVE_METRICS.filter(m => known.has(m)).flatMap(metric => {
    const kinds = metric === "temperature" && input.settings.referenceGroups.some(g => g.sensorId === sensor.id)
      ? ["climate-departure", "sensor-comparison"] as const : ["climate-departure"] as const;
    return kinds.map(kind => ({ houseId: input.house.id, fingerprint: adaptiveFingerprint(sensor, input),
      stream: { id: adaptiveDigest([store.database.telemetryArchiveSourceId(), input.mode, input.house.id, sensor.id, metric, kind]),
        sensorId: sensor.id, sensorName: sensor.name, floorId: sensor.floorId, room: sensor.room, metric, kind,
        epoch: randomUUID(), epochStartedAt: input.now, state: "collecting" as const, reason: "new-evidence-epoch",
        usableHours: 0, evaluatedThrough: null, evaluation: null },
      runtime: { selected: null, frozenAt: null, calibrationBefore: null, modelId: null } }));
  });
}
export function synchronizeAdaptiveStreams(store: AdaptiveMonitoringStore, input: SynchronizeInput): AdaptiveStoredStream[] {
  const existing = new Map(store.streams(input.house.id, input.mode).map(s => [s.stream.id, s]));
  const sensors = store.database.listSensors(input.house.id);
  const candidates = sensors.filter(s => s.enabled && !s.tags.includes("equipment:heat-pump"))
    .flatMap(s => sensorStreams(store, s, { ...input, sensors }));
  const result = candidates.map(candidate => {
    let stored = existing.get(candidate.stream.id) ?? candidate;
    if (stored.fingerprint !== candidate.fingerprint) {
      stored = store.reset(stored, { mode: input.mode, fingerprint: candidate.fingerprint, now: input.now });
    }
    stored.stream.sensorName = candidate.stream.sensorName;
    stored.stream.floorId = candidate.stream.floorId;
    stored.stream.room = candidate.stream.room;
    store.saveStream(stored, input.mode);
    existing.delete(stored.stream.id);
    return stored;
  });
  for (const removed of existing.values()) {
    store.expire(removed.stream.id, input.now);
    removed.stream.state = "disabled"; removed.stream.reason = "sensor-unavailable";
    store.saveStream(removed, input.mode);
  }
  return result;
}
