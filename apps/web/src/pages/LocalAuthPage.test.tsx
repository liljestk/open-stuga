import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../api";
import { I18nProvider } from "../i18n";
import {
  clearInvitationBootstrapStorage,
  clearInvitationFragment,
  invitationTokenFromBootstrapStorage,
  invitationTokenFromFragment,
  LocalAuthPage,
} from "./LocalAuthPage";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

function renderPage(props: React.ComponentProps<typeof LocalAuthPage>) {
  return render(<I18nProvider><LocalAuthPage {...props} /></I18nProvider>);
}

const session = {
  authenticated: true,
  principal: { type: "local", email: "owner@example.test" },
  tenant: { id: "local", name: "Local Stuga", role: "owner" as const },
  availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" as const }],
  readOnly: false,
  grants: [],
  csrfToken: "csrf",
};

describe("LocalAuthPage", () => {
  it("reads invitations only from the fragment and clears the fragment separately", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.history.replaceState(null, "", "/?invite=query-token#invite=abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");

    expect(invitationTokenFromFragment()).toBe("abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");
    expect(window.location.hash).not.toBe("");
    clearInvitationFragment();

    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?invite=query-token");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(invitationTokenFromFragment("?invite=query-token")).toBeNull();
  });

  it("reads and then explicitly clears a Cloudflare bootstrap token from tab-scoped storage", () => {
    window.sessionStorage.setItem("stuga-invitation-token", "abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");

    expect(invitationTokenFromBootstrapStorage()).toBe("abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");
    expect(invitationTokenFromBootstrapStorage()).toBe("abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");
    clearInvitationBootstrapStorage();
    expect(window.sessionStorage.getItem("stuga-invitation-token")).toBeNull();
    expect(invitationTokenFromBootstrapStorage()).toBeNull();
  });

  it("requires matching passwords before creating the first owner", async () => {
    const setupOwner = vi.spyOn(api, "setupOwner").mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    renderPage({ mode: "setup", onAuthenticated });

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different password value" } });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));

    expect(screen.getByRole("alert").textContent).toBe("The passwords do not match.");
    expect(setupOwner).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));
    await waitFor(() => expect(setupOwner).toHaveBeenCalledWith({ email: "owner@example.test", password: "correct horse battery staple" }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("refreshes session state when another request wins the first-owner setup race", async () => {
    vi.spyOn(api, "setupOwner").mockRejectedValue(new ApiRequestError(409, "AUTH_ALREADY_INITIALIZED", "Already initialized"));
    const onAuthStateChanged = vi.fn();
    renderPage({ mode: "setup", onAuthenticated: vi.fn(), onAuthStateChanged });

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));

    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledOnce());
  });

  it("shows sign-out uncertainty without attempting an automatic request", () => {
    renderPage({ mode: "login", noticeKey: "auth.logoutUncertain", onAuthenticated: vi.fn() });
    expect(screen.getByRole("alert").textContent).toContain("server could not confirm sign-out");
  });

  it("signs in with a local account", async () => {
    const user = userEvent.setup();
    const login = vi.spyOn(api, "login").mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    renderPage({ mode: "login", onAuthenticated });

    await user.type(screen.getByLabelText("Email"), "owner@example.test");
    await user.type(screen.getByLabelText(/^Password/), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: "owner@example.test", password: "correct horse battery staple" }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("allows a local workspace address without a public domain suffix", async () => {
    const user = userEvent.setup();
    const login = vi.spyOn(api, "login").mockResolvedValue(session);
    renderPage({ mode: "login", onAuthenticated: vi.fn() });

    await user.type(screen.getByLabelText("Email"), "owner@stuga");
    await user.type(screen.getByLabelText(/^Password/), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith({
      email: "owner@stuga",
      password: "correct horse battery staple",
    }));
  });

  it("activates an invited account with the in-memory fragment token", async () => {
    const register = vi.spyOn(api, "registerInvitation").mockResolvedValue({
      ...session,
      principal: { type: "local", email: "guest@example.test" },
      tenant: { ...session.tenant, role: "guest" },
      availableTenants: [{ ...session.availableTenants[0]!, role: "guest" }],
      readOnly: true,
    });
    const onAuthenticated = vi.fn();
    renderPage({ mode: "invitation", invitationToken: "abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF", onAuthenticated });

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate account" }));

    await waitFor(() => expect(register).toHaveBeenCalledWith({
      token: "abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF",
      email: "guest@example.test",
      password: "correct horse battery staple",
    }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });
});
