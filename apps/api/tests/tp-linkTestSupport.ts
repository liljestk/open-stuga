import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import type { AppConfig } from "../src/config.js";

import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

import { ipv4BroadcastAddress, loadTpLinkDeviceMappings, normalizeTpLinkTemperature } from "../src/tp-link.js";

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for direct TP-Link bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
