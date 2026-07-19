import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import type { HistoricalImportPreview, ImportSheet } from "../historicalImport";

const mocks = vi.hoisted(() => ({
  buildHistoricalImportAsync: vi.fn(),
  readHistoricalFile: vi.fn(),
}));

vi.mock("../historicalImport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../historicalImport")>();
  return {
    ...actual,
    buildHistoricalImportAsync: (...args: Parameters<typeof actual.buildHistoricalImportAsync>) => {
      const override = mocks.buildHistoricalImportAsync(...args);
      return override ?? actual.buildHistoricalImportAsync(...args);
    },
    readHistoricalFile: (...args: Parameters<typeof actual.readHistoricalFile>) => (
      mocks.readHistoricalFile(...args) ?? actual.readHistoricalFile(...args)
    ),
  };
});

import { HistoricalImportWizard } from "./HistoricalImportWizard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function importSheet(name: string, value: number): ImportSheet {
  return {
    name,
    rows: [
      ["Date and time", "Sensor", "Temperature"],
      ["2026-01-15 08:00", "Living room", value],
    ],
  };
}

function importPreview(value: number): HistoricalImportPreview {
  const timestamp = "2026-01-15T08:00:00.000Z";
  return {
    samples: [{
      sensorId: "sensor-living",
      metric: "temperature",
      value,
      canonicalUnit: "°C",
      timestamp,
      source: "import",
      quality: "good",
    }],
    issues: [],
    issueCount: 0,
    issueRowCount: 0,
    sourceRows: 1,
    usableRows: 1,
    skippedEmpty: 0,
    duplicatesInFile: 0,
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    sensorIds: ["sensor-living"],
    metricIds: ["temperature"],
  };
}

function ImportHarness() {
  const state = createDemoState();
  const house = state.houses[0]!;
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider>
      <button type="button" onClick={() => setOpen(true)}>Open import</button>
      <main data-testid="background"><a href="#background">Background link</a></main>
      <HistoricalImportWizard
        open={open}
        house={house}
        sensors={state.sensors.filter((sensor) => sensor.houseId === house.id)}
        definitions={state.measurementDefinitions}
        onClose={() => setOpen(false)}
        onImport={vi.fn().mockResolvedValue({ accepted: 0, ignoredDuplicates: 0 })}
      />
    </I18nProvider>
  );
}

describe("HistoricalImportWizard", () => {
  beforeEach(() => {
    mocks.buildHistoricalImportAsync.mockReset();
    mocks.readHistoricalFile.mockReset();
  });

  it("isolates the app, traps backward focus from the heading, and restores the opener", async () => {
    const user = userEvent.setup();
    render(<ImportHarness />);
    const opener = screen.getByRole("button", { name: "Open import" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog");
    const background = screen.getByTestId("background");
    await waitFor(() => expect(document.activeElement).toBe(dialog.querySelector("h2")));
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.hasAttribute("inert")).toBe(true);

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("link", { name: "Background link", hidden: true }));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
  });

  it("does not validate the full sheet until the review step", async () => {
    const user = userEvent.setup();
    const { container } = render(<ImportHarness />);
    await user.click(screen.getByRole("button", { name: "Open import" }));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File([
      "Date and time,Sensor,Temperature (C)\n",
      "2026-01-15 08:00,Living room,21.5\n",
    ], "history.csv", { type: "text/csv" }));

    const reviewButton = await screen.findByRole("button", { name: /review data/i });
    expect(mocks.buildHistoricalImportAsync).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByRole("combobox", { name: /date order/i }), "dmy");
    expect(mocks.buildHistoricalImportAsync).not.toHaveBeenCalled();

    await user.click(reviewButton);
    await waitFor(() => expect(mocks.buildHistoricalImportAsync).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/measurements ready/i)).not.toBeNull();
  });

  it("cancels a superseded preview and ignores its late result", async () => {
    const stalePreview = deferred<HistoricalImportPreview>();
    mocks.buildHistoricalImportAsync
      .mockReturnValueOnce(stalePreview.promise)
      .mockResolvedValueOnce(importPreview(22));
    const user = userEvent.setup();
    const { container } = render(<ImportHarness />);
    await user.click(screen.getByRole("button", { name: "Open import" }));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, new File([
      "Date and time,Sensor,Temperature (C)\n",
      "2026-01-15 08:00,Living room,21.5\n",
    ], "history.csv", { type: "text/csv" }));

    await user.click(await screen.findByRole("button", { name: /review data/i }));
    await waitFor(() => expect(mocks.buildHistoricalImportAsync).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /change matching/i }));
    await user.click(await screen.findByRole("button", { name: /review data/i }));

    expect(await screen.findByText("22 °C")).not.toBeNull();
    await act(async () => {
      stalePreview.resolve(importPreview(18));
      await stalePreview.promise;
    });

    expect(screen.getByText("22 °C")).not.toBeNull();
    expect(screen.queryByText("18 °C")).toBeNull();
  });

  it("keeps the newer file read active when an older read resolves late", async () => {
    const firstRead = deferred<ImportSheet[]>();
    const secondRead = deferred<ImportSheet[]>();
    mocks.readHistoricalFile
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);
    const user = userEvent.setup();
    const { container } = render(<ImportHarness />);
    await user.click(screen.getByRole("button", { name: "Open import" }));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, new File(["first"], "first.csv", { type: "text/csv" }));
    await user.upload(fileInput, new File(["second"], "second.csv", { type: "text/csv" }));

    await act(async () => {
      firstRead.resolve([importSheet("First", 18)]);
      await firstRead.promise;
    });
    expect(screen.queryByRole("button", { name: /review data/i })).toBeNull();
    expect((screen.getByRole("button", { name: /choose file/i }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      secondRead.resolve([importSheet("Second", 22)]);
      await secondRead.promise;
    });
    expect(await screen.findByRole("button", { name: /review data/i })).not.toBeNull();
    expect(screen.getByText("second.csv")).not.toBeNull();
    expect(screen.queryByText("first.csv")).toBeNull();
  });

  it("invalidates a pending read and resets loading and drag state across close and reopen", async () => {
    const staleRead = deferred<ImportSheet[]>();
    mocks.readHistoricalFile.mockReturnValueOnce(staleRead.promise);
    const user = userEvent.setup();
    const { container } = render(<ImportHarness />);
    const opener = screen.getByRole("button", { name: "Open import" });
    await user.click(opener);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, new File(["stale"], "stale.csv", { type: "text/csv" }));
    const dropzone = container.querySelector<HTMLElement>(".history-import-dropzone")!;
    fireEvent.dragEnter(dropzone);
    expect(dropzone.classList.contains("dragging")).toBe(true);

    await user.click(screen.getByRole("button", { name: /close historical data import/i }));
    await user.click(opener);

    const reopenedChooseFile = screen.getByRole("button", { name: /choose file/i }) as HTMLButtonElement;
    expect(reopenedChooseFile.disabled).toBe(false);
    expect(container.querySelector(".history-import-dropzone")?.classList.contains("dragging")).toBe(false);

    await act(async () => {
      staleRead.reject(new Error("stale read failed"));
      try { await staleRead.promise; } catch { /* loadFile handles this rejection */ }
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("stale.csv")).toBeNull();
    expect(reopenedChooseFile.disabled).toBe(false);
  });
});
