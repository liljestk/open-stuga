# Release operator context template

Keep the completed copy in the operator's protected ceremony store, outside
Git. It contains paths and state, not private-key or token values. Give a
release agent the completed form or the exact fields it needs.

## Public topology

- Source repository: `liljestk/open-stuga`
- Public release repository: `liljestk/stugu-releases`
- Container prefix: `ghcr.io/liljestk/open-stuga`
- Default release channel: `<stable | preview>`
- Default factory-image upload: `<yes | no>`

## Build inputs

- Recovery SSH public-key path: `<absolute path>`
- Recovery public-key fingerprint: `<SHA256 fingerprint>`
- Approved TUF root-v1 JSON path: `<absolute path>`
- TUF root-v1 SHA-256: `<hex digest>`
- Approved RAUC CA PEM path: `<absolute path>`
- RAUC CA SHA-256: `<hex digest>`
- Host-update base URL: `<https URL without query or fragment>`
- Hardware-qualification receipt path: `<absolute path or omitted>`
- Qualification target identity: `<exact appliance or omitted>`

The recovery public key, TUF root, RAUC CA certificate, and update URL are not
secrets. Their approved bytes and paths are ceremony-controlled because an
unreviewed replacement changes appliance trust or recovery access. Private
recovery, RAUC, and TUF keys are never entered here.

## Monotonic state

- Last allocated host generation: `<integer>`
- Evidence: `<previous provenance or publication-receipt path and SHA-256>`
- Next allocated host generation: `<integer, recorded before build>`
- Previous stable host-publication receipt: `<path or none>`
- Previous preview host-publication receipt: `<path or none>`

Do not infer the next generation from a release number. Allocate a value above
every factory or host generation already issued, and never reuse a generation
for different bytes.

## Access and deployment target

- GitHub account used by `gh`: `<login>`
- Confirmed access: `<source read/write, feed write, GHCR package write>`
- Intended appliance: `<unique name/hardware ID>`
- Appliance access method: `<LAN, Tailscale, or local console>`
- Current Stugu version: `<version, observed with stuguctl status>`
- Application channel: `<stable | include previews>`

Never put a GitHub token, Pi private key, Wi-Fi profile, Connect auth key, bug
report token, or signing private key in this form or command output.
