/** A constraint or trigger failure reported by node:sqlite. */
export interface SqliteFailure {
  kind: "unique" | "foreign-key" | "check" | "not-null" | "trigger";
  /** The constraint target (for example `houses.id`), or the trigger's RAISE message. */
  detail: string;
}

// Extended result codes: https://www.sqlite.org/rescode.html
const KINDS = new Map<number, SqliteFailure["kind"]>([
  [1555, "unique"], // SQLITE_CONSTRAINT_PRIMARYKEY
  [2067, "unique"], // SQLITE_CONSTRAINT_UNIQUE
  [787, "foreign-key"], // SQLITE_CONSTRAINT_FOREIGNKEY
  [275, "check"], // SQLITE_CONSTRAINT_CHECK
  [1299, "not-null"], // SQLITE_CONSTRAINT_NOTNULL
  [1811, "trigger"], // SQLITE_CONSTRAINT_TRIGGER
]);

/**
 * Some triggers emulate a constraint and RAISE its standard message (for
 * example "FOREIGN KEY constraint failed"); they are classified by what they
 * enforce rather than as a trigger.
 */
const EMULATED: ReadonlyArray<readonly [string, SqliteFailure["kind"]]> = [
  ["UNIQUE constraint failed", "unique"],
  ["FOREIGN KEY constraint failed", "foreign-key"],
  ["CHECK constraint failed", "check"],
  ["NOT NULL constraint failed", "not-null"],
];

const CONSTRAINT_PREFIX = /^[A-Z ]+ constraint failed:?\s*/u;

/** Classifies a node:sqlite constraint failure by its extended result code; null for anything else. */
export function sqliteFailure(error: unknown): SqliteFailure | null {
  if (!(error instanceof Error)) return null;
  const { code, errcode } = error as Error & { code?: unknown; errcode?: unknown };
  if (code !== "ERR_SQLITE_ERROR" || typeof errcode !== "number") return null;
  let kind = KINDS.get(errcode);
  if (!kind) return null;
  if (kind === "trigger") kind = EMULATED.find(([prefix]) => error.message.startsWith(prefix))?.[1] ?? kind;
  return { kind, detail: kind === "trigger" ? error.message : error.message.replace(CONSTRAINT_PREFIX, "") };
}

/**
 * True when `error` is this kind of constraint failure, optionally on one
 * target (`houses.id`) or, for a trigger, with exactly this RAISE message.
 */
export function isSqliteFailure(error: unknown, kind: SqliteFailure["kind"], detail?: string): boolean {
  const failure = sqliteFailure(error);
  return failure !== null && failure.kind === kind && (detail === undefined || failure.detail === detail);
}
