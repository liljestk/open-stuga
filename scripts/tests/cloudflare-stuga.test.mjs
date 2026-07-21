import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArguments,
  renderRuntimeEnvironment,
  validateOptions,
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
  assert.doesNotMatch(environment, /LOCAL_AUTH|PASSWORD|TOKEN=(?!FILE)/u);
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
