import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DataMode,
  EquipmentLocationEstimate,
  TrackingEvent,
  TrackingEventType,
  TrackingGatewayRollupInput,
  TrackingObservation,
  TrackingObservationInput,
  TrackingObservationQualityFlag,
  TrackingObserverType,
} from "@climate-twin/contracts";
import { parseJson } from "./store-support.js";

interface ObservationRow {
  id: string;
  data_mode: DataMode;
  tenant_id: string;
  property_id: string;
  endpoint_id: string;
  equipment_id: string;
  binding_id: string;
  observer_id: string;
  observer_type: TrackingObserverType;
  observed_at: string;
  received_at: string;
  profile_id: string;
  profile_version: string;
  rssi: number;
  tx_power: number | null;
  battery_percent: number | null;
  motion: number | null;
  counter: number | null;
  observer_position_json: string | null;
  scan_context: TrackingObservation["scanContext"];
  quality_flags_json: string;
  trust: number;
  telemetry_json: string;
  idempotency_key: string;
}

interface EstimateRow {
  id: string;
  data_mode: DataMode;
  equipment_id: string;
  property_id: string;
  endpoint_id: string;
  calculated_at: string;
  effective_at: string;
  kind: EquipmentLocationEstimate["kind"];
  coordinate_json: string | null;
  uncertainty_radius_meters: number | null;
  zone_id: string | null;
  confidence: number;
  truth_class: EquipmentLocationEstimate["truthClass"];
  source: EquipmentLocationEstimate["source"];
  freshness: EquipmentLocationEstimate["freshness"];
  movement_state: EquipmentLocationEstimate["movementState"];
  last_observed_at: string | null;
  observer_count: number;
  provenance_json: string;
  version: number;
}

interface EventRow {
  sequence: number;
  type: TrackingEventType;
  tenant_id: string;
  property_id: string;
  entity_id: string;
  event_at: string;
  state_version: number;
  evidence_observation_ids_json: string;
  state_json: string;
}

interface RollupRow {
  id: string;
  data_mode: DataMode;
  tenant_id: string;
  property_id: string;
  endpoint_id: string;
  equipment_id: string;
  binding_id: string;
  observer_id: string;
  profile_id: string;
  profile_version: string;
  window_started_at: string;
  window_ended_at: string;
  packet_count: number;
  rssi_minimum: number;
  rssi_maximum: number;
  rssi_mean: number;
  rssi_variance: number;
  last_battery_percent: number | null;
  motion_observed: number | null;
  first_counter: number | null;
  last_counter: number | null;
  telemetry_json: string;
  received_at: string;
  idempotency_key: string;
}

export interface StoredGatewayRollup extends Omit<
  TrackingGatewayRollupInput,
  "schemaVersion" | "lastBatteryPercent" | "motionObserved" | "firstCounter" | "lastCounter" | "telemetry"
> {
  id: string;
  tenantId: string;
  bindingId: string;
  lastBatteryPercent: number | null;
  motionObserved: boolean | null;
  firstCounter: number | null;
  lastCounter: number | null;
  telemetry: Record<string, string | number | boolean | null>;
  receivedAt: string;
}

export interface AcceptedObservation {
  input: TrackingObservationInput;
  tenantId: string;
  bindingId: string;
  observerType: TrackingObserverType;
  receivedAt: string;
  qualityFlags: TrackingObservationQualityFlag[];
  trust: number;
}

export interface AcceptedRollup {
  input: TrackingGatewayRollupInput;
  tenantId: string;
  bindingId: string;
  receivedAt: string;
}

function observationFromRow(row: ObservationRow): TrackingObservation {
  return {
    id: row.id,
    observationId: row.id,
    idempotencyKey: row.idempotency_key,
    dataMode: row.data_mode,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    endpointId: row.endpoint_id,
    equipmentId: row.equipment_id,
    observerId: row.observer_id,
    observerType: row.observer_type,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    rssi: row.rssi,
    txPower: row.tx_power,
    batteryPercent: row.battery_percent,
    motion: row.motion === null ? null : row.motion === 1,
    counter: row.counter,
    observerPosition: row.observer_position_json
      ? parseJson<TrackingObservation["observerPosition"]>(row.observer_position_json, "observer position")
      : null,
    scanContext: row.scan_context,
    qualityFlags: parseJson<TrackingObservationQualityFlag[]>(row.quality_flags_json, "quality flags"),
    trust: row.trust,
    telemetry: parseJson<TrackingObservation["telemetry"]>(row.telemetry_json, "observation telemetry"),
  };
}

function rollupFromRow(row: RollupRow): StoredGatewayRollup {
  return {
    id: row.id,
    rollupId: row.id,
    idempotencyKey: row.idempotency_key,
    dataMode: row.data_mode,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    endpointId: row.endpoint_id,
    equipmentId: row.equipment_id,
    bindingId: row.binding_id,
    observerId: row.observer_id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    windowStartedAt: row.window_started_at,
    windowEndedAt: row.window_ended_at,
    packetCount: row.packet_count,
    rssiMinimum: row.rssi_minimum,
    rssiMaximum: row.rssi_maximum,
    rssiMean: row.rssi_mean,
    rssiVariance: row.rssi_variance,
    lastBatteryPercent: row.last_battery_percent,
    motionObserved: row.motion_observed === null ? null : row.motion_observed === 1,
    firstCounter: row.first_counter,
    lastCounter: row.last_counter,
    telemetry: parseJson<StoredGatewayRollup["telemetry"]>(row.telemetry_json, "rollup telemetry"),
    receivedAt: row.received_at,
  };
}

function estimateFromRow(row: EstimateRow): EquipmentLocationEstimate {
  return {
    id: row.id,
    dataMode: row.data_mode,
    equipmentId: row.equipment_id,
    propertyId: row.property_id,
    endpointId: row.endpoint_id,
    calculatedAt: row.calculated_at,
    effectiveAt: row.effective_at,
    kind: row.kind,
    coordinate: row.coordinate_json
      ? parseJson<EquipmentLocationEstimate["coordinate"]>(row.coordinate_json, "estimate coordinate")
      : null,
    uncertaintyRadiusMeters: row.uncertainty_radius_meters,
    zoneId: row.zone_id,
    confidence: row.confidence,
    truthClass: row.truth_class,
    source: row.source,
    freshness: row.freshness,
    movementState: row.movement_state,
    lastObservedAt: row.last_observed_at,
    observerCount: row.observer_count,
    provenance: parseJson<EquipmentLocationEstimate["provenance"]>(row.provenance_json, "estimate provenance"),
    version: row.version,
  };
}

export class TrackingEvidenceStore {
  constructor(private readonly db: DatabaseSync) {}

  insertObservation(value: AcceptedObservation): { duplicate: boolean; observation: TrackingObservation | null } {
    const input = value.input;
    const result = this.db.prepare(`INSERT OR IGNORE INTO tracking_observations(
      id, data_mode, tenant_id, property_id, endpoint_id, equipment_id, binding_id, observer_id,
      observer_type, observed_at, received_at, profile_id, profile_version, rssi, tx_power,
      battery_percent, motion, counter, observer_position_json, scan_context, quality_flags_json,
      trust, telemetry_json, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.observationId, input.dataMode, value.tenantId, input.propertyId, input.endpointId,
      input.equipmentId, value.bindingId, input.observerId, value.observerType, input.observedAt,
      value.receivedAt, input.profileId, input.profileVersion, input.rssi, input.txPower ?? null,
      input.batteryPercent ?? null, input.motion === undefined ? null : input.motion ? 1 : 0,
      input.counter ?? null, input.observerPosition ? JSON.stringify(input.observerPosition) : null,
      input.scanContext, JSON.stringify(value.qualityFlags), value.trust,
      JSON.stringify(input.telemetry ?? {}), input.idempotencyKey,
    );
    if (Number(result.changes) === 0) return { duplicate: true, observation: null };
    return { duplicate: false, observation: this.observation(input.observationId) };
  }

  insertRollup(value: AcceptedRollup): { duplicate: boolean; rollup: StoredGatewayRollup | null } {
    const input = value.input;
    const result = this.db.prepare(`INSERT OR IGNORE INTO tracking_gateway_rollups(
      id, data_mode, tenant_id, property_id, endpoint_id, equipment_id, binding_id, observer_id,
      profile_id, profile_version, window_started_at, window_ended_at, packet_count, rssi_minimum,
      rssi_maximum, rssi_mean, rssi_variance, last_battery_percent, motion_observed, first_counter,
      last_counter, telemetry_json, received_at, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.rollupId, input.dataMode, value.tenantId, input.propertyId, input.endpointId,
      input.equipmentId, value.bindingId, input.observerId, input.profileId, input.profileVersion,
      input.windowStartedAt, input.windowEndedAt, input.packetCount, input.rssiMinimum,
      input.rssiMaximum, input.rssiMean, input.rssiVariance, input.lastBatteryPercent ?? null,
      input.motionObserved === undefined ? null : input.motionObserved ? 1 : 0,
      input.firstCounter ?? null, input.lastCounter ?? null, JSON.stringify(input.telemetry ?? {}),
      value.receivedAt, input.idempotencyKey,
    );
    if (Number(result.changes) === 0) return { duplicate: true, rollup: null };
    return { duplicate: false, rollup: this.rollup(input.rollupId) };
  }

  observation(id: string): TrackingObservation | null {
    const row = this.db.prepare("SELECT * FROM tracking_observations WHERE id=?")
      .get(id) as unknown as ObservationRow | undefined;
    return row ? observationFromRow(row) : null;
  }

  rollup(id: string): StoredGatewayRollup | null {
    const row = this.db.prepare("SELECT * FROM tracking_gateway_rollups WHERE id=?")
      .get(id) as unknown as RollupRow | undefined;
    return row ? rollupFromRow(row) : null;
  }

  equipmentObservations(
    equipmentId: string,
    dataMode: DataMode,
    limit = 100,
  ): TrackingObservation[] {
    return (this.db.prepare(`SELECT * FROM tracking_observations
      WHERE equipment_id=? AND data_mode=? ORDER BY observed_at DESC, id DESC LIMIT ?`)
      .all(equipmentId, dataMode, Math.max(1, Math.min(500, limit))) as unknown as ObservationRow[])
      .map(observationFromRow);
  }

  recentEvidence(
    equipmentId: string,
    dataMode: DataMode,
    since: string,
    limit = 500,
  ): { observations: TrackingObservation[]; rollups: StoredGatewayRollup[] } {
    const observations = (this.db.prepare(`SELECT * FROM tracking_observations
      WHERE equipment_id=? AND data_mode=? AND observed_at>=?
      ORDER BY observed_at DESC, id DESC LIMIT ?`).all(
      equipmentId, dataMode, since, limit,
    ) as unknown as ObservationRow[]).map(observationFromRow);
    const rollups = (this.db.prepare(`SELECT * FROM tracking_gateway_rollups
      WHERE equipment_id=? AND data_mode=? AND window_ended_at>=?
      ORDER BY window_ended_at DESC, id DESC LIMIT ?`).all(
      equipmentId, dataMode, since, limit,
    ) as unknown as RollupRow[]).map(rollupFromRow);
    return { observations, rollups };
  }

  savePosition(value: Omit<EquipmentLocationEstimate, "id" | "version">): EquipmentLocationEstimate {
    const version = (this.currentPosition(value.equipmentId, value.dataMode)?.version ?? 0) + 1;
    const estimate: EquipmentLocationEstimate = { ...value, id: randomUUID(), version };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO equipment_location_estimates(
        id, data_mode, equipment_id, property_id, endpoint_id, calculated_at, effective_at, kind,
        coordinate_json, uncertainty_radius_meters, zone_id, confidence, truth_class, source,
        freshness, movement_state, last_observed_at, observer_count, provenance_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        estimate.id, estimate.dataMode, estimate.equipmentId, estimate.propertyId, estimate.endpointId,
        estimate.calculatedAt, estimate.effectiveAt, estimate.kind,
        estimate.coordinate ? JSON.stringify(estimate.coordinate) : null, estimate.uncertaintyRadiusMeters,
        estimate.zoneId, estimate.confidence, estimate.truthClass, estimate.source, estimate.freshness,
        estimate.movementState, estimate.lastObservedAt, estimate.observerCount,
        JSON.stringify(estimate.provenance), estimate.version,
      );
      this.db.prepare(`INSERT INTO equipment_current_locations(
        equipment_id, data_mode, latest_estimate_id, property_id, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(equipment_id, data_mode) DO UPDATE SET
        latest_estimate_id=excluded.latest_estimate_id, property_id=excluded.property_id,
        version=excluded.version, updated_at=excluded.updated_at`).run(
        estimate.equipmentId, estimate.dataMode, estimate.id, estimate.propertyId,
        estimate.version, estimate.calculatedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return estimate;
  }

  currentPosition(equipmentId: string, dataMode: DataMode): EquipmentLocationEstimate | null {
    const row = this.db.prepare(`SELECT estimate.* FROM equipment_current_locations current
      JOIN equipment_location_estimates estimate ON estimate.id=current.latest_estimate_id
      WHERE current.equipment_id=? AND current.data_mode=?`).get(
      equipmentId, dataMode,
    ) as unknown as EstimateRow | undefined;
    return row ? estimateFromRow(row) : null;
  }

  positionHistory(equipmentId: string, dataMode: DataMode, limit = 100): EquipmentLocationEstimate[] {
    return (this.db.prepare(`SELECT * FROM equipment_location_estimates
      WHERE equipment_id=? AND data_mode=? ORDER BY effective_at DESC, version DESC LIMIT ?`)
      .all(equipmentId, dataMode, Math.max(1, Math.min(500, limit))) as unknown as EstimateRow[])
      .map(estimateFromRow);
  }

  appendEvent(
    type: TrackingEventType,
    tenantId: string,
    dataMode: DataMode,
    state: TrackingEvent["state"],
    evidenceObservationIds: string[] = [],
  ): TrackingEvent {
    const propertyId = state.propertyId;
    const entityId = "equipmentId" in state ? state.equipmentId : state.id;
    const stateVersion = "version" in state ? state.version : 1;
    const eventAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO tracking_events(
      data_mode, type, tenant_id, property_id, entity_id, event_at, state_version,
      evidence_observation_ids_json, state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      dataMode, type, tenantId, propertyId, entityId, eventAt, stateVersion,
      JSON.stringify(evidenceObservationIds), JSON.stringify(state),
    );
    return {
      type, tenantId, propertyId, entityId, sequence: Number(result.lastInsertRowid),
      eventAt, stateVersion, evidenceObservationIds, state,
    };
  }

  eventsAfter(propertyId: string, dataMode: DataMode, sequence: number, limit = 500): TrackingEvent[] {
    return (this.db.prepare(`SELECT * FROM tracking_events WHERE property_id=? AND data_mode=?
      AND sequence>? ORDER BY sequence LIMIT ?`).all(
      propertyId, dataMode, sequence, limit,
    ) as unknown as EventRow[]).map((row) => ({
      type: row.type,
      tenantId: row.tenant_id,
      propertyId: row.property_id,
      entityId: row.entity_id,
      sequence: Number(row.sequence),
      eventAt: row.event_at,
      stateVersion: row.state_version,
      evidenceObservationIds: parseJson<string[]>(row.evidence_observation_ids_json, "event evidence"),
      state: parseJson<TrackingEvent["state"]>(row.state_json, "event state"),
    }));
  }

  latestSequence(propertyId: string, dataMode: DataMode): number {
    const row = this.db.prepare(
      "SELECT MAX(sequence) AS sequence FROM tracking_events WHERE property_id=? AND data_mode=?",
    ).get(propertyId, dataMode) as { sequence: number | null };
    return Number(row.sequence ?? 0);
  }

  evaluateBoundaryTransition(
    equipmentId: string,
    dataMode: DataMode,
    inside: boolean,
    debounceSeconds: number,
    now = new Date(),
  ): "entered" | "exited" | null {
    const row = this.db.prepare(`SELECT confirmed_inside, candidate_inside, candidate_since
      FROM tracking_boundary_states WHERE equipment_id=? AND data_mode=?`).get(
      equipmentId, dataMode,
    ) as { confirmed_inside: number | null; candidate_inside: number | null; candidate_since: string | null } | undefined;
    const timestamp = now.toISOString();
    if (!row || row.confirmed_inside === null) {
      this.db.prepare(`INSERT INTO tracking_boundary_states(
        equipment_id, data_mode, confirmed_inside, candidate_inside, candidate_since, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(equipment_id, data_mode) DO UPDATE SET
        confirmed_inside=excluded.confirmed_inside, candidate_inside=NULL,
        candidate_since=NULL, updated_at=excluded.updated_at`).run(
        equipmentId, dataMode, inside ? 1 : 0, timestamp,
      );
      return null;
    }
    const confirmed = row.confirmed_inside === 1;
    if (confirmed === inside) {
      this.db.prepare(`UPDATE tracking_boundary_states SET candidate_inside=NULL,
        candidate_since=NULL, updated_at=? WHERE equipment_id=? AND data_mode=?`).run(
        timestamp, equipmentId, dataMode,
      );
      return null;
    }
    if (row.candidate_inside === null || (row.candidate_inside === 1) !== inside || !row.candidate_since) {
      this.db.prepare(`UPDATE tracking_boundary_states SET candidate_inside=?,
        candidate_since=?, updated_at=? WHERE equipment_id=? AND data_mode=?`).run(
        inside ? 1 : 0, timestamp, timestamp, equipmentId, dataMode,
      );
      return null;
    }
    if (now.getTime() - Date.parse(row.candidate_since) < debounceSeconds * 1_000) return null;
    this.db.prepare(`UPDATE tracking_boundary_states SET confirmed_inside=?, candidate_inside=NULL,
      candidate_since=NULL, updated_at=? WHERE equipment_id=? AND data_mode=?`).run(
      inside ? 1 : 0, timestamp, equipmentId, dataMode,
    );
    return inside ? "entered" : "exited";
  }

  purge(propertyId: string, settings: {
    observationRetentionDays: number;
    rollupRetentionDays: number;
    estimateRetentionDays: number;
  }, now = new Date()): void {
    const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM tracking_observations WHERE property_id=? AND observed_at<?")
      .run(propertyId, cutoff(settings.observationRetentionDays));
    this.db.prepare("DELETE FROM tracking_gateway_rollups WHERE property_id=? AND window_ended_at<?")
      .run(propertyId, cutoff(settings.rollupRetentionDays));
    this.db.prepare(`DELETE FROM equipment_location_estimates
      WHERE property_id=? AND calculated_at<?
        AND id NOT IN (SELECT latest_estimate_id FROM equipment_current_locations)`)
      .run(propertyId, cutoff(settings.estimateRetentionDays));
  }
}
