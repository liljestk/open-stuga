import { svPart1 } from "./sv/01-stuguby-analytics";
import { svPart2 } from "./sv/02-analytics-decision";
import { svPart3 } from "./sv/03-decision-simulation";
import { svPart4 } from "./sv/04-simulation-sensors";
import { svPart5 } from "./sv/05-sensors-outdoor";
import { svPart6 } from "./sv/06-outdoor-properties";
import { svPart7 } from "./sv/07-properties-spatial";
import { svPart8 } from "./sv/08-spatial-performance";
import { svDataExport } from "./sv/data-export";
import { svBugReports } from "./sv/bug-reports";
import { svElectricityTariffs } from "./sv/electricity-tariffs";
import { svAnalyticsQuality } from "./sv/analytics-quality";
import { svRequestErrors } from "./sv/request-errors";
import { svAssistantConnector } from "./sv/assistant-connector";
import type { TranslationKey } from "./en";

export const svOverrides = {
  ...svPart1,
  ...svPart2,
  ...svPart3,
  ...svPart4,
  ...svPart5,
  ...svPart6,
  ...svPart7,
  ...svPart8,
  ...svDataExport,
  ...svBugReports,
  ...svElectricityTariffs,
  ...svAnalyticsQuality,
  ...svRequestErrors,
  ...svAssistantConnector,
} satisfies Record<TranslationKey, string>;
