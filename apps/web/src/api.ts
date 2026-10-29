import { alertsApi } from "./api/alerts";
import { assistantConnectorApi } from "./api/assistant-connector";
import { analyticsApi } from "./api/analytics";
import { bugReportApi } from "./api/bug-reports";
import { devicesApi } from "./api/devices";
import { electricityApi } from "./api/electricity";
import { equipmentApi } from "./api/equipment";
import { homesApi } from "./api/homes";
import { integrationsApi } from "./api/integrations";
import { maintenanceApi } from "./api/maintenance";
import { measurementsApi } from "./api/measurements";
import { nexus433Api } from "./api/nexus433";
import { propertiesApi } from "./api/properties";
import { sensorsApi } from "./api/sensors";
import { sessionApi } from "./api/session";
import { spatialLayersApi } from "./api/spatial-layers";
import { stugubyApi } from "./api/stuguby";
import { systemApi } from "./api/system";

export * from "./api/support";
export * from "./apiRuntimeVersion";

/** Each endpoint family's client; a method name belongs to exactly one of them (api.test.ts checks). */
export const apiFamilies = {
  sessionApi,
  systemApi,
  stugubyApi,
  propertiesApi,
  equipmentApi,
  electricityApi,
  homesApi,
  sensorsApi,
  alertsApi,
  maintenanceApi,
  integrationsApi,
  devicesApi,
  analyticsApi,
  measurementsApi,
  spatialLayersApi,
  nexus433Api,
  bugReportApi,
  assistantConnectorApi,
};

export const api = {
  ...sessionApi,
  ...systemApi,
  ...stugubyApi,
  ...propertiesApi,
  ...equipmentApi,
  ...electricityApi,
  ...homesApi,
  ...sensorsApi,
  ...alertsApi,
  ...maintenanceApi,
  ...integrationsApi,
  ...devicesApi,
  ...analyticsApi,
  ...measurementsApi,
  ...spatialLayersApi,
  ...nexus433Api,
  ...bugReportApi,
  ...assistantConnectorApi,
};
