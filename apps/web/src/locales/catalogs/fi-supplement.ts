import { fiSupplementPart1 } from "./fi-supplement/01-stuguby-setup";
import { fiSupplementPart2 } from "./fi-supplement/02-setup-historyImport";
import { fiSupplementPart3 } from "./fi-supplement/03-historyImport-properties";
import { fiSupplementPart4 } from "./fi-supplement/04-properties-opening";
import { fiSupplementPart5 } from "./fi-supplement/05-opening-performance";
import { fiBugReports } from "./fi-supplement/bug-reports";
import type { TranslationKey } from "./en";

export const fiSupplement = {
  ...fiSupplementPart1,
  ...fiSupplementPart2,
  ...fiSupplementPart3,
  ...fiSupplementPart4,
  ...fiSupplementPart5,
  ...fiBugReports,
} satisfies Partial<Record<TranslationKey, string>>;
