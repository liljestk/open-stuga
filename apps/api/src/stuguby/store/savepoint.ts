import type { DatabaseSync } from "node:sqlite";

export function withStugubySavepoint<T>(
  database: DatabaseSync,
  name: string,
  operation: () => T,
): T {
  if (!/^[a-z][a-z_]+$/.test(name)) throw new Error("Invalid Stuguby savepoint name");
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      database.exec(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // Preserve the operation failure if SQLite already rolled back.
    }
    throw error;
  }
}
