import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TenantMemberRole } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { PeopleAccessPage } from "./PeopleAccessPage";

afterEach(() => vi.restoreAllMocks());

describe("People & access permissions", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
    ["guest", false],
    ["service", false],
  ] satisfies Array<[TenantMemberRole, boolean]>) (
    "renders the workspace administration surface for %s: %s",
    async (role, allowed) => {
      const state = createDemoState();
      state.session = {
        ...state.session,
        tenant: { ...state.session.tenant, role },
        readOnly: role === "guest",
      };
      const tenantMembers = vi.spyOn(api, "tenantMembers").mockResolvedValue({ members: [], invitations: [] });

      render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);

      if (allowed) {
        expect(screen.getByRole("heading", { level: 1, name: "People & access" })).toBeInTheDocument();
        await waitFor(() => expect(tenantMembers).toHaveBeenCalledOnce());
        expect(await screen.findByText("No guest accounts have been invited.")).toBeInTheDocument();
      } else {
        expect(screen.getByRole("heading", { level: 1, name: "Administrator access required" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1, name: "People & access" })).toBeNull();
        expect(tenantMembers).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps an invalid guest email on the client", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    vi.spyOn(api, "tenantMembers").mockResolvedValue({ members: [], invitations: [] });
    const inviteGuest = vi.spyOn(api, "inviteGuest");
    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);
    await screen.findByText("No guest accounts have been invited.");

    const inviteDetails = screen.getByText("Add a guest").closest("details")!;
    expect(inviteDetails.open).toBe(false);
    await user.click(screen.getByText("Add a guest"));
    expect(inviteDetails.open).toBe(true);
    await user.type(screen.getByLabelText("Guest email address"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Invite guest" }));

    expect(inviteGuest).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Guest email address")).toBeInvalid();
  });
});
