# Stuga companion for iOS

Native SwiftUI companion for monitoring a Stuga installation from iPhone or
iPad. It connects directly to the user-selected Stuga server; there is no
intermediary app service.

## Included

- Existing Stuga cookie authentication and CSRF protection
- Property-aware Home selection
- Exception-first Home summary with live measurement freshness
- Sensor list and native Swift Charts history
- Workspace alert list and explicit alert acknowledgement
- Guest/read-only behavior, dark mode, Dynamic Type, VoiceOver labels, and
  English/Finnish/Swedish localization foundations
- Metric/imperial temperature display without changing canonical API values
- Authenticated server-sent events with bounded reconnect and pull-to-refresh
- Opt-in, filtered Core Bluetooth equipment observation with a protected,
  bounded seven-day offline queue
- Uncertainty-aware MapKit equipment map and foreground Find nearby guidance
- Property-wide inventory with attention summary, search, service/area
  filters, native add/edit, QR scanning, and printable labels
- Equipment notes, issue reporting, borrowing, and returns
- Explicit foreground-only member location sharing on the Property map

Full setup, floor-plan editing, analytics, maintenance planning, and
administration remain in the web app.

## Open and run

Requirements: Xcode 16 or newer and iOS 17 or newer.

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
- Environmental telemetry is held in memory. Opt-in BLE observations are
  persisted before upload, expire after seven days, and use iOS file protection.
- Observer credentials are installation-bound and stored in Keychain.
- The privacy manifest declares linked precise/coarse location and the
  installation identifier for app functionality. They are not used for
  advertising tracking.
- Camera frames used for equipment QR scanning stay on the device.
- Member location sharing is optional, uses When In Use location only, stores
  current presence rather than a trail, and stops when the app leaves the
  foreground or its timer expires.
- iOS background Bluetooth detections are opportunistic: duplicate discoveries
  can be coalesced and scan timing remains under system control.
- The app uses the same `/api/v1` session and alert contracts and `/api/v2`
  measurement contracts as the web client.
