import { useState } from "react";
import {
  ADAPTIVE_BASELINE_REASON_LIMIT, ADAPTIVE_REFERENCE_GROUP_LIMIT, isAdaptiveReferenceGroups,
  type AdaptiveMonitoringSettings, type AdaptiveReferenceGroup, type AdaptiveSettingsChange, type Sensor,
} from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import { useAdaptiveFormat } from "./adaptivePresentation";

interface Props {
  settings: AdaptiveMonitoringSettings;
  sensors: readonly Sensor[];
  sensorName: (id: string) => string;
  pending: boolean;
  stale: boolean;
  timeZone: string;
  onChange: (change: AdaptiveSettingsChange) => void;
}

export function AdaptiveLearningSettings(props: Readonly<Props>) {
  const { t } = useI18n();
  return <details className="adaptive-section">
    <summary>{t("adaptive.settings")}</summary>
    <LearningSettingsForm key={props.settings.revision} {...props} />
  </details>;
}

function LearningSettingsForm({ settings, sensors, sensorName, pending, stale, timeZone, onChange }: Readonly<Props>) {
  const { t } = useI18n();
  const { date } = useAdaptiveFormat(timeZone);
  const [reason, setReason] = useState("");
  const [reset, setReset] = useState(false);
  const base = { dataMode: settings.dataMode, baseRevision: settings.revision };
  return <div className="adaptive-settings-form">
    <p>{t(settings.mode === "off" ? "adaptive.modeOff" : "adaptive.modeShadow")}</p>
    {settings.baseline && <p>{t("adaptive.baselineSince", { date: date(settings.baseline.startedAt) })}</p>}
    <button type="button" className="secondary-button" disabled={pending || stale}
      onClick={() => onChange({ ...base, action: "set-mode", mode: settings.mode === "off" ? "shadow" : "off" })}>
      {t(settings.mode === "off" ? "adaptive.enable" : "adaptive.disable")}
    </button>
    {settings.baseline && <>
      <button type="button" className="secondary-button" aria-expanded={reset} disabled={pending || stale}
        onClick={() => setReset(!reset)}>{t("adaptive.resetBaseline")}</button>
      {reset && <form className="adaptive-form" onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() && !pending && !stale) onChange({ ...base, action: "reset-baseline", reason: reason.trim() });
      }}>
        <p>{t("adaptive.resetDescription")}</p>
        <label>{t("adaptive.resetReason")}
          <textarea required maxLength={ADAPTIVE_BASELINE_REASON_LIMIT} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="adaptive-actions">
          <button className="primary-button" type="submit" disabled={pending || stale || !reason.trim()}>{t("adaptive.resetBaseline")}</button>
          <button className="secondary-button" type="button" disabled={pending} onClick={() => { setReason(""); setReset(false); }}>{t("common.cancel")}</button>
        </div>
      </form>}
    </>}
    <AdaptiveReferenceSettings groups={settings.referenceGroups} sensors={sensors} sensorName={sensorName} pending={pending || stale}
      onSave={(referenceGroups) => onChange({ ...base, action: "set-reference-groups", referenceGroups })} />
  </div>;
}

function AdaptiveReferenceSettings({ groups, sensors, sensorName, pending, onSave }: Readonly<{
  groups: AdaptiveReferenceGroup[];
  sensors: readonly Sensor[];
  sensorName: (id: string) => string;
  pending: boolean;
  onSave: (groups: AdaptiveReferenceGroup[]) => void;
}>) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<AdaptiveReferenceGroup | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const allowedTargets = sensors.filter((sensor) => !groups.some((group, index) => group.targetSensorId === sensor.id && index !== editing));
  const updated = draft ? [...groups.filter((_, index) => editing !== index), { ...draft, placement: draft.placement.trim() }] : groups;
  return <div className="adaptive-section">
    <h4>{t("adaptive.referenceGroups")}</h4>
    <p>{t("adaptive.referenceDescription")}</p>
    <ul className="adaptive-items">
      {groups.map((group, index) => <li key={group.targetSensorId}>
        <strong>{sensorName(group.targetSensorId)} · {t(`adaptive.reference.${group.kind}`)}</strong>
        <p>{t("adaptive.references", { sensors: group.referenceSensorIds.map(sensorName).join(", ") })}</p>
        <p className="adaptive-note">{group.placement}</p>
        <div className="adaptive-actions">
          <button className="secondary-button" type="button" disabled={pending}
            onClick={() => { setRemoving(null); setEditing(index); setDraft(group); }}>{t("adaptive.editReference")}</button>
          <button className="secondary-button" type="button" disabled={pending} aria-expanded={removing === index}
            onClick={() => { setDraft(null); setRemoving(removing === index ? null : index); }}>{t("adaptive.removeReference")}</button>
        </div>
        {removing === index && <div className="adaptive-message">
          <p>{t("adaptive.removeReferenceDescription")}</p>
          <button className="secondary-button" type="button" disabled={pending}
            onClick={() => onSave(groups.filter((_, position) => position !== index))}>{t("adaptive.removeReference")}</button>
        </div>}
      </li>)}
    </ul>
    {!draft && <button className="secondary-button" type="button"
      disabled={pending || groups.length >= ADAPTIVE_REFERENCE_GROUP_LIMIT || sensors.length < 2 || groups.length >= sensors.length}
      onClick={() => { setRemoving(null); setEditing(null); setDraft({ targetSensorId: "", kind: "reference-thermometer", referenceSensorIds: [], placement: "" }); }}>
      {t("adaptive.addReference")}
    </button>}
    {draft && <form className="adaptive-form" onSubmit={(event) => {
      event.preventDefault();
      if (!pending && isAdaptiveReferenceGroups(updated)) onSave(updated);
    }}>
      <label>{t("adaptive.targetSensor")}
        <select required value={draft.targetSensorId}
          onChange={(event) => setDraft({ ...draft, targetSensorId: event.target.value, referenceSensorIds: draft.referenceSensorIds.filter((id) => id !== event.target.value) })}>
          <option value="">{t("adaptive.chooseSensor")}</option>
          {allowedTargets.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}
        </select>
      </label>
      <label>{t("adaptive.referenceType")}
        <select value={draft.kind} onChange={(event) => setDraft({ ...draft,
          kind: event.target.value === "peers" ? "peers" : "reference-thermometer", referenceSensorIds: [],
        })}>
          <option value="reference-thermometer">{t("adaptive.reference.reference-thermometer")}</option>
          <option value="peers">{t("adaptive.reference.peers")}</option>
        </select>
      </label>
      <fieldset>
        <legend>{t("adaptive.referenceSensors")}</legend>
        <p>{t(draft.kind === "peers" ? "adaptive.peerHint" : "adaptive.referenceHint")}</p>
        {sensors.filter((sensor) => sensor.id !== draft.targetSensorId).map((sensor) => <label key={sensor.id} className="adaptive-checkbox">
          <input type={draft.kind === "peers" ? "checkbox" : "radio"} name="adaptive-reference" checked={draft.referenceSensorIds.includes(sensor.id)}
            onChange={(event) => {
              const remaining = draft.referenceSensorIds.filter((id) => id !== sensor.id);
              const referenceSensorIds = draft.kind === "reference-thermometer" ? [sensor.id]
                : event.target.checked ? [...remaining, sensor.id] : remaining;
              setDraft({ ...draft, referenceSensorIds });
            }} />
          {sensor.name}
        </label>)}
      </fieldset>
      <label>{t("adaptive.referencePlacement")}
        <textarea required maxLength={ADAPTIVE_BASELINE_REASON_LIMIT} value={draft.placement} onChange={(event) => setDraft({ ...draft, placement: event.target.value })} />
      </label>
      <div className="adaptive-actions">
        <button className="primary-button" type="submit" disabled={pending || !isAdaptiveReferenceGroups(updated)}>{t("common.save")}</button>
        <button className="secondary-button" type="button" disabled={pending} onClick={() => setDraft(null)}>{t("common.cancel")}</button>
      </div>
    </form>}
  </div>;
}
