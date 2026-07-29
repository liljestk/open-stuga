import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { vi } from "vitest";
import { TimeseriesStore } from "../src/timeseries/store.js";

export const FROM = "2026-07-18T00:00:00.000Z";
export const TO = "2026-07-18T01:00:00.000Z";

interface CapturedQuery {
  text: string;
  values: unknown[];
  direct: boolean;
}

type QueryHandler = (
  query: CapturedQuery,
) => Promise<QueryResult<QueryResultRow>> | QueryResult<QueryResultRow>;

export function queryResult(
  rows: QueryResultRow[] = [],
  rowCount = rows.length,
): QueryResult<QueryResultRow> {
  return {
    command: "SELECT",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  };
}

export class FakePool {
  readonly queries: CapturedQuery[] = [];
  readonly releases: ReturnType<typeof vi.fn> = vi.fn();
  readonly end = vi.fn(async () => undefined);
  readonly on = vi.fn(() => this);
  readonly off = vi.fn(() => this);
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  handler: QueryHandler;

  readonly client = {
    processID: 4_242,
    query: async (config: QueryConfig) => this.dispatch(config, false),
    release: this.releases,
  } as unknown as PoolClient;

  readonly connect = vi.fn(async () => this.client);
  readonly query = vi.fn(async (config: QueryConfig) => this.dispatch(config, true));

  constructor(handler: QueryHandler = ({ text }) => {
    if (text.includes("AS timescale_version")) {
      return queryResult([{ timescale_version: null }]);
    }
    return queryResult();
  }) {
    this.handler = handler;
  }

  private dispatch(
    config: QueryConfig,
    direct: boolean,
  ): Promise<QueryResult<QueryResultRow>> {
    const query = {
      text: config.text,
      values: config.values ?? [],
      direct,
    };
    this.queries.push(query);
    return Promise.resolve(this.handler(query));
  }
}

export function storeFor(pool: FakePool): TimeseriesStore {
  return new TimeseriesStore({
    pool: pool as unknown as Pool,
    statementTimeoutMs: 0,
  });
}
