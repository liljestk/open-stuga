import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PROJECT_CLOUD_EXPORT_APPS, readCloudExportApps, type ProjectCloudExportApps } from "../src/config/cloud-export-apps.js";
import { ExportDestinationService } from "../src/export-destinations/service.js";

const BUILT_IN: ProjectCloudExportApps = {
  dropboxAppKey: "builtinappkey",
  googleDriveClientId: "1111111111-builtin.apps.googleusercontent.com",
  googleDriveClientSecret: "builtin-client-secret",
};
const NONE: ProjectCloudExportApps = { dropboxAppKey: "", googleDriveClientId: "", googleDriveClientSecret: "" };
const DEPLOYMENT_CLIENT_ID = "2222222222-deployment.apps.googleusercontent.com";
/** Compose passes every variable through, so an unset one reaches the API as an empty string. */
const COMPOSE_EMPTY = { STUGU_DROPBOX_APP_KEY: "", STUGU_GOOGLE_DRIVE_CLIENT_ID: "", STUGU_GOOGLE_DRIVE_CLIENT_SECRET: "" };

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function secretFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloud-export-apps-"));
  directories.push(directory);
  const path = join(directory, "google-client-secret");
  writeFileSync(path, `${contents}\n`);
  return path;
}

function availability(apps: ReturnType<typeof readCloudExportApps>) {
  const service = new ExportDestinationService({
    secretsFile: join(tmpdir(), "stugu-cloud-export-apps-unused.json"),
    stored: null,
    systemStorage: { status: () => ({ settings: { backups: { kind: "managed", path: null } } }) } as never,
    ...apps,
  });
  return service.status().accounts.map((account) => [account.provider, account.available]);
}

describe("cloud export app IDs", () => {
  it("uses the built-in apps when the deployment leaves the variables empty", () => {
    expect(readCloudExportApps(COMPOSE_EMPTY, BUILT_IN)).toEqual({
      dropboxAppKey: "builtinappkey",
      googleDriveClientId: "1111111111-builtin.apps.googleusercontent.com",
      googleDriveClientSecret: "builtin-client-secret",
    });
    expect(readCloudExportApps({}, BUILT_IN).dropboxAppKey).toBe("builtinappkey");
  });

  it("lets deployment variables override the built-in apps", () => {
    expect(readCloudExportApps({
      STUGU_DROPBOX_APP_KEY: " deploymentkey ",
      STUGU_GOOGLE_DRIVE_CLIENT_ID: DEPLOYMENT_CLIENT_ID,
      STUGU_GOOGLE_DRIVE_CLIENT_SECRET: "deployment-secret",
    }, BUILT_IN)).toEqual({
      dropboxAppKey: "deploymentkey",
      googleDriveClientId: DEPLOYMENT_CLIENT_ID,
      googleDriveClientSecret: "deployment-secret",
    });
  });

  it("reads the deployment's Google client secret from its file form before the built-in one", () => {
    const apps = readCloudExportApps({
      ...COMPOSE_EMPTY,
      STUGU_GOOGLE_DRIVE_CLIENT_ID: DEPLOYMENT_CLIENT_ID,
      STUGU_GOOGLE_DRIVE_CLIENT_SECRET_FILE: secretFile("file-client-secret"),
    }, BUILT_IN);
    expect(apps).toMatchObject({ googleDriveClientId: DEPLOYMENT_CLIENT_ID, googleDriveClientSecret: "file-client-secret" });
    expect(apps.dropboxAppKey).toBe("builtinappkey");
  });

  it("falls back to the built-in Google client when the configured secret file is missing", () => {
    expect(readCloudExportApps({ STUGU_GOOGLE_DRIVE_CLIENT_SECRET_FILE: join(tmpdir(), "stugu-no-such-secret") }, BUILT_IN))
      .toMatchObject({ googleDriveClientId: BUILT_IN.googleDriveClientId, googleDriveClientSecret: BUILT_IN.googleDriveClientSecret });
  });

  it("never pairs a deployment Google client ID with the built-in secret", () => {
    expect(() => readCloudExportApps({ STUGU_GOOGLE_DRIVE_CLIENT_ID: DEPLOYMENT_CLIENT_ID }, BUILT_IN))
      .toThrow("needs both STUGU_GOOGLE_DRIVE_CLIENT_ID and STUGU_GOOGLE_DRIVE_CLIENT_SECRET");
    expect(() => readCloudExportApps({ STUGU_GOOGLE_DRIVE_CLIENT_SECRET: "deployment-secret" }, BUILT_IN))
      .toThrow("needs both STUGU_GOOGLE_DRIVE_CLIENT_ID and STUGU_GOOGLE_DRIVE_CLIENT_SECRET");
  });

  it("keeps both providers unavailable when neither the deployment nor the project sets an ID", () => {
    const apps = readCloudExportApps(COMPOSE_EMPTY, NONE);
    expect(apps).toEqual({ dropboxAppKey: null, googleDriveClientId: null, googleDriveClientSecret: null });
    expect(availability(apps)).toEqual([["dropbox", false], ["google-drive", false]]);
    expect(availability(readCloudExportApps(COMPOSE_EMPTY, BUILT_IN))).toEqual([["dropbox", true], ["google-drive", true]]);
  });

  it("rejects malformed values and names where they came from", () => {
    expect(() => readCloudExportApps({ STUGU_DROPBOX_APP_KEY: "not a key" }, BUILT_IN))
      .toThrow("STUGU_DROPBOX_APP_KEY is not a valid Dropbox app key");
    expect(() => readCloudExportApps({ STUGU_GOOGLE_DRIVE_CLIENT_ID: "client", STUGU_GOOGLE_DRIVE_CLIENT_SECRET: "deployment-secret" }, BUILT_IN))
      .toThrow("STUGU_GOOGLE_DRIVE_CLIENT_ID is not a valid Google OAuth client ID");
    expect(() => readCloudExportApps({}, { ...NONE, dropboxAppKey: "bad key" }))
      .toThrow("The built-in Dropbox app key is not a valid Dropbox app key");
    expect(() => readCloudExportApps({}, { ...NONE, googleDriveClientId: BUILT_IN.googleDriveClientId }))
      .toThrow("The built-in Google Drive client needs both its ID and its secret");
    expect(() => readCloudExportApps({}, { ...NONE, googleDriveClientId: "client", googleDriveClientSecret: "builtin-secret" }))
      .toThrow("The built-in Google Drive client ID is not a valid Google OAuth client ID");
    expect(() => readCloudExportApps({}, { ...BUILT_IN, googleDriveClientSecret: "short" }))
      .toThrow("The built-in Google Drive client secret must contain at least 8 UTF-8 bytes");
  });

  it("ships built-in apps that every installation can start with", () => {
    // A malformed built-in value would stop the API on every installation, so it fails here first.
    const apps = readCloudExportApps(COMPOSE_EMPTY);
    expect(apps.dropboxAppKey).toBe(PROJECT_CLOUD_EXPORT_APPS.dropboxAppKey || null);
    expect(apps.googleDriveClientId).toBe(PROJECT_CLOUD_EXPORT_APPS.googleDriveClientId || null);
    expect(loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", ...COMPOSE_EMPTY })).toMatchObject(apps);
  });
});
