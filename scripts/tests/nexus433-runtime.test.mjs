import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  buildNexus433SourceBundle,
  nexus433SourceArtifactNames,
} from "../build-nexus433-source-bundle.mjs";

const root = new URL("../../", import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function composeConfig(profiles = []) {
  const args = ["compose"];
  for (const profile of profiles) args.push("--profile", profile);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, {
    cwd: new URL(".", root),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

function tarEntries(gzip) {
  const tar = gunzipSync(gzip);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/su, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + 512;
    entries.set(path, tar.subarray(contentStart, contentStart + size));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("receiver build pins canonical source and carries corresponding source inputs", () => {
  const dockerfile = source("deploy/nexus433/Dockerfile");
  assert.match(dockerfile, /NEXUS433_COMMIT=eb5f8bd87cc77ce89074d9144af19a5b2b9cc175/);
  assert.match(dockerfile, /NEXUS433_SOURCE_SHA256=6f88074428738e4ffbdfa880bde84e4eada5a14a308c3f25cd52643ac445fcf8/);
  assert.match(dockerfile, /git apply --check \/patches\/\*\.patch/);
  assert.match(dockerfile, /COPY --from=source \/src\/LICENSE/);
  assert.match(dockerfile, /COPY --from=source \/src\/nexus433-upstream\.tar\.gz/);
  assert.match(dockerfile, /COPY deploy\/nexus433\/patches\/ \/usr\/share\/stugu\/nexus433-source\/patches\//);
  assert.match(dockerfile, /Dockerfile deploy\/nexus433\/entrypoint\.sh \/usr\/share\/stugu\/nexus433-source\//);
  assert.match(dockerfile, /NOTICE\.md \/usr\/share\/licenses\/nexus433\/STUGU-NOTICE\.md/);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses="GPL-3\.0-only"/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.equal(source("deploy/nexus433/patches/0001-modern-compiler-cstdint.patch").length > 0, true);
  assert.equal(source("deploy/nexus433/patches/0002-libgpiod-v2-and-fake-runtime.patch").length > 0, true);
  assert.equal(source("deploy/nexus433/patches/0003-reproducible-version.patch").length > 0, true);
  assert.equal(source("deploy/nexus433/patches/0004-stable-mac-topic-label.patch").length > 0, true);
});

test("release tooling creates a deterministic verified corresponding-source bundle", async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "stugu-nexus-source-"));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const archive = Buffer.from("test upstream archive");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const upstream = {
    commit: "a".repeat(40),
    version: "v2.0.0-test",
    archiveUrl: "https://example.test/nexus433.tar.gz",
    archiveSha256,
  };
  const fetchImpl = async (url) => {
    assert.equal(url, upstream.archiveUrl);
    return new Response(archive, { status: 200 });
  };
  const options = {
    repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
    releaseVersion: "1.2.3",
    outputDirectory,
    fetchImpl,
    upstream,
  };
  const first = await buildNexus433SourceBundle(options);
  const firstBytes = readFileSync(first.bundlePath);
  const second = await buildNexus433SourceBundle(options);
  assert.deepEqual(readFileSync(second.bundlePath), firstBytes);

  const names = nexus433SourceArtifactNames("1.2.3");
  assert.equal(first.bundlePath, join(outputDirectory, names.bundle));
  assert.match(
    readFileSync(first.checksumPath, "utf8"),
    new RegExp(`^${first.sha256}  ${names.bundle}\\n$`, "u"),
  );

  const entries = tarEntries(firstBytes);
  const prefix = "stugu-nexus433-corresponding-source-1.2.3";
  assert.ok(entries.has(`${prefix}/README.md`));
  assert.ok(entries.has(`${prefix}/SOURCE-MANIFEST.json`));
  assert.ok(entries.has(`${prefix}/SHA256SUMS`));
  assert.ok(entries.has(`${prefix}/deploy/nexus433/Dockerfile`));
  assert.ok(entries.has(`${prefix}/deploy/nexus433/entrypoint.sh`));
  assert.ok(entries.has(`${prefix}/deploy/nexus433/NOTICE.md`));
  assert.ok(entries.has(`${prefix}/deploy/nexus433/patches/0004-stable-mac-topic-label.patch`));
  assert.deepEqual(entries.get(`${prefix}/upstream/nexus433-${upstream.commit}.tar.gz`), archive);
  const manifest = JSON.parse(entries.get(`${prefix}/SOURCE-MANIFEST.json`).toString("utf8"));
  assert.equal(manifest.schema, "stugu-nexus433-corresponding-source/v1");
  assert.equal(manifest.upstream.archiveSha256, archiveSha256);
  assert.equal(
    [...entries.keys()].some((path) => path.includes("/apps/") || path.includes("/packages/")),
    false,
  );
  const sums = entries.get(`${prefix}/SHA256SUMS`).toString("utf8").trim().split("\n");
  for (const line of sums) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    assert.ok(match);
    const content = entries.get(`${prefix}/${match[2]}`);
    assert.ok(content, `missing checksummed entry ${match[2]}`);
    assert.equal(createHash("sha256").update(content).digest("hex"), match[1]);
  }
});

test("optional runtime is absent by default and tightly scoped when enabled", () => {
  const baseline = composeConfig();
  assert.equal(baseline.services.mqtt, undefined);
  assert.equal(baseline.services.nexus433, undefined);
  assert.equal(baseline.services["source-ingress-secrets"], undefined);

  const enabled = composeConfig(["mqtt", "nexus433"]);
  const mqtt = enabled.services.mqtt;
  const receiver = enabled.services.nexus433;
  const initializer = enabled.services["source-ingress-secrets"];
  assert.ok(mqtt);
  assert.ok(receiver);
  assert.equal(mqtt.ports, undefined);
  assert.deepEqual(Object.keys(mqtt.networks), ["source-ingress"]);
  assert.equal(mqtt.read_only, true);
  assert.ok(mqtt.cap_drop.includes("ALL"));
  assert.equal(receiver.read_only, true);
  assert.ok(receiver.cap_drop.includes("ALL"));
  assert.deepEqual(receiver.devices, [{
    source: "/dev/gpiochip0",
    target: "/dev/gpiochip0",
    permissions: "rwm",
  }]);
  assert.equal(enabled.services.api.devices, undefined);
  assert.deepEqual(initializer.cap_add.sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
  assert.deepEqual(initializer.cap_drop, ["ALL"]);
  assert.equal(initializer.network_mode, "none");
});

test("factory capability and rollback contract are explicit", () => {
  const capability = JSON.parse(source("deploy/rpi/assets/host-capabilities.json"));
  assert.deepEqual(capability, {
    schema: "stugu-host-capabilities/v1",
    capabilities: {
      mqtt: { state: "available", revision: "1" },
      nexus433: {
        state: "available",
        revision: "1",
        gpioChip: "/dev/gpiochip0",
        gpioLine: 17,
      },
    },
  });

  const layer = source("deploy/rpi/layer/stugu.yaml");
  const start = source("deploy/rpi/assets/stugu-compose-start");
  const gpioRules = source("deploy/rpi/assets/70-stugu-gpio.rules");
  const control = source("deploy/rpi/assets/stuguctl");
  assert.match(layer, /STUGA_RELEASE_ENV_SCHEMA=3/);
  assert.match(layer, /STUGA_MQTT_IMAGE=\$\{IGconf_stugu_mqtt_image\}/);
  assert.match(layer, /STUGA_NEXUS433_IMAGE=\$\{IGconf_stugu_nexus433_image\}/);
  assert.match(layer, /70-stugu-gpio\.rules/);
  assert.match(start, /release-v3\.env/);
  assert.match(start, /known-good-v3\.env/);
  assert.match(start, /getent group gpio 2>\/dev\/null[\s\S]*\|\| true/);
  assert.match(start, /grep -c '\^STUGA_GPIO_GID='/);
  assert.match(start, /awk -v replacement="STUGA_GPIO_GID=\$gpio_gid"/);
  assert.doesNotMatch(start, /stat --format=%g \/dev\/gpiochip0/);
  assert.match(gpioRules, /SUBSYSTEM=="gpio"/);
  assert.match(gpioRules, /KERNEL=="gpiochip0"/);
  assert.match(gpioRules, /GROUP="gpio"/);
  assert.match(gpioRules, /MODE="0660"/);
  assert.match(control, /known-good-v3\.env/);
});
