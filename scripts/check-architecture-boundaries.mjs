import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { prototypeRegistryViolations } from "./check-prototype-registries.mjs";
import { workspaceDependencyViolations } from "./check-workspace-dependencies.mjs";
import {
  committedBaseline,
  filesAtCommit,
  isNumberedModule,
  numberedModuleViolations,
} from "./tooling/quality-ratchets.mjs";

const root = process.cwd();
const webDataRoot = join(root, "apps", "web", "src", "data");
const apiAnalyticsRoot = join(root, "apps", "api", "src", "analytics");
const numberedModuleBaselinePath = "scripts/baselines/numbered-modules.json";
const legacyNumberedModuleMaximum = 362;
const ignoredDirectories = new Set([
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  ".tmp-runtime",
]);
const violations = [];
violations.push(...await prototypeRegistryViolations(root));
violations.push(...await workspaceDependencyViolations(root));

async function filesBelow(directory, fileName = /\.(?:ts|tsx|js|mjs)$/) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, fileName));
    else if (entry.isFile() && fileName.test(entry.name)) files.push(path);
  }
  return files;
}

// Numbered modules are the residue of mechanical line-count splits. Each one
// that still exists is listed in the baseline; a new one anywhere fails, and
// the list may only shrink as modules are renamed after the domain they own.
const numberedModules = [];
for (const sourceRoot of ["apps", "packages", "scripts", "config", "deploy"]) {
  for (const path of await filesBelow(join(root, sourceRoot), /./)) {
    if (isNumberedModule(projectPath(path))) numberedModules.push(projectPath(path));
  }
}
const numberedBaseline = committedBaseline(root, numberedModuleBaselinePath);
violations.push(...numberedModuleViolations({
  found: numberedModules,
  legacy: JSON.parse(await readFile(join(root, numberedModuleBaselinePath), "utf8")).files,
  maximum: legacyNumberedModuleMaximum,
  baseLegacy: numberedBaseline.value?.files ?? null,
  baseFiles: filesAtCommit(root, numberedBaseline.commit),
  baselinePath: numberedModuleBaselinePath,
}));

function projectPath(path) {
  return relative(root, path).split(sep).join("/");
}

function report(path, message) {
  violations.push(`${projectPath(path)}: ${message}`);
}

// Analytics, forecast, thermal-response, and electricity endpoints are owned by
// feature route modules; the numbered app chain may not register them again.
const apiAppRoot = join(root, "apps", "api", "src", "app");
const featureOwnedRoute = new RegExp(String.raw`context\.app\.(?:get|post|put|patch|delete|all)\(\s*`
  + String.raw`\x60\$\{context\.(?:prefix|v2Prefix)\}/(?:analytics/|forecast\x60|measurements/forecast`
  + String.raw`|houses/:id/(?:electricity|energy|thermal|moisture)|properties/:id/(?:electricity|energy))`);
for (const path of await filesBelow(apiAppRoot)) {
  if (!/^part-\d+\.ts$/.test(projectPath(path).split("/").at(-1))) continue;
  if (featureOwnedRoute.test(await readFile(path, "utf8"))) {
    report(path, "analytics, forecast, and electricity routes belong in feature route modules");
  }
}

// @climate-twin/analytics-kernel owns the statistics, counter, energy and
// local-calendar definitions. API modules adapt its results; they may not
// grow a second implementation. SQL builders keep their SQL arithmetic,
// which the kernel parity harness checks against the kernel.
const kernelOwnedDefinition = /\bfunction\s+(?:median|percentile|quantile|timeWeightedMean|localDateStart)\s*[(<]/;
const kernelOwnedKwhConstant = /\b(?:3_600_000_000|3600000000)\b/;
for (const path of await filesBelow(join(root, "apps", "api", "src"))) {
  const name = projectPath(path);
  if (/\.(?:test|spec)\.[tj]s$/.test(name)) continue;
  const text = await readFile(path, "utf8");
  if (kernelOwnedDefinition.test(text)) {
    report(path, "statistics and calendar helpers must come from @climate-twin/analytics-kernel");
  }
  if (!name.endsWith("-sql.ts") && kernelOwnedKwhConstant.test(text)) {
    report(path, "kWh conversions must use @climate-twin/analytics-kernel");
  }
}

// A type or constant that two workspaces share lives once in
// @climate-twin/contracts; a hand-copied twin "kept identical" drifts silently.
// "keep identical", "keep these in sync", "keep the two lists identical", ...
const keepIdenticalComment = /\bkeep\b[^.\n]{0,40}?\b(?:identical|in\s+sync)\b/iu;
for (const sourceRoot of ["apps", "packages"]) {
  for (const path of await filesBelow(join(root, sourceRoot))) {
    if (keepIdenticalComment.test(await readFile(path, "utf8"))) {
      report(path, "shared types and constants belong in @climate-twin/contracts, not in a copy kept identical by hand");
    }
  }
}

const removedBrowserDerivations = [
  "apps/web/src/homeInsights.ts",
  "apps/web/src/homePerformance.ts",
  "apps/web/src/houseMonitoring.ts",
  "apps/web/src/openingAnalytics.ts",
  "apps/web/src/calendarComparison.ts",
];
for (const candidate of removedBrowserDerivations) {
  try {
    await stat(join(root, candidate));
    violations.push(`${candidate}: authoritative browser derivation must remain deleted`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const removedClimateChain = join(root, "apps", "web", "src", "useClimateData");
try {
  for (const path of await filesBelow(removedClimateChain)) {
    const name = projectPath(path).split("/").at(-1);
    if (/^(?:part-\d+|main|render)\.(?:ts|tsx)$/.test(name)) {
      report(path, "the mechanically numbered useClimateData chain must remain deleted");
    }
    const text = await readFile(path, "utf8");
    if (/ReturnType\s*<\s*typeof\s+useClimateDataPart/i.test(text)) {
      report(path, "previous-part ReturnType chaining is forbidden");
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const webSourceRoot = join(root, "apps", "web", "src");
for (const path of await filesBelow(webSourceRoot)) {
  const name = projectPath(path);
  if (/\.(?:test|spec)\.[tj]sx?$|TestSupport\.[tj]sx?$/.test(name)) continue;
  const text = await readFile(path, "utf8");
  if ((text.includes("subscribeToEvents") || text.includes("subscribeToMeasurementEvents"))
    && name !== "apps/web/src/data/live/LiveEventCoordinator.ts"
    && !name.startsWith("apps/web/src/api")) {
    report(path, "live telemetry transports may only be owned by LiveEventCoordinator");
  }
}

const pureAnalyticsNames = /\/(?:model|derive|derive-support|freshness|insights|opening-intervals)\.ts$/;
for (const path of await filesBelow(apiAnalyticsRoot)) {
  const name = projectPath(path);
  if (!pureAnalyticsNames.test(name)) continue;
  const text = await readFile(path, "utf8");
  if (/from\s+["'][^"']*(?:\/db|\/timeseries|express|\/events|\/analytics\.js)/.test(text)) {
    report(path, "pure analytics modules may not import API I/O or transport infrastructure");
  }
}

// Spreading a data-sized array into Math.min/max can exceed the engine's argument limit.
const dataSizedMinMaxFiles = [
  ...await filesBelow(apiAnalyticsRoot),
  ...["thermal-simulation.ts", "thermal-isolation.ts", "energy-cost.ts"].map((name) => join(root, "apps", "api", "src", name)),
  join(webSourceRoot, "pages", "energyAnalysis.ts"),
  ...["SensorAnalyticsChart.tsx", "TrendChart.tsx", "ThermalSimulationPanel.tsx", "RoomComfortBoard.tsx"]
    .map((name) => join(webSourceRoot, "components", name)),
];
for (const path of dataSizedMinMaxFiles) {
  if (/Math\.(?:min|max)\(\.\.\./.test(await readFile(path, "utf8"))) {
    report(path, "use the analytics kernel's minimum/maximum instead of spreading a series into Math.min/max");
  }
}

const ownershipPath = join(webDataRoot, "queryOwnership.ts");
const ownership = await readFile(ownershipPath, "utf8");
for (const family of [
  "homePerformance",
  "homeMonitoringCollection",
  "homeMonitoring",
  "openingActivity",
  "calendarComparison",
  "sensorMutations",
  "analyticsExplorer",
  "energyProjection",
  "analyticsDiagnostics",
]) {
  if (!new RegExp(`\\b${family}:\\s*"query-client"`).test(ownership)) {
    report(ownershipPath, `${family} must have an explicit query-client owner`);
  }
}

const sensorMutationOwnerPath = join(webDataRoot, "sensors", "sensorMutations.ts");
const sensorMutationOwner = await readFile(sensorMutationOwnerPath, "utf8");
for (const operation of ["create", "update", "move", "delete"]) {
  if (!new RegExp(`mutationKey:\\s*sensorMutationKeys\\.${operation}\\b`).test(sensorMutationOwner)) {
    report(sensorMutationOwnerPath, `${operation} sensor writes must be owned by TanStack MutationCache`);
  }
}
const legacySensorActionsPath = join(webDataRoot, "bootstrap", "useSensorActions.ts");
const legacySensorActions = await readFile(legacySensorActionsPath, "utf8");
if (/\bapi\.(?:createSensor|updateSensor|deleteSensor)\s*\(/.test(legacySensorActions)) {
  report(legacySensorActionsPath, "sensor API writes may only be executed by the sensor mutation owner");
}

for (const path of await filesBelow(join(webDataRoot, "analytics"))) {
  const text = await readFile(path, "utf8");
  if (/from\s+["'][^"']*(?:useClimateData|\/bootstrap\/)/.test(text)) {
    report(path, "query-client resources may not import the legacy bootstrap chain");
  }
}

if (violations.length) {
  console.error("Architecture boundary violations:");
  for (const violation of violations.sort()) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Architecture boundary check passed.");
}
