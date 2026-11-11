import { randomUUID } from "node:crypto";
import type { AdaptiveFinding, AdaptiveReviewInput } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { adaptiveDigest, type AdaptiveMonitoringStore } from "./store.js";

export function ownAdaptiveReview(store: AdaptiveMonitoringStore, finding: AdaptiveFinding, actor: string | null): AdaptiveFinding {
  if (actor === null) return { ...finding, review: null };
  const row = store.database.db.prepare("SELECT response_json FROM adaptive_reviews WHERE finding_id=? AND actor_id=? ORDER BY json_extract(response_json,'$.revision') DESC LIMIT 1")
    .get(finding.id, actor) as { response_json: string } | undefined;
  return { ...finding, review: row ? (JSON.parse(row.response_json) as AdaptiveFinding).review : null };
}
export function reviewAdaptiveFinding(store: AdaptiveMonitoringStore, input: {
  finding: AdaptiveFinding; streamId: string; mode: string; actor: string; now: string; body: AdaptiveReviewInput;
}): AdaptiveFinding {
  const digest = adaptiveDigest(input.body);
  return store.database.transaction(() => {
    const previous = store.database.db.prepare("SELECT request_digest,response_json FROM adaptive_reviews WHERE finding_id=? AND actor_id=? AND idempotency_key=?")
      .get(input.finding.id, input.actor, input.body.idempotencyKey) as { request_digest: string; response_json: string } | undefined;
    if (previous) {
      if (previous.request_digest !== digest) throw new HttpError(409, "ADAPTIVE_IDEMPOTENCY_CONFLICT", "This retry key belongs to a different review");
      return JSON.parse(previous.response_json) as AdaptiveFinding;
    }
    const current = store.database.db.prepare("SELECT revision FROM adaptive_findings WHERE id=?").get(input.finding.id) as { revision: number } | undefined;
    if (input.finding.revision !== input.body.baseRevision || current?.revision !== input.body.baseRevision) {
      throw new HttpError(409, "ADAPTIVE_REVISION_CONFLICT", "Refresh the finding and retry");
    }
    const review = { id: randomUUID(), revision: input.finding.revision + 1, disposition: input.body.disposition,
      note: input.body.note, recordedAt: input.now };
    const finding = { ...input.finding, revision: review.revision, recordedAt: input.now, review: null };
    store.saveFinding(finding, input.streamId, input.mode);
    const response = { ...finding, review };
    store.database.db.prepare("INSERT INTO adaptive_reviews VALUES(?,?,?,?,?,?,?)")
      .run(review.id, finding.id, input.actor, input.body.idempotencyKey, digest, input.now, JSON.stringify(response));
    store.audit(finding.houseId, { actor: input.actor, now: input.now, action: "review",
      detail: { findingId: finding.id, revision: review.revision, disposition: review.disposition } });
    return response;
  });
}
