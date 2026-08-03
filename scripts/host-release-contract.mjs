import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const IMAGE = /^ghcr\.io\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}:[A-Za-z0-9._-]{1,128}@sha256:[0-9a-f]{64}$/u;

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a bounded non-negative integer`);
  }
  return value;
}

function digest(value, name) {
  if (!SHA256.test(value ?? "")) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function plainFile(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value ?? "")) {
    throw new Error(`${name} must be a plain filename`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== expected.length
    || expected.some((key) => !(key in value))) {
    throw new Error(`${name} has an unsupported shape`);
  }
  return value;
}

function eeprom(value) {
  if (/^[1-9][0-9]{0,9}$/u.test(value ?? "")) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? "")) {
    throw new Error("minEeprom must be a build timestamp or YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("minEeprom date is invalid");
  }
  return value;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

export function objectSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function hostReleaseManifest(input) {
  if (!VERSION.test(input.version ?? "")) throw new Error("version is invalid");
  const generation = integer(input.hostGeneration, "hostGeneration");
  if (generation < 1) throw new Error("hostGeneration must be positive");
  const fallback = integer(input.minimumFallbackGeneration, "minimumFallbackGeneration");
  if (fallback > generation) throw new Error("minimum fallback generation exceeds target");
  if (!Array.isArray(input.readableEpochs) || input.readableEpochs.length === 0) {
    throw new Error("readableEpochs must be non-empty");
  }
  const readableEpochs = input.readableEpochs.map((value) => integer(value, "readableEpoch"));
  if (new Set(readableEpochs).size !== readableEpochs.length
    || readableEpochs.some((value, index) => index > 0 && readableEpochs[index - 1] >= value)) {
    throw new Error("readableEpochs must be unique and ascending");
  }
  const epoch = integer(input.dataEpoch, "dataEpoch");
  if (!readableEpochs.includes(epoch)) throw new Error("dataEpoch must be readable");
  if (!["automatic", "restore-required", "forbidden"].includes(input.dataRollback)) {
    throw new Error("dataRollback is unsupported");
  }
  if (!COMMIT.test(input.sourceCommit ?? "")) throw new Error("sourceCommit is invalid");
  const bootSize = integer(input.boot?.size, "boot.size", 256 * 1024 ** 2);
  const rootSize = integer(input.root?.size, "root.size", 3 * 1024 ** 3);
  if (bootSize < 4096 || rootSize < 4096) throw new Error("host images are too small");
  const minimumContract = integer(input.minimumUpdaterContract ?? 4, "minimumUpdaterContract", 255);
  const resultContract = integer(input.resultUpdaterContract ?? 4, "resultUpdaterContract", 255);
  if (minimumContract < 3 || resultContract < minimumContract) {
    throw new Error("updater contracts are incompatible");
  }
  const bootShimGeneration = integer(input.bootShimGeneration, "bootShimGeneration");
  if (bootShimGeneration < 1) throw new Error("bootShimGeneration must be positive");
  const migrations = input.migrations ?? [];
  if (!Array.isArray(migrations) || migrations.length > 32) {
    throw new Error("migrations must be a bounded array");
  }
  const parsedMigrations = migrations.map((migration, index) => {
    exactKeys(migration, ["id", "filename", "sha256", "kind", "backwardCompatible"], `migration ${index}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(migration.id ?? "")) {
      throw new Error(`migration ${index} id is invalid`);
    }
    if (!/^migration-[A-Za-z0-9._-]{1,69}$/u.test(migration.filename ?? "")) {
      throw new Error(`migration ${index} filename is invalid`);
    }
    if (!new Set(["sqlite", "timescale", "filesystem", "host-config"]).has(migration.kind)) {
      throw new Error(`migration ${index} kind is invalid`);
    }
    if (typeof migration.backwardCompatible !== "boolean") {
      throw new Error(`migration ${index} compatibility is invalid`);
    }
    return {
      id: migration.id,
      filename: migration.filename,
      sha256: digest(migration.sha256, `migration ${index} sha256`),
      kind: migration.kind,
      backwardCompatible: migration.backwardCompatible,
    };
  });
  if (new Set(parsedMigrations.map(({ id }) => id)).size !== parsedMigrations.length
    || new Set(parsedMigrations.map(({ filename }) => filename)).size !== parsedMigrations.length) {
    throw new Error("migration ids and filenames must be unique");
  }
  return {
    schema: "stugu-host-release/v1",
    product: "stugu-rpi4-usb",
    hostGeneration: generation,
    version: input.version,
    layout: "stugu-gpt-ab-v2",
    hardware: {
      models: ["raspberry-pi-4"],
      minEeprom: eeprom(input.minEeprom),
    },
    updater: { minContract: minimumContract, resultContract },
    bootShim: {
      minGeneration: bootShimGeneration,
      requiresRecoveryClassUpdate: input.requiresRecoveryClassUpdate === true,
    },
    data: {
      epoch,
      readableEpochs,
      writableEpoch: epoch,
      rollback: input.dataRollback,
    },
    runtimeState: {
      dockerEpoch: integer(input.dockerEpoch, "dockerEpoch"),
      tailscaleEpoch: integer(input.tailscaleEpoch, "tailscaleEpoch"),
    },
    containers: {
      releaseSchema: 3,
      manifestFile: "stugu-release-manifest-v1.json",
      manifestSha256: digest(input.containerManifestSha256, "containerManifestSha256"),
    },
    rollback: { minimumFallbackGeneration: fallback },
    artifacts: {
      bootSha256: digest(input.boot.sha256, "boot.sha256"),
      bootSize,
      rootSha256: digest(input.root.sha256, "root.sha256"),
      rootSize,
    },
    supplyChain: {
      sbomFile: plainFile(input.sbom.filename, "sbom.filename"),
      sbomSha256: digest(input.sbom.sha256, "sbom.sha256"),
      provenanceFile: plainFile(input.provenance.filename, "provenance.filename"),
      provenanceSha256: digest(input.provenance.sha256, "provenance.sha256"),
      sourceCommit: input.sourceCommit,
    },
    migrations: parsedMigrations,
  };
}

export function validateContainerReleaseManifest(value, expectedVersion) {
  const manifest = exactKeys(
    value,
    ["schema", "repository", "version", "tagName", "compatibility", "images"],
    "container release manifest",
  );
  if (manifest.schema !== "stugu-release-manifest/v1"
    || manifest.version !== expectedVersion
    || manifest.tagName !== `v${expectedVersion}`
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(manifest.repository ?? "")) {
    throw new Error("container release identity is incompatible");
  }
  const compatibility = exactKeys(manifest.compatibility, ["updateAgent", "compose"], "container compatibility");
  if (compatibility.updateAgent !== 3 || compatibility.compose !== 2) {
    throw new Error("container release contract is incompatible");
  }
  const imageSuffixes = {
    api: "api", web: "web", backup: "backup", tapo: "tapo-export-runner",
    updateAgent: "update-agent", mqtt: "mqtt", nexus433: "nexus433",
  };
  const images = exactKeys(manifest.images, Object.keys(imageSuffixes), "container images");
  let commonPrefix;
  for (const [name, suffix] of Object.entries(imageSuffixes)) {
    const value = images[name];
    const tail = `-${suffix}:v${expectedVersion}@sha256:`;
    if (!IMAGE.test(value ?? "") || value.length <= tail.length + 64
      || value.slice(0, -64).endsWith(tail) === false) {
      throw new Error(`container image ${name} is not a version-matched digest pin`);
    }
    const prefix = value.slice(0, -(tail.length + 64));
    if (commonPrefix === undefined) commonPrefix = prefix;
    else if (prefix !== commonPrefix) throw new Error("container images do not share one registry prefix");
  }
  return manifest;
}

export function validateSpdxSbom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.spdxVersion !== "SPDX-2.3"
    || value.SPDXID !== "SPDXRef-DOCUMENT"
    || value.dataLicense !== "CC0-1.0"
    || typeof value.documentNamespace !== "string"
    || !Array.isArray(value.creationInfo?.creators)) {
    throw new Error("host SBOM is not an SPDX 2.3 JSON document");
  }
  return value;
}

export function validateHostProvenance(value, { bootSha256, rootSha256, sourceCommit }) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value._type !== "https://in-toto.io/Statement/v1"
    || value.predicateType !== "https://slsa.dev/provenance/v1"
    || !Array.isArray(value.subject)
    || !value.predicate?.buildDefinition
    || !value.predicate?.runDetails) {
    throw new Error("host provenance is not a SLSA v1 in-toto statement");
  }
  const subjects = new Map(value.subject.map((subject) => [subject?.name, subject?.digest?.sha256]));
  if (subjects.get("boot.vfat") !== bootSha256 || subjects.get("system.erofs") !== rootSha256) {
    throw new Error("host provenance subjects do not match the release images");
  }
  const dependencies = value.predicate.buildDefinition.resolvedDependencies;
  if (!Array.isArray(dependencies)
    || !dependencies.some((dependency) => dependency?.digest?.gitCommit === sourceCommit)) {
    throw new Error("host provenance does not bind the source commit");
  }
  return value;
}

export function tufTargetCustom(manifest, channel) {
  if (!new Set(["stable", "preview"]).has(channel)) throw new Error("channel is unsupported");
  return {
    stugu: {
      schema: "stugu-host-target/v1",
      channel,
      manifestSha256: objectSha256(manifest),
      product: manifest.product,
      layout: manifest.layout,
      hostGeneration: manifest.hostGeneration,
      version: manifest.version,
      bootSha256: manifest.artifacts.bootSha256,
      rootSha256: manifest.artifacts.rootSha256,
    },
  };
}

export function raucManifest(version) {
  if (!VERSION.test(version ?? "")) throw new Error("version is invalid");
  return `[update]
compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64
version=${version}

[bundle]
format=verity

[image.rootfs]
filename=system.erofs

[image.boot]
filename=boot.vfat
`;
}

export function tufTargetRequest({ manifest, channel, length, sha256 }) {
  return {
    schema: "stugu-tuf-target-request/v1",
    targetPath: `channels/${channel}/stugu-rpi4-usb.raucb`,
    length: integer(length, "bundle length", 4 * 1024 ** 3),
    hashes: { sha256: digest(sha256, "bundle sha256") },
    custom: tufTargetCustom(manifest, channel),
  };
}
