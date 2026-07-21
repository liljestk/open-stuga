import assert from "node:assert/strict";
import test from "node:test";
import { assertExpectedExportAddress } from "../dist/address.js";

test("only accepts an API-selected recipient on the configured plus mailbox", () => {
  assert.equal(
    assertExpectedExportAddress("history@example.com", "history+tapo-job-1@example.com"),
    "history+tapo-job-1@example.com",
  );
  assert.throws(
    () => assertExpectedExportAddress("history@example.com", "attacker@example.com"),
    /not a plus address/u,
  );
  assert.throws(
    () => assertExpectedExportAddress("history@example.com", "history+tapo@elsewhere.example"),
    /not a plus address/u,
  );
});
