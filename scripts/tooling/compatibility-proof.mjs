import { lstatSync, readFileSync } from "node:fs";

import {
  validateContainerReleaseManifest,
  validateHostProvenance,
  validateSpdxSbom,
} from "../host-release-contract.mjs";
import { validateCompatibilityProof, validateLocalVerificationReceipt } from "./receipt-contracts.mjs";
import { boundedJson, sha256File, verifyReceiptChecksum, writeJsonReceipt } from "./runtime.mjs";

function regularFile(path, label, maximumBytes) {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maximumBytes) {
    throw new Error(`${label} must be a regular file of at most ${maximumBytes} bytes`);
  }
  return details;
}

function passed(id, label) {
  return { id, label, status: "passed", durationMs: 0 };
}

export function createCompatibilityProof({
  artifacts,
  version,
  snapshot,
  fullCiReceiptPath,
  hostGeneration,
  tufRootSha256,
  raucCaSha256,
}) {
  const checks = [];
  const manifest = validateContainerReleaseManifest(
    boundedJson(artifacts.releaseManifest, "container release manifest", 128 * 1024),
    version,
  );
  const manifestSha256 = sha256File(artifacts.releaseManifest);
  if (sha256File(artifacts.hostContainerManifest) !== manifestSha256) {
    throw new Error("host container manifest differs from the release artifact manifest");
  }
  checks.push(passed("CONTAINER_CONTRACT", "Container and host release contracts"));

  const fullCiReceipt = validateLocalVerificationReceipt(
    boundedJson(fullCiReceiptPath, "full CI receipt", 8 * 1024 * 1024),
    { mode: "full", snapshot, requireClean: true },
  );
  if (fullCiReceipt.projectVersion !== version) throw new Error("full CI receipt version differs from the release");
  const fullCiReceiptSha256 = verifyReceiptChecksum(fullCiReceiptPath, "full CI receipt").sha256;
  checks.push(passed("FULL_CI", "Commit-pinned authoritative full CI"));

  regularFile(artifacts.hostBoot, "host boot image", 256 * 1024 ** 2);
  regularFile(artifacts.hostRoot, "host root image", 3 * 1024 ** 3);
  const bootSha256 = sha256File(artifacts.hostBoot);
  const rootSha256 = sha256File(artifacts.hostRoot);
  checks.push(passed("HOST_IMAGES", "Host boot and root image hashes"));

  validateSpdxSbom(boundedJson(artifacts.hostSbom, "host SBOM", 128 * 1024 * 1024));
  const sbomSha256 = sha256File(artifacts.hostSbom);
  checks.push(passed("HOST_SBOM", "Host SPDX supply-chain inventory"));

  regularFile(artifacts.hostProvenance, "host provenance", 16 * 1024 * 1024);
  const lines = readFileSync(artifacts.hostProvenance, "utf8").split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error("host provenance must contain exactly one statement");
  let provenance;
  try {
    provenance = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error("host provenance is not valid JSONL", { cause: error });
  }
  validateHostProvenance(provenance, {
    bootSha256,
    rootSha256,
    sourceCommit: snapshot.commit,
    version,
    hostGeneration,
    tufRootSha256,
    raucCaSha256,
  });
  const provenanceSha256 = sha256File(artifacts.hostProvenance);
  checks.push(passed("HOST_PROVENANCE", "Host provenance subjects and source commit"));

  const proof = {
    schema: "stugu-release-compatibility-proof/v1",
    result: "passed",
    commit: snapshot.commit,
    version,
    manifestSha256,
    fullCiReceiptSha256,
    contracts: manifest.compatibility,
    hostInputs: {
      containerManifestSha256: sha256File(artifacts.hostContainerManifest),
      bootSha256,
      rootSha256,
      sbomSha256,
      provenanceSha256,
      sourceCommit: snapshot.commit,
      hostGeneration,
      tufRootSha256,
      raucCaSha256,
    },
    checks,
  };
  validateCompatibilityProof(proof, {
    commit: snapshot.commit,
    version,
    manifestSha256,
    fullCiReceiptSha256,
  });
  return proof;
}

export function writeCompatibilityProof(input) {
  const proof = createCompatibilityProof(input);
  return { proof, written: writeJsonReceipt(input.artifacts.compatibilityProof, proof) };
}
