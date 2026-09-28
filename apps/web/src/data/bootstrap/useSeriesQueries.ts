import { useCallback } from "react";
import { type TimeRange, timeRangeHours } from "../../domain";
import {
  MAX_SERIES_SAMPLES,
  canonicalSeries,
  apiErrorStatus,
  errorMessage,
  isLegacySeriesCompatibilityError,
  legacySeries,
  mergeLegacySeries,
  mergeMeasurementSeries,
  metricForecastSamples,
  metricHistorySamples,
  replaceLegacySeriesWindow,
  replaceMeasurementSeriesWindow,
  seriesLimit,
  seriesStateKey,
} from "./support";
import type { BufferedSeriesTelemetry } from "./support";
import type { LiveTelemetryContext, SeriesActions } from "./pipelineTypes";

export function useSeriesQueries(
  context: LiveTelemetryContext,
): LiveTelemetryContext & SeriesActions {
  // Only the pipeline members this hook actually reads are pulled out.
  // Destructuring the whole context made every unrelated pipeline change touch
  // this line and turned it into a guaranteed merge conflict.
  const {
    activeSeriesTelemetryBuffers,
    apiAvailable,
    seriesCommitSequence,
    seriesCommitVersions,
    seriesLoadVersions,
    setSeriesStates,
    setState,
  } = context;
  const loadSeries = useCallback(async (sensorId: string, metric: string, range: TimeRange, forecastSupported = true, signal?: AbortSignal) => {
      const seriesKey = seriesStateKey(sensorId, metric);
      const requestVersion = (seriesLoadVersions.current.get(seriesKey) ?? 0) + 1;
      seriesLoadVersions.current.set(seriesKey, requestVersion);
      const isCurrentRequest = () => seriesLoadVersions.current.get(seriesKey) === requestVersion;
      const to = new Date();
      const from = new Date(to.getTime() - timeRangeHours(range) * 3600000);
      const requestedFrom = from.toISOString();
      const requestedTo = to.toISOString();
      const limit = seriesLimit(range);
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
      try {
        let loaded: Awaited<ReturnType<typeof canonicalSeries>> | null = null;
        let canonicalError: unknown = null;
        try {
          loaded = await canonicalSeries(sensorId, metric, range, requestedFrom, requestedTo, forecastSupported, signal);
        } catch (error) {
          canonicalError = error;
          // The v1 projection below remains available during a staggered upgrade.
        }
        if (signal?.aborted) return;
        if (!isCurrentRequest()) return;
        if (loaded) {
          const refreshedSamples = mergeMeasurementSeries(
            loaded.samples,
            liveTelemetry.samples.values(),
            MAX_SERIES_SAMPLES,
          );
          seriesCommitSequence.current += 1;
          seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: false });
          setState((current) => {
            const samples = replaceMeasurementSeriesWindow(
              current.measurementHistory[sensorId]?.[metric] ?? [],
              loaded.samples,
              liveTelemetry.samples.values(),
              requestedFrom,
              requestedTo,
              loaded.history.truncated,
            );
            const next = {
              ...current,
              measurementHistory: {
                ...current.measurementHistory,
                [sensorId]: { ...current.measurementHistory[sensorId], [metric]: samples },
              },
            };
            return loaded.forecast.value === null ? next : {
              ...next,
              measurementForecasts: {
                ...current.measurementForecasts,
                [sensorId]: { ...current.measurementForecasts[sensorId], [metric]: loaded.forecast.value },
              },
            };
          });
          const loadedFrom = refreshedSamples[0]?.timestamp ?? null;
          const loadedTo = refreshedSamples.at(-1)?.timestamp ?? null;
          setSeriesStates((current) => ({
            ...current,
            [seriesKey]: {
              status: "ready",
              error: null,
              forecastError: loaded.forecast.error,
              requestedFrom,
              requestedTo,
              loadedFrom,
              loadedTo,
              partial: loaded.history.truncated
                || (loadedFrom !== null && Date.parse(loadedFrom) > from.getTime() + (loaded.history.bucketSeconds ?? 0) * 1_000),
              truncated: loaded.history.truncated,
            },
          }));
          return;
        }
        if ((metric !== "temperature" && metric !== "humidity")
          || !isLegacySeriesCompatibilityError(canonicalError)) {
          fail(canonicalError);
          return;
        }
        let fallback: Awaited<ReturnType<typeof legacySeries>>;
        try {
          fallback = await legacySeries(sensorId, range, requestedFrom, requestedTo, forecastSupported, signal);
        } catch (error) {
          if (signal?.aborted) return;
          fail(error ?? canonicalError);
          return;
        }
        if (!isCurrentRequest()) return;
        const refreshedHistory = mergeLegacySeries(fallback.history, liveTelemetry.readings.values(), limit);
        seriesCommitSequence.current += 1;
        seriesCommitVersions.current.set(seriesKey, { version: seriesCommitSequence.current, legacy: true });
        setState((current) => {
          const history = replaceLegacySeriesWindow(
            current.history[sensorId] ?? [],
            fallback.history,
            liveTelemetry.readings.values(),
            requestedFrom,
            requestedTo,
          );
          const metricSamples = replaceMeasurementSeriesWindow(
            current.measurementHistory[sensorId]?.[metric] ?? [],
            metricHistorySamples(refreshedHistory, current.measurementDefinitions, metric),
            liveTelemetry.samples.values(),
            requestedFrom,
            requestedTo,
          );
          const next = {
            ...current,
            history: { ...current.history, [sensorId]: history },
            measurementHistory: {
              ...current.measurementHistory,
              [sensorId]: { ...current.measurementHistory[sensorId], [metric]: metricSamples },
            },
          };
          if (fallback.forecasts.value === null) return next;
          return {
            ...next,
            forecasts: { ...current.forecasts, [sensorId]: fallback.forecasts.value },
            measurementForecasts: {
              ...current.measurementForecasts,
              [sensorId]: {
                ...current.measurementForecasts[sensorId],
                [metric]: metricForecastSamples(fallback.forecasts.value, current.measurementDefinitions, metric),
              },
            },
          };
        });
        const loadedFrom = refreshedHistory[0]?.timestamp ?? null;
        const loadedTo = refreshedHistory.at(-1)?.timestamp ?? null;
        setSeriesStates((current) => ({
          ...current,
          [seriesKey]: {
            status: "ready",
            error: null,
            forecastError: fallback.forecasts.error,
            requestedFrom,
            requestedTo,
            loadedFrom,
            loadedTo,
            partial: refreshedHistory.length >= limit && loadedFrom !== null && Date.parse(loadedFrom) > from.getTime(),
            truncated: refreshedHistory.length >= limit && loadedFrom !== null && Date.parse(loadedFrom) > from.getTime(),
          },
        }));
      } finally {
        activeSeriesTelemetryBuffers.current.delete(liveTelemetry);
      }
    }, []);
  return Object.assign(context, { loadSeries });
}
