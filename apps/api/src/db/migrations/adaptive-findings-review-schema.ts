export const adaptiveFindingsReviewSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_finding_reviews (
    id TEXT PRIMARY KEY,
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('higher', 'lower')),
    finding_revision INTEGER NOT NULL CHECK (finding_revision > 0),
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('useful', 'not-useful', 'expected-change', 'uncertain')),
    note TEXT,
    reported_recovery INTEGER NOT NULL CHECK (reported_recovery IN (0, 1)),
    supersedes_review_id TEXT,
    recorded_at TEXT NOT NULL,
    UNIQUE (epoch_id, direction, actor_id, idempotency_key)
  );
  CREATE TRIGGER IF NOT EXISTS adaptive_finding_reviews_immutable BEFORE UPDATE ON adaptive_finding_reviews
    BEGIN SELECT RAISE(ABORT, 'Adaptive Home reviews are immutable'); END;
`;
