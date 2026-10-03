import { ApiRequestError } from "../../api";

export function historyIsPreparing(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 503
    && error.code === "TELEMETRY_ROLLUPS_MATERIALIZING";
}

/** Poll only active, explicitly preparing history; ordinary failures keep their normal cadence. */
export function historyRefreshInterval(enabled: boolean, refreshMs: number) {
  return ({ state }: { state: { error: unknown } }): number | false => (
    enabled ? historyIsPreparing(state.error) ? 5_000 : refreshMs : false
  );
}
