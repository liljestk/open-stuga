import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const expected = json("package.json").version;
const stableSemver = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number) ?? null;
const compareSemver = (first, second) => {
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index];
  }
  return 0;
};
const workspaceManifests = ["apps", "packages"].flatMap((directory) => readdirSync(resolve(root, directory), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory() && existsSync(resolve(root, directory, entry.name, "package.json")))
  .map((entry) => `${directory}/${entry.name}/package.json`));
const productManifests = workspaceManifests;
const mismatches = productManifests.flatMap((path) => {
  const version = json(path).version;
  return version === expected ? [] : [`${path}: ${version}`];
});
const currentTuple = stableSemver(expected);
if (!currentTuple) mismatches.push(`package.json version must use stable x.y.z SemVer (current ${expected})`);
const webContractsVersion = json("apps/web/package.json").dependencies?.["@climate-twin/contracts"];
if (webContractsVersion !== expected) {
  mismatches.push(`apps/web/package.json @climate-twin/contracts: ${webContractsVersion ?? "missing"}`);
}
for (const [name, version] of Object.entries(json("apps/web/package.json").dependencies ?? {})) {
  if (name.startsWith("@climate-twin/") && version !== expected) {
    mismatches.push(`apps/web/package.json ${name}: ${version}`);
  }
}
const contractsSource = readFileSync(resolve(root, "packages/contracts/src/index.ts"), "utf8");
const runtimeVersion = /export const SYSTEM_VERSION = "([^"]+)"/.exec(contractsSource)?.[1];
if (runtimeVersion !== expected) mismatches.push(`packages/contracts/src/index.ts: ${runtimeVersion ?? "missing"}`);
const apiVersionSource = readFileSync(resolve(root, "apps/api/src/version.ts"), "utf8");
const apiRuntimeVersion = /export const SYSTEM_VERSION = "([^"]+)"/.exec(apiVersionSource)?.[1];
if (apiRuntimeVersion !== expected) mismatches.push(`apps/api/src/version.ts: ${apiRuntimeVersion ?? "missing"}`);
const lock = json("package-lock.json");
if (lock.version !== expected || lock.packages?.[""]?.version !== expected) {
  mismatches.push(`package-lock.json: ${lock.version ?? "missing"}`);
}
for (const path of workspaceManifests) {
  const lockVersion = lock.packages?.[path.replace("/package.json", "")]?.version;
  if (lockVersion !== expected) mismatches.push(`package-lock.json ${path}: ${lockVersion ?? "missing"}`);
}
const lockedWebContractsVersion = lock.packages?.["apps/web"]?.dependencies?.["@climate-twin/contracts"];
if (lockedWebContractsVersion !== expected) {
  mismatches.push(`package-lock.json apps/web @climate-twin/contracts: ${lockedWebContractsVersion ?? "missing"}`);
}
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const escapedVersion = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^## ${escapedVersion}(?:\\s|$)`, "m").test(changelog)) {
  mismatches.push(`CHANGELOG.md: release ${expected} is missing`);
}

let baseVersion = null;
if (process.argv.includes("--require-base-bump")) {
  const baseRef = process.env.VERSION_BASE_REF;
  if (!baseRef) {
    mismatches.push("VERSION_BASE_REF is required for a pull-request version check");
  } else {
    try {
      baseVersion = JSON.parse(execFileSync("git", ["show", `${baseRef}:package.json`], {
        cwd: root,
        encoding: "utf8",
      })).version;
      const baseTuple = stableSemver(baseVersion);
      if (!currentTuple || !baseTuple) {
        mismatches.push(`PR versions must use stable x.y.z SemVer (base ${baseVersion}, current ${expected})`);
      } else if (compareSemver(currentTuple, baseTuple) <= 0) {
        mismatches.push(`pull request must increase the product version above ${baseVersion} (current ${expected})`);
      }
    } catch (error) {
      mismatches.push(`could not read package.json from base ref ${baseRef}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
if (mismatches.length) {
  console.error(`Stuga version ${expected} is inconsistent:\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  const bump = baseVersion ? ` and is newer than PR base ${baseVersion}` : "";
  console.log(`Stuga version ${expected} is consistent across the local runtime, package metadata, and changelog${bump}.`);
}
