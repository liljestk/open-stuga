import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientUuid } from "./clientUuid";

afterEach(() => vi.unstubAllGlobals());

describe("createClientUuid", () => {
  it("uses the browser UUID implementation when it is available", () => {
    const uuid = "12345678-1234-4234-9234-123456789abc";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => uuid) });

    expect(createClientUuid()).toBe(uuid);
  });

  it("creates a valid v4 UUID when randomUUID is unavailable on LAN HTTP", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });

    expect(createClientUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
