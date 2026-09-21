# Stugu 0.41.1

This stable application release combines the pending electricity and analytics
corrections.

- Restore Home and Property electricity totals, use quarter-hour price
  summaries correctly, and distinguish unavailable or partial consumption.
- Read electricity graphs across the complete selected range, preserve meter
  selection across metric changes, exclude submeters from whole-Home totals,
  and improve narrow-screen chart controls.
- Reuse cached climate-history interiors and read only their uncovered edges.
  Large local reads and merged results yield between bounded chunks so the
  API remains responsive. SQLite spill files use the data volume, and archive
  reads can recover from a failed local read.
- Keep thermal and moisture calculations inside uninterrupted passive
  periods. Explain unavailable scores and show genuine history gaps without
  hiding valid readings under old outage records.
- Document supported Raspberry Pi application-update recovery and update
  runtime dependencies, fonts, testing tools, and manually invoked CI actions.

## Upgrade impact

No database schema or configuration migration is required. Existing prices
are normalized on read. Corrected thermal and moisture algorithm identities
make older derived artifacts stale; they refresh through the normal schedule
or an explicit refresh. A score based on evidence spanning pump activity may
become unavailable after recalculation.

The updater contract remains 3 and the Compose contract remains 2. Installation
uses the existing application updater, its verified backup, digest-pinned
images, health checks, and rollback. The installed host OS and host generation
remain unchanged. No signed host update or factory-image upload is included.
