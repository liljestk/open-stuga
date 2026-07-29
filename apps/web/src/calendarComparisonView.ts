import type {
  CalendarComparisonPoint,
  CalendarComparisonResponse,
  CalendarComparisonSeries,
} from "@climate-twin/contracts";

export type CalendarComparisonSource = "combined" | string;

export interface CalendarChartPoint extends CalendarComparisonPoint {
  period: CalendarComparisonSeries["period"];
  aggregation: CalendarComparisonSeries["aggregation"];
}

export interface CalendarPeriodSeries
  extends Omit<CalendarComparisonSeries, "points"> {
  points: CalendarChartPoint[];
}

/** Presentation-only adapter. All alignment and summaries come from the API response. */
export function calendarPeriodSeries(
  loaded: CalendarComparisonResponse | null,
  source: CalendarComparisonSource,
): CalendarPeriodSeries[] {
  if (!loaded) return [];
  return loaded.series
    .filter((series) => series.sourceId === source)
    .map((series) => ({
      ...series,
      points: series.points.map((point) => ({
        ...point,
        period: series.period,
        aggregation: series.aggregation,
      })),
    }));
}
