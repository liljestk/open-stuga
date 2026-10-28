import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, DoorOpen, LoaderCircle, RadioTower, TriangleAlert, X } from "lucide-react";
import {
  configuredPlanElementOpeningState,
  type DoorPlanElement,
  type Floor,
  type House,
  type TpLinkDiscoveredDevice,
  type WindowPlanElement,
} from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../../i18n";
import { defaultPlanElementWidth } from "../../planElementGeometry";
import { PlanElementGlyph } from "../../components/FloorPlan";
import { tpLinkOpeningMatchesDevice } from "../../tpLinkDeviceClassification";
import "./TpLinkContactAssignment.css";

type SelectableOpening = DoorPlanElement | WindowPlanElement;

interface OpeningChoice {
  floor: Floor;
  element: SelectableOpening;
  label: string;
  eligible: boolean;
  unavailableReason: "fixed" | "already-bound" | null;
}

interface TpLinkContactAssignmentProps {
  device: TpLinkDiscoveredDevice;
  house: House;
  onAssign: (floorId: string, elementId: string) => Promise<void>;
  onClose: () => void;
}

function isFixedOpening(element: SelectableOpening): boolean {
  return (element.kind === "door" && element.variant === "open-passage")
    || (element.kind === "window" && element.variant === "fixed");
}

function openingChoices(
  house: House,
  device: TpLinkDiscoveredDevice,
  t: (key: TranslationKey) => string,
): OpeningChoice[] {
  return house.floors.flatMap((floor) => {
    let doorIndex = 0;
    let windowIndex = 0;
    return (floor.planElements ?? []).flatMap((element) => {
      if (element.kind !== "door" && element.kind !== "window") return [];
      const index = element.kind === "door" ? ++doorIndex : ++windowIndex;
      const fixed = isFixedOpening(element);
      const alreadyBound = Boolean(element.stateBinding && !tpLinkOpeningMatchesDevice(element.stateBinding, device));
      return [{
        floor,
        element,
        label: element.label?.trim() || `${t(`planElement.${element.kind}`)} ${index}`,
        eligible: !fixed && !alreadyBound,
        unavailableReason: fixed ? "fixed" as const : alreadyBound ? "already-bound" as const : null,
      }];
    });
  });
}

function activateOpening(event: KeyboardEvent<SVGGElement>, choice: OpeningChoice, select: () => void) {
  if (!choice.eligible || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  select();
}

function floorRoomCenter(points: Array<{ x: number; y: number }>) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function OpeningPlanPicker({
  floor,
  choices,
  selectedElementId,
  onSelect,
}: {
  floor: Floor;
  choices: OpeningChoice[];
  selectedElementId: string | null;
  onSelect: (elementId: string) => void;
}) {
  const { t } = useI18n();
  const scale = 800 / Math.max(floor.width, floor.height, 1);
  const renderWidth = floor.width * scale;
  const renderHeight = floor.height * scale;
  const margin = 34;
  return <div className="contact-opening-map-wrap">
    <svg
      className="contact-opening-map"
      viewBox={`${-margin} ${-margin} ${renderWidth + margin * 2} ${renderHeight + margin * 2}`}
      role="group"
      aria-label={t("sensors.contactMapLabel", { floor: floor.name })}
    >
      <rect width={renderWidth} height={renderHeight} className="contact-opening-floor" />
      {floor.rooms.map((room) => {
        const points = room.points.map((point) => `${point.x * scale},${point.y * scale}`).join(" ");
        const center = floorRoomCenter(room.points);
        return <g key={room.id} className="contact-opening-room">
          <polygon points={points} />
          <text x={center.x * scale} y={center.y * scale}>{room.name}</text>
        </g>;
      })}
      <g className="contact-opening-walls">
        {floor.walls.map((wall) => <line
          key={wall.id}
          x1={wall.from.x * scale}
          y1={wall.from.y * scale}
          x2={wall.to.x * scale}
          y2={wall.to.y * scale}
        />)}
      </g>
      {choices.map((choice) => {
        const { element } = choice;
        const selected = selectedElementId === element.id;
        const symbolWidth = Math.max(28, (element.width ?? defaultPlanElementWidth(floor, element.kind)) * scale);
        const label = t("sensors.contactMapOpeningLabel", {
          name: choice.label,
          kind: t(`planElement.${element.kind}`),
          state: choice.eligible
            ? selected ? t("sensors.contactSelected") : t("sensors.contactAvailable")
            : t(choice.unavailableReason === "fixed" ? "sensors.contactFixed" : "sensors.contactAlreadyBound"),
        });
        const select = () => choice.eligible && onSelect(element.id);
        return <g
          key={element.id}
          role="button"
          tabIndex={choice.eligible ? 0 : undefined}
          aria-label={label}
          aria-disabled={!choice.eligible || undefined}
          aria-pressed={choice.eligible ? selected : undefined}
          className={`plan-element contact-opening-target${choice.eligible ? " eligible" : " unavailable"}${selected ? " selected" : ""}`}
          transform={`translate(${element.position.x * scale} ${element.position.y * scale}) rotate(${element.rotationDegrees})`}
          onClick={select}
          onKeyDown={(event) => activateOpening(event, choice, select)}
        >
          <rect x={-symbolWidth / 2 - 14} y={-28} width={symbolWidth + 28} height={56} rx="8" className="contact-opening-hit-target" />
          {selected && <rect x={-symbolWidth / 2 - 10} y={-24} width={symbolWidth + 20} height={48} rx="8" className="plan-element-selection" />}
          <PlanElementGlyph
            kind={element.kind}
            width={symbolWidth}
            state={configuredPlanElementOpeningState(element).state}
          />
        </g>;
      })}
    </svg>
    <p className="contact-opening-map-help">{t("sensors.contactMapHelp")}</p>
  </div>;
}

export function TpLinkContactAssignment({
  device,
  house,
  onAssign,
  onClose,
}: TpLinkContactAssignmentProps) {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const choices = useMemo(() => openingChoices(house, device, t), [device, house, t]);
  const existingChoice = choices.find((choice) => tpLinkOpeningMatchesDevice(choice.element.stateBinding, device));
  const initialChoice = choices.find((choice) => choice.element.id === device.mappedOpening?.elementId)
    ?? existingChoice
    ?? choices.find((choice) => choice.eligible);
  const editing = Boolean(existingChoice || device.mappedOpening);
  const [floorId, setFloorId] = useState(initialChoice?.floor.id ?? house.floors[0]?.id ?? "");
  const [elementId, setElementId] = useState<string | null>(initialChoice?.element.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const floor = house.floors.find((candidate) => candidate.id === floorId) ?? house.floors[0];
  const floorChoices = choices.filter((choice) => choice.floor.id === floor?.id);
  const selected = choices.find((choice) => choice.floor.id === floor?.id && choice.element.id === elementId && choice.eligible);
  const eligibleCount = choices.filter((choice) => choice.eligible).length;

  useEffect(() => {
    headingRef.current?.focus();
  }, [device.deviceId]);

  const selectFloor = (nextFloorId: string) => {
    setFloorId(nextFloorId);
    setElementId(choices.find((choice) => choice.floor.id === nextFloorId && choice.eligible)?.element.id ?? null);
    setError(null);
  };

  const assign = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAssign(selected.floor.id, selected.element.id);
    } catch (assignmentError) {
      setError(assignmentError instanceof Error && assignmentError.message.trim()
        ? assignmentError.message
        : t("sensors.contactSaveError"));
      setSaving(false);
    }
  };

  return <section className="panel contact-assignment-panel" aria-labelledby="contact-assignment-title">
    <header>
      <span className="contact-assignment-icon" aria-hidden="true"><RadioTower size={20} /></span>
      <div>
        <span className="eyebrow">{t("sensors.contactEyebrow")}</span>
        <h2 id="contact-assignment-title" ref={headingRef} tabIndex={-1}>
          {t(editing ? "sensors.contactEditTitle" : "sensors.contactTitle", {
            name: device.alias?.trim() || device.model,
          })}
        </h2>
        <p>{t(editing ? "sensors.contactEditDescription" : "sensors.contactDescription")}</p>
      </div>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")} disabled={saving}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>

    <div className="contact-assignment-device">
      <DoorOpen size={18} aria-hidden="true" />
      <span><strong>{device.alias?.trim() || t("sensors.unnamedDevice")}</strong><small>{device.model} · {device.deviceId}</small></span>
      <span className={`device-health ${device.status?.toLowerCase() === "online" ? "online" : ""}`}>
        {device.status || t("sensors.unknownStatus")}
      </span>
    </div>

    {eligibleCount > 0 && floor ? <>
      {house.floors.length > 1 && <label className="field contact-floor-field">
        <span>{t("common.floor")}</span>
        <select value={floor.id} onChange={(event) => selectFloor(event.currentTarget.value)}>
          {house.floors.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>}
      <OpeningPlanPicker floor={floor} choices={floorChoices} selectedElementId={elementId} onSelect={setElementId} />
      <div className="contact-opening-list" role="group" aria-label={t("sensors.contactOpeningList")}>
        {floorChoices.map((choice) => <button
          key={choice.element.id}
          type="button"
          className={choice.element.id === elementId ? "selected" : ""}
          aria-pressed={choice.eligible ? choice.element.id === elementId : undefined}
          disabled={!choice.eligible || saving}
          onClick={() => setElementId(choice.element.id)}
        >
          <span className={`opening-kind ${choice.element.kind}`} aria-hidden="true" />
          <span><strong>{choice.label}</strong><small>{choice.element.kind === "door" ? t("planElement.door") : t("planElement.window")} · {choice.floor.name}</small></span>
          <span>{choice.eligible
            ? choice.element.id === elementId ? <><Check size={14} aria-hidden="true" />{t("sensors.contactSelected")}</> : t("sensors.contactAvailable")
            : t(choice.unavailableReason === "fixed" ? "sensors.contactFixed" : "sensors.contactAlreadyBound")}</span>
        </button>)}
      </div>
    </> : <div className="contact-assignment-empty">
      <TriangleAlert size={20} aria-hidden="true" />
      <div><strong>{t("sensors.contactNoOpeningsTitle")}</strong><p>{t("sensors.contactNoOpeningsBody")}</p></div>
    </div>}

    {error && <p className="contact-assignment-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{error}</p>}
    <footer>
      <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
      <button type="button" className="primary-button" onClick={() => void assign()} disabled={!selected || saving}>
        {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
        {saving
          ? t(editing ? "sensors.contactUpdating" : "sensors.contactSaving")
          : t(editing ? "sensors.contactUpdate" : "sensors.contactSave")}
      </button>
    </footer>
  </section>;
}
