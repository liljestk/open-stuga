import type { Application, Request, Response } from "express";
import type {
  EquipmentBorrowInput,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocationInput,
  TrackingEvent,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
  TrackingTagCapabilities,
  TrackingTagCreateInput,
} from "@climate-twin/contracts";
import { TrackingService, type TrackingIngestionActor } from "../service.js";
import {
  TrackingError,
  type AuthenticatedTrackingObserver,
} from "../store.js";
import { TrackingRouteOptions } from "./01-observer-types-to-request-tag.js";

export function machineIdentity(
  options: TrackingRouteOptions,
  response: Response,
  observerId: string,
): AuthenticatedTrackingObserver {
  const identity = options.machineObserver(response);
  if (!identity || identity.observer.id !== observerId) {
    throw new TrackingError(401, "UNAUTHORIZED", "A valid observer credential is required");
  }
  return identity;
}

export function numericLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  return number;
}

export function ingestionActor(options: TrackingRouteOptions, response: Response): TrackingIngestionActor {
  const machineObserver = options.machineObserver(response);
  const principal = options.principal(response);
  return {
    machineObserver,
    userId: principal?.userId ?? null,
    administrator: principal?.role === "owner" || principal?.role === "admin",
    canWriteProperty: (propertyId) => Boolean(
      principal
      && principal.role !== "guest"
      && options.authorizeProperty(response, propertyId),
    ),
  };
}
