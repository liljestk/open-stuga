# Dropbox and Google Drive export destinations

Scheduled CSV exports can go to the shared NAS, or to a Dropbox or Google Drive
account of your own. Each Owner and Admin chooses for themselves: the choice
applies to the schedules they set up, in every Home. Recovery backups are not
affected. They stay on the NAS, or on this device when no NAS is connected,
because they contain stored integration credentials and can be several
gigabytes.

iCloud Drive appears in the list as **Coming later**. Apple offers no supported
server API for iCloud Drive, so Stugu doesn't sign in to it with an Apple ID
password.

## Connecting your drive

Open **Data & analytics**, then **Scheduled exports** in the export panel. Under
**Where your scheduled exports go**:

- **NAS:** shared by everyone on the installation. It's the backup location
  set under **System → Storage**; until one is set, the option links there.
- **Needs a one-time setup first:** the installation has no app for that
  provider yet. Choose **Set up** and follow
  [Entering your own app](#entering-your-own-app). Stugu then goes straight on
  to the sign-in below.
- **Dropbox:** choose **Connect** next to Dropbox, then **Open Dropbox**. Sign in and
  choose **Allow**. Dropbox then shows a code. Paste it into Stugu and choose
  **Finish connecting**.
- **Google Drive:** choose **Connect** next to Google Drive. Stugu shows a short code.
  On any phone or computer, open the address shown (`google.com/device`), enter
  the code, and choose **Allow**. The page notices the approval by itself.

Connecting a drive also makes it your destination. To switch, choose another
connected option. **Disconnect** forgets your account, revokes Stugu's access
where the provider allows it, and switches your exports back to the NAS. Files
that were already uploaded stay where they are.

Only Owners and Admins schedule exports, so only they see this choice.

## Whose drive a schedule uses

A drive belongs to the person who connected it:

- Nobody else on the installation sees it, its account name, or its sign-in,
  and nobody else can disconnect it or save to it.
- Each schedule records the Owner or Admin who created it, and every run goes
  where that person currently sends their exports. The schedule list shows
  where each schedule saves and who set it up. Another Admin may still pause,
  run, or delete it.
- When someone is removed from the workspace, Stugu revokes and forgets their
  drives at once, and their schedules save to the shared NAS from then on, so
  Home data never keeps flowing to a former member's account. A run also checks
  that the owner is still an Owner or Admin before it uploads anywhere but the
  NAS.
- Schedules created before 0.62.0 have no owner and save to the NAS.

Releases 0.59.0 to 0.61.x had one installation-wide sign-in per provider.
Stugu can't tell who connected it, so 0.62.0 revokes those sign-ins when the
API starts and forgets them. Reconnect your own drive afterwards.

The provider apps those sign-ins run through stay installation-wide; see
[Enabling the providers](#enabling-the-providers).

## What Stugu can reach

| Provider | Access requested | Where files go |
| --- | --- | --- |
| Dropbox | A scoped *App folder* app: Stugu sees only its own folder | `Apps/<app name>/data-exports/<schedule-id>/` |
| Google Drive | `drive.file`: Stugu sees only files and folders it created | `My Drive/Stugu/data-exports/<schedule-id>/` |

Each schedule keeps its newest *Files to keep* in its folder and removes older
files that Stugu itself created. The API uploads the CSV directly, so cloud
destinations don't need the NAS worker or the host storage agent.

Each person's long-lived refresh token is stored in the protected integration
secrets file (`integration-secrets.json`, mode 0600) under
`exportDestinations.people.<account ID>`, next to other connection credentials,
and is never returned by the API. Access tokens live only in memory. Stugu
waits ten minutes for a pasted Dropbox code, and for Google's device code as
long as Google allows (usually 30 minutes). If a provider later rejects the refresh token,
for example because access was removed in the account's security settings, the
next scheduled run fails with *"… access was removed. Connect … again under
Scheduled exports."*

## Enabling the providers

Each provider needs a registered app. An installation gets it from one of three
places. When more than one is set, the first one wins:

1. **Deployment variables.** The operator sets them; see
   [Using a different app on one installation](#using-a-different-app-on-one-installation).
2. **Entered in Stugu.** An Owner or Admin registers an app and pastes its ID;
   see [Entering your own app](#entering-your-own-app).
3. **Built-in IDs.** The project's own app, compiled into the API; see
   [Built-in IDs](#built-in-ids).

Until one of them provides an app, that provider shows **Needs a one-time setup
first** with a **Set up** button.

### Entering your own app

Choose **Set up** next to the provider under **Where your scheduled exports
go**. Everyone on the installation then signs in to their own account through
this one app. The form links to the provider's
console and lists the steps below in short form. Paste the Dropbox app key, or
the Google client ID and client secret, and choose **Save and connect**.

- The values are stored in the protected integration secrets file
  (`integration-secrets.json`, mode 0600) under `exportDestinations.apps`. The
  API never returns the Google client secret.
- This works on every installation, including the Raspberry Pi appliance, with
  no host update or environment variable.
- **Change app** and **Remove app** appear next to a provider whose app was
  entered in Stugu. They work only while nobody's account is connected through
  it, because a connected account's refresh token belongs to the app it signed
  in through. Everyone connected to that provider disconnects first (or is
  removed from the workspace); then change the app and connect again.
  **Remove app** falls back to the built-in app, if there is one.
- Stugu doesn't offer to change an app that deployment variables set, and the
  API refuses with `CLOUD_EXPORT_APP_ENVIRONMENT_OWNED`.

### Dropbox app

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create
   an app with **Scoped access** and **App folder** access.
2. Under **Permissions**, enable `files.metadata.read`, `files.content.read`,
   `files.content.write`, and `account_info.read`, then submit.
3. Under **Settings**, keep **Allow public clients (Implicit Grant & PKCE)**
   enabled. No redirect URI is needed: Stugu uses PKCE without a redirect, so
   Dropbox shows the code to paste.
4. Paste the app key from **Settings** into Stugu, or put it in
   `dropboxAppKey` (see [Built-in IDs](#built-in-ids)). It isn't a secret, and
   Stugu never uses an app secret.

A new Dropbox app is in *development* status and accepts up to 500 users. Apply
for production in the App Console before a wider rollout.

### Google OAuth client

1. In a Google Cloud project, enable the **Google Drive API**.
2. Configure the OAuth consent screen. Add the
   `https://www.googleapis.com/auth/drive.file` scope, which is non-sensitive,
   and set the publishing status to **In production**. In *Testing* status,
   refresh tokens expire after seven days.
3. Create an OAuth client ID of type **TVs and Limited Input devices**.
4. Paste the client ID (it ends in `.apps.googleusercontent.com`) and the
   client secret into Stugu, or put them in `googleDriveClientId` and
   `googleDriveClientSecret` (see [Built-in IDs](#built-in-ids)). Google
   doesn't treat this installed-app secret as confidential. Stugu still never
   returns it.

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
- **Raspberry Pi appliance:** enter your own app in Stugu, or use the
  built-in IDs. Environment variables are unreliable there: the appliance runs the
  Compose file baked into its host image (`/opt/stugu/docker-compose.yml`), and
  an application update only swaps the pinned container images. Values in
  `/persistent/stugu/stugu.env` reach the API only when that Compose file
  passes the variable through. Host images built from 0.59.0 or later pass
  `STUGU_DROPBOX_APP_KEY`, `STUGU_GOOGLE_DRIVE_CLIENT_ID` and
  `STUGU_GOOGLE_DRIVE_CLIENT_SECRET` (not the `_FILE` form). Older host images
  silently ignore all of them until a host update installs a newer image.
