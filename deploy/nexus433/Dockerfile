# syntax=docker/dockerfile:1.7

ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

FROM ${DEBIAN_IMAGE} AS source
ARG NEXUS433_COMMIT=eb5f8bd87cc77ce89074d9144af19a5b2b9cc175
ARG NEXUS433_SOURCE_SHA256=6f88074428738e4ffbdfa880bde84e4eada5a14a308c3f25cd52643ac445fcf8
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl --fail --location --silent --show-error \
      "https://github.com/aquaticus/nexus433/archive/${NEXUS433_COMMIT}.tar.gz" \
      --output /tmp/nexus433.tar.gz \
    && echo "${NEXUS433_SOURCE_SHA256}  /tmp/nexus433.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/nexus433.tar.gz --strip-components=1 \
    && cp /tmp/nexus433.tar.gz /src/nexus433-upstream.tar.gz \
    && rm /tmp/nexus433.tar.gz
COPY deploy/nexus433/patches/ /patches/
RUN sed -i 's/\r$//' config.cpp config.h main.cpp \
    && git apply --check /patches/*.patch \
    && git apply /patches/*.patch

FROM ${DEBIAN_IMAGE} AS build
ARG NEXUS433_VERSION=v2.0.0-stugu-eb5f8bd
ARG ENABLE_FAKE_TRANSMITTER=OFF
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential cmake libgpiod-dev libmosquittopp-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=source /src /src
WORKDIR /src
RUN cmake -S . -B /build \
      -DCMAKE_BUILD_TYPE=RELEASE \
      -DCMAKE_INSTALL_PREFIX=/usr/local \
      -DENABLE_FAKE_TRANSMITTER="${ENABLE_FAKE_TRANSMITTER}" \
      -DNEXUS433_BUILD_VERSION="${NEXUS433_VERSION}" \
    && cmake --build /build --parallel \
    && /build/nexus433 --version

FROM ${DEBIAN_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Nexus433 for Stugu" \
      org.opencontainers.image.description="GPL-3.0 Nexus 433 MHz decoder packaged as an optional Stugu component" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/aquaticus/nexus433"
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgpiod3 libmosquittopp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 nexus433 \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin nexus433 \
    && install -d -o 10001 -g 10001 -m 0700 /run/nexus433 \
    && install -d -m 0755 /usr/share/licenses/nexus433 /usr/share/stugu/nexus433-source
COPY --from=build /build/nexus433 /usr/local/bin/nexus433
COPY --from=source /src/LICENSE /usr/share/licenses/nexus433/COPYING
COPY --from=source /src/nexus433-upstream.tar.gz /usr/share/stugu/nexus433-source/
COPY deploy/nexus433/patches/ /usr/share/stugu/nexus433-source/patches/
COPY deploy/nexus433/Dockerfile deploy/nexus433/entrypoint.sh /usr/share/stugu/nexus433-source/
COPY deploy/nexus433/NOTICE.md /usr/share/licenses/nexus433/STUGU-NOTICE.md
COPY --chmod=0555 deploy/nexus433/entrypoint.sh /usr/local/bin/stugu-nexus433-entrypoint
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/stugu-nexus433-entrypoint"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["/bin/sh", "-c", "kill -0 1"]
