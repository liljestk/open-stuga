# Stugu 0.35.2 preview

Stugu 0.35.2 is a focused presentation and safety patch for the unified
application and Raspberry Pi host-update experience.

## Highlights

- Show **Update information needs attention** instead of claiming Stugu is up
  to date when the application update agent or trusted native host updater is
  unavailable.
- Treat incomplete target metadata and an unbound prepared host target as
  blocked at the top of the update card, matching the component-level state.
- Preserve higher-priority recovery, restart, failed-update, and automatic
  rollback messages, while keeping non-Raspberry Pi and externally managed
  hosts neutral.

Host activation remains manual. The preview factory candidate uses host
generation 8, exact-device qualification, signed TUF/RAUC targets, A/B
probation, and automatic rollback.
