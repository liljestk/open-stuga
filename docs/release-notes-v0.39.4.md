# Stugu 0.39.4 dependable analytics and safe exports

Stugu 0.39.4 is an application-only fix release for the Raspberry Pi appliance.
It removes a failure mode that could turn a valid analytics query into a server
error, makes derived analytics agree with each other regardless of which source
answered, and closes a spreadsheet-safety gap in every CSV export.

## What changed

- Analytics queries no longer fail when a single bucket contains a very large
  number of samples. Densely reporting sensors could push bucket minimum and
  maximum calculations past a JavaScript engine limit, returning a server error
  instead of a chart.
- Electricity price refresh failures report their real cause. Malformed price
  entries, duplicate intervals, and overlapping intervals previously appeared
  only as a generic "refresh failed", hiding what an operator needed to fix.
- Coverage and the low-coverage warning are now identical whether a query was
  answered from stored samples or from the pre-computed archive rollup, so the
  same question no longer produces two different quality verdicts.
- Requests that exceed the interactive point limit under automatic resolution
  now explain what to change, rather than recommending the automatic mode that
  is already selected.
- Every CSV export is protected against spreadsheet formula injection,
  including the chart's exact-data download and the historical-import template.
  Sensor names and labels are always written as inert text.
- Wide analytics queries group their source samples once instead of rescanning
  the whole window for each series, reducing time spent on multi-sensor views.

## Upgrade impact

This release changes application containers only. Existing telemetry,
databases, configuration, and durable analytics are retained. There is no
schema rewrite, signed host update, or factory-image requirement.
