import { CloudRain, Droplets, ShieldCheck, TriangleAlert, Wind } from "lucide-react";
import type { OutdoorConditions, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useMemo } from "react";
import { useI18n } from "../i18n";
import { definitionFor, formatMeasurement, measurementValue, type LatestMeasurements } from "../measurements";

const FRESH_FOR_MS = 30 * 60_000;

export type MoistureAdviceKind = "ventilate" | "hold" | "neutral" | "limited";

export interface MoistureAdvice {
  kind: MoistureAdviceKind;
  room: string | null;
  sensorId: string | null;
  indoorDewPointC: number | null;
  outdoorDewPointC: number | null;
  relativeHumidity: number | null;
  differenceC: number | null;
  elevatedMoisture: boolean;
  reason: "missing-indoor" | "missing-outdoor" | "weather-risk" | "drier-outside" | "wetter-outside" | "similar";
}

interface MoistureCoachProps {
  sensors: Sensor[];
  latestMeasurements: LatestMeasurements;
  conditions: OutdoorConditions | null | undefined;
  weatherStale?: boolean;
  units: UnitSystem;
  now?: number;
  onOpenSensor?: (sensorId: string) => void;
}

/** Magnus approximation; sufficiently accurate for household comfort guidance. */
export function dewPointCelsius(temperatureC: number, relativeHumidity: number): number {
  const humidity = Math.min(100, Math.max(1, relativeHumidity));
  const gamma = Math.log(humidity / 100) + 17.625 * temperatureC / (243.04 + temperatureC);
  return 243.04 * gamma / (17.625 - gamma);
}

export function buildMoistureAdvice({
  sensors,
  latestMeasurements,
  conditions,
  weatherStale = false,
  now = Date.now(),
}: Omit<MoistureCoachProps, "units" | "onOpenSensor">): MoistureAdvice {
  const rooms = sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
    const temperature = latestMeasurements[sensor.id]?.temperature;
    const humidity = latestMeasurements[sensor.id]?.humidity;
    const temperatureValue = measurementValue(temperature, "temperature");
    const humidityValue = measurementValue(humidity, "humidity");
    const temperatureTime = Date.parse(temperature?.timestamp ?? "");
    const humidityTime = Date.parse(humidity?.timestamp ?? "");
    if (
      temperatureValue === undefined
      || humidityValue === undefined
      || !Number.isFinite(temperatureTime)
      || !Number.isFinite(humidityTime)
      || Math.max(temperatureTime, humidityTime) > now + 5 * 60_000
      || now - Math.min(temperatureTime, humidityTime) > FRESH_FOR_MS
      || Math.abs(temperatureTime - humidityTime) > 10 * 60_000
    ) return [];
    return [{
      room: sensor.room.trim() || sensor.name,
      sensorId: sensor.id,
      dewPointC: dewPointCelsius(temperatureValue, humidityValue),
      relativeHumidity: humidityValue,
    }];
  }).sort((left, right) => right.dewPointC - left.dewPointC);
  const wettest = rooms[0];
  if (!wettest) return {
    kind: "limited", room: null, sensorId: null, indoorDewPointC: null, outdoorDewPointC: null,
    relativeHumidity: null, differenceC: null, elevatedMoisture: false, reason: "missing-indoor",
  };

  const outdoorDewPoint = conditions?.dewPointC
    ?? (conditions?.temperatureC !== undefined && conditions.relativeHumidityPercent !== undefined
      ? dewPointCelsius(conditions.temperatureC, conditions.relativeHumidityPercent)
      : null);
  if (outdoorDewPoint === null || weatherStale) return {
    kind: "limited", room: wettest.room, sensorId: wettest.sensorId, indoorDewPointC: wettest.dewPointC,
    outdoorDewPointC: outdoorDewPoint, relativeHumidity: wettest.relativeHumidity, differenceC: null,
    elevatedMoisture: wettest.relativeHumidity >= 65, reason: "missing-outdoor",
  };

  const differenceC = wettest.dewPointC - outdoorDewPoint;
  const weatherRisk = (conditions?.windGustMps ?? 0) >= 15
    || (conditions?.precipitationIntensityMmPerHour ?? conditions?.precipitation1hMm ?? 0) >= 1;
  if (weatherRisk) return {
    kind: "limited", room: wettest.room, sensorId: wettest.sensorId, indoorDewPointC: wettest.dewPointC,
    outdoorDewPointC: outdoorDewPoint, relativeHumidity: wettest.relativeHumidity, differenceC,
    elevatedMoisture: wettest.relativeHumidity >= 65, reason: "weather-risk",
  };
  if (differenceC >= 3) return {
    kind: "ventilate", room: wettest.room, sensorId: wettest.sensorId, indoorDewPointC: wettest.dewPointC,
    outdoorDewPointC: outdoorDewPoint, relativeHumidity: wettest.relativeHumidity, differenceC,
    elevatedMoisture: wettest.relativeHumidity >= 65, reason: "drier-outside",
  };
  if (differenceC <= -1) return {
    kind: "hold", room: wettest.room, sensorId: wettest.sensorId, indoorDewPointC: wettest.dewPointC,
    outdoorDewPointC: outdoorDewPoint, relativeHumidity: wettest.relativeHumidity, differenceC,
    elevatedMoisture: wettest.relativeHumidity >= 65, reason: "wetter-outside",
  };
  return {
    kind: "neutral", room: wettest.room, sensorId: wettest.sensorId, indoorDewPointC: wettest.dewPointC,
    outdoorDewPointC: outdoorDewPoint, relativeHumidity: wettest.relativeHumidity, differenceC,
    elevatedMoisture: wettest.relativeHumidity >= 65, reason: "similar",
  };
}

function MoistureAdviceIcon({ kind }: Readonly<{ kind: MoistureAdviceKind }>) {
  if (kind === "ventilate") return <Wind size={22} />;
  if (kind === "hold") return <Droplets size={22} />;
  if (kind === "limited") return <CloudRain size={22} />;
  return <ShieldCheck size={22} />;
}

function formattedEvidence(value: number | null, definition: ReturnType<typeof definitionFor>, units: UnitSystem): string {
  if (value === null) return "—";
  return formatMeasurement(value, definition, units);
}

export function MoistureCoach(props: Readonly<MoistureCoachProps>) {
  const { t } = useI18n();
  const advice = useMemo(() => buildMoistureAdvice(props), [props.sensors, props.latestMeasurements, props.conditions, props.weatherStale, props.now]);
  const temperature = definitionFor([], "temperature");
  const humidity = definitionFor([], "humidity");
  const canOpen = Boolean(advice.sensorId && props.onOpenSensor);
  const openSensor = () => {
    if (advice.sensorId) props.onOpenSensor?.(advice.sensorId);
  };

  return (
    <section className={`panel moisture-coach ${advice.kind}`} aria-labelledby="moisture-coach-heading">
      <div className="moisture-coach-icon" aria-hidden="true"><MoistureAdviceIcon kind={advice.kind} /></div>
      <div className="moisture-coach-copy">
        <span className="eyebrow">{t("decision.moistureEyebrow")}</span>
        <h2 id="moisture-coach-heading">{t(`decision.moisture.${advice.reason}.title`, { room: advice.room ?? t("decision.thisHome") })}</h2>
        <p>{t(`decision.moisture.${advice.reason}.body`, { room: advice.room ?? t("decision.thisHome") })}</p>
        {advice.indoorDewPointC !== null && (
          <dl className="moisture-evidence">
            <div><dt>{t("decision.indoorDewPoint")}</dt><dd>{formatMeasurement(advice.indoorDewPointC, temperature, props.units)}</dd></div>
            <div><dt>{t("decision.outdoorDewPoint")}</dt><dd>{formattedEvidence(advice.outdoorDewPointC, temperature, props.units)}</dd></div>
            <div><dt>{t("common.humidity")}</dt><dd>{formattedEvidence(advice.relativeHumidity, humidity, props.units)}</dd></div>
          </dl>
        )}
        {advice.elevatedMoisture && <p className="moisture-watch"><TriangleAlert size={14} aria-hidden="true" />{t("decision.moistureWatch")}</p>}
        <small className="decision-caveat">{t("decision.moistureCaveat")}</small>
      </div>
      {canOpen && <button type="button" className="secondary-button" onClick={openSensor}>{t("decision.inspectRoom")}</button>}
    </section>
  );
}
