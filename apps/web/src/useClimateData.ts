import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlertRule,
  ConnectionState,
  Floor,
  House,
  IntegrationStatus,
  ManualObservation,
  MeasurementSample,
  MockScenario,
  Point,
  Sensor,
  StaticParameter,
  TelemetryEvent,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import {
  api,
  subscribeToEvents,
  subscribeToMeasurementEvents,
  type CreateHouseInput,
  type CreateSensorInput,
  type HousePatch,
  type HouseGeoreferencePatch,
  type SensorPatch,
} from "./api";
import { createDemoState, nextMockReading, snapshotToReadings, type ClimateState, type TimeRange } from "./domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "./measurements";
import { routeFromLocation } from "./routing";

type LoadedTelemetryState = Pick<
  ClimateState,
  "latestMeasurements" | "measurementHistory" | "measurementForecasts" | "readings" | "history" | "forecasts"
>;

function withoutSensorIds<T>(records: Record<string, T>, sensorIds: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([sensorId]) => !sensorIds.has(sensorId)));
}

function replaceHouseSensors(current: Sensor[], houseId: string, loaded: Sensor[]): Sensor[] {
  const loadedIds = new Set(loaded.map((sensor) => sensor.id));
  return [
    ...current.filter((sensor) => sensor.houseId !== houseId && !loadedIds.has(sensor.id)),
    ...loaded,
  ];
}

function isDemoSource(source: string): boolean {
  return source === "mock" || source === "replay";
}

function houseWithPatch(house: House, patch: HousePatch): House {
  const next: House = { ...house, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  if (patch.floors !== undefined) next.floors = patch.floors;
  if (patch.location === null) delete next.location;
  else if (patch.location !== undefined) next.location = patch.location;
  if (patch.mapPlacement === null) delete next.mapPlacement;
  else if (patch.mapPlacement !== undefined) next.mapPlacement = patch.mapPlacement;
  if (patch.orientationDegrees === null) delete next.orientationDegrees;
  else if (patch.orientationDegrees !== undefined) next.orientationDegrees = patch.orientationDegrees;
  return next;
}

/** Removes demo values already held in browser memory when the API enters real-data mode. */
export function withoutDemoTelemetry(current: ClimateState, clearAlerts = false): ClimateState {
  const readings = Object.fromEntries(Object.entries(current.readings).filter(([, reading]) => !isDemoSource(reading.source)));
  const history = Object.fromEntries(Object.entries(current.history).flatMap(([sensorId, values]) => {
    const retained = values.filter((reading) => !isDemoSource(reading.source));
    return retained.length ? [[sensorId, retained]] : [];
  }));
  const latestMeasurements = Object.fromEntries(Object.entries(current.latestMeasurements).flatMap(([sensorId, values]) => {
    const retained = Object.fromEntries(Object.entries(values).filter(([, sample]) => !isDemoSource(sample.source)));
    return Object.keys(retained).length ? [[sensorId, retained]] : [];
  }));
  const measurementHistory = Object.fromEntries(Object.entries(current.measurementHistory).flatMap(([sensorId, byMetric]) => {
    const retained = Object.fromEntries(Object.entries(byMetric).flatMap(([metric, samples]) => {
      const realSamples = samples.filter((sample) => !isDemoSource(sample.source));
      return realSamples.length ? [[metric, realSamples]] : [];
    }));
    return Object.keys(retained).length ? [[sensorId, retained]] : [];
  }));
  return {
    ...current,
    readings,
    history,
    latestMeasurements,
    measurementHistory,
    // Forecast contracts do not carry provenance. Drop cached forecasts at the
    // boundary rather than risk retaining values derived from demo history.
    forecasts: {},
    measurementForecasts: {},
    ...(clearAlerts ? { alerts: [] } : {}),
  };
}

function advanceMockTelemetry(
  current: ClimateState,
  scenario: MockScenario["id"],
  tick: number,
): ClimateState {
  if (!current.integration.mock.enabled || current.integration.mock.mode === "real") return current;
  const readings = { ...current.readings };
  const history = { ...current.history };
  let latestMeasurements = current.latestMeasurements;
  let measurementHistory = current.measurementHistory;
  for (const sensor of current.sensors) {
    const previous = readings[sensor.id];
    if (!previous) continue;
    const next = nextMockReading(sensor, previous, scenario, tick);
    readings[sensor.id] = next;
    history[sensor.id] = [...(history[sensor.id] ?? []), next].slice(-500);
    const samples = readingSamples(next, current.measurementDefinitions);
    latestMeasurements = upsertLatest(latestMeasurements, samples);
    measurementHistory = appendHistory(measurementHistory, samples, 500);
  }
  return { ...current, readings, history, latestMeasurements, measurementHistory };
}

function durationHours(range: TimeRange): number {
  if (range === "6h") return 6;
  if (range === "24h") return 24;
  return 24 * 7;
}

function seriesLimit(range: TimeRange): number {
  return range === "7d" ? 1000 : 500;
}

async function canonicalSeries(
  sensorId: string,
  metric: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
) {
  const [samples, forecast] = await Promise.all([
    api.measurementHistory(sensorId, metric, from, to, seriesLimit(range)),
    forecastSupported ? api.measurementForecast(sensorId, metric, 12) : Promise.resolve([]),
  ]);
  return { samples, forecast };
}

async function legacySeries(
  sensorId: string,
  range: TimeRange,
  from: string,
  to: string,
  forecastSupported: boolean,
) {
  const [history, forecasts] = await Promise.all([
    api.readings(sensorId, from, to, seriesLimit(range)),
    forecastSupported ? api.forecast(sensorId, 360) : Promise.resolve([]),
  ]);
  return { history, forecasts };
}

function metricHistorySamples(
  history: ClimateState["history"][string],
  definitions: ClimateState["measurementDefinitions"],
  metric: string,
): MeasurementSample[] {
  const result: MeasurementSample[] = [];
  for (const reading of history) {
    result.push(...readingSamples(reading, definitions).filter((sample) => sample.metric === metric));
  }
  return result;
}

function metricForecastSamples(
  forecasts: ClimateState["forecasts"][string],
  definitions: ClimateState["measurementDefinitions"],
  metric: string,
): ReturnType<typeof legacyForecastSamples> {
  const result: ReturnType<typeof legacyForecastSamples> = [];
  for (const point of forecasts) {
    result.push(...legacyForecastSamples(point, definitions).filter((sample) => sample.metric === metric));
  }
  return result;
}

function replaceFloor(current: ClimateState, houseId: string, floor: Floor): ClimateState {
  const houses = current.houses.map((house) => {
    if (house.id !== houseId) return house;
    return {
      ...house,
      floors: house.floors.map((item) => item.id === floor.id ? floor : item),
      updatedAt: new Date().toISOString(),
    };
  });
  return { ...current, houses };
}

function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function replaceLoadedHouseTelemetry(
  current: ClimateState,
  houseId: string,
  loadedSensorIds: string[],
  loadedReadings: ClimateState["readings"],
  samples: MeasurementSample[],
): LoadedTelemetryState {
  const replacedSensorIds = new Set([
    ...current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id),
    ...loadedSensorIds,
    ...Object.keys(loadedReadings),
    ...samples.map((sample) => sample.sensorId),
  ]);
  const latestOutsideHouse = withoutSensorIds(current.latestMeasurements, replacedSensorIds);
  return {
    latestMeasurements: upsertLatest(latestOutsideHouse, samples),
    measurementHistory: withoutSensorIds(current.measurementHistory, replacedSensorIds),
    measurementForecasts: withoutSensorIds(current.measurementForecasts, replacedSensorIds),
    readings: { ...withoutSensorIds(current.readings, replacedSensorIds), ...loadedReadings },
    history: withoutSensorIds(current.history, replacedSensorIds),
    forecasts: withoutSensorIds(current.forecasts, replacedSensorIds),
  };
}

export function useClimateData() {
  // Telemetry starts empty until the API positively confirms that this database
  // is still allowed to use demo data. This prevents a real installation from
  // flashing or regenerating mock values while its API is slow or unreachable.
  const initialHouseId = useRef(typeof window === "undefined" ? null : routeFromLocation(window.location).houseId);
  const [state, setState] = useState<ClimateState>(() => ({
    ...withoutDemoTelemetry(createDemoState(), true),
    // Do not expose the demo house while the real inventory is unresolved. In
    // particular, App must not "repair" a valid deep link to the demo house.
    houses: [],
    sensors: [],
    observations: [],
    staticParameters: [],
  }));
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [scenario, setScenario] = useState<MockScenario["id"]>("normal");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tpLinkDevices, setTpLinkDevices] = useState<TpLinkDiscoveredDevice[]>([]);
  const [tpLinkDevicesLoading, setTpLinkDevicesLoading] = useState(false);
  const [tpLinkDevicesError, setTpLinkDevicesError] = useState<string | null>(null);
  const tick = useRef(0);
  const apiAvailable = useRef(false);
  const dataModeConfirmed = useRef(false);
  const stateRef = useRef(state);
  const sensorMoveQueues = useRef(new Map<string, Promise<void>>());
  const sensorMoveVersions = useRef(new Map<string, number>());
  const persistedSensorPoints = useRef(new Map<string, Point>());
  const activeHouseLoadVersion = useRef(0);
  const houseTelemetryVersions = useRef(new Map<string, number>());
  const seriesLoadVersions = useRef(new Map<string, number>());

  useEffect(() => { stateRef.current = state; }, [state]);

  const applyIntegrationStatus = useCallback((integration: IntegrationStatus) => {
    dataModeConfirmed.current = true;
    setState((current) => {
      const next = { ...current, integration };
      return integration.mock.mode === "real" && current.integration.mock.mode !== "real"
        ? withoutDemoTelemetry(next, true)
        : next;
    });
  }, []);

  const refreshTpLinkDevices = useCallback(async () => {
    if (!apiAvailable.current) {
      setTpLinkDevices([]);
      setTpLinkDevicesError(null);
      return [];
    }
    setTpLinkDevicesLoading(true);
    setTpLinkDevicesError(null);
    try {
      const devices = await api.tpLinkDevices();
      setTpLinkDevices(devices);
      return devices;
    } catch (error) {
      setTpLinkDevicesError(error instanceof Error ? error.message : "Could not load TP-Link devices");
      return [];
    } finally {
      setTpLinkDevicesLoading(false);
    }
  }, []);

  const loadHouseData = useCallback(async (houseId: string) => {
    const activeVersion = ++activeHouseLoadVersion.current;
    const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
    houseTelemetryVersions.current.set(houseId, telemetryVersion);
    const measurementData = Promise.all([api.measurementDefinitions(), api.measurementSnapshot(houseId)]).catch(() => null);
    const [sensors, snapshot, alertRules, alerts, observations, staticParameters, integration, scenarios, generic] = await Promise.all([
      api.sensors(houseId), api.snapshot(houseId), api.alertRules(), api.alerts(), api.observations(houseId),
      api.staticParameters(houseId), api.integrations(), api.scenarios(), measurementData,
    ]);
    if (activeHouseLoadVersion.current !== activeVersion
      || houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
    dataModeConfirmed.current = true;
    setState((current) => {
      const definitions = enabledDefinitions(generic?.[0] ?? current.measurementDefinitions);
      const legacyReadings = snapshotToReadings(snapshot);
      const samples = generic?.[1].flatMap((item) => Object.values(item.measurements))
        ?? Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, definitions));
      const loadedSensorIds = [...new Set([
        ...sensors.map((sensor) => sensor.id),
        ...(generic?.[1] ?? []).map((item) => item.sensorId),
      ])];
      const telemetry = replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples);
      const next = {
        ...current,
        ...telemetry,
        measurementDefinitions: definitions,
        sensors: replaceHouseSensors(current.sensors, houseId, sensors),
        alertRules,
        alerts,
        observations,
        staticParameters,
        integration,
        scenarios: scenarios.length ? scenarios : current.scenarios,
      };
      return integration.mock.mode === "real" ? withoutDemoTelemetry(next) : next;
    });
  }, []);

  const loadPortfolioHouseData = useCallback(async (houseId: string) => {
    const telemetryVersion = (houseTelemetryVersions.current.get(houseId) ?? 0) + 1;
    houseTelemetryVersions.current.set(houseId, telemetryVersion);
    const measurementSnapshot = api.measurementSnapshot(houseId).catch(() => null);
    const [sensors, snapshot, generic] = await Promise.all([
      api.sensors(houseId), api.snapshot(houseId), measurementSnapshot,
    ]);
    if (houseTelemetryVersions.current.get(houseId) !== telemetryVersion) return;
    setState((current) => {
      const legacyReadings = snapshotToReadings(snapshot);
      const samples = generic?.flatMap((item) => Object.values(item.measurements))
        ?? Object.values(legacyReadings).flatMap((reading) => readingSamples(reading, current.measurementDefinitions));
      const loadedSensorIds = [...new Set([
        ...sensors.map((sensor) => sensor.id),
        ...(generic ?? []).map((item) => item.sensorId),
      ])];
      const next = {
        ...current,
        ...replaceLoadedHouseTelemetry(current, houseId, loadedSensorIds, legacyReadings, samples),
        sensors: replaceHouseSensors(current.sensors, houseId, sensors),
      };
      return current.integration.mock.mode === "real" ? withoutDemoTelemetry(next) : next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeMeasurements: (() => void) | undefined;
    const initialize = async () => {
      try {
        const houses = await api.houses();
        if (cancelled || houses.length === 0) throw new Error("No configured houses");
        apiAvailable.current = true;
        setState((current) => ({ ...current, houses }));
        const requestedHouse = initialHouseId.current
          ? houses.find((house) => house.id === initialHouseId.current)
          : undefined;
        const activeHouse = requestedHouse ?? houses[0]!;
        await Promise.all([
          loadHouseData(activeHouse.id),
          ...houses
            .filter((house) => house.id !== activeHouse.id)
            .map((house) => loadPortfolioHouseData(house.id).catch(() => undefined)),
        ]);
        if (cancelled) return;
        settleInBackground(refreshTpLinkDevices());
        unsubscribe = subscribeToEvents(handleTelemetry, setConnection);
        unsubscribeMeasurements = subscribeToMeasurementEvents(handleMeasurement, setConnection);
      } catch {
        if (!cancelled) {
          dataModeConfirmed.current = false;
          setState((current) => {
            const sanitized = withoutDemoTelemetry(current, true);
            if (sanitized.houses.length > 0) return sanitized;
            const demo = createDemoState();
            return {
              ...sanitized,
              houses: demo.houses,
              sensors: demo.sensors,
              observations: demo.observations,
              staticParameters: demo.staticParameters,
            };
          });
          setConnection("offline");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    settleInBackground(initialize());
    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeMeasurements?.();
    };
  }, [loadHouseData, loadPortfolioHouseData, refreshTpLinkDevices]);

  useEffect(() => {
    if (connection !== "offline") return;
    const timer = window.setInterval(() => {
      tick.current += 1;
      setState((current) => dataModeConfirmed.current
        ? advanceMockTelemetry(current, scenario, tick.current)
        : current);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [connection, scenario]);

  const handleTelemetry = useCallback((event: TelemetryEvent) => {
    if (event.type === "reading" && "temperature" in event.data && "humidity" in event.data) {
      const reading = event.data;
      setState((current) => {
        if (current.integration.mock.mode === "real" && reading.source === "mock") return current;
        const samples = readingSamples(reading, current.measurementDefinitions);
        return {
          ...current,
          latestMeasurements: upsertLatest(current.latestMeasurements, samples),
          measurementHistory: appendHistory(current.measurementHistory, samples),
          readings: { ...current.readings, [reading.sensorId]: reading },
          history: { ...current.history, [reading.sensorId]: [...(current.history[reading.sensorId] ?? []), reading].slice(-1000) },
        };
      });
    } else if (event.type === "alert" && "ruleId" in event.data) {
      const alert = event.data;
      setState((current) => ({ ...current, alerts: [alert, ...current.alerts.filter((item) => item.id !== alert.id)] }));
    } else if (event.type === "integration" && "homeAssistant" in event.data) {
      applyIntegrationStatus(event.data as ClimateState["integration"]);
    }
  }, [applyIntegrationStatus]);

  const handleMeasurement = useCallback((sample: MeasurementSample) => {
    setState((current) => {
      if (current.integration.mock.mode === "real" && sample.source === "mock") return current;
      return {
        ...current,
        latestMeasurements: upsertLatest(current.latestMeasurements, [sample]),
        measurementHistory: appendHistory(current.measurementHistory, [sample]),
      };
    });
  }, []);

  const selectHouse = useCallback(async (houseId: string) => {
    if (!apiAvailable.current) return;
    try { await loadHouseData(houseId); } catch { /* Keep the previous snapshot during transient failures. */ }
  }, [loadHouseData]);

  const importHistoricalMeasurements = useCallback(async (
    houseId: string,
    samples: MeasurementSample[],
    onProgress?: (completed: number, total: number) => void,
  ) => {
    if (!apiAvailable.current) throw new Error("Historical import requires a connection to the Stuga server.");
    const result = await api.importHistoricalMeasurements(samples, onProgress);
    await loadHouseData(houseId);
    return result;
  }, [loadHouseData]);

  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true) => {
    if (!apiAvailable.current) return;
    const seriesKey = `${sensorId}\u0000${metric}`;
    const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
    seriesLoadVersions.current.set(seriesKey, requestVersion);
    const isCurrentRequest = () => seriesLoadVersions.current.get(seriesKey) === requestVersion;
    const to = new Date();
    const from = new Date(to.getTime() - durationHours(range) * 3600000);
    let loaded: Awaited<ReturnType<typeof canonicalSeries>> | null = null;
    try {
      loaded = await canonicalSeries(sensorId, metric, range, from.toISOString(), to.toISOString(), forecastSupported);
    } catch {
      // The v1 projection below remains available during a staggered upgrade.
    }
    if (!isCurrentRequest()) return;
    if (loaded) {
      setState((current) => ({
        ...current,
        measurementHistory: {
          ...current.measurementHistory,
          [sensorId]: { ...current.measurementHistory[sensorId], [metric]: loaded.samples },
        },
        measurementForecasts: {
          ...current.measurementForecasts,
          [sensorId]: { ...current.measurementForecasts[sensorId], [metric]: loaded.forecast },
        },
      }));
      return;
    }
    if (metric !== "temperature" && metric !== "humidity") return;
    let fallback: Awaited<ReturnType<typeof legacySeries>>;
    try {
      fallback = await legacySeries(sensorId, range, from.toISOString(), to.toISOString(), forecastSupported);
    } catch {
      return;
    }
    if (!isCurrentRequest()) return;
    setState((current) => ({
      ...current,
      history: { ...current.history, [sensorId]: fallback.history },
      forecasts: { ...current.forecasts, [sensorId]: fallback.forecasts },
      measurementHistory: {
        ...current.measurementHistory,
        [sensorId]: {
          ...current.measurementHistory[sensorId],
          [metric]: metricHistorySamples(fallback.history, current.measurementDefinitions, metric),
        },
      },
      measurementForecasts: {
        ...current.measurementForecasts,
        [sensorId]: {
          ...current.measurementForecasts[sensorId],
          [metric]: metricForecastSamples(fallback.forecasts, current.measurementDefinitions, metric),
        },
      },
    }));
  }, []);

  const createSensor = useCallback(async (input: CreateSensorInput): Promise<Sensor> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not saved.");
    const saved = await api.createSensor(input);
    setState((current) => ({
      ...current,
      sensors: [...current.sensors.filter((sensor) => sensor.id !== saved.id), saved],
    }));
    if (saved.tpLinkDeviceId) settleInBackground(refreshTpLinkDevices());
    return saved;
  }, [refreshTpLinkDevices]);

  const updateSensor = useCallback(async (sensorId: string, patch: SensorPatch): Promise<Sensor> => {
    await sensorMoveQueues.current.get(sensorId)?.catch(() => undefined);
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The sensor was not updated.");
    const saved = await api.updateSensor(sensorId, patch);
    setState((current) => ({
      ...current,
      sensors: current.sensors.map((sensor) => sensor.id === sensorId ? saved : sensor),
    }));
    if (Object.hasOwn(patch, "tpLinkDeviceId")) settleInBackground(refreshTpLinkDevices());
    return saved;
  }, [refreshTpLinkDevices]);

  const moveSensor = useCallback((sensorId: string, point: Point) => {
    if (!apiAvailable.current) return;
    const currentSensor = stateRef.current.sensors.find((sensor) => sensor.id === sensorId);
    if (!currentSensor) return;
    if (!persistedSensorPoints.current.has(sensorId)) {
      persistedSensorPoints.current.set(sensorId, { x: currentSensor.x, y: currentSensor.y });
    }
    setState((current) => ({
      ...current,
      sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...point } : sensor),
    }));
    const version = (sensorMoveVersions.current.get(sensorId) ?? 0) + 1;
    sensorMoveVersions.current.set(sensorId, version);
    const previous = sensorMoveQueues.current.get(sensorId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      try {
        const saved = await api.updateSensor(sensorId, point);
        persistedSensorPoints.current.set(sensorId, { x: saved.x, y: saved.y });
        if (sensorMoveVersions.current.get(sensorId) !== version) return;
        setState((current) => ({
          ...current,
          sensors: current.sensors.map((sensor) => sensor.id === sensorId ? saved : sensor),
        }));
      } catch (error) {
        if (sensorMoveVersions.current.get(sensorId) === version) {
          const persisted = persistedSensorPoints.current.get(sensorId);
          if (persisted) {
            setState((current) => ({
              ...current,
              sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...persisted } : sensor),
            }));
          }
        }
        throw error;
      }
    });
    sensorMoveQueues.current.set(sensorId, queued);
    settleInBackground(queued.catch(() => undefined).finally(() => {
      if (sensorMoveQueues.current.get(sensorId) === queued) sensorMoveQueues.current.delete(sensorId);
    }));
  }, []);

  const setHouseGeoreference = useCallback(async (houseId: string, patch: HouseGeoreferencePatch) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The location was not saved.");
    const saved = await api.updateHouseGeoreference(houseId, patch);
    setState((current) => {
      const existing = current.houses.find((house) => house.id === houseId);
      if (!existing) return current;
      const hadLocation = Boolean(existing.location);
      let nextHouse: House;
      nextHouse = saved;
      const configuredDelta = Number(Boolean(nextHouse.location)) - Number(hadLocation);
      return {
        ...current,
        houses: current.houses.map((house) => house.id === houseId ? nextHouse : house),
        integration: {
          ...current.integration,
          weather: {
            ...current.integration.weather,
            configuredHouses: Math.max(0, current.integration.weather.configuredHouses + configuredDelta),
          },
        },
      };
    });
  }, []);

  const updateFloor = useCallback((houseId: string, floor: Floor) => {
    setState((current) => replaceFloor(current, houseId, floor));
  }, []);

  const updateHouseDraft = useCallback((houseId: string, patch: HousePatch) => {
    setState((current) => ({
      ...current,
      houses: current.houses.map((house) => house.id === houseId
        ? { ...house, ...patch, updatedAt: new Date().toISOString() } as House
        : house),
    }));
  }, []);

  /** Persist an atomic house metadata update, including inferred location and timezone defaults. */
  const updateHouse = useCallback(async (houseId: string, patch: HousePatch): Promise<House> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not saved.");
    const saved = await api.updateHouse(houseId, patch);
    let result: House | null = saved;
    setState((current) => {
      const existing = current.houses.find((house) => house.id === houseId);
      if (!existing) return current;
      result ??= houseWithPatch(existing, patch);
      const hadLocation = Boolean(existing.location);
      const hasLocation = Boolean(result.location);
      return {
        ...current,
        houses: current.houses.map((house) => house.id === houseId ? result as House : house),
        integration: hadLocation === hasLocation ? current.integration : {
          ...current.integration,
          weather: {
            ...current.integration.weather,
            configuredHouses: Math.max(0, current.integration.weather.configuredHouses + Number(hasLocation) - Number(hadLocation)),
          },
        },
      };
    });
    if (!result) throw new Error("House not found");
    return result;
  }, []);

  const createHouse = useCallback(async (input: CreateHouseInput): Promise<House> => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not created.");
    const saved = await api.createHouse(input);
    setState((current) => ({ ...current, houses: [...current.houses, saved] }));
    return saved;
  }, []);

  const deleteHouse = useCallback(async (houseId: string): Promise<void> => {
    if (stateRef.current.houses.length <= 1) throw new Error("At least one property is required");
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not deleted.");
    await api.deleteHouse(houseId);
    const removedSensorIds = new Set(stateRef.current.sensors.filter((sensor) => sensor.houseId === houseId).map((sensor) => sensor.id));
    setState((current) => ({
      ...current,
      houses: current.houses.filter((house) => house.id !== houseId),
      sensors: current.sensors.filter((sensor) => sensor.houseId !== houseId),
      observations: current.observations.filter((observation) => observation.houseId !== houseId),
      staticParameters: current.staticParameters.filter((parameter) => parameter.houseId !== houseId),
      readings: withoutSensorIds(current.readings, removedSensorIds),
      history: withoutSensorIds(current.history, removedSensorIds),
      forecasts: withoutSensorIds(current.forecasts, removedSensorIds),
      latestMeasurements: withoutSensorIds(current.latestMeasurements, removedSensorIds),
      measurementHistory: withoutSensorIds(current.measurementHistory, removedSensorIds),
      measurementForecasts: withoutSensorIds(current.measurementForecasts, removedSensorIds),
    }));
  }, []);

  const saveLayout = useCallback(async (houseId: string, house: House) => {
    setSaveState("saving");
    updateHouseDraft(houseId, { name: house.name, timezone: house.timezone, floors: house.floors });
    try {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The layout was not saved.");
      const saved = await api.updateHouse(houseId, { name: house.name, timezone: house.timezone, floors: house.floors });
      setState((current) => ({ ...current, houses: current.houses.map((item) => item.id === houseId ? saved : item) }));
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (error) {
      setSaveState("error");
      throw error;
    }
  }, [updateHouseDraft]);

  const runScenario = useCallback(async (next: MockScenario["id"]) => {
    setScenario(next);
    if (apiAvailable.current) {
      try { await api.runScenario(next); } catch { /* Local simulation still runs when enabled. */ }
    }
  }, []);

  const createRule = useCallback(async (rule: Omit<AlertRule, "id">) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The rule was not saved.");
    const saved = await api.createAlertRule(rule);
    setState((current) => ({ ...current, alertRules: [...current.alertRules, saved] }));
  }, []);

  const acknowledgeAlert = useCallback(async (id: string) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The alert was not acknowledged.");
    const saved = await api.acknowledgeAlert(id);
    setState((current) => ({ ...current, alerts: current.alerts.map((alert) => alert.id === id ? saved : alert) }));
  }, []);

  const createObservation = useCallback(async (observation: Omit<ManualObservation, "id" | "createdAt">) => {
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The observation was not saved.");
    const saved = await api.createObservation(observation);
    setState((current) => ({ ...current, observations: [...current.observations, saved] }));
    return saved;
  }, []);

  const createStaticParameter = useCallback(async (parameter: Omit<StaticParameter, "id">) => {
    const matchesScopeAndKey = (item: StaticParameter) => item.houseId === parameter.houseId
      && item.scopeType === parameter.scopeType && item.scopeId === parameter.scopeId && item.key === parameter.key;
    if (!apiAvailable.current) throw new Error("The local API is unavailable. The parameter was not saved.");
    const saved = await api.createStaticParameter(parameter);
    setState((current) => ({ ...current, staticParameters: [...current.staticParameters.filter((item) => !matchesScopeAndKey(item)), saved] }));
    return saved;
  }, []);

  return {
    state, loading, connection, scenario, saveState,
    tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, refreshTpLinkDevices,
    applyIntegrationStatus,
    selectHouse, loadSeries, importHistoricalMeasurements, createHouse, deleteHouse, createSensor, updateSensor, moveSensor, updateFloor, updateHouse, updateHouseDraft, setHouseGeoreference,
    saveLayout, runScenario, createRule, acknowledgeAlert, createObservation, createStaticParameter,
  };
}
