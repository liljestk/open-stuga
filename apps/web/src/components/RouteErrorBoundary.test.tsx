import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

function BrokenRoute(): never {
  throw new Error("chunk failed");
}

describe("RouteErrorBoundary", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

  it("contains a route failure and offers an explicit reload", () => {
    const reload = vi.fn();
    render(
      <RouteErrorBoundary
        resetKey="alerts:house-one"
        onReload={reload}
        renderFallback={(retry) => <button onClick={retry}>Reload Stuga</button>}
      >
        <BrokenRoute />
      </RouteErrorBoundary>,
    );

    const announcement = screen.getByRole("alert");
    expect(announcement.getAttribute("aria-atomic")).toBe("true");
    expect(announcement.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(announcement);

    fireEvent.click(screen.getByRole("button", { name: "Reload Stuga" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recovers when navigation changes the reset key", () => {
    const { rerender } = render(
      <RouteErrorBoundary
        resetKey="alerts:house-one"
        onReload={() => undefined}
        renderFallback={() => <p>Route failed</p>}
      >
        <BrokenRoute />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("Route failed")).not.toBeNull();

    rerender(
      <RouteErrorBoundary
        resetKey="sensors:house-one"
        onReload={() => undefined}
        renderFallback={() => <p>Route failed</p>}
      >
        <p>Recovered route</p>
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("Recovered route")).not.toBeNull();
  });
});
