import { createHash, createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import {
  maxTapoHistoryJobSpanMs,
  parseTapoHistoryCsv,
  TAPO_HISTORY_ACCEPTANCE_REVISION,
  TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
  TAPO_HISTORY_CSV_PARSER_VERSION,
  TAPO_TARGET_RECLAIM_GRACE_MS,
  tapoExportRecipient,
  TapoHistoryExportService,
} from "../src/tapo-history-export.js";

export const WORKER_TOKEN = "worker-token-with-at-least-thirty-two-bytes";

export const DEPLOYMENT_FINGERPRINT = "1".repeat(64);

export const DEPLOYMENT_HEADER = { "x-tapo-deployment-fingerprint": DEPLOYMENT_FINGERPRINT };

export const APPROVED_SCHEMA_SIGNATURE = parseTapoHistoryCsv(
  "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,20,45\n",
  { sensorId: "schema-fixture", timeZone: "Europe/Helsinki" },
).schemaSignature;

export const ACCEPTANCE_REVISION = createHash("sha256").update(JSON.stringify({
  acceptanceContract: TAPO_HISTORY_ACCEPTANCE_REVISION,
  apiImplementationSha256: TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
  runtime: {
    node: process.version,
    icu: process.versions.icu ?? null,
    tz: process.versions.tz ?? null,
    cldr: process.versions.cldr ?? null,
    unicode: process.versions.unicode ?? null,
  },
  parser: TAPO_HISTORY_CSV_PARSER_VERSION,
  exportEmail: "owner@gmail.com",
  gmailAccountEmail: "owner@gmail.com",
  gmailClientId: "client-id",
  mailboxCredentialProof: createHmac("sha256", WORKER_TOKEN).update("refresh-token", "utf8").digest("hex"),
})).digest("hex");

export function approveTarget(
  database: ClimateDatabase,
  sensorId: string,
  at = new Date(),
): void {
  const from = new Date(at.getTime() - 2 * 60 * 60_000).toISOString();
  const to = new Date(at.getTime() - 15 * 60_000).toISOString();
  const sensor = database.getSensor(sensorId)!;
  const house = database.getHouse(sensor.houseId)!;
  const canary = database.enqueueTapoHistoryExportJob({
    provider: "appium",
    sensorId,
    expectedDeviceId: sensor.tpLinkDeviceId!,
    deviceName: "Cellar",
    timeZone: house.timezone,
    metric: "temperature",
    expectedRecipient: "owner+canary-fixture@gmail.com",
    rangeStart: from,
    rangeEnd: to,
    intervalMinutes: 15,
    dedupeKey: `canary:test:${randomUUID()}`,
  }, at.toISOString()).job;
  const claim = database.claimNextTapoHistoryExportJob(
    "canary-fixture",
    at.toISOString(),
    new Date(at.getTime() + 5 * 60_000).toISOString(),
    ["appium"],
    at.toISOString(),
    {
      canaryOnly: true,
      deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
      acceptanceRevision: ACCEPTANCE_REVISION,
    },
  )!;
  database.transitionTapoHistoryExportJob(canary.id, {
    status: "waiting-email",
    at: new Date(at.getTime() + 1_000).toISOString(),
    leaseToken: claim.leaseToken,
  });
  const timestamp = new Date(Date.parse(from) + 15 * 60_000).toISOString();
  database.completeTapoHistoryExportJobWithSamples(canary.id, [{
    metric: "temperature", value: 20, canonicalUnit: "\u00b0C", timestamp, sourceIdentity: "canary:temperature",
  }, {
    metric: "humidity", value: 45, canonicalUnit: "%", timestamp, sourceIdentity: "canary:humidity",
  }], {
    mailboxMessageId: `canary-mail-${canary.id}`,
    expectedRecipient: canary.expectedRecipient!,
    expectedSubmittedAt: new Date(at.getTime() + 1_000).toISOString(),
    completedAt: new Date(at.getTime() + 2_000).toISOString(),
    sourceArtifactSha256: "c".repeat(64),
    sourceArtifactBytes: 128,
    parserVersion: "canary-fixture-v1",
    sourceSchemaSignature: APPROVED_SCHEMA_SIGNATURE,
  });
  database.approveTapoHistoryDeploymentFromCanary(
    canary.id,
    ACCEPTANCE_REVISION,
    new Date(at.getTime() + 2_000).toISOString(),
  );
}
