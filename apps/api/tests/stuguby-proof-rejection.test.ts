import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_PROTOCOL_VERSION,
  canonicalJson,
  eventSigningValue,
  requestSigningValue,
  type StugubySignedEvent,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MachineRequestProof } from "../src/stuguby/service.js";
import { joinSigningValue, sha256 } from "../src/stuguby/service/support/federation-validation.js";
import { node, stop, type RunningNode } from "./stugubyTestSupport.js";

let coordinator: RunningNode;
let participant: RunningNode;
let outsider: RunningNode;
let stugubyId: string;

beforeAll(async () => {
  coordinator = await node("Proof coordinator");
  participant = await node("Proof participant");
  outsider = await node("Proof outsider");
  const created = await request(coordinator.url).post("/api/v1/stugbys").send({ name: "Signed requests" }).expect(201);
  stugubyId = created.body.id;
  const invitation = await request(coordinator.runtime.app)
    .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
  await request(participant.runtime.app).post("/api/v1/stugbys/join").send({
    coordinatorUrl: coordinator.url,
    invitationId: invitation.body.id,
    joinSecret: invitation.body.joinSecret,
  }).expect(201);
});

afterAll(async () => {
  await Promise.all([coordinator, participant, outsider].map(stop));
});

/** A request proof signed by `signer` for the participant's node id. */
function proof(signer: RunningNode, overrides: Partial<MachineRequestProof> = {}): MachineRequestProof {
  const unsigned = {
    method: "GET",
    path: `/api/v1/stugby-protocol/stugbys/${stugubyId}/events`,
    body: new Uint8Array(),
    nodeId: participant.runtime.stuguby.identity.nodeId,
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    ...overrides,
  };
  const signature = signer.runtime.stuguby.keys.sign(requestSigningValue({
    method: unsigned.method,
    path: unsigned.path,
    bodyHash: sha256(unsigned.body),
    timestamp: unsigned.timestamp!,
    requestId: unsigned.requestId!,
    nodeId: unsigned.nodeId!,
  }));
  return { ...unsigned, signature };
}

const authenticate = (value: MachineRequestProof) => coordinator.runtime.stuguby.authenticateMachineRequest(stugubyId, value);

describe("Stuguby peer request proofs", () => {
  it("accepts a fresh signed request once and refuses its replay", () => {
    const signed = proof(participant);
    expect(authenticate(signed).nodeId).toBe(participant.runtime.stuguby.identity.nodeId);
    expect(() => authenticate(signed)).toThrow(expect.objectContaining({ status: 409, code: "REPLAYED_REQUEST" }));
  });

  it("refuses a request whose body or path changed after signing, without spending its request id", () => {
    const signed = proof(participant, { method: "POST", body: new TextEncoder().encode("{\"events\":[]}") });
    expect(() => authenticate({ ...signed, body: new TextEncoder().encode("{\"events\":[1]}") }))
      .toThrow(expect.objectContaining({ status: 401, code: "INVALID_REQUEST_PROOF" }));
    expect(() => authenticate({ ...signed, path: `${signed.path}/stream` }))
      .toThrow(expect.objectContaining({ status: 401, code: "INVALID_REQUEST_PROOF" }));
    expect(authenticate(signed).nodeId).toBe(participant.runtime.stuguby.identity.nodeId);
  });

  it("refuses a timestamp outside the clock window and a signature from another identity", () => {
    const stale = new Date(Date.now() - (STUGBY_MAX_CLOCK_SKEW_SECONDS + 60) * 1_000).toISOString();
    expect(() => authenticate(proof(participant, { timestamp: stale })))
      .toThrow(expect.objectContaining({ status: 401, code: "STALE_REQUEST" }));
    expect(() => authenticate(proof(outsider)))
      .toThrow(expect.objectContaining({ status: 401, code: "INVALID_REQUEST_PROOF" }));
  });
});

describe("Stuguby event proofs", () => {
  function signedEvent(): StugubySignedEvent {
    const payload = { label: "Participant", note: "membership heartbeat" };
    const wire: StugubyWireEvent = {
      protocolVersion: STUGBY_PROTOCOL_VERSION,
      stugubyId,
      eventId: randomUUID(),
      eventKind: "dataset.published",
      authorityNodeId: participant.runtime.stuguby.identity.nodeId,
      streamId: "proof-test",
      sequence: 1,
      schema: "stuguby.member.v2",
      resourceId: participant.runtime.stuguby.identity.nodeId,
      operation: "upsert",
      revision: 1,
      grantId: null,
      grantEpoch: null,
      occurredAt: new Date().toISOString(),
      payload,
      payloadHash: sha256(canonicalJson(payload)),
    };
    return {
      ...wire,
      keyFingerprint: participant.runtime.stuguby.identity.keyFingerprint,
      signature: participant.runtime.stuguby.keys.sign(eventSigningValue(wire)),
    };
  }
  // verifyEvent is the check every ingested or pulled event passes through.
  const verify = (event: StugubySignedEvent) => (coordinator.runtime.stuguby as unknown as {
    verifyEvent(value: StugubySignedEvent, publicKey: string): void;
  }).verifyEvent(event, participant.runtime.stuguby.identity.publicKey);

  it("accepts the event as signed and refuses any altered copy", () => {
    const event = signedEvent();
    expect(() => verify(event)).not.toThrow();
    expect(() => verify({ ...event, payload: { label: "Participant", note: "membership heartbeat!" } }))
      .toThrow(expect.objectContaining({ status: 400, code: "EVENT_HASH_MISMATCH" }));
    expect(() => verify({ ...event, keyFingerprint: outsider.runtime.stuguby.identity.keyFingerprint }))
      .toThrow(expect.objectContaining({ status: 401, code: "EVENT_KEY_MISMATCH" }));
    const { signature: _signature, keyFingerprint: _fingerprint, ...wire } = event;
    expect(() => verify({ ...event, signature: outsider.runtime.stuguby.keys.sign(eventSigningValue(wire)) }))
      .toThrow(expect.objectContaining({ status: 401, code: "INVALID_EVENT_SIGNATURE" }));
  });
});

describe("Stuguby join proofs", () => {
  it("refuses a join signed over different values and leaves the invitation and members unchanged", async () => {
    const invitation = await request(coordinator.runtime.app)
      .post(`/api/v1/stugbys/${stugubyId}/invitations`).send({ role: "participant" }).expect(201);
    const service = coordinator.runtime.stuguby;
    const membersBefore = service.store.listMembers(stugubyId).length;
    const identity = outsider.runtime.stuguby.identity;
    expect(() => service.acceptJoin({
      invitationId: invitation.body.id,
      joinSecret: invitation.body.joinSecret,
      identity,
      signature: outsider.runtime.stuguby.keys.sign(joinSigningValue({
        invitationId: invitation.body.id,
        joinSecret: "a different secret",
        identity,
      })),
    })).toThrow(expect.objectContaining({ status: 401, code: "INVALID_JOIN_PROOF" }));
    expect(service.store.listMembers(stugubyId)).toHaveLength(membersBefore);
    const stored = service.store.listInvitations(stugubyId).find((candidate) => candidate.id === invitation.body.id);
    expect(stored?.usedAt ?? null).toBeNull();
  });
});
