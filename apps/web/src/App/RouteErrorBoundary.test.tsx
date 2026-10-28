import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

function RouteChunk({ failed }: Readonly<{ failed: boolean }>) {
  if (failed) throw new Error("Route chunk failed");
  return <h1>Recovered route</h1>;
}

describe("RouteErrorBoundary recovery", () => {
  it("focuses the fallback, exposes reload, and resets when navigation changes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReload = vi.fn();
    const fallback = (reload: () => void) => <section>
      <h1>Page could not be loaded</h1>
      <button type="button" onClick={reload}>Reload page</button>
    </section>;
    const view = render(<RouteErrorBoundary resetKey="route-a" onReload={onReload} renderFallback={fallback}>
      <RouteChunk failed />
    </RouteErrorBoundary>);

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(onReload).toHaveBeenCalledOnce();

    view.rerender(<RouteErrorBoundary resetKey="route-b" onReload={onReload} renderFallback={fallback}>
      <RouteChunk failed={false} />
    </RouteErrorBoundary>);
    expect(await screen.findByRole("heading", { level: 1, name: "Recovered route" })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
