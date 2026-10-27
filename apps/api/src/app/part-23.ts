import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import {
  updateIntegrationSecrets,
} from "../integration-secrets.js";
import { HttpError, bodyObject, credentialString, homeAssistantUrl, networkHost, requestPrincipal, requiredString } from "./support/index.js";
import { configureApiPart22 } from "./part-22.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart23(context: ReturnType<typeof configureApiPart22>) {
  const config = context.config as NormalizedApiConfig;
  context.app.post(`${context.prefix}/integrations/tp-link/test-draft`, async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const body = bodyObject(request.body);
      const host = networkHost(credentialString(body, "host", 253, true));
      const username = credentialString(body, "username", 320, true);
      const password = credentialString(body, "password", 4_096);
      response.json(await context.tpLinkCredentialTester(host, username, password));
    });
  context.app.put(`${context.prefix}/integrations/home-assistant/config`, async (request, response) => {
      const body = bodyObject(request.body);
      const houseId = body.houseId === undefined
        ? context.database.listHouses().find(hasLocalHouseAuthority)?.id
        : requiredString(body, "houseId");
      if (!houseId || !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const generation = (context.homeAssistantConfigurationGenerations.get(houseId) ?? 0) + 1;
      context.homeAssistantConfigurationGenerations.set(houseId, generation);
      const url = homeAssistantUrl(credentialString(body, "url", 2_048, true));
      const token = credentialString(body, "token", 8_192);
      const validation = await context.homeAssistantCredentialTester(url, token);
      if (!validation.ok || !validation.connected) {
        throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
      }
      if (generation !== context.homeAssistantConfigurationGenerations.get(houseId)) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Home Assistant configuration superseded this request");
      }
      const existingConnections = config.homeAssistantConnections ?? [];
      const replacingLegacy = existingConnections.length === 0 && !config.homeAssistantLegacyDisabled
        && Boolean(config.haUrl && config.haToken);
      const rotatingCredentials = replacingLegacy || existingConnections.some((connection) => connection.houseId === houseId);
      const connections = [...existingConnections.filter((connection) => connection.houseId !== houseId), { houseId, url, token }];
      updateIntegrationSecrets(config.integrationSecretsFile, {
        homeAssistant: null,
        homeAssistantConnections: connections,
        ...(replacingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
      });
      if (replacingLegacy) context.integrationMetadata.retireHomeAssistant(houseId, true);
      context.integrationMetadata.saveHomeAssistant({ houseId, url });
      config.homeAssistantConnections = connections;
      if (replacingLegacy) config.homeAssistantLegacyDisabled = true;
      context.status.value.homeAssistant.configured = true;
      context.status.value.homeAssistant.error = null;
      context.status.value.homeAssistant.connections = [
        ...(context.status.value.homeAssistant.connections ?? []).filter((connection) => connection.houseId !== houseId),
        { houseId, configured: true, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
      ];
      const wasRealMode = context.dataMode.isRealMode;
      context.dataMode.activate();
      if (wasRealMode) context.status.changed();
      if (context.options.startBackground) context.homeAssistant.restart();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: rotatingCredentials ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `home-assistant:${houseId}`,
        details: { integration: "home-assistant", houseId },
      });
      response.json({ ok: true, configured: true, houseId, integration: structuredClone(context.status.value) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
