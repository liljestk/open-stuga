import type {
  EquipmentLocationEstimate,
  TrackingGatewayRollupInput,
  TrackingObservation,
  TrackingObservationBatchError,
  TrackingObservationInput,
  TrackingObservationQualityFlag,
  TrackingObserver,
} from "@climate-twin/contracts";

export function observationTemporalError(
  input: TrackingObservationInput,
  now: Date,
): TrackingObservationBatchError["code"] | null {
  const observedAt = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAt)
    || observedAt > now.getTime() + 5 * 60_000
    || observedAt < now.getTime() - 24 * 60 * 60_000) return "INVALID_EVIDENCE";
  return null;
}

export function validRollupWindow(input: TrackingGatewayRollupInput, now: Date): boolean {
  const start = Date.parse(input.windowStartedAt);
  const end = Date.parse(input.windowEndedAt);
  return Number.isFinite(start) && Number.isFinite(end)
    && start <= end && end - start <= 15 * 60_000
    && end <= now.getTime() + 5 * 60_000 && end >= now.getTime() - 24 * 60 * 60_000;
}

export function observationQualityFlags(
  input: TrackingObservationInput,
  observer: TrackingObserver,
  now: Date,
): TrackingObservationQualityFlag[] {
  const flags: TrackingObservationQualityFlag[] = [];
  if (Math.abs(now.getTime() - Date.parse(input.observedAt)) > 5 * 60_000) flags.push("CLOCK_SKEW");
  if (observer.trustLevel < 0.4) flags.push("LOW_TRUST");
  if (input.rssi < -115 || input.rssi > 0) flags.push("RSSI_OUTLIER");
  if (input.observerPosition) {
    if (input.observerPosition.horizontalAccuracyMeters > 250) flags.push("LOCATION_LOW_ACCURACY");
    if (Math.abs(Date.parse(input.observedAt) - Date.parse(input.observerPosition.capturedAt)) > 120_000) {
      flags.push("LOCATION_STALE");
    }
  } else if (observer.type === "ios-phone" || observer.type === "android-phone") {
    flags.push("LOCATION_UNAVAILABLE");
  }
  return flags;
}

export function observationTrust(
  observer: TrackingObserver,
  flags: TrackingObservationQualityFlag[],
): number {
  let trust = observer.trustLevel;
  if (flags.includes("LOCATION_LOW_ACCURACY")) trust *= 0.7;
  if (flags.includes("LOCATION_STALE")) trust *= 0.6;
  if (flags.includes("CLOCK_SKEW")) trust *= 0.75;
  if (flags.includes("RSSI_OUTLIER")) trust *= 0.5;
  return Math.max(0, Math.min(1, trust));
}

export function sameLocationEstimate(
  previous: EquipmentLocationEstimate,
  next: Omit<EquipmentLocationEstimate, "id" | "version">,
): boolean {
  return previous.kind === next.kind
    && JSON.stringify(previous.coordinate) === JSON.stringify(next.coordinate)
    && previous.zoneId === next.zoneId
    && previous.freshness === next.freshness
    && previous.movementState === next.movementState
    && previous.lastObservedAt === next.lastObservedAt
    && previous.provenance.observationIds.join() === next.provenance.observationIds.join()
    && previous.provenance.rollupIds.join() === next.provenance.rollupIds.join();
}
