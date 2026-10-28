import type { AreaEquipment, MaintenanceTask, Property, PropertyNote } from "@climate-twin/contracts";
import { ClimateDatabase } from "../../db.js";
import type { LocalRequestPrincipal } from "./local-sessions.js";

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
