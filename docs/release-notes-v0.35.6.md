# Stugu 0.35.6 host-update bridge heartbeat correction

Stugu 0.35.6 fixes the production updater status shown in **Advanced →
System**. A live native bridge was publishing regularly, but a completed host
operation's older timestamp replaced the bridge heartbeat timestamp. The API
correctly failed closed after two minutes and reported that the trusted host
updater was not connected.

## What changed

- The file bridge now publishes its own current heartbeat time after copying
  bounded native operation fields.
- Durable native operation timestamps can no longer make a healthy bridge
  appear stale.
- Regression coverage reproduces the exact stale completed-journal case seen
  on the production Pi.

The bridge retains no network, device, Docker socket, RAUC, sudo, or broad
host access. Host selection and writes remain in the signed native updater;
activation still requires explicit restart confirmation and A/B probation.

There is no persistent-data migration change. Kernel, Pi boot-firmware,
EEPROM, boot-chain, and recovery-class zero-touch updates remain deferred.
