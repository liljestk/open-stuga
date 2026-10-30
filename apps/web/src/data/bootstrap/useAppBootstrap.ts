import { useClimateDataStore } from "./useClimateDataStore";
import { useIntegrationActions } from "./useIntegrationActions";
import { useWorkspaceHydration } from "./useWorkspaceHydration";
import { useStreamConnections } from "./useStreamConnections";
import { useMutationRefresh } from "./useMutationRefresh";
import { useLiveTelemetry } from "./useLiveTelemetry";
import { useSessionLifecycle } from "./useSessionLifecycle";
import { useSeriesQueries } from "./useSeriesQueries";
import { useSensorActions } from "./useSensorActions";
import { usePropertyActions } from "./usePropertyActions";
import { useOperationsActions } from "./useOperationsActions";
import { useMaintenanceActions } from "./useMaintenanceActions";
import { createClimateDataPublicModel } from "./publicModel";

/**
 * The workspace bootstrap. Each hook reads the shared store, takes only the actions it calls from
 * the hooks before it, and returns its own actions; nothing is threaded through a growing bag.
 */
export function useClimateData() {
  const store = useClimateDataStore();
  const integrations = useIntegrationActions(store);
  const hydration = useWorkspaceHydration(store);
  const streams = useStreamConnections(store, hydration);
  const refresh = useMutationRefresh(store, { ...integrations, ...hydration });
  const telemetry = useLiveTelemetry(store, { ...integrations, ...hydration, ...refresh });
  const lifecycle = useSessionLifecycle(store, { ...integrations, ...hydration, ...streams, ...telemetry });
  const series = useSeriesQueries(store);
  const sensors = useSensorActions(store, integrations);
  const properties = usePropertyActions(store, sensors);
  const operations = useOperationsActions(store, properties);
  const maintenance = useMaintenanceActions(store);
  return createClimateDataPublicModel({
    ...store, ...integrations, ...hydration, ...streams, ...refresh, ...telemetry, ...lifecycle,
    ...series, ...sensors, ...properties, ...operations, ...maintenance,
  });
}
