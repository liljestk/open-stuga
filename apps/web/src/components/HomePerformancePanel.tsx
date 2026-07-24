import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleDashed,
  Droplets,
  Gauge,
  Info,
  RadioTower,
  Wind,
  Wrench,
} from "lucide-react";
import type {
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  House,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  Sensor,
} from "@climate-twin/contracts";
import { api } from "../api";
import {
  deriveHomePerformance,
  type HomePerformanceEvidenceState,
  type HomePerformanceResult,
  type HomePerformanceSensorIssue,
} from "../homePerformance";
import { useI18n } from "../i18n";
import { measurementLabel } from "../measurements";

const DAY_MS = 86_400_000;
const PERFORMANCE_DAYS = 30;
const RECOVERY_DAYS = 7;
const MAX_PERFORMANCE_SENSORS = 40;
const OUTDOOR_HISTORY_LIMIT = 10_000;
const OPENING_HISTORY_LIMIT = 10_000;
const ACTION_RUN_LIMIT = 500;

interface HomePerformancePanelProps {
  house: House;
  sensors: Sensor[];
  definitions: MeasurementDefinition[];
  maintenanceTasks: MaintenanceTask[];
  observations: ManualObservation[];
  dataMode: "demo" | "real" | "unknown";
  refreshRevision: number;
}

interface PerformanceRowProps {
  icon: ReactNode;
  label: string;
  value: string;
  context: string;
  state: HomePerformanceEvidenceState;
  children?: ReactNode;
}

function resultValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function stateIcon(state: HomePerformanceEvidenceState): ReactNode {
  if (state === "ready") return <Check size={13} aria-hidden="true" />;
  if (state === "limited") return <CircleDashed size={13} aria-hidden="true" />;
  return <Info size={13} aria-hidden="true" />;
}

function PerformanceState({ state }: Readonly<{ state: HomePerformanceEvidenceState }>) {
  const { t } = useI18n();
  return <span className={`performance-state ${state}`}>{stateIcon(state)}{t(`performance.state.${state}`)}</span>;
}

function PerformanceRow(props: Readonly<PerformanceRowProps>) {
  return <article className="performance-check">
    <span className="performance-check-icon" aria-hidden="true">{props.icon}</span>
    <div className="performance-check-copy">
      <div className="performance-check-heading">
        <h3>{props.label}</h3>
        <PerformanceState state={props.state} />
      </div>
      <strong className="performance-check-value">{props.value}</strong>
      <p>{props.context}</p>
      {props.children}
    </div>
  </article>;
}

function queryInput(
  house: House,
  sensorIds: string[],
  measurementIds: string[],
  dataMode: "live" | "demo",
  start: string,
  end: string,
  resolution: "15m" | "1h",
  requestId: string,
): AnalyticsQueryRequest {
  return {
    apiVersion: "1.0" as const,
    dataMode,
    scope: { kind: "house" as const, id: house.id, entityIds: sensorIds },
    measurementIds,
    range: { start, end, timezone: house.timezone },
    resolution,
    aggregation: "default" as const,
    qualityFilter: { include: ["good", "estimated"] },
    include: ["series", "summary", "quality", "provenance"],
    maxPointsPerSeries: 1_000,
    requestId,
  };
}

function issueText(
  issue: HomePerformanceSensorIssue,
  definitions: readonly MeasurementDefinition[],
  locale: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const definition = definitions.find((candidate) => candidate.id === issue.metric);
  const metric = definition ? measurementLabel(definition, locale) : issue.metric;
  if (issue.code === "low-coverage") {
    return t("performance.sensorIssue.lowCoverage", {
      sensor: issue.sensorName,
      metric,
      percent: Math.round(issue.value),
    });
  }
  if (issue.code === "flatline") {
    return t("performance.sensorIssue.flatline", {
      sensor: issue.sensorName,
      metric,
    });
  }
  return t("performance.sensorIssue.changedBaseline", {
    sensor: issue.sensorName,
    metric,
  });
}

export function HomePerformancePanel(props: Readonly<HomePerformancePanelProps>) {
  const { locale, t } = useI18n();
  const [performance, setPerformance] = useState<HomePerformanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [partialFailures, setPartialFailures] = useState(0);

  useEffect(() => {
    if (props.dataMode === "unknown") {
      setPerformance(null);
      setLoading(false);
      setPartialFailures(0);
      return;
    }
    const controller = new AbortController();
    const end = new Date();
    const from = new Date(end.getTime() - PERFORMANCE_DAYS * DAY_MS);
    const recoveryFrom = new Date(end.getTime() - RECOVERY_DAYS * DAY_MS);
    const enabledSensors = props.sensors.filter((sensor) => sensor.enabled)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const scopedSensors = enabledSensors.slice(0, MAX_PERFORMANCE_SENSORS);
    const sensorIds = scopedSensors.map((sensor) => sensor.id);
    const availableMetrics = new Set(props.definitions.filter((definition) => definition.enabled).map((definition) => definition.id));
    const climateMetrics = ["temperature", "humidity", "co2"].filter((metric) => availableMetrics.has(metric));
    const energyMetrics = ["energy", "power"].filter((metric) => availableMetrics.has(metric));
    const dataMode = props.dataMode === "real" ? "live" as const : "demo" as const;
    const endIso = end.toISOString();
    const fromIso = from.toISOString();
    const recoveryFromIso = recoveryFrom.toISOString();
    const emptyAnalytics = Promise.resolve<AnalyticsQueryResponse | null>(null);

    setPerformance(null);
    setLoading(true);
    setPartialFailures(0);
    void Promise.allSettled([
      sensorIds.length > 0 && climateMetrics.length > 0
        ? api.analyticsQuery(queryInput(
            props.house,
            sensorIds,
            climateMetrics,
            dataMode,
            fromIso,
            endIso,
            "1h",
            `home-performance-climate-${props.house.id}-${props.refreshRevision}`,
          ), controller.signal)
        : emptyAnalytics,
      sensorIds.length > 0 && climateMetrics.length > 0
        ? api.analyticsQuery(queryInput(
            props.house,
            sensorIds,
            climateMetrics,
            dataMode,
            recoveryFromIso,
            endIso,
            "15m",
            `home-performance-recovery-${props.house.id}-${props.refreshRevision}`,
          ), controller.signal)
        : emptyAnalytics,
      sensorIds.length > 0 && energyMetrics.length > 0
        ? api.analyticsQuery(queryInput(
            props.house,
            sensorIds,
            energyMetrics,
            dataMode,
            fromIso,
            endIso,
            "1h",
            `home-performance-energy-${props.house.id}-${props.refreshRevision}`,
          ), controller.signal)
        : emptyAnalytics,
      api.outdoorTemperatureHistory(props.house.id, fromIso, endIso, OUTDOOR_HISTORY_LIMIT, controller.signal),
      api.openingStateHistory(props.house.id, recoveryFromIso, endIso, OPENING_HISTORY_LIMIT, controller.signal),
      api.actionRuns({ houseId: props.house.id, limit: ACTION_RUN_LIMIT }, controller.signal),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      const [climateResult, recoveryResult, energyResult, outdoorResult, openingResult, actionResult] = results;
      const failures = results.filter((result) => result.status === "rejected").length;
      const outdoor = resultValue(outdoorResult);
      const openings = resultValue(openingResult);
      const actionRuns = resultValue(actionResult);
      setPartialFailures(failures);
      setPerformance(deriveHomePerformance({
        house: props.house,
        sensors: scopedSensors,
        definitions: props.definitions,
        climate: resultValue(climateResult),
        recoveryClimate: resultValue(recoveryResult),
        energy: resultValue(energyResult),
        outdoor: outdoor?.samples ?? [],
        openings: openings ?? [],
        actionRuns: actionRuns ?? [],
        maintenanceTasks: props.maintenanceTasks,
        observations: props.observations,
        from: fromIso,
        to: endIso,
        generatedAt: endIso,
        sensorScopeTruncated: enabledSensors.length > scopedSensors.length,
        evidenceScopeTruncated: Boolean(
          outdoor?.truncated
          || (openings?.length ?? 0) >= OPENING_HISTORY_LIMIT
          || (actionRuns?.length ?? 0) >= ACTION_RUN_LIMIT
        ),
      }));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [
    props.dataMode,
    props.definitions,
    props.house,
    props.maintenanceTasks,
    props.observations,
    props.refreshRevision,
    props.sensors,
  ]);

  const number = (value: number, maximumFractionDigits = 1) => new Intl.NumberFormat(locale, {
    maximumFractionDigits,
  }).format(value);
  const dash = "—";
  const guideValue = performance?.exposure.guideRangePercent === null || performance?.exposure.guideRangePercent === undefined
    ? dash
    : `${number(performance.exposure.guideRangePercent, 0)}%`;
  const recoveryValue = performance?.recovery.medianHalfLifeMinutes
    ? t("performance.minutesShort", { value: number(performance.recovery.medianHalfLifeMinutes, 0) })
    : dash;
  const openingValue = performance?.openingEffectiveness.evaluatedEvents
    ? `${performance.openingEffectiveness.effectiveEvents}/${performance.openingEffectiveness.evaluatedEvents}`
    : dash;
  const energyValue = performance?.energy.energyPerHeatingDegreeHour !== null
    && performance?.energy.energyPerHeatingDegreeHour !== undefined
    ? t("performance.energyIndexValue", { value: number(performance.energy.energyPerHeatingDegreeHour, 3) })
    : dash;
  const maintenanceValue = performance?.maintenance.evaluatedActions
    ? `${performance.maintenance.improvedActions}/${performance.maintenance.evaluatedActions}`
    : dash;
  const sensorReviewCount = performance
    ? Math.max(0, performance.sensorHealth.monitoredSensors - performance.sensorHealth.healthySensors)
    : 0;
  const sensorValue = performance?.sensorHealth.monitoredSensors
    ? t("performance.sensors.reviewValue", { count: sensorReviewCount })
    : dash;

  return <section className="home-performance-panel panel" aria-labelledby="home-performance-title">
    <header className="home-performance-header">
      <div>
        <span className="eyebrow"><Gauge size={14} aria-hidden="true" />{t("performance.eyebrow")}</span>
        <h2 id="home-performance-title">{t("performance.title")}</h2>
        <p>{t("performance.description")}</p>
      </div>
      {performance && <PerformanceState state={performance.status} />}
    </header>

    {loading && <output className="home-performance-loading" aria-live="polite">
      <CircleDashed size={16} aria-hidden="true" />{t("performance.loading")}
    </output>}
    {!loading && partialFailures > 0 && <p className="home-performance-notice" role="status">
      <Info size={15} aria-hidden="true" />{t("performance.partial", { count: partialFailures })}
    </p>}

    {performance && <div className="home-performance-content">
      <dl className="home-performance-summary">
        <div>
          <dt>{t("performance.summary.guide")}</dt>
          <dd>{guideValue}<small>{t("performance.summary.guideContext")}</small></dd>
        </div>
        <div>
          <dt>{t("performance.summary.recovery")}</dt>
          <dd>{recoveryValue}<small>{t("performance.summary.recoveryContext")}</small></dd>
        </div>
        <div>
          <dt>{t("performance.summary.energy")}</dt>
          <dd>{energyValue}<small>{t("performance.summary.energyContext")}</small></dd>
        </div>
        <div>
          <dt>{t("performance.summary.confidence")}</dt>
          <dd>
            {performance.sensorHealth.coveragePercent === null ? dash : `${number(performance.sensorHealth.coveragePercent, 0)}%`}
            <small>{t("performance.summary.confidenceContext")}</small>
          </dd>
        </div>
      </dl>

      <details className="home-performance-details">
        <summary>
          <span><ChartNoAxesCombined size={17} aria-hidden="true" />{t("performance.openChecks")}</span>
          <ChevronDown size={17} aria-hidden="true" />
        </summary>
        <div className="performance-checks">
          <PerformanceRow
            icon={<Activity size={19} />}
            label={t("performance.exposure.title")}
            value={guideValue}
            state={performance.exposure.state}
            context={t("performance.exposure.context", {
              hours: number(performance.exposure.observedHours, 1),
              degreeHours: number(performance.exposure.temperatureDegreeHours, 1),
              humidityHours: number(performance.exposure.humidityOutsideGuideHours, 1),
              co2Hours: number(performance.exposure.co2AboveGuideHours, 1),
            })}
          />
          <PerformanceRow
            icon={<Droplets size={19} />}
            label={t("performance.recovery.title")}
            value={recoveryValue}
            state={performance.recovery.state}
            context={performance.recovery.episodeCount > 0
              ? t("performance.recovery.context", { count: performance.recovery.episodeCount })
              : t("performance.recovery.empty")}
          />
          <PerformanceRow
            icon={<Wind size={19} />}
            label={t("performance.opening.title")}
            value={openingValue}
            state={performance.openingEffectiveness.state}
            context={performance.openingEffectiveness.effectiveEvents > 0
              ? t("performance.opening.context", {
                  effective: performance.openingEffectiveness.effectiveEvents,
                  evaluated: performance.openingEffectiveness.evaluatedEvents,
                  minutes: number(performance.openingEffectiveness.medianClearanceMinutes ?? 0, 0),
                  opening: performance.openingEffectiveness.bestOpeningLabel ?? t("performance.opening.generic"),
                })
              : performance.openingEffectiveness.evaluatedEvents > 0
                ? t("performance.opening.noEffect", {
                    evaluated: performance.openingEffectiveness.evaluatedEvents,
                  })
                : t("performance.opening.empty")}
          />
          <PerformanceRow
            icon={<Gauge size={19} />}
            label={t("performance.energy.title")}
            value={energyValue}
            state={performance.energy.state}
            context={performance.energy.source === "heating-meter" && performance.energy.energyKwh !== null
              ? t("performance.energy.heatingMeter", {
                  energy: number(performance.energy.energyKwh, 1),
                  degreeHours: number(performance.energy.heatingDegreeHours, 0),
                })
              : performance.energy.source === "unclassified-electricity" && performance.energy.energyKwh !== null
                ? t("performance.energy.unclassified", {
                    energy: number(performance.energy.energyKwh, 1),
                    degreeHours: number(performance.energy.heatingDegreeHours, 0),
                  })
                : t("performance.energy.empty")}
          />
          <PerformanceRow
            icon={<Wrench size={19} />}
            label={t("performance.maintenance.title")}
            value={maintenanceValue}
            state={performance.maintenance.state}
            context={performance.maintenance.evaluatedActions > 0
              ? t("performance.maintenance.context", {
                  improved: performance.maintenance.improvedActions,
                  evaluated: performance.maintenance.evaluatedActions,
                  unmeasured: performance.maintenance.completedWithoutMeasurement,
                })
              : t("performance.maintenance.empty", {
                  count: performance.maintenance.completedWithoutMeasurement,
                })}
          />
          <PerformanceRow
            icon={<RadioTower size={19} />}
            label={t("performance.sensors.title")}
            value={sensorValue}
            state={performance.sensorHealth.state}
            context={performance.sensorHealth.monitoredSensors > 0
              ? t("performance.sensors.context", {
                  review: sensorReviewCount,
                  monitored: performance.sensorHealth.monitoredSensors,
                  coverage: number(performance.sensorHealth.coveragePercent ?? 0, 0),
                })
              : t("performance.sensors.empty")}
          >
            {performance.sensorHealth.issues.length > 0 && <ul className="performance-issue-list">
              {performance.sensorHealth.issues.slice(0, 4).map((issue) => <li key={`${issue.sensorId}-${issue.metric}-${issue.code}`}>
                {issueText(issue, props.definitions, locale, t)}
              </li>)}
            </ul>}
          </PerformanceRow>
        </div>

        {(performance.exposure.rooms.length > 0 || performance.sensorHealth.issues.length > 0) && <details className="performance-evidence-details">
          <summary><span>{t("performance.openEvidence")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
          {performance.exposure.rooms.length > 0 && <div className="performance-table-wrap" role="region" aria-label={t("performance.roomTable")} tabIndex={0}>
            <table className="performance-table">
              <thead><tr>
                <th scope="col">{t("performance.room")}</th>
                <th scope="col">{t("performance.inGuide")}</th>
                <th scope="col">{t("performance.temperatureBurden")}</th>
                <th scope="col">{t("performance.humidityBurden")}</th>
                <th scope="col">{t("performance.co2Burden")}</th>
              </tr></thead>
              <tbody>{performance.exposure.rooms.map((room) => <tr key={room.id}>
                <th scope="row">{room.label}</th>
                <td>{number(room.guideRangePercent, 0)}%</td>
                <td>{t("performance.degreeHoursShort", { value: number(room.temperatureDegreeHours, 1) })}</td>
                <td>{t("performance.hoursShort", { value: number(room.humidityOutsideGuideHours, 1) })}</td>
                <td>{t("performance.hoursShort", { value: number(room.co2AboveGuideHours, 1) })}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </details>}

        {performance.limitations.length > 0 && <aside className="performance-limitations">
          <Info size={16} aria-hidden="true" />
          <div><strong>{t("performance.limitations")}</strong><ul>
            {performance.limitations.map((limitation) => <li key={limitation}>{t(`performance.limitation.${limitation}`)}</li>)}
          </ul></div>
        </aside>}
        <p className="performance-method">
          {t("performance.method", {
            version: performance.provenance.algorithmVersion,
            days: PERFORMANCE_DAYS,
            sensors: performance.provenance.sourceIds.length,
          })}
        </p>
      </details>
    </div>}

    {!loading && !performance && <p className="home-performance-empty">{t("performance.noData")}</p>}
  </section>;
}
