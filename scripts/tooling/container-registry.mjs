import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheKey } from "./runtime.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

export const RELEASE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function descriptor(value, label) {
  const item = object(value, label);
  if (!DIGEST.test(item.digest ?? "")) throw new Error(`${label} digest is invalid`);
  if (!Number.isSafeInteger(item.size) || item.size < 0) throw new Error(`${label} size is invalid`);
  if (typeof item.mediaType !== "string" || item.mediaType.length === 0) {
    throw new Error(`${label} media type is invalid`);
  }
  return { mediaType: item.mediaType, digest: item.digest, size: item.size };
}

export function imageReferenceIdentity(name, reference) {
  const separator = reference.lastIndexOf("@sha256:");
  if (separator < 1) throw new Error(`${name} image is not digest-pinned`);
  const indexDigest = reference.slice(separator + 1);
  if (!DIGEST.test(indexDigest)) throw new Error(`${name} image index digest is invalid`);
  return { base: reference.slice(0, separator), indexDigest };
}

function platformDescriptors(name, index) {
  if (!Array.isArray(index?.manifests)) throw new Error(`${name} image is not a multi-platform index`);
  if (index.schemaVersion !== 2 || !INDEX_MEDIA_TYPES.has(index.mediaType)) {
    throw new Error(`${name} image index schema or media type is invalid`);
  }
  const descriptors = {};
  for (const platform of RELEASE_PLATFORMS) {
    const [os, architecture] = platform.split("/");
    const matches = index.manifests.filter((item) => item?.platform?.os === os
      && item?.platform?.architecture === architecture);
    if (matches.length !== 1) throw new Error(`${name} image must contain exactly one ${platform} manifest`);
    descriptors[platform] = descriptor(matches[0], `${name} ${platform} manifest descriptor`);
    if (!MANIFEST_MEDIA_TYPES.has(descriptors[platform].mediaType)) {
      throw new Error(`${name} ${platform} manifest descriptor media type is invalid`);
    }
  }
  return descriptors;
}

function manifestClosure(name, platform, manifest) {
  const value = object(manifest, `${name} ${platform} manifest`);
  if (value.schemaVersion !== 2 || !MANIFEST_MEDIA_TYPES.has(value.mediaType)) {
    throw new Error(`${name} ${platform} manifest schema or media type is invalid`);
  }
  const config = descriptor(value.config, `${name} ${platform} config descriptor`);
  if (!Array.isArray(value.layers) || value.layers.length === 0) {
    throw new Error(`${name} ${platform} manifest has no layer descriptors`);
  }
  const layers = value.layers.map((item, index) => (
    descriptor(item, `${name} ${platform} layer descriptor ${index + 1}`)
  ));
  return { config, layers };
}

function platformProvenance(name, platform, value, commit) {
  const entry = object(value?.[platform], `${name} ${platform} provenance`);
  const slsa = object(entry.SLSA, `${name} ${platform} SLSA provenance`);
  const revisions = [
    slsa.invocation?.environment?.vcs?.revision,
    slsa.buildDefinition?.externalParameters?.configSource?.digest?.sha1,
    slsa.buildDefinition?.externalParameters?.request?.root?.request?.args?.["vcs:revision"],
    slsa.runDetails?.metadata?.buildkit_metadata?.vcs?.revision,
  ].filter((revision) => revision !== undefined);
  if (revisions.length === 0 || revisions.some((revision) => !COMMIT.test(revision) || revision !== commit)) {
    throw new Error(`${name} ${platform} provenance does not bind source commit ${commit}`);
  }
  const claimedPlatform = slsa.invocation?.environment?.platform;
  if (claimedPlatform !== undefined && claimedPlatform !== platform) {
    throw new Error(`${name} ${platform} provenance claims another platform`);
  }
  return cacheKey(slsa);
}

export function multiPlatformImageEvidence(name, reference, commit, {
  index,
  manifests,
  provenance,
}) {
  if (!COMMIT.test(commit ?? "")) throw new Error("source commit is invalid");
  const { indexDigest } = imageReferenceIdentity(name, reference);
  const platforms = platformDescriptors(name, index);
  const evidence = { reference, indexDigest, anonymousRead: true };
  for (const platform of RELEASE_PLATFORMS) {
    const architecture = platform.split("/")[1];
    const manifestDescriptor = platforms[platform];
    const closure = manifestClosure(name, platform, manifests?.[platform]);
    evidence[`${architecture}ManifestDigest`] = manifestDescriptor.digest;
    evidence[`${architecture}ConfigDigest`] = closure.config.digest;
    evidence[`${architecture}DescriptorClosureSha256`] = cacheKey(closure);
    evidence[`${architecture}ProvenanceSha256`] = platformProvenance(
      name,
      platform,
      provenance,
      commit,
    );
  }
  return evidence;
}

export async function inspectMultiPlatformImage(name, reference, commit, readers) {
  const { base, indexDigest } = imageReferenceIdentity(name, reference);
  const index = await readers.manifest(reference, indexDigest, `${name} image index`);
  const platforms = platformDescriptors(name, index);
  const manifests = {};
  for (const platform of RELEASE_PLATFORMS) {
    const digest = platforms[platform].digest;
    manifests[platform] = await readers.manifest(
      `${base}@${digest}`,
      digest,
      `${name} ${platform} manifest`,
    );
  }
  const provenance = await readers.provenance(reference, `${name} build provenance`);
  return multiPlatformImageEvidence(name, reference, commit, { index, manifests, provenance });
}

export function anonymousRegistryEnvironment(environment, dockerConfigDirectory) {
  const blocked = new Set([
    "CR_PAT",
    "DOCKER_AUTH_CONFIG",
    "GITHUB_TOKEN",
    "GHCR_TOKEN",
    "GHCR_USERNAME",
    "REGISTRY_AUTH_FILE",
  ]);
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!blocked.has(key.toUpperCase()) && key.toUpperCase() !== "DOCKER_CONFIG") clean[key] = value;
  }
  clean.DOCKER_CONFIG = dockerConfigDirectory;
  return clean;
}

export async function withAnonymousRegistryEnvironment(environment, callback) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-anonymous-docker-"));
  try {
    writeFileSync(join(directory, "config.json"), "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await callback(anonymousRegistryEnvironment(environment, directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
