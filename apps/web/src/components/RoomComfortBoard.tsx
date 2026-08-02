import { Activity, AlertTriangle, Bolt, ChevronDown, CloudOff, Droplets, Radio, Wind, X } from "lucide-react";
import type { AlertEvent, MeasurementDefinition, MeasurementSample, Metric, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import {
  definitionFor,
  formatMeasurement,
  measurementValue,
  type LatestMeasurements,
  type MeasurementHistory,
} from "../measurements";

const FRESH_FOR_MS = 30 * 60_000;

type RoomState = "comfortable" | "watch" | "attention" | "live" | "offline";

export interface RoomComfort {
  key: string;
  room: string;
  floorId: string;
  roomId: string | null;
  sensorIds: string[];
  sensorCount: number;
  freshSensorCount: number;
  sources: MeasurementSample["source"][];
  quality: Exclude<MeasurementSample["quality"], "stale"> | null;
  state: RoomState;
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
  power: number | null;
  supportsCo2: boolean;
  updatedAt: string | null;
  temperatureTrend: number[];
}

interface RoomComfortBoardProps {
  sensors: Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementHistory: MeasurementHistory;
  definitions: MeasurementDefinition[];
  alerts: AlertEvent[];
  units: UnitSystem;
  now?: number;
  onOpenRoom: (floorId: string, roomId: string | null) => void;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function isFreshTimestamp(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60_000 && now - timestamp <= FRESH_FOR_MS;
}

function latestTimestamp(samples: Array<{ timestamp: string } | undefined>, now: number): string | null {
  return samples
    .flatMap((sample) => sample && Number.isFinite(Date.parse(sample.timestamp)) ? [sample.timestamp] : [])
    .filter((timestamp) => isFreshTimestamp(Date.parse(timestamp), now))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function freshestSample(
  sensorId: string,
  metric: Metric,
  latestMeasurements: LatestMeasurements,
  measurementHistory: MeasurementHistory,
  now: number,
): MeasurementSample | undefined {
  const usable = (sample: MeasurementSample | undefined): sample is MeasurementSample => Boolean(
    sample
    && sample.quality !== "stale"
    && measurementValue(sample, metric) !== undefined
    && isFreshTimestamp(Date.parse(sample.timestamp), now),
  );
  const latest = latestMeasurements[sensorId]?.[metric];
  const latestUsable = usable(latest) ? latest : undefined;
  const history = measurementHistory[sensorId]?.[metric] ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const sample = history[index];
    const timestamp = sample ? Date.parse(sample.timestamp) : Number.NaN;
    if (Number.isFinite(timestamp) && timestamp < now - FRESH_FOR_MS) break;
    if (!usable(sample)) continue;
    if (!latestUsable) return sample;
    return Date.parse(latestUsable.timestamp) >= timestamp
      ? latestUsable
      : sample;
  }
  return latestUsable;
}

function recentTemperatureTrend(samples: MeasurementSample[], now: number): number[] {
  const earliest = now - 24 * 60 * 60_000;
  const latest = now + 5 * 60_000;
  const values: number[] = [];
  for (let index = samples.length - 1; index >= 0 && values.length < 24; index -= 1) {
    const sample = samples[index];
    if (!sample) continue;
    const timestamp = Date.parse(sample.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > latest || sample.quality === "stale") continue;
    if (timestamp < earliest) break;
    const value = measurementValue(sample, "temperature");
    if (value !== undefined) values.push(value);
  }
  return values.reverse();
}

function severityFor(temperature: number | null, humidity: number | null, co2: number | null): Exclude<RoomState, "offline" | "live"> {
  if (
    (temperature !== null && (temperature < 16 || temperature > 28))
    || (humidity !== null && (humidity < 20 || humidity > 70))
    || (co2 !== null && co2 >= 1_500)
  ) return "attention";
  if (
    (temperature !== null && (temperature < 18 || temperature > 25))
    || (humidity !== null && (humidity < 30 || humidity > 60))
    || (co2 !== null && co2 >= 1_000)
  ) return "watch";
  return "comfortable";
}

function roomState(hasClimateReading: boolean, hasPowerReading: boolean, hasAlert: boolean, temperature: number | null, humidity: number | null, co2: number | null): RoomState {
  if (!hasClimateReading) return hasPowerReading ? "live" : "offline";
  if (hasAlert) return "attention";
  return severityFor(temperature, humidity, co2);
}

export function buildRoomComforts({
  sensors,
  latestMeasurements,
  measurementHistory,
  alerts,
  now = Date.now(),
}: Pick<RoomComfortBoardProps, "sensors" | "latestMeasurements" | "measurementHistory" | "alerts" | "now">): RoomComfort[] {
  const groups = new Map<string, Sensor[]>();
  sensors.filter((sensor) => sensor.enabled).forEach((sensor) => {
    const roomLabel = sensor.room.trim() || sensor.name;
    const key = sensor.roomId
      ? `${sensor.floorId}\u0000room:${sensor.roomId}`
      : `${sensor.floorId}\u0000label:${roomLabel.toLocaleLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), sensor]);
  });
  const openAlertSensors = new Set(alerts.filter((alert) => !alert.resolvedAt).map((alert) => alert.sensorId));

  return [...groups.entries()].map<RoomComfort>(([key, roomSensors]) => {
    const fresh = (metric: Metric) => roomSensors.flatMap((sensor) => {
      const sample = freshestSample(sensor.id, metric, latestMeasurements, measurementHistory, now);
      const value = measurementValue(sample, metric);
      return sample && value !== undefined ? [{ sensor, sample, value }] : [];
    });
    const temperatureSamples = fresh("temperature");
    const humiditySamples = fresh("humidity");
    const co2Samples = fresh("co2");
    const powerSamples = fresh("power");
    const temperature = mean(temperatureSamples.map(({ value }) => value));
    const humidity = mean(humiditySamples.map(({ value }) => value));
    const co2 = mean(co2Samples.map(({ value }) => value));
    const power = powerSamples.length ? powerSamples.reduce((sum, { value }) => sum + value, 0) : null;
    const supportsCo2 = roomSensors.some((sensor) => (
      Boolean(sensor.measurementEntityIds?.co2)
      || Boolean(latestMeasurements[sensor.id]?.co2)
      || (measurementHistory[sensor.id]?.co2?.length ?? 0) > 0
    ));
    const currentSamples = [...temperatureSamples, ...humiditySamples, ...co2Samples, ...powerSamples];
    const samples = currentSamples.map(({ sample }) => sample);
    const updatedAt = latestTimestamp(samples, now);
    const roomHasAlert = roomSensors.some((sensor) => openAlertSensors.has(sensor.id));
    const representative = currentSamples
      .sort((left, right) => Date.parse(right.sample.timestamp) - Date.parse(left.sample.timestamp))[0]?.sensor
      ?? roomSensors[0]!;
    const temperatureTrend = recentTemperatureTrend(
      measurementHistory[representative.id]?.temperature ?? [],
      now,
    );
    const hasClimateReading = temperature !== null || humidity !== null || co2 !== null;
    const state = roomState(hasClimateReading, power !== null, roomHasAlert, temperature, humidity, co2);
    return {
      key,
      room: representative.room.trim() || representative.name,
      floorId: representative.floorId,
      roomId: representative.roomId ?? null,
      sensorIds: roomSensors.map((sensor) => sensor.id),
      sensorCount: roomSensors.length,
      freshSensorCount: new Set(currentSamples.map(({ sensor }) => sensor.id)).size,
      sources: [...new Set(samples.map((sample) => sample.source))],
      quality: samples.length === 0
        ? null
        : samples.some((sample) => sample.quality === "estimated") ? "estimated" : "good",
      state,
      temperature,
      humidity,
      co2,
      power,
      supportsCo2,
      updatedAt,
      temperatureTrend,
    };
  }).sort((left, right) => {
    const priority: Record<RoomState, number> = { attention: 0, watch: 1, offline: 2, live: 3, comfortable: 4 };
    return priority[left.state] - priority[right.state] || left.room.localeCompare(right.room);
  });
}

function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(maximum - minimum, .1);
  return values.map((value, index) => {
    const x = index / Math.max(values.length - 1, 1) * 96;
    const y = 26 - (value - minimum) / spread * 22;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function formattedReading(value: number | null, definition: MeasurementDefinition, units: UnitSystem, missing: string): string {
  if (value === null) return missing;
  return formatMeasurement(value, definition, units);
}

function ComfortStateIcon({ state }: Readonly<{ state: RoomState }>) {
  if (state === "attention") return <AlertTriangle size={12} aria-hidden="true" />;
  if (state === "live") return <Bolt size={12} aria-hidden="true" />;
  return <Activity size={12} aria-hidden="true" />;
}

export function RoomComfortBoard(props: Readonly<RoomComfortBoardProps>) {
  const { locale, t } = useI18n();
  const now = props.now ?? Date.now();
  const rooms = useMemo(() => buildRoomComforts(props), [props.sensors, props.latestMeasurements, props.measurementHistory, props.alerts, props.now]);
  const [selectedRoomKey, setSelectedRoomKey] = useState<string | null>(null);
  const evidenceId = `room-evidence-${useId().replace(/:/g, "")}`;
  const evidenceRef = useRef<HTMLElement>(null);
  const roomCardRefs = useRef(new Map<string, HTMLButtonElement>());
  const temperatureDefinition = definitionFor(props.definitions, "temperature");
  const humidityDefinition = definitionFor(props.definitions, "humidity");
  const co2Definition = definitionFor(props.definitions, "co2");
  const powerDefinition = definitionFor(props.definitions, "power");
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const selectedRoom = rooms.find((room) => room.key === selectedRoomKey) ?? null;

  useEffect(() => {
    if (selectedRoomKey && !selectedRoom) setSelectedRoomKey(null);
  }, [selectedRoom, selectedRoomKey]);

  useEffect(() => {
    if (!selectedRoomKey) return;
    evidenceRef.current?.focus();
  }, [selectedRoomKey]);

  const closeEvidence = () => {
    const roomKey = selectedRoomKey;
    setSelectedRoomKey(null);
    if (roomKey) window.requestAnimationFrame(() => roomCardRefs.current.get(roomKey)?.focus());
  };

  const roomCard = (room: RoomComfort) => {
    const path = sparkline(room.temperatureTrend);
    const ageMinutes = room.updatedAt ? Math.max(0, Math.round((now - Date.parse(room.updatedAt)) / 60_000)) : null;
    const updated = ageMinutes === null ? t("decision.noRecentReading") : relativeTime.format(-ageMinutes, "minute");
    const missing = t("common.noData");
    const readingLabels = [
      `${t("common.temperature")}: ${formattedReading(room.temperature, temperatureDefinition, props.units, missing)}`,
      `${t("common.humidity")}: ${formattedReading(room.humidity, humidityDefinition, props.units, missing)}`,
      ...(room.supportsCo2 ? [`${t("common.co2")}: ${formattedReading(room.co2, co2Definition, props.units, missing)}`] : []),
      ...(room.power !== null ? [`${t("common.power")}: ${formattedReading(room.power, powerDefinition, props.units, missing)}`] : []),
    ].join(". ");
    const readingCount = 2 + Number(room.supportsCo2) + Number(room.power !== null);
    const readingClass = readingCount === 2 ? " two-metrics" : readingCount === 4 ? " four-metrics" : "";
    return (
      <button
        type="button"
        ref={(node) => { if (node) roomCardRefs.current.set(room.key, node); else roomCardRefs.current.delete(room.key); }}
        className={`room-comfort-card ${room.state}`}
        key={room.key}
        aria-expanded={selectedRoomKey === room.key}
        aria-controls={selectedRoomKey === room.key ? evidenceId : undefined}
        onClick={() => {
          const opening = selectedRoomKey !== room.key;
          setSelectedRoomKey(opening ? room.key : null);
          if (opening) props.onOpenRoom(room.floorId, room.roomId);
        }}
        aria-label={`${t("decision.openRoom", { room: room.room, status: t(`decision.state.${room.state}`) })}. ${readingLabels}. ${updated}.`}
      >
        <span className="room-card-topline"><strong>{room.room}</strong><span className={`comfort-state ${room.state}`}><ComfortStateIcon state={room.state} />{t(`decision.state.${room.state}`)}</span></span>
        <span className={`room-card-readings${readingClass}`}>
          <span><b>{formattedReading(room.temperature, temperatureDefinition, props.units, missing)}</b><small>{t("common.temperature")}</small></span>
          <span><b>{formattedReading(room.humidity, humidityDefinition, props.units, missing)}</b><small><Droplets size={11} aria-hidden="true" />{t("common.humidity")}</small></span>
          {room.supportsCo2 && <span><b>{formattedReading(room.co2, co2Definition, props.units, missing)}</b><small><Wind size={11} aria-hidden="true" />{t("common.co2")}</small></span>}
          {room.power !== null && <span><b>{formattedReading(room.power, powerDefinition, props.units, missing)}</b><small><Bolt size={11} aria-hidden="true" />{t("common.power")}</small></span>}
        </span>
        <span className="room-card-footer">
          <span>{updated}</span>
          {path ? <svg viewBox="0 0 96 30" aria-hidden="true"><path d={path} /></svg> : <span>{t("decision.trendPending")}</span>}
        </span>
      </button>
    );
  };

  let roomContent: ReactNode;
  if (rooms.length === 0) {
    roomContent = <div className="panel decision-empty"><CloudOff size={22} aria-hidden="true" />{t("decision.roomsEmpty")}</div>;
  } else {
    const exceptionRooms = rooms.filter((room) => !["comfortable", "live"].includes(room.state));
    const comfortableRooms = rooms.filter((room) => ["comfortable", "live"].includes(room.state));
    // Exceptions are never hidden behind a disclosure. Comfortable rooms fill
    // the remaining glanceable slots and routine overflow stays on demand.
    const visibleComfortableCount = Math.max(0, 4 - exceptionRooms.length);
    const visibleRooms = [...exceptionRooms, ...comfortableRooms.slice(0, visibleComfortableCount)];
    const remainingRooms = comfortableRooms.slice(visibleComfortableCount);
    roomContent = (
      <>
        <div className="room-comfort-scroll">{visibleRooms.map(roomCard)}</div>
        {remainingRooms.length > 0 && (
          <details className="room-comfort-more">
            <summary>{t("home.showMoreRooms", { count: remainingRooms.length })}<ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="room-comfort-scroll">{remainingRooms.map(roomCard)}</div>
          </details>
        )}
      </>
    );
  }

  return (
    <section className="room-comfort-section" aria-labelledby="room-comfort-heading">
      <div className="decision-section-heading">
        <div><span className="eyebrow">{t("decision.roomsEyebrow")}</span><h2 id="room-comfort-heading">{t("decision.roomsTitle")}</h2></div>
        <p>{t("decision.roomsDescription")}</p>
      </div>
      {roomContent}
      {selectedRoom && <section
        id={evidenceId}
        ref={evidenceRef}
        className="panel room-evidence-panel"
        aria-labelledby={`${evidenceId}-title`}
        tabIndex={-1}
      >
        <div className="room-evidence-heading">
          <div>
            <span className="eyebrow">{t("decision.roomsEyebrow")}</span>
            <h3 id={`${evidenceId}-title`}>{selectedRoom.room}</h3>
            <span className={`comfort-state ${selectedRoom.state}`}><ComfortStateIcon state={selectedRoom.state} />{t(`decision.state.${selectedRoom.state}`)}</span>
          </div>
          <button type="button" className="icon-button" aria-label={t("common.close")} onClick={closeEvidence}><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="room-evidence-readings">
          <div><small>{t("common.temperature")}</small><strong>{formattedReading(selectedRoom.temperature, temperatureDefinition, props.units, t("common.noData"))}</strong></div>
          <div><small>{t("common.humidity")}</small><strong>{formattedReading(selectedRoom.humidity, humidityDefinition, props.units, t("common.noData"))}</strong></div>
          {selectedRoom.supportsCo2 && <div><small>{t("common.co2")}</small><strong>{formattedReading(selectedRoom.co2, co2Definition, props.units, t("common.noData"))}</strong></div>}
          {selectedRoom.power !== null && <div><small>{t("common.power")}</small><strong>{formattedReading(selectedRoom.power, powerDefinition, props.units, t("common.noData"))}</strong></div>}
        </div>
        <dl className="room-evidence-metadata">
          <div><dt>{t("decision.coverageLabel")}</dt><dd>{selectedRoom.freshSensorCount} {t("decision.freshOf", { total: selectedRoom.sensorCount })}</dd></div>
          <div><dt>{t("twin.quality")}</dt><dd>{selectedRoom.quality ? t(`measurement.quality.${selectedRoom.quality}`) : t("common.noData")}</dd></div>
          <div><dt>{t("twin.source")}</dt><dd>{selectedRoom.sources.length
            ? selectedRoom.sources.map((source) => t(`measurement.source.${source}` as TranslationKey)).join(" · ")
            : t("observations.source.unknown")}</dd></div>
          <div><dt>{t("setup.sourceLastUpdate")}</dt><dd>{selectedRoom.updatedAt
            ? relativeTime.format(-Math.max(0, Math.round((now - Date.parse(selectedRoom.updatedAt)) / 60_000)), "minute")
            : t("decision.noRecentReading")}</dd></div>
        </dl>
        <details className="room-evidence-sensors">
          <summary><Radio size={15} aria-hidden="true" />{t("nav.sensors")} · {selectedRoom.sensorCount}<ChevronDown size={15} aria-hidden="true" /></summary>
          <ul>{props.sensors.filter((sensor) => selectedRoom.sensorIds.includes(sensor.id)).map((sensor) => <li key={sensor.id}><strong>{sensor.name}</strong><span>{sensor.model}</span></li>)}</ul>
        </details>
      </section>}
    </section>
  );
}
