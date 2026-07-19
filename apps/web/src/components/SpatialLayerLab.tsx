import { useEffect, useMemo, useState, type FormEvent, type SyntheticEvent } from "react";
import { Check, ChevronDown, FlaskConical, Plus, RefreshCw, Save } from "lucide-react";
import type { Sensor } from "@climate-twin/contracts";
import type { SpatialContextEventKind } from "@climate-twin/spatial-layers";
import { api } from "../api";
import type {
  SpatialContextEvent,
  SpatialCalibrationSession,
  SpatialCalibrationSessionKind,
  SpatialCalibrationSessionStatus,
  SpatialGroundTruth,
  SpatialLayerAssignment,
  SpatialLayerConfigurationResponse,
  SpatialSensorBinding,
  SpatialSensorCalibration,
} from "../spatialLayers";
import type { UseSpatialLayersResult } from "../useSpatialLayers";
import { useI18n, type TranslationKey } from "../i18n";
import { spatialLayerLabel } from "./SpatialLayerPanel";

interface SpatialLayerLabProps {
  houseId: string;
  sensors: readonly Sensor[];
  layers: UseSpatialLayersResult;
}

type Feedback = "saved" | "error" | null;

const contextKinds: SpatialContextEventKind[] = [
  "door-open", "window-open", "hvac-change", "heat-pump-change", "extractor-change", "dehumidifier-change",
  "heater-change", "cooking", "shower", "sauna", "solar-gain", "rapid-weather-change",
  "persistent-environmental-source", "known-empty", "known-occupied",
];
const groundTruthLabels: SpatialGroundTruth["label"][] = ["house_empty", "people_present", "zone_active", "transition", "false_positive", "unknown"];
const calibrationSessionKinds: SpatialCalibrationSessionKind[] = ["co-location", "empty-house-baseline", "controlled-propagation"];
const calibrationSessionStatuses: SpatialCalibrationSessionStatus[] = ["planned", "running", "completed", "cancelled"];

function localDateTimeInput(value = new Date()): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function identifier(prefix: string): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? `${prefix}-${globalThis.crypto.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assignmentsFromCatalog(layers: UseSpatialLayersResult): SpatialLayerAssignment[] {
  return layers.engines.map((engine) => ({ engineId: engine.id, engineVersion: engine.version, enabled: true, layerIds: engine.layerIds }));
}

export function SpatialLayerLab({ houseId, sensors, layers }: SpatialLayerLabProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loadedHouseId, setLoadedHouseId] = useState("");
  const [configuration, setConfiguration] = useState<SpatialLayerConfigurationResponse | null>(null);
  const [assignments, setAssignments] = useState<SpatialLayerAssignment[]>([]);
  const [bindings, setBindings] = useState<SpatialSensorBinding[]>([]);
  const [calibrations, setCalibrations] = useState<SpatialSensorCalibration[]>([]);
  const [calibrationSessions, setCalibrationSessions] = useState<SpatialCalibrationSession[]>([]);
  const [contextEvents, setContextEvents] = useState<SpatialContextEvent[]>([]);
  const [groundTruth, setGroundTruth] = useState<SpatialGroundTruth[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [advancedConfig, setAdvancedConfig] = useState("{}");
  const [configInvalid, setConfigInvalid] = useState(false);
  const [bindingSensorId, setBindingSensorId] = useState("");
  const [bindingZoneId, setBindingZoneId] = useState("");
  const [calibrationSensorId, setCalibrationSensorId] = useState("");
  const [temperatureOffset, setTemperatureOffset] = useState("0");
  const [humidityOffset, setHumidityOffset] = useState("0");
  const [calibrationConfidence, setCalibrationConfidence] = useState("0.7");
  const [sessionKind, setSessionKind] = useState<SpatialCalibrationSessionKind>("co-location");
  const [sessionStatus, setSessionStatus] = useState<SpatialCalibrationSessionStatus>("running");
  const [sessionStartAt, setSessionStartAt] = useState(() => localDateTimeInput());
  const [sessionEndAt, setSessionEndAt] = useState("");
  const [sessionIntervention, setSessionIntervention] = useState("");
  const [sessionNotes, setSessionNotes] = useState("");
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [contextKind, setContextKind] = useState<SpatialContextEventKind>("known-empty");
  const [contextZoneId, setContextZoneId] = useState("");
  const [truthLabel, setTruthLabel] = useState<SpatialGroundTruth["label"]>("house_empty");
  const [truthZoneId, setTruthZoneId] = useState("");

  const topology = configuration?.configuration.topology;
  const zones = topology?.zones ?? [];
  const eligibleSensors = useMemo(() => sensors.filter((sensor) => sensor.enabled), [sensors]);

  useEffect(() => {
    setLoadedHouseId("");
    setConfiguration(null);
    setAssignments([]);
    setBindings([]);
    setCalibrations([]);
    setCalibrationSessions([]);
    setContextEvents([]);
    setGroundTruth([]);
    setFeedback(null);
  }, [houseId]);

  useEffect(() => {
    if (!bindingSensorId || !eligibleSensors.some((sensor) => sensor.id === bindingSensorId)) setBindingSensorId(eligibleSensors[0]?.id ?? "");
    if (!calibrationSensorId || !eligibleSensors.some((sensor) => sensor.id === calibrationSensorId)) setCalibrationSensorId(eligibleSensors[0]?.id ?? "");
  }, [eligibleSensors, bindingSensorId, calibrationSensorId]);

  useEffect(() => {
    if (!bindingZoneId || !zones.some((zone) => zone.id === bindingZoneId)) setBindingZoneId(zones[0]?.id ?? "");
  }, [zones, bindingZoneId]);

  const load = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const [nextConfiguration, nextBindings, nextCalibrations, nextSessions, nextEvents, nextGroundTruth] = await Promise.all([
        api.houseSpatialLayerConfig(houseId),
        api.houseSpatialLayerBindings(houseId),
        api.houseSpatialLayerCalibrations(houseId),
        api.houseSpatialLayerCalibrationSessions(houseId),
        api.houseSpatialLayerContextEvents(houseId),
        api.houseSpatialLayerGroundTruth(houseId),
      ]);
      setConfiguration(nextConfiguration);
      setAssignments(nextConfiguration.assignments.length ? nextConfiguration.assignments : assignmentsFromCatalog(layers));
      setBindings(nextBindings);
      setCalibrations(nextCalibrations);
      setCalibrationSessions(nextSessions);
      setContextEvents(nextEvents);
      setGroundTruth(nextGroundTruth);
      setAdvancedConfig(JSON.stringify(nextConfiguration.configuration.config, null, 2));
      setLoadedHouseId(houseId);
    } catch {
      setFeedback("error");
    } finally {
      setLoading(false);
    }
  };

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    if (nextOpen && loadedHouseId !== houseId && !loading) void load();
  };

  const toggleAssignment = (engineId: string, enabled: boolean) => {
    setAssignments((current) => current.map((assignment) => assignment.engineId === engineId ? { ...assignment, enabled } : assignment));
    setFeedback(null);
  };

  const saveConfiguration = async () => {
    if (!configuration || pending) return;
    let parsed: unknown;
    try { parsed = JSON.parse(advancedConfig); }
    catch { setConfigInvalid(true); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setConfigInvalid(true); return; }
    setConfigInvalid(false);
    setPending(true);
    setFeedback(null);
    try {
      const saved = await api.updateHouseSpatialLayerConfig(houseId, {
        baseVersion: configuration.configuration.version,
        config: parsed as Record<string, unknown>,
        assignments,
        enabled: assignments.some((assignment) => assignment.enabled),
      });
      setConfiguration(saved);
      setAssignments(saved.assignments);
      setAdvancedConfig(JSON.stringify(saved.configuration.config, null, 2));
      setFeedback("saved");
      await layers.refresh();
    } catch {
      setFeedback("error");
    } finally {
      setPending(false);
    }
  };

  const addBinding = async (event: FormEvent) => {
    event.preventDefault();
    const sensor = eligibleSensors.find((candidate) => candidate.id === bindingSensorId);
    const zone = zones.find((candidate) => candidate.id === bindingZoneId);
    if (!sensor || !zone || pending) return;
    setPending(true); setFeedback(null);
    try {
      const binding = await api.createHouseSpatialLayerBinding(houseId, {
        sensorId: sensor.id,
        zoneId: zone.id,
        frameId: zone.frameId,
        position: { x: sensor.x, y: sensor.y, z: sensor.z },
        role: "primary",
        activeFrom: new Date().toISOString(),
      });
      setBindings((current) => [...current.filter((item) => item.sensorId !== binding.sensorId || item.activeTo), binding]);
      setFeedback("saved");
    } catch { setFeedback("error"); }
    finally { setPending(false); }
  };

  const addCalibration = async (event: FormEvent) => {
    event.preventDefault();
    const temperatureOffsetC = Number(temperatureOffset);
    const humidityOffsetPct = Number(humidityOffset);
    const confidence = Number(calibrationConfidence);
    if (!calibrationSensorId || !Number.isFinite(temperatureOffsetC) || !Number.isFinite(humidityOffsetPct) || !Number.isFinite(confidence) || pending) return;
    setPending(true); setFeedback(null);
    try {
      const calibration = await api.createHouseSpatialLayerCalibration(houseId, {
        sensorId: calibrationSensorId,
        validFrom: new Date().toISOString(),
        temperatureOffsetC,
        humidityOffsetPct,
        confidence: Math.max(0, Math.min(1, confidence)),
        method: "manual",
      });
      setCalibrations((current) => [...current, calibration]);
      setFeedback("saved");
    } catch { setFeedback("error"); }
    finally { setPending(false); }
  };

  const addCalibrationSession = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const start = Date.parse(sessionStartAt);
    const end = sessionEndAt ? Date.parse(sessionEndAt) : null;
    const invalid = !Number.isFinite(start)
      || (sessionStatus === "completed" && end === null)
      || (end !== null && (!Number.isFinite(end) || end < start));
    if (invalid) { setSessionInvalid(true); return; }
    setSessionInvalid(false);
    setPending(true);
    setFeedback(null);
    try {
      const result = await api.createHouseSpatialLayerCalibrationSession(houseId, {
        kind: sessionKind,
        status: sessionStatus,
        startAt: new Date(start).toISOString(),
        ...(end === null ? { endAt: null } : { endAt: new Date(end).toISOString() }),
        ...(sessionIntervention.trim() ? { intervention: { description: sessionIntervention.trim() } } : {}),
        ...(sessionNotes.trim() ? { notes: sessionNotes.trim() } : { notes: null }),
      });
      setCalibrationSessions((current) => [result.session, ...current.filter((item) => item.id !== result.session.id)]);
      if (result.calibrations.length) setCalibrations((current) => [...current, ...result.calibrations]);
      setSessionIntervention("");
      setSessionNotes("");
      setSessionStartAt(localDateTimeInput());
      setSessionEndAt("");
      setFeedback("saved");
    } catch { setFeedback("error"); }
    finally { setPending(false); }
  };

  const addContext = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setFeedback(null);
    try {
      const saved = await api.createHouseSpatialLayerContextEvent(houseId, {
        id: identifier("context"), kind: contextKind, startAt: new Date().toISOString(),
        ...(contextZoneId ? { zoneIds: [contextZoneId] } : {}),
      });
      setContextEvents((current) => [...current, saved]);
      setFeedback("saved");
    } catch { setFeedback("error"); }
    finally { setPending(false); }
  };

  const addGroundTruth = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setFeedback(null);
    try {
      const saved = await api.createHouseSpatialLayerGroundTruth(houseId, {
        id: identifier("truth"), startAt: new Date().toISOString(), label: truthLabel, source: "user",
        ...(truthZoneId && truthLabel === "zone_active" ? { zoneId: truthZoneId } : {}),
      });
      setGroundTruth((current) => [...current, saved]);
      setFeedback("saved");
    } catch { setFeedback("error"); }
    finally { setPending(false); }
  };

  if (!layers.available) return null;
  return <details className="spatial-layer-lab panel compact-panel" open={open} onToggle={onToggle}>
    <summary><span className="home-tools-icon" aria-hidden="true"><FlaskConical size={19} /></span><span><span className="eyebrow">{t("spatial.lab.eyebrow")}</span><strong>{t("spatial.lab.title")}</strong><small>{t("spatial.lab.description")}</small></span><ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" /></summary>
    <div className="spatial-lab-content">
      {loading && <p role="status">{t("common.loading")}</p>}
      {!loading && configuration && <>
        <section className="spatial-lab-section">
          <div className="panel-header"><div><h3>{t("spatial.lab.engines")}</h3><p>{t("spatial.lab.enginesHelp")}</p></div><button type="button" className="icon-button small" aria-label={t("spatial.refresh")} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" /></button></div>
          <div className="spatial-engine-list">{assignments.map((assignment) => {
            const engine = layers.engines.find((candidate) => candidate.id === assignment.engineId);
            const health = layers.health.find((candidate) => candidate.engineId === assignment.engineId);
            return <label key={assignment.engineId}><input type="checkbox" checked={assignment.enabled} disabled={pending} onChange={(event) => toggleAssignment(assignment.engineId, event.target.checked)} /><span><strong>{engine?.title ?? engine?.name ?? assignment.engineId}</strong><small>{assignment.layerIds.map((id) => spatialLayerLabel(id, t)).join(" · ")}</small></span><em data-state={health?.state ?? "unknown"}>{t(`spatial.health.${health?.state ?? "unknown"}` as TranslationKey)}</em></label>;
          })}</div>
          <label className="field"><span>{t("spatial.lab.advancedConfig")}</span><textarea rows={5} value={advancedConfig} aria-invalid={configInvalid} onChange={(event) => { setAdvancedConfig(event.target.value); setConfigInvalid(false); }} /></label>
          {configInvalid && <p className="inline-error" role="alert">{t("spatial.lab.invalidConfig")}</p>}
          <button type="button" className="primary-button" disabled={pending} onClick={() => void saveConfiguration()}><Save size={14} aria-hidden="true" />{t("common.save")}</button>
        </section>

        <section className="spatial-lab-section"><h3>{t("spatial.lab.topology")}</h3><dl className="spatial-lab-facts"><div><dt>{t("spatial.lab.zones")}</dt><dd>{zones.length}</dd></div><div><dt>{t("spatial.lab.connections")}</dt><dd>{topology?.connections.length ?? 0}</dd></div><div><dt>{t("spatial.lab.bindings")}</dt><dd>{bindings.filter((binding) => !binding.activeTo).length}</dd></div><div><dt>{t("spatial.lab.calibrations")}</dt><dd>{calibrations.length}</dd></div><div><dt>{t("spatial.lab.sessions")}</dt><dd>{calibrationSessions.length}</dd></div></dl>
          <form className="spatial-lab-form" onSubmit={(event) => void addBinding(event)}><label><span>{t("spatial.lab.sensor")}</span><select value={bindingSensorId} onChange={(event) => setBindingSensorId(event.target.value)}>{eligibleSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></label><label><span>{t("spatial.lab.zone")}</span><select value={bindingZoneId} onChange={(event) => setBindingZoneId(event.target.value)}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label><button type="submit" className="secondary-button" disabled={pending || !bindingSensorId || !bindingZoneId}><Plus size={14} aria-hidden="true" />{t("spatial.lab.addBinding")}</button></form>
        </section>

        <section className="spatial-lab-section">
          <h3>{t("spatial.lab.calibrationSessions")}</h3>
          <p>{t("spatial.lab.calibrationSessionsHelp")}</p>
          {calibrationSessions.some((session) => session.kind === "empty-house-baseline" && session.status === "running") && <p className="spatial-learning-state" role="status">{t("spatial.lab.learningBaseline")}</p>}
          <form className="spatial-lab-form calibration-session" onSubmit={(event) => void addCalibrationSession(event)}>
            <label><span>{t("spatial.lab.sessionKind")}</span><select value={sessionKind} onChange={(event) => setSessionKind(event.target.value as SpatialCalibrationSessionKind)}>{calibrationSessionKinds.map((kind) => <option key={kind} value={kind}>{t(`spatial.session.kind.${kind}` as TranslationKey)}</option>)}</select></label>
            <label><span>{t("spatial.lab.sessionStatus")}</span><select value={sessionStatus} onChange={(event) => { setSessionStatus(event.target.value as SpatialCalibrationSessionStatus); setSessionInvalid(false); }}>{calibrationSessionStatuses.map((status) => <option key={status} value={status}>{t(`spatial.session.status.${status}` as TranslationKey)}</option>)}</select></label>
            <label><span>{t("spatial.lab.sessionStart")}</span><input type="datetime-local" required value={sessionStartAt} onChange={(event) => { setSessionStartAt(event.target.value); setSessionInvalid(false); }} /></label>
            <label><span>{t("spatial.lab.sessionEnd")}</span><input type="datetime-local" required={sessionStatus === "completed"} value={sessionEndAt} onChange={(event) => { setSessionEndAt(event.target.value); setSessionInvalid(false); }} /></label>
            <label className="spatial-session-wide"><span>{t("spatial.lab.sessionIntervention")}</span><input value={sessionIntervention} onChange={(event) => setSessionIntervention(event.target.value)} placeholder={t("spatial.lab.sessionInterventionPlaceholder")} /></label>
            <label className="spatial-session-wide"><span>{t("spatial.lab.sessionNotes")}</span><textarea rows={2} value={sessionNotes} onChange={(event) => setSessionNotes(event.target.value)} /></label>
            {sessionInvalid && <p className="inline-error spatial-session-wide" role="alert">{t("spatial.lab.sessionInvalid")}</p>}
            <button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordSession")}</button>
          </form>
          {calibrationSessions.length === 0 ? <small>{t("spatial.lab.noSessions")}</small> : <ol className="spatial-session-list">{[...calibrationSessions].sort((left, right) => right.startAt.localeCompare(left.startAt)).slice(0, 5).map((session) => <li key={session.id} data-status={session.status}><span><strong>{t(`spatial.session.kind.${session.kind}` as TranslationKey)}</strong><small><time dateTime={session.startAt}>{new Date(session.startAt).toLocaleString(locale)}</time>{session.endAt ? <> {"\u2013"} <time dateTime={session.endAt}>{new Date(session.endAt).toLocaleString(locale)}</time></> : null}</small></span><em>{session.kind === "empty-house-baseline" && session.status === "running" ? t("spatial.lab.learning") : t(`spatial.session.status.${session.status}` as TranslationKey)}</em></li>)}</ol>}
        </section>

        <section className="spatial-lab-section"><h3>{t("spatial.lab.calibration")}</h3><p>{t("spatial.lab.calibrationHelp")}</p><form className="spatial-lab-form calibration" onSubmit={(event) => void addCalibration(event)}><label><span>{t("spatial.lab.sensor")}</span><select value={calibrationSensorId} onChange={(event) => setCalibrationSensorId(event.target.value)}>{eligibleSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></label><label><span>{t("spatial.lab.temperatureOffset")}</span><input type="number" step="0.1" value={temperatureOffset} onChange={(event) => setTemperatureOffset(event.target.value)} /></label><label><span>{t("spatial.lab.humidityOffset")}</span><input type="number" step="0.1" value={humidityOffset} onChange={(event) => setHumidityOffset(event.target.value)} /></label><label><span>{t("spatial.lab.confidence")}</span><input type="number" min="0" max="1" step="0.05" value={calibrationConfidence} onChange={(event) => setCalibrationConfidence(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={pending || !calibrationSensorId}><Plus size={14} aria-hidden="true" />{t("spatial.lab.addCalibration")}</button></form></section>

        <div className="spatial-lab-grid"><section className="spatial-lab-section"><h3>{t("spatial.lab.context")}</h3><p>{t("spatial.lab.contextHelp")}</p><form className="spatial-lab-form stacked" onSubmit={(event) => void addContext(event)}><label><span>{t("spatial.lab.event")}</span><select value={contextKind} onChange={(event) => setContextKind(event.target.value as SpatialContextEventKind)}>{contextKinds.map((kind) => <option key={kind} value={kind}>{t(`spatial.context.${kind}` as TranslationKey)}</option>)}</select></label><label><span>{t("spatial.lab.zoneOptional")}</span><select value={contextZoneId} onChange={(event) => setContextZoneId(event.target.value)}><option value="">{t("spatial.lab.wholeHouse")}</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label><button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordContext")}</button></form><small>{t("spatial.lab.recordedCount", { count: contextEvents.length })}</small></section>
          <section className="spatial-lab-section"><h3>{t("spatial.lab.groundTruth")}</h3><p>{t("spatial.lab.groundTruthHelp")}</p><form className="spatial-lab-form stacked" onSubmit={(event) => void addGroundTruth(event)}><label><span>{t("spatial.lab.label")}</span><select value={truthLabel} onChange={(event) => setTruthLabel(event.target.value as SpatialGroundTruth["label"])}>{groundTruthLabels.map((label) => <option key={label} value={label}>{t(`spatial.truth.${label}` as TranslationKey)}</option>)}</select></label>{truthLabel === "zone_active" && <label><span>{t("spatial.lab.zone")}</span><select value={truthZoneId} onChange={(event) => setTruthZoneId(event.target.value)}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>}<button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordLabel")}</button></form><small>{t("spatial.lab.recordedCount", { count: groundTruth.length })}</small></section></div>
      </>}
      {feedback === "saved" && <p className="success-message" role="status"><Check size={14} aria-hidden="true" />{t("spatial.lab.saved")}</p>}
      {feedback === "error" && <p className="inline-error" role="alert">{t("spatial.lab.failed")}</p>}
    </div>
  </details>;
}
