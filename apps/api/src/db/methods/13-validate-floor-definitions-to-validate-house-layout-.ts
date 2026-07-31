import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { roomPolygonSelfIntersects } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  validateFloorDefinitions(floors: Floor[]): void {
      if (!Array.isArray(floors)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOORS", "floors must be an array");
      }
      const ids = new Set<string>();
      const tapoOpeningBindings = new Set<string>();
      for (const floor of floors) {
        if (!floor || typeof floor.id !== "string" || floor.id.trim() === "") {
          throw new ClimateDataValidationError(400, "INVALID_FLOOR", "Every floor must have a non-empty id");
        }
        if (ids.has(floor.id)) {
          throw new ClimateDataValidationError(400, "DUPLICATE_FLOOR", `Floor id ${floor.id} is duplicated`);
        }
        ids.add(floor.id);
        if (!Number.isFinite(floor.width) || floor.width <= 0 || !Number.isFinite(floor.height) || floor.height <= 0) {
          throw new ClimateDataValidationError(400, "INVALID_FLOOR_EXTENT", `Floor ${floor.id} width and height must be positive finite numbers`);
        }
        if (floor.metersPerPlanUnit !== undefined
          && (!Number.isFinite(floor.metersPerPlanUnit) || floor.metersPerPlanUnit <= 0 || floor.metersPerPlanUnit > 10_000)) {
          throw new ClimateDataValidationError(400, "INVALID_FLOOR_SCALE", `Floor ${floor.id} metersPerPlanUnit must be a positive finite number no greater than 10000`);
        }
        if (!Number.isFinite(floor.elevation)) {
          throw new ClimateDataValidationError(400, "INVALID_FLOOR_ELEVATION", `Floor ${floor.id} elevation must be finite`);
        }
        if (floor.type !== undefined && !["basement", "ground", "upper", "attic", "mezzanine", "outdoor"].includes(floor.type)) {
          throw new ClimateDataValidationError(400, "INVALID_FLOOR_TYPE", `Floor ${floor.id} has an unsupported type`);
        }
        if (floor.ceilingHeight !== undefined && (!Number.isFinite(floor.ceilingHeight) || floor.ceilingHeight <= 0)) {
          throw new ClimateDataValidationError(400, "INVALID_CEILING_HEIGHT", `Floor ${floor.id} ceilingHeight must be a positive finite number`);
        }
        if (floor.wallHeight !== undefined && (!Number.isFinite(floor.wallHeight) || floor.wallHeight <= 0 || floor.wallHeight > 20)) {
          throw new ClimateDataValidationError(400, "INVALID_WALL_HEIGHT", `Floor ${floor.id} wallHeight must be a positive finite number no greater than 20 metres`);
        }
        if (floor.roof !== undefined) {
          const roof = floor.roof;
          if (!roof || !["gable", "hip", "shed", "flat"].includes(roof.style)) {
            throw new ClimateDataValidationError(400, "INVALID_ROOF_STYLE", `Floor ${floor.id} has an unsupported roof style`);
          }
          if (!Number.isFinite(roof.pitchDegrees) || roof.pitchDegrees < 0 || roof.pitchDegrees > 75
            || (roof.style !== "flat" && roof.pitchDegrees <= 0) || (roof.style === "flat" && roof.pitchDegrees !== 0)) {
            throw new ClimateDataValidationError(400, "INVALID_ROOF_PITCH", `Floor ${floor.id} roof pitch must match its style and be from 0 to 75 degrees`);
          }
          if (!["x", "y"].includes(roof.ridgeAxis)) {
            throw new ClimateDataValidationError(400, "INVALID_ROOF_RIDGE_AXIS", `Floor ${floor.id} roof ridgeAxis must be x or y`);
          }
          if (!Number.isFinite(roof.overhang) || roof.overhang < 0 || !Number.isFinite(roof.eavesHeight) || roof.eavesHeight < 0) {
            throw new ClimateDataValidationError(400, "INVALID_ROOF_DIMENSIONS", `Floor ${floor.id} roof overhang and eavesHeight must be non-negative finite numbers`);
          }
        }
        const pointIsValid = (point: { x: number; y: number } | null | undefined) => Boolean(
          point && Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x >= 0 && point.x <= floor.width && point.y >= 0 && point.y <= floor.height,
        );
        if (!Array.isArray(floor.walls)) {
          throw new ClimateDataValidationError(400, "INVALID_WALLS", `Floor ${floor.id} walls must be an array`);
        }
        const wallsById = new Map<string, Wall>();
        for (const wall of floor.walls) {
          if (!wall || typeof wall.id !== "string" || wall.id.trim() === "" || wallsById.has(wall.id)) {
            throw new ClimateDataValidationError(400, "INVALID_WALL_ID", `Floor ${floor.id} walls must have unique non-empty ids`);
          }
          if (!pointIsValid(wall.from) || !pointIsValid(wall.to)
            || (Math.abs(wall.from.x - wall.to.x) < 1e-10 && Math.abs(wall.from.y - wall.to.y) < 1e-10)) {
            throw new ClimateDataValidationError(400, "INVALID_WALL_GEOMETRY", `Floor ${floor.id} walls must have distinct in-bounds endpoints`);
          }
          wallsById.set(wall.id, wall);
        }
        if (!Array.isArray(floor.rooms)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOMS", `Floor ${floor.id} rooms must be an array`);
        }
        const roomIds = new Set<string>();
        const roomNames = new Set<string>();
        for (const room of floor.rooms) {
          if (!room || typeof room.id !== "string" || room.id.trim() === "" || roomIds.has(room.id)) {
            throw new ClimateDataValidationError(400, "INVALID_ROOM_ID", `Floor ${floor.id} rooms must have unique non-empty ids`);
          }
          roomIds.add(room.id);
          if (typeof room.name !== "string" || room.name.trim() === "") {
            throw new ClimateDataValidationError(400, "INVALID_ROOM_NAME", `Floor ${floor.id} rooms must have non-empty names`);
          }
          const normalizedRoomName = room.name.trim().normalize("NFKC").toLowerCase();
          if (roomNames.has(normalizedRoomName)) {
            throw new ClimateDataValidationError(400, "DUPLICATE_ROOM_NAME", `Floor ${floor.id} room names must be unique, ignoring case`);
          }
          roomNames.add(normalizedRoomName);
          if (!Array.isArray(room.points) || room.points.length < 3 || !room.points.every(pointIsValid)) {
            throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons need at least three in-bounds points`);
          }
          const distinctPoints = new Set(room.points.map((point) => `${point.x}:${point.y}`));
          const doubledArea = Math.abs(room.points.reduce((area, point, index) => {
            const next = room.points[(index + 1) % room.points.length]!;
            return area + point.x * next.y - next.x * point.y;
          }, 0));
          if (distinctPoints.size !== room.points.length || doubledArea < 1e-10) {
            throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons must use distinct vertices and enclose a non-zero area`);
          }
          if (roomPolygonSelfIntersects(room.points, Math.max(floor.width, floor.height))) {
            throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons cannot self-intersect`);
          }
        }
        if (floor.planElements !== undefined) {
          if (!Array.isArray(floor.planElements)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENTS", `Floor ${floor.id} planElements must be an array`);
          }
          const elementIds = new Set<string>();
          for (const element of floor.planElements) {
            if (!element || typeof element.id !== "string" || element.id.trim() === "" || elementIds.has(element.id)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ID", `Floor ${floor.id} plan elements must have unique non-empty ids`);
            }
            elementIds.add(element.id);
            if (!["door", "window", "fireplace", "vent", "fireEscape"].includes(element.kind)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_KIND", `Floor ${floor.id} has an unsupported plan element kind`);
            }
            if (!element.position || !Number.isFinite(element.position.x) || !Number.isFinite(element.position.y)
              || element.position.x < 0 || element.position.x > floor.width || element.position.y < 0 || element.position.y > floor.height) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_POSITION", `Floor ${floor.id} plan element positions must be within its extent`);
            }
            if (!Number.isFinite(element.rotationDegrees) || element.rotationDegrees < 0 || element.rotationDegrees >= 360) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ROTATION", `Floor ${floor.id} plan element rotations must be from 0 (inclusive) to 360 (exclusive)`);
            }
            if (element.width !== undefined && (!Number.isFinite(element.width) || element.width <= 0)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WIDTH", `Floor ${floor.id} plan element widths must be positive finite numbers`);
            }
            if (element.height !== undefined && (!Number.isFinite(element.height) || element.height <= 0)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_HEIGHT", `Floor ${floor.id} plan element heights must be positive finite numbers`);
            }
            if (element.label !== undefined && (typeof element.label !== "string" || element.label.trim().length === 0 || element.label.length > 120)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_LABEL", `Floor ${floor.id} plan element labels must contain 1 to 120 characters`);
            }
            const isOpening = element.kind === "door" || element.kind === "window";
            const isAirflowElement = isOpening || element.kind === "vent";
            const isFireEscape = element.kind === "fireEscape";
            const isWallAttached = isOpening || isFireEscape;
            const state = "state" in element ? element.state : undefined;
            const openFraction = "openFraction" in element ? element.openFraction : undefined;
            const bottomOffsetM = "bottomOffsetM" in element ? element.bottomOffsetM : undefined;
            const stateBinding = "stateBinding" in element ? element.stateBinding : undefined;
            const variant = "variant" in element ? element.variant : undefined;
            const nominalFlowM3h = "nominalFlowM3h" in element ? element.nominalFlowM3h : undefined;
            if (state !== undefined && (!isAirflowElement || !["open", "closed"].includes(state))) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `Floor ${floor.id} opening state must be open or closed`);
            }
            if (openFraction !== undefined && (!isAirflowElement || !Number.isFinite(openFraction) || openFraction < 0 || openFraction > 1)) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_FRACTION", `Floor ${floor.id} opening fractions must be from 0 to 1`);
            }
            if (bottomOffsetM !== undefined && ((!isAirflowElement && !isFireEscape) || !Number.isFinite(bottomOffsetM) || bottomOffsetM < 0 || bottomOffsetM > (floor.ceilingHeight ?? 2.8))) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_BOTTOM_OFFSET", `Floor ${floor.id} opening bottom offsets must fit within the level height`);
            }
            if (bottomOffsetM !== undefined && element.height !== undefined && bottomOffsetM + element.height > (floor.ceilingHeight ?? 2.8) + 1e-9) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_VERTICAL_EXTENT", `Floor ${floor.id} opening height and bottom offset must fit within the level height`);
            }
            if (stateBinding !== undefined) {
              if (!isAirflowElement || !stateBinding || typeof stateBinding !== "object"
                || !["home-assistant", "tapo"].includes(stateBinding.provider)
                || typeof stateBinding.externalId !== "string" || stateBinding.externalId.trim().length === 0 || stateBinding.externalId.length > 255
                || stateBinding.externalId !== stateBinding.externalId.trim()
                || (stateBinding.connectionId !== undefined && (typeof stateBinding.connectionId !== "string" || stateBinding.connectionId.trim().length === 0 || stateBinding.connectionId.length > 255
                  || stateBinding.connectionId !== stateBinding.connectionId.trim()))
                || (stateBinding.invert !== undefined && typeof stateBinding.invert !== "boolean")
                || (stateBinding.staleAfterSeconds !== undefined && (!Number.isFinite(stateBinding.staleAfterSeconds) || stateBinding.staleAfterSeconds < 1 || stateBinding.staleAfterSeconds > 2_592_000))) {
                throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_BINDING", `Floor ${floor.id} opening state bindings require a supported provider and external id`);
              }
            }
            const validVariants = element.kind === "door"
              ? ["interior", "exterior", "sliding", "double", "open-passage"]
              : element.kind === "window"
                ? ["fixed", "casement", "tilt-turn", "sliding"]
                : element.kind === "vent"
                  ? ["passive", "supply", "extract", "balanced", "transfer"]
                  : element.kind === "fireEscape"
                    ? ["ladder", "stairs"]
                    : [];
            if (variant !== undefined && !validVariants.includes(variant)) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_VARIANT", `Floor ${floor.id} plan element variant is not supported for ${element.kind}`);
            }
            if (isAirflowElement) {
              const fixedState = fixedPlanElementOpeningState(element);
              if (fixedState && state !== undefined && state !== fixedState) {
                throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `Floor ${floor.id} ${element.variant} opening state must remain ${fixedState}`);
              }
              if (fixedState && stateBinding !== undefined) {
                throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_BINDING", `Floor ${floor.id} ${element.variant} openings cannot use a contact-state binding`);
              }
            }
            if (stateBinding?.provider === "tapo") {
              const bindingKey = `${stateBinding.connectionId ?? ""}\u0000${stateBinding.externalId}`;
              if (tapoOpeningBindings.has(bindingKey)) {
                throw new ClimateDataValidationError(
                  409,
                  "DUPLICATE_TAPO_OPENING_BINDING",
                  "A Tapo contact sensor can be attached to only one opening in a Home",
                );
              }
              tapoOpeningBindings.add(bindingKey);
            }
            if (nominalFlowM3h !== undefined && (element.kind !== "vent" || !Number.isFinite(nominalFlowM3h) || nominalFlowM3h < 0 || nominalFlowM3h > 100_000)) {
              throw new ClimateDataValidationError(400, "INVALID_VENT_FLOW", `Floor ${floor.id} vent design flow must be from 0 to 100000 cubic metres per hour`);
            }
            const verticalExtent = "verticalExtent" in element ? element.verticalExtent : undefined;
            const chimneyHeightAboveRoof = "chimneyHeightAboveRoof" in element ? element.chimneyHeightAboveRoof : undefined;
            const chimneyWidth = "chimneyWidth" in element ? element.chimneyWidth : undefined;
            const chimneyDepth = "chimneyDepth" in element ? element.chimneyDepth : undefined;
            const projection = "projection" in element ? element.projection : undefined;
            if (verticalExtent !== undefined && (element.kind !== "fireplace" || !["level", "roof"].includes(verticalExtent))) {
              throw new ClimateDataValidationError(400, "INVALID_FIREPLACE_VERTICAL_EXTENT", `Floor ${floor.id} verticalExtent is only supported for fireplaces`);
            }
            if (chimneyHeightAboveRoof !== undefined && (element.kind !== "fireplace" || !Number.isFinite(chimneyHeightAboveRoof) || chimneyHeightAboveRoof < 0 || chimneyHeightAboveRoof > 5)) {
              throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_HEIGHT", `Floor ${floor.id} chimneyHeightAboveRoof must be from 0 to 5 metres and is only supported for fireplaces`);
            }
            if (chimneyHeightAboveRoof !== undefined && verticalExtent !== "roof") {
              throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_HEIGHT", `Floor ${floor.id} chimneyHeightAboveRoof requires a roof-reaching fireplace`);
            }
            for (const [name, value] of [["chimneyWidth", chimneyWidth], ["chimneyDepth", chimneyDepth]] as const) {
              if (value !== undefined && (element.kind !== "fireplace" || verticalExtent !== "roof" || !Number.isFinite(value) || value <= 0 || value > Math.max(floor.width, floor.height))) {
                throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_DIMENSION", `Floor ${floor.id} ${name} must be positive, fit within the floor extent, and belong to a roof-reaching fireplace`);
              }
            }
            if (projection !== undefined && (!isFireEscape || !Number.isFinite(projection) || projection <= 0 || projection > Math.max(floor.width, floor.height))) {
              throw new ClimateDataValidationError(400, "INVALID_FIRE_ESCAPE_PROJECTION", `Floor ${floor.id} fire escape projection must be positive and fit within the floor extent`);
            }
            if (isWallAttached && (typeof element.wallId !== "string" || !wallsById.has(element.wallId))) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} doors, windows, and fire escapes must reference an existing wall`);
            }
            if (!isWallAttached && element.wallId !== undefined) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} fireplaces and vents cannot be wall-attached`);
            }
            if (isWallAttached) {
              const wall = wallsById.get(element.wallId!);
              if (!wall) continue;
              const dx = wall.to.x - wall.from.x;
              const dy = wall.to.y - wall.from.y;
              const lengthSquared = dx * dx + dy * dy;
              const progress = Math.max(0, Math.min(1, ((element.position.x - wall.from.x) * dx + (element.position.y - wall.from.y) * dy) / lengthSquared));
              const projectedX = wall.from.x + progress * dx;
              const projectedY = wall.from.y + progress * dy;
              const tolerance = Math.max(floor.width, floor.height, 1) * 1e-7;
              const wallAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
              const rotationDelta = ((element.rotationDegrees - wallAngle) % 180 + 180) % 180;
              if (Math.hypot(element.position.x - projectedX, element.position.y - projectedY) > tolerance
                || Math.min(rotationDelta, 180 - rotationDelta) > 1e-6) {
                throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ALIGNMENT", `Floor ${floor.id} doors, windows, and fire escapes must lie on and align with their wall`);
              }
              if (element.width !== undefined) {
                const wallLength = Math.sqrt(lengthSquared);
                const halfWidth = element.width / 2;
                const distanceFromStart = progress * wallLength;
                const distanceFromEnd = wallLength - distanceFromStart;
                if (element.width > wallLength + tolerance
                  || distanceFromStart + tolerance < halfWidth
                  || distanceFromEnd + tolerance < halfWidth) {
                  throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_FIT", `Floor ${floor.id} door, window, and fire escape widths must fit fully within their wall`);
                }
              }
            }
          }
        }
      }
    },
  validateHouseLocation(location: HouseLocation): void {
      if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
        throw new ClimateDataValidationError(422, "INVALID_LATITUDE", "House latitude must be between -90 and 90");
      }
      if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
        throw new ClimateDataValidationError(422, "INVALID_LONGITUDE", "House longitude must be between -180 and 180");
      }
      if (location.label !== undefined && (typeof location.label !== "string" || location.label.trim().length > 200)) {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_LABEL", "House location label must be at most 200 characters");
      }
      if (location.countryCode !== undefined && !/^[A-Z]{2}$/.test(location.countryCode)) {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_COUNTRY", "House location countryCode must be a two-letter uppercase code");
      }
      if (location.source !== undefined && !["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"].includes(location.source)) {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_SOURCE", "House location source is not supported");
      }
      if (location.confidence !== undefined && !["high", "medium", "low"].includes(location.confidence)) {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_CONFIDENCE", "House location confidence is not supported");
      }
      if (location.discoveredAt !== undefined && !Number.isFinite(Date.parse(location.discoveredAt))) {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_DISCOVERED_AT", "House location discoveredAt must be an ISO date-time");
      }
      if (location.userOverridden !== undefined && typeof location.userOverridden !== "boolean") {
        throw new ClimateDataValidationError(422, "INVALID_LOCATION_OVERRIDE", "House location userOverridden must be a boolean");
      }
    },
  validateHouseTimezone(timezone: string): void {
      if (typeof timezone !== "string" || timezone.length > 100) {
        throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
      } catch {
        throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
      }
    },
  validateHouseMapPlacement(mapPlacement: HouseMapPlacement, floors: Floor[]): void {
      if (!Number.isFinite(mapPlacement.latitude) || mapPlacement.latitude < -90 || mapPlacement.latitude > 90) {
        throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LATITUDE", "Map placement latitude must be between -90 and 90");
      }
      if (!Number.isFinite(mapPlacement.longitude) || mapPlacement.longitude < -180 || mapPlacement.longitude > 180) {
        throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LONGITUDE", "Map placement longitude must be between -180 and 180");
      }
      if (!Number.isFinite(mapPlacement.metersPerPlanUnit) || mapPlacement.metersPerPlanUnit <= 0) {
        throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_SCALE", "Map placement metersPerPlanUnit must be a positive finite number");
      }
      if (mapPlacement.footprintFloorId !== undefined) {
        if (typeof mapPlacement.footprintFloorId !== "string" || mapPlacement.footprintFloorId.trim() === "") {
          throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_FLOOR", "Map placement footprintFloorId must be a non-empty floor id");
        }
        if (!floors.some((floor) => floor.id === mapPlacement.footprintFloorId)) {
          throw new ClimateDataValidationError(
            422,
            "MAP_PLACEMENT_FLOOR_NOT_FOUND",
            `Map placement footprint floor ${mapPlacement.footprintFloorId} does not exist in this house`,
          );
        }
      }
    },
  validateHouseOrientation(orientationDegrees: number): void {
      if (!Number.isFinite(orientationDegrees) || orientationDegrees < 0 || orientationDegrees >= 360) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_ORIENTATION",
          "House orientationDegrees must be a finite compass bearing from 0 (inclusive) to 360 (exclusive)",
        );
      }
    },
  validateHouseLayoutForSensors(houseId: string, floors: Floor[]): void {
      const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
      for (const sensor of this.listSensors(houseId)) {
        const floor = floorsById.get(sensor.floorId);
        if (!floor) {
          throw new ClimateDataValidationError(409, "LAYOUT_ORPHANS_SENSOR", `Floor ${sensor.floorId} cannot be removed while sensor ${sensor.id} uses it`);
        }
        if (sensor.x < 0 || sensor.x > floor.width || sensor.y < 0 || sensor.y > floor.height) {
          throw new ClimateDataValidationError(409, "LAYOUT_EXCLUDES_SENSOR", `Floor ${floor.id} extent would exclude sensor ${sensor.id}`);
        }
        if (sensor.roomId !== null && sensor.roomId !== undefined
          && !floor.rooms.some((room) => room.id === sensor.roomId)) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_ORPHANS_SENSOR_ROOM",
            `Room ${sensor.roomId} cannot be removed or moved while sensor ${sensor.id} uses it`,
          );
        }
      }
    },
  validateHouseLayoutForConnectedDevices(houseId: string, floors: Floor[]): void {
      const floorsById = new Map(floors.map((floor) => [
        floor.id,
        { floor, roomIds: new Set(floor.rooms.map((room) => room.id)) },
      ]));
      const placements = this.db.prepare(`SELECT connection_id, floor_id, room_id, x, y
        FROM connected_device_placements WHERE house_id = ? AND floor_id IS NOT NULL
        ORDER BY connection_id`).all(houseId) as unknown as Array<{
          connection_id: string;
          floor_id: string;
          room_id: string | null;
          x: number;
          y: number;
        }>;
      for (const placement of placements) {
        const target = floorsById.get(placement.floor_id);
        if (!target) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_ORPHANS_CONNECTED_DEVICE",
            `Floor ${placement.floor_id} cannot be removed while connected device ${placement.connection_id} uses it`,
          );
        }
        if (placement.x < 0 || placement.x > target.floor.width
          || placement.y < 0 || placement.y > target.floor.height) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_EXCLUDES_CONNECTED_DEVICE",
            `Floor ${placement.floor_id} extent would exclude connected device ${placement.connection_id}`,
          );
        }
        if (placement.room_id && !target.roomIds.has(placement.room_id)) {
          throw new ClimateDataValidationError(
            409,
            "LAYOUT_ORPHANS_CONNECTED_DEVICE_ROOM",
            `Room ${placement.room_id} cannot be removed while connected device ${placement.connection_id} uses it`,
          );
        }
      }
    },
  validateHouseLayoutForMaintenanceTasks(houseId: string, floors: Floor[]): void {
      const floorIds = new Set(floors.map((floor) => floor.id));
      const rows = this.db.prepare(`SELECT id, floor_id FROM maintenance_tasks
        WHERE house_id = ? AND floor_id IS NOT NULL ORDER BY id`).all(houseId) as unknown as Array<{
        id: string;
        floor_id: string;
      }>;
      const orphaned = rows.find((row) => !floorIds.has(row.floor_id));
      if (orphaned) {
        throw new ClimateDataValidationError(
          409,
          "LAYOUT_ORPHANS_MAINTENANCE_TASK",
          `Floor ${orphaned.floor_id} cannot be removed while maintenance task ${orphaned.id} uses it`,
        );
      }
    },
});
