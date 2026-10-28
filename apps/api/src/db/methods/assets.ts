import { randomUUID } from "node:crypto";
import type { AssetRecord } from "@climate-twin/contracts";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & {
            data: Uint8Array;
        }): AssetRecord;
    listAssets(houseId?: string): AssetRecord[];
    getAsset(id: string): (AssetRecord & {
            data: Uint8Array;
        }) | null;
    deleteAsset(id: string): boolean;
  }
}

registerDatabaseMethods({
  createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & { data: Uint8Array }): AssetRecord {
      if (!this.getHouse(input.houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${input.houseId} does not exist`);
      }
      const asset: AssetRecord = {
        id: randomUUID(), houseId: input.houseId, name: input.name, mimeType: input.mimeType, kind: input.kind,
        size: input.data.byteLength, createdAt: new Date().toISOString(),
      };
      this.db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.houseId, asset.name, asset.mimeType, asset.kind, input.data, asset.size, asset.createdAt);
      return asset;
    },
  listAssets(houseId?: string): AssetRecord[] {
      const sql = `SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size, created_at as createdAt
        FROM assets WHERE EXISTS (SELECT 1 FROM houses AS house
          WHERE house.id = assets.house_id AND house.deleted_at IS NULL)
        ${houseId ? "AND house_id = ?" : ""} ORDER BY created_at DESC`;
      return (houseId ? this.db.prepare(sql).all(houseId) : this.db.prepare(sql).all()) as unknown as AssetRecord[];
    },
  getAsset(id: string): (AssetRecord & { data: Uint8Array }) | null {
      const row = this.db.prepare(`SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size,
        created_at as createdAt, data FROM assets WHERE id = ?
          AND EXISTS (SELECT 1 FROM houses AS house
            WHERE house.id = assets.house_id AND house.deleted_at IS NULL)`).get(id);
      return row as unknown as (AssetRecord & { data: Uint8Array }) | null;
    },
  deleteAsset(id: string): boolean {
      return Number(this.db.prepare(`DELETE FROM assets WHERE id = ?
        AND EXISTS (SELECT 1 FROM houses AS house
          WHERE house.id = assets.house_id AND house.deleted_at IS NULL)`).run(id).changes) > 0;
    },
});
