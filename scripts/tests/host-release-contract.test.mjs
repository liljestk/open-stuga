import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  hostReleaseManifest,
  objectSha256,
  raucManifest,
  tufTargetRequest,
  validateContainerReleaseManifest,
  validateHostProvenance,
  validateSpdxSbom,
} from "../host-release-contract.mjs";
import { parseArguments } from "../build-host-update-bundle.mjs";

function input() {
  return {
    version: "1.2.3",
    hostGeneration: 42,
    minimumFallbackGeneration: 41,
    minEeprom: "2026-01-01",
    bootShimGeneration: 1,
    requiresRecoveryClassUpdate: false,
    dataEpoch: 7,
    readableEpochs: [6, 7],
    dataRollback: "automatic",
    dockerEpoch: 2,
    tailscaleEpoch: 1,
    containerManifestSha256: "c".repeat(64),
    boot: { sha256: "a".repeat(64), size: 256 * 1024 * 1024 },
    root: { sha256: "b".repeat(64), size: 3 * 1024 * 1024 * 1024 },
    sbom: { filename: "stugu-host-sbom.spdx.json", sha256: "d".repeat(64) },
    provenance: {
      filename: "stugu-host-provenance.intoto.jsonl",
      sha256: "e".repeat(64),
    },
    sourceCommit: "f".repeat(40),
  };
}

test("release contract and TUF custom metadata bind the same routing facts", () => {
  const manifest = hostReleaseManifest(input());
  const request = tufTargetRequest({
    manifest,
    channel: "stable",
    length: 123456,
    sha256: "9".repeat(64),
  });
  assert.equal(request.custom.stugu.manifestSha256, objectSha256(manifest));
  assert.equal(manifest.layout, "stugu-gpt-ab-v2");
  assert.equal(request.custom.stugu.hostGeneration, 42);
  assert.equal(request.custom.stugu.rootSha256, "b".repeat(64));
  assert.equal(request.targetPath, "channels/stable/stugu-rpi4-usb.raucb");
});

test("canonical release JSON recursively sorts keys", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 3 } }), '{"a":{"b":3,"d":2},"z":1}');
});

test("release contract rejects generation rollback floors and unsafe epochs", () => {
  assert.throws(
    () => hostReleaseManifest({ ...input(), minimumFallbackGeneration: 43 }),
    /fallback generation exceeds/u,
  );
  assert.throws(
    () => hostReleaseManifest({ ...input(), readableEpochs: [7, 6] }),
    /unique and ascending/u,
  );
  assert.throws(
    () => hostReleaseManifest({ ...input(), dataRollback: "best-effort" }),
    /unsupported/u,
  );
  assert.throws(
    () => hostReleaseManifest({ ...input(), minEeprom: "2026-02-30" }),
    /date is invalid/u,
  );
  assert.throws(
    () => hostReleaseManifest({ ...input(), minimumUpdaterContract: 4, resultUpdaterContract: 3 }),
    /contracts are incompatible/u,
  );
});

test("host supply-chain inputs are structurally bound before signing", () => {
  const digestRef = (name) => `ghcr.io/example/stugu-${name}:v1.2.3@sha256:${"a".repeat(64)}`;
  const containerManifest = {
    schema: "stugu-release-manifest/v1",
    repository: "example/releases",
    version: "1.2.3",
    tagName: "v1.2.3",
    compatibility: { updateAgent: 3, compose: 2 },
    images: {
      api: digestRef("api"), web: digestRef("web"), backup: digestRef("backup"),
      tapo: digestRef("tapo-export-runner"), updateAgent: digestRef("update-agent"),
      mqtt: digestRef("mqtt"), nexus433: digestRef("nexus433"),
    },
  };
  assert.equal(validateContainerReleaseManifest(containerManifest, "1.2.3"), containerManifest);
  assert.throws(
    () => validateContainerReleaseManifest({ ...containerManifest, version: "1.2.4" }, "1.2.3"),
    /identity/u,
  );
  assert.throws(
    () => validateContainerReleaseManifest({
      ...containerManifest,
      images: { ...containerManifest.images, api: digestRef("other-api") },
    }, "1.2.3"),
    /version-matched|registry prefix/u,
  );
  assert.doesNotThrow(() => validateSpdxSbom({
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    dataLicense: "CC0-1.0",
    documentNamespace: "https://example.test/sbom/1",
    creationInfo: { creators: ["Tool: syft"] },
  }));
  assert.doesNotThrow(() => validateHostProvenance({
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "boot.vfat", digest: { sha256: "a".repeat(64) } },
      { name: "system.erofs", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://stugu.local/build/rpi-image-gen/v1",
        externalParameters: {
          version: "1.2.3",
          hostGeneration: 42,
          architecture: "arm64",
          layout: "stugu-gpt-ab-v2",
        },
        internalParameters: {
          tufRootSha256: "c".repeat(64),
          raucCaSha256: "d".repeat(64),
        },
        resolvedDependencies: [{ digest: { gitCommit: "f".repeat(40) } }],
      },
      runDetails: { builder: { id: "builder" } },
    },
  }, {
    bootSha256: "a".repeat(64),
    rootSha256: "b".repeat(64),
    sourceCommit: "f".repeat(40),
    version: "1.2.3",
    hostGeneration: 42,
    tufRootSha256: "c".repeat(64),
    raucCaSha256: "d".repeat(64),
  }));
});

test("host provenance rejects release identity and trust-anchor mismatches", () => {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "boot.vfat", digest: { sha256: "a".repeat(64) } },
      { name: "system.erofs", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://stugu.local/build/rpi-image-gen/v1",
        externalParameters: {
          version: "1.2.3",
          hostGeneration: 42,
          architecture: "arm64",
          layout: "stugu-gpt-ab-v2",
        },
        internalParameters: {
          tufRootSha256: "c".repeat(64),
          raucCaSha256: "d".repeat(64),
        },
        resolvedDependencies: [{ digest: { gitCommit: "f".repeat(40) } }],
      },
      runDetails: { builder: { id: "builder" } },
    },
  };
  const expected = {
    bootSha256: "a".repeat(64),
    rootSha256: "b".repeat(64),
    sourceCommit: "f".repeat(40),
    version: "1.2.3",
    hostGeneration: 42,
    tufRootSha256: "c".repeat(64),
    raucCaSha256: "d".repeat(64),
  };
  assert.throws(
    () => validateHostProvenance(statement, { ...expected, hostGeneration: 43 }),
    /release identity/u,
  );
  assert.throws(
    () => validateHostProvenance(statement, { ...expected, tufRootSha256: "e".repeat(64) }),
    /trust anchors/u,
  );
});

test("RAUC manifest contains only the two inactive slot classes and verity", () => {
  const value = raucManifest("1.2.3");
  assert.match(value, /compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64/u);
  assert.match(value, /\[bundle\]\nformat=verity/u);
  assert.deepEqual([...value.matchAll(/^\[image\.([^\]]+)\]$/gmu)].map((match) => match[1]), ["rootfs", "boot"]);
  assert.match(value, /\[image\.rootfs\]\nfilename=system\.img/u);
  assert.match(value, /\[image\.boot\]\nfilename=boot\.img/u);
  assert.doesNotMatch(value, /filename=.*\.(?:erofs|vfat)$/mu);
  assert.doesNotMatch(value, /hook|persistent/iu);
});

test("bundle CLI keeps TUF signing separate from RAUC signing", () => {
  const options = parseArguments([
    "--boot-image", "boot.vfat", "--root-image", "system.erofs",
    "--container-manifest", "release.json", "--sbom", "sbom.json",
    "--provenance", "provenance.jsonl", "--rauc-cert", "pkcs11:cert",
    "--rauc-key", "pkcs11:key", "--rauc-signing-keyring", "rauc-ca.pem",
    "--tuf-root", "root.json",
    "--generation", "42",
    "--fallback-generation", "41", "--version", "1.2.3",
    "--min-eeprom", "2026-01-01", "--source-commit", "f".repeat(40),
    "--output", "release.raucb",
  ]);
  assert.equal(options.raucKey, "pkcs11:key");
  assert.equal(options.raucSigningKeyring, "rauc-ca.pem");
  assert.equal(options.tufRoot, "root.json");
  assert.equal(options.channel, "stable");
  assert.equal("tufKey" in options, false);
});
