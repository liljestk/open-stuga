import { enPart1 } from "./en/01-app-bootstrap";
import { enPart2 } from "./en/02-bootstrap-twin";
import { enPart3 } from "./en/03-twin-simulation";
import { enPart4 } from "./en/04-simulation-automations";
import { enPart5 } from "./en/05-automations-analytics";
import { enPart6 } from "./en/06-analytics-developer";
import { enPart7 } from "./en/07-developer-properties";
import { enPart8 } from "./en/08-properties-setup";
import { enDataExport } from "./en/data-export";
import { enBugReports } from "./en/bug-reports";
import { enElectricityTariffs } from "./en/electricity-tariffs";

export const en = {
  ...enPart1,
  ...enPart2,
  ...enPart3,
  ...enPart4,
  ...enPart5,
  ...enPart6,
  ...enPart7,
  ...enPart8,
  ...enDataExport,
  ...enBugReports,
  ...enElectricityTariffs,
} as const;

export type TranslationKey = keyof typeof en;
