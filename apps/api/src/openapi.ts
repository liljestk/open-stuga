import { combinedOpenApiDocument } from "./openapi/document.js";

// v2 holds the measurement registry, sparse measurements and analytics; everything else is the v1 control plane.
const V2_PATHS = new Set([
  "/measurement-definitions",
  "/measurement-definitions/{id}",
  "/analytics/findings",
  "/analytics/diagnostics",
  "/analytics/opening-activity",
  "/analytics/home-performance",
  "/analytics/thermal-isolation",
  "/analytics/moisture-response",
  "/analytics/calendar-comparison",
  "/monitoring/houses",
  "/monitoring/houses/{houseId}",
  "/analytics/coverage",
  "/analytics/query",
  "/measurements",
  "/measurements/import",
  "/measurements/snapshot",
  "/measurements/history",
  "/houses/{id}/outdoor-temperature/history",
  "/sensors/{id}/measurements",
  "/measurements/events",
  "/measurements/forecast",
]);

function selectPaths(version: "v1" | "v2"): Record<string, unknown> {
  return Object.fromEntries(Object.entries(combinedOpenApiDocument.paths).filter(([path]) =>
    path === "/openapi.json" || (version === "v2" ? V2_PATHS.has(path) : !V2_PATHS.has(path))));
}

export const openApiV1Document = {
  ...combinedOpenApiDocument,
  info: { ...combinedOpenApiDocument.info, version: "1.0.0", description: "Stugu v1 control-plane API: properties, Homes, sensors, integrations, alerts, electricity, sharing and system operations, with the temperature/humidity tuple routes as its compatibility subset." },
  servers: [{ url: "/api/v1", description: "Control-plane API" }],
  paths: selectPaths("v1"),
};

export const openApiV2Document = {
  ...combinedOpenApiDocument,
  info: { ...combinedOpenApiDocument.info, version: "2.0.0", description: "Stugu v2 registry-driven sparse measurements API." },
  servers: [{ url: "/api/v2", description: "Registry-driven measurements API" }],
  paths: selectPaths("v2"),
};
