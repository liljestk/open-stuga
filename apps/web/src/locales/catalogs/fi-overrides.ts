import { fiOverridesPart1 } from "./fi-overrides/01-base-placement";
import { fiOverridesPart2 } from "./fi-overrides/02-placement-activity";
import type { TranslationKey } from "./en";

export const fiOverrides = {
  ...fiOverridesPart1,
  ...fiOverridesPart2,
} satisfies Partial<Record<TranslationKey, string>>;
