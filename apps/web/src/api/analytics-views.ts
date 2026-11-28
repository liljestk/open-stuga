import { isSavedAnalyticsView, type AnalyticsViewDefinition, type DataMode } from "@climate-twin/contracts";
import { requestV2 } from "./support/request";
import { arrayOf, fields, guarded, noContent } from "./support/response-shapes";

const single = fields({ view: guarded(isSavedAnalyticsView) });
export const analyticsViewsApi = {
  savedAnalyticsViews: (houseId: string, dataMode: DataMode, signal?: AbortSignal) => requestV2(
    `/analytics/views?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`, fields({ views: arrayOf(guarded(isSavedAnalyticsView)) }), signal ? { signal } : undefined,
  ),
  saveAnalyticsView: (input: { houseId: string; dataMode: DataMode; name: string; definition: AnalyticsViewDefinition }) => requestV2(
    "/analytics/views", single, { method: "POST", body: JSON.stringify(input) },
  ),
  updateAnalyticsView: (input: { id: string; houseId: string; dataMode: DataMode; name: string; definition: AnalyticsViewDefinition; baseRevision: number }) => {
    const { id, ...body } = input;
    return requestV2(`/analytics/views/${encodeURIComponent(id)}`, single, { method: "PUT", body: JSON.stringify(body) });
  },
  deleteAnalyticsView: (input: { id: string; houseId: string; dataMode: DataMode; baseRevision: number }) => requestV2(
    `/analytics/views/${encodeURIComponent(input.id)}?houseId=${encodeURIComponent(input.houseId)}&dataMode=${input.dataMode}&baseRevision=${input.baseRevision}`,
    noContent, { method: "DELETE" },
  ),
};
