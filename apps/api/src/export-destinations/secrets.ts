import { EXPORT_DESTINATION_KINDS, isOneOf, type ExportDestinationKind } from "@climate-twin/contracts";
import { isDropboxAppKey, isGoogleClientId, isGoogleClientSecret } from "./apps.js";

const SECRET_KEYS = new Set(["selected", "dropbox", "googleDrive", "apps"]);

/** A connected cloud drive. The refresh token never leaves the protected integration secrets file. */
export interface CloudAccountSecret {
  refreshToken: string;
  accountLabel: string | null;
  connectedAt: string;
}

/** A Dropbox app an Owner/Admin registered and entered in Set up. */
export interface StoredDropboxApp {
  appKey: string;
  updatedAt: string;
}

/** A Google "TVs and Limited Input devices" client an Owner/Admin registered and entered in Set up. */
export interface StoredGoogleDriveApp {
  clientId: string;
  clientSecret: string;
  updatedAt: string;
}

export interface StoredCloudExportApps {
  dropbox?: StoredDropboxApp;
  googleDrive?: StoredGoogleDriveApp;
}

export interface ExportDestinationSecrets {
  selected: ExportDestinationKind;
  dropbox?: CloudAccountSecret;
  googleDrive?: CloudAccountSecret;
  apps?: StoredCloudExportApps;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedDropboxApp(value: unknown, label: string): StoredDropboxApp {
  const item = plainObject(value);
  if (!item || typeof item.appKey !== "string" || !isDropboxAppKey(item.appKey) || !validTimestamp(item.updatedAt)) {
    throw new Error(`${label} is invalid`);
  }
  return { appKey: item.appKey, updatedAt: new Date(item.updatedAt).toISOString() };
}

function normalizedGoogleDriveApp(value: unknown, label: string): StoredGoogleDriveApp {
  const item = plainObject(value);
  if (!item || typeof item.clientId !== "string" || !isGoogleClientId(item.clientId)
    || typeof item.clientSecret !== "string" || !isGoogleClientSecret(item.clientSecret) || !validTimestamp(item.updatedAt)) {
    throw new Error(`${label} is invalid`);
  }
  return { clientId: item.clientId, clientSecret: item.clientSecret, updatedAt: new Date(item.updatedAt).toISOString() };
}

function normalizedApps(value: unknown, label: string): StoredCloudExportApps {
  const item = plainObject(value);
  if (!item || Object.keys(item).some((key) => key !== "dropbox" && key !== "googleDrive")) throw new Error(`${label} are invalid`);
  return {
    ...(item.dropbox === undefined ? {} : { dropbox: normalizedDropboxApp(item.dropbox, `${label}: the Dropbox app`) }),
    ...(item.googleDrive === undefined ? {} : { googleDrive: normalizedGoogleDriveApp(item.googleDrive, `${label}: the Google Drive app`) }),
  };
}

function normalizedAccount(value: unknown, label: string): CloudAccountSecret {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item)
    || typeof item.refreshToken !== "string" || item.refreshToken.length < 8 || item.refreshToken.length > 4_096
    || (item.accountLabel !== null && (typeof item.accountLabel !== "string" || item.accountLabel.length > 320))
    || typeof item.connectedAt !== "string" || !Number.isFinite(Date.parse(item.connectedAt))) {
    throw new Error(`${label} is invalid`);
  }
  return {
    refreshToken: item.refreshToken,
    accountLabel: item.accountLabel as string | null,
    connectedAt: new Date(item.connectedAt).toISOString(),
  };
}

export function normalizedExportDestinationSecrets(value: unknown, label: string): ExportDestinationSecrets {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) || !isOneOf(item.selected, EXPORT_DESTINATION_KINDS)
    || Object.keys(item).some((key) => !SECRET_KEYS.has(key))) {
    throw new Error(`${label} are invalid`);
  }
  return {
    selected: item.selected,
    ...(item.dropbox === undefined ? {} : { dropbox: normalizedAccount(item.dropbox, `${label}: the Dropbox account`) }),
    ...(item.googleDrive === undefined ? {} : { googleDrive: normalizedAccount(item.googleDrive, `${label}: the Google Drive account`) }),
    ...(item.apps === undefined ? {} : { apps: normalizedApps(item.apps, `${label}: the cloud apps`) }),
  };
}
