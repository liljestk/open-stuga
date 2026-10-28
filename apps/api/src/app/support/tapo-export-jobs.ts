import type { TapoHistoryExportJob } from "../../db.js";

export function publicTapoHistoryExportJob(job: TapoHistoryExportJob): Omit<TapoHistoryExportJob,
  "dedupeKey" | "expectedDeviceId" | "rangeStart" | "rangeEnd" | "attempt"
  | "deploymentFingerprint" | "acceptanceRevision" | "expectedSchemaSignature"> {
  const redactRecipient = (value: string | null): string | null => value && job.expectedRecipient
    ? value.replaceAll(job.expectedRecipient, "[redacted export recipient]")
    : value;
  return {
    id: job.id,
    canary: job.canary,
    provider: job.provider,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    timeZone: job.timeZone,
    metric: job.metric,
    // Correlation aliases and mailbox ids are capabilities, not operator UI data.
    expectedRecipient: null,
    from: job.from,
    to: job.to,
    intervalMinutes: job.intervalMinutes,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    submittedAt: job.submittedAt,
    mailboxMessageId: null,
    sourceArtifactSha256: job.sourceArtifactSha256,
    sourceArtifactBytes: job.sourceArtifactBytes,
    parserVersion: job.parserVersion,
    sourceSchemaSignature: job.sourceSchemaSignature,
    stagedSampleCount: job.stagedSampleCount,
    consumedSampleCount: job.consumedSampleCount,
    lastError: redactRecipient(job.lastError),
    attentionReason: redactRecipient(job.attentionReason),
    detail: redactRecipient(job.detail),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export function workerTapoHistoryExportJob(job: TapoHistoryExportJob): Pick<TapoHistoryExportJob,
  "id" | "sensorId" | "deviceId" | "deviceName" | "metric" | "from" | "to" | "timeZone"
  | "intervalMinutes" | "expectedRecipient" | "status" | "attemptCount" | "leaseExpiresAt"> {
  return {
    id: job.id,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    metric: job.metric,
    from: job.from,
    to: job.to,
    timeZone: job.timeZone,
    intervalMinutes: job.intervalMinutes,
    expectedRecipient: job.expectedRecipient,
    status: job.status,
    attemptCount: job.attemptCount,
    leaseExpiresAt: job.leaseExpiresAt,
  };
}
