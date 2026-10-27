import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TAPO_HISTORY_API_IMPLEMENTATION_SHA256,
  TAPO_HISTORY_API_ROOT_DIRECTORY,
  apiImplementationSha256,
} from "../src/tapo-history-export/support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";

describe("Tapo canary implementation digest", () => {
  it("hashes the whole API build rather than the Tapo export folder", () => {
    expect(existsSync(join(TAPO_HISTORY_API_ROOT_DIRECTORY, "app", "main.ts"))
      || existsSync(join(TAPO_HISTORY_API_ROOT_DIRECTORY, "app", "main.js"))).toBe(true);
    expect(TAPO_HISTORY_API_IMPLEMENTATION_SHA256).toBe(apiImplementationSha256(TAPO_HISTORY_API_ROOT_DIRECTORY));
    expect(TAPO_HISTORY_API_IMPLEMENTATION_SHA256)
      .not.toBe(apiImplementationSha256(join(TAPO_HISTORY_API_ROOT_DIRECTORY, "tapo-history-export")));
  });
});
