import { basename } from "node:path";

import { assertSha256, exactKeys, sha256, sha256File } from "./runtime.mjs";

const VERSION = /^\d+\.\d+\.\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactString(value, label, maximum = 2_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

export function normalizeReleaseBody(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").trimEnd();
}

export function releaseBodySha256(value) {
  return sha256(normalizeReleaseBody(value));
}

function validateAssetDigests(value, label = "draft assets") {
  const assets = object(value, label);
  const entries = Object.entries(assets);
  if (entries.length === 0) throw new Error(`${label} are missing`);
  for (const [name, digest] of entries) {
    if (!ASSET_NAME.test(name)) throw new Error(`${label} contain an invalid filename`);
    assertSha256(digest, `${label} ${name}`);
  }
  return assets;
}

export function assetDigestsForPaths(paths) {
  const assets = {};
  for (const path of paths) {
    const name = basename(path);
    const digest = sha256File(path);
    if (assets[name] && assets[name] !== digest) {
      throw new Error(`release assets contain conflicting files named ${name}`);
    }
    if (assets[name]) throw new Error(`release assets contain duplicate files named ${name}`);
    assets[name] = digest;
  }
  return Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right)));
}

function validateExpectedAssetNames(assets, version, factoryUploaded) {
  const required = new Set([
    "stugu-release-manifest-v1.json",
    "stugu-release-compatibility-proof-v1.json",
    "stugu-release-compatibility-proof-v1.json.sha256",
    `stugu-nexus433-corresponding-source-${version}.tar.gz`,
    `stugu-nexus433-corresponding-source-${version}.tar.gz.sha256`,
    `stugu-${version}-full-verification.json`,
    `stugu-${version}-full-verification.json.sha256`,
  ]);
  const factoryNames = [
    `stugu-rpi4-${version}.img.zst`,
    `stugu-rpi4-${version}-factory.sha256`,
  ];
  for (const name of required) {
    if (!(name in assets)) throw new Error(`draft assets are missing ${name}`);
  }
  for (const name of factoryNames) {
    if ((name in assets) !== factoryUploaded) {
      throw new Error(factoryUploaded
        ? `draft assets are missing ${name}`
        : `draft assets unexpectedly include ${name}`);
    }
  }
  const expectedCount = factoryUploaded ? 9 : 7;
  if (Object.keys(assets).length !== expectedCount) throw new Error("draft asset set is not exact");
}

export function validateDraftEvidence(value, version) {
  const draft = exactKeys(object(value, "release draft evidence"), [
    "title", "bodySha256", "channel", "factoryUploaded", "assets",
  ], "release draft evidence");
  exactString(draft.title, "release draft title", 300);
  if (version && draft.title !== `Stugu ${version}`) throw new Error("release draft title does not match the version");
  assertSha256(draft.bodySha256, "release draft body sha256");
  if (!new Set(["stable", "preview"]).has(draft.channel)) throw new Error("release draft channel is invalid");
  if (typeof draft.factoryUploaded !== "boolean") throw new Error("release draft factory decision is invalid");
  validateAssetDigests(draft.assets);
  if (version) validateExpectedAssetNames(draft.assets, version, draft.factoryUploaded);
  return draft;
}

export function createDraftPreparation({
  commit,
  version,
  repository,
  channel,
  factoryUploaded,
  body,
  assetPaths,
}) {
  const preparation = {
    schema: "stugu-draft-preparation/v1",
    commit,
    version,
    tagName: `v${version}`,
    repository,
    draft: {
      title: `Stugu ${version}`,
      bodySha256: releaseBodySha256(body),
      channel,
      factoryUploaded,
      assets: assetDigestsForPaths(assetPaths),
    },
  };
  return validateDraftPreparation(preparation, { commit, version, repository, channel });
}

export function validateDraftPreparation(value, expected = {}) {
  const preparation = exactKeys(object(value, "draft preparation"), [
    "schema", "commit", "version", "tagName", "repository", "draft",
  ], "draft preparation");
  if (preparation.schema !== "stugu-draft-preparation/v1") throw new Error("draft preparation schema is invalid");
  if (!COMMIT.test(preparation.commit ?? "")) throw new Error("draft preparation commit is invalid");
  if (!VERSION.test(preparation.version ?? "") || preparation.tagName !== `v${preparation.version}`) {
    throw new Error("draft preparation version or tag is invalid");
  }
  if (!REPOSITORY.test(preparation.repository ?? "")) throw new Error("draft preparation repository is invalid");
  validateDraftEvidence(preparation.draft, preparation.version);
  if (preparation.draft.channel !== expected.channel && expected.channel !== undefined) {
    throw new Error("draft preparation channel does not match");
  }
  for (const key of ["commit", "version", "repository"]) {
    if (expected[key] !== undefined && preparation[key] !== expected[key]) {
      throw new Error(`draft preparation ${key} does not match`);
    }
  }
  return preparation;
}

function releaseAssetDigests(release) {
  if (!Array.isArray(release?.assets)) throw new Error("GitHub draft assets are unavailable");
  const assets = {};
  for (const asset of release.assets) {
    const name = asset?.name;
    const digest = String(asset?.digest ?? "").replace(/^sha256:/u, "");
    if (!ASSET_NAME.test(name ?? "") || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("GitHub draft contains an asset without a valid name and SHA-256 digest");
    }
    if (assets[name]) throw new Error(`GitHub draft contains duplicate assets named ${name}`);
    assets[name] = digest;
  }
  return assets;
}

export function validateGitHubRelease(release, draftValue, {
  tagName,
  requireDraft = true,
  additionalAssets = {},
} = {}) {
  const draft = validateDraftEvidence(draftValue);
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("GitHub release is unavailable");
  }
  if (requireDraft && release.isDraft !== true) throw new Error("GitHub release is not a draft");
  if (!requireDraft && release.isDraft !== false) throw new Error("GitHub release is still a draft");
  if (tagName && release.tagName !== tagName) throw new Error("GitHub release tag does not match");
  if (release.name !== draft.title) throw new Error("GitHub release title differs from the reviewed draft");
  if (releaseBodySha256(release.body) !== draft.bodySha256) {
    throw new Error("GitHub release notes differ from the reviewed draft");
  }
  const expectedPrerelease = draft.channel === "preview";
  if (release.isPrerelease !== expectedPrerelease) throw new Error("GitHub release channel differs from the reviewed draft");
  const additional = Object.keys(object(additionalAssets, "additional release assets")).length > 0
    ? validateAssetDigests(additionalAssets, "additional release assets")
    : {};
  for (const name of Object.keys(additional)) {
    if (name in draft.assets) throw new Error(`additional release asset conflicts with reviewed draft asset ${name}`);
  }
  const expectedAssets = { ...draft.assets, ...additional };
  const actualAssets = releaseAssetDigests(release);
  const expectedNames = Object.keys(expectedAssets).sort();
  const actualNames = Object.keys(actualAssets).sort();
  if (expectedNames.length !== actualNames.length
    || expectedNames.some((name, index) => name !== actualNames[index])) {
    throw new Error("GitHub release asset set differs from the reviewed draft");
  }
  for (const [name, digest] of Object.entries(expectedAssets)) {
    if (actualAssets[name] !== digest) throw new Error(`GitHub release asset digest differs for ${name}`);
  }
  return release;
}

export function unexpectedGitHubAssets(release, expectedAssets) {
  const expectedNames = new Set(Object.keys(validateAssetDigests(expectedAssets)));
  if (!Array.isArray(release?.assets)) throw new Error("GitHub draft assets are unavailable");
  return release.assets.filter((asset) => !expectedNames.has(asset?.name));
}
