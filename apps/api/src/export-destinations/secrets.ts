import { EXPORT_DESTINATION_KINDS, isOneOf, type ExportDestinationKind } from "@climate-twin/contracts";

/** A connected cloud drive. The refresh token never leaves the protected integration secrets file. */
export interface CloudAccountSecret {
  refreshToken: string;
  accountLabel: string | null;
  connectedAt: string;
}

export interface ExportDestinationSecrets {
  selected: ExportDestinationKind;
  dropbox?: CloudAccountSecret;
  googleDrive?: CloudAccountSecret;
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
    || Object.keys(item).some((key) => key !== "selected" && key !== "dropbox" && key !== "googleDrive")) {
    throw new Error(`${label} are invalid`);
  }
  return {
    selected: item.selected,
    ...(item.dropbox === undefined ? {} : { dropbox: normalizedAccount(item.dropbox, `${label}: the Dropbox account`) }),
    ...(item.googleDrive === undefined ? {} : { googleDrive: normalizedAccount(item.googleDrive, `${label}: the Google Drive account`) }),
  };
}
