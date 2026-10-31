import type { ExportDestinationKind } from "@climate-twin/contracts";

/** Translation keys for each export destination's name, shared by the setup picker and the schedule panel. */
export const EXPORT_DESTINATION_NAME_KEYS = {
  nas: "dataExport.destinationNas",
  dropbox: "dataExport.destinationDropbox",
  "google-drive": "dataExport.destinationGoogleDrive",
} as const satisfies Record<ExportDestinationKind, string>;
