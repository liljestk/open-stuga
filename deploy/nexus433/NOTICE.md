# Nexus433 licensing and separation

The optional `nexus433` container contains Nexus433 from
`aquaticus/nexus433` plus the patches in this directory. That component is
distributed under GPL-3.0-only. Every Stugu release that includes its binary
also publishes a matching corresponding-source archive containing the pinned
upstream source, all patches, and the files needed to rebuild the container.

The Stugu API and web applications neither contain nor link Nexus433 code.
Nexus433 runs as a separate process and exchanges protocol messages with Stugu
through a private MQTT transport. The Stugu applications remain distributed
separately under their own license and are not part of the Nexus433 source
archive.

This notice documents the distribution design; it is not legal advice.
