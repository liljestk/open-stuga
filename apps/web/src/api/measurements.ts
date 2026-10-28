import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { type MeasurementForecastEvaluation, type MeasurementForecastPoint, type MeasurementSample, expectShape, isMeasurementForecastEvaluation, isMeasurementForecastPoints, withSignal } from "@climate-twin/contracts";
import { requestV2 } from "./support/request";
import type { HistoricalImportResult, MeasurementHistoryQuery } from "./support/response-types";
import { measurementForecastPointShape, measurementHistoryPageShape, measurementSampleShape, sensorMeasurementPageShape } from "./support/entity-shapes";
import { anyBody, string, number, arrayOf, recordOf, fields } from "./support/response-shapes";

const measurementHistoryPageRequest = async (
    sensorId: string,
    { metric, from, to, limit = 500, bucketSeconds, signal, cursor }: MeasurementHistoryQuery,
  ) => {
    const query = new URLSearchParams({ sensorId, metric, from, to, limit: String(limit) });
    if (bucketSeconds !== undefined) query.set("bucketSeconds", String(bucketSeconds));
    if (cursor) query.set("cursor", cursor);
    return requestV2(`/measurements/history?${query.toString()}`, measurementHistoryPageShape, withSignal(signal));
  };

/** Measurement snapshots, history pages, historical imports and forecasts. */
export const measurementsApi = {
  measurementSnapshot: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => (await requestV2(
      `/measurements/snapshot?houseId=${encodeURIComponent(houseId)}`, fields({ snapshot: arrayOf(fields({ sensorId: string, measurements: recordOf(measurementSampleShape) })) }), { schedulingClass },
    )).snapshot,
  measurementHistoryPage: measurementHistoryPageRequest,
  measurementHistory: async (sensorId: string, query: Omit<MeasurementHistoryQuery, "bucketSeconds" | "cursor">) => (
      await measurementHistoryPageRequest(sensorId, query)
    ).samples,
  sensorMeasurementPage: (sensorId: string, cursor: string | null = null, limit = 100) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return requestV2(`/sensors/${encodeURIComponent(sensorId)}/measurements?${query}`, sensorMeasurementPageShape);
    },
  importHistoricalMeasurements: async (
      samples: MeasurementSample[],
      onProgress?: (completed: number, total: number) => void,
    ): Promise<HistoricalImportResult> => {
      let accepted = 0;
      let ignoredDuplicates = 0;
      for (let offset = 0; offset < samples.length; offset += 1_000) {
        const batch = samples.slice(offset, offset + 1_000);
        const result = await requestV2("/measurements/import", fields({ accepted: number, ignoredDuplicates: number }), {
          method: "POST",
          body: JSON.stringify({ samples: batch }),
        });
        accepted += result.accepted;
        ignoredDuplicates += result.ignoredDuplicates;
        onProgress?.(Math.min(offset + batch.length, samples.length), samples.length);
      }
      return { submitted: samples.length, accepted, ignoredDuplicates };
    },
  measurementForecast: async (sensorId: string, { metric, hours = 12, signal }: { metric: string; hours?: number; signal?: AbortSignal | undefined }) => (
      await requestV2(
        `/measurements/forecast?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`, fields({ forecast: arrayOf(measurementForecastPointShape) }),
        withSignal(signal),
      )
    ).forecast,
  /** The forecast with the backtest that decided whether it is shown. */
  measurementForecastWithEvaluation: async (
      { sensorId, metric, hours = 12, signal }: { sensorId: string; metric: string; hours?: number; signal?: AbortSignal },
    ): Promise<{ forecast: MeasurementForecastPoint[]; evaluation?: MeasurementForecastEvaluation }> => {
      const endpoint = "/measurements/forecast";
      const body = await requestV2(
        `${endpoint}?sensorId=${encodeURIComponent(sensorId)}&metric=${encodeURIComponent(metric)}&hours=${hours}`, anyBody,
        signal ? { signal } : undefined,
      );
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const forecast = expectShape(record.forecast, isMeasurementForecastPoints, endpoint);
      const evaluation = record.evaluation === undefined ? undefined : expectShape(record.evaluation, isMeasurementForecastEvaluation, endpoint);
      return evaluation ? { forecast, evaluation } : { forecast };
    },
};
