import { useState } from "react";
import type { AdaptiveSettings, AdaptiveSettingsPatch, DataMode, Sensor } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { confirmAction } from "../components/ConfirmationProvider";

export function AdaptiveLearningSettings(props: Readonly<{
  settings: AdaptiveSettings; sensors: Sensor[]; referenceSensors: Sensor[]; homeName: string; dataMode: DataMode; busy: boolean;
  onSave(patch: AdaptiveSettingsPatch): Promise<unknown>;
}>) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [peers, setPeers] = useState<string[]>([]);
  const [designated, setDesignated] = useState(false);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async (patch: Omit<AdaptiveSettingsPatch, "dataMode" | "baseRevision">) => {
    setSaved(false);
    await props.onSave({ ...patch, baseRevision: props.settings.revision, dataMode: props.dataMode });
    setSaved(true);
  };
  const chooseTarget = (id: string) => {
    setTarget(id);
    const existing = props.settings.referenceGroups.find(g => g.sensorId === id);
    setPeers(existing?.peerIds ?? []); setDesignated(existing?.designatedReference ?? false);
  };
  return <details className="adaptive-settings">
    <summary>{t("adaptive.settings")}</summary>
    <p>{t("adaptive.optIn")}</p>
    <label className="field"><span>{t("adaptive.mode")}</span>
      <select value={props.settings.mode} disabled={props.busy} onChange={e => {
        const mode = e.target.value;
        if (mode === "off" || mode === "shadow" || mode === "advisory") void save({ mode }).catch(() => undefined);
      }}>
        <option value="off">{t("adaptive.mode.off")}</option><option value="shadow">{t("adaptive.mode.shadow")}</option>
        <option value="advisory" disabled={!props.settings.promotionReceiptId}>{t("adaptive.mode.advisory")}</option>
      </select>
    </label>
    <p>{t("adaptive.promotionGate")}</p>
    <details><summary>{t("adaptive.references")}</summary>
      <p>{t("adaptive.referenceHelp")}</p>
      <label className="field"><span>{t("adaptive.target")}</span><select value={target} onChange={e => chooseTarget(e.target.value)}>
        <option value="">{t("adaptive.chooseSensor")}</option>{props.referenceSensors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
      {target && <form onSubmit={e => {
        e.preventDefault();
        const referenceGroups = props.settings.referenceGroups.filter(g => g.sensorId !== target);
        if (peers.length) referenceGroups.push({ sensorId: target, peerIds: peers, designatedReference: designated });
        void save({ referenceGroups }).catch(() => undefined);
      }}>
        <fieldset disabled={props.busy}><legend>{t("adaptive.peerSensors")}</legend>{props.referenceSensors.filter(s => s.id !== target).map(s =>
          <label key={s.id} className="adaptive-check"><input type="checkbox" checked={peers.includes(s.id)}
            onChange={e => {
              const next = e.target.checked ? [...peers, s.id] : peers.filter(id => id !== s.id);
              setPeers(next); if (next.length !== 1) setDesignated(false);
            }} />{s.name}</label>)}</fieldset>
        <label className="adaptive-check"><input type="checkbox" checked={designated} disabled={props.busy || peers.length !== 1} onChange={e => setDesignated(e.target.checked)} />{t("adaptive.designated")}</label>
        <button type="submit" className="secondary-button" disabled={props.busy}>{t("adaptive.saveReferences")}</button>
      </form>}
    </details>
    <details><summary>{t("adaptive.resetTitle")}</summary>
      <p>{t("adaptive.resetHelp")}</p>
      <label className="field"><span>{t("adaptive.resetSensor")}</span><select value={target} onChange={e => chooseTarget(e.target.value)}>
        <option value="">{t("adaptive.chooseSensor")}</option>{props.sensors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
      <label className="field"><span>{t("adaptive.resetReason")}</span><input value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label>
      <button type="button" className="secondary-button" disabled={props.busy || !target || !reason.trim()} onClick={() => {
        void confirmAction(t("adaptive.resetConfirm", { sensor: props.sensors.find(s => s.id === target)?.name ?? target, home: props.homeName }), t("adaptive.resetAction"), false).then(confirmed => {
          if (confirmed) return save({ resetBaseline: { sensorId: target, reason } });
          return undefined;
        }).catch(() => undefined);
      }}>{t("adaptive.resetAction")}</button>
    </details>
    {saved && <p role="status">{t("adaptive.settingsSaved")}</p>}
  </details>;
}
