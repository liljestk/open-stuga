import type { FireEscapeVariant, Floor, PlanElement } from "@climate-twin/contracts";
import { fireplaceChimneyDimensions } from "../architecturalGeometry";
import { defaultFireEscapeProjection, effectivePlanElementHeight, planElementWidthBounds } from "../planElementGeometry";
import { useI18n, type TranslationKey } from "../i18n";

export type FixturePlanElement = Extract<PlanElement, { kind: "fireplace" | "fireEscape" }>;

export interface FixturePlanElementPatch {
  label?: string | undefined;
  verticalExtent?: "level" | "roof" | undefined;
  chimneyHeightAboveRoof?: number | undefined;
  chimneyWidth?: number | undefined;
  chimneyDepth?: number | undefined;
  fireEscapeVariant?: FireEscapeVariant | undefined;
  bottomOffsetM?: number | undefined;
  projection?: number | undefined;
}

/** Applies fixture-only fields while preserving the PlanElement discriminant. */
export function applyFixturePlanElementPatch<T extends FixturePlanElement>(
  element: T,
  patch: FixturePlanElementPatch,
): T {
  const next = { ...element } as T;
  const mutable = next as unknown as Record<string, unknown>;
  const assignOptional = (target: string, source: keyof FixturePlanElementPatch = target as keyof FixturePlanElementPatch) => {
    if (!(source in patch)) return;
    const value = patch[source];
    if (value === undefined) delete mutable[target];
    else mutable[target] = value;
  };

  assignOptional("label");
  if (element.kind === "fireplace") {
    for (const key of ["verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth"] as const) assignOptional(key);
  } else {
    assignOptional("variant", "fireEscapeVariant");
    assignOptional("bottomOffsetM");
    assignOptional("projection");
  }
  return next;
}

interface PlanElementFixtureFieldsProps {
  floor: Floor;
  element: FixturePlanElement;
  planUnitLabel: string;
  onChange: (patch: FixturePlanElementPatch) => void;
}

function boundedNumber(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

/** Shared non-airflow controls used by both the 2D plan and 3D building editors. */
export function PlanElementFixtureFields({ floor, element, planUnitLabel, onChange }: PlanElementFixtureFieldsProps) {
  const { t } = useI18n();
  const maximumPlanDimension = Math.max(.05, floor.width, floor.height);

  return <div className="plan-element-fixture-fields">
    <label>
      <span>{t("opening.label")}</span>
      <input
        value={element.label ?? ""}
        maxLength={120}
        placeholder={t(`planElement.${element.kind}` as TranslationKey)}
        onChange={(event) => onChange({ label: event.currentTarget.value.trim() ? event.currentTarget.value : undefined })}
      />
    </label>
    {element.kind === "fireplace" ? (() => {
      const extent = element.verticalExtent ?? "level";
      const dimensions = fireplaceChimneyDimensions(floor, element);
      const dimensionStep = Math.max(.01, planElementWidthBounds(floor, "fireplace").step);
      return <>
        <label>
          <span>{t("twin.fireplaceExtent")}</span>
          <select value={extent} onChange={(event) => {
            const verticalExtent = event.currentTarget.value as "level" | "roof";
            onChange(verticalExtent === "roof"
              ? { verticalExtent }
              : { verticalExtent, chimneyHeightAboveRoof: undefined, chimneyWidth: undefined, chimneyDepth: undefined });
          }}>
            <option value="level">{t("twin.fireplaceExtentLevel")}</option>
            <option value="roof">{t("twin.fireplaceExtentRoof")}</option>
          </select>
        </label>
        {extent === "roof" && <>
          <span className="editor-properties-note">{t("twin.chimneyFullHeightHelp")}</span>
          <label><span>{t("twin.chimneyAboveRoof")}</span><span className="input-suffix"><input type="number" min="0" max="5" step="0.1" value={element.chimneyHeightAboveRoof ?? .6} onChange={(event) => onChange({ chimneyHeightAboveRoof: boundedNumber(event.currentTarget.valueAsNumber, 0, 5) })} /><span>m</span></span></label>
          <label><span>{t("twin.chimneyWidth")}</span><span className="input-suffix"><input type="number" min="0.05" max={maximumPlanDimension} step={dimensionStep} value={dimensions.width} onChange={(event) => onChange({ chimneyWidth: boundedNumber(event.currentTarget.valueAsNumber, .05, maximumPlanDimension) })} /><span>{planUnitLabel}</span></span></label>
          <label><span>{t("twin.chimneyDepth")}</span><span className="input-suffix"><input type="number" min="0.05" max={maximumPlanDimension} step={dimensionStep} value={dimensions.depth} onChange={(event) => onChange({ chimneyDepth: boundedNumber(event.currentTarget.valueAsNumber, .05, maximumPlanDimension) })} /><span>{planUnitLabel}</span></span></label>
        </>}
      </>;
    })() : <>
      <label><span>{t("twin.fireEscapeType")}</span><select value={element.variant ?? "ladder"} onChange={(event) => onChange({ fireEscapeVariant: event.currentTarget.value as FireEscapeVariant })}><option value="ladder">{t("twin.fireEscapeLadder")}</option><option value="stairs">{t("twin.fireEscapeStairs")}</option></select></label>
      <label><span>{t("opening.bottomOffset")}</span><span className="input-suffix"><input type="number" min="0" max={Math.max(0, (floor.ceilingHeight ?? 2.8) - effectivePlanElementHeight(floor, element))} step="0.05" value={element.bottomOffsetM ?? 0} onChange={(event) => onChange({ bottomOffsetM: boundedNumber(event.currentTarget.valueAsNumber, 0, Math.max(0, (floor.ceilingHeight ?? 2.8) - effectivePlanElementHeight(floor, element))) })} /><span>m</span></span></label>
      <label><span>{t("twin.fireEscapeProjection")}</span><span className="input-suffix"><input type="number" min="0.05" max={maximumPlanDimension} step={Math.max(.01, planElementWidthBounds(floor, "fireEscape").step)} value={element.projection ?? defaultFireEscapeProjection(floor, element.width ?? 1)} onChange={(event) => onChange({ projection: boundedNumber(event.currentTarget.valueAsNumber, .05, maximumPlanDimension) })} /><span>{planUnitLabel}</span></span></label>
    </>}
  </div>;
}
