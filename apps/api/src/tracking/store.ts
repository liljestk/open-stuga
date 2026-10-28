import { isSqliteFailure } from "../db/sqlite-failure.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  EquipmentTrackingBinding,
  EquipmentTrackingBindingInput,
  TrackingEndpoint,
  TrackingEndpointEnrollmentInput,
  TrackingObserver,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
  TrackedEquipmentState,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";
import { TrackingSecretBox } from "./crypto.js";
import { TrackingError } from "./errors.js";
import { TrackingEvidenceStore } from "./evidence-store.js";
import { trackingProfile } from "./profiles.js";
import { TrackingPeopleStore } from "./people-store.js";
import { initializeTrackingSchema } from "./schema.js";
import {
  DEFAULT_TRACKING_SETTINGS,
  MAX_TRACKED_EQUIPMENT,
  TRACKED_EQUIPMENT_PAGE_SIZE,
  type TrackingBindingRow,
  type TrackingEndpointRow,
  type TrackingObserverRow,
  type TrackingSettingsRow,
  bindingFromRow,
  credentialMatches,
  endpointFromRow,
  finiteCoordinate,
  observerFromRow,
  optionalText,
  requiredText,
  settingsFromRow,
  sha256,
} from "./store-support.js";

export { TrackingError } from "./errors.js";

export interface AuthenticatedTrackingObserver {
  observer: TrackingObserver;
  createdByUserId: string | null;
}

function isMobile(type: TrackingObserver["type"]): boolean {
  return type === "ios-phone" || type === "android-phone";
}

function activeMode(core: ClimateDatabase): "live" | "demo" {
  return core.isRealDataMode() ? "live" : "demo";
}

export class TrackingStore {
  readonly db: DatabaseSync;
  readonly evidence: TrackingEvidenceStore;
  readonly people: TrackingPeopleStore;

  constructor(
    readonly core: ClimateDatabase,
    private readonly secretBox: TrackingSecretBox,
  ) {
    this.db = core.db;
    initializeTrackingSchema(this.db);
    this.evidence = new TrackingEvidenceStore(this.db);
    this.people = new TrackingPeopleStore(this.core);
    this.db.prepare("DELETE FROM property_member_locations").run();
  }

  dataMode(): "live" | "demo" {
    return activeMode(this.core);
  }

  propertySettings(propertyId: string): TrackingPropertySettings {
    const existing = this.db.prepare("SELECT * FROM tracking_property_settings WHERE property_id=?")
      .get(propertyId) as unknown as TrackingSettingsRow | undefined;
    if (existing) return settingsFromRow(existing);
    if (!this.core.getProperty(propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const updatedAt = new Date().toISOString();
    const value: TrackingPropertySettings = { propertyId, ...DEFAULT_TRACKING_SETTINGS, updatedAt };
    this.db.prepare(`INSERT INTO tracking_property_settings(
      property_id, enabled, property_boundary_json, live_nearby_seconds, recently_seen_seconds,
      stale_seconds, unknown_seconds, movement_threshold_meters, movement_maximum_interval_seconds,
      minimum_movement_confidence, exit_alert_debounce_seconds, observation_retention_days,
      rollup_retention_days, estimate_retention_days, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      propertyId, 1, "[]", value.liveNearbySeconds, value.recentlySeenSeconds, value.staleSeconds,
      value.unknownSeconds, value.movementThresholdMeters, value.movementMaximumIntervalSeconds,
      value.minimumMovementConfidence, value.exitAlertDebounceSeconds, value.observationRetentionDays,
      value.rollupRetentionDays, value.estimateRetentionDays, updatedAt,
    );
    return value;
  }

  updatePropertySettings(
    propertyId: string,
    patch: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">>,
  ): TrackingPropertySettings {
    const next = { ...this.propertySettings(propertyId), ...patch, updatedAt: new Date().toISOString() };
    next.propertyBoundary = next.propertyBoundary.map((point) => finiteCoordinate(point, "Property boundary"));
    if (next.propertyBoundary.length > 10_000) {
      throw new TrackingError(413, "COLLECTION_TOO_LARGE", "Property boundary may contain at most 10000 points");
    }
    if (!(next.liveNearbySeconds < next.recentlySeenSeconds
      && next.recentlySeenSeconds <= next.staleSeconds
      && next.staleSeconds < next.unknownSeconds)) {
      throw new TrackingError(422, "INVALID_TRACKING_WINDOWS", "Tracking freshness windows must increase in order");
    }
    try {
      this.db.prepare(`UPDATE tracking_property_settings SET
        enabled=?, property_boundary_json=?, live_nearby_seconds=?, recently_seen_seconds=?,
        stale_seconds=?, unknown_seconds=?, movement_threshold_meters=?,
        movement_maximum_interval_seconds=?, minimum_movement_confidence=?,
        exit_alert_debounce_seconds=?, observation_retention_days=?, rollup_retention_days=?,
        estimate_retention_days=?, updated_at=? WHERE property_id=?`).run(
        next.enabled ? 1 : 0, JSON.stringify(next.propertyBoundary), next.liveNearbySeconds,
        next.recentlySeenSeconds, next.staleSeconds, next.unknownSeconds,
        next.movementThresholdMeters, next.movementMaximumIntervalSeconds,
        next.minimumMovementConfidence, next.exitAlertDebounceSeconds,
        next.observationRetentionDays, next.rollupRetentionDays, next.estimateRetentionDays,
        next.updatedAt, propertyId,
      );
    } catch (error) {
      if (isSqliteFailure(error, "check")) {
        throw new TrackingError(422, "INVALID_TRACKING_SETTINGS", "Tracking settings are outside supported limits");
      }
      throw error;
    }
    return this.propertySettings(propertyId);
  }

  enrollEndpoint(
    input: TrackingEndpointEnrollmentInput,
    tenantId = "local",
  ): TrackingEndpoint {
    if (!this.core.getProperty(input.propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const registered = trackingProfile(input.profileId, input.profileVersion);
    if (!registered) throw new TrackingError(422, "PROFILE_NOT_SUPPORTED", "Tracking profile version is not supported");
    const profile = registered.profile;
    if (profile.identity.scope === "NONE" || profile.capabilities.trackabilityTier === "DISCOVERED_ONLY") {
      throw new TrackingError(422, "PROFILE_NOT_CLAIMABLE", "This profile can be discovered but not claimed");
    }
    const expectedFields = new Set(profile.identity.fields);
    const suppliedFields = Object.keys(input.identityFields);
    if (suppliedFields.length !== expectedFields.size || suppliedFields.some((field) => !expectedFields.has(field))) {
      throw new TrackingError(422, "IDENTITY_FIELDS_MISMATCH", "Identity fields must exactly match the profile");
    }
    const identityFields = Object.fromEntries(profile.identity.fields.map((field) => {
      const value = requiredText(input.identityFields[field] ?? "", `Identity field ${field}`, 512);
      return [field, value];
    }));
    const observerScopeId = input.observerScopeId?.trim() || null;
    if (profile.identity.scope === "OBSERVER") {
      const observer = observerScopeId ? this.getObserver(observerScopeId) : null;
      if (!observer || observer.propertyId !== input.propertyId) {
        throw new TrackingError(422, "OBSERVER_SCOPE_REQUIRED", "Observer-local identities require an observer in this Property");
      }
    } else if (observerScopeId) {
      throw new TrackingError(422, "OBSERVER_SCOPE_NOT_ALLOWED", "This profile is not observer-scoped");
    }
    if (input.proof.kind !== "PHYSICAL_ACCESS") {
      throw new TrackingError(
        422,
        "PROOF_VERIFIER_UNAVAILABLE",
        "This profile requires a configured cryptographic or provider proof verifier",
      );
    }
    const canonicalIdentity = profile.identity.fields.map((field) => identityFields[field]).join("\u001f");
    const hashNamespace = [
      profile.id,
      profile.version,
      String(profile.identity.namespaceVersion),
      observerScopeId ?? "",
    ].join("\u001e");
    const identityHash = this.secretBox.fingerprint(hashNamespace, canonicalIdentity);
    const identityReference = `tep_${Buffer.from(identityHash.slice(0, 32), "hex").toString("base64url")}`;
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO tracking_endpoints(
        id, tenant_id, property_id, profile_id, profile_version, identity_namespace_version,
        identity_hash, identity_envelope, identity_reference, identity_scope, identity_strength,
        observer_scope_id, observer_scope_key, trackability_tier, display_name, manufacturer,
        model, firmware_version, claim_status, proof_kind, proof_verified_at, last_seen_at,
        telemetry_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?, NULL, '{}', ?, ?)`).run(
        id, tenantId, input.propertyId, profile.id, profile.version, profile.identity.namespaceVersion,
        identityHash, this.secretBox.encryptText(JSON.stringify(identityFields)), identityReference,
        profile.identity.scope, profile.identity.strength, observerScopeId, observerScopeId ?? "",
        profile.capabilities.trackabilityTier, requiredText(input.displayName, "Endpoint name"),
        optionalText(input.manufacturer, "Manufacturer"), optionalText(input.model, "Model"),
        optionalText(input.firmwareVersion, "Firmware version"), input.proof.kind, timestamp,
        timestamp, timestamp,
      );
    } catch (error) {
      if (isSqliteFailure(error, "unique")) {
        throw new TrackingError(409, "ENDPOINT_ALREADY_ENROLLED", "This endpoint identity is already enrolled");
      }
      throw error;
    }
    return this.getEndpoint(id)!;
  }

  getEndpoint(id: string): TrackingEndpoint | null {
    const row = this.db.prepare("SELECT * FROM tracking_endpoints WHERE id=?")
      .get(id) as unknown as TrackingEndpointRow | undefined;
    return row ? endpointFromRow(row) : null;
  }

  listEndpoints(propertyId: string): TrackingEndpoint[] {
    return (this.db.prepare("SELECT * FROM tracking_endpoints WHERE property_id=? ORDER BY display_name, id")
      .all(propertyId) as unknown as TrackingEndpointRow[]).map(endpointFromRow);
  }

  endpointIdentityFields(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT identity_envelope FROM tracking_endpoints WHERE id=?")
      .get(id) as { identity_envelope: string } | undefined;
    if (!row) throw new TrackingError(404, "TRACKING_ENDPOINT_NOT_FOUND", "Tracking endpoint not found");
    try {
      const value = JSON.parse(this.secretBox.decryptText(row.identity_envelope)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid identity");
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (typeof item !== "string") throw new Error("invalid identity");
        return [key, item];
      }));
    } catch {
      throw new Error(`Tracking endpoint ${id} has unreadable identity material`);
    }
  }

  setEndpointStatus(id: string, status: TrackingEndpoint["claimStatus"]): TrackingEndpoint {
    const endpoint = this.getEndpoint(id);
    if (!endpoint) throw new TrackingError(404, "TRACKING_ENDPOINT_NOT_FOUND", "Tracking endpoint not found");
    const terminal = endpoint.claimStatus === "REVOKED" || endpoint.claimStatus === "RETIRED";
    if (terminal || status === "PENDING") {
      throw new TrackingError(409, "INVALID_ENDPOINT_TRANSITION", "Endpoint status transition is not allowed");
    }
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE tracking_endpoints SET claim_status=?, updated_at=? WHERE id=?")
      .run(status, timestamp, id);
    if (status === "REVOKED" || status === "RETIRED") {
      this.db.prepare("UPDATE equipment_tracking_bindings SET valid_to=? WHERE endpoint_id=? AND valid_to IS NULL")
        .run(timestamp, id);
    }
    return this.getEndpoint(id)!;
  }

  touchEndpoint(
    id: string,
    at: string,
    telemetry: Record<string, string | number | boolean | null>,
  ): void {
    const current = this.getEndpoint(id);
    if (!current) return;
    this.db.prepare("UPDATE tracking_endpoints SET last_seen_at=?, telemetry_json=?, updated_at=? WHERE id=?")
      .run(at, JSON.stringify({ ...current.telemetry, ...telemetry }), at, id);
  }

  bindEndpoint(
    equipmentId: string,
    input: EquipmentTrackingBindingInput,
    boundBy: string,
    at = new Date().toISOString(),
  ): EquipmentTrackingBinding {
    const equipment = this.core.getAreaEquipment(equipmentId);
    const endpoint = this.getEndpoint(input.endpointId);
    if (!equipment) throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
    if (!endpoint || endpoint.propertyId !== equipment.propertyId) {
      throw new TrackingError(404, "TRACKING_ENDPOINT_NOT_FOUND", "Tracking endpoint not found");
    }
    if (endpoint.claimStatus !== "CLAIMED" && endpoint.claimStatus !== "DEGRADED") {
      throw new TrackingError(409, "ENDPOINT_NOT_CLAIMED", "Endpoint must be claimed before it can be bound");
    }
    const observerId = input.observerId?.trim() || null;
    if ((endpoint.identityScope === "OBSERVER" && observerId !== endpoint.observerScopeId)
      || (endpoint.identityScope !== "OBSERVER" && observerId !== null)) {
      throw new TrackingError(409, "BINDING_OBSERVER_SCOPE", "Binding observer scope does not match the endpoint");
    }
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO equipment_tracking_bindings(
        id, property_id, equipment_id, endpoint_id, observer_id, valid_from, valid_to, bound_by
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).run(
        id, equipment.propertyId, equipment.id, endpoint.id, observerId, at, requiredText(boundBy, "Binding actor"),
      );
    } catch (error) {
      if (isSqliteFailure(error, "unique")) {
        throw new TrackingError(409, "ACTIVE_BINDING_CONFLICT", "Equipment or endpoint already has an active binding");
      }
      if (isSqliteFailure(error, "trigger", "TRACKING_BINDING_SCOPE")) {
        throw new TrackingError(409, "BINDING_SCOPE_MISMATCH", "Endpoint binding scope is invalid");
      }
      throw error;
    }
    return this.activeBindingForEquipment(equipmentId)!;
  }

  unbindEquipment(equipmentId: string, at = new Date().toISOString()): EquipmentTrackingBinding | null {
    const current = this.activeBindingForEquipment(equipmentId);
    if (!current) return null;
    this.db.prepare("UPDATE equipment_tracking_bindings SET valid_to=? WHERE id=?").run(at, current.id);
    return { ...current, validTo: at };
  }

  activeBindingForEquipment(equipmentId: string): EquipmentTrackingBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM equipment_tracking_bindings WHERE equipment_id=? AND valid_to IS NULL",
    ).get(equipmentId) as unknown as TrackingBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  activeBindingForEndpoint(endpointId: string): EquipmentTrackingBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM equipment_tracking_bindings WHERE endpoint_id=? AND valid_to IS NULL",
    ).get(endpointId) as unknown as TrackingBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  listBindings(propertyId: string, activeOnly = true): EquipmentTrackingBinding[] {
    const sql = `SELECT * FROM equipment_tracking_bindings WHERE property_id=?
      ${activeOnly ? "AND valid_to IS NULL" : ""} ORDER BY valid_from DESC, id`;
    return (this.db.prepare(sql).all(propertyId) as unknown as TrackingBindingRow[]).map(bindingFromRow);
  }

  registerObserver(
    input: TrackingObserverRegisterInput,
    createdByUserId: string | null,
    tenantId = "local",
  ): { observer: TrackingObserver; credential: string } {
    if (!this.core.getProperty(input.propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const mobile = isMobile(input.type);
    const installationId = input.appInstallationId?.trim() || null;
    if (mobile && !installationId) {
      throw new TrackingError(400, "INVALID_FIELD", "Mobile observers require an appInstallationId");
    }
    if (!mobile && !input.fixedPosition && !input.zoneId) {
      throw new TrackingError(400, "INVALID_FIELD", "Fixed gateways require a map position or assigned zone");
    }
    const fixedPosition = input.fixedPosition ? finiteCoordinate(input.fixedPosition, "Observer position") : null;
    const accuracy = input.fixedPositionAccuracyMeters ?? (fixedPosition ? 5 : null);
    if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0.1 || accuracy > 10_000)) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer accuracy must be between 0.1 and 10000 metres");
    }
    if (input.zoneId) this.assertObserverZone(input.propertyId, input.zoneId);
    const trust = input.trustLevel ?? (mobile ? 0.7 : 0.9);
    if (!Number.isFinite(trust) || trust < 0 || trust > 1) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer trust must be from 0 to 1");
    }
    const id = randomUUID();
    const credential = `stugu_observer.${id}.${randomBytes(32).toString("base64url")}`;
    const timestamp = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO tracking_observers(
        id, tenant_id, property_id, type, name, trust_level, fixed_position_json,
        fixed_position_accuracy_meters, zone_id, app_installation_id, created_by_user_id,
        hardware_metadata_json, last_heartbeat_at, status, credential_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'offline', ?, ?, ?)`).run(
        id, tenantId, input.propertyId, input.type, requiredText(input.name, "Observer name"), trust,
        fixedPosition ? JSON.stringify(fixedPosition) : null, accuracy, input.zoneId?.trim() || null,
        installationId, createdByUserId, JSON.stringify(input.hardwareMetadata ?? {}),
        sha256(credential), timestamp, timestamp,
      );
    } catch (error) {
      if (isSqliteFailure(error, "unique")) {
        throw new TrackingError(409, "OBSERVER_INSTALLATION_CONFLICT", "This app installation is already registered");
      }
      throw error;
    }
    return { observer: this.getObserver(id)!, credential };
  }

  getObserver(id: string): TrackingObserver | null {
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?")
      .get(id) as unknown as TrackingObserverRow | undefined;
    return row ? observerFromRow(row) : null;
  }

  observerIdentity(id: string): AuthenticatedTrackingObserver | null {
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?")
      .get(id) as unknown as TrackingObserverRow | undefined;
    return row ? { observer: observerFromRow(row), createdByUserId: row.created_by_user_id } : null;
  }

  listObservers(propertyId: string): TrackingObserver[] {
    return (this.db.prepare("SELECT * FROM tracking_observers WHERE property_id=? ORDER BY name, id")
      .all(propertyId) as unknown as TrackingObserverRow[]).map(observerFromRow);
  }

  updateObserver(id: string, patch: TrackingObserverPatch): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const position = patch.fixedPosition === undefined
      ? current.fixedPosition
      : patch.fixedPosition ? finiteCoordinate(patch.fixedPosition, "Observer position") : null;
    const accuracy = patch.fixedPositionAccuracyMeters === undefined
      ? current.fixedPositionAccuracyMeters
      : patch.fixedPositionAccuracyMeters;
    const zoneId = patch.zoneId === undefined ? current.zoneId : patch.zoneId?.trim() || null;
    if (zoneId) this.assertObserverZone(current.propertyId, zoneId);
    if (!isMobile(current.type) && !position && !zoneId) {
      throw new TrackingError(400, "INVALID_FIELD", "Fixed gateways require a map position or assigned zone");
    }
    const trust = patch.trustLevel ?? current.trustLevel;
    if (!Number.isFinite(trust) || trust < 0 || trust > 1) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer trust must be from 0 to 1");
    }
    const timestamp = new Date().toISOString();
    this.db.prepare(`UPDATE tracking_observers SET name=?, trust_level=?, fixed_position_json=?,
      fixed_position_accuracy_meters=?, zone_id=?, hardware_metadata_json=?, status=?, updated_at=?
      WHERE id=?`).run(
      patch.name === undefined ? current.name : requiredText(patch.name, "Observer name"), trust,
      position ? JSON.stringify(position) : null, position ? accuracy : null, zoneId,
      JSON.stringify(patch.hardwareMetadata ?? current.hardwareMetadata), patch.status ?? current.status,
      timestamp, id,
    );
    return this.getObserver(id)!;
  }

  authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null {
    const match = credential.match(/^stugu_observer\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/iu);
    if (!match) return null;
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?")
      .get(match[1]!) as unknown as TrackingObserverRow | undefined;
    if (!row || row.status === "disabled" || !credentialMatches(sha256(credential), row.credential_hash)) return null;
    return { observer: observerFromRow(row), createdByUserId: row.created_by_user_id };
  }

  heartbeatObserver(
    id: string,
    input: { status?: TrackingObserver["status"]; hardwareMetadata?: TrackingObserver["hardwareMetadata"] },
    at = new Date().toISOString(),
  ): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const status = input.status === "degraded"
      ? "degraded"
      : input.status === "disabled"
        ? "disabled"
        : "online";
    this.db.prepare(`UPDATE tracking_observers SET status=?, hardware_metadata_json=?,
      last_heartbeat_at=?, updated_at=? WHERE id=?`).run(
      status, JSON.stringify(input.hardwareMetadata ?? current.hardwareMetadata), at, at, id,
    );
    return this.getObserver(id)!;
  }

  updateObserverPosition(
    id: string,
    position: { latitude: number; longitude: number },
    accuracyMeters: number,
    zoneId: string | null,
  ): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const coordinate = finiteCoordinate(position, "Observer position");
    if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0.1 || accuracyMeters > 10_000) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer accuracy must be between 0.1 and 10000 metres");
    }
    if (zoneId) this.assertObserverZone(current.propertyId, zoneId);
    const timestamp = new Date().toISOString();
    this.db.prepare(`UPDATE tracking_observers SET fixed_position_json=?,
      fixed_position_accuracy_meters=?, zone_id=?, updated_at=? WHERE id=?`).run(
      JSON.stringify(coordinate), accuracyMeters, zoneId, timestamp, id,
    );
    return this.getObserver(id)!;
  }

  refreshGatewayHealth(now = new Date(), timeoutSeconds = 90): TrackingObserver[] {
    const rows = this.db.prepare(`SELECT * FROM tracking_observers
      WHERE type IN ('esp32-gateway','linux-gateway','android-gateway') AND status <> 'disabled'`)
      .all() as unknown as TrackingObserverRow[];
    const changed: TrackingObserver[] = [];
    for (const row of rows) {
      const online = row.last_heartbeat_at
        && now.getTime() - Date.parse(row.last_heartbeat_at) <= timeoutSeconds * 1_000;
      const next = online ? (row.status === "degraded" ? "degraded" : "online") : "offline";
      if (next === row.status) continue;
      this.db.prepare("UPDATE tracking_observers SET status=?, updated_at=? WHERE id=?")
        .run(next, now.toISOString(), row.id);
      changed.push(this.getObserver(row.id)!);
    }
    return changed;
  }

  activePropertyIds(): string[] {
    return (this.db.prepare(`SELECT property_id FROM tracking_endpoints WHERE claim_status IN ('CLAIMED','DEGRADED')
      UNION SELECT property_id FROM tracking_observers WHERE status <> 'disabled'
      UNION SELECT property_id FROM property_member_locations ORDER BY property_id`)
      .all() as Array<{ property_id: string }>).map((row) => row.property_id);
  }

  trackedEquipment(propertyId: string): TrackedEquipmentState[] {
    const equipmentRecords = [];
    for (let offset = 0; ; offset += TRACKED_EQUIPMENT_PAGE_SIZE) {
      const page = this.core.listAreaEquipment({ propertyId, limit: TRACKED_EQUIPMENT_PAGE_SIZE, offset });
      equipmentRecords.push(...page);
      if (equipmentRecords.length > MAX_TRACKED_EQUIPMENT) {
        throw new TrackingError(413, "COLLECTION_TOO_LARGE", "Property contains too many equipment records");
      }
      if (page.length < TRACKED_EQUIPMENT_PAGE_SIZE) break;
    }
    return equipmentRecords.flatMap((equipment) => {
      const binding = this.activeBindingForEquipment(equipment.id);
      const endpoint = binding ? this.getEndpoint(binding.endpointId) : null;
      if (!binding || !endpoint) return [];
      return [{
        equipment,
        endpoint,
        binding,
        position: this.evidence.currentPosition(equipment.id, this.dataMode()),
      }];
    });
  }

  private assertObserverZone(propertyId: string, zoneId: string): void {
    const zone = this.core.getPropertyArea(zoneId);
    if (!zone || zone.propertyId !== propertyId) {
      throw new TrackingError(409, "OBSERVER_ZONE_SCOPE", "Observer zone must belong to the selected Property");
    }
  }
}
