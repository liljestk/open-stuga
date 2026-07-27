import { render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import axe from "axe-core";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StugubyShareGrant, StugubySummary } from "@climate-twin/stuguby-protocol";

import { api, type StugubyDetailResponse, type StugubyListResponse } from "../api";

import { I18nProvider } from "../i18n";

import { localDateTimeInput, StugubyPage } from "./StugubyPage";

import { detail, identity, localGrant, mockLoadedStugubys, summary } from "./StugubyPageTestSupport";

afterEach(() => vi.restoreAllMocks());

describe("StugubyPage", () => {
  it("rejects a half-entered shared-property coordinate", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const update = vi.spyOn(api, "updateStugubyProperty");

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    await user.click(await screen.findByText("Shared property"));
    await user.type(await screen.findByLabelText("Latitude"), "60.17");
    await user.click(screen.getByRole("button", { name: "Save revision 2" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter both latitude and longitude");
    expect(update).not.toHaveBeenCalled();
  });

  it("converts UTC expiry instants to datetime-local wall time", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-180);
    expect(localDateTimeInput("2026-07-24T10:00:00.000Z")).toBe("2026-07-24T13:00");
  });
});
