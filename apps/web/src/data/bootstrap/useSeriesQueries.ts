import { apiErrorStatus, errorMessage } from "../../api/support/request-error";
import { useCallback } from "react";
import { type TimeRange, timeRangeHours } from "../../domain";
import {
  MAX_SERIES_SAMPLES,
  canonicalSeries,
  mergeMeasurementSeries,
  replaceMeasurementSeriesWindow,
  seriesStateKey,
} from "./support";
import type { BufferedSeriesTelemetry } from "./support";
import type { ClimateDataStore, SeriesActions } from "./pipelineTypes";

export function useSeriesQueries(
  store: Pick<ClimateDataStore,
    | "activeSeriesTelemetryBuffers" | "apiAvailable" | "seriesCommitSequence"
    | "seriesCommitVersions" | "seriesLoadVersions" | "setSeriesStates" | "setState"
  >,
): SeriesActions {
  // Only the pipeline members this hook actually reads are pulled out.
  // Destructuring the whole context made every unrelated pipeline change touch
  // this line and turned it into a guaranteed merge conflict.
  const { seriesLoadVersions, setSeriesStates, apiAvailable, activeSeriesTelemetryBuffers, seriesCommitSequence, seriesCommitVersions, setState } = store;
  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true, signal?: AbortSignal) => {
      const seriesKey = seriesStateKey(sensorId, metric);
      const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
      seriesLoadVersions.current.set(seriesKey, requestVersion);
      const isCurrentRequest = () => !signal?.aborted && seriesLoadVersions.current.get(seriesKey) === requestVersion;
      const to = new Date();
      const from = new Date(to.getTime() - timeRangeHours(range) * 3600000);
      const requestedFrom = from.toISOString();
      const requestedTo = to.toISOString();
      setSeriesStates((current) => {
        const previous = current[seriesKey];
        return {
          ...current,
          [seriesKey]: {
            status: "loading",
            error: null,
            forecastError: previous?.forecastError ?? null,
            requestedFrom,
            requestedTo,
            loadedFrom: previous?.loadedFrom ?? null,
            loadedTo: previous?.loadedTo ?? null,
            partial: previous?.partial ?? false,
            truncated: previous?.truncated ?? false,
          },
        };
      });
      const fail = (error: unknown) => {
        if (!isCurrentRequest()) return;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            ...(current[seriesKey] ?? {
              forecastError: null, loadedFrom: null, loadedTo: null, partial: false, truncated: false,
            }),
            status: "error",
            error: errorMessage(error, "History data is temporarily unavailable"),
            errorStatus: apiErrorStatus(error),
            requestedFrom,
            requestedTo,
          },
        }));
      };
      if (!apiAvailable.current) {
        fail(new Error("History data is unavailable while the service is offline"));
        return;
      }
      const liveTelemetry: BufferedSeriesTelemetry = {
        sensorId,
        metric,
        samples: new Map(),
        readings: new Map(),
      };
      for (const buffer of activeSeriesTelemetryBuffers.current) {
        if (buffer.sensorId === sensorId && buffer.metric === metric) {
          activeSeriesTelemetryBuffers.current.delete(buffer);
        }
      }
      activeSeriesTelemetryBuffers.current.add(liveTelemetry);
      const requests = canonicalSeries(sensorId, metric, range, requestedFrom, requestedTo, forecastSupported, signal);
      let history: Awaited<typeof requests.history>;
      try {
        history = await requests.history;
      } catch (error) {
        fail(error);
        return;
      } finally {
        activeSeriesTelemetryBuffers.current.delete(liveTelemetry);
      }
      if (!isCurrentRequest()) return;
      // The history is committed before the forecast settles. A forecast is
      // computed on request and can take tens of seconds; waiting for it left
      // every chart drawing only the samples it already held.
      const refreshedSamples = mergeMeasurementSeries(
        history.samples,
        liveTelemetry.samples.values(),
        MAX_SERIES_SAMPLES,
      );
      seriesCommitSequence.current += 1;
      seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current });
      setState((current) => ({
        ...current,
        measurementHistory: {
          ...current.measurementHistory,
          [sensorId]: {
            ...current.measurementHistory[sensorId],
            [metric]: replaceMeasurementSeriesWindow(
              current.measurementHistory[sensorId]?.[metric] ?? [],
              history.samples,
              liveTelemetry.samples.values(),
              requestedFrom,
              requestedTo,
              history.truncated,
            ),
          },
        },
      }));
      const loadedFrom = refreshedSamples[0]?.timestamp ?? null;
      const loadedTo = refreshedSamples.at(-1)?.timestamp ?? null;
      setSeriesStates((current) => ({
        ...current,
        [seriesKey]: {
          status: "ready",
          error: null,
          forecastError: current[seriesKey]?.forecastError ?? null,
          requestedFrom,
          requestedTo,
          loadedFrom,
          loadedTo,
          partial: history.truncated
            || (loadedFrom !== null && Date.parse(loadedFrom) > from.getTime() + (history.bucketSeconds ?? 0) * 1_000),
          truncated: history.truncated,
        },
      }));
      const forecast = await requests.forecast;
      if (!isCurrentRequest()) return;
      if (forecast.value !== null) {
        const points = forecast.value;
        setState((current) => ({
          ...current,
          measurementForecasts: {
            ...current.measurementForecasts,
            [sensorId]: { ...current.measurementForecasts[sensorId], [metric]: points },
          },
        }));
      }
      setSeriesStates((current) => {
        const settled = current[seriesKey];
        return settled ? { ...current, [seriesKey]: { ...settled, forecastError: forecast.error } } : current;
      });
    }, []);
  return { loadSeries };
}
