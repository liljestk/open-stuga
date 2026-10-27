import { useClimateDataStore } from "./useClimateDataStore";
import { useIntegrationActions } from "./useIntegrationActions";
import { useWorkspaceHydration } from "./useWorkspaceHydration";
import { useSessionLifecycle } from "./useSessionLifecycle";
import { useLiveTelemetry } from "./useLiveTelemetry";
import { useSeriesQueries } from "./useSeriesQueries";
import { useSensorActions } from "./useSensorActions";
import { usePropertyActions } from "./usePropertyActions";
import { useOperationsActions } from "./useOperationsActions";
import { useMaintenanceActions } from "./useMaintenanceActions";
import { createClimateDataPublicModel } from "./publicModel";

export function useClimateData() {
  const store = useClimateDataStore({});
  const integrations = useIntegrationActions(store);
  const hydration = useWorkspaceHydration(integrations);
  const lifecycle = useSessionLifecycle(hydration);
  const telemetry = useLiveTelemetry(lifecycle);
  const series = useSeriesQueries(telemetry);
  const sensors = useSensorActions(series);
  const properties = usePropertyActions(sensors);
  const operations = useOperationsActions(properties);
  const maintenance = useMaintenanceActions(operations);
  return createClimateDataPublicModel(maintenance);
}
