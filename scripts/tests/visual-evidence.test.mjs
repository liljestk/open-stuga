import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { validateVisualAcceptanceReceipt } from "../tooling/receipt-contracts.mjs";
import {
  assertPngDimensionsMatchViewport,
  parseVisualViewport,
  readPngDimensions,
} from "../tooling/visual-evidence.mjs";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const hex = (character = "a") => character.repeat(64);

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

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const pixels = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function visualReceipt(viewport) {
  return {
    schema: "stugu-visual-acceptance/v1",
    result: "passed",
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    renderedScreenChanges: true,
    reason: null,
    scenarios: [
      {
        surface: "web",
        route: "/",
        dataScenario: "representative public data",
        viewport,
        theme: "light",
        screenshot: { path: "home.png", sha256: hex() },
        workflow: "Open the home overview",
        result: "passed",
      },
    ],
  };
}

test("visual receipt viewports use canonical numeric WIDTHxHEIGHT", () => {
  const receipt = visualReceipt("1440x800");
  assert.equal(validateVisualAcceptanceReceipt(receipt), receipt);
  assert.deepEqual(parseVisualViewport("320x568"), {
    width: 320,
    height: 568,
  });

  for (const viewport of [
    "desktop-1440",
    "1440",
    "1440X800",
    "1440 x 800",
    "01440x800",
    "1440x0800",
    "0x800",
  ]) {
    assert.throws(
      () => validateVisualAcceptanceReceipt(visualReceipt(viewport)),
      /canonical WIDTHxHEIGHT/u,
    );
  }
});

test("portrait PNG evidence cannot satisfy a landscape desktop viewport", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-visual-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const screenshot = join(directory, "portrait.png");
  writeFileSync(screenshot, png(800, 1440));

  assert.deepEqual(readPngDimensions(screenshot), {
    width: 800,
    height: 1440,
  });
  assert.throws(
    () => assertPngDimensionsMatchViewport(screenshot, "1440x800"),
    /dimensions 800x1440 do not match viewport 1440x800/u,
  );
  assert.deepEqual(
    assertPngDimensionsMatchViewport(screenshot, "800x1440"),
    { width: 800, height: 1440 },
  );
});

test("PNG dimension evidence rejects malformed and truncated images", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-visual-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const complete = png(320, 568);
  const malformed = join(directory, "malformed.png");
  const corrupted = join(directory, "corrupted.png");
  const truncated = join(directory, "truncated.png");
  writeFileSync(malformed, Buffer.alloc(complete.length));
  const invalidHeader = Buffer.from(complete);
  invalidHeader[16] ^= 1;
  writeFileSync(corrupted, invalidHeader);
  writeFileSync(truncated, complete.subarray(0, complete.length - 6));

  assert.throws(
    () => readPngDimensions(malformed),
    /invalid PNG signature/u,
  );
  assert.throws(
    () => readPngDimensions(corrupted),
    /invalid PNG IHDR/u,
  );
  assert.throws(
    () => readPngDimensions(truncated),
    /truncated PNG/u,
  );
});
