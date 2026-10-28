import type { ClimateDatabase } from "../db.js";
import { withResponseSignal } from "./response-signal.js";
import { resolvePlanElementOpeningState, hasLocalHouseAuthority } from "@climate-twin/contracts";
import type { House, HousePatch, OpeningStateObservationInput } from "@climate-twin/contracts";
import { HttpError } from "../http-error.js";
import { bodyObject, requiredNumber, requiredString } from "../request-fields.js";
import { boundedQueryInteger, dateValue, optionalResourceQuery } from "./support/query-fields.js";
import { houseLocationValue, houseMapPlacementValue } from "./support/house-fields.js";
import { refreshAppleNotesStatus } from "./support/apple-notes.js";
import { requireVisibleHouse } from "./support/house-access.js";
import { commitCoordinatedIntegrationSecrets } from "../integration-secrets-coordinator.js";
import type { IntegrationSecrets, IntegrationSecretsPatch } from "../integration-secrets.js";
import type { AppConfig } from "../config.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** House CRUD and opening states. */
export function registerHouseRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.get(`${context.prefix}/houses`, (request, response) => {
      const access = context.visibility(response);
      response.json({
        houses: context.database.listHouses(optionalResourceQuery(request.query.propertyId, "propertyId"))
          .filter((house) => access.house(house.id)),
      });
    });
  context.app.post(`${context.prefix}/houses`, (request, response) => {
      const body = bodyObject(request.body);
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      const floors = context.database.parseFloorDefinitions(body.floors);
      const targetPropertyId = body.propertyId !== undefined ? requiredString(body, "propertyId") : undefined;
      const propertyCandidates = targetPropertyId ? [] : context.database.listProperties(2, 0);
      const inferredPropertyId = targetPropertyId ?? (propertyCandidates.length === 1 ? propertyCandidates[0]!.id : undefined);
      if (inferredPropertyId) context.stuguby.assertPropertyWriteAllowed(inferredPropertyId);
      let house = context.database.createHouse({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(targetPropertyId ? { propertyId: targetPropertyId } : {}),
        name: requiredString(body, "name"),
        timezone: requiredString(body, "timezone"),
        ...(body.location !== undefined ? { location: houseLocationValue(body.location) } : {}),
        ...(body.mapPlacement !== undefined ? { mapPlacement: houseMapPlacementValue(body.mapPlacement) } : {}),
        ...(body.orientationDegrees !== undefined ? { orientationDegrees: requiredNumber(body, "orientationDegrees") } : {}),
        floors,
      });
      house = context.stuguby.markLocalHouseInAdoptedProperty(house.id);
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        house.id,
        house.propertyId,
        new Date().toISOString(),
        "ownership-changed",
      ));
      context.status.refreshWeatherConfiguration();
      response.status(201).json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id`, (request, response) => {
      const house = requireVisibleHouse(context, response, request.params.id as string);
      response.json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id/opening-states`, async (request, response) => {
      const houseId = request.params.id as string;
      const house = requireVisibleHouse(context, response, houseId);
      const historical = request.query.at !== undefined
        || request.query.from !== undefined
        || request.query.to !== undefined;
      if (!historical) {
        const at = new Date().toISOString();
        const observations = context.database.listCurrentOpeningStateCandidates(houseId, at, 10_000);
        const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
          return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
            ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
        }));
        response.setHeader("cache-control", "private, no-store");
        response.json({ snapshot: { houseId, at, states }, observations });
        return;
      }
      const at = request.query.at === undefined && request.query.to !== undefined
        ? dateValue(request.query.to, new Date(), "to")
        : dateValue(request.query.at, new Date(), "at");
      const historyRange = request.query.from === undefined ? null : (() => {
        const from = dateValue(request.query.from, new Date(Date.parse(at) - 7 * 86_400_000), "from");
        const to = dateValue(request.query.to, new Date(at), "to");
        const durationMs = Date.parse(to) - Date.parse(from);
        if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
          throw new HttpError(400, "INVALID_OPENING_HISTORY_RANGE", "Opening-state history must cover more than zero and at most 366 days");
        }
        return { from, to, limit: boundedQueryInteger(request.query.limit, "limit", 1, 10_000) ?? 10_000 };
      })();
      await withResponseSignal(response, async (signal) => {
        const observations = (await context.telemetryReader.openingStateSnapshot({
          houseId,
          at,
          limit: 10_000,
          signal,
          timeoutMs: 5_000,
        })).records;
        const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
          return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
            ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
        }));
        if (!historyRange) {
          response.json({ snapshot: { houseId, at, states }, observations });
          return;
        }
        const { from, to, limit } = historyRange;
        // Seed the requested interval with the effective candidates at its leading
        // edge so clients can distinguish a real closed-to-open transition from a
        // startup heartbeat whose previous state lies just outside the range.
        const initial = (await context.telemetryReader.openingStateSnapshot({
          houseId,
          at: from,
          limit,
          signal,
          timeoutMs: 5_000,
        })).records;
        const history = (await context.telemetryReader.openingStateHistory({
          houseId,
          from,
          to,
          limit: Math.max(1, limit - Math.min(initial.length, limit - 1)),
          signal,
          timeoutMs: 5_000,
        })).records;
        const mergedHistory = [...new Map([...initial, ...history].map((observation) => [observation.id, observation])).values()]
          .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
          .slice(-limit);
        response.json({ snapshot: { houseId, at, states }, observations, history: mergedHistory, from, to });
      });
    });
  context.app.post(`${context.prefix}/houses/:id/opening-states`, (request, response) => {
      const houseId = request.params.id as string;
      requireVisibleHouse(context, response, houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      const body = bodyObject(request.body);
      const source = body.source === undefined ? "api" : requiredString(body, "source");
      if (source !== "api" && source !== "manual") {
        throw new HttpError(400, "INVALID_FIELD", "REST callers may record only api or manual opening-state provenance; Home Assistant and Tapo provenance is adapter-managed");
      }
      const input: OpeningStateObservationInput = {
        ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
        floorId: requiredString(body, "floorId"),
        elementId: requiredString(body, "elementId"),
        state: requiredString(body, "state") as OpeningStateObservationInput["state"],
        ...(body.openFraction !== undefined ? { openFraction: requiredNumber(body, "openFraction") } : {}),
        source,
        observedAt: body.observedAt === undefined ? new Date().toISOString() : requiredString(body, "observedAt"),
        ...(body.validUntil !== undefined ? { validUntil: requiredString(body, "validUntil") } : {}),
        ...(body.externalId !== undefined ? { externalId: requiredString(body, "externalId") } : {}),
      };
      const observation = context.database.recordOpeningStateObservation(houseId, input);
      context.notifyOpeningStateRecorded(observation);
      response.status(201).json({ observation });
    });
  context.app.patch(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      context.stuguby.assertHouseWriteAllowed(houseId);
      const patch = parseHousePatch(bodyObject(request.body), context.database);
      if (previous && patch.propertyId !== undefined && patch.propertyId !== previous.propertyId) {
        assertHousePropertyMoveAllowed(context, previous, patch.propertyId);
      }
      if (patch.floors) context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, patch.floors);
      if (patch.location !== undefined) await context.requireArchivedBeforeCascade("house-location", houseId);
      const house = context.database.transaction(() => {
        const updated = context.database.updateHouse(houseId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(updated.id);
        return updated;
      });
      if (patch.floors !== undefined) context.homeAssistant.refreshMappings();
      if (previous) wakeSpatialAfterHousePatch(context, previous, house, patch);
      context.weather.invalidate(house.id);
      context.weatherEvents.invalidate(house.id);
      context.status.refreshWeatherConfiguration();
      if (patch.location !== undefined && context.options.startBackground) {
        // Configuration changes may request a coalesced background cycle, but
        // never make the foreground mutation wait for upstream weather.
        context.weatherMonitor.requestRun();
      }
      response.json({ house });
    });
  context.app.delete(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      // Revoke every durable share and queue its purge tombstone before the
      // authoritative Home disappears from the local active scope. If this
      // phase fails, the Home stays visible and the request remains retryable.
      context.stuguby.retireLocalHouseShares(houseId);
      const firstLocalHouseId = context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const plan = planHouseIntegrationRetirement(config, houseId, firstLocalHouseId === houseId);
      const deleteHouseRow = (): void => {
        context.integrationMetadata.retireHouse(houseId);
        if (!context.database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      };
      if (plan.connectionsChanged || plan.grantsChanged) {
        commitCoordinatedIntegrationSecrets(config.integrationSecretsFile, context.database, (currentSecrets) => {
          deleteHouseRow();
          return { patch: retiredHouseSecretsPatch(plan, currentSecrets), result: undefined };
        });
      } else {
        context.database.transaction(deleteHouseRow);
      }
      config.homeAssistantConnections = plan.remaining.homeAssistantConnections;
      config.tpLinkConnections = plan.remaining.tpLinkConnections;
      config.greeConnections = plan.remaining.greeConnections;
      config.tuyaConnections = plan.remaining.tuyaConnections;
      config.appleNotesGrants = plan.remaining.appleNotesGrants;
      if (plan.hideLegacyHomeAssistant) config.homeAssistantLegacyDisabled = true;
      if (plan.hideLegacyTpLink) config.tpLinkLegacyDisabled = true;
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "ownership-changed",
        true,
      ));
      context.homeAssistant.refreshMappings();
      if (plan.connectionsChanged && context.options.startBackground) {
        context.homeAssistant.restart();
        context.tpLink.restart();
      }
      if (plan.greeChanged) context.gree.refreshConfiguration();
      if (plan.tuyaChanged) context.tuya.refreshConfiguration();
      context.weather.invalidate(houseId);
      context.weatherEvents.invalidate(houseId);
      if (plan.grantsChanged) refreshAppleNotesStatus(config, context.status);
      context.status.refreshWeatherConfiguration();
      response.status(204).end();
    });
}

function parseHousePatch(body: Record<string, unknown>, database: Pick<ClimateDatabase, "parseFloorDefinitions">): HousePatch {
  if (body.floors !== undefined && !Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
  const floors = body.floors === undefined ? undefined : database.parseFloorDefinitions(body.floors);
  return {
    ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
    ...(body.timezone !== undefined ? { timezone: requiredString(body, "timezone") } : {}),
    ...(body.propertyId !== undefined ? { propertyId: requiredString(body, "propertyId") } : {}),
    ...(body.location !== undefined ? { location: houseLocationValue(body.location, true) } : {}),
    ...(body.mapPlacement !== undefined ? { mapPlacement: houseMapPlacementValue(body.mapPlacement, true) } : {}),
    ...(body.orientationDegrees !== undefined
      ? { orientationDegrees: body.orientationDegrees === null ? null : requiredNumber(body, "orientationDegrees") }
      : {}),
    ...(floors !== undefined ? { floors } : {}),
  };
}

/** A Home may only change Property outside Stuguby sharing and adopted Properties. */
function assertHousePropertyMoveAllowed(context: ApiRouteRegistrationContext, previous: House, targetPropertyId: string): void {
  if (previous.stuguby?.ownership === "shared" && previous.stuguby.syncState !== "detached") {
    throw new HttpError(409, "STUGBY_HOME_PROPERTY_MANAGED", "A shared Home remains in its adopted Stuguby Property until permanent disconnect");
  }
  const linked = (propertyId: string) => {
    const link = context.database.getProperty(propertyId)?.stuguby;
    return Boolean(link && link.syncState !== "detached");
  };
  if (linked(previous.propertyId) || linked(targetPropertyId)) {
    throw new HttpError(
      409,
      "STUGBY_PROPERTY_MIGRATION_REQUIRED",
      "Use the reviewed Stuguby Property migration to move a local Home into or out of an adopted Property",
    );
  }
}

/** Re-runs spatial inference for the scopes a house edit can change. */
function wakeSpatialAfterHousePatch(context: ApiRouteRegistrationContext, previous: House, house: House, patch: HousePatch): void {
  const observedAt = new Date().toISOString();
  if (previous.propertyId !== house.propertyId) {
    context.notifySpatial((runtime) => {
      runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
      runtime.scheduler.wakeHouse(house.id, house.propertyId, observedAt, "ownership-changed");
    });
    return;
  }
  const contextFields: Array<keyof HousePatch> = ["name", "floors", "location", "mapPlacement", "orientationDegrees"];
  if (contextFields.some((field) => patch[field] !== undefined)) {
    context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(house.id, house.propertyId, observedAt, "property-context-changed"));
  }
}

type HouseScoped = { houseId?: string | null };

/** What deleting a house removes from the integration configuration. */
function planHouseIntegrationRetirement(config: AppConfig, houseId: string, isFirstLocalHouse: boolean) {
  const split = <T extends HouseScoped>(items: readonly T[] | undefined) => ({
    removed: (items ?? []).filter((item) => item.houseId === houseId),
    remaining: (items ?? []).filter((item) => item.houseId !== houseId),
  });
  const homeAssistant = split(config.homeAssistantConnections);
  const tpLink = split(config.tpLinkConnections);
  const gree = split(config.greeConnections);
  const tuya = split(config.tuyaConnections);
  const grants = split(config.appleNotesGrants);
  // Legacy single-connection credentials belong to the first local house.
  const hideLegacyHomeAssistant = isFirstLocalHouse && !config.homeAssistantLegacyDisabled
    && Boolean(config.haUrl && config.haToken);
  const hideLegacyTpLink = isFirstLocalHouse && !config.tpLinkLegacyDisabled
    && Boolean(config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword);
  const greeChanged = gree.removed.length > 0;
  const tuyaChanged = tuya.removed.length > 0;
  return {
    houseId,
    hideLegacyHomeAssistant,
    hideLegacyTpLink,
    greeChanged,
    tuyaChanged,
    connectionsChanged: homeAssistant.removed.length > 0 || tpLink.removed.length > 0 || greeChanged || tuyaChanged
      || hideLegacyHomeAssistant || hideLegacyTpLink,
    grantsChanged: grants.removed.length > 0,
    removed: {
      homeAssistantConnections: homeAssistant.removed,
      tpLinkConnections: tpLink.removed,
      greeConnections: gree.removed,
      tuyaConnections: tuya.removed,
      appleNotesGrants: grants.removed,
    },
    remaining: {
      homeAssistantConnections: homeAssistant.remaining,
      tpLinkConnections: tpLink.remaining,
      greeConnections: gree.remaining,
      tuyaConnections: tuya.remaining,
      appleNotesGrants: grants.remaining,
    },
  };
}

/**
 * Secrets update for a deleted house: keep the other houses' connections and
 * park the removed ones (and any hidden legacy credentials) in hiddenHouseData.
 */
function retiredHouseSecretsPatch(
  plan: ReturnType<typeof planHouseIntegrationRetirement>,
  currentSecrets: IntegrationSecrets,
): IntegrationSecretsPatch {
  const legacyHomeAssistant = plan.hideLegacyHomeAssistant && currentSecrets.homeAssistant
    ? { homeAssistant: currentSecrets.homeAssistant }
    : {};
  const legacyTpLink = plan.hideLegacyTpLink && currentSecrets.tpLink ? { tpLink: currentSecrets.tpLink } : {};
  return {
    ...plan.remaining,
    ...(plan.hideLegacyHomeAssistant ? { homeAssistant: null, homeAssistantLegacyDisabled: true } : {}),
    ...(plan.hideLegacyTpLink ? { tpLink: null, tpLinkLegacyDisabled: true } : {}),
    hiddenHouseData: [
      ...(currentSecrets.hiddenHouseData ?? []),
      { houseId: plan.houseId, hiddenAt: new Date().toISOString(), ...legacyHomeAssistant, ...legacyTpLink, ...plan.removed },
    ],
  };
}
