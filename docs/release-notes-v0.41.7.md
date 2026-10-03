# Stugu 0.41.7

Electricity history preparation now starts and ends with each meter's recorded
history. A year view of a recently connected meter no longer schedules a year
of empty days. Counter gaps within recorded history and bounded power holds
remain part of the calculation.

Unfinished history is a retryable preparation state. It does not trigger a
large raw-history fallback or unrelated archive catch-up, and cost requests
avoid full pricing joins until their required summaries are ready. Active
usage and cost views refresh automatically while preparing and keep the
selected period and sources. Inactive cost requests are cancelled.

The original requested period and partial-coverage labels are preserved.
Missing history is never presented as a complete year or zero usage.

This is an application update. No database migration, configuration change,
Compose contract change or signed host update is required. Existing readings
and pending preparation work are retained; catch-up may continue after the
update. Normal pre-update backup and runtime safety checks remain required.
