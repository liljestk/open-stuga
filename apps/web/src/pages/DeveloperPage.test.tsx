import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DeveloperPage } from "./DeveloperPage";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  localStorage.removeItem("climate-twin-locale");
  document.documentElement.lang = "en";
  vi.restoreAllMocks();
});

describe("DeveloperPage", () => {
  it("distinguishes local integrations from hosted-only HTTP and copies the hosted manifest", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Local v1 + v2 HTTP API" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local MCP server" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tenant-scoped hosted HTTP" })).toBeTruthy();
    expect(screen.getByText("Hosted deployments only")).toBeTruthy();
    expect(screen.getByText(/Tenant, member, invitation, and API-token administration is HTTP-only/)).toBeTruthy();
    expect(screen.getByText(/local MCP server remains trusted stdio/)).toBeTruthy();

    const openApi = screen.getByRole("textbox", { name: "Hosted OpenAPI" }) as HTMLInputElement;
    const routeManifest = screen.getByRole("textbox", { name: "Hosted route manifest" }) as HTMLInputElement;
    expect(openApi.value).toBe(window.location.origin + "/api/openapi.json");
    expect(routeManifest.value).toBe(window.location.origin + "/api/hosted-routes.json");

    await user.click(screen.getByRole("button", { name: "Copy: Hosted route manifest" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/hosted-routes\.json$/));
    expect(screen.getByText("Copied").getAttribute("role")).toBe("status");
  });

  it("announces when copying is unavailable in a non-secure local context", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "Copy: Trusted stdio command" }));

    expect(screen.getByText("Copy failed. Select the value and copy it manually.").getAttribute("role")).toBe("status");
    const value = screen.getByRole("textbox", { name: "Trusted stdio command" }) as HTMLInputElement;
    await user.click(value);
    expect(value.selectionStart).toBe(0);
    expect(value.selectionEnd).toBe(value.value.length);
  });

  it("announces when a browser leaves the clipboard request pending", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => new Promise<void>(() => undefined));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Copy: Hosted OpenAPI" }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(screen.getByText("Copy failed. Select the value and copy it manually.").getAttribute("role")).toBe("status");
  });

  it("explains the same local and hosted boundary in Finnish", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Paikallinen v1 + v2 HTTP-rajapinta" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paikallinen MCP-palvelin" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tenant-kohtainen hostattu HTTP-rajapinta" })).toBeTruthy();
    expect(screen.getByText("Vain hostatut asennukset")).toBeTruthy();
    expect(screen.getByText(/hallinta toimii vain HTTP:n kautta/)).toBeTruthy();
    expect(screen.getByText(/s\u00e4ilyy luotettuna stdio-palvelimena/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Hostattu OpenAPI-kuvaus" }) as HTMLInputElement).value).toBe(window.location.origin + "/api/openapi.json");
    expect((screen.getByRole("textbox", { name: "Hostattu reittiluettelo" }) as HTMLInputElement).value).toBe(window.location.origin + "/api/hosted-routes.json");
  });
});
