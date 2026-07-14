import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Box, Check, Droplets, Edit3, Gauge, Home, Map, MapPinPlus, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import type { Floor, House, ManualObservation, MeasurementDefinition, MeasurementSample, Metric, MockScenario, Point, Reading, Sensor, StaticParameter, UnitSystem } from "@climate-twin/contracts";
import { BuildingScene } from "../components/BuildingScene";
import { FloorPlan } from "../components/FloorPlan";
import { ReplayControls } from "../components/ReplayControls";
import { TrendChart } from "../components/TrendChart";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementDomain, measurementLabel, measurementValue, samplesAt } from "../measurements";

interface TwinDashboardProps {
  state: ClimateState;
  house: House;
  floor: Floor;
  houseId: string;
  floorId: string;
  metric: Metric;
  units: UnitSystem;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  saveState: "idle" | "saving" | "saved" | "error";
  scenario: MockScenario["id"];
  onHouse: (id: string) => void;
  onFloor: (id: string) => void;
  onMetric: (metric: Metric) => void;
  onViewMode: (view: ViewMode) => void;
  onSensorSelect: (id: string) => void;
  onSensorMove: (id: string, point: Point) => void;
  onSensorUpdate: (id: string, patch: Partial<Sensor>) => void;
  onFloorChange: (floor: Floor) => void;
  onSaveLayout: (floor: Floor) => void;
  onLoadSeries: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
  onRunScenario: (scenario: MockScenario["id"]) => void;
  onCreateObservation: (observation: Omit<ManualObservation, "id" | "createdAt">) => Promise<ManualObservation>;
  onCreateStaticParameter: (parameter: Omit<StaticParameter, "id">) => Promise<StaticParameter>;
}

const observationKinds: ManualObservation["kind"][] = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"];

export function TwinDashboard(props: TwinDashboardProps) {
  const { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario } = props;
  const { locale, t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [range, setRange] = useState<TimeRange>("24h");
  const [replayActive, setReplayActive] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayStartPending, setReplayStartPending] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(4);
  const [observationPlacement, setObservationPlacement] = useState(false);
  const [observationKind, setObservationKind] = useState<ManualObservation["kind"]>("leak");
  const [observationSeverity, setObservationSeverity] = useState<ManualObservation["severity"]>("warning");
  const [observationNote, setObservationNote] = useState("");
  const [observationStatus, setObservationStatus] = useState(false);
  const [parameterLabel, setParameterLabel] = useState("");
  const [parameterValue, setParameterValue] = useState("");
  const [parameterUnit, setParameterUnit] = useState("");
  const replayBatchRef = useRef("");

  const houseSensors = useMemo(
    () => state.sensors.filter((sensor) => sensor.houseId === houseId && sensor.enabled),
    [state.sensors, houseId],
  );
  const floorSensors = useMemo(
    () => houseSensors.filter((sensor) => sensor.floorId === floorId),
    [houseSensors, floorId],
  );
  const selectedSensor = houseSensors.find((sensor) => sensor.id === selectedSensorId) ?? floorSensors[0] ?? houseSensors[0] ?? null;
  const selectedFloor = house.floors.find((item) => item.id === selectedSensor?.floorId) ?? floor;
  const summarySensors = viewMode === "isometric" ? houseSensors : floorSensors;
  const definitions = enabledDefinitions(state.measurementDefinitions);
  const houseDefinitions = definitions.filter((definition) => houseSensors.some((sensor) =>
    state.latestMeasurements[sensor.id]?.[definition.id]
    || (state.measurementHistory[sensor.id]?.[definition.id]?.length ?? 0) > 0
    || Boolean(sensor.measurementEntityIds?.[definition.id]),
  ));
  const availableDefinitions = houseDefinitions.length ? houseDefinitions : definitions;
  const definition = definitionFor(definitions, metric);
  const metricOptions = availableDefinitions.some((item) => item.id === definition.id)
    ? availableDefinitions
    : [definition, ...availableDefinitions];
  const metricLabel = measurementLabel(definition, locale);
  const liveSamples = useMemo(() => Object.fromEntries(houseSensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  })), [houseSensors, state.latestMeasurements, definition.id]);
  const historyTimestamps = useMemo(() => houseSensors
    .flatMap((sensor) => (state.measurementHistory[sensor.id]?.[definition.id] ?? []).map((sample) => Date.parse(sample.timestamp)))
    .filter(Number.isFinite), [houseSensors, state.measurementHistory, definition.id]);
  const replayHistoryReady = historyTimestamps.length > 0;
  const fallbackReplayBounds = useMemo(() => {
    const maximum = Date.now();
    return { minimum: maximum - 24 * 3600000, maximum };
  }, [houseId]);
  const replayMin = historyTimestamps.length ? Math.min(...historyTimestamps) : fallbackReplayBounds.minimum;
  const replayMax = historyTimestamps.length ? Math.max(...historyTimestamps) : fallbackReplayBounds.maximum;
  const [replayTimestamp, setReplayTimestamp] = useState(replayMax);

  useEffect(() => {
    setReplayTimestamp((current) => replayActive ? clamp(current, replayMin, replayMax) : replayMax);
  }, [replayActive, replayMin, replayMax]);
  useEffect(() => {
    if (!replayActive) {
      if (replayStartPending) setReplayStartPending(false);
      return;
    }
    if (!replayStartPending || !replayHistoryReady) return;
    setReplayTimestamp(replayMin);
    setReplayPlaying(true);
    setReplayStartPending(false);
  }, [replayActive, replayStartPending, replayHistoryReady, replayMin]);
  useEffect(() => {
    if (!replayPlaying) return;
    let previousTick = Date.now();
    const timer = window.setInterval(() => {
      const currentTick = Date.now();
      const elapsedRealMs = Math.max(0, currentTick - previousTick);
      previousTick = currentTick;
      setReplayTimestamp((current) => {
        const next = current + elapsedRealMs * replaySpeed * 60;
        if (next >= replayMax) { setReplayPlaying(false); return replayMax; }
        return next;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [replayPlaying, replaySpeed, replayMax]);

  const changeReplayPlaying = (playing: boolean) => {
    if (!playing) {
      setReplayStartPending(false);
      setReplayPlaying(false);
      return;
    }
    if (!replayHistoryReady) {
      setReplayStartPending(true);
      setReplayPlaying(false);
      return;
    }
    setReplayStartPending(false);
    setReplayPlaying(true);
  };

  useEffect(() => {
    if (selectedSensor) props.onLoadSeries(selectedSensor.id, definition.id, range, definition.forecastSupported);
  }, [selectedSensor?.id, definition.id, range, definition.forecastSupported]);

  const houseSensorIds = houseSensors.map((sensor) => sensor.id).join(",");
  useEffect(() => {
    if (!replayActive) {
      replayBatchRef.current = "";
      return;
    }
    const batchKey = `${houseId}:${definition.id}:${range}:${houseSensorIds}`;
    if (replayBatchRef.current === batchKey) return;
    replayBatchRef.current = batchKey;
    houseSensors.forEach((sensor) => {
      if (sensor.id !== selectedSensor?.id) props.onLoadSeries(sensor.id, definition.id, range, definition.forecastSupported);
    });
  }, [replayActive, houseId, definition.id, definition.forecastSupported, range, houseSensorIds, selectedSensor?.id]);

  const displayedSamples = useMemo(() => replayActive
    ? samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), definition.id, replayTimestamp)
    : liveSamples,
  [replayActive, replayTimestamp, houseSensors, state.measurementHistory, liveSamples, definition.id]);

  const values = summarySensors.flatMap((sensor) => {
    const sample = displayedSamples[sensor.id];
    const value = measurementValue(sample, definition.id);
    return sample?.quality !== "stale" && value != null ? [value] : [];
  });
  const houseColorDomain = measurementDomain(definition, houseSensors.flatMap((sensor) => {
    const sample = displayedSamples[sensor.id];
    const value = measurementValue(sample, definition.id);
    return sample?.quality !== "stale" && value != null ? [value] : [];
  }));
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const spread = values.length ? Math.max(...values) - Math.min(...values) : null;
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt && summarySensors.some((sensor) => sensor.id === alert.sensorId));
  const floorObservations = state.observations.filter((observation) => observation.houseId === houseId && observation.floorId === floorId);
  const houseObservations = state.observations.filter((observation) => observation.houseId === houseId);
  const houseParameters = state.staticParameters.filter((parameter) => parameter.houseId === houseId);
  const inspectorSamples = useMemo<Record<string, MeasurementSample>>(() => {
    if (!selectedSensor) return {};
    const samples = { ...(state.latestMeasurements[selectedSensor.id] ?? {}) };
    if (replayActive) {
      delete samples[definition.id];
      const replaySample = displayedSamples[selectedSensor.id];
      if (replaySample) samples[definition.id] = replaySample;
    }
    return samples;
  }, [selectedSensor?.id, state.latestMeasurements, displayedSamples, replayActive, definition.id]);

  const changeRange = (next: TimeRange) => {
    setRange(next);
  };

  const submitObservation = (event: FormEvent) => {
    event.preventDefault();
    props.onViewMode("plan");
    setObservationPlacement(true);
    setObservationStatus(false);
  };

  const placeObservation = async (point: Point) => {
    await props.onCreateObservation({
      houseId,
      floorId,
      sensorId: null,
      kind: observationKind,
      severity: observationSeverity,
      note: observationNote.trim() || t(`observations.${observationKind === "note" ? "noteKind" : observationKind}` as TranslationKey),
      x: round(point.x),
      y: round(point.y),
      occurredAt: new Date().toISOString(),
    });
    setObservationPlacement(false);
    setObservationStatus(true);
    setObservationNote("");
  };

  const submitParameter = async (event: FormEvent) => {
    event.preventDefault();
    const label = parameterLabel.trim();
    const value = parameterValue.trim();
    if (!label || !value) return;
    await props.onCreateStaticParameter({
      houseId,
      scopeType: "house",
      scopeId: houseId,
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || crypto.randomUUID(),
      label,
      value,
      unit: parameterUnit.trim() || null,
    });
    setParameterLabel("");
    setParameterValue("");
    setParameterUnit("");
  };

  return (
    <>
      <header className="page-heading twin-heading">
        <div><span className="eyebrow"><Sparkles size={14} aria-hidden="true" />{t("status.live")}</span><h1>{t("twin.title")}</h1><p>{t("twin.description")}</p></div>
        <div className="context-controls">
          <label><span>{t("common.house")}</span><select value={houseId} onChange={(event) => props.onHouse(event.target.value)}>{state.houses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label><span>{t("common.floor")}</span><select value={floorId} onChange={(event) => props.onFloor(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
      </header>

      <section className="summary-strip" aria-label={t("twin.title")}>
        <div className="summary-item"><span className={`summary-icon measurement ${definition.colorScale}`}><MeasurementGlyph definition={definition} size={18} /></span><span><small>{t("twin.averageMeasurement", { metric: metricLabel })}</small><strong>{average == null ? t("common.noData") : formatMeasurement(average, definition, units)}</strong></span></div>
        <div className="summary-item"><span className="summary-icon flow"><Activity size={18} aria-hidden="true" /></span><span><small>{t("twin.reportingSensors")}</small><strong>{t("twin.reportingCount", { count: values.length, total: summarySensors.length })}</strong></span></div>
        <div className="summary-item"><span className="summary-icon flow"><Wind size={18} aria-hidden="true" /></span><span><small>{t("twin.spread")}</small><strong>{spread == null ? t("common.noData") : formatMeasurementDelta(spread, definition, units)}</strong></span></div>
        <div className={`summary-item ${openAlerts.length ? "attention" : ""}`}><span className="summary-icon alert"><AlertTriangle size={18} aria-hidden="true" /></span><span><small>{t("twin.attention")}</small><strong>{openAlerts.length === 0 ? t("twin.noActiveAlerts") : openAlerts.length === 1 ? t("twin.oneAlert") : t("twin.manyAlerts", { count: openAlerts.length })}</strong></span></div>
      </section>

      <section className="panel twin-panel">
        <div className="twin-toolbar">
          <div className="toolbar-title"><span className="eyebrow">{viewMode === "isometric" ? house.name : floor.name}</span><strong>{summarySensors.length} {t("twin.sensors")}</strong></div>
          <div className="toolbar-groups">
            <label className="metric-picker"><span>{t("common.metric")}</span><select value={definition.id} onChange={(event) => props.onMetric(event.target.value)}>{metricOptions.map((item) => <option key={item.id} value={item.id}>{measurementLabel(item, locale)} · {displayUnit(item, units)}</option>)}</select></label>
            <div className="segmented" role="group" aria-label={t("common.view")}><button type="button" aria-pressed={viewMode === "plan"} onClick={() => props.onViewMode("plan")}><Map size={15} aria-hidden="true" />{t("twin.mode2d")}</button><button type="button" aria-pressed={viewMode === "isometric"} onClick={() => { setEditing(false); setObservationPlacement(false); props.onViewMode("isometric"); }}><Box size={15} aria-hidden="true" />{t("twin.modeIso")}</button></div>
            <button type="button" className={editing ? "primary-button" : "secondary-button"} onClick={() => { setEditing((value) => !value); if (!editing) props.onViewMode("plan"); }}><Edit3 size={15} aria-hidden="true" />{editing ? t("common.done") : t("common.edit")}</button>
            {editing && <button type="button" className="primary-button" onClick={() => props.onSaveLayout(floor)} disabled={props.saveState === "saving"}><Save size={15} aria-hidden="true" />{props.saveState === "saving" ? t("common.saving") : props.saveState === "saved" ? t("common.saved") : t("common.save")}</button>}
          </div>
        </div>
        {props.saveState === "error" && <p className="inline-error" role="alert">{t("twin.layoutSaveError")}</p>}
        <div className="twin-grid">
          {viewMode === "plan" ? (
            <FloorPlan
              floor={floor} sensors={floorSensors} samples={displayedSamples} observations={floorObservations} definition={definition} colorDomain={houseColorDomain} units={units}
              viewMode="plan" selectedSensorId={selectedSensor?.id ?? null} editing={editing} observationPlacement={observationPlacement}
              onSensorSelect={props.onSensorSelect} onSensorMove={props.onSensorMove} onFloorChange={props.onFloorChange} onObservationPoint={placeObservation}
              onCancelObservationPlacement={() => setObservationPlacement(false)}
            />
          ) : (
            <BuildingScene
              house={house} sensors={houseSensors} samples={displayedSamples} observations={houseObservations} definition={definition} colorDomain={houseColorDomain} units={units}
              activeFloorId={floorId} selectedSensorId={selectedSensor?.id ?? null} onFloorSelect={props.onFloor}
              onSensorSelect={(sensorId) => props.onSensorSelect(sensorId)}
            />
          )}
          <SensorInspector
            sensor={selectedSensor} reading={selectedSensor ? state.readings[selectedSensor.id] : undefined} samples={inspectorSamples}
            definitions={definitions} selectedDefinition={definition} units={units}
            house={house} floor={selectedFloor} editing={editing} onSensorUpdate={props.onSensorUpdate} onFloorSelect={props.onFloor}
          />
        </div>
      </section>

      <ReplayControls active={replayActive} playing={replayPlaying} timestamp={replayTimestamp} min={replayMin} max={replayMax} speed={replaySpeed} onActive={setReplayActive} onPlaying={changeReplayPlaying} onTimestamp={setReplayTimestamp} onSpeed={setReplaySpeed} />

      <div className="lower-grid">
        <TrendChart
          sensor={selectedSensor}
          history={selectedSensor ? state.measurementHistory[selectedSensor.id]?.[definition.id] ?? [] : []}
          forecast={selectedSensor ? state.measurementForecasts[selectedSensor.id]?.[definition.id] ?? [] : []}
          definition={definition} units={units} range={range} onRange={changeRange}
        />
        <div className="side-stack">
          <section className="panel compact-panel">
            <div className="panel-header"><div><span className="eyebrow">{t("mock.title")}</span><h2>{t("mock.description")}</h2></div></div>
            <label className="field"><span>{t("mock.scenario")}</span><select value={scenario} onChange={(event) => props.onRunScenario(event.target.value as MockScenario["id"])}>{state.scenarios.map((item) => <option key={item.id} value={item.id}>{t(`mock.${item.id}` as TranslationKey)}</option>)}</select></label>
            <p className="field-help">{t(`mock.${scenario}Description` as TranslationKey)}</p>
            <button type="button" className="secondary-button full-width" onClick={() => props.onRunScenario(scenario)}><Sparkles size={15} aria-hidden="true" />{t("mock.start")}</button>
          </section>
          <section className="panel compact-panel observation-panel">
            <div className="panel-header"><div><span className="eyebrow">{t("observations.title")}</span><h2>{floor.name}</h2></div><span className="count-badge">{floorObservations.length}</span></div>
            <form onSubmit={submitObservation} className="observation-form">
              <div className="field-row"><label className="field"><span>{t("observations.kind")}</span><select value={observationKind} onChange={(event) => setObservationKind(event.target.value as ManualObservation["kind"])}>{observationKinds.map((kind) => <option key={kind} value={kind}>{t(`observations.${kind === "note" ? "noteKind" : kind}` as TranslationKey)}</option>)}</select></label><label className="field"><span>{t("alerts.severity")}</span><select value={observationSeverity} onChange={(event) => setObservationSeverity(event.target.value as ManualObservation["severity"])}><option value="info">{t("alerts.info")}</option><option value="warning">{t("alerts.warning")}</option><option value="critical">{t("alerts.critical")}</option></select></label></div>
              <label className="field"><span>{t("observations.note")}</span><input value={observationNote} onChange={(event) => setObservationNote(event.target.value)} placeholder={t("observations.notePlaceholder")} /></label>
              <button type="submit" className={observationPlacement ? "primary-button full-width" : "secondary-button full-width"}><MapPinPlus size={15} aria-hidden="true" />{observationPlacement ? t("observations.locationHint") : t("observations.add")}</button>
              {observationStatus && <p className="success-message" role="status"><Check size={15} aria-hidden="true" />{t("observations.logged")}</p>}
            </form>
          </section>
          <section className="panel compact-panel context-panel">
            <div className="panel-header"><div><span className="eyebrow">{t("context.title")}</span><h2>{t("context.description")}</h2></div><span className="count-badge">{houseParameters.length}</span></div>
            {houseParameters.length > 0 && <dl className="parameter-list">{houseParameters.slice(0, 5).map((parameter) => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{String(parameter.value)}{parameter.unit ? ` ${parameter.unit}` : ""}</dd></div>)}</dl>}
            <form onSubmit={submitParameter} className="context-form">
              <label className="field"><span>{t("context.label")}</span><input required value={parameterLabel} onChange={(event) => setParameterLabel(event.target.value)} placeholder={t("context.labelPlaceholder")} /></label>
              <div className="field-row"><label className="field"><span>{t("context.value")}</span><input required value={parameterValue} onChange={(event) => setParameterValue(event.target.value)} placeholder={t("context.valuePlaceholder")} /></label><label className="field"><span>{t("context.unit")}</span><input value={parameterUnit} onChange={(event) => setParameterUnit(event.target.value)} placeholder={t("common.optional")} /></label></div>
              <button type="submit" className="secondary-button full-width">{t("context.add")}</button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}

function MeasurementGlyph({ definition, size }: { definition: MeasurementDefinition; size: number }) {
  const Icon = definition.colorScale === "thermal"
    ? Thermometer
    : definition.colorScale === "humidity"
      ? Droplets
      : definition.colorScale === "air-quality"
        ? Wind
        : Gauge;
  return <Icon size={size} aria-hidden="true" />;
}

function SensorInspector({
  sensor, reading, samples, definitions, selectedDefinition, units, house, floor, editing, onSensorUpdate, onFloorSelect,
}: {
  sensor: Sensor | null;
  reading: Reading | undefined;
  samples: Record<string, MeasurementSample>;
  definitions: MeasurementDefinition[];
  selectedDefinition: MeasurementDefinition;
  units: UnitSystem;
  house: House;
  floor: Floor;
  editing: boolean;
  onSensorUpdate: (id: string, patch: Partial<Sensor>) => void;
  onFloorSelect: (floorId: string) => void;
}) {
  const { locale, t } = useI18n();
  const [targetFloorId, setTargetFloorId] = useState(sensor?.floorId ?? floor.id);
  const [mountingHeight, setMountingHeight] = useState(sensor ? String(round(sensor.z - floor.elevation)) : "1.4");
  useEffect(() => {
    if (!sensor) return;
    const sensorFloor = house.floors.find((item) => item.id === sensor.floorId) ?? floor;
    setTargetFloorId(sensorFloor.id);
    setMountingHeight(String(round(sensor.z - sensorFloor.elevation)));
  }, [sensor?.id, sensor?.floorId, sensor?.z, house.floors, floor]);
  if (!sensor) return <aside className="sensor-inspector"><div className="empty-state">{t("twin.selectSensor")}</div></aside>;
  const registeredForSensor = definitions.filter((definition) => samples[definition.id] || sensor.measurementEntityIds?.[definition.id]);
  const availableDefinitions = registeredForSensor.length ? registeredForSensor : definitions;
  const visibleDefinitions = availableDefinitions.some((definition) => definition.id === selectedDefinition.id)
    ? availableDefinitions
    : [selectedDefinition, ...availableDefinitions];
  const selectedSample = samples[selectedDefinition.id];
  const applyPlacement = (event: FormEvent) => {
    event.preventDefault();
    const targetFloor = house.floors.find((item) => item.id === targetFloorId);
    const height = Number(mountingHeight);
    if (!targetFloor || !Number.isFinite(height)) return;
    onSensorUpdate(sensor.id, {
      floorId: targetFloor.id,
      x: clamp(sensor.x, 0, targetFloor.width),
      y: clamp(sensor.y, 0, targetFloor.height),
      z: targetFloor.elevation + Math.max(0, height),
    });
    onFloorSelect(targetFloor.id);
  };
  return (
    <aside className="sensor-inspector" aria-labelledby="selected-sensor-title">
      <div className="sensor-heading"><span className="device-glyph" aria-hidden="true"><span /><span /></span><div><span className="eyebrow">{sensor.model}</span><h2 id="selected-sensor-title">{sensor.name}</h2><p><Home size={13} aria-hidden="true" />{sensor.room}</p></div></div>
      <div className="sensor-current" role="list" aria-label={t("twin.measurements")}>
        {visibleDefinitions.map((definition) => {
          const sample = samples[definition.id];
          const value = measurementValue(sample, definition.id);
          return (
            <div key={definition.id} role="listitem" className={definition.id === selectedDefinition.id ? "selected" : undefined}>
              <span><MeasurementGlyph definition={definition} size={16} />{measurementLabel(definition, locale)}</span>
              <strong>{value == null ? "—" : formatMeasurement(value, definition, units)}</strong>
              <small>
                <span className={`quality-dot ${sample?.quality ?? "stale"}`} aria-hidden="true" />
                {sample ? t(`measurement.quality.${sample.quality}` as TranslationKey) : t("common.noData")}
                {sample && <time dateTime={sample.timestamp}>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(sample.timestamp))}</time>}
              </small>
            </div>
          );
        })}
      </div>
      <dl className="sensor-meta">
        <div><dt>{t("twin.sensorFloor")}</dt><dd>{floor.name}</dd></div>
        <div><dt>{t("twin.mountingHeight")}</dt><dd>{round(sensor.z - floor.elevation)} m</dd></div>
        <div><dt><BatteryMedium size={15} aria-hidden="true" />{t("twin.battery")}</dt><dd>{reading?.battery == null ? "—" : `${reading.battery}%`}</dd></div>
        <div><dt>{t("twin.quality")}</dt><dd><span className={`quality-dot ${selectedSample?.quality ?? "stale"}`} aria-hidden="true" />{selectedSample ? t(`measurement.quality.${selectedSample.quality}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.source")}</dt><dd>{selectedSample ? t(`measurement.source.${selectedSample.source}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.lastReading")}</dt><dd>{selectedSample ? <time dateTime={selectedSample.timestamp}>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(selectedSample.timestamp))}</time> : "—"}</dd></div>
      </dl>
      {editing && (
        <form className="sensor-placement-form" onSubmit={applyPlacement}>
          <strong>{t("twin.sensorPlacement")}</strong>
          <label className="field"><span>{t("twin.sensorFloor")}</span><select value={targetFloorId} onChange={(event) => setTargetFloorId(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>{t("twin.mountingHeight")}</span><span className="input-suffix"><input type="number" min="0" step="0.1" required value={mountingHeight} onChange={(event) => setMountingHeight(event.target.value)} /><span aria-hidden="true">m</span></span></label>
          <button type="submit" className="secondary-button full-width">{t("twin.applyPlacement")}</button>
        </form>
      )}
      <p className="keyboard-help">{t("twin.keyboardMove")}</p>
    </aside>
  );
}
