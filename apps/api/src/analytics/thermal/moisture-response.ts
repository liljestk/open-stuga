import type {
  House,
  HvacExclusionSummary,
  MeasurementSample,
  MoistureResponseConfidence,
  MoistureResponseEntry,
  MoistureResponseInsight,
  MoistureResponseMetrics,
  MoistureResponseResult,
  OutdoorTemperatureSample,
  Sensor,
} from "@climate-twin/contracts";
import {
  calibrateMoistureResponse,
  prepareOutdoorMoistureBoundary,
  type PreparedOutdoorMoistureBoundary,
} from "./moisture-response-model.js";
import { isThermalIsolationTemperatureSensor } from "./isolation.js";
import { median, round } from "./math.js";
import type { PassiveInterval } from "../heat-pump-evidence.js";
import { SYSTEM_VERSION } from "../../version.js";

const TP_LINK_CLIMATE_MODEL_PATTERN = /\bT3(?:10|15)\b/i;

export interface MoistureResponseInput {
  house: Pick<House, "id" | "name" | "floors">;
  sensors: Sensor[];
  indoorSamplesBySensor: ReadonlyMap<string, MeasurementSample[]>;
  outdoorSamples: OutdoorTemperatureSample[];
  from: string;
  to: string;
  generatedAt?: string;
  hvacExclusion?: HvacExclusionSummary;
  passiveIntervals?: readonly PassiveInterval[];
}

interface RoomGroup {
  id: string;
  label: string;
  floorId: string;
  floorScopeId: string;
  sensorIds: string[];
}

interface PreparedMoistureRun {
  sensors: Sensor[];
  groups: RoomGroup[];
  parentBySensor: Map<string, string>;
  outdoor: PreparedOutdoorMoistureBoundary;
}

export function isMoistureResponseSensor(
  sensor: Sensor,
  hasRecordedTemperature = false,
  hasRecordedHumidity = false,
): boolean {
  const directClimateSensor = Boolean(
    sensor.tpLinkDeviceId && TP_LINK_CLIMATE_MODEL_PATTERN.test(sensor.model),
  );
  const hasHumidity = hasRecordedHumidity
    || Boolean(sensor.humidityEntityId?.trim())
    || Boolean(sensor.measurementEntityIds?.humidity?.trim())
    || directClimateSensor;
  return hasHumidity
    && isThermalIsolationTemperatureSensor(sensor, hasRecordedTemperature);
}

function metricsForCalibration(
  calibration: ReturnType<typeof calibrateMoistureResponse>,
): MoistureResponseMetrics {
  const responseTimeHours = calibration.parameters?.responseTimeHours ?? null;
  return {
    responseTimeHours,
    halfResponseHours: responseTimeHours === null ? null : round(responseTimeHours * Math.log(2), 1),
    outdoorCouplingPct: calibration.parameters === null
      ? null
      : round(calibration.parameters.outdoorCoupling * 100, 1),
    medianIndoorVaporPressureHpa: calibration.quality.medianIndoorVaporPressureHpa,
    medianOutdoorVaporPressureHpa: calibration.quality.medianOutdoorVaporPressureHpa,
    medianMoistureExcessHpa: calibration.quality.medianMoistureExcessHpa,
    modelSkillPct: calibration.quality.modelSkillPct,
  };
}

function confidenceForCalibration(
  calibration: ReturnType<typeof calibrateMoistureResponse>,
): MoistureResponseConfidence {
  if (!calibration.parameters) return "unavailable";
  const weakEvidence = [
    "LOW_OUTDOOR_MOISTURE_VARIATION",
    "WEAK_MOISTURE_RESPONSE_IDENTIFICATION",
    "HIGH_MOISTURE_VALIDATION_BIAS",
    "MOISTURE_MODEL_WORSE_THAN_PERSISTENCE",
    "NON_POSITIVE_OUTDOOR_MOISTURE_COUPLING",
    "IMPLAUSIBLE_OUTDOOR_MOISTURE_COUPLING",
  ].some((warning) => calibration.warnings.includes(warning));
  if (weakEvidence) return "low";
  return calibration.status === "ready" ? "high" : "medium";
}

function sensorEntry(
  input: MoistureResponseInput,
  sensor: Sensor,
  parentId: string,
  outdoor: PreparedOutdoorMoistureBoundary,
): MoistureResponseEntry {
  const calibration = calibrateMoistureResponse(
    input.indoorSamplesBySensor.get(sensor.id) ?? [],
    input.outdoorSamples,
    outdoor,
    input.passiveIntervals,
  );
  return {
    scope: {
      type: "sensor",
      id: `sensor:${sensor.id}`,
      label: sensor.name,
      parentId,
      floorId: sensor.floorId,
      sensorIds: [sensor.id],
    },
    calibrationStatus: calibration.status,
    confidence: confidenceForCalibration(calibration),
    rank: null,
    childCoveragePct: calibration.parameters ? 100 : 0,
    sensorCount: 1,
    eligibleSensorCount: calibration.parameters ? 1 : 0,
    metrics: metricsForCalibration(calibration),
    quality: {
      durationHours: calibration.quality.durationHours,
      outdoorRangeHpa: calibration.quality.outdoorRangeHpa,
      validationMaeHpa: calibration.quality.validationMaeHpa,
      persistenceMaeHpa: calibration.quality.persistenceMaeHpa,
      responseTimeLowHours: calibration.quality.responseTimeLowHours,
      responseTimeHighHours: calibration.quality.responseTimeHighHours,
    },
    warnings: [
      ...calibration.warnings,
      ...(input.hvacExclusion?.excludedSampleCount
        ? ["HVAC_ACTIVE_OR_UNVERIFIED_PERIODS_EXCLUDED"]
        : []),
    ],
  };
}

function roomGroups(house: MoistureResponseInput["house"], sensors: Sensor[]): RoomGroup[] {
  const groups = new Map<string, RoomGroup>();
  for (const floor of house.floors) {
    const floorScopeId = `floor:${floor.id}`;
    for (const room of floor.rooms) {
      const id = `room:${floor.id}:${room.id}`;
      groups.set(id, { id, label: room.name, floorId: floor.id, floorScopeId, sensorIds: [] });
    }
  }
  for (const sensor of sensors) {
    const floor = house.floors.find((candidate) => candidate.id === sensor.floorId);
    if (!floor) continue;
    const linkedRoom = sensor.roomId
      ? floor.rooms.find((room) => room.id === sensor.roomId)
      : floor.rooms.find((room) =>
        room.name.trim().toLocaleLowerCase() === sensor.room.trim().toLocaleLowerCase());
    const roomKey = linkedRoom?.id ?? `legacy:${sensor.room.trim().toLocaleLowerCase() || "unassigned"}`;
    const id = `room:${floor.id}:${roomKey}`;
    const group = groups.get(id) ?? {
      id,
      label: linkedRoom?.name ?? (sensor.room.trim() || "Unassigned"),
      floorId: floor.id,
      floorScopeId: `floor:${floor.id}`,
      sensorIds: [],
    };
    group.sensorIds.push(sensor.id);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.floorId.localeCompare(right.floorId) || left.label.localeCompare(right.label));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function aggregateConfidence(
  status: MoistureResponseEntry["calibrationStatus"],
  coverage: number,
  children: MoistureResponseEntry[],
): MoistureResponseConfidence {
  if (status === "insufficient-data") return "unavailable";
  const modeled = children.filter((child) => child.metrics.responseTimeHours !== null);
  if (coverage < 50 || modeled.filter((child) => child.confidence === "low").length > modeled.length / 2) {
    return "low";
  }
  if (status === "ready" && modeled.every((child) => child.confidence === "high")) return "high";
  return "medium";
}

function aggregateEntry(
  scope: MoistureResponseEntry["scope"],
  children: MoistureResponseEntry[],
  sensorIds: string[],
): MoistureResponseEntry {
  const modeled = children.filter((child) => child.metrics.responseTimeHours !== null);
  const coverage = children.length ? round(modeled.length / children.length * 100, 1) : 0;
  const status: MoistureResponseEntry["calibrationStatus"] = modeled.length === 0
    ? "insufficient-data"
    : coverage === 100 && modeled.every((child) => child.calibrationStatus === "ready")
      ? "ready"
      : "provisional";
  const metricMedian = (selector: (entry: MoistureResponseEntry) => number | null): number | null => {
    const values = modeled.flatMap((entry) => {
      const selected = selector(entry);
      return selected === null ? [] : [selected];
    });
    return values.length > 0 ? round(median(values), 2) : null;
  };
  const responseTimeHours = metricMedian((entry) => entry.metrics.responseTimeHours);
  const warnings = unique(children.flatMap((child) => child.warnings));
  if (coverage < 100) warnings.push(children.length ? "PARTIAL_MOISTURE_SCOPE_COVERAGE" : "NO_PAIRED_CLIMATE_SENSOR");
  if (!sensorIds.length && !warnings.includes("NO_PAIRED_CLIMATE_SENSOR")) warnings.push("NO_PAIRED_CLIMATE_SENSOR");
  return {
    scope,
    calibrationStatus: status,
    confidence: aggregateConfidence(status, coverage, children),
    rank: null,
    childCoveragePct: coverage,
    sensorCount: sensorIds.length,
    eligibleSensorCount: Math.min(
      sensorIds.length,
      modeled.reduce((sum, child) => sum + child.eligibleSensorCount, 0),
    ),
    metrics: {
      responseTimeHours,
      halfResponseHours: responseTimeHours === null ? null : round(responseTimeHours * Math.log(2), 1),
      outdoorCouplingPct: metricMedian((entry) => entry.metrics.outdoorCouplingPct),
      medianIndoorVaporPressureHpa: metricMedian((entry) => entry.metrics.medianIndoorVaporPressureHpa),
      medianOutdoorVaporPressureHpa: metricMedian((entry) => entry.metrics.medianOutdoorVaporPressureHpa),
      medianMoistureExcessHpa: metricMedian((entry) => entry.metrics.medianMoistureExcessHpa),
      modelSkillPct: metricMedian((entry) => entry.metrics.modelSkillPct),
    },
    quality: {
      durationHours: metricMedian((entry) => entry.quality.durationHours) ?? 0,
      outdoorRangeHpa: metricMedian((entry) => entry.quality.outdoorRangeHpa) ?? 0,
      validationMaeHpa: metricMedian((entry) => entry.quality.validationMaeHpa),
      persistenceMaeHpa: metricMedian((entry) => entry.quality.persistenceMaeHpa),
      responseTimeLowHours: metricMedian((entry) => entry.quality.responseTimeLowHours ?? null),
      responseTimeHighHours: metricMedian((entry) => entry.quality.responseTimeHighHours ?? null),
    },
    warnings,
  };
}

function ranked(entries: MoistureResponseEntry[]): MoistureResponseEntry[] {
  const ordered = [...entries]
    .filter((entry) => entry.metrics.responseTimeHours !== null)
    .sort((left, right) =>
      (left.metrics.responseTimeHours ?? Infinity) - (right.metrics.responseTimeHours ?? Infinity)
      || left.scope.label.localeCompare(right.scope.label));
  const ranks = new Map<string, number>();
  let previous: number | null = null;
  let rank = 0;
  ordered.forEach((entry, index) => {
    if (previous === null || entry.metrics.responseTimeHours !== previous) rank = index + 1;
    ranks.set(entry.scope.id, rank);
    previous = entry.metrics.responseTimeHours;
  });
  return entries.map((entry) => ({ ...entry, rank: ranks.get(entry.scope.id) ?? null }));
}

function uniqueExtreme(
  entries: MoistureResponseEntry[],
  selector: (entry: MoistureResponseEntry) => number | null,
  direction: "low" | "high",
): MoistureResponseEntry | null {
  const modeled = entries.filter((entry) => selector(entry) !== null);
  const ordered = modeled.sort((left, right) => {
    const difference = (selector(left) ?? 0) - (selector(right) ?? 0);
    return direction === "low" ? difference : -difference;
  });
  const first = ordered[0];
  const second = ordered[1];
  if (!first || (second && selector(first) === selector(second))) return null;
  return first;
}

function buildInsights(entries: MoistureResponseEntry[]): MoistureResponseInsight[] {
  const rooms = entries.filter((entry) => entry.scope.type === "room");
  const insights: MoistureResponseInsight[] = [];
  const fastest = uniqueExtreme(
    rooms.filter((entry) => (entry.metrics.outdoorCouplingPct ?? 0) > 0),
    (entry) => entry.metrics.responseTimeHours,
    "low",
  );
  if (fastest?.metrics.responseTimeHours !== null && fastest?.metrics.responseTimeHours !== undefined) {
    insights.push({
      code: "FASTEST_MOISTURE_RESPONSE_ROOM",
      scopeIds: [fastest.scope.id],
      value: fastest.metrics.responseTimeHours,
      unit: "hours",
    });
  }
  const strongest = uniqueExtreme(
    rooms.filter((entry) => (entry.metrics.outdoorCouplingPct ?? 0) > 0),
    (entry) => entry.metrics.outdoorCouplingPct,
    "high",
  );
  if (strongest?.metrics.outdoorCouplingPct !== null && strongest?.metrics.outdoorCouplingPct !== undefined) {
    insights.push({
      code: "STRONGEST_OUTDOOR_MOISTURE_COUPLING",
      scopeIds: [strongest.scope.id],
      value: strongest.metrics.outdoorCouplingPct,
      unit: "percent",
    });
  }
  const highestExcess = uniqueExtreme(rooms, (entry) => entry.metrics.medianMoistureExcessHpa, "high");
  if ((highestExcess?.metrics.medianMoistureExcessHpa ?? 0) >= 0.5) {
    insights.push({
      code: "HIGHEST_INDOOR_MOISTURE_EXCESS",
      scopeIds: [highestExcess!.scope.id],
      value: highestExcess!.metrics.medianMoistureExcessHpa!,
      unit: "hectopascal",
    });
  }
  const house = entries.find((entry) => entry.scope.type === "house");
  if (house && (house.confidence === "low" || house.confidence === "unavailable" || house.childCoveragePct < 100)) {
    insights.push({
      code: "LIMITED_MOISTURE_EVIDENCE",
      scopeIds: [house.scope.id],
      value: house.childCoveragePct,
      unit: "percent",
    });
  }
  return insights;
}

function prepareRun(input: MoistureResponseInput): PreparedMoistureRun {
  const recordedTemperature = new Set<string>();
  const recordedHumidity = new Set<string>();
  for (const [sensorId, samples] of input.indoorSamplesBySensor) {
    if (samples.some((sample) => sample.metric === "temperature")) recordedTemperature.add(sensorId);
    if (samples.some((sample) => sample.metric === "humidity")) recordedHumidity.add(sensorId);
  }
  const sensors = input.sensors.filter((sensor) =>
    sensor.enabled
    && sensor.houseId === input.house.id
    && isMoistureResponseSensor(
      sensor,
      recordedTemperature.has(sensor.id),
      recordedHumidity.has(sensor.id),
    ));
  const groups = roomGroups(input.house, sensors);
  return {
    sensors,
    groups,
    parentBySensor: new Map(
      groups.flatMap((group) => group.sensorIds.map((sensorId) => [sensorId, group.id] as const)),
    ),
    outdoor: prepareOutdoorMoistureBoundary(input.outdoorSamples),
  };
}

function complete(
  input: MoistureResponseInput,
  groups: RoomGroup[],
  rawSensorEntries: MoistureResponseEntry[],
): MoistureResponseResult {
  const sensorEntries = ranked(rawSensorEntries);
  const sensorEntryById = new Map(sensorEntries.map((entry) => [entry.scope.sensorIds[0]!, entry]));
  let roomEntries = groups.map((group) => aggregateEntry(
    {
      type: "room",
      id: group.id,
      label: group.label,
      parentId: group.floorScopeId,
      floorId: group.floorId,
      sensorIds: [...group.sensorIds],
    },
    group.sensorIds.flatMap((sensorId) => {
      const entry = sensorEntryById.get(sensorId);
      return entry ? [entry] : [];
    }),
    group.sensorIds,
  ));
  roomEntries = ranked(roomEntries);
  let floorEntries = input.house.floors.map((floor) => {
    const children = roomEntries.filter((entry) => entry.scope.floorId === floor.id);
    const sensorIds = unique(children.flatMap((entry) => entry.scope.sensorIds));
    return aggregateEntry({
      type: "floor",
      id: `floor:${floor.id}`,
      label: floor.name,
      parentId: `house:${input.house.id}`,
      floorId: floor.id,
      sensorIds,
    }, children, sensorIds);
  });
  floorEntries = ranked(floorEntries);
  const houseSensorIds = unique(floorEntries.flatMap((entry) => entry.scope.sensorIds));
  const houseEntry = aggregateEntry({
    type: "house",
    id: `house:${input.house.id}`,
    label: input.house.name,
    sensorIds: houseSensorIds,
  }, floorEntries, houseSensorIds);
  houseEntry.rank = houseEntry.metrics.responseTimeHours === null ? null : 1;
  const entries = [houseEntry, ...floorEntries, ...roomEntries, ...sensorEntries];
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    systemVersion: SYSTEM_VERSION,
    houseId: input.house.id,
    from: input.from,
    to: input.to,
    entries,
    insights: buildInsights(entries),
    methodology: {
      conversionMethod: "buck-vapor-pressure-v1",
      modelMethod: "first-order-moisture-response-v1",
      aggregationMethod: "median-child-metric-v1",
      interpretation: "Response time describes how quickly temperature-corrected indoor water vapor follows the observed outdoor moisture boundary. Meteorological relative humidity and dew point use Buck saturation pressure over liquid water, including below freezing.",
      limitations: [
        "Relative humidity is converted with paired temperature before comparison; raw indoor and outdoor percentages are never compared directly.",
        "Periods without verified heat-pump-off evidence are excluded when a tracked heat pump exists; ventilation, air leakage, occupants, showers, cooking, laundry, plants, other dehumidification, condensation, material sorption, and sensor placement remain mixed into the response.",
        "This is an empirical moisture-response comparison, not an airtightness, dampness, mould, condensation, or building-code assessment.",
        "Floor and Home values are medians of child scopes so one heavily instrumented room does not dominate.",
      ],
      ...(input.hvacExclusion ? { hvacExclusion: input.hvacExclusion } : {}),
    },
  };
}

export function runMoistureResponse(input: MoistureResponseInput): MoistureResponseResult {
  const prepared = prepareRun(input);
  const entries = prepared.sensors.map((sensor) => sensorEntry(
    input,
    sensor,
    prepared.parentBySensor.get(sensor.id) ?? `floor:${sensor.floorId}`,
    prepared.outdoor,
  ));
  return complete(input, prepared.groups, entries);
}

export async function runMoistureResponseAsync(
  input: MoistureResponseInput,
  options: { signal?: AbortSignal } = {},
): Promise<MoistureResponseResult> {
  const prepared = prepareRun(input);
  const entries: MoistureResponseEntry[] = [];
  for (const sensor of prepared.sensors) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    options.signal?.throwIfAborted();
    entries.push(sensorEntry(
      input,
      sensor,
      prepared.parentBySensor.get(sensor.id) ?? `floor:${sensor.floorId}`,
      prepared.outdoor,
    ));
  }
  options.signal?.throwIfAborted();
  return complete(input, prepared.groups, entries);
}
