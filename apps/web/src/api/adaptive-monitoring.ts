import {
  isAdaptiveSnapshot, isAdaptiveSettings, isAdaptiveFinding, isAdaptiveFindingDetail, isAdaptivePage,
  type DataMode, type AdaptiveSettingsPatch, type AdaptiveReviewInput, type AdaptiveFinding, type AdaptiveKind,
} from "@climate-twin/contracts";
import { guarded } from "./support/response-shapes";
import { requestV2 } from "./support/request";

const path = (houseId: string) => `/monitoring/houses/${encodeURIComponent(houseId)}/adaptive`;
export const adaptiveMonitoringApi = {
  adaptiveMonitoring: (houseId: string, options: { dataMode: DataMode; signal?: AbortSignal; streamCursor?: string; findingCursor?: string; kind?: AdaptiveKind | undefined }) => {
    const query = new URLSearchParams({ dataMode: options.dataMode });
    if (options.streamCursor) query.set("streamCursor", options.streamCursor);
    if (options.findingCursor) query.set("findingCursor", options.findingCursor);
    if (options.kind) query.set("kind", options.kind);
    return requestV2(`${path(houseId)}?${query}`, guarded(isAdaptiveSnapshot), { ...(options.signal ? { signal: options.signal } : {}) });
  },
  adaptiveFindings: (houseId: string, options: { dataMode: DataMode; signal?: AbortSignal; cursor?: string; activeOnly?: boolean; kind?: AdaptiveKind | undefined }) => {
    const query = new URLSearchParams({ dataMode: options.dataMode });
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.activeOnly) query.set("activeOnly", "true");
    if (options.kind) query.set("kind", options.kind);
    return requestV2(`${path(houseId)}/findings?${query}`, guarded((v): v is { items: AdaptiveFinding[]; nextCursor: string | null } =>
      isAdaptivePage(v, isAdaptiveFinding)), { ...(options.signal ? { signal: options.signal } : {}) });
  },
  adaptiveFinding: (houseId: string, options: { dataMode: DataMode; findingId: string; signal?: AbortSignal }) =>
    requestV2(`${path(houseId)}/findings/${encodeURIComponent(options.findingId)}?dataMode=${options.dataMode}`, guarded(isAdaptiveFindingDetail),
      { ...(options.signal ? { signal: options.signal } : {}) }),
  updateAdaptiveSettings: (houseId: string, patch: AdaptiveSettingsPatch) =>
    requestV2(`${path(houseId)}/settings`, guarded(isAdaptiveSettings), { method: "PATCH", body: JSON.stringify(patch) }),
  reviewAdaptiveFinding: (houseId: string, findingId: string, body: AdaptiveReviewInput) =>
    requestV2(`${path(houseId)}/findings/${encodeURIComponent(findingId)}/reviews`, guarded(isAdaptiveFinding), { method: "POST", body: JSON.stringify(body) }),
};
