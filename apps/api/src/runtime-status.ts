import { hasLocalHouseAuthority, IntegrationStatus } from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "./config.js";
import { ClimateDatabase, outdoorLocationKey } from "./db.js";
import { TelemetryBus } from "./events.js";

export type WeatherConnectionStatus = NonNullable<IntegrationStatus["weather"]["connections"]>[number];

export class RuntimeStatus {
  readonly value: IntegrationStatus;
  readonly #bus: TelemetryBus;
  readonly #database: ClimateDatabase;

  constructor(config: AppConfig, bus: TelemetryBus, database: ClimateDatabase) {
    this.#bus = bus;
    this.#database = database;
    const webhookDestinations = configuredAlertWebhookDestinations(config);
    const weatherConnections = this.weatherConnections();
    const latestWeatherSuccess = weatherConnections
      .filter((connection) => connection.lastSuccessAt !== null)
      .sort((left, right) => (right.lastSuccessAt as string).localeCompare(left.lastSuccessAt as string))[0];
    this.value = {
      homeAssistant: {
        configured: Boolean((config.homeAssistantConnections?.length ?? 0) > 0
          || (!config.homeAssistantLegacyDisabled && config.haUrl && config.haToken)),
        connected: false,
        lastEventAt: null,
        mappedEntities: 0,
        error: null,
        connections: (config.homeAssistantConnections ?? []).map((connection) => ({
          houseId: connection.houseId,
          configured: true,
          connected: false,
          lastEventAt: null,
          mappedEntities: 0,
          error: null,
        })),
      },
      tpLink: {
        configured: Boolean((config.tpLinkConnections?.length ?? 0) > 0
          || (!config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)),
        connected: false,
        lastPollAt: null,
        mappedDevices: 0,
        discoveredDevices: 0,
        hubModel: null,
        error: null,
        connections: (config.tpLinkConnections ?? []).map((connection) => ({
          id: connection.id, houseId: connection.houseId, configured: true, connected: false,
          lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
          host: connection.host,
          sourceType: connection.sourceType ?? null,
          sourceModel: connection.sourceModel ?? null,
          sourceAlias: connection.sourceAlias ?? null,
        })),
      },
      webhook: {
        configured: webhookDestinations.length > 0,
        lastDeliveryAt: null,
        error: null,
        destinations: webhookDestinations.map((destination) => ({
          id: destination.id,
          lastDeliveryAt: null,
          error: null,
        })),
      },
      telegram: {
        available: true,
        configured: Boolean(config.telegramBotToken && config.telegramChatId),
        connected: false,
        botUsername: null,
        chatLabel: null,
        lastDeliveryAt: null,
        error: null,
      },
      appleNotes: {
        available: true,
        configured: (config.appleNotesGrants ?? []).length > 0,
        grantCount: (config.appleNotesGrants ?? []).length,
        lastSyncAt: null,
        error: null,
      },
      mock: {
        enabled: config.mockEnabled && !database.isRealDataMode(),
        intervalMs: config.mockIntervalMs,
        mode: database.isRealDataMode() ? "real" : "demo",
        activatedAt: database.realDataModeActivatedAt(),
      },
      weather: {
        policy: "automatic",
        availableProviders: ["fmi", "open-meteo"],
        provider: latestWeatherSuccess?.provider ?? "fmi",
        configuredHouses: this.configuredWeatherHouses(),
        lastSuccessAt: latestWeatherSuccess?.lastSuccessAt ?? null,
        error: weatherConnections.find((connection) => connection.error)?.error ?? null,
        connections: weatherConnections,
      },
    };
  }

  changed(): void {
    this.synchronizeWeatherConfiguration();
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  refreshWeatherConfiguration(): void {
    if (!this.synchronizeWeatherConfiguration()) return;
    this.#bus.publish({ type: "integration", data: structuredClone(this.value) });
  }

  refreshDataMode(): void {
    const mode = this.#database.isRealDataMode() ? "real" : "demo";
    const enabled = this.value.mock.enabled && mode === "demo";
    const activatedAt = this.#database.realDataModeActivatedAt();
    if (this.value.mock.mode === mode && this.value.mock.enabled === enabled && this.value.mock.activatedAt === activatedAt) return;
    this.value.mock.mode = mode;
    this.value.mock.enabled = enabled;
    this.value.mock.activatedAt = activatedAt;
    this.changed();
  }

  private configuredWeatherHouses(): number {
    return this.#database.listHouses()
      .filter((house) => hasLocalHouseAuthority(house) && house.location !== undefined)
      .length;
  }

  private weatherConnections(
    existing: WeatherConnectionStatus[] = [],
    fallbackProvider: IntegrationStatus["weather"]["provider"] = "fmi",
  ): WeatherConnectionStatus[] {
    const previous = new Map(existing.map((connection) => [connection.houseId, connection]));
    return this.#database.listHouses().filter(hasLocalHouseAuthority).map((house) => {
      const prior = previous.get(house.id);
      const configured = house.location !== undefined;
      const snapshot = house.location
        ? this.#database.getWeatherSnapshot(house.id, outdoorLocationKey(house.location))
        : null;
      return {
        houseId: house.id,
        configured,
        provider: prior?.provider ?? snapshot?.weather?.provider ?? fallbackProvider,
        lastSuccessAt: configured ? (prior ? prior.lastSuccessAt : snapshot?.lastSuccessAt ?? null) : null,
        error: configured ? (prior ? prior.error : snapshot?.lastError ?? null) : null,
      };
    });
  }

  private synchronizeWeatherConfiguration(): boolean {
    const previousConnections = this.value.weather.connections ?? [];
    const connections = this.weatherConnections(previousConnections, this.value.weather.provider);
    const configuredHouses = connections.filter((connection) => connection.configured).length;
    const changed = configuredHouses !== this.value.weather.configuredHouses
      || JSON.stringify(connections) !== JSON.stringify(previousConnections);
    this.value.weather.configuredHouses = configuredHouses;
    this.value.weather.connections = connections;
    return changed;
  }
}
