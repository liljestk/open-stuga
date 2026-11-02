/**
 * Where a person's scheduled CSV exports are delivered: the shared NAS or a cloud drive they connected
 * themselves. Cloud drives are personal; the provider apps they sign in through belong to the installation.
 */

export const EXPORT_DESTINATION_KINDS = ["nas", "dropbox", "google-drive"] as const;
export type ExportDestinationKind = (typeof EXPORT_DESTINATION_KINDS)[number];
export const CLOUD_EXPORT_PROVIDERS = ["dropbox", "google-drive"] as const;
export type CloudExportProvider = (typeof CLOUD_EXPORT_PROVIDERS)[number];

/**
 * Where a provider's app ID comes from. The deployment's environment wins over an app an Owner/Admin
 * entered in Stugu ("protected-file"), which wins over the project's built-in app.
 */
export type CloudExportAppSource = "environment" | "protected-file" | "built-in";

/** The app an Owner/Admin registers with each provider and enters in Stugu. */
export interface CloudExportAppInputs {
  dropbox: { appKey: string };
  "google-drive": { clientId: string; clientSecret: string };
}

export interface CloudExportAccount {
  provider: CloudExportProvider;
  /** False until this install has the provider's app ID configured. */
  available: boolean;
  /** Where that app ID comes from; null while there is none. Stugu can't change an "environment" app. */
  appSource: CloudExportAppSource | null;
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

/** The signed-in person's destination, their own cloud drives, and their sign-in in progress. */
export interface ExportDestinationStatus {
  selected: ExportDestinationKind;
  /** True when the selected destination can receive exports now. */
  ready: boolean;
  nasConnected: boolean;
  accounts: CloudExportAccount[];
  connection: CloudExportConnection | null;
}
