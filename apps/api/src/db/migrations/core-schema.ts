import { CORE_SCHEMA_01 } from "./core-schema-01.js";
import { CORE_SCHEMA_02 } from "./core-schema-02.js";
import { CORE_SCHEMA_03 } from "./core-schema-03.js";
import { CORE_SCHEMA_04 } from "./core-schema-04.js";
import { CORE_SCHEMA_05 } from "./core-schema-05.js";
import { CORE_SCHEMA_06 } from "./core-schema-06.js";
import { CORE_SCHEMA_07 } from "./core-schema-07.js";
import { CORE_SCHEMA_08 } from "./core-schema-08.js";
import { CORE_SCHEMA_09 } from "./core-schema-09.js";
import { WEATHER_SNAPSHOT_SCHEMA_SQL } from "./weather-snapshot-schema.js";
import { DERIVED_ANALYTICS_SCHEMA_SQL } from "./derived-analytics-schema.js";

export const CORE_SCHEMA_SQL = [
  CORE_SCHEMA_01,
  CORE_SCHEMA_02,
  CORE_SCHEMA_03,
  CORE_SCHEMA_04,
  CORE_SCHEMA_05,
  CORE_SCHEMA_06,
  CORE_SCHEMA_07,
  CORE_SCHEMA_08,
  CORE_SCHEMA_09,
  WEATHER_SNAPSHOT_SCHEMA_SQL,
  DERIVED_ANALYTICS_SCHEMA_SQL,
].join("");
