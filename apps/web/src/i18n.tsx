import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { en, type TranslationKey } from "./locales/catalogs/en";
import { readLocalStorage, subscribeToAccountStorageScope, writeLocalStorage } from "./browserStorage";

export const SUPPORTED_LOCALES = ["en", "fi", "sv"] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export type { TranslationKey };

type TranslationCatalog = Readonly<Record<TranslationKey, string>>;
type CatalogLoader = (locale: Locale) => Promise<TranslationCatalog>;

const catalogCache = new Map<Locale, TranslationCatalog>([["en", en]]);
const catalogRequests = new Map<Locale, Promise<TranslationCatalog>>();

function completeCatalog(locale: Exclude<Locale, "en">, overrides: Partial<Record<TranslationKey, string>>): Record<TranslationKey, string> {
    const englishKeys = Object.keys(en) as TranslationKey[];
    const missing = englishKeys.filter((key) => !Object.hasOwn(overrides, key) || !overrides[key]?.trim());
    const unexpected = Object.keys(overrides).filter((key) => !Object.hasOwn(en, key));
    if (missing.length || unexpected.length) {
        throw new Error(`Incomplete ${locale} translations. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
    }
    return overrides as Record<TranslationKey, string>;
}

function requestCatalog(locale: Locale): Promise<TranslationCatalog> {
    const cached = catalogCache.get(locale);
    if (cached) return Promise.resolve(cached);
    const pending = catalogRequests.get(locale);
    if (pending) return pending;

    const request = (locale === "fi"
        ? Promise.all([
            import("./locales/catalogs/fi-overrides"),
            import("./locales/catalogs/fi-supplement"),
        ]).then(([{ fiOverrides }, { fiSupplement }]) => completeCatalog("fi", { ...fiOverrides, ...fiSupplement }))
        : import("./locales/catalogs/sv").then(({ svOverrides }) => completeCatalog("sv", svOverrides)))
        .then((catalog) => {
            catalogCache.set(locale, catalog);
            catalogRequests.delete(locale);
            return catalog;
        })
        .catch((error: unknown) => {
            catalogRequests.delete(locale);
            throw error;
        });
    catalogRequests.set(locale, request);
    return request;
}

function initialLocale(): Locale {
    const stored = readLocalStorage("climate-twin-locale");
    if (SUPPORTED_LOCALES.some((candidate) => candidate === stored)) return stored as Locale;
    const browserLocales = navigator.languages?.length ? navigator.languages : [navigator.language];
    return browserLocales
        .map((candidate) => candidate.toLowerCase().split("-")[0])
        .find((candidate): candidate is Locale => SUPPORTED_LOCALES.some((supported) => supported === candidate)) ?? "en";
}

function persistLocale(locale: Locale): void {
    writeLocalStorage("climate-twin-locale", locale);
}

interface I18nValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ children, catalogLoader = requestCatalog }: Readonly<{
    children: ReactNode;
    catalogLoader?: CatalogLoader;
}>) {
    const [preferredLocale] = useState(initialLocale);
    const [active, setActive] = useState<{ locale: Locale; catalog: TranslationCatalog } | null>(() => {
        const catalog = catalogLoader === requestCatalog
            ? catalogCache.get(preferredLocale)
            : preferredLocale === "en" ? en : undefined;
        return catalog ? { locale: preferredLocale, catalog } : null;
    });
    const startedWithPendingCatalog = useRef(active === null);
    const loadGeneration = useRef(0);

    const activateLocale = useCallback((next: Locale, persist: boolean) => {
        const generation = ++loadGeneration.current;
        void catalogLoader(next).then((catalog) => {
            if (generation !== loadGeneration.current) return;
            if (persist) persistLocale(next);
            setActive({ locale: next, catalog });
        }).catch((error: unknown) => {
            console.error(`Could not load the ${next} translation catalog`, error);
            if (generation !== loadGeneration.current) return;
            setActive((current) => current ?? { locale: "en", catalog: en });
        });
    }, [catalogLoader]);

    useEffect(() => {
        if (!active) activateLocale(preferredLocale, false);
    }, [active, activateLocale, preferredLocale]);

    useEffect(() => subscribeToAccountStorageScope(() => {
        activateLocale(initialLocale(), false);
    }), [activateLocale]);

    useEffect(() => {
        if (active) document.documentElement.lang = active.locale;
    }, [active]);

    const setLocale = useCallback((next: Locale) => {
        activateLocale(next, true);
    }, [activateLocale]);

    const t = useCallback((key: TranslationKey, values: Record<string, string | number> = {}) => {
        const template = (active?.catalog ?? en)[key];
        return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
    }, [active]);
    const value = useMemo(() => ({ locale: active?.locale ?? "en", setLocale, t }), [active?.locale, setLocale, t]);

    if (!startedWithPendingCatalog.current) {
        return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
    }
    const catalogPending = active === null;
    return <I18nContext.Provider value={value}>
        <div
            aria-hidden={catalogPending ? true : undefined}
            inert={catalogPending ? true : undefined}
            style={{ display: catalogPending ? "none" : "contents" }}
        >
            {children}
        </div>
        {catalogPending && <div className="bootstrap-screen" role="status" aria-busy="true"><strong>Stugu</strong></div>}
    </I18nContext.Provider>;
}
/** The catalog's singular key for a count of one, its plural key for any other count. */
export function countKey<Key extends TranslationKey>(count: number, one: Key, other: Key): Key {
  return count === 1 ? one : other;
}

/** True when `key` names a catalog entry, for keys built from data the compiler cannot see. */
export function isTranslationKey(key: string): key is TranslationKey {
  return Object.hasOwn(en, key);
}

export function useI18n() {
    const context = useContext(I18nContext);
    if (!context)
        throw new Error("useI18n must be used within I18nProvider");
    return context;
}
