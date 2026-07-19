# Apple Notes bridge and Telegram alerts

Stuga supports two deliberately different workflows:

- **Telegram** is a real-time outbound alert channel. A rule must explicitly
  enable Telegram before Stuga sends anything.
- **Apple Notes** is a user-run iOS Shortcuts bridge for maintenance capture
  and dated snapshots. Stuga remains the source of truth.

Apple does not publish a server API for the Apple Notes database. Its current
Shortcuts actions document finding, creating, appending, moving, deleting, and
organising notes, but not atomic arbitrary body replacement or conflict-aware
document sync. Stuga therefore does not ask for an Apple Account password,
scrape iCloud.com, or claim invisible live synchronization.

## Telegram: guided setup

Open **Alerts → Notification delivery → Telegram alerts**. Telegram is a
Workspace-owned delivery channel, so this setup is available even when the
Workspace contains a Property without a Home.

1. In Telegram, open the verified [@BotFather](https://t.me/BotFather), run
   `/newbot`, and follow its prompts. Treat the returned bot token like a
   password.
2. Paste the token into Stuga. Stuga validates it with Telegram's `getMe`
   method but never returns it after it is saved.
3. Open the new bot in Telegram and send `/start` from the private chat that
   should receive alerts.
4. Choose **Find my private chat**. Stuga reads recent bot updates and shows
   private chats only; choose the intended recipient. This avoids copying a
   numeric chat ID from raw API JSON.
5. Save, then choose **Send test alert**. Set up is not complete until the test
   reaches the intended chat.
6. Open **Alerts**. For each new or existing rule that should leave Stuga,
   enable **Telegram**. The generic webhook and Telegram are separate options.

Telegram bots cannot initiate a conversation, so step 3 is required. If no
chat appears, send `/start` again and retry. A bot already configured with a
Telegram webhook cannot use `getUpdates` discovery at the same time; use a
dedicated Stuga bot or remove the other integration first.

### What an alert contains

Stuga sends a short plain-text summary with the severity, Home and sensor
label, rule, observed value, threshold, and start time. It does not send floor
plans, coordinates, credentials, free-form observation history, or occupant
information. `protect_content` is requested from Telegram, and informational
alerts are silent. Telegram cloud chats are not end-to-end encrypted Secret
Chats; do not put sensitive personal facts in Home, sensor, or rule names.

A successful Bot API response means Telegram accepted the message. It does not
mean a person saw or acted on it. Telegram is not a certified fire, leak, CO,
or emergency pager; retain suitable detectors and escalation paths.

### Advanced environment setup

The guided flow writes credentials to the protected integration-secrets file.
Container operators may instead set:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-with-the-botfather-token
TELEGRAM_CHAT_ID=123456789
```

Environment variables override saved values after a restart. Never commit a
real token, put it in a URL shared with another person, or paste it into a bug
report. Use BotFather's token rotation if it may have been exposed.

### Telegram troubleshooting

- **Token rejected:** confirm that it came from the verified BotFather chat;
  rotate it if it was copied through an untrusted application.
- **No private chat found:** open the bot, press **Start** or send `/start`, and
  retry discovery. Group chats are intentionally excluded from the personal
  setup flow.
- **Test succeeds but rules do not alert:** enable Telegram on the individual
  rule and use a real sensor source. Mock and replay samples never leave Stuga.
- **HTTP 429 / delivery error:** Telegram is rate-limiting the bot. Avoid many
  near-identical rules, wait, and retry the test later.
- **Focus mode or no sound:** delivery sound is controlled by Telegram and iOS
  notification settings. Stuga cannot override the phone's Focus settings.

Disconnecting removes the saved bot token and recipient from the local
integration store. Rotate the token in BotFather as well after a lost machine
or suspected disclosure. If credentials are supplied through environment
variables, remove those variables and restart too; the guided disconnect cannot
edit the container or service environment.

## Apple Notes: what the bridge does

The bridge provides two safe directions:

1. **Stuga → Notes:** fetch a current maintenance snapshot and create a dated,
   generated note.
2. **Notes → Stuga:** run a Share Sheet shortcut that creates one planned
   maintenance task from selected note text and explicit Shortcut prompts.

It does not interpret a checked Notes checkbox as verified maintenance. Stuga's
completion and verification notes, timestamps, and revision checks remain
authoritative. It also never overwrites a user-authored note.

## Apple Notes: prepare secure access

The bridge bearer authenticates only the snapshot and capture routes; it does
not add authentication to the rest of the local Stuga API. Making Stuga
reachable on a LAN therefore makes the full API reachable to every client that
the host firewall or reverse proxy permits.

Prefer one of these connectivity patterns:

- **Private VPN or authenticated reverse proxy:** keep Stuga private, restrict
  the phone identity, and publish only
  `GET /api/v1/integrations/apple-notes/snapshot` and
  `POST /api/v1/integrations/apple-notes/capture` when the proxy supports a
  route allowlist. Keep **Set up**, grant management, and the general API
  loopback-only.
- **Trusted home LAN:** set `BIND_ADDRESS` in `.env` to the server's specific
  LAN address (not `0.0.0.0`), restart Compose, and restrict the application
  port with the host firewall. Use this only where every permitted LAN client
  is trusted. Add HTTPS before traffic crosses an untrusted network.

  ```dotenv
  BIND_ADDRESS=192.168.1.20
  APP_PORT=8080
  ```

  ```powershell
  docker compose up -d
  ```

Open the Stuga setup page through that reachable hostname or IP before copying
the generated URLs. If the page itself uses `localhost` or `127.0.0.1`, the
copied URL points back to the iPhone and cannot reach the server.

Then prepare the device:

1. Confirm that the iPhone can reach the chosen private address. Do not expose
   the application directly to the public internet; built-in account sign-in
   does not encrypt network traffic.
2. Use HTTPS whenever traffic crosses a network you do not fully trust.
3. In Notes, create an **iCloud** folder named `Stuga`. Notes under **On My
   iPhone** do not appear on other Apple devices.
4. Open **Set up → Automations → Apple Notes bridge**, select the Home, enter an
   operator device label such as `Niklas iPhone`, and create a grant. The label
   is an audit hint for the operator; it is not a device identity.
5. Copy the bearer token immediately. It is shown once. The revocable grant is
   restricted to the selected Home and the Notes bridge endpoints, but it is
   not bound to or authenticated by the labelled device. Stuga retains only
   the token's SHA-256 hash and cannot reveal the original later.
6. Decide whether this credential may be copied through iCloud Shortcuts sync.
   Sync can copy a Shortcut containing the bearer to other devices, while its
   Personal Automation remains device-specific. Treat every device that
   receives the Shortcut as authorized. Otherwise disable Shortcuts sync or
   use a non-synced Shortcut, and revoke the grant if any recipient device is
   lost or untrusted.

The setup card provides the exact snapshot and capture URLs for the current
installation. A URL containing `localhost` or `127.0.0.1` refers to the phone
itself when used on iOS and will not reach Stuga.

## Shortcut 1: Refresh Stuga maintenance

Create a shortcut named **Refresh Stuga maintenance** with these actions:

1. **URL** — paste the snapshot URL copied from Set up. It includes the selected
   `houseId` query parameter.
2. **Get Contents of URL** — method `GET`; add header `Authorization` with value
   `Bearer ` followed by the one-time token.
3. **Get Dictionary Value** — key `text` from the response.
4. **Create Note** — use that text in the `Stuga` iCloud folder. Keep **Show
   Compose Sheet** enabled for the first test. After confirming the result,
   turn it off only if you want this action to run unattended.
5. **Show Result** — display `Snapshot created`.

Each run creates a dated generated snapshot. Archive or delete older generated
snapshots when no longer useful. This avoids destructive replacement and makes
the direction of synchronization obvious.

You may add a **Time of Day** Personal Automation to run this shortcut. Choose
**Run Immediately**, or disable **Ask Before Running** where that option is
offered. Test the complete automation on that device: some actions, privacy
permissions, or OS versions may still require interaction. The Personal
Automation is device-specific and does not sync, even when iCloud Shortcuts
sync copies its underlying Shortcut to another iPhone or iPad.

## Shortcut 2: Send a note to Stuga

Create a shortcut named **Send maintenance to Stuga** and enable **Show in Share
Sheet**, accepting text input. Add these actions:

1. **Ask for Input** — maintenance title.
2. **Choose from Menu** — basis: `required`, `scheduled`, `condition-based`,
   `predictive`, or `optional-improvement`.
3. **Choose from Menu** — priority: `low`, `normal`, `high`, or `urgent`.
4. **Generate UUID** — do this exactly once, before any in-run **Repeat** or
   retry step. Store it in a variable as the `operationId`, and reuse that same
   variable for every HTTP attempt during this Shortcut run.
5. **Dictionary** — construct this JSON-compatible value:

   ```json
   {
     "schema": "stuga.apple-notes-command/v1",
     "operationId": "<Generated UUID>",
     "houseId": "<Home ID copied from Set up>",
     "title": "<Ask for Input result>",
     "description": "<Shortcut Input>",
     "basis": "condition-based",
     "priority": "normal"
   }
   ```

   Add `plannedFor` or `dueBy` only as `YYYY-MM-DD`. Predictive tasks cannot
   claim a formal due date.
6. **URL** — paste the capture URL from Set up.
7. **Get Contents of URL** — method `POST`, request body `JSON`, using the
   Dictionary; add the same `Authorization: Bearer …` header.
8. **Get Dictionary Value** — key `receipt`, then **Show Result**.

Stuga derives a stable task ID from `operationId`. Repeating the identical
request with the same in-run variable returns the existing task instead of
creating a duplicate. Reusing the UUID with different content is rejected as a
conflict.

Restarting the Shortcut normally generates a new UUID and therefore a new
operation, unless you deliberately persist and restore the UUID. Do not blindly
rerun the Shortcut after a timeout or other unknown response. Check Stuga's
maintenance list first; only retry with the original UUID when it was preserved
and the request content is identical.

## Grant and sync troubleshooting

- **401:** the token is missing, mistyped, or revoked. Create a new
  Home-scoped Shortcut grant; Stuga cannot reveal the old token.
- **403:** the grant belongs to a different Home. Use that Home's URL or
  create another grant.
- **409:** the operation UUID was reused with different content. Generate a new
  UUID for genuinely new work.
- **Phone cannot connect:** verify the URL from Safari on the phone, then check
  the private-LAN/VPN route, firewall, reverse proxy, and TLS certificate.
- **Notes asks for access:** allow the Shortcut access to Notes and the Stuga
  host. Permissions can be reviewed in the Shortcut's details.
- **Wrong Notes account:** choose the `Stuga` folder under iCloud, not a local
  or third-party Notes account.

Revoke a grant from **Set up** immediately if any device that received its Shortcut
is lost, sold, or untrusted. The operator device label helps identify intended
use but does not enforce device binding. Grant tokens should live only in
Shortcuts—not in Notes, screenshots, chat messages, or source control.

## Platform references

- [Apple: request an API from Shortcuts](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)
- [Apple: run a Shortcut from another app](https://support.apple.com/guide/shortcuts/launch-a-shortcut-from-another-app-apd163eb9f95/ios)
- [Apple: share actions and Append to Note](https://support.apple.com/en-ca/guide/shortcuts/apdaf74d75a5/ios)
- [Apple: personal automation behavior](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios)
- [Apple: Shortcut sync limitations](https://support.apple.com/guide/shortcuts/sync-shortcuts-apdb3a4240b0/ios)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram bot basics and token security](https://core.telegram.org/bots)
- [Telegram cloud-chat encryption model](https://telegram.org/faq#q-so-how-do-you-encrypt-data)
