import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { NasExportSetupPanel } from "./NasExportSetupPanel";

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

afterEach(() => vi.restoreAllMocks());

describe("NasExportSetupPanel", () => {
  it("preserves primary storage while queuing the shared NAS destination", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    const status = {
      settings: { timeseries: { kind: "managed" as const, path: null }, backups: { kind: "managed" as const, path: null } },
      revision: "storage-revision",
      allowedRoots: ["/mnt/stugu"],
      capability: { available: true, runtime: "docker" as const, agentLastSeenAt: "2026-08-02T12:00:00.000Z", reason: "ready" as const, detail: null },
      operation: null,
    };
    vi.spyOn(api, "systemStorageStatus").mockResolvedValue(status);
    const update = vi.spyOn(api, "updateSystemStorage").mockResolvedValue(status);
    const user = userEvent.setup();

    render(<I18nProvider><NasExportSetupPanel /></I18nProvider>);

    const path = await screen.findByRole("textbox", { name: /^Mounted NAS path/u });
    await user.clear(path);
    await user.type(path, "/mnt/stugu/home-nas");
    await user.click(screen.getByRole("button", { name: "Apply NAS destination" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      settings: {
        timeseries: { kind: "managed", path: null },
        backups: { kind: "nas-path", path: "/mnt/stugu/home-nas" },
      },
      expectedRevision: "storage-revision",
      confirmation: "APPLY_STORAGE",
    }));
  });
});
