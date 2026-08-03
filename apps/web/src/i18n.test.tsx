import ts from "typescript";
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, SUPPORTED_LOCALES, useI18n, type TranslationKey } from "./i18n";
import { en } from "./locales/catalogs/en";
import { fiOverrides } from "./locales/catalogs/fi-overrides";
import { fiSupplement } from "./locales/catalogs/fi-supplement";
import { svOverrides } from "./locales/catalogs/sv";

const translationCatalogs = {
  en,
  fi: { ...fiOverrides, ...fiSupplement } as Record<TranslationKey, string>,
  sv: svOverrides,
};

const uiSources = import.meta.glob(
  [
    "./App.tsx",
    "./components/*.tsx",
    "./pages/*.tsx",
    "!./components/*.test.tsx",
    "!./components/*TestSupport.tsx",
    "!./pages/*.test.tsx",
    "!./pages/*TestSupport.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{[^{}]+\}/g)].map((match) => match[0]).sort();
}

function technicalLiteral(value: string): boolean {
  return value.startsWith("/")
    || /^(GET|POST)( v2)?$/.test(value)
    || /^(TP_LINK_|HA_)/.test(value)
    || value === "Europe/Helsinki"
    || /^(Home Assistant|TP-Link|TP-Link H100\/H200(?:\/H500)?|TP-Link Tapo · Direct \/ Home Assistant|DayOps \/ OpenWearable webhook)( ·)?$/.test(value);
}

function userFacingLiterals(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const literals: string[] = [];
  const add = (value: string) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (/[A-Za-zÅÄÖåäö]{2}/.test(normalized) && !technicalLiteral(normalized)) literals.push(normalized);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node)
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && ["aria-label", "title", "placeholder", "alt"].includes(node.name.getText(sourceFile))) {
      add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

function LocaleProbe({ onMount, onUnmount }: Readonly<{
  onMount?: () => void;
  onUnmount?: () => void;
}> = {}) {
  const { locale, setLocale, t } = useI18n();
  useEffect(() => {
    onMount?.();
    return () => onUnmount?.();
  }, [onMount, onUnmount]);
  return <><span>{locale}:{t("common.save")}</span><button type="button" onClick={() => setLocale("fi")}>Finnish</button><button type="button" onClick={() => setLocale("sv")}>Swedish</button></>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  localStorage.clear();
});

describe("localization coverage", () => {
  it("keeps every locale complete, non-empty, and placeholder-compatible", () => {
    const englishKeys = Object.keys(translationCatalogs.en).sort() as TranslationKey[];
    expect(SUPPORTED_LOCALES).toEqual(["en", "fi", "sv"]);
    expect(englishKeys.length).toBeGreaterThan(1_200);

    for (const locale of SUPPORTED_LOCALES) {
      const catalog = translationCatalogs[locale];
      expect(Object.keys(catalog).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(catalog[key].trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholders(catalog[key]), `${locale}.${key}`).toEqual(placeholders(translationCatalogs.en[key]));
        expect(catalog[key], `${locale}.${key}`).not.toMatch(/ZXQ|STUGA_TRANSLATION|SPLIT_9F3A|â€¦|Ã|Â°|â€“|â€”|â€™|â€œ|â€|Â·/);
      }
    }
  });

  it("uses the user-facing Home taxonomy for navigation and scoped copy", () => {
    expect({
      en: {
        home: translationCatalogs.en["common.house"],
        homes: translationCatalogs.en["properties.houses"],
        connections: translationCatalogs.en["overview.connections"],
        activity: translationCatalogs.en["activity.pageDescription"],
      },
      fi: {
        home: translationCatalogs.fi["common.house"],
        homes: translationCatalogs.fi["properties.houses"],
        connections: translationCatalogs.fi["overview.connections"],
        activity: translationCatalogs.fi["activity.pageDescription"],
      },
      sv: {
        home: translationCatalogs.sv["common.house"],
        homes: translationCatalogs.sv["properties.houses"],
        connections: translationCatalogs.sv["overview.connections"],
        activity: translationCatalogs.sv["activity.pageDescription"],
      },
    }).toEqual({
      en: { home: "Home", homes: "Homes", connections: "Home connections", activity: "A clear history of observations, alerts, weather, and important changes in this home." },
      fi: { home: "Koti", homes: "Kodit", connections: "Kotien yhteydet", activity: "Selkeä historia kodin havainnoista, hälytyksistä, säästä ja tärkeistä muutoksista." },
      sv: { home: "Hem", homes: "Hem", connections: "Hemmens anslutningar", activity: "En tydlig historik över observationer, varningar, väder och viktiga förändringar i hemmet." },
    });
  });

  it("keeps the primary setup journey vendor-neutral in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const setupCopy = [
        translationCatalogs[locale]["setup.step1body"],
        translationCatalogs[locale]["setup.step2body"],
        translationCatalogs[locale]["setup.step3body"],
      ].join(" ");
      expect(setupCopy, locale).not.toMatch(/TP-Link|Home Assistant|H100|H200|H500|Tapo/);
    }
  });

  it("keeps unknown monitoring and Property-wide optimizer scope explicit in every locale", () => {
    expect(SUPPORTED_LOCALES.map((locale) => ({
      locale,
      monitoring: translationCatalogs[locale]["overview.monitoringUnknown"],
      homes: translationCatalogs[locale]["overview.unknownHomes"],
      optimizer: translationCatalogs[locale]["energy.optimizer.propertyScope"],
    }))).toEqual([
      { locale: "en", monitoring: "Monitoring not confirmed", homes: "Monitoring is not confirmed for {count} homes", optimizer: "Property scope · {property}" },
      { locale: "fi", monitoring: "Seurantaa ei ole vahvistettu", homes: "{count} kodin seurantaa ei ole vahvistettu", optimizer: "Kiinteistötaso · {property}" },
      { locale: "sv", monitoring: "Övervakning inte bekräftad", homes: "Övervakningen är inte bekräftad för {count} hem", optimizer: "Fastighetsnivå · {property}" },
    ]);
  });

  it("loads and persists Swedish without falling back to English", async () => {
    localStorage.setItem("climate-twin-locale", "sv");
    render(<I18nProvider><LocaleProbe /></I18nProvider>);
    expect(await screen.findByText("sv:Spara")).not.toBeNull();

    localStorage.setItem("climate-twin-locale", "en");
    act(() => screen.getByRole("button", { name: "Swedish" }).click());
    expect(await screen.findByText("sv:Spara")).not.toBeNull();
    expect(localStorage.getItem("climate-twin-locale")).toBe("sv");
    expect(document.documentElement.lang).toBe("sv");
  });

  it("preserves direct child DOM when the initial catalog is immediately available", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const { container } = render(<I18nProvider><LocaleProbe /></I18nProvider>);

    expect(screen.getByText("en:Save").parentElement).toBe(container);
  });

  it("starts child effects while keeping a preferred non-English locale hidden until its catalog resolves", async () => {
    localStorage.setItem("climate-twin-locale", "fi");
    const request = deferred<Record<TranslationKey, string>>();
    const catalogLoader = vi.fn(() => request.promise);
    const onMount = vi.fn();
    const onUnmount = vi.fn();

    render(<I18nProvider catalogLoader={catalogLoader}><LocaleProbe onMount={onMount} onUnmount={onUnmount} /></I18nProvider>);

    expect(catalogLoader).toHaveBeenCalledOnce();
    expect(catalogLoader).toHaveBeenCalledWith("fi");
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
    const mountedProbe = screen.getByText("en:Save");
    expect(mountedProbe.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(mountedProbe.parentElement).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Finnish" })).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      request.resolve(translationCatalogs.fi);
      await request.promise;
    });
    expect(screen.getByText("fi:Tallenna")).toBe(mountedProbe);
    expect(screen.getByRole("button", { name: "Finnish" })).not.toBeNull();
    expect(document.documentElement.lang).toBe("fi");
    expect(mountedProbe.parentElement).not.toHaveAttribute("aria-hidden");
    expect(mountedProbe.parentElement).not.toHaveAttribute("inert");
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it("ignores a stale locale load that finishes after a newer selection", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const finnish = deferred<Record<TranslationKey, string>>();
    const swedish = deferred<Record<TranslationKey, string>>();
    const catalogLoader = vi.fn((locale: typeof SUPPORTED_LOCALES[number]) => {
      if (locale === "fi") return finnish.promise;
      if (locale === "sv") return swedish.promise;
      return Promise.resolve(translationCatalogs.en);
    });
    render(<I18nProvider catalogLoader={catalogLoader}><LocaleProbe /></I18nProvider>);

    act(() => screen.getByRole("button", { name: "Finnish" }).click());
    act(() => screen.getByRole("button", { name: "Swedish" }).click());
    expect(catalogLoader.mock.calls.map(([locale]) => locale)).toEqual(["fi", "sv"]);
    await act(async () => {
      swedish.resolve(translationCatalogs.sv);
      await swedish.promise;
    });
    expect(screen.getByText("sv:Spara")).not.toBeNull();

    await act(async () => {
      finnish.resolve(translationCatalogs.fi);
      await finnish.promise;
    });
    expect(screen.getByText("sv:Spara")).not.toBeNull();
    expect(localStorage.getItem("climate-twin-locale")).toBe("sv");
    expect(document.documentElement.lang).toBe("sv");
  });

  it("starts when browser privacy settings block persistent storage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    try {
      render(<I18nProvider><LocaleProbe /></I18nProvider>);
      expect(screen.getByText("en:Save")).not.toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });

  it("keeps prose and accessibility copy out of UI components", () => {
    const violations = Object.entries(uiSources).flatMap(([fileName, source]) =>
      userFacingLiterals(fileName, source).map((literal) => `${fileName}: ${literal}`));
    expect(violations).toEqual([]);
    expect(Object.values(uiSources).join("\n")).not.toMatch(/copyByLocale|locale\s*===\s*["'](?:en|fi|sv)["']\s*\?\s*["'][A-Za-zÅÄÖåäö]/);
  });
});
