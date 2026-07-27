import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import { homeAssistantInstanceFromService } from "../src/discovery.js";

import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for integration state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
