import type { CloudExportAppSource } from "@climate-twin/contracts";
import { isDropboxAppKey, isGoogleClientId } from "../export-destinations/apps.js";
import { optional, optionalFileSecret, requireAllOrNone } from "./app-config.js";

type Env = NodeJS.ProcessEnv;
type ConfiguredAppSource = Extract<CloudExportAppSource, "environment" | "built-in">;

interface CloudExportAppValues {
  dropboxAppKey: string | null;
  googleDriveClientId: string | null;
  googleDriveClientSecret: string | null;
}

/**
 * The app IDs a Stugu installation uses to let an owner connect Dropbox or Google Drive, and where each
 * provider's came from. An app an Owner/Admin enters in Set up replaces a built-in one, never an environment one.
 */
export interface CloudExportApps extends CloudExportAppValues {
  dropboxAppSource: ConfiguredAppSource | null;
  googleDriveAppSource: ConfiguredAppSource | null;
}

export type ProjectCloudExportApps = Readonly<Record<keyof CloudExportAppValues, string>>;

/**
 * The project's registered Dropbox app and Google "TVs and Limited Input devices" OAuth client.
 *
 * They ship inside the API image so every installation can offer Dropbox and Google Drive after an
 * ordinary application update. That includes the Raspberry Pi appliance, whose Compose file is part
 * of the host image and only changes with a host update. The values identify public clients and are
 * not secrets; Google doesn't treat an installed-app client secret as confidential. A deployment's
 * `STUGU_DROPBOX_APP_KEY` and `STUGU_GOOGLE_DRIVE_CLIENT_*` variables override them, and so does an
 * app an Owner/Admin enters in Set up. Empty values leave the provider for Set up;
 * docs/cloud-export-destinations.md has the registration steps.
 */
export const PROJECT_CLOUD_EXPORT_APPS: ProjectCloudExportApps = {
  dropboxAppKey: "",
  googleDriveClientId: "",
  googleDriveClientSecret: "",
};

const PROJECT_LABEL = "The built-in";

function validDropboxAppKey(value: string | null, source: string): string | null {
  if (value && !isDropboxAppKey(value)) throw new Error(`${source} is not a valid Dropbox app key`);
  return value;
}

function validGoogleClient(clientId: string, clientSecret: string, source: string) {
  if (!isGoogleClientId(clientId)) {
    throw new Error(`${source} is not a valid Google OAuth client ID`);
  }
  return { clientId, clientSecret };
}

/** The deployment's own Google client. It replaces the built-in one as a pair, so an ID never meets another client's secret. */
function deploymentGoogleClient(env: Env) {
  const clientId = optional(env.STUGU_GOOGLE_DRIVE_CLIENT_ID);
  const clientSecret = optionalFileSecret(
    env, "STUGU_GOOGLE_DRIVE_CLIENT_SECRET", "STUGU_GOOGLE_DRIVE_CLIENT_SECRET_FILE", "Google Drive client secret", 8, true,
  );
  requireAllOrNone(
    [clientId, clientSecret],
    "The Google Drive export destination needs both STUGU_GOOGLE_DRIVE_CLIENT_ID and STUGU_GOOGLE_DRIVE_CLIENT_SECRET",
  );
  return clientId && clientSecret ? validGoogleClient(clientId, clientSecret, "STUGU_GOOGLE_DRIVE_CLIENT_ID") : null;
}

function projectGoogleClient(project: ProjectCloudExportApps) {
  const clientId = optional(project.googleDriveClientId);
  const clientSecret = optional(project.googleDriveClientSecret);
  requireAllOrNone([clientId, clientSecret], `${PROJECT_LABEL} Google Drive client needs both its ID and its secret`);
  if (clientSecret && Buffer.byteLength(clientSecret, "utf8") < 8) {
    throw new Error(`${PROJECT_LABEL} Google Drive client secret must contain at least 8 UTF-8 bytes`);
  }
  return clientId && clientSecret ? validGoogleClient(clientId, clientSecret, `${PROJECT_LABEL} Google Drive client ID`) : null;
}

function appSource(resolved: unknown, deployment: unknown): ConfiguredAppSource | null {
  if (!resolved) return null;
  return deployment ? "environment" : "built-in";
}

/** Deployment variables (inline or file form) win; empty ones fall back to the project's built-in apps. */
export function readCloudExportApps(env: Env, project: ProjectCloudExportApps = PROJECT_CLOUD_EXPORT_APPS): CloudExportApps {
  const deploymentDropbox = optional(env.STUGU_DROPBOX_APP_KEY);
  const dropboxAppKey = deploymentDropbox
    ? validDropboxAppKey(deploymentDropbox, "STUGU_DROPBOX_APP_KEY")
    : validDropboxAppKey(optional(project.dropboxAppKey), `${PROJECT_LABEL} Dropbox app key`);
  const deploymentGoogle = deploymentGoogleClient(env);
  const google = deploymentGoogle ?? projectGoogleClient(project);
  return {
    dropboxAppKey,
    googleDriveClientId: google?.clientId ?? null,
    googleDriveClientSecret: google?.clientSecret ?? null,
    dropboxAppSource: appSource(dropboxAppKey, deploymentDropbox),
    googleDriveAppSource: appSource(google, deploymentGoogle),
  };
}
