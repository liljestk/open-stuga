# Stuga companion for iOS

Native SwiftUI companion for monitoring a Stuga installation from iPhone or
iPad. It connects directly to the user-selected Stuga server; there is no
intermediary app service.

## Included

- Existing Stuga cookie authentication and CSRF protection
- Property-aware Home selection with clear owned/remote Stugby origin, sync,
  and edit-policy cues across the app, widgets, and Watch
- Exception-first Home summary with live measurement freshness
- Sensor list and native Swift Charts history
- Workspace alert list and explicit alert acknowledgement
- Opt-in actionable native notifications delivered directly from the user's
  Stuga server through APNs, with generic lock-screen text by default
- Protected offline Home snapshots and history, plus a bounded retry queue for
  observations, maintenance items, and alert acknowledgement
- Home Screen and Lock Screen widgets, App Shortcuts, deep links, and quick
  field capture with equipment QR scanning
- Reviewed single-room floor capture on supported LiDAR devices using RoomPlan;
  only derived metre-based geometry is imported
- A dependent Apple Watch companion for Home status, unseen alerts, refresh,
  and alert acknowledgement without copying Stuga credentials to the Watch
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
  placement, and manual map pins
- Equipment notes, issue reporting, borrowing, and returns
- Explicit foreground-only member location sharing on the Property map
- Owner/Admin visibility into installed and available versions, durable system
  update progress, live reconnecting status, and recent update-agent activity

Full setup, detailed floor-plan editing, analytics, maintenance planning, and
administration remain in the web app. The companion shows system-update status
but sends update scheduling and installation changes to the web app.

## Open and run

Requirements: Xcode 16 or newer, iOS 17 or newer, and watchOS 10 or newer for
the Watch companion.

1. Open `Stuga.xcodeproj`.
2. Choose the `Stuga` scheme and an iPhone or iPad simulator.
3. Build and run.
4. Enter the root address of a reachable Stuga installation.

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
  -project apps/ios/Stuga.xcodeproj \
  -scheme Stuga \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Connection and security

- Public addresses must use HTTPS.
- Plain HTTP is accepted only for loopback, `.local`/Home ARPA names, and
  private or link-local IP addresses.
- The first release expects a directly reachable Stuga origin, typically over
  the trusted LAN or a private VPN. It does not yet bridge an interactive
  Cloudflare Access browser sign-in into the native URL session.
- `NSAllowsLocalNetworking` is enabled for trusted-LAN installations; arbitrary
  transport-security exceptions are not.
- Passwords are never persisted. The server-managed session cookie is stored by
  iOS and removed when the user disconnects.
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
  the paired iPhone to communicate with Stuga.
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
enable Push Notifications for the `Stuga` app target. The server needs the
optional APNs configuration documented in `docs/getting-started.md`; it
contacts Apple directly and never sends device tokens through a Stuga relay.

Room scanning appears only on devices where RoomPlan is supported. Choose an
empty or single-room floor, scan one room, review the derived plan, and confirm
before replacing existing geometry. Existing sensor and observation coordinates
aren't moved automatically, so review their placement afterward. Import requires
an online writable session.
