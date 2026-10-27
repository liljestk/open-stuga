import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClimateDatabase, ensureSqliteSpillDirectory } from "../src/db.js";

describe("SQLite spill directory", () => {
  let workDirectory: string;
  let savedTmpdir: string | undefined;

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), "stugu-spill-"));
    savedTmpdir = process.env.SQLITE_TMPDIR;
    delete process.env.SQLITE_TMPDIR;
  });

  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.SQLITE_TMPDIR;
    else process.env.SQLITE_TMPDIR = savedTmpdir;
    rmSync(workDirectory, { recursive: true, force: true });
  });

  it("creates a spill directory beside the database and exposes it to SQLite", () => {
    const databasePath = join(workDirectory, "climate-twin.sqlite");
    ensureSqliteSpillDirectory(databasePath);

    const spillDirectory = join(workDirectory, ".sqlite-tmp");
    expect(existsSync(spillDirectory)).toBe(true);
    expect(process.env.SQLITE_TMPDIR).toBe(spillDirectory);
  });

  it("never overrides an operator-provided SQLITE_TMPDIR and skips in-memory databases", () => {
    process.env.SQLITE_TMPDIR = join(workDirectory, "operator-tmp");
    ensureSqliteSpillDirectory(join(workDirectory, "climate-twin.sqlite"));
    expect(process.env.SQLITE_TMPDIR).toBe(join(workDirectory, "operator-tmp"));

    delete process.env.SQLITE_TMPDIR;
    ensureSqliteSpillDirectory(":memory:");
    expect(process.env.SQLITE_TMPDIR).toBeUndefined();
  });

  it("leaves the process environment to the entry point when a database opens", () => {
    const databasePath = join(workDirectory, "climate-twin.sqlite");
    const database = new ClimateDatabase(databasePath, false);
    try {
      expect(existsSync(join(workDirectory, ".sqlite-tmp"))).toBe(false);
      expect(process.env.SQLITE_TMPDIR).toBeUndefined();
    } finally {
      database.db.close();
    }
  });
});
