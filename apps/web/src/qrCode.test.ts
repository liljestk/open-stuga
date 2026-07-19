import { describe, expect, it } from "vitest";
import { qrCodeMatrix } from "./qrCode";

describe("local sensor-label QR encoder", () => {
  it("creates a deterministic Version 6 symbol with standard finder patterns", () => {
    const first = qrCodeMatrix("stuga://sensor/sensor-01?house=house-main");
    const second = qrCodeMatrix("stuga://sensor/sensor-01?house=house-main");
    expect(first).toEqual(second);
    expect(first).toHaveLength(41);
    expect(first.every((row) => row.length === 41)).toBe(true);
    for (const [x, y] of [[0, 0], [6, 0], [0, 6], [34, 0], [40, 6], [0, 34], [6, 40]] as const) {
      expect(first[y]![x]).toBe(true);
    }
    expect(first[1]![1]).toBe(false);
    expect(first[3]![3]).toBe(true);
  });

  it("encodes different setup URIs differently and enforces the offline profile capacity", () => {
    expect(qrCodeMatrix("stuga://sensor/a?house=one")).not.toEqual(qrCodeMatrix("stuga://sensor/b?house=one"));
    expect(() => qrCodeMatrix("x".repeat(135))).toThrow(/too long/i);
  });
});
