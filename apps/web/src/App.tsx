import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Metric, UnitSystem } from "@climate-twin/contracts";
import { AppShell } from "./components/AppShell";
import { type AppPage, type ViewMode } from "./domain";
import { useClimateData } from "./useClimateData";
import { AlertsPage } from "./pages/AlertsPage";
import { DeveloperPage } from "./pages/DeveloperPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { SensorManagementPage } from "./pages/SensorManagementPage";
import { TwinDashboard } from "./pages/TwinDashboard";
import { PortfolioOverview } from "./pages/PortfolioOverview";
import { OutdoorWeatherPage } from "./pages/OutdoorWeatherPage";
import { useI18n } from "./i18n";
import { enabledDefinitions } from "./measurements";
import type { CreateHouseInput } from "./api";
import { locationForRoute, routeFromLocation } from "./routing";

const pageTitleKeys = {
  overview: "nav.overview",
  twin: "nav.twin",
  outdoor: "nav.outdoor",
  sensors: "nav.sensors",
  alerts: "nav.alerts",
  integrations: "nav.integrations",
  developer: "nav.developer",
} as const;

function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function App() {
  const { t } = useI18n();
  const climate = useClimateData();
  const { state } = climate;
  const initialRoute = useMemo(() => routeFromLocation(window.location), []);
  const [page, setPage] = useState<AppPage>(initialRoute.page);
  const [houseId, setHouseId] = useState(() => initialRoute.houseId ?? state.houses[0]?.id ?? "");
  const [floorId, setFloorId] = useState(() => state.houses[0]?.floors[0]?.id ?? "");
  const [metric, setMetric] = useState<Metric>("temperature");
  const [viewMode, setViewMode] = useState<ViewMode>("plan");
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(() => state.sensors[0]?.id ?? null);
  const [units, setUnitsState] = useState<UnitSystem>(() => localStorage.getItem("climate-twin-units") === "imperial" ? "imperial" : "metric");
  const previousPage = useRef(page);

  const house = state.houses.find((item) => item.id === houseId) ?? state.houses[0];
  const floor = house?.floors.find((item) => item.id === floorId) ?? house?.floors[0];
  const measurementDefinitions = useMemo(() => enabledDefinitions(state.measurementDefinitions), [state.measurementDefinitions]);
  const availableMeasurements = useMemo(() => {
    const houseSensors = state.sensors.filter((sensor) => sensor.houseId === house?.id && sensor.enabled);
    const houseMeasurements = measurementDefinitions.filter((definition) => houseSensors.some((sensor) =>
      state.latestMeasurements[sensor.id]?.[definition.id]
      || (state.measurementHistory[sensor.id]?.[definition.id]?.length ?? 0) > 0
      || Boolean(sensor.measurementEntityIds?.[definition.id]),
    ));
    return houseMeasurements.length ? houseMeasurements : measurementDefinitions;
  }, [house?.id, measurementDefinitions, state.sensors, state.latestMeasurements, state.measurementHistory]);
  const lastUpdated = useMemo(() => {
    const sensorIds = new Set(state.sensors.filter((sensor) => sensor.houseId === house?.id && sensor.enabled).map((sensor) => sensor.id));
    const times = Object.entries(state.latestMeasurements).flatMap(([sensorId, measurements]) => sensorIds.has(sensorId)
      ? Object.values(measurements).map((sample) => sample.timestamp)
      : []).sort((left, right) => left.localeCompare(right));
    return times.at(-1) ?? null;
  }, [house?.id, state.sensors, state.latestMeasurements]);

  useEffect(() => {
    if (!state.houses.some((candidate) => candidate.id === houseId) && state.houses[0]) {
      setHouseId(state.houses[0].id);
      window.history.replaceState(
        { page, houseId: state.houses[0].id },
        "",
        locationForRoute(page, state.houses[0].id, window.location.pathname),
      );
    }
  }, [houseId, page, state.houses]);
  useEffect(() => {
    if (house && !house.floors.some((item) => item.id === floorId)) setFloorId(house.floors[0]?.id ?? "");
  }, [house, floorId]);
  useEffect(() => {
    if (floor && !state.sensors.some((sensor) => sensor.id === selectedSensorId && sensor.houseId === house?.id && sensor.floorId === floor.id && sensor.enabled)) {
      setSelectedSensorId(state.sensors.find((sensor) => sensor.houseId === house?.id && sensor.floorId === floor.id && sensor.enabled)?.id ?? null);
    }
  }, [house?.id, floor, selectedSensorId, state.sensors]);
  useEffect(() => {
    if (availableMeasurements.length && !availableMeasurements.some((definition) => definition.id === metric)) {
      setMetric(availableMeasurements[0]!.id);
    }
  }, [availableMeasurements, metric]);

  useEffect(() => {
    document.title = `${t(pageTitleKeys[page])} — ${t("app.name")}`;
    if (previousPage.current === page) return;
    previousPage.current = page;
    const frame = window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [page, t]);

  const setUnits = (next: UnitSystem) => {
    if (next === "imperial") {
      localStorage.setItem("climate-twin-units", "imperial");
    } else {
      localStorage.setItem("climate-twin-units", "metric");
    }
    setUnitsState(next);
  };

  const applyHouse = useCallback((id: string) => {
    setHouseId(id);
    const next = state.houses.find((item) => item.id === id);
    const nextFloorId = next?.floors[0]?.id ?? "";
    setFloorId(nextFloorId);
    setSelectedSensorId(state.sensors.find((sensor) => sensor.houseId === id && sensor.floorId === nextFloorId && sensor.enabled)?.id ?? null);
    settleInBackground(climate.selectHouse(id));
  }, [climate, state.houses, state.sensors]);

  const navigate = useCallback((nextPage: AppPage, nextHouseId = houseId, replace = false, routePathname = window.location.pathname) => {
    const url = locationForRoute(nextPage, nextHouseId, routePathname);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history[replace ? "replaceState" : "pushState"]({ page: nextPage, houseId: nextHouseId }, "", url);
    }
    setPage(nextPage);
  }, [houseId]);

  const chooseHouse = useCallback((id: string) => {
    applyHouse(id);
    const url = locationForRoute(page, id, window.location.pathname);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({ page, houseId: id }, "", url);
    }
  }, [applyHouse, page]);

  useEffect(() => {
    const restoreRoute = () => {
      const route = routeFromLocation(window.location);
      setPage(route.page);
      if (route.houseId && state.houses.some((candidate) => candidate.id === route.houseId)) {
        applyHouse(route.houseId);
      }
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [applyHouse, state.houses]);

  useEffect(() => {
    if (!house) return;
    const route = routeFromLocation(window.location);
    if (!route.houseId && page !== "overview" && page !== "developer") navigate(page, house.id, true);
  }, [house, navigate, page]);

  const createHouse = async (input: CreateHouseInput) => {
    return climate.createHouse(input);
  };

  const deleteHouse = async (id: string) => {
    const fallback = state.houses.find((item) => item.id !== id);
    await climate.deleteHouse(id);
    if (houseId === id && fallback) chooseHouse(fallback.id);
  };

  if (climate.loading || !house || !floor) {
    return <output className="loading-screen"><span className="loading-logo" aria-hidden="true" /><strong>{t("app.name")}</strong><span>{t("common.loading")}</span></output>;
  }

  return (
    <AppShell
      page={page}
      onPage={(next) => navigate(next)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={lastUpdated}
      openAlertCount={state.alerts.filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt).length}
      houses={state.houses}
      houseId={house.id}
      onHouse={chooseHouse}
      onBack={() => navigate("overview", house.id, true)}
    >
      {page === "overview" && (
        <PortfolioOverview
          houses={state.houses}
          sensors={state.sensors}
          latestMeasurements={state.latestMeasurements}
          openAlertSensorIds={new Set(state.alerts.filter((alert) => !alert.resolvedAt).map((alert) => alert.sensorId))}
          integration={state.integration}
          onOpenTwin={(id) => { applyHouse(id); navigate("twin", id); }}
          onOpenOutdoor={(id) => { applyHouse(id); navigate("outdoor", id); }}
          onOpenSetup={(id) => { applyHouse(id); navigate("integrations", id); }}
        />
      )}
      {page === "twin" && (
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id} metric={metric} units={units} viewMode={viewMode}
          selectedSensorId={selectedSensorId} saveState={climate.saveState} scenario={climate.scenario} connection={climate.connection}
          onHouse={chooseHouse} onFloor={setFloorId} onMetric={setMetric} onViewMode={setViewMode} onSensorSelect={setSelectedSensorId}
          onSensorMove={climate.moveSensor} onSensorUpdate={(id, patch) => { settleInBackground(climate.updateSensor(id, patch)); }} onFloorChange={(next) => climate.updateFloor(house.id, next)}
          onHouseChange={(next) => climate.updateHouseDraft(next.id, { name: next.name, timezone: next.timezone, floors: next.floors })}
          onHouseCreate={createHouse} onHouseDelete={deleteHouse}
          onSaveLayout={(next) => climate.saveLayout(next.id, next)} onLoadSeries={(id, nextMetric, range, forecastSupported) => settleInBackground(climate.loadSeries(id, nextMetric, range, forecastSupported))}
          onRunScenario={(next) => settleInBackground(climate.runScenario(next))} onCreateObservation={climate.createObservation}
          onCreateStaticParameter={climate.createStaticParameter}
        />
      )}
      {page === "outdoor" && (
        <OutdoorWeatherPage
          house={house}
          units={units}
          onConfigureLocation={() => navigate("integrations", house.id, false, "/setup/weather")}
        />
      )}
      {page === "sensors" && (
        <SensorManagementPage
          state={state}
          house={house}
          houses={state.houses}
          integration={state.integration}
          tpLinkDevices={climate.tpLinkDevices}
          tpLinkDevicesLoading={climate.tpLinkDevicesLoading}
          tpLinkDevicesError={climate.tpLinkDevicesError}
          onHouse={chooseHouse}
          onRefreshDevices={async () => { await climate.refreshTpLinkDevices(); }}
          onCreateSensor={climate.createSensor}
          onUpdateSensor={climate.updateSensor}
          onImportHistoricalData={(samples, onProgress) => climate.importHistoricalMeasurements(house.id, samples, onProgress)}
        />
      )}
      {page === "alerts" && <AlertsPage state={state} units={units} onCreateRule={climate.createRule} onAcknowledge={climate.acknowledgeAlert} />}
      {page === "integrations" && (
        <IntegrationsPage
          integration={state.integration}
          house={house}
          houses={state.houses}
          units={units}
          onHouse={chooseHouse}
          onHouseUpdate={climate.updateHouse}
          onGeoreferenceChange={climate.setHouseGeoreference}
          onIntegrationChange={climate.applyIntegrationStatus}
        />
      )}
      {page === "developer" && <DeveloperPage />}
    </AppShell>
  );
}
