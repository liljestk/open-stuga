import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const NEXUS433_UPSTREAM = Object.freeze({
  commit: "eb5f8bd87cc77ce89074d9144af19a5b2b9cc175",
  version: "v2.0.0-stugu-eb5f8bd",
  archiveUrl:
    "https://github.com/aquaticus/nexus433/archive/eb5f8bd87cc77ce89074d9144af19a5b2b9cc175.tar.gz",
  archiveSha256: "6f88074428738e4ffbdfa880bde84e4eada5a14a308c3f25cd52643ac445fcf8",
});

const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;
const buildFiles = [
  "deploy/nexus433/Dockerfile",
  "deploy/nexus433/entrypoint.sh",
  "deploy/nexus433/NOTICE.md",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`Invalid Stugu release version: ${value}`);
  }
  return value;
}

export function nexus433SourceArtifactNames(releaseVersion) {
  const version = safeVersion(releaseVersion);
  const bundle = `stugu-nexus433-corresponding-source-${version}.tar.gz`;
  return { bundle, checksum: `${bundle}.sha256` };
}

function regularFile(path) {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Corresponding-source input must be a regular file: ${path}`);
  }
  return readFileSync(path);
}

function correspondingSourceFiles(repositoryRoot) {
  const patchDirectory = resolve(repositoryRoot, "deploy/nexus433/patches");
  const entries = readdirSync(patchDirectory, { withFileTypes: true });
  if (
    entries.length === 0
    || entries.some((entry) =>
      !entry.isFile() || !/^\d{4}-[a-z0-9-]+\.patch$/u.test(entry.name))
  ) {
    throw new Error("Nexus433 patch directory contains missing or unexpected entries");
  }
  return [
    ...buildFiles,
    ...entries
      .map((entry) => `deploy/nexus433/patches/${entry.name}`)
      .sort(),
  ];
}

function writeOctal(header, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error("Tar numeric field overflow");
  header.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarPathFields(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Tar path is too long: ${path}`);
}

function tarHeader(path, bytes) {
  const header = Buffer.alloc(512);
  const fields = tarPathFields(path);
  header.write(fields.name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  if (fields.prefix) header.write(fields.prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function deterministicTarGzip(entries) {
  const parts = [];
  const ordered = [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  for (const [path, value] of ordered) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    parts.push(tarHeader(path, bytes), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
}

function readme(upstream) {
  return `# Nexus433 corresponding source\n\nThis bundle accompanies Stugu's ${upstream.version} Nexus433 image. It contains\nthe exact verified upstream archive, every Stugu patch, and the build/runtime\nfiles used for the image. Nexus433 is licensed under GPL-3.0.\n\nVerify all inputs:\n\n    sha256sum --check SHA256SUMS\n\nRebuild on Debian Trixie after installing build-essential, cmake, git,\nlibgpiod-dev, and libmosquittopp-dev:\n\n    tar -xzf upstream/nexus433-${upstream.commit}.tar.gz\n    cd nexus433-${upstream.commit}\n    sed -i 's/\\r$//' config.cpp config.h main.cpp\n    git apply ../deploy/nexus433/patches/*.patch\n    cmake -S . -B build -DCMAKE_BUILD_TYPE=RELEASE \\\n      -DENABLE_FAKE_TRANSMITTER=OFF \\\n      -DNEXUS433_BUILD_VERSION=${upstream.version}\n    cmake --build build --parallel\n\nThe included Dockerfile records the pinned Debian base and complete image build.\nIts paths are relative to this bundle root.\n`;
}

async function downloadArchive(upstream, fetchImpl) {
  const response = await fetchImpl(upstream.archiveUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Nexus433 source download failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    throw new Error("Nexus433 source archive exceeds the size limit");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length === 0 || archive.length > MAX_UPSTREAM_BYTES) {
    throw new Error("Nexus433 source archive is empty or exceeds the size limit");
  }
  const actualHash = sha256(archive);
  if (actualHash !== upstream.archiveSha256) {
    throw new Error(`Nexus433 source hash mismatch: ${actualHash}`);
  }
  return archive;
}

export async function buildNexus433SourceBundle({
  repositoryRoot,
  releaseVersion,
  outputDirectory,
  fetchImpl = fetch,
  upstream = NEXUS433_UPSTREAM,
}) {
  const version = safeVersion(releaseVersion);
  const archive = await downloadArchive(upstream, fetchImpl);
  const directory = `stugu-nexus433-corresponding-source-${version}`;
  const sourceFiles = correspondingSourceFiles(repositoryRoot);
  const entries = sourceFiles.map((path) => [
    `${directory}/${path}`,
    regularFile(resolve(repositoryRoot, path)),
  ]);
  entries.push([
    `${directory}/upstream/nexus433-${upstream.commit}.tar.gz`,
    archive,
  ]);
  entries.push([`${directory}/README.md`, readme(upstream)]);

  const manifest = {
    schema: "stugu-nexus433-corresponding-source/v1",
    component: "aquaticus/nexus433",
    stuguRelease: version,
    upstream,
    includedBuildFiles: sourceFiles,
  };
  entries.push([
    `${directory}/SOURCE-MANIFEST.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  ]);

  const sums = entries
    .map(([path, value]) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
      return `${sha256(bytes)}  ${path.slice(directory.length + 1)}`;
    })
    .sort()
    .join("\n");
  entries.push([`${directory}/SHA256SUMS`, `${sums}\n`]);

  const names = nexus433SourceArtifactNames(version);
  const bundlePath = resolve(outputDirectory, names.bundle);
  const checksumPath = resolve(outputDirectory, names.checksum);
  mkdirSync(outputDirectory, { recursive: true });
  const bundle = deterministicTarGzip(entries);
  const bundleHash = sha256(bundle);
  writeFileSync(bundlePath, bundle, { mode: 0o644 });
  writeFileSync(checksumPath, `${bundleHash}  ${basename(bundlePath)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return { bundlePath, checksumPath, sha256: bundleHash };
}

function cliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--version" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.version || !options.output) {
    throw new Error("Usage: build-nexus433-source-bundle.mjs --version X.Y.Z --output PATH");
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = cliArguments(argv);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await buildNexus433SourceBundle({
    repositoryRoot,
    releaseVersion: options.version,
    outputDirectory: resolve(options.output),
  });
  console.log(`${result.bundlePath}\n${result.checksumPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
