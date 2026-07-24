import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import test from "node:test";
import {
  parseArguments,
  provision,
  readExistingDeployment,
  renderRuntimeEnvironment,
  stugbyProtocolApplicationSpec,
  stugbyProtocolPolicySpec,
  validateOptions,
  verifyCoordinator,
  verifyDeployment,
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
  assert.throws(
    () => validateOptions({
      ...options,
      ownerEmail: "owner@example.test",
      secretDirectory: parsePath(resolve(".")).root,
    }),
    /dedicated subdirectory/u,
  );
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
  assert.equal(parseArguments(["verify"]).command, "verify");
  assert.equal(parseArguments(["verify-coordinator"]).command, "verify-coordinator");
  assert.throws(
    () => parseArguments(["verify-coordinator", "--hostname", "stuga.example.test"]),
    /Unknown option/u,
  );
});

test("coordinator upgrades accept legacy metadata but refuse another deployment or a downgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-upgrade-test-"));
  const deploymentPath = join(directory, "deployment.json");
  try {
    writeFileSync(deploymentPath, JSON.stringify({
      version: 1,
      hostname: "stuga.example.test",
      accountId: "0123456789abcdef0123456789abcdef",
      zoneId: "fedcba9876543210fedcba9876543210",
    }));
    assert.equal(readExistingDeployment(deploymentPath, {
      command: "provision-coordinator",
      hostname: "stuga.example.test",
    }).version, 1);
    assert.throws(() => readExistingDeployment(deploymentPath, {
      command: "provision-coordinator",
      hostname: "other.example.test",
    }), /belongs to stuga\.example\.test/u);

    writeFileSync(deploymentPath, JSON.stringify({
      version: 2,
      mode: "stugby-coordinator",
      hostname: "stuga.example.test",
    }));
    assert.throws(() => readExistingDeployment(deploymentPath, {
      command: "provision",
      hostname: "stuga.example.test",
    }), /Refusing to downgrade/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provisioning refuses to retain a broad setup token as the runtime token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-token-test-"));
  const provisionTokenFile = join(directory, "provision-token");
  const accessTokenFile = join(directory, "access-token");
  const token = "same-token-value-which-is-longer-than-thirty-two-bytes";
  try {
    writeFileSync(provisionTokenFile, token, { mode: 0o600 });
    writeFileSync(accessTokenFile, token, { mode: 0o600 });
    await assert.rejects(
      provision({
        accessTokenFile,
        accountId: null,
        command: "provision",
        hostname: "stuga.example.test",
        ownerEmail: "owner@example.test",
        provisionTokenFile,
        secretDirectory: join(directory, "runtime"),
        zone: "example.test",
        zoneId: null,
      }),
      /must be different/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function publicAsset(contentType) {
  return new Response("", { status: 200, headers: { "content-type": contentType } });
}

function cloudflareDeployment(mode) {
  const directory = mkdtempSync(join(tmpdir(), "stuga-cloudflare-test-"));
  writeFileSync(join(directory, "deployment.json"), JSON.stringify({
    version: 2,
    mode,
    hostname: "stuga.example.test",
  }));
  return directory;
}

function coordinatorDeployment() {
  return cloudflareDeployment("stugby-coordinator");
}

test("remote-UI verifier proves that every non-static path remains behind Access", async () => {
  const directory = cloudflareDeployment("remote-ui");
  const responses = [
    accessRedirect(),
    accessRedirect(),
    publicAsset("text/html; charset=utf-8"),
    publicAsset("application/javascript"),
    accessRedirect(),
  ];
  try {
    const result = await verifyDeployment(
      { secretDirectory: directory },
      {
        fetcher: async () => responses.shift(),
        logger: { log() {} },
      },
    );
    assert.equal(result.machineStatus, 302);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote-UI verifier fails closed if the machine path is exposed", async () => {
  const directory = cloudflareDeployment("remote-ui");
  const responses = [
    accessRedirect(),
    accessRedirect(),
    publicAsset("text/html"),
    publicAsset("application/javascript"),
    new Response(JSON.stringify({ error: { code: "STUGBY_DISABLED" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  ];
  try {
    await assert.rejects(
      verifyDeployment(
        { secretDirectory: directory },
        {
          fetcher: async () => responses.shift(),
          logger: { log() {} },
        },
      ),
      /machine path is not protected/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator verifier proves that human/admin paths are protected and machine validation is reachable", async () => {
  const directory = coordinatorDeployment();
  const responses = [
    accessRedirect(),
    accessRedirect(),
    publicAsset("text/html; charset=utf-8"),
    publicAsset("application/javascript"),
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
      handoffStatus: 200,
      handoffScriptStatus: 200,
      machineStatus: 400,
    });
    assert.deepEqual(urls, [
      "https://stuga.example.test/",
      "https://stuga.example.test/api/v1/stugbys",
      "https://stuga.example.test/invite-bootstrap",
      "https://stuga.example.test/invite-bootstrap.js",
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
    const responses = [
      accessRedirect(),
      accessRedirect(),
      publicAsset("text/html"),
      publicAsset("application/javascript"),
      accessRedirect(),
    ];
    await assert.rejects(
      verifyCoordinator(
        { secretDirectory: directory },
        { fetcher: async () => responses.shift(), logger: { log() {} } },
      ),
      /machine path did not reach/u,
    );
    const blockedHandoff = [accessRedirect(), accessRedirect(), accessRedirect()];
    await assert.rejects(
      verifyCoordinator(
        { secretDirectory: directory },
        { fetcher: async () => blockedHandoff.shift(), logger: { log() {} } },
      ),
      /Invitation handoff page is not publicly reachable/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
