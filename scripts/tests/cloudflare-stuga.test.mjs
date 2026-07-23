import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseArguments,
  renderRuntimeEnvironment,
  stugbyProtocolApplicationSpec,
  stugbyProtocolPolicySpec,
  validateOptions,
  verifyCoordinator,
} from "../cloudflare-stuga.mjs";

test("generated Cloudflare runtime config pins the edge operator independently of the local owner", () => {
  const environment = renderRuntimeEnvironment({
    accountId: "0123456789abcdef0123456789abcdef",
    groupId: "123e4567-e89b-42d3-a456-426614174000",
    groupName: "Stuga (stuga.example.test) members",
    operatorEmails: ["edge-owner@example.test", "recovery@example.test"],
    hostname: "stuga.example.test",
  });

  assert.match(environment, /^CLOUDFLARE_ACCESS_ACCOUNT_ID=0123456789abcdef0123456789abcdef$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_GROUP_ID=123e4567-e89b-42d3-a456-426614174000$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_GROUP_NAME="Stuga \(stuga\.example\.test\) members"$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_STATIC_EMAILS="edge-owner@example\.test,recovery@example\.test"$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_API_TOKEN_FILE=\/run\/secrets\/cloudflare\/access-group-token$/mu);
  assert.doesNotMatch(environment, /^STUGBY_PUBLIC_ORIGIN=/mu);
  assert.doesNotMatch(environment, /LOCAL_AUTH|PASSWORD|TOKEN=(?!FILE)/u);
});

test("coordinator config pins the Stugby origin without adding a node credential", () => {
  const environment = renderRuntimeEnvironment({
    accountId: "0123456789abcdef0123456789abcdef",
    groupId: "123e4567-e89b-42d3-a456-426614174000",
    groupName: "Stuga (stuga.example.test) members",
    operatorEmails: ["edge-owner@example.test"],
    hostname: "stuga.example.test",
    coordinator: true,
  });
  assert.match(environment, /^STUGBY_PUBLIC_ORIGIN=https:\/\/stuga\.example\.test$/mu);
  assert.doesNotMatch(environment, /STUGBY_ENABLED|STUGBY.*TOKEN|STUGBY.*SECRET/u);
});

test("coordinator Access exception is exact, invisible, and bypasses only for app-level signatures", () => {
  assert.deepEqual(stugbyProtocolApplicationSpec("stuga.example.test"), {
    name: "Stuga (stuga.example.test) Stugby protocol",
    type: "self_hosted",
    domain: "stuga.example.test/api/v1/stugby-protocol/*",
    destinations: [{ type: "public", uri: "stuga.example.test/api/v1/stugby-protocol/*" }],
    app_launcher_visible: false,
  });
  assert.deepEqual(stugbyProtocolPolicySpec("stuga.example.test"), {
    name: "Stuga (stuga.example.test) signed Stugby nodes",
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  });
});

test("Cloudflare owner email rejects the comma reserved for the runtime operator list", () => {
  const options = parseArguments([
    "provision",
    "--hostname", "stuga.example.test",
    "--zone", "example.test",
    "--owner-email", "first@example.test,second@example.test",
    "--provision-token-file", "provision-token",
    "--access-token-file", "access-token",
  ]);
  assert.throws(() => validateOptions(options), /valid email address/u);
});

test("coordinator and verification commands have distinct fail-closed arguments", () => {
  const coordinator = parseArguments([
    "provision-coordinator",
    "--hostname", "stuga.example.test",
    "--zone", "example.test",
    "--owner-email", "owner@example.test",
    "--provision-token-file", "provision-token",
    "--access-token-file", "access-token",
  ]);
  assert.equal(coordinator.command, "provision-coordinator");
  assert.equal(parseArguments(["verify-coordinator"]).command, "verify-coordinator");
  assert.throws(
    () => parseArguments(["verify-coordinator", "--hostname", "stuga.example.test"]),
    /Unknown option/u,
  );
});

test("bundled reverse proxy rate-limits the machine exception before the generic API route", () => {
  const nginx = readFileSync(new URL("../../config/nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /client_max_body_size 16m;/u);
  assert.match(nginx, /limit_req_zone \$stuga_client_address zone=stugby_join:10m rate=6r\/m;/u);
  assert.match(nginx, /limit_req_zone \$stuga_client_address zone=stugby_protocol:10m rate=30r\/s;/u);
  const join = nginx.indexOf("location = /api/v1/stugby-protocol/join");
  const protocol = nginx.indexOf("location ^~ /api/v1/stugby-protocol/");
  const genericApi = nginx.indexOf("location /api/");
  assert.ok(join > 0 && protocol > join && genericApi > protocol);
  assert.match(nginx.slice(join, protocol), /client_max_body_size 64k;/u);
  assert.match(nginx.slice(join, protocol), /limit_req zone=stugby_join burst=5 nodelay;/u);
  assert.match(nginx.slice(protocol, genericApi), /limit_req zone=stugby_protocol burst=120 nodelay;/u);
});

function accessRedirect() {
  return new Response("", {
    status: 302,
    headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/stuga.example.test" },
  });
}

function coordinatorDeployment() {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-test-"));
  writeFileSync(join(directory, "deployment.json"), JSON.stringify({
    version: 2,
    mode: "stugby-coordinator",
    hostname: "stuga.example.test",
  }));
  return directory;
}

test("coordinator verifier proves that human/admin paths are protected and machine validation is reachable", async () => {
  const directory = coordinatorDeployment();
  const responses = [
    accessRedirect(),
    accessRedirect(),
    new Response(JSON.stringify({ error: { code: "INVALID_INPUT", message: "Invitation id is required" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  ];
  const urls = [];
  try {
    const result = await verifyCoordinator(
      { secretDirectory: directory },
      {
        fetcher: async (url) => {
          urls.push(url);
          return responses.shift();
        },
        logger: { log() {} },
      },
    );
    assert.deepEqual(result, {
      origin: "https://stuga.example.test",
      rootStatus: 302,
      administrationStatus: 302,
      machineStatus: 400,
    });
    assert.deepEqual(urls, [
      "https://stuga.example.test/",
      "https://stuga.example.test/api/v1/stugbys",
      "https://stuga.example.test/api/v1/stugby-protocol/join",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator verifier fails closed for an exposed root or Access-blocked machine path", async () => {
  const directory = coordinatorDeployment();
  try {
    await assert.rejects(
      verifyCoordinator(
        { secretDirectory: directory },
        { fetcher: async () => new Response("exposed", { status: 200 }), logger: { log() {} } },
      ),
      /Human root is not protected/u,
    );
    const responses = [accessRedirect(), accessRedirect(), accessRedirect()];
    await assert.rejects(
      verifyCoordinator(
        { secretDirectory: directory },
        { fetcher: async () => responses.shift(), logger: { log() {} } },
      ),
      /machine path did not reach/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
