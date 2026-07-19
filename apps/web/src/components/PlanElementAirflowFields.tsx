import { useEffect, useState } from "react";
import {
  configuredPlanElementOpeningState,
  defaultPlanElementOpeningState,
  fixedPlanElementOpeningState,
  type AirflowPlanElement,
  type ConfiguredOpeningState,
  type DoorVariant,
  type Floor,
  type OpeningStateBinding,
  type VentVariant,
  type WindowVariant,
} from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { defaultPlanElementBottomOffset, effectivePlanElementHeight } from "../planElementGeometry";

export interface AirflowPlanElementPatch {
  label?: string | undefined;
  state?: ConfiguredOpeningState | undefined;
  openFraction?: number | undefined;
  bottomOffsetM?: number | undefined;
  variant?: DoorVariant | WindowVariant | VentVariant | undefined;
  nominalFlowM3h?: number | undefined;
  stateBinding?: OpeningStateBinding | undefined;
}

const VARIANTS = {
  door: ["interior", "exterior", "sliding", "double", "open-passage"],
  window: ["fixed", "casement", "tilt-turn", "sliding"],
  vent: ["passive", "supply", "extract", "balanced", "transfer"],
} as const;

/** Apply an editor patch without weakening the discriminated door/window/vent types. */
export function applyAirflowPlanElementPatch<T extends AirflowPlanElement>(element: T, patch: AirflowPlanElementPatch): T {
  const next = { ...element } as T;
  const mutable = next as unknown as Record<string, unknown>;
  const assignOptional = (key: keyof AirflowPlanElementPatch) => {
    if (!(key in patch)) return;
    const value = patch[key];
    if (value === undefined) delete mutable[key];
    else mutable[key] = value;
  };

  for (const key of ["label", "state", "openFraction", "bottomOffsetM", "stateBinding"] as const) assignOptional(key);

  if ("variant" in patch) {
    const allowed = patch.variant === undefined
      || (element.kind === "door" && (VARIANTS.door as readonly string[]).includes(patch.variant))
      || (element.kind === "window" && (VARIANTS.window as readonly string[]).includes(patch.variant))
      || (element.kind === "vent" && (VARIANTS.vent as readonly string[]).includes(patch.variant));
    if (allowed) assignOptional("variant");
  }
  if (element.kind === "vent") assignOptional("nominalFlowM3h");
  return next;
}

function defaultVariant(element: AirflowPlanElement): DoorVariant | WindowVariant | VentVariant {
  if (element.kind === "door") return "interior";
  if (element.kind === "window") return "casement";
  return "passive";
}

function variantTranslationKey(element: AirflowPlanElement, variant: string): TranslationKey {
  return `opening.variant.${element.kind}.${variant}` as TranslationKey;
}

interface PlanElementAirflowFieldsProps {
  floor: Floor;
  element: AirflowPlanElement;
  onChange: (patch: AirflowPlanElementPatch) => void;
}

/** Shared progressive controls for the same opening instance in plan and building editors. */
export function PlanElementAirflowFields({ floor, element, onChange }: PlanElementAirflowFieldsProps) {
  const { t } = useI18n();
  const configured = configuredPlanElementOpeningState(element);
  const [bindingProvider, setBindingProvider] = useState<OpeningStateBinding["provider"] | "none">(element.stateBinding?.provider ?? "none");
  const [bindingExternalId, setBindingExternalId] = useState(element.stateBinding?.externalId ?? "");
  const [bindingConnectionId, setBindingConnectionId] = useState(element.stateBinding?.connectionId ?? "");

  useEffect(() => {
    setBindingProvider(element.stateBinding?.provider ?? "none");
    setBindingExternalId(element.stateBinding?.externalId ?? "");
    setBindingConnectionId(element.stateBinding?.connectionId ?? "");
  }, [element.id, element.stateBinding?.provider, element.stateBinding?.externalId, element.stateBinding?.connectionId]);

  const commitBinding = (overrides: Partial<OpeningStateBinding> = {}) => {
    const provider = overrides.provider ?? (bindingProvider === "none" ? undefined : bindingProvider);
    const externalId = (overrides.externalId ?? bindingExternalId).trim();
    if (!provider) {
      onChange({ stateBinding: undefined });
      return;
    }
    if (!externalId) return;
    const connectionId = (overrides.connectionId ?? bindingConnectionId).trim();
    const invert = overrides.invert ?? element.stateBinding?.invert;
    const staleAfterSeconds = overrides.staleAfterSeconds ?? element.stateBinding?.staleAfterSeconds;
    onChange({
      stateBinding: {
        provider,
        externalId,
        ...(connectionId ? { connectionId } : {}),
        ...(invert === undefined ? {} : { invert }),
        ...(staleAfterSeconds === undefined ? {} : { staleAfterSeconds }),
      },
    });
  };

  const variant = element.variant ?? defaultVariant(element);
  const stateIsFixed = fixedPlanElementOpeningState({ ...element, variant } as AirflowPlanElement) !== null;
  const apertureIsSealed = element.kind === "window" && variant === "fixed";
  const maximumBottomOffset = Math.max(0, (floor.ceilingHeight ?? 2.8) - effectivePlanElementHeight(floor, element));

  return <div className="plan-element-airflow-fields">
    <label>
      <span>{t("opening.label")}</span>
      <input
        value={element.label ?? ""}
        maxLength={120}
        placeholder={t(`planElement.${element.kind}` as TranslationKey)}
        onChange={(event) => onChange({ label: event.currentTarget.value.trim() ? event.currentTarget.value : undefined })}
      />
    </label>
    <label>
      <span>{t("opening.variant")}</span>
      <select
        value={variant}
        onChange={(event) => {
          const nextVariant = event.currentTarget.value as DoorVariant | WindowVariant | VentVariant;
          const becomesFixed = (element.kind === "window" && nextVariant === "fixed")
            || (element.kind === "door" && nextVariant === "open-passage");
          onChange(becomesFixed
            ? { variant: nextVariant, state: undefined, stateBinding: undefined }
            : { variant: nextVariant });
        }}
      >
        {VARIANTS[element.kind].map((candidate) => <option key={candidate} value={candidate}>{t(variantTranslationKey(element, candidate))}</option>)}
      </select>
    </label>
    <label>
      <span>{element.stateBinding ? t("opening.fallbackState") : t("opening.state")}</span>
      <select
        value={configured.state}
        disabled={stateIsFixed}
        onChange={(event) => onChange({ state: event.currentTarget.value as ConfiguredOpeningState })}
      >
        <option value="closed">{t("opening.state.closed")}</option>
        <option value="open">{t("opening.state.open")}</option>
      </select>
    </label>
    {element.state === undefined && <span className="editor-properties-note">{t("opening.defaultState", { state: t(`opening.state.${defaultPlanElementOpeningState(element)}` as TranslationKey) })}</span>}
    <details className="opening-advanced-fields">
      <summary>{t("opening.advanced")}</summary>
      <div className="opening-advanced-grid">
        <label>
          <span>{t("opening.openFraction")}</span>
          <span className="input-suffix"><input type="number" min="0" max="100" step="5" disabled={apertureIsSealed} value={apertureIsSealed ? 0 : Math.round((element.openFraction ?? 1) * 100)} onChange={(event) => onChange({ openFraction: Math.max(0, Math.min(1, Number(event.currentTarget.value) / 100)) })} /><span>%</span></span>
        </label>
        <label>
          <span>{t("opening.bottomOffset")}</span>
          <span className="input-suffix"><input type="number" min="0" max={maximumBottomOffset} step="0.05" value={element.bottomOffsetM ?? defaultPlanElementBottomOffset(floor, element)} onChange={(event) => onChange({ bottomOffsetM: Math.max(0, Math.min(maximumBottomOffset, Number(event.currentTarget.value))) })} /><span>m</span></span>
        </label>
        {element.kind === "vent" && <label>
          <span>{t("opening.nominalFlow")}</span>
          <span className="input-suffix"><input type="number" min="0" max="100000" step="1" value={element.nominalFlowM3h ?? ""} placeholder={t("common.optional")} onChange={(event) => onChange({ nominalFlowM3h: event.currentTarget.value === "" ? undefined : Math.max(0, Math.min(100_000, Number(event.currentTarget.value))) })} /><span>m³/h</span></span>
        </label>}
        {!stateIsFixed && <fieldset className="opening-binding-fields">
          <legend>{t("opening.contactSensor")}</legend>
          <label>
            <span>{t("opening.provider")}</span>
            <select value={bindingProvider} onChange={(event) => {
              const provider = event.currentTarget.value as OpeningStateBinding["provider"] | "none";
              setBindingProvider(provider);
              if (provider === "none") onChange({ stateBinding: undefined });
              else if (bindingExternalId.trim()) commitBinding({ provider });
            }}>
              <option value="none">{t("opening.provider.none")}</option>
              <option value="home-assistant">{t("opening.provider.homeAssistant")}</option>
              <option value="tapo">{t("opening.provider.tapo")}</option>
            </select>
          </label>
          {bindingProvider !== "none" && <>
            <label>
              <span>{t("opening.externalId")}</span>
              <input value={bindingExternalId} placeholder={bindingProvider === "home-assistant" ? "binary_sensor.entry_door" : "device id"} onChange={(event) => setBindingExternalId(event.currentTarget.value)} onBlur={(event) => commitBinding({ externalId: event.currentTarget.value })} />
            </label>
            <label>
              <span>{t("opening.connectionId")}</span>
              <input value={bindingConnectionId} placeholder={t("common.optional")} onChange={(event) => setBindingConnectionId(event.currentTarget.value)} onBlur={(event) => commitBinding({ connectionId: event.currentTarget.value })} />
            </label>
            <label className="checkbox-row"><input type="checkbox" checked={element.stateBinding?.invert ?? false} onChange={(event) => commitBinding({ invert: event.currentTarget.checked })} /><span>{t("opening.invert")}</span></label>
            <label>
              <span>{t("opening.staleAfter")}</span>
              <span className="input-suffix"><input type="number" min="1" max="43200" step="1" value={Math.round((element.stateBinding?.staleAfterSeconds ?? 900) / 60)} onChange={(event) => commitBinding({ staleAfterSeconds: Math.max(1, Math.min(43_200, Number(event.currentTarget.value))) * 60 })} /><span>{t("common.minutes")}</span></span>
            </label>
            {!bindingExternalId.trim() && <span className="editor-properties-note">{t("opening.bindingNeedsId")}</span>}
          </>}
        </fieldset>}
        {element.state !== undefined && <button type="button" className="tool-button" onClick={() => onChange({ state: undefined })}>{t("opening.useDefault")}</button>}
      </div>
    </details>
  </div>;
}
