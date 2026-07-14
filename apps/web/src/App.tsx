import { useEffect, useMemo, useState } from "react";
import type { Metric, UnitSystem } from "@climate-twin/contracts";
import { AppShell } from "./components/AppShell";
import { type AppPage, type ViewMode } from "./domain";
import { useClimateData } from "./useClimateData";
import { AlertsPage } from "./pages/AlertsPage";
import { DeveloperPage } from "./pages/DeveloperPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { TwinDashboard } from "./pages/TwinDashboard";
import { useI18n } from "./i18n";
import { enabledDefinitions } from "./measurements";

export function App() {
  const { t } = useI18n();
  const climate = useClimateData();
  const { state } = climate;
  const [page, setPage] = useState<AppPage>("twin");
  const [houseId, setHouseId] = useState(() => state.houses[0]?.id ?? "");
  const [floorId, setFloorId] = useState(() => state.houses[0]?.floors[0]?.id ?? "");
  const [metric, setMetric] = useState<Metric>("temperature");
  const [viewMode, setViewMode] = useState<ViewMode>("plan");
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(() => state.sensors[0]?.id ?? null);
  const [units, setUnitsState] = useState<UnitSystem>(() => localStorage.getItem("climate-twin-units") === "imperial" ? "imperial" : "metric");

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
      : []).sort();
    return times.at(-1) ?? null;
  }, [house?.id, state.sensors, state.latestMeasurements]);

  useEffect(() => {
    if (!house && state.houses[0]) setHouseId(state.houses[0].id);
  }, [house, state.houses]);
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

  const setUnits = (next: UnitSystem) => {
    localStorage.setItem("climate-twin-units", next);
    setUnitsState(next);
  };

  const chooseHouse = (id: string) => {
    setHouseId(id);
    const next = state.houses.find((item) => item.id === id);
    const nextFloorId = next?.floors[0]?.id ?? "";
    setFloorId(nextFloorId);
    setSelectedSensorId(state.sensors.find((sensor) => sensor.houseId === id && sensor.floorId === nextFloorId && sensor.enabled)?.id ?? null);
    void climate.selectHouse(id);
  };

  if (!house || !floor) {
    return <div className="loading-screen" role="status"><span className="loading-logo" aria-hidden="true" /><strong>{t("app.name")}</strong><span>{t("common.loading")}</span></div>;
  }

  return (
    <AppShell page={page} onPage={setPage} connection={climate.connection} units={units} onUnits={setUnits} lastUpdated={lastUpdated}>
      {page === "twin" && (
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id} metric={metric} units={units} viewMode={viewMode}
          selectedSensorId={selectedSensorId} saveState={climate.saveState} scenario={climate.scenario}
          onHouse={chooseHouse} onFloor={setFloorId} onMetric={setMetric} onViewMode={setViewMode} onSensorSelect={setSelectedSensorId}
          onSensorMove={(id, point) => climate.updateSensor(id, point)} onSensorUpdate={climate.updateSensor} onFloorChange={(next) => climate.updateFloor(house.id, next)}
          onSaveLayout={(next) => void climate.saveLayout(house.id, next)} onLoadSeries={(id, nextMetric, range, forecastSupported) => void climate.loadSeries(id, nextMetric, range, forecastSupported)}
          onRunScenario={(next) => void climate.runScenario(next)} onCreateObservation={climate.createObservation}
          onCreateStaticParameter={climate.createStaticParameter}
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
          onGeoreferenceChange={(patch) => climate.setHouseGeoreference(house.id, patch)}
        />
      )}
      {page === "developer" && <DeveloperPage />}
    </AppShell>
  );
}
