import { resolve } from "node:path";

import { nexus433SourceArtifactNames } from "./build-nexus433-source-bundle.mjs";
import { reportPaths as localCiReportPaths } from "./local-ci.mjs";
import { releaseManifestAsset } from "./local-release-manifest.mjs";

export const containerTargets = Object.freeze([
  { target: "api", suffix: "api", dockerfile: "Dockerfile", buildTarget: "api" },
  { target: "web", suffix: "web", dockerfile: "Dockerfile", buildTarget: "web" },
  { target: "backup", suffix: "backup", dockerfile: "Dockerfile", buildTarget: "backup" },
  {
    target: "tapo-export-runner",
    suffix: "tapo-export-runner",
    dockerfile: "Dockerfile",
    buildTarget: "tapo-export-runner",
  },
  {
    target: "update-agent",
    suffix: "update-agent",
    dockerfile: "Dockerfile",
    buildTarget: "update-agent",
  },
  {
    target: "mqtt",
    suffix: "mqtt",
    dockerfile: "deploy/mqtt/Dockerfile",
    buildTarget: "runtime",
  },
  {
    target: "nexus433",
    suffix: "nexus433",
    dockerfile: "deploy/nexus433/Dockerfile",
    buildTarget: "runtime",
  },
]);

export function imageDefinitions(prefix, tag) {
  return containerTargets.map((definition) => ({
    ...definition,
    ref: `${prefix}-${definition.suffix}:${tag}`,
  }));
}

export function artifactDefinitions(repositoryRoot, version) {
  const directory = resolve(repositoryRoot, "dist", "rpi");
  const releaseDirectory = resolve(directory, "release");
  const hostInputsDirectory = resolve(directory, "host-inputs");
  const localCi = localCiReportPaths(repositoryRoot, version);
  const nexus433Source = nexus433SourceArtifactNames(version);
  return {
    directory,
    releaseDirectory,
    ota: resolve(directory, `stugu-rpi4-${version}-ota.tar.zst`),
    factory: resolve(directory, `stugu-rpi4-${version}.img.zst`),
    combinedChecksum: resolve(directory, `stugu-rpi4-${version}.sha256`),
    releaseChecksum: resolve(releaseDirectory, `stugu-rpi4-${version}.sha256`),
    factoryChecksum: resolve(
      releaseDirectory,
      `stugu-rpi4-${version}-factory.sha256`,
    ),
    releaseManifest: resolve(releaseDirectory, releaseManifestAsset),
    hostInputsDirectory,
    hostBoot: resolve(hostInputsDirectory, "boot.vfat"),
    hostRoot: resolve(hostInputsDirectory, "system.erofs"),
    hostSbom: resolve(hostInputsDirectory, "stugu-host-sbom.spdx.json"),
    hostProvenance: resolve(
      hostInputsDirectory,
      "stugu-host-provenance.intoto.jsonl",
    ),
    hostContainerManifest: resolve(hostInputsDirectory, releaseManifestAsset),
    hostBundle: resolve(releaseDirectory, `stugu-rpi4-${version}-host.raucb`),
    hostTargetRequest: resolve(
      releaseDirectory,
      `stugu-rpi4-${version}-host.raucb.tuf-target.json`,
    ),
    nexus433Source: resolve(releaseDirectory, nexus433Source.bundle),
    nexus433SourceChecksum: resolve(releaseDirectory, nexus433Source.checksum),
    localCiReport: localCi.report,
    localCiChecksum: localCi.checksum,
  };
}
