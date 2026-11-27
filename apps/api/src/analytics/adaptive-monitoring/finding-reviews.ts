import { randomUUID } from "node:crypto";
import type { AdaptiveFindingReview, AdaptiveFindingReviewWrite, AdaptiveShadowFinding } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HttpError } from "../../http-error.js";

interface ReviewRow {
  id: string;
  finding_revision: number;
  disposition: AdaptiveFindingReview["disposition"];
  note: string | null;
  reported_recovery: number;
  supersedes_review_id: string | null;
  recorded_at: string;
}

function reviewFromRow(findingId: string, row: ReviewRow): AdaptiveFindingReview {
  return {
    id: row.id, findingId, findingRevision: row.finding_revision, disposition: row.disposition, note: row.note,
    reportedRecovery: row.reported_recovery === 1, supersedesReviewId: row.supersedes_review_id, recordedAt: row.recorded_at,
  };
}

const actorReviews = `SELECT id, finding_revision, disposition, note, reported_recovery, supersedes_review_id, recorded_at
  FROM adaptive_finding_reviews WHERE epoch_id = ? AND direction = ? AND actor_id = ?`;

export function latestAdaptiveReview(database: ClimateDatabase, finding: AdaptiveShadowFinding, actor: string): AdaptiveFindingReview | null {
  const row = database.db.prepare(`${actorReviews} ORDER BY rowid DESC LIMIT 1`)
    .get(finding.epochId, finding.direction, actor) as ReviewRow | undefined;
  return row ? reviewFromRow(finding.id, row) : null;
}

/** Called with the visible finding and its current revision inside the write transaction. */
export function recordAdaptiveReview(database: ClimateDatabase, { finding, actor, input }: {
  finding: AdaptiveShadowFinding; actor: string; input: AdaptiveFindingReviewWrite;
}): AdaptiveFindingReview {
  const note = input.note?.trim() || null;
  const reportedRecovery = input.reportedRecovery ?? false;
  const existing = database.db.prepare(`${actorReviews} AND idempotency_key = ?`)
    .get(finding.epochId, finding.direction, actor, input.idempotencyKey) as ReviewRow | undefined;
  if (existing) {
    const saved = reviewFromRow(finding.id, existing);
    if (saved.findingRevision !== input.baseRevision || saved.disposition !== input.disposition
      || saved.note !== note || saved.reportedRecovery !== reportedRecovery) {
      throw new HttpError(409, "ADAPTIVE_REVIEW_KEY_CONFLICT", "This idempotency key already identifies another review");
    }
    return saved;
  }
  if (finding.revision !== input.baseRevision) {
    throw new HttpError(409, "ADAPTIVE_FINDING_REVISION_CONFLICT", "The finding changed before the review was recorded");
  }
  const supersedesReviewId = latestAdaptiveReview(database, finding, actor)?.id ?? null;
  const id = randomUUID();
  const recordedAt = new Date().toISOString();
  database.db.prepare(`INSERT INTO adaptive_finding_reviews (id, epoch_id, direction, finding_revision,
      actor_id, idempotency_key, disposition, note, reported_recovery, supersedes_review_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, finding.epochId, finding.direction, input.baseRevision, actor, input.idempotencyKey,
    input.disposition, note, Number(reportedRecovery), supersedesReviewId, recordedAt,
  );
  return { id, findingId: finding.id, findingRevision: input.baseRevision, disposition: input.disposition, note,
    reportedRecovery, supersedesReviewId, recordedAt };
}
