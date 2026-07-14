import { useEffect, useState, type FormEvent } from "react";
import { Building2, ChevronDown, ChevronUp, Copy, Layers3, Plus, Trash2 } from "lucide-react";
import type { Floor, FloorType, House, PlanElement, Sensor } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";

export type CreateHouseInput = Pick<House, "name" | "timezone" | "floors">;

interface StructureEditorProps {
  houses: House[];
  house: House;
  floor: Floor;
  sensors: Sensor[];
  onHouseSelect: (houseId: string) => void;
  onFloorSelect: (floorId: string) => void;
  onHouseChange?: (house: House) => void;
  onHouseSave?: (house: House) => void | Promise<void>;
  onHouseCreate?: (input: CreateHouseInput) => Promise<House>;
  onHouseDelete?: (houseId: string) => Promise<void>;
}

export const FLOOR_TYPES: FloorType[] = ["basement", "ground", "upper", "attic", "mezzanine", "outdoor"];

export function inferredFloorType(floor: Floor): FloorType {
  if (floor.type) return floor.type;
  const name = floor.name.toLowerCase();
  if (name.includes("basement") || name.includes("cellar")) return "basement";
  if (name.includes("attic") || name.includes("loft")) return "attic";
  if (name.includes("mezzanine")) return "mezzanine";
  if (name.includes("terrace") || name.includes("garden") || name.includes("outdoor")) return "outdoor";
  if (floor.elevation <= 0) return "ground";
  return "upper";
}

function defaultFloorName(type: FloorType, index: number): string {
  if (type === "upper" && index > 1) return `Upper floor ${index}`;
  return {
    basement: "Basement",
    ground: "Ground floor",
    upper: "Upper floor",
    attic: "Attic",
    mezzanine: "Mezzanine",
    outdoor: "Outdoor level",
  }[type];
}

function nextElevation(house: House, type: FloorType): number {
  if (type === "basement") {
    const lowest = Math.min(0, ...house.floors.map((item) => item.elevation));
    return Number((lowest - 2.6).toFixed(1));
  }
  if (type === "ground" || type === "outdoor") return 0;
  const highest = house.floors.reduce((current, item) => item.elevation > current.elevation ? item : current, house.floors[0]!);
  return Number((highest.elevation + (highest.ceilingHeight ?? 2.8) + .2).toFixed(1));
}

function blankFloor(type: FloorType, name: string, house: House, reference: Floor): Floor {
  return {
    id: crypto.randomUUID(),
    name,
    type,
    width: reference.width,
    height: reference.height,
    elevation: nextElevation(house, type),
    ceilingHeight: type === "attic" ? 2.4 : type === "outdoor" ? 2.8 : 2.8,
    walls: [],
    rooms: [],
    planElements: [],
  };
}

function copyFloor(source: Floor, house: House): Floor {
  const nextType: FloorType = inferredFloorType(source) === "ground" ? "upper" : inferredFloorType(source);
  const wallIdMap = new Map(source.walls.map((wall) => [wall.id, crypto.randomUUID()]));
  return {
    ...source,
    id: crypto.randomUUID(),
    name: `${source.name} copy`,
    type: nextType,
    elevation: nextElevation(house, nextType),
    walls: source.walls.map((wall) => ({ ...wall, id: wallIdMap.get(wall.id)!, from: { ...wall.from }, to: { ...wall.to } })),
    rooms: source.rooms.map((room) => ({ ...room, id: crypto.randomUUID(), points: room.points.map((point) => ({ ...point })) })),
    planElements: source.planElements?.map((element): PlanElement => {
      if (element.kind !== "door" && element.kind !== "window") {
        return { ...element, id: crypto.randomUUID(), position: { ...element.position } };
      }
      return {
        ...element,
        id: crypto.randomUUID(),
        position: { ...element.position },
        wallId: wallIdMap.get(element.wallId) ?? element.wallId,
      };
    }) ?? [],
  };
}

export function StructureEditor({
  houses, house, floor, sensors, onHouseSelect, onFloorSelect, onHouseChange, onHouseSave, onHouseCreate, onHouseDelete,
}: StructureEditorProps) {
  const { t } = useI18n();
  const [addingHouse, setAddingHouse] = useState(false);
  const [addingFloor, setAddingFloor] = useState(false);
  const [newHouseName, setNewHouseName] = useState("");
  const [newFloorType, setNewFloorType] = useState<FloorType>("upper");
  const [newFloorName, setNewFloorName] = useState(defaultFloorName("upper", house.floors.length));
  const [creating, setCreating] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [confirmDeleteHouse, setConfirmDeleteHouse] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const floorSensors = sensors.filter((sensor) => sensor.houseId === house.id && sensor.floorId === floor.id);
  const geometryPoints = [
    ...floor.walls.flatMap((wall) => [wall.from, wall.to]),
    ...floor.rooms.flatMap((room) => room.points),
    ...(floor.planElements ?? []).map((element) => element.position),
  ];
  const minimumWidth = Math.max(1, ...floorSensors.map((sensor) => Math.ceil(sensor.x)), ...geometryPoints.map((point) => Math.ceil(point.x)));
  const minimumHeight = Math.max(1, ...floorSensors.map((sensor) => Math.ceil(sensor.y)), ...geometryPoints.map((point) => Math.ceil(point.y)));

  useEffect(() => {
    setConfirmDeleteHouse(false);
    setAddingFloor(false);
    setMutationError(null);
  }, [house.id]);

  useEffect(() => {
    setNewFloorName(defaultFloorName(newFloorType, house.floors.length));
  }, [newFloorType, house.floors.length]);

  const changeHouse = (patch: Partial<House>) => {
    if (!onHouseChange) return;
    onHouseChange({ ...house, ...patch, updatedAt: new Date().toISOString() });
  };

  const changeFloor = (patch: Partial<Floor>) => {
    changeHouse({ floors: house.floors.map((item) => item.id === floor.id ? { ...item, ...patch } : item) });
  };

  const submitHouse = async (event: FormEvent) => {
    event.preventDefault();
    const name = newHouseName.trim();
    if (!name || !onHouseCreate) return;
    setCreating(true);
    setMutationError(null);
    try {
      const initialFloor: Floor = {
        id: crypto.randomUUID(), name: defaultFloorName("ground", 0), type: "ground",
        width: floor.width, height: floor.height, elevation: 0, ceilingHeight: 2.8, walls: [], rooms: [], planElements: [],
      };
      const created = await onHouseCreate({
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || house.timezone || "UTC",
        floors: [initialFloor],
      });
      setAddingHouse(false);
      setNewHouseName("");
      onHouseSelect(created.id);
      onFloorSelect(created.floors[0]!.id);
    } catch {
      setMutationError(t("structure.createError"));
    } finally {
      setCreating(false);
    }
  };

  const saveHouseName = async (event: FormEvent) => {
    event.preventDefault();
    const name = house.name.trim();
    if (!name || !onHouseSave) return;
    const nextHouse = name === house.name ? house : { ...house, name, updatedAt: new Date().toISOString() };
    if (nextHouse !== house) onHouseChange?.(nextHouse);
    setSavingName(true);
    setMutationError(null);
    try {
      await onHouseSave(nextHouse);
    } catch {
      setMutationError(t("structure.renameError"));
    } finally {
      setSavingName(false);
    }
  };

  const addFloor = (event: FormEvent) => {
    event.preventDefault();
    const name = newFloorName.trim() || defaultFloorName(newFloorType, house.floors.length);
    const created = blankFloor(newFloorType, name, house, floor);
    changeHouse({ floors: [...house.floors, created] });
    setAddingFloor(false);
    onFloorSelect(created.id);
  };

  const duplicateFloor = () => {
    const created = copyFloor(floor, house);
    const index = house.floors.findIndex((item) => item.id === floor.id);
    const next = house.floors.slice();
    next.splice(index + 1, 0, created);
    changeHouse({ floors: next });
    onFloorSelect(created.id);
  };

  const deleteFloor = () => {
    if (house.floors.length <= 1 || floorSensors.length > 0) return;
    const index = house.floors.findIndex((item) => item.id === floor.id);
    const next = house.floors.filter((item) => item.id !== floor.id);
    changeHouse({ floors: next });
    onFloorSelect(next[Math.max(0, index - 1)]!.id);
  };

  const moveFloor = (direction: -1 | 1) => {
    const index = house.floors.findIndex((item) => item.id === floor.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= house.floors.length) return;
    const next = house.floors.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    changeHouse({ floors: next });
  };

  const removeHouse = async () => {
    if (!onHouseDelete || houses.length <= 1) return;
    setMutationError(null);
    try {
      await onHouseDelete(house.id);
    } catch {
      setMutationError(t("structure.deleteError"));
      setConfirmDeleteHouse(false);
    }
  };

  return (
    <aside className="structure-editor" aria-label={t("structure.title")}>
      <div className="structure-scroll">
        <section className="structure-section">
          <div className="structure-section-heading">
            <div><span className="eyebrow">{t("structure.properties")}</span><strong>{t("structure.title")}</strong></div>
            <span className="count-badge">{houses.length}</span>
          </div>
          <label className="field compact-field"><span>{t("structure.activeProperty")}</span><select value={house.id} onChange={(event) => onHouseSelect(event.target.value)}>{houses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className="structure-add-button" onClick={() => setAddingHouse((value) => !value)} aria-expanded={addingHouse}><Plus size={15} aria-hidden="true" />{t("structure.addProperty")}</button>
          {mutationError && <p className="structure-error" role="alert">{mutationError}</p>}
          {addingHouse && (
            <form className="structure-inline-form" onSubmit={submitHouse}>
              <label className="field compact-field"><span>{t("structure.propertyName")}</span><input autoFocus required value={newHouseName} onChange={(event) => setNewHouseName(event.target.value)} placeholder={t("structure.propertyPlaceholder")} /></label>
              <div className="inline-form-actions"><button type="button" className="text-button" onClick={() => setAddingHouse(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={creating || !onHouseCreate}>{creating ? t("structure.creating") : t("common.add")}</button></div>
            </form>
          )}
          <form className="structure-name-form" onSubmit={saveHouseName}>
            <label className="field compact-field"><span>{t("structure.propertyName")}</span><span className="input-with-icon"><Building2 size={15} aria-hidden="true" /><input required value={house.name} disabled={!onHouseChange} onChange={(event) => changeHouse({ name: event.target.value })} /></span></label>
            <button type="submit" className="secondary-button" disabled={savingName || !onHouseSave || !house.name.trim()}>{savingName ? t("common.saving") : t("structure.saveName")}</button>
          </form>
        </section>

        <section className="structure-section level-section">
          <div className="structure-section-heading"><div><span className="eyebrow">{t("structure.levels")}</span><strong>{t("structure.organiseLevels")}</strong></div><button type="button" className="icon-button small" aria-label={t("structure.addLevel")} onClick={() => setAddingFloor((value) => !value)}><Plus size={16} aria-hidden="true" /></button></div>
          {addingFloor && (
            <form className="structure-inline-form" onSubmit={addFloor}>
              <label className="field compact-field"><span>{t("structure.levelType")}</span><select value={newFloorType} onChange={(event) => setNewFloorType(event.target.value as FloorType)}>{FLOOR_TYPES.map((type) => <option key={type} value={type}>{t(`floorType.${type}` as TranslationKey)}</option>)}</select></label>
              <label className="field compact-field"><span>{t("structure.levelName")}</span><input required value={newFloorName} onChange={(event) => setNewFloorName(event.target.value)} /></label>
              <div className="inline-form-actions"><button type="button" className="text-button" onClick={() => setAddingFloor(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={!onHouseChange}>{t("structure.addLevel")}</button></div>
            </form>
          )}
          <div className="level-list" role="list" aria-label={t("structure.levels")}>
            {house.floors.map((item) => {
              const type = inferredFloorType(item);
              const sensorCount = sensors.filter((sensor) => sensor.houseId === house.id && sensor.floorId === item.id).length;
              return (
                <div key={item.id} role="listitem">
                  <button type="button" className={`level-card ${item.id === floor.id ? "active" : ""}`} aria-current={item.id === floor.id ? "true" : undefined} onClick={() => onFloorSelect(item.id)}>
                    <span className={`level-glyph ${type}`}><Layers3 size={16} aria-hidden="true" /></span>
                    <span><strong>{item.name}</strong><small>{t(`floorType.${type}` as TranslationKey)} · {item.elevation.toFixed(1)} m</small></span>
                    <span className="level-sensor-count">{sensorCount}</span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="level-actions" aria-label={t("structure.levelActions")}>
            <button type="button" className="icon-button small" aria-label={t("structure.moveUp")} onClick={() => moveFloor(-1)} disabled={house.floors[0]?.id === floor.id}><ChevronUp size={15} aria-hidden="true" /></button>
            <button type="button" className="icon-button small" aria-label={t("structure.moveDown")} onClick={() => moveFloor(1)} disabled={house.floors.at(-1)?.id === floor.id}><ChevronDown size={15} aria-hidden="true" /></button>
            <button type="button" className="icon-button small" aria-label={t("structure.duplicateLevel")} onClick={duplicateFloor}><Copy size={14} aria-hidden="true" /></button>
            <button type="button" className="icon-button small danger-icon" aria-label={t("structure.deleteLevel")} onClick={deleteFloor} disabled={house.floors.length <= 1 || floorSensors.length > 0} title={floorSensors.length ? t("structure.moveSensorsFirst") : undefined}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        </section>

        <section className="structure-section level-properties">
          <div className="structure-section-heading"><div><span className="eyebrow">{t("structure.selectedLevel")}</span><strong>{floor.name}</strong></div></div>
          <label className="field compact-field"><span>{t("structure.levelName")}</span><input value={floor.name} disabled={!onHouseChange} onChange={(event) => changeFloor({ name: event.target.value })} /></label>
          <label className="field compact-field"><span>{t("structure.levelType")}</span><select value={inferredFloorType(floor)} disabled={!onHouseChange} onChange={(event) => changeFloor({ type: event.target.value as FloorType })}>{FLOOR_TYPES.map((type) => <option key={type} value={type}>{t(`floorType.${type}` as TranslationKey)}</option>)}</select></label>
          <div className="structure-number-grid">
            <label className="field compact-field"><span>{t("structure.elevation")}</span><span className="input-suffix"><input type="number" step="0.1" value={floor.elevation} disabled={!onHouseChange} onChange={(event) => changeFloor({ elevation: Number(event.target.value) })} /><span>m</span></span></label>
            <label className="field compact-field"><span>{t("structure.ceilingHeight")}</span><span className="input-suffix"><input type="number" min="1" step="0.1" value={floor.ceilingHeight ?? 2.8} disabled={!onHouseChange} onChange={(event) => changeFloor({ ceilingHeight: Number(event.target.value) })} /><span>m</span></span></label>
            <label className="field compact-field"><span>{t("structure.planWidth")}</span><input type="number" min={minimumWidth} step="1" value={floor.width} disabled={!onHouseChange} onChange={(event) => changeFloor({ width: Number(event.target.value) })} /></label>
            <label className="field compact-field"><span>{t("structure.planDepth")}</span><input type="number" min={minimumHeight} step="1" value={floor.height} disabled={!onHouseChange} onChange={(event) => changeFloor({ height: Number(event.target.value) })} /></label>
          </div>
          <p className="structure-help">{t("structure.levelHelp")}</p>
        </section>
      </div>

      <div className="structure-danger-zone">
        {confirmDeleteHouse ? <><p>{t("structure.deletePropertyConfirm", { house: house.name })}</p><div className="inline-form-actions"><button type="button" className="text-button" onClick={() => setConfirmDeleteHouse(false)}>{t("common.cancel")}</button><button type="button" className="danger-button" onClick={() => void removeHouse()}>{t("structure.deleteProperty")}</button></div></> : <button type="button" className="text-button danger-text" disabled={houses.length <= 1 || !onHouseDelete} onClick={() => setConfirmDeleteHouse(true)}><Trash2 size={14} aria-hidden="true" />{t("structure.deleteProperty")}</button>}
        {houses.length <= 1 && <p className="structure-constraint">{t("structure.lastPropertyHint")}</p>}
      </div>
    </aside>
  );
}
