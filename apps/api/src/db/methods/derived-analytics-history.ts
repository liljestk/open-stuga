import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  invalidateDerivedAnalyticsHistory(
    houseId: string,
    from: string,
    to: string,
    invalidatedAt = new Date().toISOString(),
  ): boolean {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new RangeError("Derived analytics invalidation requires a valid history interval");
    }
    // Invalidate only if new history overlaps an identity evaluated with the
    // current evidence revision. The first batch changes that revision, so a
    // large import cannot churn it once per sample. The extra day covers DST
    // boundaries while keeping unrelated old history outside the fit window.
    const result = this.db.prepare(`
      UPDATE derived_analytics_evidence_revisions AS revision
      SET revision = revision + 1, updated_at = ?
      WHERE revision.house_id = ?
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT house_id, window_days, cutoff, evidence_version
            FROM derived_analytics_artifacts
            UNION ALL
            SELECT house_id, window_days, cutoff, evidence_version
            FROM derived_analytics_jobs
          ) AS evaluated
          CROSS JOIN derived_analytics_global_revision AS global
          WHERE evaluated.house_id = revision.house_id
            AND evaluated.evidence_version =
              'evidence-v2:' || revision.revision || ':' || global.revision
            AND julianday(?) < julianday(evaluated.cutoff)
            AND julianday(?) >= julianday(
              evaluated.cutoff,
              printf('-%d days', evaluated.window_days + 1)
            )
        )
    `).run(invalidatedAt, houseId, from, to);
    return Number(result.changes) > 0;
  },
});
