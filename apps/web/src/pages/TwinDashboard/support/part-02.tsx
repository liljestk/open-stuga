import type { SensorPatch } from "@climate-twin/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { BatteryMedium, Home } from "lucide-react";
import { type Floor, type House, type MeasurementDefinition, type MeasurementSample, type Metric, type Reading, type Sensor, type UnitSystem } from "@climate-twin/contracts";
import "../../../components/decisionLayer.css";
import "../../OperationsPages.css";
import { formatInTimeZone } from "../../../dateTime";
import { clamp, round, type ClimateState } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { formatMeasurement, measurementLabel, measurementValue } from "../../../measurements";
import { isEnergyDeviceSensor } from "../../../energyDeviceMap";
import { MeasurementGlyph } from "./part-01";

export function sensorSupportsMeasurement(state: ClimateState, sensor: Sensor, metric: Metric): boolean {
  if (state.latestMeasurements[sensor.id]?.[metric]) return true;
  if ((state.measurementHistory[sensor.id]?.[metric]?.length ?? 0) > 0) return true;
  if (sensor.measurementEntityIds?.[metric]) return true;
  if (metric === "temperature" && sensor.temperatureEntityId) return true;
  if (metric === "humidity" && sensor.humidityEntityId) return true;
  if (metric === "battery" && sensor.batteryEntityId) return true;
  const reading = state.readings[sensor.id];
  if (metric === "temperature" || metric === "humidity") return Number.isFinite(reading?.[metric] ?? Number.NaN);
  return Number.isFinite(reading?.measurements?.[metric] ?? Number.NaN);
}

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
  const energyDevice = isEnergyDeviceSensor(sensor, samples);
  const registeredForSensor = definitions.filter((definition) => samples[definition.id] || sensor.measurementEntityIds?.[definition.id]);
  const energyDefinitions = definitions.filter((definition) => definition.id === "power" || definition.id === "energy");
  const registeredEnergyDefinitions = energyDefinitions.filter((definition) => (
    samples[definition.id] || sensor.measurementEntityIds?.[definition.id]
  ));
  const availableDefinitions = energyDevice
    ? (registeredEnergyDefinitions.length ? registeredEnergyDefinitions : energyDefinitions)
    : (registeredForSensor.length ? registeredForSensor : definitions);
  const visibleDefinitions = energyDevice || availableDefinitions.some((definition) => definition.id === selectedDefinition.id)
    ? availableDefinitions
    : [selectedDefinition, ...availableDefinitions];
  const activeDefinition = visibleDefinitions.find((definition) => definition.id === selectedDefinition.id)
    ?? visibleDefinitions[0]
    ?? selectedDefinition;
  const selectedSample = samples[activeDefinition.id];
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
            <div key={definition.id} role="listitem" className={definition.id === activeDefinition.id ? "selected" : undefined}>
              <span><MeasurementGlyph definition={definition} size={16} />{measurementLabel(definition, locale)}</span>
              <strong>{value == null ? t("common.noData") : formatMeasurement(value, definition, units)}</strong>
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
        <div><dt><BatteryMedium size={15} aria-hidden="true" />{t("twin.battery")}</dt><dd>{batteryValue == null ? t("common.noData") : `${batteryValue}%`}</dd></div>
        <div><dt>{t("twin.quality")}</dt><dd><span className={`quality-dot ${selectedSample?.quality ?? "stale"}`} aria-hidden="true" />{selectedSample ? t(`measurement.quality.${selectedSample.quality}` as TranslationKey) : t("common.noData")}</dd></div>
        <div><dt>{t("twin.source")}</dt><dd>{selectedSample ? t(`measurement.source.${selectedSample.source}` as TranslationKey) : t("common.noData")}</dd></div>
        <div><dt>{t("twin.lastReading")}</dt><dd>{selectedSample ? <time dateTime={selectedSample.timestamp}>{formatInTimeZone(selectedSample.timestamp, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : t("common.noData")}</dd></div>
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
