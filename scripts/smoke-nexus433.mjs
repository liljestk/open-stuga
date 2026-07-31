#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = `stugu-nexus-smoke-${randomUUID().slice(0, 8)}`;
const environment = {
  ...process.env,
  STUGA_MQTT_IMAGE: "stugu-mqtt:smoke",
  STUGA_NEXUS433_IMAGE: "stugu-nexus433:smoke",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr ?? ""}`);
  }
  return result;
}

function compose(args, options) {
  return run("docker", [
    "compose",
    "--project-name",
    project,
    "--file",
    "docker-compose.yml",
    "--file",
    "deploy/nexus433/compose.fake.yml",
    "--profile",
    "mqtt",
    "--profile",
    "nexus433",
    "--profile",
    "nexus433-smoke",
    ...args,
  ], options);
}

try {
  run("docker", [
    "build",
    "--file",
    "deploy/mqtt/Dockerfile",
    "--target",
    "runtime",
    "--tag",
    environment.STUGA_MQTT_IMAGE,
    ".",
  ]);
  run("docker", [
    "build",
    "--file",
    "deploy/mqtt/Dockerfile",
    "--target",
    "test-client",
    "--tag",
    "stugu-mqtt-client:smoke",
    ".",
  ]);
  run("docker", [
    "build",
    "--file",
    "deploy/nexus433/Dockerfile",
    "--target",
    "runtime",
    "--build-arg",
    "ENABLE_FAKE_TRANSMITTER=ON",
    "--tag",
    environment.STUGA_NEXUS433_IMAGE,
    ".",
  ]);

  try {
    compose(["up", "--detach", "--no-build", "--wait", "source-ingress-secrets", "mqtt"]);
  } catch (error) {
    const logs = compose(["logs", "--no-color", "source-ingress-secrets", "mqtt"], {
      allowFailure: true,
      capture: true,
    });
    process.stderr.write(logs.stdout ?? "");
    process.stderr.write(logs.stderr ?? "");
    throw error;
  }
  compose(["up", "--detach", "--no-build", "--no-deps", "nexus433-smoke-subscriber"]);
  try {
    compose(["up", "--detach", "--no-build", "--no-deps", "--wait", "nexus433"]);
  } catch (error) {
    const logs = compose(["logs", "--no-color", "nexus433"], {
      allowFailure: true,
      capture: true,
    });
    process.stderr.write(logs.stdout ?? "");
    process.stderr.write(logs.stderr ?? "");
    throw error;
  }
  compose(["wait", "nexus433-smoke-subscriber"]);
  const output = compose(["logs", "--no-color", "nexus433-smoke-subscriber"], {
    capture: true,
  }).stdout;
  const message = output.split(/\r?\n/u).find((line) => line.includes("nexus433/sensor/"));
  if (
    !message
    || !/nexus433\/sensor\/[0-9A-F]{12}_[0-9a-f]{4}\/state/u.test(message)
    || !/"temperature": -?\d+\.\d/u.test(message)
    || !/"humidity": \d+/u.test(message)
    || !/"battery": "(?:ok|low)"/u.test(message)
    || !/"quality": \d+/u.test(message)
  ) throw new Error(`Unexpected Nexus433 MQTT state message: ${message ?? "none"}`);
  console.log(message.replace(/^.*?\|\s*/u, ""));
} finally {
  compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
}
