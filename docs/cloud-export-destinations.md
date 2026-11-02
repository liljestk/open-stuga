# Dropbox and Google Drive export destinations

Scheduled CSV exports can go to the shared NAS, to Dropbox, or to Google Drive.
The choice is installation-wide: every Home's schedules use the same
destination. Recovery backups are not affected. They stay on the NAS, or on
this device when no NAS is connected, because they contain stored integration
credentials and can be several gigabytes.

iCloud Drive appears in the list as **Coming later**. Apple offers no supported
server API for iCloud Drive, so Stugu doesn't sign in to it with an Apple ID
password.

## Connecting a drive (owners)

Open **Set up → Operations → Backups and exports**. Under **Where scheduled
exports go**:

- **Dropbox:** choose **Connect** next to Dropbox, then **Open Dropbox**. Sign in and
  choose **Allow**. Dropbox then shows a code. Paste it into Stugu and choose
  **Finish connecting**.
- **Google Drive:** choose **Connect** next to Google Drive. Stugu shows a short code.
  On any phone or computer, open the address shown (`google.com/device`), enter
  the code, and choose **Allow**. The setup page notices the approval by itself.

Connecting a drive also makes it the selected destination. To switch, choose
another connected option. **Disconnect** forgets the account, revokes Stugu's
access where the provider allows it, and switches exports back to the NAS. Files
that were already uploaded stay where they are.

Only Owners and Admins can see or change this setting.

## What Stugu can reach

| Provider | Access requested | Where files go |
| --- | --- | --- |
| Dropbox | A scoped *App folder* app: Stugu sees only its own folder | `Apps/<app name>/data-exports/<schedule-id>/` |
| Google Drive | `drive.file`: Stugu sees only files and folders it created | `My Drive/Stugu/data-exports/<schedule-id>/` |

Each schedule keeps its newest *Files to keep* in its folder and removes older
files that Stugu itself created. The API uploads the CSV directly, so cloud
destinations don't need the NAS worker or the host storage agent.

The long-lived refresh token is stored in the protected integration secrets file
(`integration-secrets.json`, mode 0600), next to other connection credentials,
and is never returned by the API. Access tokens live only in memory. Stugu
waits ten minutes for a pasted Dropbox code, and for Google's device code as
long as Google allows (usually 30 minutes). If a provider later rejects the refresh token,
for example because access was removed in the account's security settings, the
next scheduled run fails with *"… access was removed. Connect … again in Set
up."*

## Enabling the providers (one-time, by the maintainer)

Each provider needs a registered app. Its ID is public and every installation
can share it, so the project builds the IDs into the API and owners never see
this step. Until an ID is set, that provider shows **Not enabled on this
installation yet**.

### Dropbox app

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create
   an app with **Scoped access** and **App folder** access.
2. Under **Permissions**, enable `files.metadata.read`, `files.content.read`,
   `files.content.write`, and `account_info.read`, then submit.
3. Under **Settings**, keep **Allow public clients (Implicit Grant & PKCE)**
   enabled. No redirect URI is needed: Stugu uses PKCE without a redirect, so
   Dropbox shows the code to paste.
4. Put the app key in `dropboxAppKey` (see [Built-in IDs](#built-in-ids)). It
   isn't a secret, and Stugu never uses an app secret.

A new Dropbox app is in *development* status and accepts up to 500 users. Apply
for production in the App Console before a wider rollout.

### Google OAuth client

1. In a Google Cloud project, enable the **Google Drive API**.
2. Configure the OAuth consent screen. Add the
   `https://www.googleapis.com/auth/drive.file` scope, which is non-sensitive,
   and set the publishing status to **In production**. In *Testing* status,
   refresh tokens expire after seven days.
3. Create an OAuth client ID of type **TVs and Limited Input devices**.
4. Put the client ID (it ends in `.apps.googleusercontent.com`) in
   `googleDriveClientId` and the client secret in `googleDriveClientSecret`
   (see [Built-in IDs](#built-in-ids)). Google doesn't treat this installed-app
   secret as confidential. Stugu still never returns it.

### Built-in IDs

`PROJECT_CLOUD_EXPORT_APPS` in `apps/api/src/config/cloud-export-apps.ts` holds
the project's IDs. They are compiled into the API image, so every installation
receives them with an ordinary application update. That includes the Raspberry
Pi appliance, which can't receive new environment variables that way (see
below). Fill in all of a provider's values in the same change.
`apps/api/tests/cloud-export-apps.test.ts` fails when a built-in value is
malformed or only half of the Google pair is set, because the API would then
refuse to start on every installation.

### Using a different app on one installation

An installation's environment overrides the built-in IDs. An empty variable
counts as unset and falls back to the built-in value.

- `STUGU_DROPBOX_APP_KEY` replaces the Dropbox app key.
- `STUGU_GOOGLE_DRIVE_CLIENT_ID` together with
  `STUGU_GOOGLE_DRIVE_CLIENT_SECRET` (or `STUGU_GOOGLE_DRIVE_CLIENT_SECRET_FILE`,
  which reads the secret from a file) replaces the built-in Google client.
  Google values replace it only as a pair, so your client ID is never sent with
  the project's secret.

The API refuses to start if `STUGU_DROPBOX_APP_KEY` or
`STUGU_GOOGLE_DRIVE_CLIENT_ID` is malformed, or if only one of the two Google
values is set.

Where to set them:

- **Docker Compose:** add the variables to `.env`. Compose passes them to the
  API container.
- **Raspberry Pi appliance:** use the built-in IDs. The appliance runs the
  Compose file baked into its host image (`/opt/stugu/docker-compose.yml`), and
  an application update only swaps the pinned container images. Values in
  `/persistent/stugu/stugu.env` reach the API only when that Compose file
  passes the variable through. Host images built from 0.59.0 or later pass
  `STUGU_DROPBOX_APP_KEY`, `STUGU_GOOGLE_DRIVE_CLIENT_ID` and
  `STUGU_GOOGLE_DRIVE_CLIENT_SECRET` (not the `_FILE` form). Older host images
  silently ignore all of them until a host update installs a newer image.
