import { randomUUID } from "node:crypto";
import type { StaticParameter } from "@climate-twin/contracts";
import { StaticParameterRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { parameterFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    listParameters(houseId?: string): StaticParameter[];
    saveParameter(input: Omit<StaticParameter, "id"> & {
            id?: string;
        }): StaticParameter;
    deleteParameter(id: string): boolean;
  }
}

registerDatabaseMethods({
  listParameters(houseId?: string): StaticParameter[] {
      const rows = (houseId
        ? this.db.prepare(`SELECT parameter.* FROM static_parameters AS parameter
            JOIN houses AS house ON house.id = parameter.house_id
            WHERE parameter.house_id = ? AND house.deleted_at IS NULL ORDER BY parameter.label`).all(houseId)
        : this.db.prepare(`SELECT parameter.* FROM static_parameters AS parameter
            JOIN houses AS house ON house.id = parameter.house_id
            WHERE house.deleted_at IS NULL ORDER BY parameter.label`).all()) as unknown as StaticParameterRow[];
      return rows.map(parameterFromRow);
    },
  saveParameter(input: Omit<StaticParameter, "id"> & { id?: string }): StaticParameter {
      if (!this.getHouse(input.houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${input.houseId} does not exist`);
      }
      const parameter: StaticParameter = { ...input, id: input.id ?? randomUUID() };
      this.db.prepare(`INSERT INTO static_parameters
        (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(house_id, scope_type, scope_id, key) DO UPDATE SET
          value_json = excluded.value_json, unit = excluded.unit, label = excluded.label`)
        .run(parameter.id, parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key,
          JSON.stringify(parameter.value), parameter.unit, parameter.label);
      const row = this.db.prepare(`SELECT * FROM static_parameters
        WHERE house_id = ? AND scope_type = ? AND scope_id = ? AND key = ?`)
        .get(parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key) as unknown as StaticParameterRow;
      return parameterFromRow(row);
    },
  deleteParameter(id: string): boolean {
      return Number(this.db.prepare(`DELETE FROM static_parameters WHERE id = ?
        AND EXISTS (SELECT 1 FROM houses AS house
          WHERE house.id = static_parameters.house_id AND house.deleted_at IS NULL)`).run(id).changes) > 0;
    },
});
