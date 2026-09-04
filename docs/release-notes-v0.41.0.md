# Stugu 0.41.0 resilient heat-pump evidence and installable updates

Stugu 0.41.0 is an application-only release for the Raspberry Pi appliance. It
is the first release since 0.39.4 and carries the unpublished 0.40.0 and 0.40.1
changes. It keeps the passive thermal and moisture comparisons alive on homes
with a cloud-connected Gree/Wilfa heat pump, explains why a saved comparison
could not be updated, and keeps application updates installable when the update
feed's trust metadata is stale.

## What changed

- Thermal isolation and moisture response comparisons stay alive on homes with
  a cloud-connected Gree/Wilfa heat pump. The EWPE cloud poller used to end its
  session on a single failed poll and journal the pump as unavailable during
  every reconnect; those blips excluded whole evidence windows, and the nightly
  comparisons failed with "heat-pump evidence insufficient" night after night.
  The poller now retries transient failures in-session, and the journal records
  unavailability only for outages longer than three minutes, backdated to the
  first failed poll. The integration status keeps showing the pump as connected
  while the poller retries and reports the failure once the session gives up.
- The passive-analytics evidence policy gives an unavailability report no more
  weight than reporting silence: an `available: false` blip between two
  verified pump-off reports at most five minutes apart no longer breaks the
  pump-off evidence, while silence beyond a report's five-minute reach stays
  unclassified. Existing flap-polluted history becomes usable without touching
  the journal.
- Derived-analytics jobs that failed for a deterministic reason (insufficient
  heat-pump evidence, an over-large scope or result) are no longer retried
  until their whole attempt budget is spent.
- The thermal isolation, moisture response, and home performance panels
  explain recognized failure causes — scarce verified heat-pump-off evidence,
  the comparison's sensor limit, or an over-large result — in English, Finnish,
  and Swedish instead of only a generic failure notice.
- Application updates stay installable while the update feed's trust metadata
  is stale. Faults that describe the remote feed pause host updates only, with
  a plain-language explanation in all three languages; faults that describe
  the machine itself still block everything. The appliance doctor reports
  feed-scoped faults as warnings.
- Operator tooling gained a Tailscale diagnostic and repair tool for the
  appliance, and the release publisher refuses an implicit image prefix.

## Upgrade impact

This release changes application containers only. Existing telemetry,
databases, configuration, and durable analytics are retained. The thermal
isolation, moisture response, and home performance algorithm versions were
bumped, so the first nightly run (or a manual Refresh) recomputes each
comparison; homes stuck on "heat-pump evidence insufficient" recover on that
first run because the new evidence policy reads the existing journal. There is
no schema rewrite, signed host update, or factory-image requirement.
