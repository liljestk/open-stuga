import { randomBytes, randomUUID } from "node:crypto";

import request from "supertest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { ClimateDatabase } from "../src/db.js";

import {
  encodeTrackingAdvertisement,
  trackingEpochCounter,
  TRACKING_FLAGS,
} from "../src/tracking/protocol.js";

import { TrackingSecretBox } from "../src/tracking/crypto.js";

import { TrackingStore } from "../src/tracking/store.js";
