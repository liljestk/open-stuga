import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSqliteFailure, sqliteFailure } from "../src/db/sqlite-failure.js";

function failing(sql: string): unknown {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id), size INTEGER CHECK (size > 0));
    CREATE TABLE guarded (id TEXT PRIMARY KEY);
    CREATE TRIGGER refuse_demo BEFORE INSERT ON guarded WHEN NEW.id = 'demo'
      BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
    CREATE TRIGGER emulated_reference BEFORE INSERT ON guarded WHEN NEW.id = 'orphan'
      BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END;
    INSERT INTO parent VALUES ('p');`);
  try {
    db.exec(sql);
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
  throw new Error(`expected ${sql} to fail`);
}

describe("SQLite failure classification", () => {
  it("classifies constraints by result code and names their target", () => {
    expect(sqliteFailure(failing("INSERT INTO parent VALUES ('p')"))).toEqual({ kind: "unique", detail: "parent.id" });
    expect(sqliteFailure(failing("INSERT INTO child VALUES ('c', 'missing', 1)"))).toEqual({ kind: "foreign-key", detail: "" });
    expect(sqliteFailure(failing("INSERT INTO child VALUES ('c', 'p', 0)"))).toEqual({ kind: "check", detail: "size > 0" });
  });

  it("keeps a trigger's RAISE message and recognizes triggers that emulate a constraint", () => {
    expect(isSqliteFailure(failing("INSERT INTO guarded VALUES ('demo')"), "trigger", "DEMO_DATA_DISABLED")).toBe(true);
    expect(isSqliteFailure(failing("INSERT INTO guarded VALUES ('orphan')"), "foreign-key")).toBe(true);
  });

  it("ignores errors that are not SQLite constraint failures", () => {
    expect(sqliteFailure(new Error("UNIQUE constraint failed: parent.id"))).toBeNull();
    expect(sqliteFailure(failing("SELECT * FROM missing_table"))).toBeNull();
  });
});
