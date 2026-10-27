import {
  outdoorLocationKey,
} from "../db.js";
import {
  FmiWeatherProvider,
  WeatherService,
} from "../weather.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../open-meteo.js";
import { WeatherMonitor } from "../weather-monitor.js";
import { WeatherRecoveryCoordinator } from "../weather-recovery.js";
import {
  InMemoryWeatherEventBroker,
} from "../weather-events.js";
import {
  ElectricityPriceService,
} from "../electricity-prices.js";
import { persistWeatherObservation } from "./support/index.js";
import type { IntegrationBridges } from "./integration-bridges.js";
/** Outside data the API pulls in: weather forecasts and history, electricity prices and location lookup. */
export function createExternalFeedServices(context: IntegrationBridges) {
  const config = context.config;
  const electricityPrices = new ElectricityPriceService(
      context.database,
      context.options.electricityPriceFetcher ?? fetch,
      undefined,
      {
        allowPrivateNetwork: config.electricityAllowPrivateEndpoints,
        ...(context.options.electricityEndpointResolver ? { resolver: context.options.electricityEndpointResolver } : {}),
      },
      () => context.telemetryArchive?.reconcileNow(),
    );
  const locationDiscovery = context.options.locationDiscovery ?? new LocationDiscoveryService();
  const weatherProvider = context.options.weatherProvider ?? new AutomaticWeatherProvider(
        new FmiWeatherProvider(),
        new OpenMeteoWeatherProvider(),
      );
  const weatherRecovery = new WeatherRecoveryCoordinator(context.database, weatherProvider, {
      telemetryReader: context.telemetryReader,
      onRecovered: () => context.telemetryArchive?.reconcileNow(),
    });
  const weather = new WeatherService(
      weatherProvider,
      context.status.value.weather,
      () => context.status.changed(),
      undefined,
      undefined,
      undefined,
      weatherRecovery,
      context.database,
    );
  const weatherEvents = context.options.weatherEventBroker ?? new InMemoryWeatherEventBroker();
  const removeWeatherProjector = weatherEvents.addProjector((event) => {
      persistWeatherObservation(context.database, event.weather, context.dataMode);
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
    });
  const removeWeatherTelemetryBridge = weatherEvents.subscribe((event) => {
      context.bus.publish({ type: "weather", data: event });
    });
  const weatherMonitor = new WeatherMonitor({
      houses: context.database,
      weather,
      // Polling is an input adapter: providers do not need native push support.
      persist: async (result) => {
        context.database.saveWeatherSnapshot(result, outdoorLocationKey(result.location));
        try {
          await weatherEvents.publish(result, "scheduled-refresh");
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown projection failure";
          console.error(`[weather] Snapshot stored, but live projection failed: ${message}`);
        }
      },
      persistFailure: (house, error, attemptedAt) => {
        if (!house.location) return;
        const message = (error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Weather refresh failed").slice(0, 1000);
        const connection = context.status.value.weather.connections
          ?.find((candidate) => candidate.houseId === house.id);
        const statusChanged = context.status.value.weather.error !== message
          || (connection !== undefined && connection.error !== message);
        context.status.value.weather.error = message;
        if (connection) connection.error = message;
        if (statusChanged) context.status.changed();
        context.database.noteWeatherSnapshotFailure(
          house.id,
          outdoorLocationKey(house.location),
          error,
          attemptedAt,
        );
      },
    });
  return Object.assign(context, { electricityPrices, locationDiscovery, weatherProvider, weatherRecovery, weather, weatherEvents, removeWeatherProjector, removeWeatherTelemetryBridge, weatherMonitor });
}

export type ExternalFeedServices = ReturnType<typeof createExternalFeedServices>;
