import {
  isAdaptiveFindingDetail, isAdaptiveFindingReview, isAdaptiveHomeSnapshot, isAdaptiveMonitoringSettings,
  type AdaptiveFindingReviewWrite, type AdaptiveSettingsChange, type AdaptiveSettingsScope,
} from "@climate-twin/contracts";
import { requestV2 } from "./support/request";
import { guarded } from "./support/response-shapes";

function adaptivePath(houseId: string) {
  return `/monitoring/houses/${encodeURIComponent(houseId)}/adaptive`;
}

function findingPath(houseId: string, findingId: string) {
  return `${adaptivePath(houseId)}/findings/${encodeURIComponent(findingId)}`;
}

export const adaptiveMonitoringApi = {
  snapshot(scope: AdaptiveSettingsScope, options: { signal: AbortSignal; findingCursor?: string; streamCursor?: string }) {
    const params = new URLSearchParams({ dataMode: scope.dataMode, limit: "10" });
    if (options.findingCursor) params.set("findingCursor", options.findingCursor);
    if (options.streamCursor) params.set("streamCursor", options.streamCursor);
    return requestV2(`${adaptivePath(scope.houseId)}?${params}`, guarded(isAdaptiveHomeSnapshot), { signal: options.signal });
  },
  finding(scope: AdaptiveSettingsScope, findingId: string, options: { signal: AbortSignal; beforeEvidenceAt?: string; beforeRevision?: number }) {
    const params = new URLSearchParams({ dataMode: scope.dataMode, limit: "8" });
    if (options.beforeEvidenceAt) params.set("beforeEvidenceAt", options.beforeEvidenceAt);
    if (options.beforeRevision) params.set("beforeRevision", String(options.beforeRevision));
    return requestV2(`${findingPath(scope.houseId, findingId)}?${params}`, guarded(isAdaptiveFindingDetail), { signal: options.signal });
  },
  review(scope: AdaptiveSettingsScope, findingId: string, input: AdaptiveFindingReviewWrite) {
    return requestV2(`${findingPath(scope.houseId, findingId)}/reviews?dataMode=${scope.dataMode}`, guarded(isAdaptiveFindingReview),
      { method: "POST", body: JSON.stringify(input) });
  },
  changeSettings(houseId: string, input: AdaptiveSettingsChange) {
    return requestV2(`${adaptivePath(houseId)}/settings`, guarded(isAdaptiveMonitoringSettings),
      { method: "PATCH", body: JSON.stringify(input) });
  },
};
