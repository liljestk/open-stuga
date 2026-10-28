import { useEffect, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { Check, ChevronDown, FlaskConical, Play, Plus, RefreshCw, Save, Square } from "lucide-react";
import type { Sensor } from "@climate-twin/contracts";
import type { SpatialContextEventKind } from "@climate-twin/spatial-layers";
import { api } from "../api";
import { createClientUuid } from "../clientUuid";
import type {
  SpatialContextEvent,
  SpatialCalibrationSession,
  SpatialCalibrationSessionKind,
  SpatialCalibrationSessionStatus,
  SpatialGroundTruth,
  SpatialInferenceSession,
  SpatialLayerAssignment,
  SpatialLayerConfigurationResponse,
  SpatialSensorBinding,
  SpatialSensorCalibration,
} from "../spatial/layers";
import { formatInTimeZone, twentyFourHourInputLocale } from "../dateTime";
import type { UseSpatialLayersResult } from "../spatial/useSpatialLayers";
import { useI18n } from "../i18n";
import { spatialLayerLabel } from "./SpatialLayerPanel";

interface SpatialLayerLabProps {
  houseId: string;
  sensors: readonly Sensor[];
  layers: UseSpatialLayersResult;
  onActiveChange?: (active: boolean) => void;
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
const inferenceDurationPresets = [30, 60, 120, 240] as const;
const inferenceCadencePresets = [5, 10, 15, 30] as const;

function localDateTimeInput(value = new Date()): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function identifier(prefix: string): string {
  return `${prefix}-${createClientUuid()}`;
}

function assignmentsFromCatalog(layers: UseSpatialLayersResult): SpatialLayerAssignment[] {
  return layers.engines.map((engine) => ({ engineId: engine.id, engineVersion: engine.version, enabled: true, layerIds: engine.layerIds }));
}

export function SpatialLayerLab({ houseId, sensors, layers, onActiveChange }: SpatialLayerLabProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loadedHouseId, setLoadedHouseId] = useState("");
  const [configuration, setConfiguration] = useState<SpatialLayerConfigurationResponse | null>(null);
  const [assignments, setAssignments] = useState<SpatialLayerAssignment[]>([]);
  const [bindings, setBindings] = useState<SpatialSensorBinding[]>([]);
  const [calibrations, setCalibrations] = useState<SpatialSensorCalibration[]>([]);
  const [calibrationSessions, setCalibrationSessions] = useState<SpatialCalibrationSession[]>([]);
  const [inferenceSession, setInferenceSession] = useState<SpatialInferenceSession | null>(null);
  const [contextEvents, setContextEvents] = useState<SpatialContextEvent[]>([]);
  const [groundTruth, setGroundTruth] = useState<SpatialGroundTruth[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [inferenceFeedback, setInferenceFeedback] = useState<"started" | "stopped" | "error" | null>(null);
  const [inferenceDuration, setInferenceDuration] = useState("60");
  const [inferenceCadence, setInferenceCadence] = useState("10");
  const [sessionClock, setSessionClock] = useState(() => Date.now());
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
  const openRef = useRef(false);
  const activeHouseId = useRef(houseId);
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const sessionController = useRef<AbortController | null>(null);
  const sessionGeneration = useRef(0);
  const mutationController = useRef<AbortController | null>(null);
  const mutationGeneration = useRef(0);
  const activeChange = useRef(onActiveChange);
  activeChange.current = onActiveChange;
  activeHouseId.current = houseId;

  const topology = configuration?.configuration.topology;
  const zones = topology?.zones ?? [];
  const eligibleSensors = useMemo(() => sensors.filter((sensor) => sensor.enabled), [sensors]);
  const inferenceStatus = !inferenceSession ? "off"
    : inferenceSession.status === "active" && Date.parse(inferenceSession.expiresAt) <= sessionClock ? "expired"
      : inferenceSession.status;
  const inferenceActive = inferenceStatus === "active";

  useEffect(() => {
    loadController.current?.abort();
    loadController.current = null;
    loadGeneration.current += 1;
    sessionController.current?.abort();
    sessionController.current = null;
    sessionGeneration.current += 1;
    mutationController.current?.abort();
    mutationController.current = null;
    mutationGeneration.current += 1;
    setLoadedHouseId("");
    setConfiguration(null);
    setAssignments([]);
    setBindings([]);
    setCalibrations([]);
    setCalibrationSessions([]);
    setInferenceSession(null);
    setContextEvents([]);
    setGroundTruth([]);
    setFeedback(null);
    setInferenceFeedback(null);
    setLoading(false);
    setPending(false);
    setOpen(false);
    openRef.current = false;
  }, [houseId]);

  useEffect(() => () => {
    loadController.current?.abort();
    sessionController.current?.abort();
    mutationController.current?.abort();
    loadGeneration.current += 1;
    sessionGeneration.current += 1;
    mutationGeneration.current += 1;
    activeChange.current?.(false);
  }, []);

  useEffect(() => {
    if (!open || !inferenceActive) return undefined;
    const timer = window.setInterval(() => setSessionClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open, inferenceActive, inferenceSession?.expiresAt]);

  useEffect(() => {
    if (!bindingSensorId || !eligibleSensors.some((sensor) => sensor.id === bindingSensorId)) setBindingSensorId(eligibleSensors[0]?.id ?? "");
    if (!calibrationSensorId || !eligibleSensors.some((sensor) => sensor.id === calibrationSensorId)) setCalibrationSensorId(eligibleSensors[0]?.id ?? "");
  }, [eligibleSensors, bindingSensorId, calibrationSensorId]);

  useEffect(() => {
    if (!bindingZoneId || !zones.some((zone) => zone.id === bindingZoneId)) setBindingZoneId(zones[0]?.id ?? "");
  }, [zones, bindingZoneId]);

  const load = async () => {
    const targetHouseId = houseId;
    const requestId = ++loadGeneration.current;
    loadController.current?.abort();
    sessionController.current?.abort();
    sessionController.current = null;
    sessionGeneration.current += 1;
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setFeedback(null);
    setInferenceFeedback(null);
    setSessionClock(Date.now());
    try {
      const [nextConfiguration, nextInferenceSession, nextBindings, nextCalibrations, nextSessions, nextEvents, nextGroundTruth] = await Promise.all([
        api.houseSpatialLayerConfig(targetHouseId, controller.signal),
        api.houseSpatialInferenceSession(targetHouseId, controller.signal),
        api.houseSpatialLayerBindings(targetHouseId, controller.signal),
        api.houseSpatialLayerCalibrations(targetHouseId, controller.signal),
        api.houseSpatialLayerCalibrationSessions(targetHouseId, controller.signal),
        api.houseSpatialLayerContextEvents(targetHouseId, controller.signal),
        api.houseSpatialLayerGroundTruth(targetHouseId, controller.signal),
      ]);
      if (controller.signal.aborted || requestId !== loadGeneration.current
          || activeHouseId.current !== targetHouseId) return;
      setConfiguration(nextConfiguration);
      setInferenceSession(nextInferenceSession);
      setAssignments(nextConfiguration.assignments.length ? nextConfiguration.assignments : assignmentsFromCatalog(layers));
      setBindings(nextBindings);
      setCalibrations(nextCalibrations);
      setCalibrationSessions(nextSessions);
      setContextEvents(nextEvents);
      setGroundTruth(nextGroundTruth);
      setAdvancedConfig(JSON.stringify(nextConfiguration.configuration.config, null, 2));
      setLoadedHouseId(targetHouseId);
    } catch {
      if (!controller.signal.aborted && requestId === loadGeneration.current) setFeedback("error");
    } finally {
      if (loadController.current === controller) loadController.current = null;
      if (!controller.signal.aborted && requestId === loadGeneration.current) setLoading(false);
    }
  };

  const revalidateInferenceSession = async () => {
    // Start/Stop responses are authoritative for the singular session resource.
    // A visibility catch-up must not supersede their generation while pending.
    if (mutationController.current) return;
    const targetHouseId = houseId;
    const requestId = ++sessionGeneration.current;
    sessionController.current?.abort();
    const controller = new AbortController();
    sessionController.current = controller;
    setSessionClock(Date.now());
    try {
      const next = await api.houseSpatialInferenceSession(targetHouseId, controller.signal);
      if (controller.signal.aborted || requestId !== sessionGeneration.current
          || activeHouseId.current !== targetHouseId) return;
      setInferenceSession(next);
    } catch {
      if (!controller.signal.aborted && requestId === sessionGeneration.current) setInferenceFeedback("error");
    } finally {
      if (sessionController.current === controller) sessionController.current = null;
    }
  };

  useEffect(() => {
    if (!open || !layers.available) return;
    if (loadedHouseId !== houseId) void load();
    else void revalidateInferenceSession();
    // A Home can change while the parent disclosure remains mounted and open.
    // The request generation above fences any late response from the old Home.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseId, layers.available, open]);

  useEffect(() => {
    if (!open || loadedHouseId !== houseId) return;
    const catchUp = () => {
      if (document.visibilityState !== "hidden") void revalidateInferenceSession();
    };
    document.addEventListener("visibilitychange", catchUp);
    return () => document.removeEventListener("visibilitychange", catchUp);
    // Revalidation intentionally follows disclosure/House identity, not every
    // layer render from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseId, loadedHouseId, open]);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open;
    // Native <details> toggle events are coalesced and can be delivered again
    // after the controlled `open` attribute has already caught up.
    if (nextOpen === openRef.current) return;
    openRef.current = nextOpen;
    setOpen(nextOpen);
    activeChange.current?.(nextOpen);
    if (!nextOpen) {
      loadController.current?.abort();
      loadController.current = null;
      loadGeneration.current += 1;
      if (sessionController.current) {
        sessionController.current.abort();
        sessionController.current = null;
        sessionGeneration.current += 1;
      }
      if (mutationController.current) {
        mutationController.current.abort();
        mutationController.current = null;
        mutationGeneration.current += 1;
      }
      setLoading(false);
      setPending(false);
      return;
    }
    setSessionClock(Date.now());
  };

  const toggleAssignment = (engineId: string, enabled: boolean) => {
    setAssignments((current) => current.map((assignment) => assignment.engineId === engineId ? { ...assignment, enabled } : assignment));
    setFeedback(null);
  };

  const beginMutation = (): AbortController => {
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    return controller;
  };

  const finishMutation = (controller: AbortController): void => {
    if (mutationController.current === controller) mutationController.current = null;
  };

  const saveConfiguration = async () => {
    if (!configuration || pending) return;
    let parsed: unknown;
    try { parsed = JSON.parse(advancedConfig); }
    catch { setConfigInvalid(true); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setConfigInvalid(true); return; }
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setConfigInvalid(false);
    setPending(true);
    setFeedback(null);
    try {
      const saved = await api.updateHouseSpatialLayerConfig(targetHouseId, {
        baseVersion: configuration.configuration.version,
        config: parsed as Record<string, unknown>,
        assignments,
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setConfiguration(saved);
      setAssignments(saved.assignments);
      setAdvancedConfig(JSON.stringify(saved.configuration.config, null, 2));
      setFeedback("saved");
      await layers.refresh();
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const startInference = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setInferenceFeedback(null);
    sessionController.current?.abort();
    sessionController.current = null;
    const targetHouseId = houseId;
    const requestId = ++sessionGeneration.current;
    const controller = beginMutation();
    try {
      const session = await api.startHouseSpatialInferenceSession(targetHouseId, {
        durationMinutes: Number(inferenceDuration),
        cadenceMinutes: Number(inferenceCadence),
      }, controller.signal);
      if (controller.signal.aborted || requestId !== sessionGeneration.current || activeHouseId.current !== targetHouseId) return;
      setInferenceSession(session);
      setSessionClock(Date.now());
      setInferenceFeedback("started");
    } catch {
      if (!controller.signal.aborted && requestId === sessionGeneration.current && activeHouseId.current === targetHouseId) setInferenceFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === sessionGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const stopInference = async () => {
    if (pending) return;
    setPending(true);
    setInferenceFeedback(null);
    sessionController.current?.abort();
    sessionController.current = null;
    const targetHouseId = houseId;
    const requestId = ++sessionGeneration.current;
    const controller = beginMutation();
    try {
      const stopped = await api.stopHouseSpatialInferenceSession(targetHouseId, controller.signal);
      if (controller.signal.aborted || requestId !== sessionGeneration.current || activeHouseId.current !== targetHouseId) return;
      setInferenceSession(stopped);
      setSessionClock(Date.now());
      setInferenceFeedback("stopped");
    } catch {
      if (!controller.signal.aborted && requestId === sessionGeneration.current && activeHouseId.current === targetHouseId) setInferenceFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === sessionGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const addBinding = async (event: FormEvent) => {
    event.preventDefault();
    const sensor = eligibleSensors.find((candidate) => candidate.id === bindingSensorId);
    const zone = zones.find((candidate) => candidate.id === bindingZoneId);
    if (!sensor || !zone || pending) return;
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setPending(true); setFeedback(null);
    try {
      const binding = await api.createHouseSpatialLayerBinding(targetHouseId, {
        sensorId: sensor.id,
        zoneId: zone.id,
        frameId: zone.frameId,
        position: { x: sensor.x, y: sensor.y, z: sensor.z },
        role: "primary",
        activeFrom: new Date().toISOString(),
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setBindings((current) => [...current.filter((item) => item.sensorId !== binding.sensorId || item.activeTo), binding]);
      setFeedback("saved");
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const addCalibration = async (event: FormEvent) => {
    event.preventDefault();
    const temperatureOffsetC = Number(temperatureOffset);
    const humidityOffsetPct = Number(humidityOffset);
    const confidence = Number(calibrationConfidence);
    if (!calibrationSensorId || !Number.isFinite(temperatureOffsetC) || !Number.isFinite(humidityOffsetPct) || !Number.isFinite(confidence) || pending) return;
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setPending(true); setFeedback(null);
    try {
      const calibration = await api.createHouseSpatialLayerCalibration(targetHouseId, {
        sensorId: calibrationSensorId,
        validFrom: new Date().toISOString(),
        temperatureOffsetC,
        humidityOffsetPct,
        confidence: Math.max(0, Math.min(1, confidence)),
        method: "manual",
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setCalibrations((current) => [...current, calibration]);
      setFeedback("saved");
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
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
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setSessionInvalid(false);
    setPending(true);
    setFeedback(null);
    try {
      const result = await api.createHouseSpatialLayerCalibrationSession(targetHouseId, {
        kind: sessionKind,
        status: sessionStatus,
        startAt: new Date(start).toISOString(),
        ...(end === null ? { endAt: null } : { endAt: new Date(end).toISOString() }),
        ...(sessionIntervention.trim() ? { intervention: { description: sessionIntervention.trim() } } : {}),
        ...(sessionNotes.trim() ? { notes: sessionNotes.trim() } : { notes: null }),
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setCalibrationSessions((current) => [result.session, ...current.filter((item) => item.id !== result.session.id)]);
      if (result.calibrations.length) setCalibrations((current) => [...current, ...result.calibrations]);
      setSessionIntervention("");
      setSessionNotes("");
      setSessionStartAt(localDateTimeInput());
      setSessionEndAt("");
      setFeedback("saved");
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const addContext = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setPending(true); setFeedback(null);
    try {
      const saved = await api.createHouseSpatialLayerContextEvent(targetHouseId, {
        id: identifier("context"), kind: contextKind, startAt: new Date().toISOString(),
        ...(contextZoneId ? { zoneIds: [contextZoneId] } : {}),
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setContextEvents((current) => [...current, saved]);
      setFeedback("saved");
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  const addGroundTruth = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const targetHouseId = houseId;
    const requestId = ++mutationGeneration.current;
    const controller = beginMutation();
    setPending(true); setFeedback(null);
    try {
      const saved = await api.createHouseSpatialLayerGroundTruth(targetHouseId, {
        id: identifier("truth"), startAt: new Date().toISOString(), label: truthLabel, source: "user",
        ...(truthZoneId && truthLabel === "zone_active" ? { zoneId: truthZoneId } : {}),
      }, controller.signal);
      if (controller.signal.aborted || requestId !== mutationGeneration.current || activeHouseId.current !== targetHouseId) return;
      setGroundTruth((current) => [...current, saved]);
      setFeedback("saved");
    } catch {
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setFeedback("error");
    } finally {
      finishMutation(controller);
      if (!controller.signal.aborted && requestId === mutationGeneration.current && activeHouseId.current === targetHouseId) setPending(false);
    }
  };

  return <details className="spatial-layer-lab panel compact-panel" open={open} onToggle={onToggle}>
    <summary><span className="home-tools-icon" aria-hidden="true"><FlaskConical size={19} /></span><span><span className="eyebrow">{t("spatial.lab.eyebrow")}</span><strong>{t("spatial.lab.title")}</strong><small>{t("spatial.lab.description")}</small></span><ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" /></summary>
    <div className="spatial-lab-content">
      {(layers.loading || loading) && <p role="status">{t("common.loading")}</p>}
      {!layers.loading && !layers.available && <p className="spatial-empty" role="status">{t("spatial.lab.unavailable")}</p>}
      {!layers.loading && !loading && layers.available && configuration && <>
        <section className="spatial-lab-section">
          <div className="panel-header"><div><h3>{t("spatial.inference.title")}</h3><p>{t("spatial.inference.description")}</p></div><strong role="status">{t(`spatial.inference.status.${inferenceStatus}`)}</strong></div>
          <p>{t("spatial.inference.retained")}</p>
          {inferenceActive && inferenceSession ? <>
            <dl className="spatial-lab-facts">
              <div><dt>{t("spatial.inference.statusLabel")}</dt><dd>{t("spatial.inference.status.active")}</dd></div>
              <div><dt>{t("spatial.inference.cadence")}</dt><dd>{t("spatial.inference.minutes", { count: inferenceSession.cadenceMinutes })}</dd></div>
              <div><dt>{t("spatial.inference.expires")}</dt><dd><time dateTime={inferenceSession.expiresAt}>{formatInTimeZone(inferenceSession.expiresAt, locale, undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></dd></div>
            </dl>
            <button type="button" className="secondary-button" disabled={pending} onClick={() => void stopInference()}><Square size={14} aria-hidden="true" />{t("spatial.inference.stop")}</button>
          </> : <form className="spatial-lab-form" onSubmit={(event) => void startInference(event)}>
            <label><span>{t("spatial.inference.duration")}</span><select value={inferenceDuration} onChange={(event) => setInferenceDuration(event.target.value)}>{inferenceDurationPresets.map((minutes) => <option key={minutes} value={minutes}>{t("spatial.inference.minutes", { count: minutes })}</option>)}</select></label>
            <label><span>{t("spatial.inference.cadence")}</span><select value={inferenceCadence} onChange={(event) => setInferenceCadence(event.target.value)}>{inferenceCadencePresets.map((minutes) => <option key={minutes} value={minutes}>{t("spatial.inference.minutes", { count: minutes })}</option>)}</select></label>
            <button type="submit" className="primary-button" disabled={pending}><Play size={14} aria-hidden="true" />{t("spatial.inference.start")}</button>
          </form>}
          {inferenceFeedback === "started" && <p className="success-message" role="status"><Check size={14} aria-hidden="true" />{t("spatial.inference.started")}</p>}
          {inferenceFeedback === "stopped" && <p className="success-message" role="status"><Check size={14} aria-hidden="true" />{t("spatial.inference.stopped")}</p>}
          {inferenceFeedback === "error" && <p className="inline-error" role="alert">{t("spatial.inference.failed")}</p>}
        </section>

        <section className="spatial-lab-section">
          <div className="panel-header"><div><h3>{t("spatial.lab.engines")}</h3><p>{t("spatial.lab.enginesHelp")}</p></div><button type="button" className="icon-button small" aria-label={t("spatial.refresh")} disabled={loading || pending} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" /></button></div>
          <div className="spatial-engine-list">{assignments.map((assignment) => {
            const engine = layers.engines.find((candidate) => candidate.id === assignment.engineId);
            const health = layers.health.find((candidate) => candidate.engineId === assignment.engineId);
            return <label key={assignment.engineId}><input type="checkbox" checked={assignment.enabled} disabled={pending} onChange={(event) => toggleAssignment(assignment.engineId, event.target.checked)} /><span><strong>{engine?.title ?? engine?.name ?? assignment.engineId}</strong><small>{assignment.layerIds.map((id) => spatialLayerLabel(id, t)).join(" · ")}</small></span><em data-state={health?.state ?? "unknown"}>{t(`spatial.health.${health?.state ?? "unknown"}`)}</em></label>;
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
            <label><span>{t("spatial.lab.sessionKind")}</span><select value={sessionKind} onChange={(event) => setSessionKind(event.target.value as SpatialCalibrationSessionKind)}>{calibrationSessionKinds.map((kind) => <option key={kind} value={kind}>{t(`spatial.session.kind.${kind}`)}</option>)}</select></label>
            <label><span>{t("spatial.lab.sessionStatus")}</span><select value={sessionStatus} onChange={(event) => { setSessionStatus(event.target.value as SpatialCalibrationSessionStatus); setSessionInvalid(false); }}>{calibrationSessionStatuses.map((status) => <option key={status} value={status}>{t(`spatial.session.status.${status}`)}</option>)}</select></label>
            <label><span>{t("spatial.lab.sessionStart")}</span><input type="datetime-local" lang={twentyFourHourInputLocale(locale)} required value={sessionStartAt} onChange={(event) => { setSessionStartAt(event.target.value); setSessionInvalid(false); }} /></label>
            <label><span>{t("spatial.lab.sessionEnd")}</span><input type="datetime-local" lang={twentyFourHourInputLocale(locale)} required={sessionStatus === "completed"} value={sessionEndAt} onChange={(event) => { setSessionEndAt(event.target.value); setSessionInvalid(false); }} /></label>
            <label className="spatial-session-wide"><span>{t("spatial.lab.sessionIntervention")}</span><input value={sessionIntervention} onChange={(event) => setSessionIntervention(event.target.value)} placeholder={t("spatial.lab.sessionInterventionPlaceholder")} /></label>
            <label className="spatial-session-wide"><span>{t("spatial.lab.sessionNotes")}</span><textarea rows={2} value={sessionNotes} onChange={(event) => setSessionNotes(event.target.value)} /></label>
            {sessionInvalid && <p className="inline-error spatial-session-wide" role="alert">{t("spatial.lab.sessionInvalid")}</p>}
            <button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordSession")}</button>
          </form>
          {calibrationSessions.length === 0 ? <small>{t("spatial.lab.noSessions")}</small> : <ol className="spatial-session-list">{[...calibrationSessions].sort((left, right) => right.startAt.localeCompare(left.startAt)).slice(0, 5).map((session) => <li key={session.id} data-status={session.status}><span><strong>{t(`spatial.session.kind.${session.kind}`)}</strong><small><time dateTime={session.startAt}>{formatInTimeZone(session.startAt, locale, undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>{session.endAt ? <> {"\u2013"} <time dateTime={session.endAt}>{formatInTimeZone(session.endAt, locale, undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</time></> : null}</small></span><em>{session.kind === "empty-house-baseline" && session.status === "running" ? t("spatial.lab.learning") : t(`spatial.session.status.${session.status}`)}</em></li>)}</ol>}
        </section>

        <section className="spatial-lab-section"><h3>{t("spatial.lab.calibration")}</h3><p>{t("spatial.lab.calibrationHelp")}</p><form className="spatial-lab-form calibration" onSubmit={(event) => void addCalibration(event)}><label><span>{t("spatial.lab.sensor")}</span><select value={calibrationSensorId} onChange={(event) => setCalibrationSensorId(event.target.value)}>{eligibleSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name}</option>)}</select></label><label><span>{t("spatial.lab.temperatureOffset")}</span><input type="number" step="0.1" value={temperatureOffset} onChange={(event) => setTemperatureOffset(event.target.value)} /></label><label><span>{t("spatial.lab.humidityOffset")}</span><input type="number" step="0.1" value={humidityOffset} onChange={(event) => setHumidityOffset(event.target.value)} /></label><label><span>{t("spatial.lab.confidence")}</span><input type="number" min="0" max="1" step="0.05" value={calibrationConfidence} onChange={(event) => setCalibrationConfidence(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={pending || !calibrationSensorId}><Plus size={14} aria-hidden="true" />{t("spatial.lab.addCalibration")}</button></form></section>

        <div className="spatial-lab-grid"><section className="spatial-lab-section"><h3>{t("spatial.lab.context")}</h3><p>{t("spatial.lab.contextHelp")}</p><form className="spatial-lab-form stacked" onSubmit={(event) => void addContext(event)}><label><span>{t("spatial.lab.event")}</span><select value={contextKind} onChange={(event) => setContextKind(event.target.value as SpatialContextEventKind)}>{contextKinds.map((kind) => <option key={kind} value={kind}>{t(`spatial.context.${kind}`)}</option>)}</select></label><label><span>{t("spatial.lab.zoneOptional")}</span><select value={contextZoneId} onChange={(event) => setContextZoneId(event.target.value)}><option value="">{t("spatial.lab.wholeHouse")}</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label><button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordContext")}</button></form><small>{t("spatial.lab.recordedCount", { count: contextEvents.length })}</small></section>
          <section className="spatial-lab-section"><h3>{t("spatial.lab.groundTruth")}</h3><p>{t("spatial.lab.groundTruthHelp")}</p><form className="spatial-lab-form stacked" onSubmit={(event) => void addGroundTruth(event)}><label><span>{t("spatial.lab.label")}</span><select value={truthLabel} onChange={(event) => setTruthLabel(event.target.value as SpatialGroundTruth["label"])}>{groundTruthLabels.map((label) => <option key={label} value={label}>{t(`spatial.truth.${label}`)}</option>)}</select></label>{truthLabel === "zone_active" && <label><span>{t("spatial.lab.zone")}</span><select value={truthZoneId} onChange={(event) => setTruthZoneId(event.target.value)}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>}<button type="submit" className="secondary-button" disabled={pending}><Plus size={14} aria-hidden="true" />{t("spatial.lab.recordLabel")}</button></form><small>{t("spatial.lab.recordedCount", { count: groundTruth.length })}</small></section></div>
      </>}
      {feedback === "saved" && <p className="success-message" role="status"><Check size={14} aria-hidden="true" />{t("spatial.lab.saved")}</p>}
      {feedback === "error" && <p className="inline-error" role="alert">{t("spatial.lab.failed")}</p>}
    </div>
  </details>;
}
