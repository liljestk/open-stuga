import { useEffect, useMemo, useRef, useState } from "react";
import { isAirflowPlanElement, type OpeningStateObservation } from "@climate-twin/contracts";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { samplesAt, type LatestMeasurements } from "../../measurements";
import { createOutdoorBoundaryContextFromConditions } from "../../outdoorContext";
import type { OutdoorVisualizationState } from "../../components/OutdoorConditionsBadge";
import {
  type ClimateSampleMatrix,
} from "../../airflowSimulation";
import { api } from "../../api";
import {
  assessSensorCoverage,
} from "../../experimentalSpatialLayers";
import { type ReplayClimateEvent } from "../../replayEvents";
import { replayOutdoorAttribution, replayOutdoorConditions, replayOutdoorSampleAt } from "../../replayWeather";
import { openingStateCanChange, openingStateObservationsForHouse } from "../../openingState";
import { mergeOpeningStateObservations } from "./support";
import { houseLocalDateTimeCandidates } from "../../observationTime";
import { useTwinDashboardPart02 } from "./part-02";

const OPENING_FALLBACK_MIN_MS = 60_000;
const OPENING_FALLBACK_MAX_MS = 5 * 60_000;
const OPENING_STREAM_STALE_MS = 45_000;

export function useTwinDashboardPart03(context: ReturnType<typeof useTwinDashboardPart02>) {
  const { props, state, house, houseId, floorId, connection, t, editing, historyOpen, range, replayActive, setReplayActive, setReplayPlaying, setReplayStartPending, replayPrepared, setReplayPrepared, replayWindowFrom, replayWindowTo, replayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, setReplayLoadState, setReplayLoadError, setReplayLoadPartial, setReplaySampleCount, setLiveSpatialClockMs, experimentalVisualizations, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, loadSeriesOnce, outdoorContext, outdoor, houseSensors, selectedSensor, definitions, airflowDefinitions, airflowMetricKey, definition, liveSamples, houseSensorIds, replayMetricIds, replayMin, replayMax, replayTimestamp, setReplayTimestamp, spatialLayers, spatialMaxSampleAgeMs, spatialFreshness } = context;
  const selectReplayEvent = (event: ReplayClimateEvent) => {
      props.onMetric(event.metric);
      const sensor = houseSensors.find((candidate) => candidate.id === event.sensorId);
      if (!sensor) return;
      if (sensor.floorId !== floorId) props.onFloor(sensor.floorId);
      props.onSensorSelect(sensor.id);
    };
  const loadReplayWindow = async () => {
      if (!props.onLoadReplaySeries) {
        setReplayLoadState("error");
        setReplayLoadError(t("replay.windowUnavailable"));
        return;
      }
      const fromCandidates = houseLocalDateTimeCandidates(replayWindowFrom, house.timezone);
      const toCandidates = houseLocalDateTimeCandidates(replayWindowTo, house.timezone);
      const from = fromCandidates?.[0] ?? null;
      const to = toCandidates?.at(-1) ?? null;
      if (!from || !to || Date.parse(from) >= Date.parse(to)) {
        setReplayLoadState("error");
        setReplayLoadError(t("replay.invalidWindow"));
        return;
      }

      const requestId = replayWindowRequestRef.current + 1;
      replayWindowRequestRef.current = requestId;
      context.replayWindowControllerRef.current?.abort();
      const controller = new AbortController();
      context.replayWindowControllerRef.current = controller;
      setReplayLoadState("loading");
      setReplayLoadError(null);
      setReplayLoadPartial(false);
      setReplaySampleCount(null);
      context.setReplayOutdoorLoading(Boolean(house.location));
      context.setReplayOutdoorPartial(false);
      setReplayPlaying(false);
      setReplayStartPending(false);
      setReplayPrepared(true);
      try {
        const [pages, outdoorResult] = await Promise.all([
          Promise.all(houseSensors.flatMap((sensor) => replayMetricIds.map((replayMetric) => (
            props.onLoadReplaySeries!(sensor.id, replayMetric, {
              from,
              to,
              bucketSeconds: replayResolutionSeconds,
            }, controller.signal)
          )))),
          house.location
            ? api.outdoorTemperatureHistory(houseId, from, to, 20_000, controller.signal)
              .then((page) => ({ page, failed: false as const }))
              .catch(() => ({ page: null, failed: true as const }))
            : Promise.resolve({ page: null, failed: false as const }),
        ]);
        if (controller.signal.aborted || replayWindowRequestRef.current !== requestId) return;
        const minimum = Date.parse(from);
        const maximum = Date.parse(to);
        const outdoorSamples = outdoorResult.page?.samples ?? [];
        const sampleCount = pages.reduce((total, page) => total + page.samples.length, outdoorSamples.length);
        setReplayRequestedBounds({ minimum, maximum });
        setReplayTimestamp(minimum);
        context.setReplayOutdoorSamples(outdoorSamples);
        context.setReplayOutdoorPartial(outdoorResult.failed || Boolean(outdoorResult.page?.truncated));
        setReplayLoadPartial(pages.some((page) => page.truncated)
          || outdoorResult.failed
          || Boolean(outdoorResult.page?.truncated));
        setReplaySampleCount(sampleCount);
        setReplayLoadState("ready");
        setReplayActive(sampleCount > 0);
      } catch (error) {
        if (controller.signal.aborted || replayWindowRequestRef.current !== requestId) return;
        context.setReplayOutdoorLoading(false);
        controller.abort();
        setReplayLoadState("error");
        setReplayLoadError(error instanceof Error && error.message.trim() ? error.message : t("replay.loadFailed"));
      } finally {
        if (context.replayWindowControllerRef.current === controller) {
          context.replayWindowControllerRef.current = null;
        }
        if (!controller.signal.aborted && replayWindowRequestRef.current === requestId) {
          context.setReplayOutdoorLoading(false);
        }
      }
    };
  useEffect(() => {
      if (!house.location || replayRequestedBounds || (!historyOpen && !replayActive)) return;
      const from = new Date(replayMin).toISOString();
      const to = new Date(replayMax).toISOString();
      const batchKey = `${houseId}:${from}:${to}`;
      if (context.replayOutdoorBatchRef.current === batchKey) return;
      context.replayOutdoorBatchRef.current = batchKey;
      const controller = new AbortController();
      context.setReplayOutdoorLoading(true);
      context.setReplayOutdoorPartial(false);
      void api.outdoorTemperatureHistory(houseId, from, to, 20_000, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          context.setReplayOutdoorSamples(page.samples);
          context.setReplayOutdoorPartial(page.truncated);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          context.setReplayOutdoorSamples([]);
          context.setReplayOutdoorPartial(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) context.setReplayOutdoorLoading(false);
        });
      return () => controller.abort();
    }, [historyOpen, replayActive, replayRequestedBounds, replayMin, replayMax, houseId, house.location?.latitude, house.location?.longitude]);
  useEffect(() => {
      if (replayActive && replayRequestedBounds) return;
      if (selectedSensor) loadSeriesOnce(selectedSensor.id, definition);
    }, [replayActive, replayRequestedBounds, selectedSensor?.id, definition.id, range, definition.forecastSupported, loadSeriesOnce]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds) {
        replayBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${definition.id}:${range}:${houseSensorIds}`;
      if (replayBatchRef.current === batchKey) return;
      replayBatchRef.current = batchKey;
      houseSensors.forEach((sensor) => {
        if (sensor.id !== selectedSensor?.id) loadSeriesOnce(sensor.id, definition);
      });
    }, [replayActive, replayRequestedBounds, houseId, definition.id, definition.forecastSupported, range, houseSensorIds, selectedSensor?.id, loadSeriesOnce]);
  useEffect(() => {
      // Loading every metric for every sensor can produce dozens of requests.
      // History is an on-demand workspace, so prepare it only after the person
      // opens that workspace (or while an active replay still depends on it).
      if ((!historyOpen && !replayActive) || !replayPrepared || replayRequestedBounds) {
        replayPreparationBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}`;
      if (replayPreparationBatchRef.current === batchKey) return;
      replayPreparationBatchRef.current = batchKey;
      definitions
        .filter((candidate) => replayMetricIds.includes(candidate.id))
        .forEach((replayDefinition) => houseSensors.forEach((sensor) => {
          loadSeriesOnce(sensor.id, replayDefinition);
        }));
    }, [historyOpen, replayActive, replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, replayMetricIds, loadSeriesOnce]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds) {
        airflowReplayBatchRef.current = "";
        return;
      }
      const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}:${definition.id}:${replayPrepared}`;
      if (airflowReplayBatchRef.current === batchKey) return;
      airflowReplayBatchRef.current = batchKey;
      airflowDefinitions.forEach((airflowDefinition) => {
        if (airflowDefinition.id === definition.id) return;
        if (replayPrepared && (airflowDefinition.id === "temperature" || airflowDefinition.id === "humidity")) return;
        houseSensors.forEach((sensor) => {
          loadSeriesOnce(sensor.id, airflowDefinition);
        });
      });
    }, [replayActive, replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, airflowMetricKey, definition.id, loadSeriesOnce]);
  useEffect(() => {
      if (!replayActive || replayRequestedBounds || !selectedSensor) {
        inspectorReplayBatchRef.current = "";
        return;
      }
      const supported = definitions.filter((candidate) => candidate.id !== definition.id
        && !airflowDefinitions.some((airflow) => airflow.id === candidate.id)
        && (selectedSensor.measurementEntityIds?.[candidate.id]
          || state.latestMeasurements[selectedSensor.id]?.[candidate.id]
          || state.measurementHistory[selectedSensor.id]?.[candidate.id]?.length));
      const batchKey = `${selectedSensor.id}:${range}:${supported.map((candidate) => candidate.id).join(",")}`;
      if (inspectorReplayBatchRef.current === batchKey) return;
      inspectorReplayBatchRef.current = batchKey;
      supported.forEach((candidate) => {
        loadSeriesOnce(selectedSensor.id, candidate);
      });
    }, [replayActive, replayRequestedBounds, selectedSensor?.id, range, definition.id, airflowMetricKey, state.latestMeasurements, state.measurementHistory, loadSeriesOnce]);
  const replayOutdoorSample = useMemo(
      () => replayOutdoorSampleAt(context.replayOutdoorSamples, replayTimestamp),
      [context.replayOutdoorSamples, replayTimestamp],
    );
  const historicalOutdoorContext = useMemo(() => {
      if (!replayOutdoorSample) return null;
      const observedAt = Date.parse(replayOutdoorSample.timestamp);
      const stale = !Number.isFinite(observedAt)
        || replayTimestamp - observedAt > spatialMaxSampleAgeMs;
      return createOutdoorBoundaryContextFromConditions(
        house,
        replayOutdoorConditions(replayOutdoorSample),
        stale,
      );
    }, [house, replayOutdoorSample, replayTimestamp, spatialMaxSampleAgeMs]);
  const replayAwareOutdoor = useMemo<OutdoorVisualizationState>(() => {
      if (!replayActive) return outdoor;
      const attribution = replayOutdoorSample ? replayOutdoorAttribution(replayOutdoorSample) : null;
      return {
        context: historicalOutdoorContext,
        loading: context.replayOutdoorLoading,
        unavailable: !context.replayOutdoorLoading && !historicalOutdoorContext,
        refreshFailed: false,
        hasLocation: Boolean(house.location),
        replayActive: true,
        timeZone: house.timezone,
        ...(house.orientationDegrees === undefined ? {} : { orientationDegrees: house.orientationDegrees }),
        ...(attribution ? { attribution } : {}),
      };
    }, [replayActive, outdoor, historicalOutdoorContext, context.replayOutdoorLoading, house.location, house.orientationDegrees, house.timezone, replayOutdoorSample]);
  const replayAwareOutdoorContext = replayActive ? historicalOutdoorContext : outdoorContext;
  const displayedSamples = useMemo(() => replayActive
      ? samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), definition.id, replayTimestamp)
      : liveSamples,
    [replayActive, replayTimestamp, houseSensors, state.measurementHistory, liveSamples, definition.id]);
  const mapSensorMeasurements = useMemo<LatestMeasurements>(() => {
      if (!replayActive) return state.latestMeasurements;
      const replaySamples = replayMetricIds.map((replayMetric) => (
        samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), replayMetric, replayTimestamp)
      ));
      return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
        replaySamples.flatMap((samplesBySensor) => {
          const sample = samplesBySensor[sensor.id];
          return sample ? [[sample.metric, sample]] : [];
        }),
      )]));
    }, [replayActive, replayTimestamp, houseSensors, replayMetricIds, state.latestMeasurements, state.measurementHistory]);
  const airflowSamples = useMemo<ClimateSampleMatrix>(() => {
      if (!replayActive) {
        return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id] ?? {}]));
      }
      const replayByMetric = Object.fromEntries(airflowDefinitions.map((airflowDefinition) => [
        airflowDefinition.id,
        samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), airflowDefinition.id, replayTimestamp),
      ]));
      return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
        airflowDefinitions.flatMap((airflowDefinition) => {
          const sample = replayByMetric[airflowDefinition.id]?.[sensor.id];
          return sample ? [[airflowDefinition.id, sample]] : [];
        }),
      )]));
    }, [replayActive, replayTimestamp, houseSensors, state.latestMeasurements, state.measurementHistory, airflowMetricKey]);
  const sensorCoverage = useMemo(() => assessSensorCoverage({
      house,
      sensors: houseSensors,
      samples: airflowSamples,
      freshness: spatialFreshness,
    }), [house, houseSensors, airflowSamples, spatialFreshness]);
  const airMovementSelected = spatialLayers.available && experimentalVisualizations.includes("air-movement");
  const coverageSelected = spatialLayers.available && experimentalVisualizations.includes("sensor-coverage");
  const openingStateAt = replayActive ? new Date(replayTimestamp).toISOString() : undefined;
  const [openingStateObservations, setOpeningStateObservations] = useState<OpeningStateObservation[]>([]);
  const [replayOpeningStateObservations, setReplayOpeningStateObservations] = useState<OpeningStateObservation[]>([]);
  const [pendingOpeningStateKeys, setPendingOpeningStateKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [openingStateError, setOpeningStateError] = useState<string | null>(null);
  const [openingStateAnnouncement, setOpeningStateAnnouncement] = useState("");
  const openingStateRequestsRef = useRef(new Set<string>());
  const openingStateContextRef = useRef({ houseId });
  const openingStateHydrationKeyRef = useRef("");
  const suppressedOpeningObservationIdRef = useRef("");
  const openingLiveSinceRef = useRef(Date.now());
  const openingTelemetryHeartbeatRef = useRef(state.latestTelemetryHeartbeatAt);
  openingTelemetryHeartbeatRef.current = state.latestTelemetryHeartbeatAt;
  const [openingPageVisible, setOpeningPageVisible] = useState(() => document.visibilityState !== "hidden");
  if (openingStateContextRef.current.houseId !== houseId) openingStateContextRef.current = { houseId };
  const houseOpeningStateObservations = useMemo(
      () => openingStateObservationsForHouse(
        houseId,
        openingStateAt === undefined ? openingStateObservations : replayOpeningStateObservations,
      ),
      [houseId, openingStateAt, openingStateObservations, replayOpeningStateObservations],
    );
  const controllableOpenings = useMemo(() => house.floors.flatMap((candidateFloor) => (
      (candidateFloor.planElements ?? []).flatMap((element, index) => (
        isAirflowPlanElement(element) && openingStateCanChange(element)
          ? [{ floor: candidateFloor, element, index }]
          : []
      ))
    )), [house.floors]);
  const hasOpeningElements = useMemo(() => house.floors.some((candidateFloor) => (
      (candidateFloor.planElements ?? []).some(isAirflowPlanElement)
    )), [house.floors]);
  const replayOpeningMinimum = replayRequestedBounds?.minimum ?? replayMin;
  const replayOpeningMaximum = replayRequestedBounds?.maximum ?? replayMax;
  useEffect(() => {
      setOpeningStateObservations([]);
      setReplayOpeningStateObservations([]);
      setPendingOpeningStateKeys(new Set());
      setOpeningStateError(null);
      setOpeningStateAnnouncement("");
      openingStateRequestsRef.current.clear();
      openingStateHydrationKeyRef.current = "";
      suppressedOpeningObservationIdRef.current = "";
    }, [houseId]);
  useEffect(() => {
      if (!replayActive || !hasOpeningElements) {
        setReplayOpeningStateObservations([]);
        return;
      }
      const minimum = replayOpeningMinimum;
      const maximum = replayOpeningMaximum;
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
        setReplayOpeningStateObservations([]);
        return;
      }
      const controller = new AbortController();
      setReplayOpeningStateObservations([]);
      void api.openingStateHistory(
        houseId,
        new Date(minimum).toISOString(),
        new Date(maximum).toISOString(),
        10_000,
        controller.signal,
      ).then((observations) => {
        if (!controller.signal.aborted) setReplayOpeningStateObservations(observations);
      }).catch(() => {
        // Configured opening defaults remain visible when replay history is not
        // available. One range request replaces per-frame archive lookups.
      });
      return () => controller.abort();
    }, [hasOpeningElements, houseId, replayActive, replayOpeningMaximum, replayOpeningMinimum]);
  useEffect(() => {
      const updateVisibility = () => setOpeningPageVisible(document.visibilityState !== "hidden");
      document.addEventListener("visibilitychange", updateVisibility);
      return () => document.removeEventListener("visibilitychange", updateVisibility);
    }, []);
  useEffect(() => {
      if (connection === "live") openingLiveSinceRef.current = Date.now();
    }, [connection]);
  useEffect(() => {
      const observation = state.latestOpeningStateObservation;
      if (observation?.houseId !== houseId) return;
      if (openingStateAt !== undefined || editing || !openingPageVisible) {
        suppressedOpeningObservationIdRef.current = observation.id;
        return;
      }
      if (suppressedOpeningObservationIdRef.current === observation.id) {
        suppressedOpeningObservationIdRef.current = "";
        return;
      }
      const observedAtMs = Date.parse(observation.observedAt);
      setLiveSpatialClockMs((current) => Math.max(
        current,
        Date.now(),
        Number.isFinite(observedAtMs) ? observedAtMs : 0,
      ));
      setOpeningStateObservations((current) => mergeOpeningStateObservations(current, [observation]));
    }, [editing, houseId, openingPageVisible, openingStateAt, state.latestOpeningStateObservation]);
  useEffect(() => {
      if (!hasOpeningElements || openingStateAt !== undefined || editing || !openingPageVisible) {
        // The next live render must perform one authoritative catch-up after a
        // replay, layout edit, or hidden-tab interval. Keeping the completed key
        // here would defer missed state until the slow disconnected fallback.
        if (openingStateAt !== undefined || editing || !openingPageVisible) openingStateHydrationKeyRef.current = "";
        return;
      }
      const hydrationKey = `${houseId}:${openingStateAt ?? "current"}`;
      if (openingStateHydrationKeyRef.current === hydrationKey) return;
      openingStateHydrationKeyRef.current = hydrationKey;
      const controller = new AbortController();
      let settled = false;
      void api.openingStates(houseId, openingStateAt, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setOpeningStateObservations((current) => mergeOpeningStateObservations(current, result.observations));
        }
      }).catch(() => {
        // Keep configured/manual fallbacks. A disconnected stream uses the
        // deliberately slow fallback below; a healthy stream supplies updates.
      }).finally(() => {
        settled = true;
      });
      return () => {
        controller.abort();
        if (!settled && openingStateHydrationKeyRef.current === hydrationKey) {
          openingStateHydrationKeyRef.current = "";
        }
      };
    }, [editing, hasOpeningElements, houseId, openingPageVisible, openingStateAt]);
  useEffect(() => {
      if (!hasOpeningElements || openingStateAt !== undefined || editing || !openingPageVisible) return;
      let stopped = false;
      let timer: number | null = null;
      let controller: AbortController | null = null;
      let delayMs = OPENING_FALLBACK_MIN_MS;
      const schedule = () => {
        if (!stopped) timer = window.setTimeout(() => { void check(); }, delayMs);
      };
      const check = async () => {
        if (stopped || document.visibilityState === "hidden") return;
        const lastHeartbeat = openingTelemetryHeartbeatRef.current ?? openingLiveSinceRef.current;
        const streamFresh = connection === "live" && Date.now() - lastHeartbeat < OPENING_STREAM_STALE_MS;
        if (streamFresh) {
          delayMs = OPENING_FALLBACK_MIN_MS;
          schedule();
          return;
        }
        controller = new AbortController();
        try {
          const result = await api.openingStates(houseId, undefined, controller.signal);
          if (!controller.signal.aborted && !stopped) {
            setOpeningStateObservations((current) => mergeOpeningStateObservations(current, result.observations));
            delayMs = OPENING_FALLBACK_MIN_MS;
          }
        } catch {
          if (!controller.signal.aborted) delayMs = Math.min(OPENING_FALLBACK_MAX_MS, delayMs * 2);
        } finally {
          controller = null;
          schedule();
        }
      };
      schedule();
      return () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        controller?.abort();
      };
    }, [connection, editing, hasOpeningElements, houseId, openingPageVisible, openingStateAt]);
  return Object.assign(context, { outdoor: replayAwareOutdoor, outdoorContext: replayAwareOutdoorContext, replayOutdoorSample, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, openingStateAt, openingStateObservations, setOpeningStateObservations, pendingOpeningStateKeys, setPendingOpeningStateKeys, openingStateError, setOpeningStateError, openingStateAnnouncement, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations, controllableOpenings, hasOpeningElements });
}
