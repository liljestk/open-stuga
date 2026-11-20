import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isSavedAnalyticsView, type AnalyticsViewDefinition, type DataMode, type SavedAnalyticsView } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";

export interface SavedViewScope { userId: string; houseId: string; dataMode: DataMode }
interface ViewRow { id: string; house_id: string; data_mode: DataMode; name: string; revision: number; definition_json: string; created_at: string; updated_at: string }
function view(row: ViewRow): SavedAnalyticsView {
  const result = { id: row.id, houseId: row.house_id, dataMode: row.data_mode, name: row.name, revision: row.revision,
    definition: JSON.parse(row.definition_json), createdAt: row.created_at, updatedAt: row.updated_at };
  if (!isSavedAnalyticsView(result)) throw new HttpError(503, "SAVED_VIEW_INVALID", "Stored analytics view could not be read");
  return result;
}
export class SavedAnalyticsViews {
  constructor(private readonly db: DatabaseSync) {}
  list(scope: SavedViewScope): SavedAnalyticsView[] {
    const rows = this.db.prepare("SELECT * FROM saved_analytics_views WHERE user_id = ? AND house_id = ? AND data_mode = ? ORDER BY created_at, id")
      .all(scope.userId, scope.houseId, scope.dataMode) as unknown as ViewRow[];
    return rows.map(view);
  }
  get(scope: SavedViewScope, id: string): SavedAnalyticsView {
    const row = this.db.prepare("SELECT * FROM saved_analytics_views WHERE id = ? AND user_id = ? AND house_id = ? AND data_mode = ?")
      .get(id, scope.userId, scope.houseId, scope.dataMode) as unknown as ViewRow | undefined;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Saved analytics view not found");
    return view(row);
  }
  create(scope: SavedViewScope, input: { name: string; definition: AnalyticsViewDefinition }): SavedAnalyticsView {
    const id = randomUUID();
    const now = new Date().toISOString();
    const count = this.db.prepare("SELECT count(*) AS count FROM saved_analytics_views WHERE user_id = ? AND house_id = ? AND data_mode = ?")
      .get(scope.userId, scope.houseId, scope.dataMode) as { count: number };
    if (count.count >= 50) throw new HttpError(409, "SAVED_VIEW_LIMIT", "A Home can have at most 50 saved views per account and data mode");
    this.db.prepare("INSERT INTO saved_analytics_views VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(id, scope.userId, scope.houseId, scope.dataMode, input.name, JSON.stringify(input.definition), now, now);
    return this.get(scope, id);
  }
  update(scope: SavedViewScope, input: { id: string; baseRevision: number; name: string; definition: AnalyticsViewDefinition }): SavedAnalyticsView {
    this.get(scope, input.id);
    const result = this.db.prepare(`UPDATE saved_analytics_views SET name = ?, definition_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND house_id = ? AND data_mode = ? AND revision = ?`)
      .run(input.name, JSON.stringify(input.definition), new Date().toISOString(), input.id, scope.userId, scope.houseId, scope.dataMode, input.baseRevision);
    if (!result.changes) throw new HttpError(409, "SAVED_VIEW_CONFLICT", "This saved view changed. Reload it before trying again");
    return this.get(scope, input.id);
  }
  delete(scope: SavedViewScope, input: { id: string; baseRevision: number }): void {
    this.get(scope, input.id);
    const result = this.db.prepare("DELETE FROM saved_analytics_views WHERE id = ? AND user_id = ? AND house_id = ? AND data_mode = ? AND revision = ?")
      .run(input.id, scope.userId, scope.houseId, scope.dataMode, input.baseRevision);
    if (!result.changes) throw new HttpError(409, "SAVED_VIEW_CONFLICT", "This saved view changed. Reload it before trying again");
  }
}
