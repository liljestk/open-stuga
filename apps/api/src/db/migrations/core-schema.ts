import { CORE_SCHEMA_01 } from "./core-schema-01.js";
import { CORE_SCHEMA_02 } from "./core-schema-02.js";
import { DEMO_DATA_GUARD_SCHEMA_SQL } from "./demo-data-guard-schema.js";
import { HEAT_PUMP_SCHEMA_SQL } from "./heat-pump-schema.js";
import { CONNECTED_DEVICE_SCHEMA_SQL } from "./connected-device-schema.js";
import { EXTERNAL_SOURCE_SCHEMA_SQL } from "./external-source-schema.js";
import { HOST_DIAGNOSTICS_SCHEMA_SQL } from "./host-diagnostics-schema.js";
import { ELECTRICITY_TARIFF_SCHEMA_SQL } from "./electricity-tariff-schema.js";
import { FORECAST_EVALUATION_SCHEMA_SQL } from "./forecast-evaluation-schema.js";
import { SENSOR_REPORTING_INTERVAL_SCHEMA_SQL } from "./sensor-reporting-interval-schema.js";
import { TELEMETRY_HISTORY_REVISION_SCHEMA_SQL } from "./telemetry-history-revision-schema.js";
import { ANALYTICS_LATENCY_SCHEMA_SQL } from "./analytics-latency-schema.js";
import { WEATHER_SNAPSHOT_SCHEMA_SQL } from "./weather-snapshot-schema.js";
import { DERIVED_ANALYTICS_SCHEMA_SQL } from "./derived-analytics-schema.js";
import { ASSISTANT_CONNECTOR_SCHEMA_SQL } from "./assistant-connector-schema.js";

// Statements run in this order: triggers follow the tables they guard.
export const CORE_SCHEMA_SQL = [
  CORE_SCHEMA_01,
  CORE_SCHEMA_02,
  DEMO_DATA_GUARD_SCHEMA_SQL,
  HEAT_PUMP_SCHEMA_SQL,
  CONNECTED_DEVICE_SCHEMA_SQL,
  EXTERNAL_SOURCE_SCHEMA_SQL,
  HOST_DIAGNOSTICS_SCHEMA_SQL,
  ELECTRICITY_TARIFF_SCHEMA_SQL,
  FORECAST_EVALUATION_SCHEMA_SQL,
  SENSOR_REPORTING_INTERVAL_SCHEMA_SQL,
  TELEMETRY_HISTORY_REVISION_SCHEMA_SQL,
  ANALYTICS_LATENCY_SCHEMA_SQL,
  WEATHER_SNAPSHOT_SCHEMA_SQL,
  DERIVED_ANALYTICS_SCHEMA_SQL,
  ASSISTANT_CONNECTOR_SCHEMA_SQL,
].join("");
