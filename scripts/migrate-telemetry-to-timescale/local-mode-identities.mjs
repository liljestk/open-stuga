import { DatabaseSync } from "node:sqlite";
import { assertSqliteCheck, createVerifiedSqliteSnapshot, describeFile, openReadOnlySqlite } from "../sqlite-snapshot-utils.mjs";

export async function stageLocalMeasurementModeIdentities({ source, snapshot }) {
  const { prepareMeasurementModeIdentity } = await import(
    "../../apps/api/dist/db/migrations/measurement-mode-identity.js"
  );
  const base = await createVerifiedSqliteSnapshot({ sourcePath: source, destinationPath: snapshot });
  const database = new DatabaseSync(snapshot);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    prepareMeasurementModeIdentity(database);
  } finally {
    database.close();
  }
  const staged = openReadOnlySqlite(snapshot);
  try {
    assertSqliteCheck(staged, "integrity_check");
  } finally {
    staged.close();
  }
  const report = { source: base.source, staged: await describeFile(snapshot), integrity: "ok" };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
