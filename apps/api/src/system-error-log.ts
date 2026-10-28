import type { ClimateDatabase } from "./db.js";

const MAXIMUM_ENTRIES = 2_000;
const RETENTION_MS = 30 * 86_400_000;
const PRUNE_EVERY_ENTRIES = 64;

export interface SystemErrorLogEntry {
  id: number;
  occurredAt: string;
  level: "warning" | "error";
  source: string;
  code: string;
  message: string;
}

export interface SystemErrorLogInput {
  level?: SystemErrorLogEntry["level"];
  source: string;
  code: string;
  message: string;
  occurredAt?: Date;
}

function identifier(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
  return cleaned || fallback;
}

/** Redact common credentials and personal identifiers before anything reaches durable storage. */
export function redactSystemErrorMessage(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s\"'<>|]+\\)*[^\\\s\"'<>|]*/g, "[redacted-path]")
    .replace(/(^|[\s\"'(])\/(?:[^/\s\"'()]+\/)*[^/\s\"'()]*/g, (_match, prefix: string) => `${prefix}[redacted-path]`)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]")
    .replace(/\b(?:token|password|secret|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, (match) => {
      const separator = match.search(/[:=]/);
      return `${match.slice(0, separator + 1)}[redacted]`;
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "No safe error detail was available").slice(0, 1_000);
}

export class SystemErrorLog {
  #entriesUntilPrune = 0;

  constructor(private readonly database: ClimateDatabase) {}

  /** Stores a redacted entry; false when the log itself could not be written. */
  record(input: SystemErrorLogInput): boolean {
    try {
      const occurredAt = (input.occurredAt ?? new Date()).toISOString();
      this.database.db.prepare(`INSERT INTO system_error_log
        (occurred_at, level, source, code, message) VALUES (?, ?, ?, ?, ?)`)
        .run(
          occurredAt,
          input.level ?? "error",
          identifier(input.source, "system"),
          identifier(input.code, "UNKNOWN"),
          redactSystemErrorMessage(input.message),
        );
      if (this.#entriesUntilPrune <= 0) {
        this.database.db.prepare("DELETE FROM system_error_log WHERE occurred_at < ?")
          .run(new Date(Date.parse(occurredAt) - RETENTION_MS).toISOString());
        this.database.db.prepare(`DELETE FROM system_error_log WHERE id IN (
          SELECT id FROM system_error_log
          ORDER BY occurred_at DESC, id DESC LIMIT -1 OFFSET ?
        )`).run(MAXIMUM_ENTRIES);
        this.#entriesUntilPrune = PRUNE_EVERY_ENTRIES;
      }
      this.#entriesUntilPrune -= 1;
      return true;
    } catch {
      // Error reporting must never replace the original operation or recurse.
      return false;
    }
  }

  list(limit = 1_000, now = new Date()): SystemErrorLogEntry[] {
    const boundedLimit = Math.max(1, Math.min(MAXIMUM_ENTRIES, Math.floor(limit)));
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    const rows = this.database.db.prepare(`SELECT id, occurred_at, level, source, code, message
      FROM system_error_log WHERE occurred_at >= ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(cutoff, boundedLimit) as Array<{
        id: number;
        occurred_at: string;
        level: SystemErrorLogEntry["level"];
        source: string;
        code: string;
        message: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      level: row.level,
      source: row.source,
      code: row.code,
      message: row.message,
    }));
  }

  exportNdjson(now = new Date()): string {
    const entries = this.list(1_000, now);
    const header = {
      type: "stugu.system-error-log-export",
      version: 1,
      generatedAt: now.toISOString(),
      redacted: true,
      entryCount: entries.length,
    };
    return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  }
}

/**
 * Records the failure behind a user-facing error that does not name it, so a
 * defect that looks like a user mistake still leaves a (redacted) trace.
 */
export function recordFailureCause(log: Pick<SystemErrorLog, "record">, source: string, error: unknown): void {
  log.record({
    level: "warning",
    source,
    code: error instanceof Error ? error.name : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Where background work reports failures. */
export type FailureLog = Pick<SystemErrorLog, "record">;

/**
 * Records a background failure in the system error log. Only when that log is
 * unavailable does a detail-free line go to the console instead.
 */
export function reportBackgroundFailure(log: FailureLog | null | undefined, input: SystemErrorLogInput): void {
  if (log?.record(input)) return;
  console.error(JSON.stringify({ event: "background_failure", source: input.source, code: input.code }));
}
