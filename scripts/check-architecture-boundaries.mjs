import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const webDataRoot = join(root, "apps", "web", "src", "data");
const apiAnalyticsRoot = join(root, "apps", "api", "src", "analytics");
const violations = [];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function projectPath(path) {
  return relative(root, path).split(sep).join("/");
}

function report(path, message) {
  violations.push(`${projectPath(path)}: ${message}`);
}

for (const directory of [webDataRoot, apiAnalyticsRoot]) {
  for (const path of await filesBelow(directory)) {
    const name = projectPath(path).split("/").at(-1);
    if (/^(?:part-\d+|\d{2}-)/.test(name)) {
      report(path, "numbered modules are forbidden in analytics and web data domains");
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
  if (/\.(?:test|spec)\.[tj]sx?$/.test(name) || name.includes("apiTestSupport")) continue;
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

const ownershipPath = join(webDataRoot, "queryOwnership.ts");
const ownership = await readFile(ownershipPath, "utf8");
for (const family of [
  "homePerformance",
  "homeMonitoringCollection",
  "homeMonitoring",
  "openingActivity",
  "calendarComparison",
]) {
  if (!new RegExp(`\\b${family}:\\s*"query-client"`).test(ownership)) {
    report(ownershipPath, `${family} must have an explicit query-client owner`);
  }
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
