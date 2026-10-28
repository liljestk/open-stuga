import { isIP } from "node:net";
import type { AppConfig } from "../config.js";

/** TLS settings for the TimescaleDB pool, from TIMESERIES_SSL_MODE. */
export interface TimeseriesSslOptions {
  rejectUnauthorized: boolean;
  ca?: string;
  servername?: string;
  checkServerIdentity?: () => undefined;
}

/**
 * `disable` sends plain text; `require` encrypts without verifying; `verify-ca`
 * verifies the certificate chain but not the host name; anything else verifies
 * both, naming the server for SNI when the host is not an IP address.
 */
export function timeseriesSslOptions(config: Pick<AppConfig, "timeseriesSslMode" | "timeseriesSslCa" | "timeseriesHost">): TimeseriesSslOptions | undefined {
  if (config.timeseriesSslMode === "disable") return undefined;
  if (config.timeseriesSslMode === "require") return { rejectUnauthorized: false };
  const ca = config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {};
  if (config.timeseriesSslMode === "verify-ca") return { rejectUnauthorized: true, ...ca, checkServerIdentity: () => undefined };
  return { rejectUnauthorized: true, ...ca, ...(isIP(config.timeseriesHost) === 0 ? { servername: config.timeseriesHost } : {}) };
}

/** Connection settings shared by every process that opens the TimescaleDB pool. */
export function timeseriesPoolConfig(config: AppConfig) {
  const ssl = timeseriesSslOptions(config);
  return {
    host: config.timeseriesHost,
    port: config.timeseriesPort,
    database: config.timeseriesDatabase,
    user: config.timeseriesUser,
    password: config.timeseriesPassword,
    // Heavy analytics are already admitted in-process. Disabling backend
    // query parallelism prevents two admitted reads from consuming every
    // Raspberry Pi core through PostgreSQL worker fan-out.
    options: "-c max_parallel_workers_per_gather=0",
    ...(ssl ? { ssl } : {}),
  };
}
