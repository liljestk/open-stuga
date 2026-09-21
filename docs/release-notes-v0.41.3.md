# Stugu 0.41.3

Verified pre-update backups now have the same bounded 24-hour allowance as
storage-move backups. Large database snapshots and integrity checks can finish
without hitting the 45-minute limit intended for other container commands.

Application and unified application/host workflows both use this allowance.
Other command deadlines, signature checks, mutation journals and fail-closed
recovery remain unchanged. No database migration or host activation is required.

Includes the product updates and application/host-feed readiness fix from 0.41.2.
