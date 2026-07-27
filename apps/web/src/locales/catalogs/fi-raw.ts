import { fiRawPart1 } from "./fi-raw/01-base-setup";
import type { TranslationKey } from "./en";

export const fiRaw = {
  ...fiRawPart1,
} satisfies Partial<Record<TranslationKey, string>>;
