import { act, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { expect, it, vi } from "vitest";
import { useAnalyticsBrush } from "./useAnalyticsBrush";

it("requires a deliberate drag and keeps a plain chart click from drafting a range", () => {
  const onSelect = vi.fn();
  const target = { getBoundingClientRect: () => ({ left: 0, width: 200 }), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
  const event = (x: number) => ({ button: 0, clientX: x, pointerId: 1, currentTarget: target }) as unknown as PointerEvent<SVGSVGElement>;
  const { result } = renderHook(() => useAnalyticsBrush({ from: 0, to: 3_600_000, endLimit: 3_600_000, width: 200, left: 0, right: 0, onSelect }));
  act(() => result.current.down(event(20)));
  act(() => result.current.up(event(20)));
  expect(onSelect).not.toHaveBeenCalled();
  act(() => result.current.down(event(20)));
  act(() => result.current.move(event(100)));
  act(() => result.current.up(event(100)));
  expect(onSelect).toHaveBeenCalledWith({ start: "1970-01-01T00:06:00.000Z", end: "1970-01-01T00:30:00.000Z" });
});
