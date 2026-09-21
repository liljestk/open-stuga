# Stugu 0.41.2

This stable application release includes the electricity and analytics fixes in
0.41.1 and corrects application-release readiness when the independent signed
host feed is unavailable or expired.

The release gate accepts only an isolated host-feed warning with structured
proof of no host journal or recovery state. All other appliance checks, exact
artifact verification, backups, and runtime update interlocks remain mandatory.
The warning remains visible; host signature and expiry checks are unchanged.

No database migration or host installation is required. Updater contract 3 and
Compose contract 2 are unchanged. Existing thermal/moisture artifacts refresh
as documented for 0.41.1. Build generation 21 is reserved for the local factory
artifacts; the installed host generation is unchanged. No factory upload or
signed host update is included.
