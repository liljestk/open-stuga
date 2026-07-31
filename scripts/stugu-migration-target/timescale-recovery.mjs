import {
  postgresConfiguration,
  postgresConnection,
  psql,
  run,
  safeIdentifier,
} from "./storage-preflight.mjs";

export const TIMESCALE_RECOVERY_TIMEOUT_MS = 600_000;
export const TIMESCALE_RECOVERY_POLL_MS = 2_000;
export const TELEMETRY_ARCHIVE_RECOVERY_TIMEOUT_MS = 600_000;
export const TIMESCALE_SCHEDULER_GRACE_MS = 10_000;

const FATAL_RECOVERY_ERROR = "STUGU_TIMESCALE_RECOVERY_FATAL";
const SCHEDULER_TIMEOUT_ERROR = "STUGU_TIMESCALE_SCHEDULER_TIMEOUT";

export const TIMESCALE_RECOVERY_STATUS_SQL = `
WITH scheduled_jobs AS (
  SELECT
    jobs.job_id,
    stats.job_status,
    stats.next_start,
    stats.last_run_started_at,
    stats.last_successful_finish,
    stats.last_run_status,
    COALESCE(stats.total_successes, 0)::bigint AS total_successes,
    COALESCE(stats.total_failures, 0)::bigint AS total_failures
  FROM timescaledb_information.jobs AS jobs
  LEFT JOIN timescaledb_information.job_stats AS stats USING (job_id)
  WHERE jobs.scheduled
)
SELECT json_build_object(
  'checkedAt',
  clock_timestamp(),
  'schedulerRunning',
  EXISTS (
    SELECT 1
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = 'TimescaleDB Background Worker Scheduler'
  ),
  'restoringOff',
  current_setting('timescaledb.restoring') = 'off',
  'maxWorkerProcesses',
  current_setting('max_worker_processes')::integer,
  'maxParallelWorkers',
  current_setting('max_parallel_workers')::integer,
  'maxBackgroundWorkers',
  current_setting('timescaledb.max_background_workers')::integer,
  'jobs',
  COALESCE(
    (
      SELECT json_agg(json_build_object(
        'jobId', job_id,
        'jobStatus', job_status,
        'nextStart', next_start,
        'lastRunStartedAt', last_run_started_at,
        'lastSuccessfulFinish', last_successful_finish,
        'lastRunStatus', last_run_status,
        'totalSuccesses', total_successes,
        'totalFailures', total_failures
      ) ORDER BY job_id)
      FROM scheduled_jobs
    ),
    '[]'::json
  )
)::text;
`;

function nullableDate(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`TimescaleDB recovery returned invalid ${label}`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`TimescaleDB recovery returned invalid ${label}`);
  }
  return number;
}

function parseJob(value) {
  if (!value || typeof value !== "object"
    || !Number.isSafeInteger(value.jobId) || value.jobId < 0
    || !["Running", "Scheduled", "Paused", null].includes(value.jobStatus)
    || !["Success", "Failed", null].includes(value.lastRunStatus)) {
    throw new Error("TimescaleDB recovery returned invalid job status");
  }
  const nextStart = ["infinity", "-infinity"].includes(value.nextStart) ? value.nextStart
    : nullableDate(value.nextStart, "next job start");
  return {
    jobId: value.jobId,
    jobStatus: value.jobStatus,
    nextStart,
    lastRunStartedAt: nullableDate(value.lastRunStartedAt, "last job start"),
    lastSuccessfulFinish: nullableDate(value.lastSuccessfulFinish, "last successful finish"),
    lastRunStatus: value.lastRunStatus,
    totalSuccesses: nonNegativeInteger(value.totalSuccesses, "job success count"),
    totalFailures: nonNegativeInteger(value.totalFailures, "job failure count"),
  };
}

export function parseTimescaleRecoveryStatus(output) {
  let value;
  try {
    value = JSON.parse(String(output).trim());
  } catch {
    throw new Error("TimescaleDB recovery returned invalid status JSON");
  }
  if (typeof value?.schedulerRunning !== "boolean"
    || typeof value?.restoringOff !== "boolean"
    || !Array.isArray(value?.jobs)) {
    throw new Error("TimescaleDB recovery returned invalid scheduler status");
  }
  const jobs = value.jobs.map(parseJob);
  if (new Set(jobs.map(({ jobId }) => jobId)).size !== jobs.length) {
    throw new Error("TimescaleDB recovery returned duplicate job ids");
  }
  return {
    checkedAt: nullableDate(value.checkedAt, "check time"),
    schedulerRunning: value.schedulerRunning,
    restoringOff: value.restoringOff,
    maxWorkerProcesses: nonNegativeInteger(value.maxWorkerProcesses, "worker process limit"),
    maxParallelWorkers: nonNegativeInteger(value.maxParallelWorkers, "parallel worker limit"),
    maxBackgroundWorkers: nonNegativeInteger(value.maxBackgroundWorkers, "background worker limit"),
    jobs,
  };
}

export function workerBudgetIsHealthy(status) {
  return status.maxWorkerProcesses
    >= status.maxParallelWorkers + status.maxBackgroundWorkers;
}

export function assertTimescaleWorkerBudget(status) {
  if (!workerBudgetIsHealthy(status)) {
    const error = new Error(
      `TimescaleDB worker budget is inconsistent: max_worker_processes=${status.maxWorkerProcesses}, `
      + `max_parallel_workers=${status.maxParallelWorkers}, `
      + `timescaledb.max_background_workers=${status.maxBackgroundWorkers}`,
    );
    error.code = FATAL_RECOVERY_ERROR;
    throw error;
  }
  return status;
}

function jobWasDue(job, activatedAt) {
  if (job.nextStart === null) return true;
  if (job.nextStart === "infinity" || job.nextStart === "-infinity") return true;
  return Date.parse(job.nextStart) <= Date.parse(activatedAt);
}

export function createTimescaleActivationBaseline(status) {
  if (!status.checkedAt) throw new Error("TimescaleDB activation baseline has no database timestamp");
  return {
    activatedAt: status.checkedAt,
    maxWorkerProcesses: status.maxWorkerProcesses,
    maxParallelWorkers: status.maxParallelWorkers,
    maxBackgroundWorkers: status.maxBackgroundWorkers,
    jobs: status.jobs.map((job) => ({
      jobId: job.jobId,
      due: jobWasDue(job, status.checkedAt),
      totalSuccesses: job.totalSuccesses,
      totalFailures: job.totalFailures,
    })),
  };
}

function validateBaseline(value) {
  const activatedAt = nullableDate(value?.activatedAt, "activation time");
  if (!activatedAt || !Array.isArray(value?.jobs)) {
    throw new Error("TimescaleDB activation baseline is invalid");
  }
  const jobs = value.jobs.map((job) => {
    if (!Number.isSafeInteger(job?.jobId) || job.jobId < 0 || typeof job?.due !== "boolean") {
      throw new Error("TimescaleDB activation baseline has an invalid job");
    }
    return {
      jobId: job.jobId,
      due: job.due,
      totalSuccesses: nonNegativeInteger(job.totalSuccesses, "baseline success count"),
      totalFailures: nonNegativeInteger(job.totalFailures, "baseline failure count"),
    };
  });
  if (new Set(jobs.map(({ jobId }) => jobId)).size !== jobs.length) {
    throw new Error("TimescaleDB activation baseline has duplicate job ids");
  }
  return { activatedAt, jobs };
}

export function evaluateTimescaleRecovery(status, baselineValue) {
  const baseline = validateBaseline(baselineValue);
  const currentJobs = new Map(status.jobs.map((job) => [job.jobId, job]));
  const baselineJobs = new Map(baseline.jobs.map((job) => [job.jobId, job]));
  const failedJobIds = [];
  const pendingDueJobIds = [];
  for (const before of baseline.jobs) {
    const current = currentJobs.get(before.jobId);
    if (!current) {
      if (before.due) pendingDueJobIds.push(before.jobId);
      continue;
    }
    if (current.totalFailures > before.totalFailures
      || (current.lastRunStatus === "Failed"
        && current.lastRunStartedAt !== null
        && Date.parse(current.lastRunStartedAt) >= Date.parse(baseline.activatedAt))) {
      failedJobIds.push(before.jobId);
    }
    if (before.due && !(
      current.totalSuccesses > before.totalSuccesses
      && current.lastSuccessfulFinish !== null
      && Date.parse(current.lastSuccessfulFinish) >= Date.parse(baseline.activatedAt)
    )) {
      pendingDueJobIds.push(before.jobId);
    }
  }
  for (const current of status.jobs) {
    if (baselineJobs.has(current.jobId)) continue;
    if (current.lastRunStatus === "Failed"
      && current.lastRunStartedAt !== null
      && Date.parse(current.lastRunStartedAt) >= Date.parse(baseline.activatedAt)) {
      failedJobIds.push(current.jobId);
    }
  }
  return {
    schedulerRunning: status.schedulerRunning,
    restoringOff: status.restoringOff,
    workerBudgetHealthy: workerBudgetIsHealthy(status),
    scheduledJobCount: status.jobs.length,
    dueJobIds: baseline.jobs.filter(({ due }) => due).map(({ jobId }) => jobId),
    pendingDueJobIds,
    failedJobIds,
    runningJobIds: status.jobs
      .filter(({ jobStatus }) => jobStatus === "Running")
      .map(({ jobId }) => jobId),
  };
}

export function timescaleRecoveryIsHealthy(status) {
  return status.schedulerRunning === true
    && status.restoringOff === true
    && status.workerBudgetHealthy === true
    && status.pendingDueJobIds.length === 0
    && status.failedJobIds.length === 0;
}

export async function readTimescaleRecoveryStatus(
  configuration,
  database,
  { query = run } = {},
) {
  const output = await query("psql", [
    ...postgresConnection(configuration, safeIdentifier(database, "TimescaleDB database")),
    "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-c", TIMESCALE_RECOVERY_STATUS_SQL,
  ], configuration.environment);
  return parseTimescaleRecoveryStatus(output);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recoveryFailureMessage(status, lastError, timeoutMs) {
  if (status) {
    return `TimescaleDB background workers did not recover within ${timeoutMs}ms `
      + `(scheduler=${status.schedulerRunning}, restoringOff=${status.restoringOff}, `
      + `workerBudget=${status.workerBudgetHealthy}, `
      + `pendingJobs=${status.pendingDueJobIds.join(",") || "none"})`;
  }
  return `TimescaleDB background worker status was unavailable for ${timeoutMs}ms`
    + (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "");
}

export async function waitForTimescaleRecovery(
  configuration,
  database,
  {
    baseline,
    timeoutMs = TIMESCALE_RECOVERY_TIMEOUT_MS,
    pollMs = TIMESCALE_RECOVERY_POLL_MS,
    readStatus = readTimescaleRecoveryStatus,
    sleep = delay,
    now = Date.now,
  } = {},
) {
  const activation = validateBaseline(baseline);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new Error("TimescaleDB recovery wait bounds are invalid");
  }
  const deadline = now() + timeoutMs;
  let lastStatus;
  let lastError;
  while (true) {
    try {
      const raw = await readStatus(configuration, database);
      assertTimescaleWorkerBudget(raw);
      lastStatus = evaluateTimescaleRecovery(raw, activation);
      lastError = undefined;
      if (lastStatus.failedJobIds.length > 0) {
        const error = new Error(`TimescaleDB jobs failed after activation: ${lastStatus.failedJobIds.join(",")}`);
        error.code = FATAL_RECOVERY_ERROR;
        throw error;
      }
      if (timescaleRecoveryIsHealthy(lastStatus)) {
        return { ...lastStatus, verifiedAt: new Date(now()).toISOString() };
      }
    } catch (error) {
      if (error?.code === FATAL_RECOVERY_ERROR) throw error;
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(recoveryFailureMessage(lastStatus, lastError, timeoutMs), {
        cause: lastError,
      });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function finishTimescaleRestore(
  configuration,
  database,
  { execute = psql } = {},
) {
  await execute(
    configuration,
    safeIdentifier(database, "TimescaleDB database"),
    "SELECT timescaledb_post_restore();",
  );
}

export async function restartTimescaleBackgroundWorkers(
  configuration,
  database,
  {
    execute = psql,
    readStatus = readTimescaleRecoveryStatus,
  } = {},
) {
  const target = safeIdentifier(database, "TimescaleDB database");
  const status = await readStatus(configuration, target);
  assertTimescaleWorkerBudget(status);
  if (!status.restoringOff) {
    const error = new Error("Refusing to restart TimescaleDB workers while restore mode is enabled");
    error.code = FATAL_RECOVERY_ERROR;
    throw error;
  }
  if (status.schedulerRunning) return { restarted: false, reason: "scheduler-running" };
  const runningJobIds = status.jobs
    .filter(({ jobStatus }) => jobStatus === "Running")
    .map(({ jobId }) => jobId);
  if (runningJobIds.length > 0) {
    const error = new Error(
      `Refusing to restart TimescaleDB workers while jobs are running: ${runningJobIds.join(",")}`,
    );
    error.code = FATAL_RECOVERY_ERROR;
    throw error;
  }
  // This fallback is used only after restore mode has been cleared. Separate
  // connections make the public pre/post pair a genuine scheduler restart.
  await execute(configuration, target, "SELECT timescaledb_pre_restore();");
  await execute(configuration, target, "SELECT timescaledb_post_restore();");
  return { restarted: true };
}

function schedulerTimeout(message, cause) {
  const error = new Error(message, { cause });
  error.code = SCHEDULER_TIMEOUT_ERROR;
  return error;
}

export async function waitForTimescaleScheduler(
  configuration,
  database,
  {
    baseline,
    timeoutMs = TIMESCALE_SCHEDULER_GRACE_MS,
    pollMs = TIMESCALE_RECOVERY_POLL_MS,
    readStatus = readTimescaleRecoveryStatus,
    sleep = delay,
    now = Date.now,
  } = {},
) {
  const activation = validateBaseline(baseline);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new Error("TimescaleDB scheduler wait bounds are invalid");
  }
  const deadline = now() + timeoutMs;
  let lastStatus;
  let lastError;
  while (true) {
    try {
      const raw = await readStatus(configuration, database);
      assertTimescaleWorkerBudget(raw);
      if (!raw.restoringOff) {
        const error = new Error("TimescaleDB restore mode remained enabled after post-restore");
        error.code = FATAL_RECOVERY_ERROR;
        throw error;
      }
      lastStatus = evaluateTimescaleRecovery(raw, activation);
      lastError = undefined;
      if (lastStatus.failedJobIds.length > 0) {
        const error = new Error(`TimescaleDB jobs failed after activation: ${lastStatus.failedJobIds.join(",")}`);
        error.code = FATAL_RECOVERY_ERROR;
        throw error;
      }
      if (raw.schedulerRunning) {
        return {
          ...lastStatus,
          verifiedAt: new Date(now()).toISOString(),
        };
      }
    } catch (error) {
      if (error?.code === FATAL_RECOVERY_ERROR) throw error;
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw schedulerTimeout(
        lastStatus
          ? `TimescaleDB scheduler did not start within ${timeoutMs}ms`
          : `TimescaleDB scheduler status was unavailable for ${timeoutMs}ms`,
        lastError,
      );
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function ensureTimescaleScheduler(
  configuration,
  database,
  {
    baseline,
    wait = waitForTimescaleScheduler,
    restart = restartTimescaleBackgroundWorkers,
    ...waitOptions
  } = {},
) {
  try {
    return {
      ...(await wait(configuration, database, { baseline, ...waitOptions })),
      schedulerRestarted: false,
    };
  } catch (error) {
    if (error?.code !== SCHEDULER_TIMEOUT_ERROR) throw error;
  }
  const restartResult = await restart(configuration, database, {
    readStatus: waitOptions.readStatus ?? readTimescaleRecoveryStatus,
  });
  return {
    ...(await wait(configuration, database, { baseline, ...waitOptions })),
    schedulerRestarted: restartResult?.restarted === true,
  };
}

export async function activateRestoredTimescale(
  configuration,
  database,
  {
    execute = psql,
    readStatus = readTimescaleRecoveryStatus,
    finish = finishTimescaleRestore,
    ensureScheduler = ensureTimescaleScheduler,
    wait = waitForTimescaleRecovery,
    onBaseline = () => {},
  } = {},
) {
  const target = safeIdentifier(database, "TimescaleDB database");
  const initial = await readStatus(configuration, target);
  if (initial.restoringOff) throw new Error("Restored TimescaleDB candidate left restore mode before database swap");
  assertTimescaleWorkerBudget(initial);
  const baseline = createTimescaleActivationBaseline(initial);
  await onBaseline(baseline);
  await finish(configuration, target, { execute });
  await execute(configuration, target, "ANALYZE;");
  await ensureScheduler(configuration, target, { baseline, readStatus });
  return {
    baseline,
    recovery: await wait(configuration, target, { baseline }),
  };
}

function parseArchiveStatus(value) {
  const archive = value?.telemetryArchive;
  if (typeof value?.status !== "string"
    || typeof value?.database !== "string"
    || typeof archive?.enabled !== "boolean"
    || typeof archive?.phase !== "string"
    || typeof archive?.caughtUp !== "boolean"
    || typeof archive?.timescaleAvailable !== "boolean") {
    throw new Error("Stugu API returned invalid telemetry archive health");
  }
  return {
    apiStatus: value.status,
    databaseReady: value.database === "ready",
    enabled: archive.enabled,
    phase: archive.phase,
    caughtUp: archive.caughtUp,
    timescaleAvailable: archive.timescaleAvailable,
    dirtyRows: nonNegativeInteger(archive.dirtyRows, "archive dirty row count"),
    queuedSamples: nonNegativeInteger(archive.queuedSamples, "archive queue length"),
  };
}

export function telemetryArchiveRecoveryIsHealthy(status) {
  return status.apiStatus === "ok"
    && status.databaseReady
    && status.enabled
    && status.phase === "ready"
    && status.caughtUp
    && status.timescaleAvailable
    && status.dirtyRows === 0
    && status.queuedSamples === 0;
}

export async function readTelemetryArchiveRecoveryStatus({
  url = process.env.STUGA_MIGRATION_API_HEALTH_URL ?? "http://api:8787/api/v1/health",
  request = fetch,
} = {}) {
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Stugu API health returned HTTP ${response.status}`);
  return parseArchiveStatus(await response.json());
}

export async function waitForTelemetryArchiveRecovery({
  timeoutMs = TELEMETRY_ARCHIVE_RECOVERY_TIMEOUT_MS,
  pollMs = TIMESCALE_RECOVERY_POLL_MS,
  readStatus = readTelemetryArchiveRecoveryStatus,
  sleep = delay,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new Error("Telemetry archive recovery wait bounds are invalid");
  }
  const deadline = now() + timeoutMs;
  let status;
  let lastError;
  while (true) {
    try {
      status = await readStatus();
      lastError = undefined;
      if (telemetryArchiveRecoveryIsHealthy(status)) {
        return { ...status, verifiedAt: new Date(now()).toISOString() };
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const detail = status
        ? `phase=${status.phase}, caughtUp=${status.caughtUp}, dirtyRows=${status.dirtyRows}, queuedSamples=${status.queuedSamples}`
        : (lastError instanceof Error ? lastError.message : String(lastError));
      throw new Error(`Telemetry archive did not recover within ${timeoutMs}ms (${detail})`, {
        cause: lastError,
      });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function ensurePendingTimescaleRecovery(
  receipt,
  {
    configuration = postgresConfiguration(),
    ensureScheduler = ensureTimescaleScheduler,
    wait = waitForTimescaleRecovery,
    waitForArchive = waitForTelemetryArchiveRecovery,
  } = {},
) {
  const database = safeIdentifier(receipt.targetDatabase, "Migration target database");
  const baseline = validateBaseline(receipt.timescaleRecovery?.activationBaseline);
  await ensureScheduler(configuration, database, { baseline });
  const timescale = await wait(configuration, database, { baseline });
  const telemetryArchive = await waitForArchive();
  return { ...timescale, telemetryArchive };
}
