// The API's `caughtUp` flag is instantaneous: during steady streaming every new
// sample clears it until the next one-second live flush, so one read is false
// about half the time. When the first read is not caught up, the remote
// collector re-reads the archive status a few times (`telemetryArchiveFollowUp`).
// Only a lag that lasts through every follow-up read is a sustained lag.

const MAXIMUM_FOLLOW_UP_READS = 8;

function instant(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function followUpReads(health) {
  const reads = health?.telemetryArchiveFollowUp;
  return Array.isArray(reads)
    ? reads.slice(0, MAXIMUM_FOLLOW_UP_READS).filter((read) => read !== null && typeof read === "object")
    : [];
}

/**
 * Summarizes the first archive read and its follow-up reads. `lastSuccessAt`
 * advances only when the archive drains its queue, so a later value proves it
 * caught up between two reads even when neither read saw `caughtUp: true`.
 */
export function observeArchiveLag(health) {
  const archive = health?.telemetryArchive ?? {};
  const reads = followUpReads(health);
  const firstSuccess = instant(archive.lastSuccessAt);
  const caughtUpLater = reads.some((read) => {
    const success = instant(read.lastSuccessAt);
    return read.caughtUp === true || (success !== null && (firstSuccess === null || success > firstSuccess));
  });
  const last = reads.at(-1);
  return {
    sustainedLag: archive.caughtUp === false && !caughtUpLater,
    caughtUpLater: archive.caughtUp === false && caughtUpLater,
    followUpReads: reads.length,
    windowMs: Math.min(30_000, count(last?.elapsedMs) ?? 0),
    firstQueuedSamples: count(archive.queuedSamples),
    lastQueuedSamples: last ? count(last.queuedSamples) : count(archive.queuedSamples),
  };
}

export function describeArchiveLag(archive, observation) {
  const state = `Archive ${archive.phase ?? "unknown"}`;
  const reads = `${observation.followUpReads} follow-up read(s) over ${(observation.windowMs / 1000).toFixed(1)} s`;
  if (observation.caughtUpLater) {
    return `${state}, caught up within ${reads} (${observation.firstQueuedSamples ?? "?"} sample(s) in flight at first read)`;
  }
  if (observation.sustainedLag && observation.followUpReads > 0) {
    return `${state}, not caught up across ${reads} (queued ${observation.firstQueuedSamples ?? "?"} -> ${observation.lastQueuedSamples ?? "?"})`;
  }
  return `${state}, caught up ${archive.caughtUp ?? "unknown"}`;
}
