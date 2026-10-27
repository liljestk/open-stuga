import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { type NextFunction, type Request, type Response } from "express";
import type {
  AreaEquipment,
  MaintenanceTask,
  Property,
  PropertyNote,
} from "@climate-twin/contracts";
import { type AppConfig } from "../../config.js";
import {
  ClimateDatabase,
} from "../../db.js";
import {
  type AppleNotesGrantSecret,
} from "../../integration-secrets.js";
import {
  RuntimeStatus,
} from "../../services.js";
import { HttpError } from "./part-01.js";
import { keyMatches, requestPrincipal, trustedProxyRequest } from "./part-04.js";
import type { LocalRequestPrincipal } from "./part-04.js";
import { roleCanAccessNonGuestConfiguration } from "../access-policy.js";

export function requireNonGuest(_request: Request, response: Response, next: NextFunction): void {
  if (!roleCanAccessNonGuestConfiguration(requestPrincipal(response).role)) {
    next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot access administrative configuration"));
    return;
  }
  next();
}

export class LocalVisibility {
  readonly #propertyIds = new Set<string>();
  readonly #houseIds = new Set<string>();
  readonly #areaIds = new Set<string>();
  readonly #derivedPropertyIds = new Set<string>();
  readonly #houseAccess = new Map<string, boolean>();
  readonly #areaAccess = new Map<string, boolean>();
  readonly #equipmentAccess = new Map<string, boolean>();
  readonly #sensorAccess = new Map<string, boolean>();

  constructor(
    private readonly database: ClimateDatabase,
    private readonly principal: LocalRequestPrincipal,
  ) {
    for (const grant of principal.grants) {
      if (grant.scopeType === "property") this.#propertyIds.add(grant.scopeId);
      else if (grant.scopeType === "house") {
        this.#houseIds.add(grant.scopeId);
        const house = database.getHouse(grant.scopeId);
        if (house) this.#derivedPropertyIds.add(house.propertyId);
      } else {
        this.#areaIds.add(grant.scopeId);
        const area = database.getPropertyArea(grant.scopeId);
        if (area) this.#derivedPropertyIds.add(area.propertyId);
      }
    }
  }

  get restricted(): boolean { return this.principal.role === "guest"; }

  hasProperty(propertyId: string): boolean {
    return !this.restricted || this.#propertyIds.has(propertyId);
  }

  property(property: Property): Property | null {
    if (!this.restricted || this.#propertyIds.has(property.id)) return property;
    if (!this.#derivedPropertyIds.has(property.id)) return null;
    const defaultHouseId = property.defaultHouseId && this.house(property.defaultHouseId)
      ? property.defaultHouseId
      : null;
    return { ...property, description: null, defaultHouseId, location: null };
  }

  house(houseId: string): boolean {
    const cached = this.#houseAccess.get(houseId);
    if (cached !== undefined) return cached;
    const house = this.database.getHouse(houseId);
    const allowed = Boolean(house && (!this.restricted
      || this.#propertyIds.has(house.propertyId)
      || this.#houseIds.has(houseId)));
    this.#houseAccess.set(houseId, allowed);
    return allowed;
  }

  area(areaId: string): boolean {
    if (!this.restricted) return true;
    const cached = this.#areaAccess.get(areaId);
    if (cached !== undefined) return cached;
    const area = this.database.getPropertyArea(areaId);
    const allowed = Boolean(area && (this.#propertyIds.has(area.propertyId) || this.#areaIds.has(areaId)));
    this.#areaAccess.set(areaId, allowed);
    return allowed;
  }

  equipment(equipment: AreaEquipment): boolean {
    if (!this.restricted) return true;
    const cached = this.#equipmentAccess.get(equipment.id);
    if (cached !== undefined) return cached;
    const allowed = this.#propertyIds.has(equipment.propertyId)
      || Boolean(equipment.areaId && this.area(equipment.areaId))
      || Boolean(equipment.houseId && this.house(equipment.houseId));
    this.#equipmentAccess.set(equipment.id, allowed);
    return allowed;
  }

  sensor(sensorId: string): boolean {
    const cached = this.#sensorAccess.get(sensorId);
    if (cached !== undefined) return cached;
    const sensor = this.database.getSensor(sensorId);
    const allowed = Boolean(sensor && this.house(sensor.houseId));
    this.#sensorAccess.set(sensorId, allowed);
    return allowed;
  }

  note(note: PropertyNote): boolean {
    if (!this.restricted || this.#propertyIds.has(note.propertyId)) return true;
    if (note.houseId) return this.house(note.houseId);
    if (note.areaId) return this.area(note.areaId);
    if (note.equipmentId) {
      const equipment = this.database.getAreaEquipment(note.equipmentId);
      return Boolean(equipment && this.equipment(equipment));
    }
    return false;
  }

  maintenance(task: MaintenanceTask): boolean {
    if (!this.restricted || this.#propertyIds.has(task.propertyId)) return true;
    const hasHouseContext = Boolean(task.houseId);
    const hasAreaContext = Boolean(task.areaId || task.equipmentId);
    if (!hasHouseContext && !hasAreaContext) return false;
    if (task.houseId && !this.house(task.houseId)) return false;
    if (task.areaId && !this.area(task.areaId)) return false;
    if (task.equipmentId) {
      const equipment = this.database.getAreaEquipment(task.equipmentId);
      if (!equipment || !this.equipment(equipment)) return false;
    }
    return true;
  }
}

export interface AuthAttemptBucket {
  attempts: number;
  active: number;
  resetAt: number;
}

export interface AuthAttemptLimit {
  key: string;
  maxAttempts: number;
  maxActive: number;
}

export class AuthAbuseLimiter {
  readonly #buckets = new Map<string, AuthAttemptBucket>();
  #active = 0;

  enter(limits: readonly AuthAttemptLimit[], response: Response): (forgiveAttempt?: boolean) => void {
    const now = Date.now();
    this.prune(now);
    const uniqueLimits = [...new Map(limits.map((limit) => [limit.key, limit])).values()];
    const entries = uniqueLimits.map((limit) => {
      let bucket = this.#buckets.get(limit.key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { attempts: 0, active: 0, resetAt: now + 60_000 };
        this.#buckets.set(limit.key, bucket);
      }
      return { bucket, limit };
    });
    const limited = entries.find(({ bucket, limit }) => (
      bucket.attempts >= limit.maxAttempts || bucket.active >= limit.maxActive
    ));
    if (limited || this.#active >= 4) {
      const retrySeconds = limited && limited.bucket.attempts >= limited.limit.maxAttempts
        ? Math.max(1, Math.ceil((limited.bucket.resetAt - now) / 1_000))
        : 1;
      response.setHeader("retry-after", String(retrySeconds));
      throw new HttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts; try again later");
    }
    for (const { bucket } of entries) {
      bucket.attempts += 1;
      bucket.active += 1;
    }
    this.#active += 1;
    let released = false;
    return (forgiveAttempt = false) => {
      if (released) return;
      released = true;
      for (const { bucket } of entries) {
        bucket.active = Math.max(0, bucket.active - 1);
        if (forgiveAttempt) bucket.attempts = Math.max(0, bucket.attempts - 1);
      }
      this.#active = Math.max(0, this.#active - 1);
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && bucket.active === 0) this.#buckets.delete(key);
    }
    if (this.#buckets.size <= 10_000) return;
    for (const key of this.#buckets.keys()) {
      this.#buckets.delete(key);
      if (this.#buckets.size <= 10_000) break;
    }
  }
}

export function trustedProxyClientAddress(request: Request, config: AppConfig): string | null {
  if (!config.localAuthProxyBindAddress
    || !trustedProxyRequest(request, config)) return null;
  const candidate = request.header("x-real-ip")?.trim().toLowerCase();
  if (!candidate || candidate.includes(",") || isIP(candidate.replace(/^::ffff:/, "")) === 0) return null;
  return candidate.replace(/^::ffff:/, "");
}

export function authAttemptKeys(request: Request, config: AppConfig, kind: string, subject: unknown): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  const normalized = typeof subject === "string" ? subject.trim().toLowerCase() : "invalid";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return [
    { key: `auth:${address}:*`, maxAttempts: 60, maxActive: 4 },
    { key: `${kind}:subject:${digest}`, maxAttempts: 8, maxActive: 2 },
  ];
}

export function trackingObserverAttemptKeys(
  request: Request,
  config: AppConfig,
  credential: string,
): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  const digest = createHash("sha256").update(credential).digest("hex").slice(0, 24);
  return [
    { key: `tracking-observer:${address}:*`, maxAttempts: 240, maxActive: 4 },
    { key: `tracking-observer:credential:${digest}`, maxAttempts: 120, maxActive: 2 },
  ];
}

export function appleNotesGrant(request: Request, config: AppConfig): AppleNotesGrantSecret {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match) throw new HttpError(401, "APPLE_NOTES_UNAUTHORIZED", "A valid Apple Notes Shortcut bearer token is required");
  const tokenHash = `sha256:${createHash("sha256").update(match[1]!).digest("hex")}`;
  let grant: AppleNotesGrantSecret | undefined;
  for (const candidate of config.appleNotesGrants) {
    if (keyMatches(tokenHash, candidate.tokenHash)) grant = candidate;
  }
  if (!grant) throw new HttpError(401, "APPLE_NOTES_UNAUTHORIZED", "A valid Apple Notes Shortcut bearer token is required");
  return grant;
}

export function appleNotesGrantSummary(grant: AppleNotesGrantSecret): Omit<AppleNotesGrantSecret, "tokenHash"> {
  const { tokenHash: _tokenHash, ...summary } = grant;
  return summary;
}

export function refreshAppleNotesStatus(config: AppConfig, status: RuntimeStatus): void {
  const appleNotes = status.value.appleNotes!;
  appleNotes.configured = config.appleNotesGrants.length > 0;
  appleNotes.grantCount = config.appleNotesGrants.length;
  appleNotes.error = null;
  status.changed();
}

export function notePlainLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function noteTaskBlock(task: MaintenanceTask): string {
  const schedule = task.dueBy
    ? `due ${task.dueBy}`
    : task.plannedFor ? `planned ${task.plannedFor}` : "no date";
  const lines = [
    `• ${notePlainLine(task.title)}`,
    `  Status: ${task.status}; priority: ${task.priority}; ${schedule}`,
    `  Basis: ${task.basis}${task.basisDetail ? ` — ${notePlainLine(task.basisDetail)}` : ""}`,
    ...(task.description ? [`  Details: ${notePlainLine(task.description)}`] : []),
  ];
  return lines.join("\n");
}
