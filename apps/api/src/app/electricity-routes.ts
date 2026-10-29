import { withResponseSignal } from "./response-signal.js";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, roleCanAccessNonGuestConfiguration } from "@climate-twin/contracts";
import type { HomeElectricityPricePoint, PropertyElectricityConfigInput } from "@climate-twin/contracts";
import {
  ElectricityEndpointPolicyError,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
} from "../electricity/prices.js";
import { HttpError } from "../http-error.js";
import { bodyObject, enumValue, rejectUnknownFields, requiredNumber, requiredString } from "../request-fields.js";
import { dateValue, optionalResourceQuery } from "./support/query-fields.js";
import { propertyText } from "./support/property-fields.js";
import { requestPrincipal } from "./support/local-sessions.js";
import { requireVisibleHouse } from "./support/house-access.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";
import { registerElectricityTariffRoutes } from "./electricity-tariff-routes.js";
import { summaryLatencyOperation } from "../analytics/diagnostics/latency.js";

export type ElectricityRouteContext = Pick<
  ApiRouteRegistrationContext,
  | "app"
  | "prefix"
  | "config"
  | "database"
  | "visibility"
  | "telemetryReader"
  | "electricityPrices"
  | "energyCost"
  | "energySummaries"
  | "energyProjections"
  | "analyticsWorkLimiter"
>;

const MAX_ENERGY_RANGE_MS = 366 * 86_400_000;
const DEFAULT_ENERGY_RANGE_MS = 30 * 86_400_000;

/** Property price configuration and history, plus per-home energy cost and summaries. */
export function registerElectricityRoutes(context: ElectricityRouteContext): () => void {
  const energySummaryCache = context.energySummaries;
  const removeStats = context.analyticsWorkLimiter.registerCache("energy-summary", () => energySummaryCache.stats());
  const projectionCache = context.energyProjections;
  const removeProjectionStats = context.analyticsWorkLimiter.registerCache("energy-projection", () => projectionCache.stats());

  const visibleProperty = (propertyId: string, response: Parameters<ElectricityRouteContext["visibility"]>[0]) => {
    const property = context.database.getProperty(propertyId);
    if (!property || !context.visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
    return property;
  };
  const visibleEnergySensors = (houseId: string, response: Parameters<ElectricityRouteContext["visibility"]>[0]) => {
    const access = context.visibility(response);
    return context.database.listSensors(houseId).filter((sensor) => sensor.enabled && access.sensor(sensor.id));
  };
  registerElectricityTariffRoutes(context, {
    visibleProperty,
    houseSensors: visibleEnergySensors,
    invalidateSummaries: () => energySummaryCache.clear(),
  });

  context.app.get(`${context.prefix}/properties/:id/electricity`, async (request, response) => {
    const propertyId = request.params.id as string;
    visibleProperty(propertyId, response);
    const config = context.database.getPropertyElectricityConfig(propertyId);
    if (!config) throw new HttpError(404, "NOT_FOUND", "Property electricity configuration not found");
    const from = dateValue(request.query.from, new Date(Date.now() - 24 * 60 * 60_000), "from");
    const to = dateValue(request.query.to, new Date(Date.now() + 48 * 60 * 60_000), "to");
    const history = await context.telemetryReader.electricityPriceHistory({
      propertyId,
      from,
      to,
      limit: 100_000,
    });
    response.json({
      config: publicElectricityConfiguration(config, !roleCanAccessNonGuestConfiguration(requestPrincipal(response).role)),
      current: context.database.getCurrentPropertyElectricityPrice(propertyId),
      prices: history.records,
    });
  });
  context.app.put(`${context.prefix}/properties/:id/electricity/config`, (request, response) => {
    const propertyId = request.params.id as string;
    visibleProperty(propertyId, response);
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["provider", "endpointUrl", "enabled", "marginCentsPerKwh", "contractType", "contractName", "retailer", "monthlyFeeEur"]), "Electricity configuration");
    const optionalNumber = (key: "marginCentsPerKwh" | "monthlyFeeEur"): number | null | undefined => (
      body[key] === undefined ? undefined : body[key] === null ? null : requiredNumber(body, key)
    );
    const nullableText = (key: "contractName" | "retailer"): string | null => body[key] === null || body[key] === undefined
      ? null : propertyText(body, key, 200) as string;
    const input: PropertyElectricityConfigInput = {
      provider: enumValue(body.provider, ["porssisahko", "custom"] as const, "provider"),
      endpointUrl: requiredString(body, "endpointUrl"),
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      contractName: nullableText("contractName"),
      retailer: nullableText("retailer"),
    };
    const margin = optionalNumber("marginCentsPerKwh");
    if (margin === null) throw new HttpError(400, "INVALID_FIELD", "marginCentsPerKwh must be a finite number");
    if (margin !== undefined) input.marginCentsPerKwh = margin;
    if (body.contractType !== undefined) {
      input.contractType = enumValue(body.contractType, ["spot", "fixed", "other"] as const, "contractType");
    }
    const monthlyFee = optionalNumber("monthlyFeeEur");
    if (monthlyFee !== undefined) input.monthlyFeeEur = monthlyFee;
    try {
      const endpoint = validateElectricityEndpointUrl(input.endpointUrl, context.config.electricityAllowPrivateEndpoints === true);
      if (input.provider === "porssisahko" && endpoint.toString() !== DEFAULT_ELECTRICITY_PRICE_ENDPOINT) {
        throw new ElectricityEndpointPolicyError("The Porssisahko provider must use its canonical endpoint");
      }
      input.endpointUrl = endpoint.toString();
    } catch (error) {
      if (error instanceof ElectricityEndpointPolicyError) {
        throw new HttpError(400, "INVALID_ELECTRICITY_ENDPOINT", error.message);
      }
      throw error;
    }
    const savedConfig = context.database.updatePropertyElectricityConfig(propertyId, input);
    energySummaryCache.clear();
    response.json({ config: savedConfig });
  });
  context.app.post(`${context.prefix}/properties/:id/electricity/refresh`, async (request, response) => {
    const propertyId = request.params.id as string;
    visibleProperty(propertyId, response);
    try {
      const prices = await context.electricityPrices.refresh(propertyId);
      const savedConfig = context.database.getPropertyElectricityConfig(propertyId);
      response.json({
        config: savedConfig ? publicElectricityConfiguration(savedConfig, !roleCanAccessNonGuestConfiguration(requestPrincipal(response).role)) : null,
        current: context.database.getCurrentPropertyElectricityPrice(propertyId),
        prices,
      });
    } catch (error) {
      throw new HttpError(502, "ELECTRICITY_PRICE_SOURCE_FAILED", error instanceof Error ? error.message : "Electricity price refresh failed");
    }
  });
  context.app.get(`${context.prefix}/houses/:id/electricity-price`, async (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.id as string);
    const propertyPrice = context.database.getCurrentPropertyElectricityPrice(house.propertyId);
    const homePrice = (price: NonNullable<typeof propertyPrice>): HomeElectricityPricePoint => ({
      startAt: price.startAt,
      endAt: price.endAt,
      effectivePriceCentsPerKwh: price.effectivePriceCentsPerKwh,
      effectivePriceEurPerKwh: price.effectivePriceEurPerKwh,
      ...(price.components ? { components: price.components } : {}),
      fetchedAt: price.fetchedAt,
    });
    const current = propertyPrice ? homePrice(propertyPrice) : null;
    const historyRequested = request.query.from !== undefined || request.query.to !== undefined;
    if (!historyRequested) {
      response.json({ current });
      return;
    }
    const from = dateValue(request.query.from, new Date(Date.now() - 24 * 60 * 60_000), "from");
    const to = dateValue(request.query.to, new Date(Date.now() + 48 * 60 * 60_000), "to");
    const history = await context.telemetryReader.electricityPriceHistory({
      propertyId: house.propertyId,
      from,
      to,
      limit: 100_000,
    });
    const prices = history.records.map(homePrice);
    response.json({ current, prices });
  });
  context.app.get(`${context.prefix}/houses/:id/energy-cost`, async (request, response) => {
    const houseId = request.params.id as string;
    const house = requireVisibleHouse(context, response, houseId);
    const sensorId = optionalResourceQuery(request.query.sensorId, "sensorId");
    if (!sensorId) throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    const sensor = context.database.getSensor(sensorId);
    if (!sensor || sensor.houseId !== houseId || !context.visibility(response).sensor(sensorId)) {
      throw new HttpError(404, "NOT_FOUND", "Energy sensor not found");
    }
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - DEFAULT_ENERGY_RANGE_MS), "from");
    const durationMs = Date.parse(to) - Date.parse(from);
    if (durationMs <= 0 || durationMs > MAX_ENERGY_RANGE_MS) {
      throw new HttpError(400, "INVALID_ENERGY_COST_RANGE", "Energy cost range must be greater than zero and at most 366 days");
    }
    response.setHeader("cache-control", "no-store");
    const startedAt = performance.now();
    const cost = await withResponseSignal(response, (signal) => context.analyticsWorkLimiter.run(
      "energy-cost",
      () => context.energyCost.calculate({
        houseId,
        propertyId: house.propertyId,
        sensorId,
        from,
        to,
        signal,
      }),
      signal,
    ));
    response.setHeader("server-timing", `energy-cost;dur=${(performance.now() - startedAt).toFixed(1)}`);
    response.json({ cost });
  });
  context.app.get(`${context.prefix}/houses/:id/energy-summary`, async (request, response) => {
    const houseId = request.params.id as string;
    const house = requireVisibleHouse(context, response, houseId);
    const energySensors = visibleEnergySensors(houseId, response);
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - DEFAULT_ENERGY_RANGE_MS), "from");
    const durationMs = Date.parse(to) - Date.parse(from);
    if (durationMs <= 0 || durationMs > MAX_ENERGY_RANGE_MS) {
      throw new HttpError(400, "INVALID_ENERGY_SUMMARY_RANGE", "Energy summary range must be greater than zero and at most 366 days");
    }
    const startedAt = performance.now();
    const { summary, source } = await withResponseSignal(response, (signal) => energySummaryCache.get({
      houseId,
      propertyId: house.propertyId,
      timeZone: house.timezone,
      sensors: energySensors,
      from,
      to,
      signal,
    }));
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-stugu-cache", source);
    const operation = summaryLatencyOperation(durationMs);
    if (operation) context.database.recordAnalyticsLatency({ houseId, operation, durationMs: performance.now() - startedAt });
    response.setHeader(
      "server-timing",
      `energy-summary;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    response.json({ summary });
  });
  context.app.get(`${context.prefix}/houses/:id/energy-projection`, async (request, response) => {
    const houseId = request.params.id as string;
    const house = requireVisibleHouse(context, response, houseId);
    const sensors = visibleEnergySensors(houseId, response);
    const startedAt = performance.now();
    const projection = await withResponseSignal(response, (signal) => projectionCache.get(house, sensors, signal));
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("server-timing", `energy-projection;dur=${(performance.now() - startedAt).toFixed(1)}`);
    response.json({ projection });
  });
  return () => { removeStats(); removeProjectionStats(); projectionCache.clear(); energySummaryCache.clear(); };
}
