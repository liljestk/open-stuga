import { fiBasePart1 } from "./fi-base/01-app-sensor";
import type { TranslationKey } from "./en";

export const fiBase = {
  ...fiBasePart1,
} satisfies Partial<Record<TranslationKey, string>>;
