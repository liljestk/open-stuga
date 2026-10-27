import type {
  SpatialConnection,
  SpatialConnectionStateInterval,
  SpatialLayerEngineInput,
} from './contracts.js';

import { clamp, mean, median } from './math.js';

import { prepareSpatialWindow, type PreparedSpatialWindow } from './series.js';

import { createSignalSeries, detectEvents, propagationConfig, segmentCorrelation, withCommonModeFractions, intervalOpenFraction, connectionOpenFractionThroughout } from "./propagation-signals.js";
import type { ClimatePropagationEvent, DirectedPropagationEvidence, MatchedPropagationEvent, PropagationAnalysis, PropagationConfig, PropagationSignal, SignalSeries } from "./propagation-signals.js";

export function directedEvidence(
  connection: SpatialConnection,
  fromZoneId: string,
  toZoneId: string,
  events: ClimatePropagationEvent[],
  series: SignalSeries[],
  config: PropagationConfig,
  stateIntervals?: readonly SpatialConnectionStateInterval[],
): DirectedPropagationEvidence {
  const sourceEvents = events.filter((event) => event.zoneId === fromZoneId && event.commonModeFraction < 0.75);
  const targetEvents = events.filter((event) => event.zoneId === toZoneId);
  const matches: MatchedPropagationEvent[] = [];
  const usedTargets = new Set<string>();
  for (const sourceEvent of sourceEvents) {
    const candidates = targetEvents.filter((target) => {
      const lag = target.peakIndex - sourceEvent.peakIndex;
      return (
        !usedTargets.has(target.id) &&
        target.signal === sourceEvent.signal &&
        target.sign === sourceEvent.sign &&
        lag >= config.minimumLagBuckets &&
        lag <= config.maximumLagBuckets &&
        connectionOpenFractionThroughout(
          stateIntervals,
          connection.enabled,
          sourceEvent.peakAt,
          target.peakAt,
        ) > 0
      );
    });
    let best: MatchedPropagationEvent | undefined;
    for (const targetEvent of candidates) {
      const lagBuckets = targetEvent.peakIndex - sourceEvent.peakIndex;
      const sourceSeries = series.find(
        (item) => item.zoneId === fromZoneId && item.signal === sourceEvent.signal,
      );
      const targetSeries = series.find(
        (item) => item.zoneId === toZoneId && item.signal === sourceEvent.signal,
      );
      if (sourceSeries === undefined || targetSeries === undefined) continue;
      const correlation = Math.max(0, segmentCorrelation(
        sourceSeries,
        targetSeries,
        sourceEvent,
        lagBuckets,
        connection,
        stateIntervals,
      ));
      const amplitudeRatio =
        Math.min(sourceEvent.amplitudeZ, targetEvent.amplitudeZ) /
        Math.max(sourceEvent.amplitudeZ, targetEvent.amplitudeZ, 1e-6);
      const sourceStrength = clamp((sourceEvent.amplitudeZ - config.eventThresholdZ) / 4);
      const targetStrength = clamp((targetEvent.amplitudeZ - config.eventThresholdZ) / 4);
      const sourceQuality = mean(
        sourceSeries.quality.slice(sourceEvent.startIndex, sourceEvent.endIndex + 1),
      );
      const targetQuality = mean(
        targetSeries.quality.slice(targetEvent.startIndex, targetEvent.endIndex + 1),
      );
      const commonPenalty = 1 - 0.85 * Math.max(sourceEvent.commonModeFraction, targetEvent.commonModeFraction);
      const lagSeconds = Math.max(0, (Date.parse(targetEvent.peakAt) - Date.parse(sourceEvent.peakAt)) / 1_000);
      const timingCompatibility = clamp(
        lagSeconds / Math.max(sourceSeries.timingResolutionSeconds, targetSeries.timingResolutionSeconds),
      );
      const openingFraction = connectionOpenFractionThroughout(
        stateIntervals,
        connection.enabled,
        sourceEvent.peakAt,
        targetEvent.peakAt,
      );
      const score = clamp(
        (0.4 * correlation + 0.25 * amplitudeRatio + 0.2 * sourceStrength + 0.15 * targetStrength) *
          Math.sqrt(sourceQuality * targetQuality) *
          commonPenalty *
          timingCompatibility *
          openingFraction,
      );
      const match: MatchedPropagationEvent = {
        connectionId: connection.id,
        fromZoneId,
        toZoneId,
        signal: sourceEvent.signal,
        sourceEventId: sourceEvent.id,
        targetEventId: targetEvent.id,
        sourceAt: sourceEvent.peakAt,
        targetAt: targetEvent.peakAt,
        lagSeconds,
        evidenceScore: score,
      };
      if (best === undefined || match.evidenceScore > best.evidenceScore) best = match;
    }
    if (best !== undefined && best.evidenceScore >= 0.2) {
      matches.push(best);
      usedTargets.add(best.targetEventId);
    }
  }
  const recurrence = clamp(matches.length / config.minimumDistinctEvents);
  const score = mean(matches.map((match) => match.evidenceScore)) * recurrence;
  const bySignal = (signal: PropagationSignal): number => {
    const matching = matches.filter((match) => match.signal === signal);
    return mean(matching.map((match) => match.evidenceScore)) * clamp(matching.length / config.minimumDistinctEvents);
  };
  return {
    fromZoneId,
    toZoneId,
    evidenceScore: clamp(score),
    matchedEventCount: matches.length,
    sourceEventCount: sourceEvents.length,
    lagSeconds: matches.length === 0 ? null : median(matches.map((match) => match.lagSeconds)),
    temperatureEvidence: bySignal('temperature'),
    humidityEvidence: bySignal('humidity-ratio'),
    matches,
  };
}

export function analyseGraphPropagation(
  input: SpatialLayerEngineInput,
  existingPrepared?: PreparedSpatialWindow,
): PropagationAnalysis {
  const prepared = existingPrepared ?? prepareSpatialWindow(input);
  const config = propagationConfig(input);
  // Keep the wall-clock grid complete. Building an index only from buckets
  // that contain a reading compresses whole-house outages and invents shorter
  // propagation delays after a gap.
  const bucketMs = prepared.resampled.bucketSeconds * 1_000;
  const firstBucket = Math.ceil(Date.parse(prepared.resampled.startAt) / bucketMs) * bucketMs;
  const end = Date.parse(prepared.resampled.endAt);
  const buckets: string[] = [];
  for (let bucket = firstBucket; bucket <= end; bucket += bucketMs) {
    buckets.push(new Date(bucket).toISOString());
  }
  const signalSeries = [
    ...createSignalSeries(prepared, 'temperature', buckets, config.baselineBuckets, config.commonModeWeight),
    ...createSignalSeries(prepared, 'humidity-ratio', buckets, config.baselineBuckets, config.commonModeWeight),
  ];
  const detected = signalSeries.flatMap((series) => detectEvents(series, config));
  const events = withCommonModeFractions(detected, prepared.zoneSeries.size, signalSeries, config);
  const intervalsByConnection = new Map<string, SpatialConnectionStateInterval[]>();
  for (const interval of input.connectionStateIntervals ?? []) {
    const intervals = intervalsByConnection.get(interval.connectionId) ?? [];
    intervals.push(interval);
    intervalsByConnection.set(interval.connectionId, intervals);
  }
  for (const intervals of intervalsByConnection.values()) {
    intervals.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  }
  const edges = input.topology.connections.filter((connection) => {
    const intervals = intervalsByConnection.get(connection.id);
    return intervals === undefined
      ? connection.enabled
      : intervals.some((interval) => intervalOpenFraction(interval) > 0);
  }).map((connection) => {
    const stateIntervals = intervalsByConnection.get(connection.id);
    const forward = directedEvidence(
      connection,
      connection.zoneAId,
      connection.zoneBId,
      events,
      signalSeries,
      config,
      stateIntervals,
    );
    const reverse = directedEvidence(
      connection,
      connection.zoneBId,
      connection.zoneAId,
      events,
      signalSeries,
      config,
      stateIntervals,
    );
    const expected = Math.max(1, prepared.resampled.expectedBucketCount);
    const leftCoverage = (prepared.zoneSeries.get(connection.zoneAId)?.length ?? 0) / expected;
    const rightCoverage = (prepared.zoneSeries.get(connection.zoneBId)?.length ?? 0) / expected;
    return {
      connection,
      forward,
      reverse,
      endpointCoverage: clamp(Math.min(leftCoverage, rightCoverage)),
    };
  });
  const explainedBucketsByZone = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const match of [...edge.forward.matches, ...edge.reverse.matches]) {
      if (match.evidenceScore < config.displayEvidenceThreshold) continue;
      const event = events.find((candidate) => candidate.id === match.targetEventId);
      if (event === undefined) continue;
      const set = explainedBucketsByZone.get(match.toZoneId) ?? new Set<string>();
      for (let index = Math.max(0, event.startIndex - 1); index <= event.endIndex + 2; index += 1) {
        const bucket = buckets[index];
        if (bucket !== undefined) set.add(bucket);
      }
      explainedBucketsByZone.set(match.toZoneId, set);
    }
  }
  return { prepared, buckets, events, edges, explainedBucketsByZone };
}
