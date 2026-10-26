import type { DataMode } from "./measurement-analytics.js";
import type {
  DerivedAnalyticsCache,
  DerivedAnalyticsProvenance,
  DerivedAnalyticsWarning,
} from "./analytics-common.js";
import type { HvacExclusionSummary } from "./weather-thermal.js";

export const HOME_PERFORMANCE_ALGORITHM_VERSION = "home-performance-v4.0.0";

export type HomePerformanceEvidenceState = "ready" | "limited" | "unavailable";

export interface HomePerformanceRoomExposure {
  id: string;
  label: string;
  sensorIds: string[];
  guideRangePercent: number;
  observedHours: number;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
  /** The temperature band this room was judged against. */
  comfortTemperatureLowC?: number;
  comfortTemperatureHighC?: number;
}

export interface HomePerformanceExposure {
  state: HomePerformanceEvidenceState;
  guideRangePercent: number | null;
  observedHours: number;
  temperatureDegreeHours: number;
  humidityOutsideGuideHours: number;
  co2AboveGuideHours: number;
  worstRoom: HomePerformanceRoomExposure | null;
  rooms: HomePerformanceRoomExposure[];
  /** Rooms left out of comfort exposure, such as saunas. */
  excludedRooms?: string[];
}

export interface HomePerformanceRecovery {
  state: HomePerformanceEvidenceState;
  episodeCount: number;
  medianHalfLifeMinutes: number | null;
}

export interface HomePerformanceOpeningEffectiveness {
  state: HomePerformanceEvidenceState;
  evaluatedEvents: number;
  effectiveEvents: number;
  medianClearanceMinutes: number | null;
  bestOpeningLabel: string | null;
}

export interface HomePerformanceEnergy {
  state: HomePerformanceEvidenceState;
  energyKwh: number | null;
  heatingDegreeHours: number;
  energyPerHeatingDegreeHour: number | null;
  comparisonChangePercent: number | null;
  source: "heating-meter" | "unclassified-electricity" | null;
  /** Outdoor °C below which degree-hours accumulate: the house's parameter, 17 °C by default. */
  heatingBaseTemperatureC?: number;
  /** "regression" when the index is the fitted heating slope; "ratio" when too few days allow a fit. */
  indexMethod?: "regression" | "ratio";
  /** Fitted daily energy with no heating need. */
  baseLoadKwhPerDay?: number | null;
  /** 90% interval of the heating slope. */
  heatingSlopeInterval?: { low: number; high: number } | null;
  /** 90% interval of comparisonChangePercent. */
  comparisonInterval?: { lowPercent: number; highPercent: number } | null;
}

export interface HomePerformanceMaintenance {
  state: HomePerformanceEvidenceState;
  evaluatedActions: number;
  improvedActions: number;
  improvementPercent: number | null;
  linkedEvaluatedActions: number;
  completedWithoutMeasurement: number;
  recurringObservations: number;
}

export type HomePerformanceSensorIssueCode =
  | "low-coverage"
  | "flatline"
  | "changed-baseline";

export interface HomePerformanceSensorIssue {
  code: HomePerformanceSensorIssueCode;
  sensorId: string;
  sensorName: string;
  metric: string;
  value: number;
  unit: string;
}

export interface HomePerformanceSensorHealth {
  state: HomePerformanceEvidenceState;
  monitoredSensors: number;
  healthySensors: number;
  coveragePercent: number | null;
  issues: HomePerformanceSensorIssue[];
}

export type HomePerformanceLimitation =
  | "archive-incomplete"
  | "opening-history-missing"
  | "unclassified-energy"
  | "maintenance-evidence-missing"
  | "coverage-limited";

export interface HomePerformanceResponse {
  apiVersion: "1.0";
  houseId: string;
  dataMode: DataMode;
  status: HomePerformanceEvidenceState;
  generatedAt: string;
  evaluatedAt: string;
  from: string;
  to: string;
  recoveryFrom: string;
  complete: boolean;
  exposure: HomePerformanceExposure;
  recovery: HomePerformanceRecovery;
  openingEffectiveness: HomePerformanceOpeningEffectiveness;
  energy: HomePerformanceEnergy;
  maintenance: HomePerformanceMaintenance;
  sensorHealth: HomePerformanceSensorHealth;
  limitations: HomePerformanceLimitation[];
  warnings: DerivedAnalyticsWarning[];
  /** Heat-pump evidence used only for recovery and opening-effectiveness episodes. */
  hvacExclusion?: HvacExclusionSummary;
  provenance: DerivedAnalyticsProvenance & {
    truthClass: "derived";
    archiveStates: string[];
  };
  cache: DerivedAnalyticsCache;
}
