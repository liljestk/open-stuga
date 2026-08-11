import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_IHDR_BYTES = 33;
const PNG_MAX_DIMENSION = 0x7fffffff;
const PNG_MAX_CHUNKS = 4_096;
const PNG_MAX_FILE_BYTES = 256 * 1024 * 1024;
const VIEWPORT = /^([1-9]\d{0,9})x([1-9]\d{0,9})$/u;

function crc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function readExact(descriptor, length, position, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (count === 0) throw new Error(`${label} is a truncated PNG`);
    offset += count;
  }
  return buffer;
}

function validIhdrFormat(header) {
  const bitDepth = header[24];
  const colorType = header[25];
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  return (
    validDepths.get(colorType)?.has(bitDepth) === true &&
    header[26] === 0 &&
    header[27] === 0 &&
    (header[28] === 0 || header[28] === 1)
  );
}

export function parseVisualViewport(value, label = "visual viewport") {
  const match = typeof value === "string" ? VIEWPORT.exec(value) : null;
  if (!match) {
    throw new Error(`${label} must use canonical WIDTHxHEIGHT pixels`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > PNG_MAX_DIMENSION ||
    height > PNG_MAX_DIMENSION
  ) {
    throw new Error(`${label} dimensions are outside the PNG range`);
  }
  return { width, height };
}

export function readPngDimensions(path, label = "visual screenshot") {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error(`${label} must be a regular PNG file`);
    if (details.size < PNG_IHDR_BYTES) {
      throw new Error(`${label} is a truncated PNG`);
    }
    if (details.size > PNG_MAX_FILE_BYTES) {
      throw new Error(`${label} exceeds the bounded PNG evidence limit`);
    }

    const header = readExact(descriptor, PNG_IHDR_BYTES, 0, label);
    if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`${label} has an invalid PNG signature`);
    }
    if (
      header.readUInt32BE(8) !== 13 ||
      header.toString("ascii", 12, 16) !== "IHDR" ||
      !validIhdrFormat(header) ||
      header.readUInt32BE(29) !== crc32(header.subarray(12, 29))
    ) {
      throw new Error(`${label} has an invalid PNG IHDR chunk`);
    }

    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (
      width === 0 ||
      height === 0 ||
      width > PNG_MAX_DIMENSION ||
      height > PNG_MAX_DIMENSION
    ) {
      throw new Error(`${label} has invalid PNG dimensions`);
    }

    let position = PNG_IHDR_BYTES;
    let hasImageData = false;
    for (let chunk = 0; chunk < PNG_MAX_CHUNKS; chunk += 1) {
      if (position === details.size) break;
      const chunkHeader = readExact(descriptor, 8, position, label);
      const length = chunkHeader.readUInt32BE(0);
      const type = chunkHeader.toString("ascii", 4, 8);
      if (!/^[A-Za-z]{4}$/u.test(type)) {
        throw new Error(`${label} has an invalid PNG chunk type`);
      }
      const next = position + 12 + length;
      if (!Number.isSafeInteger(next) || next > details.size) {
        throw new Error(`${label} is a truncated PNG`);
      }
      if (type === "IDAT") hasImageData = true;
      if (type === "IEND") {
        if (length !== 0 || next !== details.size || !hasImageData) {
          throw new Error(`${label} has an invalid PNG ending`);
        }
        return { width, height };
      }
      position = next;
    }
    throw new Error(`${label} has no bounded PNG ending`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertPngDimensionsMatchViewport(
  path,
  viewport,
  label = "visual screenshot",
) {
  const expected = parseVisualViewport(viewport, `${label} viewport`);
  const actual = readPngDimensions(path, label);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `${label} dimensions ${actual.width}x${actual.height} do not match viewport ${viewport}`,
    );
  }
  return actual;
}
