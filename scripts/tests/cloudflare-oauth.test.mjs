import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  authorizeCloudflareSetup,
  cloudflareSetupOAuthScopes,
  createCloudflareAuthorizationUrl,
  createPkceChallenge,
  validateCloudflareOAuthClientId,
  validateCloudflareOAuthRedirectUri,
} from "../cloudflare-oauth.mjs";

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("No loopback port");
  return address.port;
}

test("Cloudflare OAuth settings require PKCE and an explicit loopback callback", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    createPkceChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  assert.deepEqual(cloudflareSetupOAuthScopes(false), [
    "access.write",
    "argotunnel.write",
    "dns.write",
  ]);
  assert.deepEqual(cloudflareSetupOAuthScopes(true), [
    "access.write",
    "argotunnel.write",
    "dns.write",
    "zone.read",
  ]);
  assert.equal(validateCloudflareOAuthClientId("stuga-oauth-client"), "stuga-oauth-client");
  assert.throws(
    () => validateCloudflareOAuthRedirectUri("https://stuga.example.test/oauth/callback"),
    /loopback/u,
  );
  assert.throws(
    () => validateCloudflareOAuthRedirectUri("http://127.0.0.1/cloudflare/oauth/callback"),
    /loopback/u,
  );

  const authorization = new URL(createCloudflareAuthorizationUrl({
    clientId: "stuga-oauth-client",
    codeChallenge: "challenge",
    redirectUri: "http://127.0.0.1:8976/cloudflare/oauth/callback",
    scopes: cloudflareSetupOAuthScopes(false),
    state: "state",
  }));
  assert.equal(authorization.origin, "https://dash.cloudflare.com");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("scope"),
    "access.write argotunnel.write dns.write",
  );
  assert.equal(authorization.searchParams.has("client_secret"), false);
});

test("Cloudflare OAuth browser flow validates state, exchanges PKCE, and revokes once", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/cloudflare/oauth/callback`;
  const requestedScopes = cloudflareSetupOAuthScopes(true);
  const accessToken = "oauth-access-token-".padEnd(48, "x");
  const requests = [];
  let authorization;
  let randomCall = 0;

  const grant = await authorizeCloudflareSetup({
    clientId: "stuga-oauth-client",
    redirectUri,
    scopes: requestedScopes,
  }, {
    fetcher: async (url, init) => {
      requests.push([url, init]);
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("client_id"), "stuga-oauth-client");
        assert.equal(body.get("redirect_uri"), redirectUri);
        assert.equal(body.get("code"), "approved-code");
        assert.equal(
          createPkceChallenge(body.get("code_verifier")),
          authorization.searchParams.get("code_challenge"),
        );
        return Response.json({
          access_token: accessToken,
          expires_in: 600,
          scope: requestedScopes.join(" "),
          token_type: "Bearer",
        });
      }
      if (url === "https://dash.cloudflare.com/oauth2/revoke") {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("client_id"), "stuga-oauth-client");
        assert.equal(body.get("token"), accessToken);
        assert.equal(body.get("token_type_hint"), "access_token");
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request to ${url}`);
    },
    logger: { log() {} },
    openBrowser: async (url) => {
      authorization = new URL(url);
      const wrongState = await fetch(
        `${redirectUri}?code=wrong-code&state=wrong-state`,
      );
      assert.equal(wrongState.status, 400);
      const approved = await fetch(
        `${redirectUri}?code=approved-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}`,
      );
      assert.equal(approved.status, 200);
      assert.match(await approved.text(), /Return to the terminal/u);
    },
    randomBytes: (size) => {
      randomCall += 1;
      return Buffer.alloc(size, randomCall);
    },
  });

  assert.equal(grant.accessToken, accessToken);
  assert.equal(grant.expiresIn, 600);
  await grant.revoke();
  await grant.revoke();
  assert.equal(requests.length, 2);
});

test("Cloudflare OAuth refusal never reaches the token endpoint", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/cloudflare/oauth/callback`;
  let exchanged = false;

  await assert.rejects(
    authorizeCloudflareSetup({
      clientId: "stuga-oauth-client",
      redirectUri,
      scopes: cloudflareSetupOAuthScopes(false),
    }, {
      fetcher: async () => {
        exchanged = true;
        return new Response(null, { status: 500 });
      },
      logger: { log() {} },
      openBrowser: async (url) => {
        const authorization = new URL(url);
        const refused = await fetch(
          `${redirectUri}?error=access_denied&state=${encodeURIComponent(authorization.searchParams.get("state"))}`,
        );
        assert.equal(refused.status, 400);
      },
      randomBytes: (size) => Buffer.alloc(size, 7),
    }),
    /not granted \(access_denied\)/u,
  );
  assert.equal(exchanged, false);
});

test("Cloudflare OAuth revokes a token that omits a required scope", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/cloudflare/oauth/callback`;
  const accessToken = "partial-oauth-token-".padEnd(48, "x");
  let revoked = false;

  await assert.rejects(
    authorizeCloudflareSetup({
      clientId: "stuga-oauth-client",
      redirectUri,
      scopes: cloudflareSetupOAuthScopes(false),
    }, {
      fetcher: async (url) => {
        if (url === "https://dash.cloudflare.com/oauth2/token") {
          return Response.json({
            access_token: accessToken,
            scope: "access.write",
            token_type: "Bearer",
          });
        }
        if (url === "https://dash.cloudflare.com/oauth2/revoke") {
          revoked = true;
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request to ${url}`);
      },
      logger: { log() {} },
      openBrowser: async (url) => {
        const authorization = new URL(url);
        await fetch(
          `${redirectUri}?code=approved-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}`,
        );
      },
      randomBytes: (size) => Buffer.alloc(size, 9),
    }),
    /omitted the required argotunnel\.write/u,
  );
  assert.equal(revoked, true);
});
