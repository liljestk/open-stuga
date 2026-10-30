import { useEffect, useRef, useState, type ReactNode } from "react";
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
  House,
  HomePerformanceEvidenceState,
  HomePerformanceSensorIssue,
  MeasurementDefinition,
} from "@climate-twin/contracts";
import { useHomePerformanceQuery } from "../../data/analytics/homePerformanceQuery";
import { useI18n } from "../../i18n";
import { measurementLabel } from "../../measurements";
import { DerivedArtifactNotices } from "../../components/DerivedArtifactNotices";
import { RefreshButton } from "../../components/RefreshButton";

const PERFORMANCE_DAYS = 30;

interface HomePerformancePanelProps {
  house: House;
  definitions: MeasurementDefinition[];
  dataMode: "demo" | "real" | "unknown";
  refreshRevision: number;
  embedded?: boolean;
  canRefresh?: boolean;
}

interface PerformanceRowProps {
  icon: ReactNode;
  label: string;
  value: string;
  context: string;
  state: HomePerformanceEvidenceState;
  children?: ReactNode;
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
  const canRefresh = props.canRefresh ?? true;
  const dataMode = props.dataMode === "real" ? "live" as const : "demo" as const;
  const queryIdentity = `${props.house.id}:${dataMode}`;
  const query = useHomePerformanceQuery(
    props.house.id,
    dataMode,
    props.dataMode !== "unknown",
  );
  const firstRefresh = useRef(true);
  const [settledFailure, setSettledFailure] = useState<{ identity: string; error: unknown } | null>(null);

  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (props.dataMode !== "unknown") void query.refetch();
    // Global refresh only re-reads the durable artifact. The panel button is
    // the sole UI action here that may enqueue a new computation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshRevision]);

  useEffect(() => {
    setSettledFailure((current) => {
      if (query.error) return { identity: queryIdentity, error: query.error };
      if (query.data || current?.identity !== queryIdentity) return null;
      return current;
    });
  }, [query.data, query.error, queryIdentity]);

  const durable = query.data ?? null;
  const performance = durable?.result ?? null;
  const visibleFailure = query.error
    ?? (settledFailure?.identity === queryIdentity ? settledFailure.error : null);
  const loading = query.isLoading && !visibleFailure;
  const partialFailures = performance?.warnings.map((warning) => warning.message)
    ?? (visibleFailure
      ? [visibleFailure instanceof Error ? visibleFailure.message : t("performance.partial", { sources: "" })]
      : []);

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
  const energy = performance?.energy;
  const energyDetail = [
    energy?.indexMethod === "regression" && energy.baseLoadKwhPerDay != null && energy.energyPerHeatingDegreeHour !== null && energy.heatingSlopeInterval
      ? t("performance.energy.regression", {
          base: number(energy.baseLoadKwhPerDay, 1),
          slope: number(energy.energyPerHeatingDegreeHour, 3),
          temperature: number(energy.heatingBaseTemperatureC ?? 17, 1),
          low: number(energy.heatingSlopeInterval.low, 3),
          high: number(energy.heatingSlopeInterval.high, 3),
        })
      : null,
    energy?.comparisonChangePercent != null && energy.comparisonInterval
      ? t("performance.energy.comparison", {
          change: number(energy.comparisonChangePercent, 0),
          low: number(energy.comparisonInterval.lowPercent, 0),
          high: number(energy.comparisonInterval.highPercent, 0),
        })
      : null,
  ].filter(Boolean).join(" ");
  const maintenanceValue = performance?.maintenance.evaluatedActions
    ? `${performance.maintenance.improvedActions}/${performance.maintenance.evaluatedActions}`
    : dash;
  const sensorReviewCount = performance
    ? Math.max(0, performance.sensorHealth.monitoredSensors - performance.sensorHealth.healthySensors)
    : 0;
  const sensorValue = performance?.sensorHealth.monitoredSensors
    ? t("performance.sensors.reviewValue", { count: sensorReviewCount })
    : dash;

  return <section
    className="home-performance-panel panel"
    {...(props.embedded
      ? { "aria-label": t("performance.title") }
      : { "aria-labelledby": "home-performance-title" })}
  >
    <header className={`home-performance-header${props.embedded ? " embedded" : ""}`}>
      {props.embedded
        ? <span className="eyebrow"><Gauge size={14} aria-hidden="true" />{t("performance.eyebrow")}</span>
        : <div>
            <span className="eyebrow"><Gauge size={14} aria-hidden="true" />{t("performance.eyebrow")}</span>
            <h2 id="home-performance-title">{t("performance.title")}</h2>
            <p>{t("performance.description")}</p>
          </div>}
      <div className="isolation-controls">
        {performance && <PerformanceState state={performance.status} />}
        {canRefresh && <RefreshButton
          onClick={() => query.refresh()}
          busy={query.recalculating}
          disabled={query.isFetching || props.dataMode === "unknown"}
          label={t("derived.recalculate")}
          busyLabel={t("derived.recalculating")}
        />}
      </div>
    </header>

    {loading && <output className="home-performance-loading" aria-live="polite">
      <CircleDashed size={16} aria-hidden="true" />{t("derived.loading")}
    </output>}
    <DerivedArtifactNotices status={durable} hasResult={Boolean(performance)} canRefresh={canRefresh} />
    {!loading && partialFailures.length > 0 && <p className="home-performance-notice" role="status">
      <Info size={15} aria-hidden="true" />{t("performance.partial", { sources: partialFailures.join(", ") })}
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
            context={[t("performance.exposure.context", {
              hours: number(performance.exposure.observedHours, 1),
              degreeHours: number(performance.exposure.temperatureDegreeHours, 1),
              humidityHours: number(performance.exposure.humidityOutsideGuideHours, 1),
              co2Hours: number(performance.exposure.co2AboveGuideHours, 1),
            }), performance.exposure.excludedRooms?.length
              ? t("performance.exposure.excluded", { rooms: new Intl.ListFormat(locale).format(performance.exposure.excludedRooms) })
              : null].filter(Boolean).join(" ")}
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
          >{energyDetail ? <p>{energyDetail}</p> : null}</PerformanceRow>
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
