import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import test from "node:test";
import {
  assistantConnectorApplicationSpec,
  assistantConnectorPolicySpec,
  parseArguments,
  provision,
  readCoordinatorDeployment,
  readExistingDeployment,
  renderRuntimeEnvironment,
  stugubyProtocolApplicationSpec,
  stugubyProtocolPolicySpec,
  validateOptions,
  verifyCoordinator,
  verifyDeployment,
} from "../cloudflare-stugu.mjs";

test("generated Cloudflare runtime config pins the edge operator independently of the local owner", () => {
  const environment = renderRuntimeEnvironment({
    accountId: "0123456789abcdef0123456789abcdef",
    groupId: "123e4567-e89b-42d3-a456-426614174000",
    groupName: "Stugu (stugu.example.test) members",
    operatorEmails: ["edge-owner@example.test", "recovery@example.test"],
    hostname: "stugu.example.test",
  });

  assert.match(environment, /^CLOUDFLARE_ACCESS_ACCOUNT_ID=0123456789abcdef0123456789abcdef$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_GROUP_ID=123e4567-e89b-42d3-a456-426614174000$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_GROUP_NAME="Stugu \(stugu\.example\.test\) members"$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_STATIC_EMAILS="edge-owner@example\.test,recovery@example\.test"$/mu);
  assert.match(environment, /^CLOUDFLARE_ACCESS_API_TOKEN_FILE=\/run\/secrets\/cloudflare\/access-group-token$/mu);
  assert.doesNotMatch(environment, /^STUGBY_PUBLIC_ORIGIN=/mu);
  assert.doesNotMatch(environment, /LOCAL_AUTH|PASSWORD|TOKEN=(?!FILE)/u);
});

test("coordinator config pins the Stuguby origin without adding a node credential", () => {
  const environment = renderRuntimeEnvironment({
    accountId: "0123456789abcdef0123456789abcdef",
    groupId: "123e4567-e89b-42d3-a456-426614174000",
    groupName: "Stugu (stugu.example.test) members",
    operatorEmails: ["edge-owner@example.test"],
    hostname: "stugu.example.test",
    coordinator: true,
  });
  assert.match(environment, /^STUGBY_PUBLIC_ORIGIN=https:\/\/stugu\.example\.test$/mu);
  assert.doesNotMatch(environment, /STUGBY_ENABLED|STUGUBY.*TOKEN|STUGUBY.*SECRET/u);
});

test("coordinator Access exception is exact, invisible, and bypasses only for app-level signatures", () => {
  assert.deepEqual(stugubyProtocolApplicationSpec("stugu.example.test"), {
    name: "Stugu (stugu.example.test) Stuguby protocol",
    type: "self_hosted",
    domain: "stugu.example.test/api/v1/stugby-protocol/*",
    destinations: [{ type: "public", uri: "stugu.example.test/api/v1/stugby-protocol/*" }],
    app_launcher_visible: false,
  });
  assert.deepEqual(stugubyProtocolPolicySpec("stugu.example.test"), {
    name: "Stugu (stugu.example.test) signed Stuguby nodes",
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  });
});

test("assistant connector Access exception covers only the OAuth and MCP machine paths", () => {
  assert.deepEqual(assistantConnectorApplicationSpec("stugu.example.test"), {
    name: "Stugu (stugu.example.test) assistant connector",
    type: "self_hosted",
    domain: "stugu.example.test/api/v1/mcp",
    destinations: [
      { type: "public", uri: "stugu.example.test/api/v1/mcp" },
      { type: "public", uri: "stugu.example.test/api/v1/oauth/*" },
      { type: "public", uri: "stugu.example.test/.well-known/oauth-authorization-server" },
      { type: "public", uri: "stugu.example.test/.well-known/oauth-protected-resource/api/v1/mcp" },
    ],
    app_launcher_visible: false,
  });
  const destinations = assistantConnectorApplicationSpec("stugu.example.test").destinations.map((destination) => destination.uri);
  assert.ok(!destinations.some((uri) => uri.includes("/connect/assistant") || uri.includes("/assistant-connector")),
    "the consent page and its API must stay behind the human Access application");
  assert.deepEqual(assistantConnectorPolicySpec("stugu.example.test"), {
    name: "Stugu (stugu.example.test) OAuth-authenticated assistants",
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
    "--hostname", "stugu.example.test",
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
    "--hostname", "stugu.example.test",
    "--zone", "example.test",
    "--owner-email", "owner@example.test",
    "--provision-token-file", "provision-token",
    "--access-token-file", "access-token",
  ]);
  assert.equal(coordinator.command, "provision-coordinator");
  assert.equal(parseArguments(["verify"]).command, "verify");
  assert.equal(parseArguments(["verify-coordinator"]).command, "verify-coordinator");
  assert.throws(
    () => parseArguments(["verify-coordinator", "--hostname", "stugu.example.test"]),
    /Unknown option/u,
  );
});

test("coordinator upgrades accept legacy metadata but refuse another deployment or a downgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-upgrade-test-"));
  const deploymentPath = join(directory, "deployment.json");
  try {
    writeFileSync(deploymentPath, JSON.stringify({
      version: 1,
      hostname: "stugu.example.test",
      accountId: "0123456789abcdef0123456789abcdef",
      zoneId: "fedcba9876543210fedcba9876543210",
    }));
    assert.equal(readExistingDeployment(deploymentPath, {
      command: "provision-coordinator",
      hostname: "stugu.example.test",
    }).version, 1);
    assert.throws(() => readExistingDeployment(deploymentPath, {
      command: "provision-coordinator",
      hostname: "other.example.test",
    }), /belongs to stugu\.example\.test/u);

    writeFileSync(deploymentPath, JSON.stringify({
      version: 2,
      mode: "stuguby-coordinator",
      hostname: "stugu.example.test",
    }));
    assert.throws(() => readExistingDeployment(deploymentPath, {
      command: "provision",
      hostname: "stugu.example.test",
    }), /Refusing to downgrade/u);

    writeFileSync(deploymentPath, JSON.stringify({
      version: 2,
      mode: "stugby-coordinator",
      hostname: "stugu.example.test",
    }));
    assert.equal(readExistingDeployment(deploymentPath, {
      command: "provision-coordinator",
      hostname: "stugu.example.test",
    }).mode, "stuguby-coordinator");
    assert.equal(readCoordinatorDeployment(directory).mode, "stuguby-coordinator");
    assert.throws(() => readExistingDeployment(deploymentPath, {
      command: "provision",
      hostname: "stugu.example.test",
    }), /Refusing to downgrade/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provisioning refuses to retain a broad setup token as the runtime token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-token-test-"));
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
        hostname: "stugu.example.test",
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
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(nginx, /client_max_body_size 16m;/u);
  assert.match(nginx, /gzip_static on;/u);
  assert.match(nginx, /gzip_vary on;/u, "compressed responses must emit Vary: Accept-Encoding");
  assert.match(dockerfile, /find \/usr\/share\/nginx\/html[\s\S]*gzip -9 -c "\$file" > "\$file\.gz"/u);
  assert.match(nginx, /resolver \$\{STUGA_CONTAINER_DNS_RESOLVER\} valid=10s ipv6=off;/u);
  assert.match(nginx, /set \$stuga_api_host api;/u);
  assert.equal((nginx.match(/proxy_pass http:\/\/\$stuga_api_host:8787;/gu) ?? []).length, 5);
  assert.match(nginx, /limit_req_zone \$stuga_client_address zone=stugby_join:10m rate=6r\/m;/u);
  assert.match(nginx, /limit_req_zone \$stuga_client_address zone=stugby_protocol:10m rate=30r\/s;/u);
  const join = nginx.indexOf("location = /api/v1/stugby-protocol/join");
  const protocol = nginx.indexOf("location ^~ /api/v1/stugby-protocol/");
  const genericApi = nginx.indexOf("location /api/");
  assert.ok(join > 0 && protocol > join && genericApi > protocol);
  assert.match(nginx.slice(join, protocol), /client_max_body_size 64k;/u);
  assert.match(nginx.slice(join, protocol), /limit_req zone=stugby_join burst=5 nodelay;/u);
  assert.match(nginx.slice(protocol, genericApi), /limit_req zone=stugby_protocol burst=120 nodelay;/u);
  assert.match(nginx, /limit_req_zone \$stuga_client_address zone=assistant_oauth:10m rate=30r\/m;/u);
  const discovery = nginx.indexOf("location ^~ /.well-known/oauth- {");
  const otherWellKnown = nginx.indexOf("location ^~ /.well-known/ {");
  const oauth = nginx.indexOf("location ^~ /api/v1/oauth/ {");
  assert.ok(protocol < discovery && discovery < otherWellKnown && otherWellKnown < oauth && oauth < genericApi);
  assert.match(nginx.slice(discovery, otherWellKnown), /limit_req zone=assistant_oauth[\s\S]*proxy_pass/u);
  assert.match(nginx.slice(otherWellKnown, oauth), /return 404;/u);
  assert.match(nginx.slice(oauth, genericApi), /client_max_body_size 16k;[\s\S]*limit_req zone=assistant_oauth burst=20 nodelay;/u);
  const assets = nginx.indexOf("location ^~ /assets/");
  const application = nginx.indexOf("location / {", assets);
  assert.ok(assets > genericApi && application > assets);
  assert.match(nginx.slice(assets, application), /try_files \$uri =404;[\s\S]*expires 1y;/u);
  const applicationEnd = nginx.indexOf("\n    }\n  }\n}", application);
  assert.ok(applicationEnd > application);
  assert.match(
    nginx.slice(application, applicationEnd),
    /expires -1;[\s\S]*try_files \$uri \$uri\/ \/index\.html;/u,
  );
});

function accessRedirect() {
  return new Response("", {
    status: 302,
    headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/stugu.example.test" },
  });
}

function publicAsset(contentType) {
  return new Response("", { status: 200, headers: { "content-type": contentType } });
}

function cloudflareDeployment(mode, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-test-"));
  writeFileSync(join(directory, "deployment.json"), JSON.stringify({
    version: 2,
    mode,
    hostname: "stugu.example.test",
    ...extra,
  }));
  return directory;
}

function assistantChallenge() {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001 }, id: null }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="Stugu MCP", resource_metadata="https://stugu.example.test/.well-known/oauth-protected-resource/api/v1/mcp"',
    },
  });
}

function assistantMetadata(issuer = "https://stugu.example.test") {
  return new Response(JSON.stringify({ issuer }), { status: 200, headers: { "content-type": "application/json" } });
}

function coordinatorDeployment() {
  return cloudflareDeployment("stuguby-coordinator");
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

test("remote-UI verifier accepts legacy deployment metadata during guided upgrades", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stugu-cloudflare-legacy-test-"));
  writeFileSync(join(directory, "deployment.json"), JSON.stringify({
    version: 1,
    hostname: "stugu.example.test",
  }));
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
      origin: "https://stugu.example.test",
      rootStatus: 302,
      administrationStatus: 302,
      handoffStatus: 200,
      handoffScriptStatus: 200,
      machineStatus: 400,
      assistantConnector: null,
    });
    assert.deepEqual(urls, [
      "https://stugu.example.test/",
      "https://stugu.example.test/api/v1/stugbys",
      "https://stugu.example.test/invite-bootstrap",
      "https://stugu.example.test/invite-bootstrap.js",
      "https://stugu.example.test/api/v1/stugby-protocol/join",
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

test("verifier proves assistants reach OAuth and MCP while the consent page stays behind Access", async () => {
  const directory = cloudflareDeployment("remote-ui", { assistantConnectorApplicationId: "app-assistant" });
  const responses = [
    accessRedirect(),
    accessRedirect(),
    publicAsset("text/html"),
    publicAsset("application/javascript"),
    accessRedirect(),
    accessRedirect(),
    assistantMetadata(),
    assistantChallenge(),
  ];
  const urls = [];
  try {
    const result = await verifyDeployment(
      { secretDirectory: directory },
      {
        fetcher: async (url) => {
          urls.push(url);
          return responses.shift();
        },
        logger: { log() {} },
      },
    );
    assert.deepEqual(result.assistantConnector, { consentStatus: 302, metadataStatus: 200, mcpStatus: 401 });
    assert.deepEqual(urls.slice(5), [
      "https://stugu.example.test/connect/assistant",
      "https://stugu.example.test/.well-known/oauth-authorization-server",
      "https://stugu.example.test/api/v1/mcp",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifier fails closed when the assistant paths are still behind Access or the consent page is exposed", async () => {
  const directory = cloudflareDeployment("remote-ui", { assistantConnectorApplicationId: "app-assistant" });
  const prefix = () => [accessRedirect(), accessRedirect(), publicAsset("text/html"), publicAsset("application/javascript"), accessRedirect()];
  try {
    const blocked = [...prefix(), accessRedirect(), accessRedirect()];
    await assert.rejects(
      verifyDeployment({ secretDirectory: directory }, { fetcher: async () => blocked.shift(), logger: { log() {} } }),
      /OAuth discovery did not reach Stugu/u,
    );
    const exposed = [...prefix(), publicAsset("text/html")];
    await assert.rejects(
      verifyDeployment({ secretDirectory: directory }, { fetcher: async () => exposed.shift(), logger: { log() {} } }),
      /consent page is not protected/u,
    );
    const challengeBlocked = [...prefix(), accessRedirect(), assistantMetadata(), accessRedirect()];
    await assert.rejects(
      verifyDeployment({ secretDirectory: directory }, { fetcher: async () => challengeBlocked.shift(), logger: { log() {} } }),
      /did not answer with Stugu's OAuth challenge/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
