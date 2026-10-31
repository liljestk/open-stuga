/** Where scheduled CSV exports are delivered: the shared NAS or one connected cloud drive. */

export const EXPORT_DESTINATION_KINDS = ["nas", "dropbox", "google-drive"] as const;
export type ExportDestinationKind = (typeof EXPORT_DESTINATION_KINDS)[number];
export const CLOUD_EXPORT_PROVIDERS = ["dropbox", "google-drive"] as const;
export type CloudExportProvider = (typeof CLOUD_EXPORT_PROVIDERS)[number];

export interface CloudExportAccount {
  provider: CloudExportProvider;
  /** False until this install has the provider's app ID configured. */
  available: boolean;
  connected: boolean;
  /** The signed-in account's email or display name, when the provider shares it. */
  accountLabel: string | null;
  connectedAt: string | null;
}

/**
 * An in-progress sign-in. "paste-code": open `url`, approve, and paste the code the provider shows.
 * "enter-code": open `url` and type `userCode`; Stugu finishes on its own once the account approves.
 */
export interface CloudExportConnection {
  id: string;
  provider: CloudExportProvider;
  method: "paste-code" | "enter-code";
  url: string;
  userCode: string | null;
  expiresAt: string;
  error: string | null;
}

export interface ExportDestinationStatus {
  selected: ExportDestinationKind;
  /** True when the selected destination can receive exports now. */
  ready: boolean;
  nasConnected: boolean;
  accounts: CloudExportAccount[];
  connection: CloudExportConnection | null;
}
