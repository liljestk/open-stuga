import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import request from "supertest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

export const polygon = [
  { latitude: 60.17, longitude: 24.93 },
  { latitude: 60.17, longitude: 24.94 },
  { latitude: 60.18, longitude: 24.94 },
  { latitude: 60.18, longitude: 24.93 },
];

export async function createMainHouse(runtime: ApiRuntime): Promise<void> {
  await request(runtime.app).post("/api/v1/houses").send({
    id: "house-main",
    propertyId: "property-main",
    name: "Main home",
    timezone: "Europe/Helsinki",
    floors: [{ id: "floor-ground", name: "Ground", width: 10, height: 8, elevation: 0, walls: [], rooms: [] }],
  }).expect(201);
}
