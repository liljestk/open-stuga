import { mapWithConcurrency } from "../timeseries/read-support.js";

export const MCP_THERMAL_HISTORY_READ_CONCURRENCY = 2;

interface McpThermalWorkOptions<TSubject, TOutdoor, TIndoor, TResult> {
  subjects: readonly TSubject[];
  signal?: AbortSignal;
  readOutdoor: (signal?: AbortSignal) => Promise<TOutdoor>;
  readIndoor: (subject: TSubject, signal?: AbortSignal) => Promise<TIndoor>;
  complete: (
    input: { outdoor: TOutdoor; indoor: TIndoor[] },
    signal?: AbortSignal,
  ) => TResult | Promise<TResult>;
}

/**
 * One cancellable admission shape for MCP thermal tools. Indoor history reads
 * stay aligned with the REST endpoint's two-reader limit, and the same request
 * signal reaches every read plus the cooperative model.
 */
export async function runMcpThermalWork<TSubject, TOutdoor, TIndoor, TResult>(
  options: McpThermalWorkOptions<TSubject, TOutdoor, TIndoor, TResult>,
): Promise<TResult> {
  options.signal?.throwIfAborted();
  const [outdoor, indoor] = await Promise.all([
    options.readOutdoor(options.signal),
    mapWithConcurrency(
      options.subjects,
      MCP_THERMAL_HISTORY_READ_CONCURRENCY,
      async (subject) => {
        options.signal?.throwIfAborted();
        return options.readIndoor(subject, options.signal);
      },
    ),
  ]);
  options.signal?.throwIfAborted();
  return options.complete({ outdoor, indoor }, options.signal);
}
