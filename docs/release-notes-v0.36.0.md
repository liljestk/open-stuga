# Stugu 0.36.0 in-app bug-report relay configuration

Stugu 0.36.0 lets a workspace administrator turn on private bug reporting from
the app. Previously **Report a bug** could only reach the maintainers when the
deployment already carried `BUG_REPORT_RELAY_URL` and a mounted relay token, so
most installs saw "Bug reporting is not configured yet" with no way forward.

## What changed

- **System → Bug report relay** accepts the HTTPS relay address and its shared
  token from an Owner or Admin. The token is validated (absolute HTTPS URL
  without embedded credentials, at least 32 characters), written to the existing
  protected integration secrets file, and applied immediately — no restart.
- `GET`, `PUT`, and `DELETE /api/v1/bug-reports/relay` back that panel. The
  stored token is never returned to a browser, both writes are recorded as
  security-audit events, and members never see the panel.
- Deployment environment variables stay authoritative: when
  `BUG_REPORT_RELAY_URL` is set, the relay is shown read-only and the API
  answers writes with `409 BUG_REPORT_RELAY_ENVIRONMENT_OWNED`.
- The unconfigured message now points administrators at that panel, and the
  offered **Download copy** fallback works in Firefox and Safari.

The report contents, privacy review, size and field limits, per-account rate
limit, and the relay's exclusive ownership of the GitHub App credential are
unchanged. The relay Worker itself still has to be deployed by the maintainer.

There is no persistent-data migration change. Installs that already configure
the relay through the environment keep working exactly as before.
