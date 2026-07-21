import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Building2, ChevronDown, ChevronUp, Copy, Layers3, Plus, Trash2 } from "lucide-react";
import { floorMetersPerPlanUnit, type Floor, type FloorType, type House, type PlanElement, type RoofDesign, type RoofStyle, type Sensor } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { DEFAULT_ROOF_DESIGN, roofPeakZ } from "../architecturalGeometry";

export type CreateHouseInput = Pick<House, "name" | "timezone" | "floors"> & Partial<Pick<House, "propertyId">>;

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

function ProgressiveDisclosure({
  className,
  summaryClassName,
  summary,
  children,
}: {
  className: string;
  summaryClassName: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} open={open}>
      <summary className={summaryClassName} onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>{summary}</summary>
      <div hidden={!open}>{children}</div>
    </details>
  );
}

export const FLOOR_TYPES: FloorType[] = ["basement", "ground", "upper", "attic", "mezzanine", "outdoor"];
const ROOF_STYLES: RoofStyle[] = ["gable", "hip", "shed", "flat"];

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
  const highestTop = Math.max(...house.floors.map((item) => item.roof
    ? roofPeakZ(item)
    : item.elevation + (item.wallHeight ?? item.ceilingHeight ?? 2.8)));
  return Number((highestTop + .2).toFixed(1));
}

function blankFloor(type: FloorType, name: string, house: House, reference: Floor): Floor {
  const wallHeight = type === "attic" ? .9 : 2.8;
  return {
    id: crypto.randomUUID(),
    name,
    type,
    width: reference.width,
    height: reference.height,
    ...(reference.metersPerPlanUnit ? { metersPerPlanUnit: reference.metersPerPlanUnit } : {}),
    elevation: nextElevation(house, type),
    ceilingHeight: type === "attic" ? 2.4 : type === "outdoor" ? 2.8 : 2.8,
    wallHeight,
    ...(type === "attic" ? { roof: { ...DEFAULT_ROOF_DESIGN, eavesHeight: wallHeight } } : {}),
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
      if (element.kind !== "door" && element.kind !== "window" && element.kind !== "fireEscape") {
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
  const { locale, t } = useI18n();
  const [addingHouse, setAddingHouse] = useState(false);
  const [addingFloor, setAddingFloor] = useState(false);
  const [newHouseName, setNewHouseName] = useState("");
  const [newFloorType, setNewFloorType] = useState<FloorType>("upper");
  const [newFloorName, setNewFloorName] = useState(defaultFloorName("upper", house.floors.length));
  const [creating, setCreating] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [deletingHouse, setDeletingHouse] = useState(false);
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
  const horizontalScale = floorMetersPerPlanUnit(floor, house);
  const physicalFootprint = horizontalScale === null ? null : {
    width: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(floor.width * horizontalScale),
    depth: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(floor.height * horizontalScale),
    scale: new Intl.NumberFormat(locale, { maximumFractionDigits: 5 }).format(horizontalScale),
  };

  useEffect(() => {
    setConfirmDeleteHouse(false);
    setAddingFloor(false);
    setDeletingHouse(false);
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

  const changeRoof = (patch: Partial<RoofDesign>) => {
    if (!floor.roof) return;
    changeFloor({ roof: { ...floor.roof, ...patch } });
  };

  const changeWallHeight = (wallHeight: number) => {
    changeFloor({
      wallHeight,
      ...(floor.roof && (floor.ceilingHeight ?? 0) < wallHeight ? { ceilingHeight: wallHeight } : {}),
      ...(floor.roof ? { roof: { ...floor.roof, eavesHeight: wallHeight } } : {}),
    });
  };

  const removeRoof = () => {
    changeHouse({ floors: house.floors.map((item) => {
      if (item.id !== floor.id) return item;
      const { roof: _roof, ...withoutRoof } = item;
      return withoutRoof;
    }) });
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
        width: floor.width, height: floor.height, elevation: 0, ceilingHeight: 2.8, wallHeight: 2.8, walls: [], rooms: [], planElements: [],
      };
      const created = await onHouseCreate({
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || house.timezone || "UTC",
        floors: [initialFloor],
        ...(house.propertyId ? { propertyId: house.propertyId } : {}),
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
    if (!onHouseChange || house.floors.length <= 1 || floorSensors.length > 0) return;
    const index = house.floors.findIndex((item) => item.id === floor.id);
    const next = house.floors.filter((item) => item.id !== floor.id);
    changeHouse({ floors: next });
    onFloorSelect(next[Math.max(0, index - 1)]!.id);
  };

  const moveFloor = (direction: -1 | 1) => {
    if (!onHouseChange) return;
    const index = house.floors.findIndex((item) => item.id === floor.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= house.floors.length) return;
    const next = house.floors.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    changeHouse({ floors: next });
  };

  const removeHouse = async () => {
    if (!onHouseDelete || deletingHouse) return;
    setDeletingHouse(true);
    setMutationError(null);
    try {
      await onHouseDelete(house.id);
    } catch {
      setMutationError(t("structure.deleteError"));
      setConfirmDeleteHouse(false);
    } finally {
      setDeletingHouse(false);
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
          {mutationError && <p className="structure-error" role="alert">{mutationError}</p>}
          <ProgressiveDisclosure className="structure-disclosure property-management" summaryClassName="structure-disclosure-summary" summary={t("structure.manageProperties")}>
            <div className="structure-disclosure-content">
              <button type="button" className="structure-add-button" disabled={!onHouseCreate} onClick={() => setAddingHouse((value) => !value)} aria-expanded={addingHouse}><Plus size={15} aria-hidden="true" />{t("structure.addProperty")}</button>
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
            </div>
          </ProgressiveDisclosure>
        </section>

        <section className="structure-section level-section">
          <div className="structure-section-heading"><div><span className="eyebrow">{t("structure.levels")}</span><strong>{t("structure.organiseLevels")}</strong></div></div>
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
          <ProgressiveDisclosure className="structure-disclosure level-management" summaryClassName="structure-disclosure-summary" summary={t("structure.levelActions")}>
            <div className="structure-disclosure-content">
              <button type="button" className="structure-add-button" disabled={!onHouseChange} aria-expanded={addingFloor} onClick={() => setAddingFloor((value) => !value)}><Plus size={16} aria-hidden="true" />{t("structure.addLevel")}</button>
              {addingFloor && (
                <form className="structure-inline-form" onSubmit={addFloor}>
                  <label className="field compact-field"><span>{t("structure.levelType")}</span><select value={newFloorType} onChange={(event) => setNewFloorType(event.target.value as FloorType)}>{FLOOR_TYPES.map((type) => <option key={type} value={type}>{t(`floorType.${type}` as TranslationKey)}</option>)}</select></label>
                  <label className="field compact-field"><span>{t("structure.levelName")}</span><input required value={newFloorName} onChange={(event) => setNewFloorName(event.target.value)} /></label>
                  <div className="inline-form-actions"><button type="button" className="text-button" onClick={() => setAddingFloor(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={!onHouseChange}>{t("structure.addLevel")}</button></div>
                </form>
              )}
              <div className="level-actions" aria-label={t("structure.levelActions")}>
                <button type="button" className="icon-button small" aria-label={t("structure.moveUp")} onClick={() => moveFloor(-1)} disabled={!onHouseChange || house.floors[0]?.id === floor.id}><ChevronUp size={15} aria-hidden="true" /></button>
                <button type="button" className="icon-button small" aria-label={t("structure.moveDown")} onClick={() => moveFloor(1)} disabled={!onHouseChange || house.floors.at(-1)?.id === floor.id}><ChevronDown size={15} aria-hidden="true" /></button>
                <button type="button" className="icon-button small" aria-label={t("structure.duplicateLevel")} onClick={duplicateFloor} disabled={!onHouseChange}><Copy size={14} aria-hidden="true" /></button>
                <button type="button" className="icon-button small danger-icon" aria-label={t("structure.deleteLevel")} onClick={deleteFloor} disabled={!onHouseChange || house.floors.length <= 1 || floorSensors.length > 0} title={floorSensors.length ? t("structure.moveSensorsFirst") : undefined}><Trash2 size={14} aria-hidden="true" /></button>
              </div>
            </div>
          </ProgressiveDisclosure>
        </section>

        <ProgressiveDisclosure
          className="structure-section level-properties structure-disclosure"
          summaryClassName="structure-section-heading structure-disclosure-summary"
          summary={<span><span className="eyebrow">{t("structure.selectedLevel")}</span><strong>{floor.name}</strong></span>}
        >
          <div className="structure-disclosure-content">
            <label className="field compact-field"><span>{t("structure.levelName")}</span><input value={floor.name} disabled={!onHouseChange} onChange={(event) => changeFloor({ name: event.target.value })} /></label>
            <label className="field compact-field"><span>{t("structure.levelType")}</span><select value={inferredFloorType(floor)} disabled={!onHouseChange} onChange={(event) => changeFloor({ type: event.target.value as FloorType })}>{FLOOR_TYPES.map((type) => <option key={type} value={type}>{t(`floorType.${type}` as TranslationKey)}</option>)}</select></label>
            <div className="structure-number-grid">
              <label className="field compact-field"><span>{t("structure.elevation")}</span><span className="input-suffix"><input type="number" step="0.1" value={floor.elevation} disabled={!onHouseChange} onChange={(event) => changeFloor({ elevation: Number(event.target.value) })} /><span>m</span></span></label>
              <label className="field compact-field"><span>{t("structure.wallHeight")}</span><span className="input-suffix"><input type="number" min="0.2" max="20" step="0.1" value={floor.wallHeight ?? floor.roof?.eavesHeight ?? floor.ceilingHeight ?? 2.8} disabled={!onHouseChange} onChange={(event) => changeWallHeight(Number(event.target.value))} /><span>m</span></span></label>
              <label className="field compact-field"><span>{t(floor.roof ? "structure.roofPeakHeight" : "structure.ceilingHeight")}</span><span className="input-suffix"><input type="number" min={floor.roof ? floor.wallHeight ?? floor.roof.eavesHeight : 1} max="30" step="0.1" value={floor.ceilingHeight ?? 2.8} disabled={!onHouseChange} onChange={(event) => changeFloor({ ceilingHeight: Number(event.target.value) })} /><span>m</span></span></label>
              <label className="field compact-field"><span>{t("structure.planWidth")}</span><input type="number" min={minimumWidth} step="1" value={floor.width} disabled={!onHouseChange} onChange={(event) => changeFloor({ width: Number(event.target.value) })} /></label>
              <label className="field compact-field"><span>{t("structure.planDepth")}</span><input type="number" min={minimumHeight} step="1" value={floor.height} disabled={!onHouseChange} onChange={(event) => changeFloor({ height: Number(event.target.value) })} /></label>
            </div>
            {physicalFootprint && <div className="structure-scale-summary">
              <span>{t("structure.calibratedPlanExtent", physicalFootprint)}</span>
              <small>{t("structure.horizontalScale", physicalFootprint)}</small>
            </div>}
            {(inferredFloorType(floor) === "attic" || floor.roof) && <div className="roof-design-fields">
              <div className="structure-subheading">
                <span><strong>{t("structure.roofDesign")}</strong><small>{t("structure.roofDesignHelp")}</small></span>
                {floor.roof
                  ? <button type="button" className="text-button danger-text" disabled={!onHouseChange} onClick={removeRoof}>{t("structure.removeRoof")}</button>
                  : <button type="button" className="secondary-button" disabled={!onHouseChange} onClick={() => {
                    const wallHeight = floor.wallHeight ?? Math.min(.9, floor.ceilingHeight ?? 2.4);
                    changeFloor({ wallHeight, roof: { ...DEFAULT_ROOF_DESIGN, eavesHeight: wallHeight } });
                  }}>{t("structure.addRoof")}</button>}
              </div>
              {floor.roof && <>
                <label className="field compact-field"><span>{t("structure.roofStyle")}</span><select value={floor.roof.style} disabled={!onHouseChange} onChange={(event) => {
                  const style = event.target.value as RoofStyle;
                  if (style === "flat") {
                    const wallHeight = Math.max(floor.wallHeight ?? floor.roof?.eavesHeight ?? 0, floor.ceilingHeight ?? 0);
                    changeFloor({ wallHeight, ceilingHeight: wallHeight, roof: { ...floor.roof!, style, pitchDegrees: 0, eavesHeight: wallHeight } });
                  } else {
                    changeRoof({ style, pitchDegrees: Math.max(1, floor.roof?.pitchDegrees ?? DEFAULT_ROOF_DESIGN.pitchDegrees) });
                  }
                }}>{ROOF_STYLES.map((style) => <option key={style} value={style}>{t(`roofStyle.${style}` as TranslationKey)}</option>)}</select></label>
                <div className="structure-number-grid">
                  <label className="field compact-field"><span>{t("structure.roofPitch")}</span><span className="input-suffix"><input type="number" min={floor.roof.style === "flat" ? 0 : 1} max="75" step="1" value={floor.roof.pitchDegrees} disabled={!onHouseChange || floor.roof.style === "flat"} onChange={(event) => changeRoof({ pitchDegrees: Number(event.target.value) })} /><span>°</span></span></label>
                  <label className="field compact-field"><span>{t("structure.ridgeAxis")}</span><select value={floor.roof.ridgeAxis} disabled={!onHouseChange || floor.roof.style === "flat"} onChange={(event) => changeRoof({ ridgeAxis: event.target.value as "x" | "y" })}><option value="x">{t("structure.ridgeAxisX")}</option><option value="y">{t("structure.ridgeAxisY")}</option></select></label>
                  <label className="field compact-field"><span>{t("structure.roofOverhang")}</span><span className="input-suffix"><input type="number" min="0" max="5" step="0.05" value={floor.roof.overhang} disabled={!onHouseChange} onChange={(event) => changeRoof({ overhang: Number(event.target.value) })} /><span>{t("twin.planUnit")}</span></span></label>
                </div>
              </>}
            </div>}
            <p className="structure-help">{t("structure.levelHelp")}</p>
          </div>
        </ProgressiveDisclosure>
      </div>

      <ProgressiveDisclosure
        className="structure-danger-zone structure-disclosure"
        summaryClassName="text-button danger-text"
        summary={<><Trash2 size={14} aria-hidden="true" />{t("structure.deleteProperty")}</>}
      >
        <div className="structure-disclosure-content">
          {confirmDeleteHouse ? <><p>{t("structure.deletePropertyConfirm", { house: house.name })}</p><div className="inline-form-actions"><button type="button" className="text-button" disabled={deletingHouse} onClick={() => setConfirmDeleteHouse(false)}>{t("common.cancel")}</button><button type="button" className="danger-button" disabled={deletingHouse} onClick={() => void removeHouse()}>{t("structure.deleteProperty")}</button></div></> : <button type="button" className="danger-button" disabled={!onHouseDelete} onClick={() => setConfirmDeleteHouse(true)}>{t("structure.deleteProperty")}</button>}
        </div>
      </ProgressiveDisclosure>
    </aside>
  );
}
