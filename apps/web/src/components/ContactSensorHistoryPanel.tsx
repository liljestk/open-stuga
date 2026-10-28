import { useEffect, useId, useMemo, useState, type RefObject } from "react";
import {
  Clock3,
  Database,
  DoorClosed,
  DoorOpen,
  Edit3,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  House,
  OpeningState,
  OpeningStateObservation,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import { api } from "../api";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import type { TpLinkOpeningTarget } from "../tpLinkDeviceClassification";

type ContactHistoryRange = "6h" | "24h" | "7d";
type ContactTransitionKind = "opened" | "closed";

const rangeHours: Record<ContactHistoryRange, number> = { "6h": 6, "24h": 24, "7d": 168 };
const HISTORY_LIMIT = 10_000;
const timelineWidth = 780;
const timelineMargin = 30;
const timelinePlotWidth = timelineWidth - timelineMargin * 2;

interface ContactTimelineSegment {
  state: OpeningState;
  startedAt: number;
  endedAt: number;
}

interface ContactTimelineTransition {
  id: string;
  kind: ContactTransitionKind;
  observedAt: number;
}

export interface ContactHistoryAnalysis {
  segments: ContactTimelineSegment[];
  transitions: ContactTimelineTransition[];
  openingCount: number;
  closingCount: number;
  openDurationMs: number;
  endState: OpeningState;
  observationCount: number;
}

interface ContactHistorySelection {
  deviceId: string;
  connectionId?: string;
  floorId: string;
  elementId: string;
  invert?: boolean;
  staleAfterMs?: number;
  fromMs: number;
  toMs: number;
}

function effectiveState(state: OpeningState, invert = false): OpeningState {
  if (!invert || state === "unknown") return state;
  return state === "open" ? "closed" : "open";
}

export function analyzeContactHistory(
  observations: readonly OpeningStateObservation[],
  selection: ContactHistorySelection,
): ContactHistoryAnalysis {
  const points = observations
    .filter((observation) => observation.floorId === selection.floorId
      && observation.elementId === selection.elementId
      && observation.source === "tapo"
      && observation.externalId === selection.deviceId
      && (!selection.connectionId || observation.connectionId === selection.connectionId))
    .flatMap((observation) => {
      const observedAt = Date.parse(observation.observedAt);
      return Number.isFinite(observedAt) && observedAt <= selection.toMs
        ? [{ ...observation, observedAtMs: observedAt, state: effectiveState(observation.state, selection.invert) }]
        : [];
    })
    .sort((left, right) => left.observedAtMs - right.observedAtMs || left.id.localeCompare(right.id));

  const knownSegments: ContactTimelineSegment[] = [];
  const transitions: ContactTimelineTransition[] = [];
  let previousState: OpeningState | null = null;

  for (const [index, point] of points.entries()) {
    if (point.state !== "unknown") {
      const declaredValidUntil = point.validUntil ? Date.parse(point.validUntil) : Number.POSITIVE_INFINITY;
      const validityEnd = point.validUntil && !Number.isFinite(declaredValidUntil)
        ? point.observedAtMs
        : declaredValidUntil;
      const nextTimestamp = points[index + 1]?.observedAtMs ?? selection.toMs;
      const startedAt = Math.max(selection.fromMs, point.observedAtMs);
      const endedAt = Math.min(
        selection.toMs,
        nextTimestamp,
        validityEnd,
        point.observedAtMs + Math.max(1_000, selection.staleAfterMs ?? 15 * 60_000),
      );
      if (endedAt > startedAt) {
        const previous = knownSegments.at(-1);
        if (previous && previous.state === point.state && startedAt <= previous.endedAt) {
          previous.endedAt = Math.max(previous.endedAt, endedAt);
        } else {
          knownSegments.push({ state: point.state, startedAt, endedAt });
        }
      }
    }

    if (point.state === previousState) continue;
    if (point.observedAtMs >= selection.fromMs
      && previousState === "closed" && point.state === "open") {
      transitions.push({ id: point.id, kind: "opened", observedAt: point.observedAtMs });
    } else if (point.observedAtMs >= selection.fromMs
      && previousState === "open" && point.state === "closed") {
      transitions.push({ id: point.id, kind: "closed", observedAt: point.observedAtMs });
    }
    previousState = point.state;
  }

  const segments: ContactTimelineSegment[] = [];
  let cursor = selection.fromMs;
  for (const segment of knownSegments) {
    if (segment.startedAt > cursor) {
      segments.push({ state: "unknown", startedAt: cursor, endedAt: segment.startedAt });
    }
    segments.push(segment);
    cursor = Math.max(cursor, segment.endedAt);
  }
  if (cursor < selection.toMs) {
    segments.push({ state: "unknown", startedAt: cursor, endedAt: selection.toMs });
  }
  const endState = segments.at(-1)?.state ?? "unknown";

  return {
    segments,
    transitions,
    openingCount: transitions.filter((transition) => transition.kind === "opened").length,
    closingCount: transitions.filter((transition) => transition.kind === "closed").length,
    openDurationMs: segments
      .filter((segment) => segment.state === "open")
      .reduce((total, segment) => total + segment.endedAt - segment.startedAt, 0),
    endState,
    observationCount: points.filter((point) => point.observedAtMs >= selection.fromMs).length,
  };
}

function durationLabel(milliseconds: number, locale: string, lessThanMinute: string): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (milliseconds > 0 && totalMinutes === 0) return lessThanMinute;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const formatter = (value: number, unit: "hour" | "minute") => new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(value);
  return [hours ? formatter(hours, "hour") : "", minutes || !hours ? formatter(minutes, "minute") : ""]
    .filter(Boolean)
    .join(" ");
}

function deviceState(
  device: TpLinkDiscoveredDevice,
  invert: boolean,
  fallback: OpeningState,
): OpeningState {
  if (typeof device.contactOpen !== "boolean") return fallback;
  return effectiveState(device.contactOpen ? "open" : "closed", invert);
}

interface ContactSensorHistoryPanelProps {
  device: TpLinkDiscoveredDevice;
  house: House;
  opening: TpLinkOpeningTarget | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onEdit: (() => void) | undefined;
}

export function ContactSensorHistoryPanel({
  device,
  house,
  opening,
  headingRef,
  onClose,
  onEdit,
}: Readonly<ContactSensorHistoryPanelProps>) {
  const { locale, t } = useI18n();
  const [range, setRange] = useState<ContactHistoryRange>("24h");
  const [rangeEnd] = useState(() => Date.now());
  const [observations, setObservations] = useState<OpeningStateObservation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const patternId = useId().replaceAll(":", "");
  const targetFloorId = opening?.floor.id ?? device.mappedOpening?.floorId ?? "";
  const targetElementId = opening?.element.id ?? device.mappedOpening?.elementId ?? "";
  const invert = opening?.element.stateBinding?.invert === true;
  const fromMs = rangeEnd - rangeHours[range] * 3_600_000;
  const name = device.alias?.trim()
    || opening?.element.label?.trim()
    || device.mappedOpening?.label?.trim()
    || device.model;
  const openingName = opening?.element.label?.trim()
    || device.mappedOpening?.label?.trim()
    || t("sensors.contactNotAttached");
  const floorName = opening?.floor.name
    || house.floors.find((floor) => floor.id === targetFloorId)?.name
    || t("sensors.unknownFloor");

  useEffect(() => {
    if (!targetFloorId || !targetElementId) {
      setObservations([]);
      setLoading(false);
      setError(t("sensors.contactHistoryNoAssignment"));
      return;
    }
    const controller = new AbortController();
    setObservations([]);
    setLoading(true);
    setError(null);
    void api.openingStateHistory(
      house.id,
      {
        from: new Date(fromMs).toISOString(),
        to: new Date(rangeEnd).toISOString(),
        limit: HISTORY_LIMIT,
        signal: controller.signal,
      },
    ).then((history) => {
      if (!controller.signal.aborted) setObservations(history);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error && reason.message.trim()
        ? reason.message
        : t("sensors.contactHistoryError"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fromMs, house.id, rangeEnd, retryRevision, t, targetElementId, targetFloorId]);

  const analysis = useMemo(() => analyzeContactHistory(observations, {
    deviceId: device.deviceId,
    ...(device.connectionId ? { connectionId: device.connectionId } : {}),
    floorId: targetFloorId,
    elementId: targetElementId,
    invert,
    staleAfterMs: (opening?.element.stateBinding?.staleAfterSeconds ?? 900) * 1_000,
    fromMs,
    toMs: rangeEnd,
  }), [device.connectionId, device.deviceId, fromMs, invert, observations, rangeEnd, targetElementId, targetFloorId]);
  const currentState = deviceState(device, invert, analysis.endState);
  const rangeLabel = t(`chart.range${range}`);
  const timePosition = (timestamp: number) => timelineMargin
    + (timestamp - fromMs) / Math.max(rangeEnd - fromMs, 1) * timelinePlotWidth;
  const ticks = Array.from({ length: 5 }, (_, index) => fromMs + (rangeEnd - fromMs) * index / 4);
  const timelineSummary = t("sensors.contactHistoryTimelineAria", {
    name,
    from: formatInTimeZone(fromMs, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }),
    to: formatInTimeZone(rangeEnd, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }),
    openings: analysis.openingCount,
    closings: analysis.closingCount,
  });
  const recentTransitions = analysis.transitions.slice(-12).reverse();

  return <section id="sensor-details-panel" className="panel sensor-details-panel contact-history-panel" aria-labelledby="sensor-details-title">
    <header>
      <div>
        <span className="eyebrow">{t("sensors.contactHistoryEyebrow")}</span>
        <h2 ref={headingRef} id="sensor-details-title" tabIndex={-1}>{name}</h2>
        <small>{device.deviceId}</small>
      </div>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button>
    </header>
    <div className="sensor-details-summary">
      <span><Database size={15} aria-hidden="true" />{t("sensors.contactHistoryRecords", {
        count: analysis.transitions.length,
        range: rangeLabel,
      })}</span>
      <small>{t("sensors.contactHistoryDescription")}</small>
    </div>
    <div className="contact-history-content">
      <div className="sensor-contact-detail-hero">
        <span className="sensor-contact-detail-icon" aria-hidden="true"><DoorOpen size={22} /></span>
        <span>
          <small>{t("sensors.contactCurrentAssignment")}</small>
          <strong>{openingName}</strong>
          <span>{t(`planElement.${opening?.element.kind ?? device.mappedOpening?.kind ?? "door"}`)} · {floorName}</span>
        </span>
        <strong className={`contact-state ${currentState}`}>
          {currentState === "open"
            ? t("opening.state.open")
            : currentState === "closed" ? t("opening.state.closed") : t("sensors.unknownStatus")}
        </strong>
      </div>

      <div className="contact-history-toolbar">
        <span><strong>{t("sensors.contactHistoryTimeline")}</strong><small>{t("sensors.contactHistoryTimelineHelp")}</small></span>
        <div className="segmented compact" role="group" aria-label={t("sensors.contactHistoryRange")}>
          {(["6h", "24h", "7d"] as const).map((item) => <button
            key={item}
            type="button"
            aria-pressed={range === item}
            onClick={() => setRange(item)}
          >{t(`chart.range${item}`)}</button>)}
        </div>
      </div>

      {loading ? <output className="contact-history-status" aria-live="polite">
        <LoaderCircle className="spin" size={17} aria-hidden="true" />{t("sensors.contactHistoryLoading")}
      </output> : error ? <div className="contact-history-error" role="alert">
        <TriangleAlert size={17} aria-hidden="true" />
        <span>{error}</span>
        {targetFloorId && targetElementId && <button type="button" className="text-button" onClick={() => setRetryRevision((value) => value + 1)}>{t("common.retry")}</button>}
      </div> : <>
        <dl className="contact-history-stats">
          <div><dt>{t("sensors.contactHistoryOpenings")}</dt><dd>{analysis.openingCount}</dd></div>
          <div><dt>{t("sensors.contactHistoryClosings")}</dt><dd>{analysis.closingCount}</dd></div>
          <div><dt>{t("sensors.contactHistoryOpenTime")}</dt><dd>{durationLabel(analysis.openDurationMs, locale, t("sensors.contactHistoryLessThanMinute"))}</dd></div>
          <div><dt>{t("sensors.contactHistoryCurrent")}</dt><dd>{currentState === "open" ? t("opening.state.open") : currentState === "closed" ? t("opening.state.closed") : t("sensors.unknownStatus")}</dd></div>
        </dl>

        <div className="contact-history-visual">
          <div className="contact-history-legend" aria-hidden="true">
            <span><i className="open" />{t("opening.state.open")}</span>
            <span><i className="closed" />{t("opening.state.closed")}</span>
            <span><i className="unknown" />{t("sensors.unknownStatus")}</span>
          </div>
          <div className="contact-history-scroll" role="region" aria-label={t("sensors.contactHistoryTimeline")} tabIndex={0}>
            <svg viewBox={`0 0 ${timelineWidth} 116`} role="img" aria-label={timelineSummary}>
              <title>{timelineSummary}</title>
              <defs><pattern id={patternId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" /></pattern></defs>
              <rect className="contact-history-track" x={timelineMargin} y="24" width={timelinePlotWidth} height="38" rx="5" />
              {analysis.segments.map((segment, index) => <rect
                key={`${segment.startedAt}-${segment.state}-${index}`}
                className={`contact-history-segment ${segment.state}`}
                x={timePosition(segment.startedAt)}
                y="24"
                width={Math.max(0, timePosition(segment.endedAt) - timePosition(segment.startedAt))}
                height="38"
                fill={segment.state === "unknown" ? `url(#${patternId})` : undefined}
              />)}
              {analysis.transitions.map((transition) => transition.kind === "opened"
                ? <circle key={transition.id} className="contact-history-marker opened" cx={timePosition(transition.observedAt)} cy="43" r="6" />
                : <rect key={transition.id} className="contact-history-marker closed" x={timePosition(transition.observedAt) - 5} y="38" width="10" height="10" />)}
              <g className="contact-history-axis">
                {ticks.map((tick, index) => <g key={tick}>
                  <line x1={timePosition(tick)} x2={timePosition(tick)} y1="68" y2="74" />
                  <text
                    x={timePosition(tick)}
                    y="94"
                    textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
                  >{formatInTimeZone(tick, locale, house.timezone, range === "7d"
                    ? { weekday: "short", hour: "2-digit" }
                    : { hour: "2-digit", minute: "2-digit" })}</text>
                </g>)}
              </g>
            </svg>
          </div>
        </div>

        <section className="contact-history-events" aria-labelledby="contact-history-events-title">
          <h3 id="contact-history-events-title"><Clock3 size={15} aria-hidden="true" />{t("sensors.contactHistoryRecent")}</h3>
          {recentTransitions.length > 0 ? <ol>{recentTransitions.map((transition) => <li key={transition.id}>
            <span className={`contact-history-event-icon ${transition.kind}`} aria-hidden="true">
              {transition.kind === "opened" ? <DoorOpen size={15} /> : <DoorClosed size={15} />}
            </span>
            <strong>{t(transition.kind === "opened" ? "sensors.contactHistoryOpened" : "sensors.contactHistoryClosed")}</strong>
            <time dateTime={new Date(transition.observedAt).toISOString()}>
              {formatInTimeZone(transition.observedAt, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </li>)}</ol> : <p>{t("sensors.contactHistoryNoData")}</p>}
        </section>
      </>}
    </div>
    {onEdit && <footer><div className="sensor-details-actions">
      <button type="button" className="secondary-button" onClick={onEdit}><Edit3 size={14} aria-hidden="true" />{t("sensors.contactManageAction")}</button>
    </div></footer>}
  </section>;
}
