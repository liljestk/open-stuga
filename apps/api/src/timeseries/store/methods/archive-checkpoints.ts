import { qualifiedName } from "../../schema.js";
import type { ArchiveCheckpoint, ArchiveTableName, QueryControl } from "../../types.js";
import { ArchiveCheckpointRow } from "../support/row-types.js";
import { timestamp } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    getArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<ArchiveCheckpoint | null>;
    archiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<number>;
    setArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<ArchiveCheckpoint>;
    saveArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<void>;
  }

  interface TimeseriesStoreCore {
    getArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<ArchiveCheckpoint | null>;
    archiveCheckpoint(sourceId: string, tableName: ArchiveTableName, control?: QueryControl): Promise<number>;
    setArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<ArchiveCheckpoint>;
    saveArchiveCheckpoint(sourceId: string, tableName: ArchiveTableName, lastRowId: number, control?: QueryControl): Promise<void>;
  }
}

registerTimeseriesStoreMethods({
  async getArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      control: QueryControl = {},
    ): Promise<ArchiveCheckpoint | null> {
      const result = await this.__query<ArchiveCheckpointRow>(`SELECT source_id, table_name, last_row_id, updated_at
        FROM ${qualifiedName(this.schema, "archive_checkpoints")}
        WHERE source_id = $1 AND table_name = $2`, [sourceId, tableName], control);
      const row = result.rows[0];
      if (!row) return null;
      const lastRowId = Number(row.last_row_id);
      if (!Number.isSafeInteger(lastRowId)) throw new RangeError("Archive checkpoint exceeds JavaScript's safe integer range");
      return {
        sourceId: row.source_id,
        tableName: row.table_name,
        lastRowId,
        updatedAt: timestamp(row.updated_at),
      };
    },
  /** Returns zero for a source/table pair that has never been archived. */
  async archiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      control: QueryControl = {},
    ): Promise<number> {
      return (await this.getArchiveCheckpoint(sourceId, tableName, control))?.lastRowId ?? 0;
    },
  /** Atomically advances a cursor and never lets overlapping workers move it backwards. */
  async setArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      lastRowId: number,
      control: QueryControl = {},
    ): Promise<ArchiveCheckpoint> {
      if (!Number.isSafeInteger(lastRowId) || lastRowId < 0) {
        throw new RangeError("lastRowId must be a non-negative safe integer");
      }
      const result = await this.__query<ArchiveCheckpointRow>(`INSERT INTO ${qualifiedName(this.schema, "archive_checkpoints")} AS checkpoint
          (source_id, table_name, last_row_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (source_id, table_name) DO UPDATE SET
          last_row_id = GREATEST(checkpoint.last_row_id, EXCLUDED.last_row_id),
          updated_at = CASE
            WHEN EXCLUDED.last_row_id > checkpoint.last_row_id THEN clock_timestamp()
            ELSE checkpoint.updated_at
          END
        RETURNING source_id, table_name, last_row_id, updated_at`, [sourceId, tableName, lastRowId], control);
      const row = result.rows[0];
      if (!row) throw new Error("PostgreSQL did not return the archive checkpoint");
      return {
        sourceId: row.source_id,
        tableName: row.table_name,
        lastRowId: Number(row.last_row_id),
        updatedAt: timestamp(row.updated_at),
      };
    },
  async saveArchiveCheckpoint(this: TimeseriesStoreInternals,
      sourceId: string,
      tableName: ArchiveTableName,
      lastRowId: number,
      control: QueryControl = {},
    ): Promise<void> {
      await this.setArchiveCheckpoint(sourceId, tableName, lastRowId, control);
    },
});
