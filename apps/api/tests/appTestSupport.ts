import { createServer, type Server } from "node:http";

import { generateKeyPairSync } from "node:crypto";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import type { TelemetryEvent } from "@climate-twin/contracts";

import { loadConfig, type AppConfig } from "../src/config.js";

import { createApi, type ApiRuntime } from "../src/app.js";

export const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: true,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: "test-ingest-key",
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
  tpLinkHost: null,
  tpLinkUsername: null,
  tpLinkPassword: null,
  tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000,
  tpLinkPython: "python",
  tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null,
  alertWebhookBearerToken: null,
  corsOrigin: "http://localhost:5173",
};
