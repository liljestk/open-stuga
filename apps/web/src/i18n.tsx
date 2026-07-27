import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type TranslationKey } from "./locales/catalogs/en";
import { fiOverrides } from "./locales/catalogs/fi-overrides";
import { fiSupplement } from "./locales/catalogs/fi-supplement";
import { svOverrides } from "./locales/catalogs/sv";

export const SUPPORTED_LOCALES = ["en", "fi", "sv"] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export type { TranslationKey };

const fi = completeCatalog("fi", { ...fiOverrides, ...fiSupplement });
const sv = completeCatalog("sv", svOverrides);

function completeCatalog(locale: Exclude<Locale, "en">, overrides: Partial<Record<TranslationKey, string>>): Record<TranslationKey, string> {
    const englishKeys = Object.keys(en) as TranslationKey[];
    const missing = englishKeys.filter((key) => !Object.hasOwn(overrides, key) || !overrides[key]?.trim());
    const unexpected = Object.keys(overrides).filter((key) => !Object.hasOwn(en, key));
    if (missing.length || unexpected.length) {
        throw new Error(`Incomplete ${locale} translations. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
    }
    return overrides as Record<TranslationKey, string>;
}
export const translationCatalogs: Readonly<Record<Locale, Readonly<Record<TranslationKey, string>>>> = { en, fi, sv };
interface I18nValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ children }: Readonly<{
    children: ReactNode;
}>) {
    const [locale, setLocaleState] = useState<Locale>(() => {
        const stored = localStorage.getItem("climate-twin-locale");
        if (SUPPORTED_LOCALES.some((candidate) => candidate === stored))
            return stored as Locale;
        const browserLocales = navigator.languages?.length ? navigator.languages : [navigator.language];
        return browserLocales
            .map((candidate) => candidate.toLowerCase().split("-")[0])
            .find((candidate): candidate is Locale => SUPPORTED_LOCALES.some((supported) => supported === candidate)) ?? "en";
    });
    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);
    const setLocale = useCallback((next: Locale) => {
        localStorage.setItem("climate-twin-locale", next);
        document.documentElement.lang = next;
        setLocaleState(next);
    }, []);
    const t = useCallback((key: TranslationKey, values: Record<string, string | number> = {}) => {
        const template = translationCatalogs[locale][key];
        return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
    }, [locale]);
    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() {
    const context = useContext(I18nContext);
    if (!context)
        throw new Error("useI18n must be used within I18nProvider");
    return context;
}
