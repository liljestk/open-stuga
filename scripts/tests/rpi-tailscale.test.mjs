import assert from "node:assert/strict";
import test from "node:test";

import {
  assessRpiTailscale,
  formatRpiTailscaleReport,
  parseRpiTailscaleArguments,
  runRpiTailscale,
  sshArguments,
} from "../rpi-tailscale.mjs";

function parse(argv) {
  return parseRpiTailscaleArguments(argv, {
    cwd: "/operator",
    home: "/home/operator",
    exists: () => true,
    stat: () => ({ isFile: () => true }),
  });
}

function diagnostics(overrides = {}) {
  return {
    hostname: "stugu",
    osVersion: "0.37.0",
    serviceEnabled: "enabled",
    serviceActive: "active",
    addresses: ["100.64.0.12"],
    status: "100.64.0.12 stugu operator linux -",
    mount: {
      source: "/dev/sda6[/shared/var/lib/tailscale]",
      filesystem: "ext4",
      options: "rw,noatime",
    },
    operator: "stugu",
    ...overrides,
  };
}

test("CLI defaults to strict, key-based appliance access", () => {
  const options = parse(["check"]);
  assert.equal(options.target, "stugu@stugu.local");
  assert.match(options.identityFile, /[\\/]\.ssh[\\/]stuga_appliance$/u);
  const arguments_ = sshArguments(options);
  assert.ok(arguments_.includes("StrictHostKeyChecking=yes"));
  assert.ok(arguments_.includes("BatchMode=yes"));
  assert.ok(arguments_.includes("IdentitiesOnly=yes"));
  assert.ok(!arguments_.includes("accept-new"));
});

test("CLI rejects SSH option injection, invalid ports, and JSON repair", () => {
  assert.throws(
    () => parse(["check", "--target", "-oProxyCommand=bad"]),
    /--target requires a value|safe SSH/u,
  );
  assert.throws(() => parse(["check", "--ssh-port", "70000"]), /1 to 65535/u);
  assert.throws(() => parse(["repair", "--json"]), /only available with check/u);
});

test("assessment distinguishes a healthy Pi from a logged-out Pi", () => {
  const healthy = assessRpiTailscale(diagnostics());
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.repairable, true);

  const loggedOut = assessRpiTailscale(diagnostics({
    addresses: [],
    status: "Logged out.",
    operator: null,
  }));
  assert.equal(loggedOut.healthy, false);
  assert.equal(loggedOut.repairable, true);
  assert.match(loggedOut.issues.join("\n"), /Logged out/u);
  assert.match(loggedOut.issues.join("\n"), /operator is not set/u);
  assert.match(formatRpiTailscaleReport(loggedOut), /NEEDS REPAIR/u);
});

test("repair uses only the guarded appliance login and verifies again", async () => {
  const inspections = [
    diagnostics({ addresses: [], status: "Logged out.", operator: null }),
    diagnostics(),
  ];
  const calls = [];
  const output = [];
  const exitCode = await runRpiTailscale(parse(["repair"]), {
    inspect: async () => inspections.shift(),
    runProcess: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return { stdout: "", stderr: "" };
    },
    write: (message) => output.push(message),
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].arguments_.slice(-4), [
    "stugu@stugu.local", "stuguctl", "tailscale", "up",
  ]);
  assert.equal(calls[0].options.interactive, true);
  assert.match(output.at(-1), /PASS/u);
});

test("repair fails closed when persistent state is not mounted", async () => {
  let repairCalls = 0;
  await assert.rejects(
    () => runRpiTailscale(parse(["repair"]), {
      inspect: async () => diagnostics({
        addresses: [],
        status: "Logged out.",
        mount: { source: "/dev/root", filesystem: "ext4", options: "rw" },
      }),
      runProcess: async () => { repairCalls += 1; },
      write: () => {},
    }),
    /persistent state mount needs host maintenance/u,
  );
  assert.equal(repairCalls, 0);
});

test("read-only check returns one for repairable login state", async () => {
  const output = [];
  const exitCode = await runRpiTailscale(parse(["check", "--json"]), {
    inspect: async () => diagnostics({ addresses: [], status: "NeedsLogin" }),
    write: (message) => output.push(message),
  });
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).healthy, false);
});
