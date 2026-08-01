import { useCallback, useEffect, useMemo, useState } from "react";
import { BatteryLow, Check, ChevronDown, LoaderCircle, RadioTower, TriangleAlert } from "lucide-react";
import type { House, Nexus433Binding, Nexus433Candidate, Nexus433Status, Sensor } from "@climate-twin/contracts";
import { api } from "../../api";
import { useI18n } from "../../i18n";

interface Nexus433SendersPanelProps {
  house: House;
  sensors: Sensor[];
  readOnly: boolean;
  onAddSensor: () => void;
}

export function Nexus433SendersPanel({ house, sensors, readOnly, onAddSensor }: Nexus433SendersPanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Nexus433Status | null>(null);
  const [candidates, setCandidates] = useState<Nexus433Candidate[]>([]);
  const [bindings, setBindings] = useState<Nexus433Binding[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<Nexus433Status> => {
    const nextStatus = await api.nexus433Status(house.id, signal);
    setStatus(nextStatus);
    if (!nextStatus.capability.available || !nextStatus.enabled) return nextStatus;
    const [nextCandidates, nextBindings] = await Promise.all([
      api.nexus433Candidates(house.id, signal),
      api.nexus433Bindings(house.id, signal),
    ]);
    setCandidates(nextCandidates);
    setBindings(nextBindings);
    return nextStatus;
  }, [house.id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    const refresh = async () => {
      try {
        const nextStatus = await load(controller.signal);
        setError(null);
        if (!controller.signal.aborted && nextStatus.capability.available && nextStatus.enabled) {
          timer = window.setTimeout(() => void refresh(), 5_000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("nexus433.requestFailed"));
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load, t]);

  const bindingBySensor = useMemo(
    () => new Map(bindings.map((binding) => [binding.sensorId, binding])),
    [bindings],
  );

  if (!status?.capability.available || !status.enabled) return null;

  const attentionBindings = bindings.filter((binding) => !binding.available || binding.battery === "low");

  const assign = async (candidate: Nexus433Candidate) => {
    const sensorId = targets[candidate.id];
    if (!sensorId) return;
    setBusy(candidate.id);
    setError(null);
    try {
      const binding = bindingBySensor.get(sensorId);
      if (binding) {
        await api.reconnectNexus433Sensor(sensorId, {
          houseId: house.id,
          candidateId: candidate.id,
          expectedRevision: binding.revision,
        });
      } else {
        await api.bindNexus433Candidate({ houseId: house.id, candidateId: candidate.id, sensorId });
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("nexus433.requestFailed"));
    } finally {
      setBusy(null);
    }
  };

  const bindingList = (items: Nexus433Binding[]) => <ul>{items.map((binding) => {
    const sensor = sensors.find((item) => item.id === binding.sensorId);
    return <li key={binding.id}><span><strong>{sensor?.name ?? binding.sensorId}</strong><small>{t("nexus433.senderSummary", { id: binding.senderId, channel: binding.channel + 1 })}</small></span><span className={binding.available && binding.battery !== "low" ? "configured-note" : "muted-note"}>{binding.battery === "low" && <BatteryLow size={15} aria-hidden="true" />}{binding.battery === "low" ? t("nexus433.batteryLow") : binding.available ? t("nexus433.senderLive") : t("nexus433.senderWaiting")}</span></li>;
  })}</ul>;
  const candidateList = <ul>{candidates.map((candidate) => {
        const targetId = targets[candidate.id] ?? "";
        const reconnect = Boolean(targetId && bindingBySensor.has(targetId));
        return <li key={candidate.id}>
          <div><strong>{t("nexus433.senderSummary", { id: candidate.senderId, channel: candidate.channel + 1 })}</strong><small>{candidate.sample.temperature.toFixed(1)} °C · {candidate.sample.humidity}% · {t("nexus433.signal", { quality: candidate.sample.quality })}</small></div>
          {!readOnly && <div className="nexus433-candidate-action"><label><span>{t("nexus433.sensorTarget")}</span><select value={targetId} onChange={(event) => setTargets((current) => ({ ...current, [candidate.id]: event.target.value }))}><option value="">{t("nexus433.chooseSensor")}</option>{sensors.filter((sensor) => sensor.enabled).map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></label><button type="button" className="secondary-button" disabled={!targetId || busy === candidate.id} onClick={() => void assign(candidate)}>{busy === candidate.id && <LoaderCircle className="spin" size={14} aria-hidden="true" />}{reconnect ? t("nexus433.reconnect") : t("nexus433.attach")}</button></div>}
        </li>;
      })}</ul>;

  return <div className="nexus433-surface">
    {(error || status.runtime !== "connected" || candidates.length > 0 || attentionBindings.length > 0) && <section className="panel nexus433-attention" aria-labelledby="nexus433-attention-title">
      <div className="panel-header">
        <div><span className="eyebrow"><TriangleAlert size={14} aria-hidden="true" />{t("nexus433.eyebrow")}</span><h2 id="nexus433-attention-title">{t(candidates.length > 0 ? "nexus433.foundSenders" : "nexus433.sendersTitle")}</h2><p>{t("nexus433.sendersBody")}</p></div>
        <span className={`source-health-pill ${status.runtime === "connected" ? "connected" : "warning"}`} role="status" aria-live="polite">{status.runtime === "connected" ? <Check size={14} aria-hidden="true" /> : <LoaderCircle className="spin" size={14} aria-hidden="true" />}{status.runtime === "connected" ? t("nexus433.statusListening") : t("nexus433.statusStarting")}</span>
      </div>
      {error && <p className="field-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{error}</p>}
      {attentionBindings.length > 0 && <div className="nexus433-binding-list"><h3>{t("nexus433.connectedSensors")}</h3>{bindingList(attentionBindings)}</div>}
      {candidates.length > 0 && <div className="nexus433-candidate-list">{candidateList}{!readOnly && sensors.length === 0 && <button type="button" className="primary-button" onClick={onAddSensor}>{t("nexus433.addSensorFirst")}</button>}</div>}
    </section>}

    <details className="panel nexus433-senders">
      <summary>
        <span><RadioTower size={18} aria-hidden="true" /><span><strong>{t("nexus433.sendersTitle")}</strong><small>{t("nexus433.sendersBody")}</small></span></span>
        <span><span className={`source-health-pill ${status.runtime === "connected" ? "connected" : "warning"}`}>{status.runtime === "connected" ? <Check size={14} aria-hidden="true" /> : <LoaderCircle className="spin" size={14} aria-hidden="true" />}{status.runtime === "connected" ? t("nexus433.statusListening") : t("nexus433.statusStarting")}</span><ChevronDown size={17} aria-hidden="true" /></span>
      </summary>
      <div className="nexus433-management-body">
        {bindings.length > 0 && <div className="nexus433-binding-list"><h3>{t("nexus433.connectedSensors")}</h3>{bindingList(bindings)}</div>}
        <p>{candidates.length === 0 ? t("nexus433.noCandidates") : t("nexus433.foundSenders")}</p>
        <details><summary>{t("nexus433.idChangeTitle")}</summary><p>{t("nexus433.idChangeBody")}</p></details>
      </div>
    </details>
  </div>;
}
