import type { IntegrationStatus } from "@climate-twin/contracts";

function newest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

/**
 * Converts the backwards-compatible workspace aggregate into the status for one
 * Home. When connection arrays are present, aggregate fields must never leak a
 * sibling Home's health into the selected Home.
 */
export function integrationForHouse(value: IntegrationStatus, houseId: string, weatherConfigured?: boolean): IntegrationStatus {
  const homeAssistantConnections = value.homeAssistant.connections?.filter((connection) => connection.houseId === houseId);
  const tpLinkConnections = value.tpLink.connections?.filter((connection) => connection.houseId === houseId);
  const weatherConnections = value.weather.connections?.filter((connection) => connection.houseId === houseId);

  const homeAssistant = homeAssistantConnections === undefined
    ? value.homeAssistant
    : (() => {
      const configured = homeAssistantConnections.filter((connection) => connection.configured);
      return {
        ...value.homeAssistant,
        configured: configured.length > 0,
        connected: configured.some((connection) => connection.connected),
        lastEventAt: newest(homeAssistantConnections.map((connection) => connection.lastEventAt)),
        mappedEntities: homeAssistantConnections.reduce((total, connection) => total + connection.mappedEntities, 0),
        error: homeAssistantConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
        connections: homeAssistantConnections,
      };
    })();

  const tpLink = tpLinkConnections === undefined
    ? value.tpLink
    : (() => {
      const configured = tpLinkConnections.filter((connection) => connection.configured);
      return {
        ...value.tpLink,
        configured: configured.length > 0,
        connected: configured.some((connection) => connection.connected),
        lastPollAt: newest(tpLinkConnections.map((connection) => connection.lastPollAt)),
        mappedDevices: tpLinkConnections.reduce((total, connection) => total + connection.mappedDevices, 0),
        discoveredDevices: tpLinkConnections.reduce((total, connection) => total + connection.discoveredDevices, 0),
        hubModel: tpLinkConnections.length === 1 ? tpLinkConnections[0]!.hubModel : null,
        error: tpLinkConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
        connections: tpLinkConnections,
      };
    })();

  const weather = weatherConnections === undefined
    ? {
        ...value.weather,
        configuredHouses: weatherConfigured ? 1 : 0,
        lastSuccessAt: null,
        error: null,
      }
    : {
        ...value.weather,
        configuredHouses: weatherConnections.filter((connection) => connection.configured).length,
        provider: weatherConnections[0]?.provider ?? value.weather.provider,
        lastSuccessAt: weatherConnections[0]?.lastSuccessAt ?? null,
        error: weatherConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
        connections: weatherConnections,
      };

  return { ...value, homeAssistant, tpLink, weather };
}
