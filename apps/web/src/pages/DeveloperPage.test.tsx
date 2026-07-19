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
  it("documents and copies the local integrations", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Local v1 + v2 HTTP API" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local MCP server" })).toBeTruthy();
    expect(screen.getByText("Local integration contracts")).toBeTruthy();
    expect(screen.getByText("Use Stuga locally through the versioned HTTP API and trusted stdio MCP server.")).toBeTruthy();

    const baseUrl = screen.getByRole("textbox", { name: "Local v1 base URL" }) as HTMLInputElement;
    expect(baseUrl.value).toBe(window.location.origin + "/api/v1");

    await user.click(screen.getByRole("button", { name: "Copy: Local v1 base URL" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1$/));
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

    fireEvent.click(screen.getByRole("button", { name: "Copy: Local v1 base URL" }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(screen.getByText("Copy failed. Select the value and copy it manually.").getAttribute("role")).toBe("status");
  });

  it("explains the local integrations in Finnish", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Paikallinen v1 + v2 HTTP-rajapinta" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paikallinen MCP-palvelin" })).toBeTruthy();
    expect(screen.getByText("Paikalliset integraatiorajapinnat")).toBeTruthy();
    expect(screen.getByText("Käytä Stugaa paikallisesti versioidun HTTP-rajapinnan ja luotetun stdio-MCP-palvelimen kautta.")).toBeTruthy();
  });
});
