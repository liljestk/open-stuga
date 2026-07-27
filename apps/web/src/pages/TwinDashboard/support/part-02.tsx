import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../../../components/ReplayControls";
import { RoomComfortBoard } from "../../../components/RoomComfortBoard";
import { MoistureCoach } from "../../../components/MoistureCoach";
import { HomePulsePanel } from "../../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../../components/HomeOperationsPreview";
import "../../../components/decisionLayer.css";
import "../../OperationsPages.css";
import { formatInTimeZone } from "../../../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../../../measurements";
import { isEnergyDeviceSensor } from "../../../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../../../spatialFreshness";
import { createOutdoorBoundaryContext } from "../../../outdoorContext";
import { useHouseWeather } from "../../../useHouseWeather";
import type { OutdoorVisualizationState } from "../../../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../../../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../../../airflowSimulation";
import type { DataMode } from "../../../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../../../api";
import { useSpatialLayers } from "../../../useSpatialLayers";
import { SpatialLayerPanel } from "../../../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../../../experimentalSpatialLayers";
import { readLocalStorage, writeLocalStorage } from "../../../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../../../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../../openingState";
import { integrationForHouse } from "../../../integrationScope";
import { MeasurementGlyph } from "./part-01";

export function SensorInspector({
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
  onSensorUpdate: (id: string, patch: SensorPatch) => Promise<Sensor>;
  onFloorSelect: (floorId: string) => void;
}) {
  const { locale, t } = useI18n();
  const [targetFloorId, setTargetFloorId] = useState(sensor?.floorId ?? floor.id);
  const [mountingHeight, setMountingHeight] = useState(sensor ? String(round(sensor.z - floor.elevation)) : "1.4");
  const [placementPending, setPlacementPending] = useState(false);
  const [placementError, setPlacementError] = useState(false);
  useEffect(() => {
    if (!sensor) return;
    const sensorFloor = house.floors.find((item) => item.id === sensor.floorId) ?? floor;
    setTargetFloorId(sensorFloor.id);
    setMountingHeight(String(round(sensor.z - sensorFloor.elevation)));
    setPlacementError(false);
  }, [sensor?.id, sensor?.floorId, sensor?.z, house.floors, floor]);
  if (!sensor) return <aside className={`sensor-inspector ${editing ? "editing" : ""}`}><div className="empty-state">{editing ? t("twin.selectSensorToMove") : t("twin.selectSensor")}</div></aside>;
  const registeredForSensor = definitions.filter((definition) => samples[definition.id] || sensor.measurementEntityIds?.[definition.id]);
  const availableDefinitions = registeredForSensor.length ? registeredForSensor : definitions;
  const visibleDefinitions = availableDefinitions.some((definition) => definition.id === selectedDefinition.id)
    ? availableDefinitions
    : [selectedDefinition, ...availableDefinitions];
  const selectedSample = samples[selectedDefinition.id];
  const applyPlacement = async (event: FormEvent) => {
    event.preventDefault();
    const targetFloor = house.floors.find((item) => item.id === targetFloorId);
    const height = Number(mountingHeight);
    if (!targetFloor || !Number.isFinite(height)) return;
    setPlacementPending(true);
    setPlacementError(false);
    try {
      await onSensorUpdate(sensor.id, {
        floorId: targetFloor.id,
        x: clamp(sensor.x, 0, targetFloor.width),
        y: clamp(sensor.y, 0, targetFloor.height),
        z: targetFloor.elevation + Math.max(0, height),
      });
      onFloorSelect(targetFloor.id);
    } catch {
      setPlacementError(true);
    } finally {
      setPlacementPending(false);
    }
  };
  const batteryValue = measurementValue(samples.battery, "battery") ?? reading?.battery ?? null;
  return (
    <aside className={`sensor-inspector ${editing ? "editing" : ""}`} aria-labelledby="selected-sensor-title">
      <div className="sensor-heading"><span className="device-glyph" aria-hidden="true"><span /><span /></span><div><span className="eyebrow">{sensor.model}</span><h2 id="selected-sensor-title">{sensor.name}</h2><p><Home size={13} aria-hidden="true" />{sensor.room}</p></div></div>
      {!editing && <><div className="sensor-current" role="list" aria-label={t("twin.measurements")}>
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
                {sample && <time dateTime={sample.timestamp}>{formatInTimeZone(sample.timestamp, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}
              </small>
            </div>
          );
        })}
      </div>
      <dl className="sensor-meta">
        <div><dt>{t("twin.sensorFloor")}</dt><dd>{floor.name}</dd></div>
        <div><dt>{t("twin.mountingHeight")}</dt><dd>{round(sensor.z - floor.elevation)} m</dd></div>
        <div><dt><BatteryMedium size={15} aria-hidden="true" />{t("twin.battery")}</dt><dd>{batteryValue == null ? "—" : `${batteryValue}%`}</dd></div>
        <div><dt>{t("twin.quality")}</dt><dd><span className={`quality-dot ${selectedSample?.quality ?? "stale"}`} aria-hidden="true" />{selectedSample ? t(`measurement.quality.${selectedSample.quality}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.source")}</dt><dd>{selectedSample ? t(`measurement.source.${selectedSample.source}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.lastReading")}</dt><dd>{selectedSample ? <time dateTime={selectedSample.timestamp}>{formatInTimeZone(selectedSample.timestamp, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : "—"}</dd></div>
      </dl></>}
      {editing && <>
        <p className="sensor-edit-help">{t("twin.sensorEditHint")}</p>
        <form className="sensor-placement-form" onSubmit={applyPlacement}>
          <strong>{t("twin.sensorPlacement")}</strong>
          <label className="field"><span>{t("twin.sensorFloor")}</span><select value={targetFloorId} onChange={(event) => setTargetFloorId(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>{t("twin.mountingHeight")}</span><span className="input-suffix"><input type="number" min="0" step="0.1" required value={mountingHeight} onChange={(event) => setMountingHeight(event.target.value)} /><span aria-hidden="true">m</span></span></label>
          <button type="submit" className="secondary-button full-width" disabled={placementPending}>{placementPending ? t("common.saving") : t("twin.applyPlacement")}</button>
          {placementError && <p className="inline-error" role="alert">{t("twin.sensorPlacementError")}</p>}
        </form>
        <p className="keyboard-help">{t("twin.keyboardMove")}</p>
      </>}
    </aside>
  );
}
