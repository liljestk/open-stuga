import type { CloudExportAppSource, CloudExportProvider } from "@climate-twin/contracts";
import type { CloudExportApps } from "../config/cloud-export-apps.js";
import type { StoredCloudExportApps, StoredDropboxApp, StoredGoogleDriveApp } from "./secrets.js";

export interface DropboxApp {
  appKey: string;
  source: CloudExportAppSource;
}

export interface GoogleDriveApp {
  clientId: string;
  clientSecret: string;
  source: CloudExportAppSource;
}

export interface ResolvedCloudExportApps {
  dropbox: DropboxApp | null;
  "google-drive": GoogleDriveApp | null;
}

export function isDropboxAppKey(value: string): boolean {
  return /^[a-z0-9]{8,64}$/iu.test(value);
}

export function isGoogleClientId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,200}\.apps\.googleusercontent\.com$/u.test(value);
}

/** The installed-app secret Google shows next to the client ID: one token of at least 8 bytes. */
export function isGoogleClientSecret(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 8 && value.length <= 512 && !/\s/u.test(value);
}

function resolveDropbox(configured: CloudExportApps, stored: StoredDropboxApp | undefined): DropboxApp | null {
  if (stored && configured.dropboxAppSource !== "environment") return { appKey: stored.appKey, source: "protected-file" };
  return configured.dropboxAppKey && configured.dropboxAppSource
    ? { appKey: configured.dropboxAppKey, source: configured.dropboxAppSource }
    : null;
}

function resolveGoogleDrive(configured: CloudExportApps, stored: StoredGoogleDriveApp | undefined): GoogleDriveApp | null {
  if (stored && configured.googleDriveAppSource !== "environment") {
    return { clientId: stored.clientId, clientSecret: stored.clientSecret, source: "protected-file" };
  }
  return configured.googleDriveClientId && configured.googleDriveClientSecret && configured.googleDriveAppSource
    ? { clientId: configured.googleDriveClientId, clientSecret: configured.googleDriveClientSecret, source: configured.googleDriveAppSource }
    : null;
}

/** The deployment's environment wins, then the app an Owner/Admin entered in Stugu, then the project's built-in app. */
export function resolveCloudExportApps(configured: CloudExportApps, stored: StoredCloudExportApps | undefined): ResolvedCloudExportApps {
  return { dropbox: resolveDropbox(configured, stored?.dropbox), "google-drive": resolveGoogleDrive(configured, stored?.googleDrive) };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasOnly(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key));
}

function dropboxAppFromInput(body: Record<string, unknown>, updatedAt: string): StoredDropboxApp | null {
  const appKey = text(body.appKey);
  return hasOnly(body, ["appKey"]) && isDropboxAppKey(appKey) ? { appKey, updatedAt } : null;
}

function googleDriveAppFromInput(body: Record<string, unknown>, updatedAt: string): StoredGoogleDriveApp | null {
  const clientId = text(body.clientId);
  const clientSecret = text(body.clientSecret);
  return hasOnly(body, ["clientId", "clientSecret"]) && isGoogleClientId(clientId) && isGoogleClientSecret(clientSecret)
    ? { clientId, clientSecret, updatedAt }
    : null;
}

/** `stored` with the provider's app replaced by the one in a Set up request body, or null when that body is malformed. */
export function withAppFromInput(
  stored: StoredCloudExportApps | undefined,
  provider: CloudExportProvider,
  input: { body: Record<string, unknown>; updatedAt: string },
): StoredCloudExportApps | null {
  if (provider === "dropbox") {
    const dropbox = dropboxAppFromInput(input.body, input.updatedAt);
    return dropbox && { ...stored, dropbox };
  }
  const googleDrive = googleDriveAppFromInput(input.body, input.updatedAt);
  return googleDrive && { ...stored, googleDrive };
}
