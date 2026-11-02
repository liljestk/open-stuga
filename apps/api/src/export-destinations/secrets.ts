import { EXPORT_DESTINATION_KINDS, isOneOf, type ExportDestinationKind } from "@climate-twin/contracts";
import { isDropboxAppKey, isGoogleClientId, isGoogleClientSecret } from "./apps.js";

const SECRET_KEYS = new Set(["people", "apps", "retired"]);
/** The installation-wide keys written before 0.62.0, when one sign-in served every Owner/Admin. */
const LEGACY_KEYS = new Set(["selected", "dropbox", "googleDrive"]);
const ACCOUNT_KEYS = new Set(["dropbox", "googleDrive"]);
const PERSON_KEYS = new Set(["selected", "dropbox", "googleDrive"]);
const USER_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** A connected cloud drive. The refresh token never leaves the protected integration secrets file. */
export interface CloudAccountSecret {
  refreshToken: string;
  accountLabel: string | null;
  connectedAt: string;
}

export interface CloudAccountSecrets {
  dropbox?: CloudAccountSecret;
  googleDrive?: CloudAccountSecret;
}

/** One person's choice of where their scheduled exports go, and the cloud drives they signed in to. */
export interface PersonalExportDestination extends CloudAccountSecrets {
  selected: ExportDestinationKind;
}

/** A Dropbox app an Owner/Admin registered and entered in Stugu. */
export interface StoredDropboxApp {
  appKey: string;
  updatedAt: string;
}

/** A Google "TVs and Limited Input devices" client an Owner/Admin registered and entered in Stugu. */
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
  /** Keyed by local account ID. A person without an entry sends their exports to the NAS. */
  people?: Record<string, PersonalExportDestination>;
  /** The installation's provider apps, which every person signs in through. */
  apps?: StoredCloudExportApps;
  /** Sign-ins from before 0.62.0 that belong to nobody in particular; revoked once when the API starts. */
  retired?: CloudAccountSecrets;
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

function normalizedAccounts(item: Record<string, unknown>, label: string): CloudAccountSecrets {
  return {
    ...(item.dropbox === undefined ? {} : { dropbox: normalizedAccount(item.dropbox, `${label}: the Dropbox account`) }),
    ...(item.googleDrive === undefined ? {} : { googleDrive: normalizedAccount(item.googleDrive, `${label}: the Google Drive account`) }),
  };
}

function normalizedPerson(value: unknown, label: string): PersonalExportDestination {
  const item = plainObject(value);
  if (!item || !isOneOf(item.selected, EXPORT_DESTINATION_KINDS) || Object.keys(item).some((key) => !PERSON_KEYS.has(key))) {
    throw new Error(`${label} is invalid`);
  }
  return { selected: item.selected, ...normalizedAccounts(item, label) };
}

function normalizedPeople(value: unknown, label: string): Record<string, PersonalExportDestination> {
  const item = plainObject(value);
  if (!item || Object.keys(item).some((userId) => !USER_ID.test(userId))) throw new Error(`${label} are invalid`);
  return Object.fromEntries(Object.entries(item).map(([userId, person]) => [userId, normalizedPerson(person, `${label}: one person's destination`)]));
}

function normalizedRetired(value: unknown, label: string): CloudAccountSecrets {
  const item = plainObject(value);
  if (!item || Object.keys(item).some((key) => !ACCOUNT_KEYS.has(key))) throw new Error(`${label} are invalid`);
  return normalizedAccounts(item, label);
}

/** The pre-0.62.0 shape: one selection and one account per provider for the whole installation. */
function migratedLegacySecrets(item: Record<string, unknown>, label: string): ExportDestinationSecrets {
  if (!isOneOf(item.selected, EXPORT_DESTINATION_KINDS) || Object.keys(item).some((key) => !LEGACY_KEYS.has(key) && key !== "apps")) {
    throw new Error(`${label} are invalid`);
  }
  const retired = normalizedAccounts(item, label);
  return {
    ...(item.apps === undefined ? {} : { apps: normalizedApps(item.apps, `${label}: the cloud apps`) }),
    ...(Object.keys(retired).length > 0 ? { retired } : {}),
  };
}

/**
 * Validates the stored destinations. A file from before 0.62.0 migrates: its sign-ins can't be tied to the
 * person who made them, so they move to `retired` and everyone starts on the NAS.
 */
export function normalizedExportDestinationSecrets(value: unknown, label: string): ExportDestinationSecrets {
  const item = plainObject(value);
  if (!item) throw new Error(`${label} are invalid`);
  if (Object.keys(item).some((key) => LEGACY_KEYS.has(key))) return migratedLegacySecrets(item, label);
  if (Object.keys(item).some((key) => !SECRET_KEYS.has(key))) throw new Error(`${label} are invalid`);
  return {
    ...(item.people === undefined ? {} : { people: normalizedPeople(item.people, `${label}: the people`) }),
    ...(item.apps === undefined ? {} : { apps: normalizedApps(item.apps, `${label}: the cloud apps`) }),
    ...(item.retired === undefined ? {} : { retired: normalizedRetired(item.retired, `${label}: the retired sign-ins`) }),
  };
}
