# Stugu 0.36.1 reliability and in-app bug-report setup

Stugu 0.36.1 combines the unreleased 0.36.0 bug-report configuration work with
the follow-up request-cancellation and security-audit fixes. It is an
application release compatible with the existing generation-15 Raspberry Pi
host; no new signed host update is included.

## What changed

- Owners and Admins can configure or remove the private bug-report relay from
  **System → Bug report relay**. The shared token stays in the protected
  integration-secrets file and is never returned to the browser. Deployment
  environment variables remain authoritative and read-only.
- Routine browser navigation and analytics-cache invalidation now produce a
  retryable `503 REQUEST_CANCELLED` response instead of a false server error.
  Cancelled requests no longer pollute the exported system error log.
- Monitoring reads already in progress may finish after their cache entry is
  invalidated; only the stale result is prevented from entering the cache.
- Upgraded databases accept every current security-audit subject, fixing
  update, storage, and Cloudflare setup operations that previously failed while
  recording their audit event.
- The repository now contains a transferable application-release runbook with
  explicit source/feed tagging, approval, artifact-audit, failure-recovery, and
  host-signing boundaries.

## Upgrade impact

The security-audit table is rebuilt in place on first start. Existing audit
events are preserved and no operator action is required. Existing bug-report
environment configuration continues to work unchanged. Clients should treat
`503 REQUEST_CANCELLED` as retryable rather than as an appliance outage.
