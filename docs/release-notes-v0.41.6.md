# Stugu 0.41.6

Electricity cost calculations now seek the price periods that overlap each
measurement interval. Large price histories no longer cause every reading to
scan every stored price.

Local file-backed cost calculations run in a bounded, read-only worker. Dense
history can be cancelled or timed out while the API remains responsive to
health checks, current readings and other requests.

Consumption charts retain the measurement immediately before a rolling window
and an energy-counter observation exactly at its end. These anchors close the
same supported intervals used by the summary without adding out-of-range
observations to chart statistics. Counter resets, price gaps, source conflicts
and the 15-minute power hold remain explicit.

This is an application update. No database migration, configuration change,
Compose contract change or signed host update is required.
