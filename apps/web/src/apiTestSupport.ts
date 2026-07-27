import type { House, HouseWeather, ManualObservation, ManualObservationInput, Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  api,
  cancelPendingApiRequests,
  COLLECTION_PAGE_SIZE,
  subscribeToApiAuthorizationChanges,
  subscribeToEvents,
  subscribeToMeasurementEvents,
  subscribeToSpatialLayerEvents,
  subscribeToSystemUpdateEvents,
  subscribeToTrackingEvents,
} from "./api";

import { createDemoState } from "./domain";
