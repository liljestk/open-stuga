import { render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StugubyShareGrant } from "@climate-twin/stuguby-protocol";

import { api } from "../api";
import { ConfirmationProvider } from "../components/ConfirmationProvider";

import { I18nProvider } from "../i18n";

import { localDateTimeInput, StugubyPage } from "./StugubyPage";

import { detail, identity, mockLoadedStugubys, summary } from "./StugubyPageTestSupport";

afterEach(() => vi.restoreAllMocks());

describe("StugubyPage", () => {
  it("does not create a precise-location grant after the page unmounts during confirmation", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const createGrant = vi.spyOn(api, "createStugubyGrant").mockResolvedValue({} as StugubyShareGrant);

    const view = render(
      <I18nProvider>
        <ConfirmationProvider>
          <StugubyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} />
        </ConfirmationProvider>
      </I18nProvider>,
    );

    await screen.findByRole("button", { name: "Start sharing" });
    await user.click(screen.getByText("Customize what is shared"));
    await user.click(screen.getByRole("checkbox", { name: /^Precise location home\.location/ }));
    await user.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(await screen.findByRole("heading", { name: "Share location" })).toBeTruthy();

    view.rerender(
      <I18nProvider>
        <ConfirmationProvider>
          <main><h1>Elsewhere</h1></main>
        </ConfirmationProvider>
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Share location" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Share location" })).toBeNull());
    expect(createGrant).not.toHaveBeenCalled();
    expect(api.syncStuguby).not.toHaveBeenCalled();
  });

  it("does not delete a Stuguby after the page unmounts during confirmation", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const remove = vi.spyOn(api, "deleteStuguby");

    const view = render(
      <I18nProvider>
        <ConfirmationProvider>
          <StugubyPage houses={[]} />
        </ConfirmationProvider>
      </I18nProvider>,
    );

    const summaryCard = (await screen.findByText("Automatic sync")).closest("section");
    expect(summaryCard).not.toBeNull();
    await user.click(within(summaryCard!).getByText("Advanced"));
    await user.click(within(summaryCard!).getByRole("button", { name: "Delete Stuguby" }));
    expect(await screen.findByRole("heading", { name: "Delete" })).toBeTruthy();

    view.rerender(
      <I18nProvider>
        <ConfirmationProvider>
          <main><h1>Elsewhere</h1></main>
        </ConfirmationProvider>
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Delete" })).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not apply a deferred confirmation after selecting another Stuguby", async () => {
    const user = userEvent.setup();
    const first = summary("stuguby-a", "North grounds");
    const second = summary("stuguby-b", "South grounds");
    mockLoadedStugubys([first, second], {
      [first.id]: detail(first),
      [second.id]: detail(second),
    });
    const remove = vi.spyOn(api, "deleteStuguby");

    render(
      <I18nProvider>
        <ConfirmationProvider>
          <StugubyPage houses={[]} />
        </ConfirmationProvider>
      </I18nProvider>,
    );

    const summaryCard = (await screen.findByText("Automatic sync")).closest("section");
    expect(summaryCard).not.toBeNull();
    await user.click(within(summaryCard!).getByText("Advanced"));
    await user.click(within(summaryCard!).getByRole("button", { name: "Delete Stuguby" }));
    expect(await screen.findByRole("heading", { name: "Delete" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /South grounds/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /South grounds/ })).toHaveAttribute("aria-current", "true"));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Delete" })).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a deferred confirmation valid across a same-Stuguby refresh", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const listStugubys = vi.mocked(api.stugubys);
    const remove = vi.spyOn(api, "deleteStuguby").mockImplementation(async () => {
      listStugubys.mockResolvedValue({ identity, publicOrigin: "https://stugu.example.test", stugubys: [] });
    });

    render(
      <I18nProvider>
        <ConfirmationProvider>
          <StugubyPage houses={[]} />
        </ConfirmationProvider>
      </I18nProvider>,
    );

    const summaryCard = (await screen.findByText("Automatic sync")).closest("section");
    expect(summaryCard).not.toBeNull();
    await user.click(within(summaryCard!).getByText("Advanced"));
    await user.click(within(summaryCard!).getByRole("button", { name: "Delete Stuguby" }));
    expect(await screen.findByRole("heading", { name: "Delete" })).toBeTruthy();

    await user.click(within(summaryCard!).getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(api.stuguby).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(stuguby.id));
  });

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
