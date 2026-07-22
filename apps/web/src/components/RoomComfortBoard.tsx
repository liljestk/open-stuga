import { Activity, AlertTriangle, ChevronDown, CloudOff, Droplets, Wind } from "lucide-react";
import type { AlertEvent, MeasurementDefinition, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useMemo, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  definitionFor,
  formatMeasurement,
  measurementValue,
  type LatestMeasurements,
  type MeasurementHistory,
} from "../measurements";

const FRESH_FOR_MS = 30 * 60_000;

type RoomState = "comfortable" | "watch" | "attention" | "offline";

export interface RoomComfort {
  key: string;
  room: string;
  floorId: string;
  sensorId: string;
  sensorCount: number;
  state: RoomState;
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
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
  onOpenRoom: (floorId: string, sensorId: string) => void;
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

function severityFor(temperature: number | null, humidity: number | null, co2: number | null): Exclude<RoomState, "offline"> {
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

function roomState(hasReading: boolean, hasAlert: boolean, temperature: number | null, humidity: number | null, co2: number | null): RoomState {
  if (!hasReading) return "offline";
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
    const key = `${sensor.floorId}\u0000${sensor.room.trim() || sensor.name}`;
    groups.set(key, [...(groups.get(key) ?? []), sensor]);
  });
  const openAlertSensors = new Set(alerts.filter((alert) => !alert.resolvedAt).map((alert) => alert.sensorId));

  return [...groups.entries()].map(([key, roomSensors]) => {
    const fresh = (metric: string) => roomSensors.flatMap((sensor) => {
      const sample = latestMeasurements[sensor.id]?.[metric];
      const timestamp = sample ? Date.parse(sample.timestamp) : Number.NaN;
      const value = measurementValue(sample, metric);
      return value !== undefined && isFreshTimestamp(timestamp, now) ? [value] : [];
    });
    const temperature = mean(fresh("temperature"));
    const humidity = mean(fresh("humidity"));
    const co2 = mean(fresh("co2"));
    const samples = roomSensors.flatMap((sensor) => Object.values(latestMeasurements[sensor.id] ?? {}));
    const updatedAt = latestTimestamp(samples, now);
    const roomHasAlert = roomSensors.some((sensor) => openAlertSensors.has(sensor.id));
    const representative = roomSensors
      .map((sensor) => ({ sensor, timestamp: Date.parse(latestMeasurements[sensor.id]?.temperature?.timestamp ?? "") }))
      .sort((left, right) => (Number.isFinite(right.timestamp) ? right.timestamp : -Infinity) - (Number.isFinite(left.timestamp) ? left.timestamp : -Infinity))[0]?.sensor
      ?? roomSensors[0]!;
    const temperatureTrend = (measurementHistory[representative.id]?.temperature ?? [])
      .filter((sample) => {
        const timestamp = Date.parse(sample.timestamp);
        return sample.quality !== "stale" && timestamp <= now + 5 * 60_000 && timestamp >= now - 24 * 60 * 60_000;
      })
      .flatMap((sample) => {
        const value = measurementValue(sample, "temperature");
        return value === undefined ? [] : [value];
      })
      .slice(-24);
    const hasReading = temperature !== null || humidity !== null || co2 !== null;
    const state = roomState(hasReading, roomHasAlert, temperature, humidity, co2);
    return {
      key,
      room: representative.room.trim() || representative.name,
      floorId: representative.floorId,
      sensorId: representative.id,
      sensorCount: roomSensors.length,
      state,
      temperature,
      humidity,
      co2,
      updatedAt,
      temperatureTrend,
    };
  }).sort((left, right) => {
    const priority: Record<RoomState, number> = { attention: 0, watch: 1, offline: 2, comfortable: 3 };
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

function formattedReading(value: number | null, definition: MeasurementDefinition, units: UnitSystem): string {
  if (value === null) return "—";
  return formatMeasurement(value, definition, units);
}

function ComfortStateIcon({ state }: Readonly<{ state: RoomState }>) {
  if (state === "attention") return <AlertTriangle size={12} aria-hidden="true" />;
  return <Activity size={12} aria-hidden="true" />;
}

export function RoomComfortBoard(props: Readonly<RoomComfortBoardProps>) {
  const { locale, t } = useI18n();
  const now = props.now ?? Date.now();
  const rooms = useMemo(() => buildRoomComforts(props), [props.sensors, props.latestMeasurements, props.measurementHistory, props.alerts, props.now]);
  const temperatureDefinition = definitionFor(props.definitions, "temperature");
  const humidityDefinition = definitionFor(props.definitions, "humidity");
  const co2Definition = definitionFor(props.definitions, "co2");
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const roomCard = (room: RoomComfort) => {
    const path = sparkline(room.temperatureTrend);
    const ageMinutes = room.updatedAt ? Math.max(0, Math.round((now - Date.parse(room.updatedAt)) / 60_000)) : null;
    const updated = ageMinutes === null ? t("decision.noRecentReading") : relativeTime.format(-ageMinutes, "minute");
    return (
      <button
        type="button"
        className={`room-comfort-card ${room.state}`}
        key={room.key}
        onClick={() => props.onOpenRoom(room.floorId, room.sensorId)}
        aria-label={`${t("decision.openRoom", { room: room.room, status: t(`decision.state.${room.state}`) })}. ${t("common.temperature")}: ${formattedReading(room.temperature, temperatureDefinition, props.units)}. ${t("common.humidity")}: ${formattedReading(room.humidity, humidityDefinition, props.units)}. ${t("common.co2")}: ${formattedReading(room.co2, co2Definition, props.units)}. ${updated}.`}
      >
        <span className="room-card-topline"><strong>{room.room}</strong><span className={`comfort-state ${room.state}`}><ComfortStateIcon state={room.state} />{t(`decision.state.${room.state}`)}</span></span>
        <span className="room-card-readings">
          <span><b>{formattedReading(room.temperature, temperatureDefinition, props.units)}</b><small>{t("common.temperature")}</small></span>
          <span><b>{formattedReading(room.humidity, humidityDefinition, props.units)}</b><small><Droplets size={11} aria-hidden="true" />{t("common.humidity")}</small></span>
          <span><b>{formattedReading(room.co2, co2Definition, props.units)}</b><small><Wind size={11} aria-hidden="true" />{t("common.co2")}</small></span>
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
    const exceptionRooms = rooms.filter((room) => room.state !== "comfortable");
    const comfortableRooms = rooms.filter((room) => room.state === "comfortable");
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
    </section>
  );
}
