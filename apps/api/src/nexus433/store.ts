import { randomUUID } from "node:crypto";
import type {
  Nexus433Binding,
  Nexus433Candidate,
  Nexus433SamplePreview,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";

const ADAPTER = "nexus433";
const CANDIDATE_TTL_MS = 6 * 60 * 60_000;
const CANDIDATE_LIMIT = 128;
const CANDIDATE_ADMISSION_WINDOW_MS = 60_000;
const CANDIDATE_ADMISSION_LIMIT = 16;
const ACCEPT_INTERVAL_MS = 10_000;
const DIRECT_SOURCE_FRESHNESS_MS = 240_000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const ANOMALY_WINDOW_MS = 120_000;
const ANOMALY_CONFIRMATION_MS = 180_000;

interface GatewayRow {
  id: string;
  house_id: string;
  enabled: number;
  revision: number;
  receiver_identity: string | null;
}

interface CandidateRow {
  id: string;
  provider_key: string;
  sender_id: string;
  channel: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string;
  sample_json: string;
}

interface BindingRow {
  id: string;
  sensor_id: string;
  provider_key: string;
  sender_id: string;
  channel: number;
  revision: number;
  battery_state: Nexus433Binding["battery"];
  signal_quality: number | null;
  available: number;
  last_seen_at: string | null;
  last_accepted_at: string | null;
  last_temperature: number | null;
  last_humidity: number | null;
  pending_temperature: number | null;
  pending_humidity: number | null;
  pending_at: string | null;
  created_at: string;
}

export class Nexus433StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function candidateFromRow(row: CandidateRow): Nexus433Candidate {
  return {
    id: row.id,
    providerKey: row.provider_key,
    senderId: row.sender_id,
    channel: row.channel,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    sample: JSON.parse(row.sample_json) as Nexus433SamplePreview,
  };
}

function bindingFromRow(row: BindingRow): Nexus433Binding {
  return {
    id: row.id,
    sensorId: row.sensor_id,
    providerKey: row.provider_key,
    senderId: row.sender_id,
    channel: row.channel,
    revision: row.revision,
    battery: row.battery_state,
    signalQuality: row.signal_quality,
    available: row.available === 1,
    lastSeenAt: row.last_seen_at,
    lastAcceptedAt: row.last_accepted_at,
    createdAt: row.created_at,
  };
}

export class Nexus433Store {
  constructor(private readonly database: ClimateDatabase) {}

  gatewayForHouse(houseId: string, create = true): GatewayRow | null {
    const existing = this.database.db.prepare(
      `SELECT gateway.id, gateway.house_id, gateway.enabled, gateway.revision, gateway.receiver_identity
        FROM external_source_gateways AS gateway
        JOIN houses AS house ON house.id = gateway.house_id
        WHERE gateway.adapter = ? AND gateway.house_id = ? AND house.deleted_at IS NULL`,
    ).get(ADAPTER, houseId) as unknown as GatewayRow | undefined;
    if (existing || !create) return existing ?? null;
    if (!this.database.getHouse(houseId)) {
      throw new Nexus433StoreError(404, "HOUSE_NOT_FOUND", "Home not found");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT INTO external_source_gateways
      (id, adapter, house_id, enabled, revision, receiver_identity, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`)
      .run(id, ADAPTER, houseId, now, now);
    return { id, house_id: houseId, enabled: 0, revision: 0, receiver_identity: null };
  }

  enabledGateway(): GatewayRow | null {
    return (this.database.db.prepare(
      `SELECT gateway.id, gateway.house_id, gateway.enabled, gateway.revision, gateway.receiver_identity
        FROM external_source_gateways AS gateway
        JOIN houses AS house ON house.id = gateway.house_id
        WHERE gateway.adapter = ? AND gateway.enabled = 1 AND house.deleted_at IS NULL`,
    ).get(ADAPTER) as unknown as GatewayRow | undefined) ?? null;
  }

  setEnabled(houseId: string, enabled: boolean, expectedRevision?: number): GatewayRow {
    return this.database.transaction(() => {
      const gateway = this.gatewayForHouse(houseId, true)!;
      if (expectedRevision !== undefined && gateway.revision !== expectedRevision) {
        throw new Nexus433StoreError(409, "NEXUS433_CONFIG_CHANGED", "The receiver setting changed; refresh and try again");
      }
      if (enabled) {
        const current = this.enabledGateway();
        if (current && current.id !== gateway.id) {
          throw new Nexus433StoreError(409, "NEXUS433_ALREADY_ASSIGNED", "The receiver is already assigned to another Home");
        }
      } else {
        const current = this.enabledGateway();
        if (current && current.id !== gateway.id) {
          throw new Nexus433StoreError(409, "NEXUS433_ASSIGNED_ELSEWHERE", "The receiver is assigned to another Home");
        }
      }
      if ((gateway.enabled === 1) === enabled) return gateway;
      const now = new Date().toISOString();
      this.database.db.prepare(`UPDATE external_source_gateways
        SET enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, now, gateway.id);
      return { ...gateway, enabled: enabled ? 1 : 0, revision: gateway.revision + 1 };
    });
  }

  noteReceiver(gatewayId: string, receiverIdentity: string): void {
    this.database.db.prepare(`UPDATE external_source_gateways
      SET receiver_identity = ?, updated_at = ? WHERE id = ?`)
      .run(receiverIdentity, new Date().toISOString(), gatewayId);
  }

  listCandidates(houseId: string, now = new Date()): Nexus433Candidate[] {
    const gateway = this.gatewayForHouse(houseId, false);
    if (!gateway) return [];
    this.expireCandidates(gateway.id, now);
    const rows = this.database.db.prepare(`SELECT id, provider_key, sender_id, channel,
      first_seen_at, last_seen_at, expires_at, sample_json
      FROM external_source_candidates WHERE gateway_id = ? AND expires_at > ?
      ORDER BY last_seen_at DESC`).all(gateway.id, now.toISOString()) as unknown as CandidateRow[];
    return rows.map(candidateFromRow);
  }

  recordCandidate(
    gatewayId: string,
    providerKey: string,
    senderId: string,
    channel: number,
    sample: Nexus433SamplePreview,
    receivedAt: Date,
  ): boolean {
    return this.database.transaction(() => {
      const timestamp = receivedAt.toISOString();
      const expiresAt = new Date(receivedAt.getTime() + CANDIDATE_TTL_MS).toISOString();
      this.expireCandidates(gatewayId, receivedAt);
      const existing = this.database.db.prepare(
        "SELECT 1 FROM external_source_candidates WHERE gateway_id = ? AND provider_key = ?",
      ).get(gatewayId, providerKey);
      if (!existing) {
        const admitted = this.database.db.prepare(`SELECT COUNT(*) AS count
          FROM external_source_candidates WHERE gateway_id = ? AND first_seen_at >= ?`)
          .get(gatewayId, new Date(receivedAt.getTime() - CANDIDATE_ADMISSION_WINDOW_MS).toISOString()) as { count: number };
        if (admitted.count >= CANDIDATE_ADMISSION_LIMIT) return false;
      }
      this.database.db.prepare(`INSERT INTO external_source_candidates
        (id, gateway_id, provider_key, sender_id, channel, first_seen_at, last_seen_at, expires_at, sample_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gateway_id, provider_key) DO UPDATE SET
          sender_id = excluded.sender_id,
          channel = excluded.channel,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at,
          sample_json = excluded.sample_json`)
        .run(randomUUID(), gatewayId, providerKey, senderId, channel, timestamp, timestamp, expiresAt, JSON.stringify(sample));
      this.database.db.prepare(`DELETE FROM external_source_candidates WHERE id IN (
        SELECT id FROM external_source_candidates WHERE gateway_id = ?
        ORDER BY last_seen_at DESC, id DESC LIMIT -1 OFFSET ?
      )`).run(gatewayId, CANDIDATE_LIMIT);
      return true;
    });
  }

  listBindings(houseId: string): Nexus433Binding[] {
    const gateway = this.gatewayForHouse(houseId, false);
    if (!gateway) return [];
    const rows = this.database.db.prepare(`SELECT id, sensor_id, provider_key, sender_id, channel,
      revision, battery_state, signal_quality, available, last_seen_at, last_accepted_at,
      last_temperature, last_humidity, pending_temperature, pending_humidity, pending_at, created_at
      FROM external_source_bindings WHERE gateway_id = ? AND active = 1 ORDER BY created_at`)
      .all(gateway.id) as unknown as BindingRow[];
    return rows.map(bindingFromRow);
  }

  bindingForProvider(gatewayId: string, providerKey: string): BindingRow | null {
    return (this.database.db.prepare(`SELECT id, sensor_id, provider_key, sender_id, channel,
      revision, battery_state, signal_quality, available, last_seen_at, last_accepted_at,
      last_temperature, last_humidity, pending_temperature, pending_humidity, pending_at, created_at
      FROM external_source_bindings WHERE gateway_id = ? AND provider_key = ? AND active = 1`)
      .get(gatewayId, providerKey) as unknown as BindingRow | undefined) ?? null;
  }

  bindCandidate(houseId: string, candidateId: string, sensorId: string): Nexus433Binding {
    return this.database.transaction(() => {
      const gateway = this.gatewayForHouse(houseId, false);
      if (!gateway) throw new Nexus433StoreError(404, "NEXUS433_CANDIDATE_NOT_FOUND", "Sender not found");
      const candidate = this.candidate(gateway.id, candidateId);
      const sensor = this.database.getSensor(sensorId);
      if (!sensor || sensor.houseId !== houseId) throw new Nexus433StoreError(404, "SENSOR_NOT_FOUND", "Sensor not found");
      if (!sensor.enabled) throw new Nexus433StoreError(409, "SENSOR_DISABLED", "Enable the Sensor before attaching a sender");
      if (sensor.tpLinkDeviceId) {
        throw new Nexus433StoreError(409, "NEXUS433_DIRECT_SOURCE_CONFLICT", "Remove the direct TP-Link binding before attaching a 433 MHz sender");
      }
      const claimed = this.database.db.prepare(
        "SELECT id FROM external_source_bindings WHERE gateway_id = ? AND sensor_id = ? AND active = 1",
      ).get(gateway.id, sensorId);
      if (claimed) throw new Nexus433StoreError(409, "NEXUS433_SENSOR_ALREADY_BOUND", "This sensor already has a 433 MHz sender");
      if (this.bindingForProvider(gateway.id, candidate.provider_key)) {
        throw new Nexus433StoreError(409, "NEXUS433_SENDER_ALREADY_BOUND", "This sender is already in use");
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.db.prepare(`INSERT INTO external_source_bindings
        (id, gateway_id, sensor_id, provider_key, sender_id, channel, active, revision,
         battery_state, signal_quality, available, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?, ?)`)
        .run(id, gateway.id, sensor.id, candidate.provider_key, candidate.sender_id, candidate.channel,
          (JSON.parse(candidate.sample_json) as Nexus433SamplePreview).battery,
          (JSON.parse(candidate.sample_json) as Nexus433SamplePreview).quality,
          candidate.last_seen_at, now);
      this.database.db.prepare("DELETE FROM external_source_candidates WHERE id = ?").run(candidate.id);
      return bindingFromRow(this.bindingById(id)!);
    });
  }

  reconnectCandidate(
    houseId: string,
    sensorId: string,
    candidateId: string,
    expectedRevision: number,
  ): Nexus433Binding {
    return this.database.transaction(() => {
      const gateway = this.gatewayForHouse(houseId, false);
      if (!gateway) throw new Nexus433StoreError(404, "NEXUS433_BINDING_NOT_FOUND", "Receiver binding not found");
      const current = this.database.db.prepare(`SELECT id, sensor_id, provider_key, sender_id, channel,
        revision, battery_state, signal_quality, available, last_seen_at, last_accepted_at,
        last_temperature, last_humidity, pending_temperature, pending_humidity, pending_at, created_at
        FROM external_source_bindings WHERE gateway_id = ? AND sensor_id = ? AND active = 1`)
        .get(gateway.id, sensorId) as unknown as BindingRow | undefined;
      if (!current) throw new Nexus433StoreError(404, "NEXUS433_BINDING_NOT_FOUND", "Receiver binding not found");
      const sensor = this.database.getSensor(sensorId);
      if (!sensor?.enabled) throw new Nexus433StoreError(409, "SENSOR_DISABLED", "Enable the Sensor before reconnecting its sender");
      if (sensor.tpLinkDeviceId) {
        throw new Nexus433StoreError(409, "NEXUS433_DIRECT_SOURCE_CONFLICT", "Remove the direct TP-Link binding before reconnecting a 433 MHz sender");
      }
      if (current.revision !== expectedRevision) {
        throw new Nexus433StoreError(409, "NEXUS433_BINDING_CHANGED", "The sender binding changed; refresh and try again");
      }
      const candidate = this.candidate(gateway.id, candidateId);
      if (this.bindingForProvider(gateway.id, candidate.provider_key)) {
        throw new Nexus433StoreError(409, "NEXUS433_SENDER_ALREADY_BOUND", "This sender is already in use");
      }
      const now = new Date().toISOString();
      this.database.db.prepare("UPDATE external_source_bindings SET active = 0, retired_at = ? WHERE id = ?")
        .run(now, current.id);
      const sample = JSON.parse(candidate.sample_json) as Nexus433SamplePreview;
      const id = randomUUID();
      this.database.db.prepare(`INSERT INTO external_source_bindings
        (id, gateway_id, sensor_id, provider_key, sender_id, channel, active, revision,
         battery_state, signal_quality, available, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`)
        .run(id, gateway.id, sensorId, candidate.provider_key, candidate.sender_id, candidate.channel,
          current.revision + 1, sample.battery, sample.quality, candidate.last_seen_at, now);
      this.database.db.prepare("DELETE FROM external_source_candidates WHERE id = ?").run(candidate.id);
      return bindingFromRow(this.bindingById(id)!);
    });
  }

  setSenderAvailability(gatewayId: string, providerKey: string, online: boolean, receivedAt: Date): void {
    this.database.db.prepare(`UPDATE external_source_bindings
      SET available = ?, last_seen_at = ? WHERE gateway_id = ? AND provider_key = ? AND active = 1`)
      .run(online ? 1 : 0, receivedAt.toISOString(), gatewayId, providerKey);
  }

  isSensorDirectlyAvailable(sensorId: string, now = new Date()): boolean {
    const row = this.database.db.prepare(`SELECT binding.available, binding.last_accepted_at
      FROM external_source_bindings AS binding
      JOIN external_source_gateways AS gateway ON gateway.id = binding.gateway_id
      WHERE gateway.adapter = ? AND gateway.enabled = 1
        AND binding.sensor_id = ? AND binding.active = 1`)
      .get(ADAPTER, sensorId) as { available: number; last_accepted_at: string | null } | undefined;
    if (!row || row.available !== 1 || !row.last_accepted_at) return false;
    const acceptedAt = Date.parse(row.last_accepted_at);
    const age = now.getTime() - acceptedAt;
    return Number.isFinite(acceptedAt) && age >= 0 && age <= DIRECT_SOURCE_FRESHNESS_MS;
  }

  acceptBoundObservation(
    bindingId: string,
    sample: Nexus433SamplePreview,
    payloadHash: string,
    receivedAt: Date,
  ): boolean {
    const row = this.bindingById(bindingId);
    if (!row) return false;
    const timestamp = receivedAt.toISOString();
    const observed = () => this.database.db.prepare(`UPDATE external_source_bindings SET
      battery_state = ?, signal_quality = ?, available = 1, last_seen_at = ? WHERE id = ?`)
      .run(sample.battery, sample.quality, timestamp, bindingId);
    observed();
    const lastAcceptedMs = row.last_accepted_at ? Date.parse(row.last_accepted_at) : 0;
    if (lastAcceptedMs && receivedAt.getTime() - lastAcceptedMs < ACCEPT_INTERVAL_MS) return false;
    const duplicate = this.database.db.prepare(`SELECT 1 FROM external_observation_receipts
      WHERE binding_id = ? AND payload_hash = ? AND received_at >= ? LIMIT 1`)
      .get(bindingId, payloadHash, new Date(receivedAt.getTime() - ACCEPT_INTERVAL_MS).toISOString());
    if (duplicate) return false;

    const recentlyAccepted = lastAcceptedMs && receivedAt.getTime() - lastAcceptedMs <= ANOMALY_WINDOW_MS;
    const anomalous = recentlyAccepted && (
      (row.last_temperature !== null && Math.abs(sample.temperature - row.last_temperature) > 10)
      || (row.last_humidity !== null && Math.abs(sample.humidity - row.last_humidity) > 25)
    );
    if (anomalous) {
      const pendingMs = row.pending_at ? Date.parse(row.pending_at) : 0;
      const confirmsPending = pendingMs
        && receivedAt.getTime() - pendingMs <= ANOMALY_CONFIRMATION_MS
        && row.pending_temperature !== null
        && row.pending_humidity !== null
        && Math.abs(sample.temperature - row.pending_temperature) <= 1
        && Math.abs(sample.humidity - row.pending_humidity) <= 3;
      if (!confirmsPending) {
        this.database.db.prepare(`UPDATE external_source_bindings SET
          pending_temperature = ?, pending_humidity = ?, pending_at = ? WHERE id = ?`)
          .run(sample.temperature, sample.humidity, timestamp, bindingId);
        return false;
      }
    }

    this.database.db.prepare(`UPDATE external_source_bindings SET
      last_accepted_at = ?, last_temperature = ?, last_humidity = ?,
      pending_temperature = NULL, pending_humidity = NULL, pending_at = NULL WHERE id = ?`)
      .run(timestamp, sample.temperature, sample.humidity, bindingId);
    this.database.db.prepare(`INSERT INTO external_observation_receipts
      (id, binding_id, payload_hash, received_at) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), bindingId, payloadHash, timestamp);
    this.database.db.prepare("DELETE FROM external_observation_receipts WHERE received_at < ?")
      .run(new Date(receivedAt.getTime() - RECEIPT_RETENTION_MS).toISOString());
    return true;
  }

  private expireCandidates(gatewayId: string, now: Date): void {
    this.database.db.prepare("DELETE FROM external_source_candidates WHERE gateway_id = ? AND expires_at <= ?")
      .run(gatewayId, now.toISOString());
  }

  private candidate(gatewayId: string, candidateId: string): CandidateRow {
    const row = this.database.db.prepare(`SELECT id, provider_key, sender_id, channel,
      first_seen_at, last_seen_at, expires_at, sample_json FROM external_source_candidates
      WHERE gateway_id = ? AND id = ? AND expires_at > ?`)
      .get(gatewayId, candidateId, new Date().toISOString()) as unknown as CandidateRow | undefined;
    if (!row) throw new Nexus433StoreError(404, "NEXUS433_CANDIDATE_NOT_FOUND", "Sender not found or discovery expired");
    return row;
  }

  private bindingById(id: string): BindingRow | null {
    return (this.database.db.prepare(`SELECT id, sensor_id, provider_key, sender_id, channel,
      revision, battery_state, signal_quality, available, last_seen_at, last_accepted_at,
      last_temperature, last_humidity, pending_temperature, pending_humidity, pending_at, created_at
      FROM external_source_bindings WHERE id = ? AND active = 1`)
      .get(id) as unknown as BindingRow | undefined) ?? null;
  }
}
