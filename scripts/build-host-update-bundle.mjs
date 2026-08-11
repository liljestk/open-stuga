#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  hostReleaseManifest,
  raucManifest,
  sha256File,
  tufTargetRequest,
  validateContainerReleaseManifest,
  validateHostProvenance,
  validateSpdxSbom,
} from "./host-release-contract.mjs";

function usage() {
  return `Build a signed Stugu RAUC host bundle and TUF target request.

Usage:
  node scripts/build-host-update-bundle.mjs \\
    --boot-image boot.vfat --root-image system.erofs \\
    --container-manifest stugu-release-manifest-v1.json \\
    --sbom host.spdx.json --provenance host.intoto.jsonl \\
    --rauc-cert CERT_OR_PKCS11 --rauc-key KEY_OR_PKCS11 \\
    --tuf-root root.json \\
    --generation N --fallback-generation N --version X.Y.Z \\
    --min-eeprom YYYY-MM-DD --source-commit SHA --output FILE

RAUC signing also requires --rauc-signing-keyring RAUC_CA_PEM so the release
certificate is verified against the same trust chain embedded in the image.

The resulting *.tuf-target.json is an unsigned request for the independent TUF
targets ceremony. This command never writes TUF metadata or handles TUF keys.
`;
}

export function parseArguments(argv) {
  const options = { channel: "stable", dataRollback: "automatic" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") options.help = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      const key = {
        "--boot-image": "bootImage", "--root-image": "rootImage",
        "--container-manifest": "containerManifest", "--sbom": "sbom",
        "--provenance": "provenance", "--rauc-cert": "raucCert", "--rauc-key": "raucKey",
        "--rauc-signing-keyring": "raucSigningKeyring",
        "--tuf-root": "tufRoot",
        "--generation": "generation", "--fallback-generation": "fallbackGeneration",
        "--version": "version", "--min-eeprom": "minEeprom", "--source-commit": "sourceCommit",
        "--output": "output", "--channel": "channel", "--data-rollback": "dataRollback",
        "--data-epoch": "dataEpoch", "--readable-data-epochs": "readableDataEpochs",
        "--docker-epoch": "dockerEpoch", "--tailscale-epoch": "tailscaleEpoch",
        "--boot-shim-generation": "bootShimGeneration",
        "--min-updater-contract": "minimumUpdaterContract",
        "--result-updater-contract": "resultUpdaterContract",
        "--recovery-class-update": "recoveryClassUpdate",
      }[name];
      if (!key) throw new Error(`Unknown argument: ${name}`);
      options[key] = value;
    }
  }
  return options;
}

function invoke(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function verifyRaucInfo(value, manifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.update?.compatible !== "stugu-rpi4-usb:stugu-gpt-ab-v2:arm64"
    || value.update?.version !== manifest.version
    || !/^[0-9a-f]{64}$/u.test(value["manifest-hash"] ?? "")
    || value.bundle?.format !== "verity"
    || !Array.isArray(value.images)
    || value.images.length !== 2) {
    throw new Error("RAUC verification returned an incompatible bundle description");
  }
  const expected = new Map([
    ["rootfs", { filename: "system.img", checksum: manifest.artifacts.rootSha256, size: manifest.artifacts.rootSize }],
    ["boot", { filename: "boot.img", checksum: manifest.artifacts.bootSha256, size: manifest.artifacts.bootSize }],
  ]);
  for (const image of value.images) {
    const declaration = expected.get(image?.["slot-class"]);
    if (!declaration
      || image.filename !== declaration.filename
      || image.checksum !== declaration.checksum
      || image.size !== declaration.size
      || !Array.isArray(image.hooks)
      || image.hooks.length !== 0) {
      throw new Error("RAUC image declarations do not match the signed host manifest");
    }
    expected.delete(image["slot-class"]);
  }
  if (expected.size !== 0) throw new Error("RAUC bundle is missing a required image class");
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (["hook", "hooks"].includes(key.toLowerCase())
          && child !== null && child !== ""
          && (!Array.isArray(child) || child.length !== 0)
          && (typeof child !== "object" || Array.isArray(child) || Object.keys(child).length !== 0)) {
          throw new Error("RAUC bundle hooks are forbidden");
        }
        pending.push(child);
      }
    }
  }
}

function requiredFile(path, name) {
  if (!path || !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`${name} is missing or empty`);
  }
}

function syncPath(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishExclusive(source, destination) {
  linkSync(source, destination);
  unlinkSync(source);
  syncPath(dirname(destination));
}

function boundedJson(path, name, maximum) {
  requiredFile(path, name);
  const data = readFileSync(path);
  if (data.length > maximum) throw new Error(`${name} exceeds its size limit`);
  try {
    return JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(`${name} is not valid UTF-8 JSON`, { cause: error });
  }
}

function boundedInteger(value, name, fallback) {
  const selected = value ?? fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(String(selected))) {
    throw new Error(`${name} must be a canonical integer`);
  }
  const parsed = Number(selected);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is out of range`);
  return parsed;
}

function booleanValue(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  for (const [key, label] of [
    ["bootImage", "boot image"], ["rootImage", "root image"],
    ["containerManifest", "container release manifest"], ["sbom", "host SBOM"],
    ["provenance", "host provenance"],
  ]) requiredFile(options[key], label);
  for (const key of [
    "raucCert", "raucKey", "raucSigningKeyring", "tufRoot", "generation", "fallbackGeneration",
    "version", "minEeprom", "sourceCommit", "output",
  ]) if (!options[key]) throw new Error(`${key} is required`);
  requiredFile(options.raucSigningKeyring, "RAUC signing keyring");
  requiredFile(options.tufRoot, "TUF root v1");
  for (const [value, label] of [
    [options.raucCert, "RAUC release certificate"],
    [options.raucKey, "RAUC release private key"],
  ]) {
    if (!String(value).startsWith("pkcs11:")) requiredFile(value, label);
  }
  if (existsSync(options.output) || existsSync(`${options.output}.tuf-target.json`)) {
    throw new Error("output already exists; signed release artifacts are immutable");
  }
  const boot = resolve(options.bootImage);
  const root = resolve(options.rootImage);
  const containerManifest = resolve(options.containerManifest);
  const sbom = resolve(options.sbom);
  const provenance = resolve(options.provenance);
  const output = resolve(options.output);
  const dataEpoch = boundedInteger(options.dataEpoch, "data epoch", 1);
  const readableEpochs = String(options.readableDataEpochs ?? dataEpoch)
    .split(",")
    .map((item) => boundedInteger(item, "readable data epoch"));
  mkdirSync(dirname(output), { recursive: true });
  const work = mkdtempSync(join(dirname(output), ".stugu-host-bundle-"));
  try {
    const input = join(work, "input");
    mkdirSync(input, { mode: 0o700 });
    const inputFiles = {
      boot: join(input, "boot.img"),
      root: join(input, "system.img"),
      sbom: join(input, "stugu-host-sbom.spdx.json"),
      provenance: join(input, "stugu-host-provenance.intoto.jsonl"),
      containerManifest: join(input, "stugu-release-manifest-v1.json"),
      tufRoot: join(input, "stugu-host-tuf-root.json"),
      raucCa: join(input, "stugu-host-rauc-ca.pem"),
    };
    copyFileSync(boot, inputFiles.boot);
    copyFileSync(root, inputFiles.root);
    copyFileSync(sbom, inputFiles.sbom);
    copyFileSync(provenance, inputFiles.provenance);
    copyFileSync(containerManifest, inputFiles.containerManifest);
    copyFileSync(resolve(options.tufRoot), inputFiles.tufRoot);
    copyFileSync(resolve(options.raucSigningKeyring), inputFiles.raucCa);
    const bootSha256 = await sha256File(inputFiles.boot);
    const rootSha256 = await sha256File(inputFiles.root);
    validateContainerReleaseManifest(
      boundedJson(inputFiles.containerManifest, "container release manifest", 128 * 1024),
      options.version,
    );
    validateSpdxSbom(boundedJson(inputFiles.sbom, "host SBOM", 128 * 1024 * 1024));
    if (statSync(inputFiles.provenance).size > 16 * 1024 * 1024) {
      throw new Error("host provenance exceeds its size limit");
    }
    const provenanceLines = readFileSync(inputFiles.provenance, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
    if (provenanceLines.length !== 1) {
      throw new Error("host provenance must contain exactly one statement");
    }
    let provenanceStatement;
    try {
      provenanceStatement = JSON.parse(provenanceLines[0]);
    } catch (error) {
      throw new Error("host provenance is not valid JSONL", { cause: error });
    }
    validateHostProvenance(provenanceStatement, {
      bootSha256,
      rootSha256,
      sourceCommit: options.sourceCommit,
      version: options.version,
      hostGeneration: boundedInteger(options.generation, "host generation"),
      tufRootSha256: await sha256File(inputFiles.tufRoot),
      raucCaSha256: await sha256File(inputFiles.raucCa),
    });
    const manifest = hostReleaseManifest({
      version: options.version,
      hostGeneration: boundedInteger(options.generation, "host generation"),
      minimumFallbackGeneration: boundedInteger(
        options.fallbackGeneration,
        "fallback generation",
      ),
      minEeprom: options.minEeprom,
      bootShimGeneration: boundedInteger(options.bootShimGeneration, "boot shim generation", 1),
      minimumUpdaterContract: boundedInteger(
        options.minimumUpdaterContract,
        "minimum updater contract",
        4,
      ),
      resultUpdaterContract: boundedInteger(
        options.resultUpdaterContract,
        "result updater contract",
        4,
      ),
      requiresRecoveryClassUpdate: booleanValue(
        options.recoveryClassUpdate,
        "recovery class update",
      ),
      dataEpoch,
      readableEpochs,
      dataRollback: options.dataRollback,
      dockerEpoch: boundedInteger(options.dockerEpoch, "Docker epoch", 1),
      tailscaleEpoch: boundedInteger(options.tailscaleEpoch, "Tailscale epoch", 1),
      containerManifestSha256: await sha256File(inputFiles.containerManifest),
      boot: { sha256: bootSha256, size: statSync(inputFiles.boot).size },
      root: { sha256: rootSha256, size: statSync(inputFiles.root).size },
      sbom: {
        filename: basename(inputFiles.sbom),
        sha256: await sha256File(inputFiles.sbom),
      },
      provenance: {
        filename: basename(inputFiles.provenance),
        sha256: await sha256File(inputFiles.provenance),
      },
      sourceCommit: options.sourceCommit,
    });
    writeFileSync(join(input, "stugu-host-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(input, "manifest.raucm"), raucManifest(options.version));
    const temporaryBundle = join(work, "bundle.raucb");
    const signerBackend = join(work, "signer-boot-backend");
    writeFileSync(signerBackend, "#!/bin/sh\nprintf 'a\\n'\n", { mode: 0o700 });
    const signerConfig = join(work, "signer-system.conf");
    writeFileSync(signerConfig, `[system]
compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64
bootloader=custom

[keyring]
path=${inputFiles.raucCa}
check-purpose=codesign

[handlers]
bootloader-custom-backend=${signerBackend}
`);
    invoke("rauc", [
      `--conf=${signerConfig}`,
      `--cert=${options.raucCert}`,
      `--key=${options.raucKey}`,
      `--signing-keyring=${inputFiles.raucCa}`,
      "bundle",
      input,
      temporaryBundle,
    ]);
    const infoOutput = invoke("rauc", [
      `--conf=${signerConfig}`,
      `--keyring=${inputFiles.raucCa}`,
      "info",
      "--output-format=json-2",
      temporaryBundle,
    ]);
    let info;
    try {
      info = JSON.parse(infoOutput);
    } catch (error) {
      throw new Error("RAUC verification did not return JSON", { cause: error });
    }
    verifyRaucInfo(info, manifest);
    const request = tufTargetRequest({
      manifest,
      channel: options.channel,
      length: statSync(temporaryBundle).size,
      sha256: await sha256File(temporaryBundle),
    });
    const temporaryRequest = join(work, "bundle.raucb.tuf-target.json");
    chmodSync(temporaryBundle, 0o444);
    writeFileSync(temporaryRequest, `${JSON.stringify(request, null, 2)}\n`, {
      mode: 0o444,
      flag: "wx",
    });
    syncPath(temporaryBundle);
    syncPath(temporaryRequest);
    publishExclusive(temporaryBundle, output);
    publishExclusive(temporaryRequest, `${output}.tuf-target.json`);
    console.log(`Signed RAUC bundle: ${output}`);
    console.log(`TUF signing request: ${output}.tuf-target.json`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
