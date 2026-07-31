# syntax=docker/dockerfile:1.7

ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd
FROM ${DEBIAN_IMAGE} AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends mosquitto openssl \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o mosquitto -g mosquitto -m 0750 /run/mosquitto
COPY --chmod=0444 deploy/mqtt/mosquitto.conf /etc/mosquitto/mosquitto.conf
COPY --chmod=0555 deploy/mqtt/init-secrets.sh /usr/local/bin/stugu-mqtt-init-secrets

USER mosquitto:mosquitto
CMD ["/usr/sbin/mosquitto", "-c", "/etc/mosquitto/mosquitto.conf"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=4 CMD ["/bin/sh", "-c", "kill -0 1"]

FROM runtime AS test-client
USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends mosquitto-clients \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 smoke \
    && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin smoke
USER 1000:1000
ENTRYPOINT ["/usr/bin/mosquitto_sub"]
