import { once } from "node:events";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { WebSocketServer, type WebSocket } from "ws";

import { createApi, type ApiRuntime } from "../src/app.js";

import type { AppConfig } from "../src/config.js";

import {
  loadEntityMappings,
  normalizeHomeAssistantElectricityMeasurement,
  normalizeHomeAssistantTemperature,
  normalizeHomeAssistantTimestamp,
  testHomeAssistantCredentials,
} from "../src/home-assistant.js";

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for Home Assistant bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
