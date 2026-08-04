# Stugu 0.35.2 preview

Stugu 0.35.2 is a focused presentation and safety patch for the unified
application and Raspberry Pi host-update experience.

## Highlights

- Show **Update information needs attention** instead of claiming Stugu is up
  to date when the application update agent or trusted native host updater is
  unavailable.
- Treat incomplete target metadata and an unbound prepared host target as
  blocked at the top of the update card, matching the component-level state.
- Keep a verified active workflow visible through the updater's expected
  mutation interlock, with progress preserved across restart and reconnection.
- Hide update, retry, restart, and cancellation actions whenever a required
  updater safety state is unavailable or stale. A prepared host can restart
  only while its exact workflow binding and native updater remain valid.
- Announce asynchronous overall and component status changes for assistive
  technology, while keeping non-Raspberry Pi and externally managed hosts
  neutral and application-only updates available.

Host activation remains manual. The preview factory candidate uses host
generation 8, exact-device qualification, signed TUF/RAUC targets, A/B
probation, and automatic rollback.
