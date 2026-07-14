import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlertRule,
  ConnectionState,
  Floor,
  HouseLocation,
  ManualObservation,
  MeasurementSample,
  MockScenario,
  Sensor,
  StaticParameter,
  TelemetryEvent,
} from "@climate-twin/contracts";
import { api, subscribeToEvents, subscribeToMeasurementEvents } from "./api";
import { createDemoState, nextMockReading, snapshotToReadings, type ClimateState, type TimeRange } from "./domain";
import { appendHistory, enabledDefinitions, legacyForecastSamples, readingSamples, upsertLatest } from "./measurements";

type LoadedTelemetryState = Pick<
  ClimateState,
  "latestMeasurements" | "measurementHistory" | "measurementForecasts" | "readings" | "history" | "forecasts"
>;

function withoutSensorIds<T>(records: Record<string, T>, sensorIds: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([sensorId]) => !sensorIds.has(sensorId)));
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
  const [state, setState] = useState<ClimateState>(createDemoState);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [scenario, setScenario] = useState<MockScenario["id"]>("normal");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const tick = useRef(0);
  const apiAvailable = useRef(false);

  const loadHouseData = useCallback(async (houseId: string) => {
    const measurementData = Promise.all([api.measurementDefinitions(), api.measurementSnapshot(houseId)]).catch(() => null);
    const [sensors, snapshot, alertRules, alerts, observations, staticParameters, integration, scenarios, generic] = await Promise.all([
      api.sensors(houseId), api.snapshot(houseId), api.alertRules(), api.alerts(), api.observations(houseId),
      api.staticParameters(houseId), api.integrations(), api.scenarios(), measurementData,
    ]);
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
      return {
        ...current,
        ...telemetry,
        measurementDefinitions: definitions,
        sensors,
        alertRules,
        alerts,
        observations,
        staticParameters,
        integration,
        scenarios: scenarios.length ? scenarios : current.scenarios,
      };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeMeasurements: (() => void) | undefined;
    void (async () => {
      try {
        const houses = await api.houses();
        if (cancelled || houses.length === 0) throw new Error("No configured houses");
        apiAvailable.current = true;
        setState((current) => ({ ...current, houses }));
        await loadHouseData(houses[0]!.id);
        if (cancelled) return;
        unsubscribe = subscribeToEvents(handleTelemetry, setConnection);
        unsubscribeMeasurements = subscribeToMeasurementEvents(handleMeasurement, setConnection);
      } catch {
        if (!cancelled) setConnection("offline");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeMeasurements?.();
    };
  }, [loadHouseData]);

  useEffect(() => {
    if (connection !== "offline") return;
    const timer = window.setInterval(() => {
      tick.current += 1;
      setState((current) => {
        const readings = { ...current.readings };
        const history = { ...current.history };
        let latestMeasurements = current.latestMeasurements;
        let measurementHistory = current.measurementHistory;
        current.sensors.forEach((sensor) => {
          const previous = readings[sensor.id];
          if (!previous) return;
          const next = nextMockReading(sensor, previous, scenario, tick.current);
          readings[sensor.id] = next;
          history[sensor.id] = [...(history[sensor.id] ?? []), next].slice(-500);
          const samples = readingSamples(next, current.measurementDefinitions);
          latestMeasurements = upsertLatest(latestMeasurements, samples);
          measurementHistory = appendHistory(measurementHistory, samples, 500);
        });
        return { ...current, readings, history, latestMeasurements, measurementHistory };
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [connection, scenario]);

  const handleTelemetry = useCallback((event: TelemetryEvent) => {
    if (event.type === "reading" && "sensorId" in event.data && "timestamp" in event.data) {
      const reading = event.data;
      setState((current) => {
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
      setState((current) => ({ ...current, integration: event.data as ClimateState["integration"] }));
    }
  }, []);

  const handleMeasurement = useCallback((sample: MeasurementSample) => {
    setState((current) => ({
      ...current,
      latestMeasurements: upsertLatest(current.latestMeasurements, [sample]),
      measurementHistory: appendHistory(current.measurementHistory, [sample]),
    }));
  }, []);

  const selectHouse = useCallback(async (houseId: string) => {
    if (!apiAvailable.current) return;
    try { await loadHouseData(houseId); } catch { /* Keep the previous snapshot during transient failures. */ }
  }, [loadHouseData]);

  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true) => {
    if (!apiAvailable.current) return;
    const duration = range === "6h" ? 6 : range === "24h" ? 24 : 24 * 7;
    const to = new Date();
    const from = new Date(to.getTime() - duration * 3600000);
    try {
      const [samples, forecast] = await Promise.all([
        api.measurementHistory(sensorId, metric, from.toISOString(), to.toISOString(), range === "7d" ? 1000 : 500),
        forecastSupported ? api.measurementForecast(sensorId, metric, 12) : Promise.resolve([]),
      ]);
      setState((current) => ({
        ...current,
        measurementHistory: {
          ...current.measurementHistory,
          [sensorId]: { ...(current.measurementHistory[sensorId] ?? {}), [metric]: samples },
        },
        measurementForecasts: {
          ...current.measurementForecasts,
          [sensorId]: { ...(current.measurementForecasts[sensorId] ?? {}), [metric]: forecast },
        },
      }));
    } catch {
      if (metric !== "temperature" && metric !== "humidity") return;
      try {
        const [history, forecasts] = await Promise.all([
          api.readings(sensorId, from.toISOString(), to.toISOString(), range === "7d" ? 1000 : 500),
          forecastSupported ? api.forecast(sensorId, 360) : Promise.resolve([]),
        ]);
        setState((current) => ({
          ...current,
          history: { ...current.history, [sensorId]: history },
          forecasts: { ...current.forecasts, [sensorId]: forecasts },
          measurementHistory: {
            ...current.measurementHistory,
            [sensorId]: {
              ...(current.measurementHistory[sensorId] ?? {}),
              [metric]: history.flatMap((reading) => readingSamples(reading, current.measurementDefinitions).filter((sample) => sample.metric === metric)),
            },
          },
          measurementForecasts: {
            ...current.measurementForecasts,
            [sensorId]: {
              ...(current.measurementForecasts[sensorId] ?? {}),
              [metric]: forecasts.flatMap((point) => legacyForecastSamples(point, current.measurementDefinitions).filter((sample) => sample.metric === metric)),
            },
          },
        }));
      } catch {
        // Existing buffered data remains usable offline.
      }
    }
  }, []);

  const updateSensor = useCallback((sensorId: string, patch: Partial<Sensor>) => {
    setState((current) => ({ ...current, sensors: current.sensors.map((sensor) => sensor.id === sensorId ? { ...sensor, ...patch } : sensor) }));
    if (apiAvailable.current) void api.updateSensor(sensorId, patch).catch(() => undefined);
  }, []);

  const setHouseLocation = useCallback(async (houseId: string, location: HouseLocation | null) => {
    const saved = apiAvailable.current ? await api.updateHouseLocation(houseId, location) : null;
    setState((current) => {
      const existing = current.houses.find((house) => house.id === houseId);
      if (!existing) return current;
      const hadLocation = Boolean(existing.location);
      let nextHouse = saved;
      if (!nextHouse && location) {
        nextHouse = { ...existing, location, updatedAt: new Date().toISOString() };
      } else if (!nextHouse) {
        const { location: _removedLocation, ...withoutLocation } = existing;
        nextHouse = { ...withoutLocation, updatedAt: new Date().toISOString() };
      }
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
    setState((current) => ({
      ...current,
      houses: current.houses.map((house) => house.id === houseId
        ? { ...house, floors: house.floors.map((item) => item.id === floor.id ? floor : item), updatedAt: new Date().toISOString() }
        : house),
    }));
  }, []);

  const saveLayout = useCallback(async (houseId: string, floor: Floor) => {
    setSaveState("saving");
    updateFloor(houseId, floor);
    try {
      if (apiAvailable.current) await api.updateFloor(houseId, floor.id, floor);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch {
      setSaveState("error");
    }
  }, [updateFloor]);

  const runScenario = useCallback(async (next: MockScenario["id"]) => {
    setScenario(next);
    if (apiAvailable.current) {
      try { await api.runScenario(next); } catch { /* Local simulation still runs when enabled. */ }
    }
  }, []);

  const createRule = useCallback(async (rule: Omit<AlertRule, "id">) => {
    const local = { ...rule, id: crypto.randomUUID() };
    setState((current) => ({ ...current, alertRules: [...current.alertRules, local] }));
    if (!apiAvailable.current) return;
    try {
      const saved = await api.createAlertRule(rule);
      setState((current) => ({ ...current, alertRules: current.alertRules.map((item) => item.id === local.id ? saved : item) }));
    } catch { /* Preserve the local draft so it can still be reviewed. */ }
  }, []);

  const acknowledgeAlert = useCallback(async (id: string) => {
    const acknowledgedAt = new Date().toISOString();
    setState((current) => ({ ...current, alerts: current.alerts.map((alert) => alert.id === id ? { ...alert, acknowledgedAt } : alert) }));
    if (apiAvailable.current) void api.acknowledgeAlert(id).catch(() => undefined);
  }, []);

  const createObservation = useCallback(async (observation: Omit<ManualObservation, "id" | "createdAt">) => {
    const local: ManualObservation = { ...observation, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setState((current) => ({ ...current, observations: [...current.observations, local] }));
    if (!apiAvailable.current) return local;
    try {
      const saved = await api.createObservation(observation);
      setState((current) => ({ ...current, observations: current.observations.map((item) => item.id === local.id ? saved : item) }));
      return saved;
    } catch { return local; }
  }, []);

  const createStaticParameter = useCallback(async (parameter: Omit<StaticParameter, "id">) => {
    const local: StaticParameter = { ...parameter, id: crypto.randomUUID() };
    const matchesScopeAndKey = (item: StaticParameter) => item.houseId === parameter.houseId
      && item.scopeType === parameter.scopeType && item.scopeId === parameter.scopeId && item.key === parameter.key;
    setState((current) => ({ ...current, staticParameters: [...current.staticParameters.filter((item) => !matchesScopeAndKey(item)), local] }));
    if (!apiAvailable.current) return local;
    try {
      const saved = await api.createStaticParameter(parameter);
      setState((current) => ({ ...current, staticParameters: [...current.staticParameters.filter((item) => !matchesScopeAndKey(item)), saved] }));
      return saved;
    } catch { return local; }
  }, []);

  return {
    state, loading, connection, scenario, saveState, selectHouse, loadSeries, updateSensor, updateFloor, setHouseLocation,
    saveLayout, runScenario, createRule, acknowledgeAlert, createObservation, createStaticParameter,
  };
}
