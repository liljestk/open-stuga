# Stugu 0.39.3 reliable history and recovery

Stugu 0.39.3 is an application-only reliability patch for the Raspberry Pi
appliance. It keeps the responsive analytics work from 0.39.2 while preventing
stale history requests and hidden tabs from starving current data.

## What changed

- Browser requests are bounded and prioritized. Obsolete history loads are
  cancelled, mutations keep a reserved path, and request timeouts start only
  after queued work is actually sent.
- Successful history and supporting evidence remain visible during refreshes.
  Failures are shown as stale or partial data with a recovery action instead of
  being presented as missing recorded measurements.
- Twenty-four-hour history is bucketed in the database read path, reducing raw
  rows, API event-loop work, and memory pressure on the appliance.
- Hidden tabs release long-lived event connections and perform one
  authoritative refresh when they become visible again.
- Native updater safety codes are normalized into calm, specific explanations;
  unknown future codes remain safely blocked and available in diagnostics.

## Upgrade impact

This patch changes application containers and diagnostics only. Existing
telemetry, databases, configuration, and cached history are retained. There is
no schema rewrite, signed host update, or factory-image requirement.
