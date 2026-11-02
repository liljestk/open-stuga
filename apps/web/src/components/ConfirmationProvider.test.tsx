import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ConfirmationProvider, confirmAction } from "./ConfirmationProvider";

const productionUiSources = import.meta.glob(
  [
    "../components/**/*.tsx",
    "../pages/**/*.tsx",
    "!../components/**/*.test.tsx",
    "!../pages/**/*.test.tsx",
    "!../pages/**/*TestSupport.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function Harness() {
  return <button type="button" onClick={async (event) => {
    const trigger = event.currentTarget;
    const confirmed = await confirmAction("Remove this connection and its saved credentials?", "Remove connection");
    trigger.dataset.result = String(confirmed);
  }}>Remove connection</button>;
}

function QueuedHarness() {
  const secondTriggerRef = useRef<HTMLButtonElement>(null);
  return <>
    <button type="button" onClick={async (event) => {
      const firstTrigger = event.currentTarget;
      const first = confirmAction("Apply the first change?", "Apply first", false);
      secondTriggerRef.current?.focus();
      const second = confirmAction("Apply the second change?", "Apply second", false);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      firstTrigger.dataset.results = `${firstResult},${secondResult}`;
    }}>Queue confirmations</button>
    <button ref={secondTriggerRef} type="button">Second trigger</button>
  </>;
}

function SequentialHarness() {
  return <>
    <button type="button" onClick={async (event) => {
      event.currentTarget.dataset.result = String(await confirmAction("Apply the first change?", "Apply first", false));
    }}>First change</button>
    <button type="button" onClick={async (event) => {
      event.currentTarget.dataset.result = String(await confirmAction("Apply the second change?", "Apply second", false));
    }}>Second change</button>
  </>;
}

function renderHarness() {
  return render(<I18nProvider><ConfirmationProvider><Harness /></ConfirmationProvider></I18nProvider>);
}

describe("ConfirmationProvider", () => {
  it("routes every enumerated production confirmation through the shared dialog", () => {
    const source = Object.values(productionUiSources).join("\n");
    expect(source).not.toContain("window.confirm(");
    expect(source.match(/confirmAction\(/g)).toHaveLength(44);
  });

  it("fails closed without a mounted provider", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");

    await expect(confirmAction("Remove the connection?", "Remove connection")).resolves.toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("keeps the safer choice focused and resolves an explicit confirmation", async () => {
    const user = userEvent.setup();
    renderHarness();
    const trigger = screen.getByRole("button", { name: "Remove connection" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Remove this connection and its saved credentials?");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Remove connection" }));
    expect(trigger).toHaveAttribute("data-result", "true");
    expect(trigger).toHaveFocus();
  });

  it("cancels with Escape without calling the browser confirmation API", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    renderHarness();
    const trigger = screen.getByRole("button", { name: "Remove connection" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(trigger).toHaveAttribute("data-result", "false");
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("retains each queued request's original return-focus target", async () => {
    const user = userEvent.setup();
    render(<I18nProvider><ConfirmationProvider><QueuedHarness /></ConfirmationProvider></I18nProvider>);
    const queueTrigger = screen.getByRole("button", { name: "Queue confirmations" });
    const secondTrigger = screen.getByRole("button", { name: "Second trigger" });

    await user.click(queueTrigger);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Apply the first change?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Apply first" }));

    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Apply the second change?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(secondTrigger).toHaveFocus();
    expect(queueTrigger).toHaveAttribute("data-results", "true,false");
  });

  it("opens a later confirmation after the previous request has settled", async () => {
    const user = userEvent.setup();
    render(<I18nProvider><ConfirmationProvider><SequentialHarness /></ConfirmationProvider></I18nProvider>);
    const firstTrigger = screen.getByRole("button", { name: "First change" });
    const secondTrigger = screen.getByRole("button", { name: "Second change" });

    await user.click(firstTrigger);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply first" }));
    expect(firstTrigger).toHaveAttribute("data-result", "true");

    await user.click(secondTrigger);
    const secondDialog = screen.getByRole("dialog");
    expect(within(secondDialog).getByText("Apply the second change?")).toBeTruthy();
    await user.click(within(secondDialog).getByRole("button", { name: "Cancel" }));
    expect(secondTrigger).toHaveAttribute("data-result", "false");
  });
});
