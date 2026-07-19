import ts from "typescript";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, SUPPORTED_LOCALES, translationCatalogs, useI18n, type TranslationKey } from "./i18n";

const uiSources = import.meta.glob(
  ["./App.tsx", "./components/*.tsx", "./pages/*.tsx", "!./components/*.test.tsx", "!./pages/*.test.tsx"],
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
    || /^(Home Assistant|TP-Link|TP-Link H100\/H200|TP-Link Tapo · Direct \/ Home Assistant|DayOps \/ OpenWearable webhook)( ·)?$/.test(value);
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

function LocaleProbe() {
  const { locale, setLocale, t } = useI18n();
  return <><span>{locale}:{t("common.save")}</span><button type="button" onClick={() => setLocale("sv")}>switch</button></>;
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

  it("loads and persists Swedish without falling back to English", () => {
    localStorage.setItem("climate-twin-locale", "sv");
    render(<I18nProvider><LocaleProbe /></I18nProvider>);
    expect(screen.getByText("sv:Spara")).not.toBeNull();

    localStorage.setItem("climate-twin-locale", "en");
    act(() => screen.getByRole("button", { name: "switch" }).click());
    expect(localStorage.getItem("climate-twin-locale")).toBe("sv");
    expect(document.documentElement.lang).toBe("sv");
  });

  it("keeps prose and accessibility copy out of UI components", () => {
    const violations = Object.entries(uiSources).flatMap(([fileName, source]) =>
      userFacingLiterals(fileName, source).map((literal) => `${fileName}: ${literal}`));
    expect(violations).toEqual([]);
    expect(Object.values(uiSources).join("\n")).not.toMatch(/copyByLocale|locale\s*===\s*["'](?:en|fi|sv)["']\s*\?\s*["'][A-Za-zÅÄÖåäö]/);
  });
});
