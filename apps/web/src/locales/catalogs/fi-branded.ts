import type { TranslationKey } from "./en";
import { fiRaw } from "./fi-raw";

export const fiBranded = Object.fromEntries(Object.entries(fiRaw).map(([key, value]) => [
    key,
    value
        .replaceAll("Climate Twinin", "Stugun")
        .replaceAll("Climate Twiniin", "Stuguun")
        .replaceAll("Climate Twin", "Stugu"),
])) as Partial<Record<TranslationKey, string>>;
