import { describe, expect, it } from "vitest";
import { roomLabelPoint } from "./roomLabelPlacement";

describe("room label placement", () => {
  const center = { x: 400, y: 300 };

  it("keeps the name at the centroid when no sensor marker covers it", () => {
    expect(roomLabelPoint({ name: "Kitchen", center, roomTop: 100, markers: [{ x: 600, y: 300 }] })).toEqual(center);
  });

  it("moves the name above a marker that sits on it", () => {
    expect(roomLabelPoint({ name: "Kitchen", center, roomTop: 100, markers: [{ x: 410, y: 305 }] })).toEqual({ x: 400, y: 267 });
  });

  it("keeps a moved name inside the room", () => {
    expect(roomLabelPoint({ name: "Kitchen", center: { x: 400, y: 130 }, roomTop: 100, markers: [{ x: 400, y: 130 }] })).toEqual({ x: 400, y: 119 });
  });
});
