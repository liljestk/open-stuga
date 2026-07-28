# Stugu for iOS, iPadOS, and macOS

The iPhone app is a lightweight native SwiftUI companion for quick monitoring
and field work. iPad and Mac Catalyst present the complete server-hosted Stugu
interface in a native shell, so their features and information architecture stay
in step with the web product. Every platform connects directly to the
user-selected Stugu server; there is no intermediary app service.

## Included

- Existing Stugu cookie authentication and CSRF protection
- Full web-product parity on iPad and Mac, including setup, analytics,
  maintenance planning, administration, and developer tools
- A deliberately lighter tab-based iPhone interface for glanceable status,
  alerts, sensors, inventory, and capture
- Property-aware Home selection with clear owned/remote Stuguby origin, sync,
  and edit-policy cues across the app, widgets, and Watch
- Exception-first Home summary with live measurement freshness
- Sensor list and native Swift Charts history
- Live TP-Link door/window contact state, bounded opening history, transition
  summaries, and direct handoff to the full management surface
- Workspace alert list and explicit alert acknowledgement
- Opt-in actionable native notifications delivered directly from the user's
  Stugu server through APNs, with generic lock-screen text by default
- Protected offline Home snapshots and history, plus a bounded retry queue for
  observations, maintenance items, and alert acknowledgement
- Home Screen and Lock Screen widgets, App Shortcuts, deep links, and quick
  field capture with equipment QR scanning
- Reviewed single-room floor capture on supported LiDAR devices using RoomPlan;
  only derived metre-based geometry is imported
- A dependent Apple Watch companion for Home status, unseen alerts, refresh,
  and alert acknowledgement without copying Stugu credentials to the Watch
- Evidence-based Today guidance for weather, ventilation, and electricity;
  advice remains read-only and explains stale or insufficient data
- Guest/read-only behavior, dark mode, Dynamic Type, VoiceOver labels, and
  English/Finnish/Swedish localization foundations
- Metric/imperial temperature display without changing canonical API values
- Authenticated server-sent events with bounded reconnect and pull-to-refresh
- Opt-in, filtered Core Bluetooth equipment observation with a protected,
  bounded seven-day offline queue
- Uncertainty-aware MapKit equipment map and foreground Find nearby guidance
- Property-wide inventory with attention summary, search, service/location
  filters, native add/edit, QR scanning, printable labels, Home/area/unassigned
  placement, one-shot current-location pins, and a Property-aware map picker
- Equipment notes, issue reporting, borrowing, and returns
- Explicit foreground-only member location sharing on the Property map
- Owner/Admin visibility into installed and available versions, durable system
  update progress, live reconnecting status, and recent update-agent activity

The iPad and Mac app use the same server-hosted interface as a browser instead
of maintaining a second implementation of every desktop feature. The iPhone
companion opens that full interface when a desktop-oriented workflow is needed.

## Open and run

Requirements: Xcode 26 or newer, iOS 26 or newer, macOS 26 or newer for the
Mac Catalyst app, and watchOS 10 or newer for the Watch companion.

1. Open `Stugu.xcodeproj`.
2. Choose the `Stugu` scheme and an iPhone/iPad simulator or **My Mac
   (Mac Catalyst)**.
3. Build and run.
4. Enter the root address of a reachable Stugu installation.

`project.yml` is the canonical XcodeGen specification. If source files are
added, regenerate the checked-in project with:

```sh
cd apps/ios
xcodegen generate
```

Run the portable contract and policy tests on macOS:

```sh
swift test --package-path apps/ios
```

Build without signing:

```sh
xcodebuild \
  -project apps/ios/Stugu.xcodeproj \
  -scheme Stugu \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Build the Mac app without signing:

```sh
xcodebuild \
  -project apps/ios/Stugu.xcodeproj \
  -scheme Stugu \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## iPad and macOS scope

After native connection and sign-in, iPad and Mac load the selected
installation's complete Stugu interface with shared session cookies. Browser
history, downloads, file import, confirmation dialogs, links, and responsive
layout remain available. A small native app bar adds quick capture, device
settings, reload, and browser handoff without replacing the web navigation.
If the server is unavailable, protected cached data remains accessible through
an explicitly labelled offline companion view.
The Watch app remains paired with the iPhone, and RoomPlan capture remains an
iPhone/iPad task.

The Mac app does not embed a second Stugu server. The Node/SQLite control
plane, Python TP-Link bridge, optional databases, backup/update agent, and
integration credentials remain one separately managed installation. Bundling
those components into the GUI would create a second deployment and update
boundary rather than make the platform native. Full setup, administration,
and research views therefore continue to run on that installation and are
presented by the large-screen app rather than duplicated in Swift.

## Connection and security

- Public addresses must use HTTPS.
- Plain HTTP is accepted only for loopback, `.local`/Home ARPA names, and
  private or link-local IP addresses.
- Native API requests support a Cloudflare Access service token. The token
  secret stays in Keychain and is never injected into web content; the
  large-screen interface uses the resulting Access cookie. Access applications
  must retain an Allow policy as well as the token's Service Auth policy.
- `NSAllowsLocalNetworking` is enabled for trusted-LAN installations; arbitrary
  transport-security exceptions are not.
- Passwords are never persisted. Server-managed session cookies are synchronized
  between native networking and the large-screen WebKit view, and removed when
  the user disconnects.
- Live environmental telemetry is held in memory. Opt-in BLE observations are
  persisted before upload, expire after seven days, and use iOS file protection.
- The latest Home snapshot, bounded chart history, and pending field actions
  use iOS file protection, are excluded from device backups, and are removed on
  sign-out or disconnect. Widgets receive only a small summary through the
  signed app group.
- Observer credentials are installation-bound and stored in Keychain.
- The privacy manifest declares linked precise/coarse location and the
  installation identifier for app functionality. They are not used for
  advertising tracking.
- Camera frames used for equipment QR scanning stay on the device.
- RoomPlan capture data stays on the device while scanning. Import sends only
  reviewed walls, one room outline, and door/window geometry; the API rejects
  images. Raw USDZ/JSON export is a separate, explicit share action.
- The dependent Watch app receives a minimal Home/alert snapshot and opaque
  alert identifiers. It receives no cookie, password, or server URL and needs
  the paired iPhone to communicate with Stugu.
- Choosing the current location for an equipment pin makes one foreground
  location request. The point is stored only if the inventory record is saved.
- Member location sharing is optional, uses When In Use location only, stores
  current presence rather than a trail, and stops when the app leaves the
  foreground or its timer expires.
- iOS background Bluetooth detections are opportunistic: duplicate discoveries
  can be coalesced and scan timing remains under system control.
- The app uses the same `/api/v1` session and alert contracts and `/api/v2`
  measurement contracts as the web client.

## Push notifications and widget signing

In Xcode, select a development team for the app, widget, and Watch targets.
Enable the `group.net.nysta.stuga` App Group for the iOS app and widget, and
enable Push Notifications for the `Stugu` app target. The server needs the
optional APNs configuration documented in `docs/getting-started.md`; it
contacts Apple directly and never sends device tokens through a Stugu relay.

Room scanning appears only on devices where RoomPlan is supported. Choose an
empty or single-room floor, scan one room, review the derived plan, and confirm
before replacing existing geometry. Existing sensor and observation coordinates
aren't moved automatically, so review their placement afterward. Import requires
an online writable session.
