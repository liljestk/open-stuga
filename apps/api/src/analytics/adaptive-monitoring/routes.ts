import { isAdaptiveFinding } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { requireVisibleHouse } from "../../app/support/house-access.js";
import { requireWorkspaceAdmin, requestPrincipal } from "../../app/support/local-sessions.js";
import type { ApiRouteRegistrationContext } from "../../app/route-registration-context.js";
import { adaptiveDataMode, adaptiveKind, adaptiveSettingsPatch, adaptiveReviewInput, adaptiveCursor, adaptiveFindingFilter } from "./request.js";
import { adaptiveCursorAfter, adaptiveFindingKey, adaptivePage, type AdaptiveViewer } from "./service.js";

function viewer(context: ApiRouteRegistrationContext, response: Parameters<typeof requestPrincipal>[0]): AdaptiveViewer {
  const principal = requestPrincipal(response);
  return { actor: principal.userId, admin: principal.role === "owner" || principal.role === "admin",
    visibleSensor: id => context.visibility(response).sensor(id) };
}
export function registerAdaptiveMonitoringRoutes(context: ApiRouteRegistrationContext): void {
  const path = `${context.v2Prefix}/monitoring/houses/:houseId/adaptive`;
  const service = context.adaptiveMonitoring;
  context.app.get<{ houseId: string; findingId: string }>(path, (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.houseId as string);
    response.setHeader("cache-control", "private, no-store");
    response.json(service.snapshot(house, { mode: adaptiveDataMode(request.query.dataMode), viewer: viewer(context, response),
      kind: adaptiveKind(request.query.kind),
      streamCursor: adaptiveCursor(request.query.streamCursor), findingCursor: adaptiveCursor(request.query.findingCursor) }));
  });
  context.app.get<{ houseId: string; findingId: string }>(`${path}/findings`, (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.houseId as string);
    const mode = adaptiveDataMode(request.query.dataMode);
    service.assertMode(mode);
    const access = viewer(context, response);
    const filter = adaptiveFindingFilter(request.query);
    const findings = service.visibleFindings(house, mode, access).filter(f => (!filter.metric || f.metric === filter.metric)
      && (!filter.state || f.state === filter.state) && (!filter.kind || f.kind === filter.kind)
      && (!filter.activeOnly || f.state === "candidate" || f.state === "presented"));
    response.setHeader("cache-control", "private, no-store");
    response.json(adaptivePage(findings, { cursor: adaptiveCursor(request.query.cursor), limit: filter.limit,
      binding: [house.id, mode, access.actor, filter, findings.map(f => [f.id, f.revision])], key: adaptiveFindingKey }));
  });
  context.app.get<{ houseId: string; findingId: string }>(`${path}/findings/:findingId`, (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.houseId as string);
    const mode = adaptiveDataMode(request.query.dataMode);
    service.assertMode(mode);
    const access = viewer(context, response);
    const finding = service.visibleFindings(house, mode, access).find(f => f.id === request.params.findingId);
    if (!finding) throw new HttpError(404, "NOT_FOUND", "Finding not found");
    const binding = [house.id, mode, finding.id, finding.revision, access.actor];
    const cursor = adaptiveCursor(request.query.cursor);
    const after = adaptiveCursorAfter({ cursor, binding });
    if (after && !/^\d{12}$/.test(after)) throw new HttpError(409, "ADAPTIVE_CURSOR_CONFLICT", "Refresh this list to continue");
    const revisions = access.admin ? (context.database.db.prepare("SELECT finding_json FROM adaptive_finding_revisions WHERE finding_id=? AND revision>? ORDER BY revision LIMIT 51")
      .all(finding.id, Number(after || 0)) as Array<{ finding_json: string }>).map(r => {
        const parsed: unknown = JSON.parse(r.finding_json);
        if (!isAdaptiveFinding(parsed)) throw new HttpError(503, "ADAPTIVE_STORE_INVALID", "Finding history is unavailable");
        return { ...parsed, review: null };
      }) : [];
    response.setHeader("cache-control", "private, no-store");
    response.json({ finding, revisions: adaptivePage(revisions, { cursor, limit: 50,
      binding, key: item => String(item.revision).padStart(12, "0") }) });
  });
  context.app.patch<{ houseId: string }>(`${path}/settings`, requireWorkspaceAdmin, (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.houseId as string);
    const settings = service.settings(house.id, adaptiveSettingsPatch(request.body), requestPrincipal(response).userId);
    context.adaptiveMonitoringWorker.changed();
    response.json(settings);
  });
  context.app.post<{ houseId: string; findingId: string }>(`${path}/findings/:findingId/reviews`, requireWorkspaceAdmin, (request, response) => {
    const house = requireVisibleHouse(context, response, request.params.houseId as string);
    response.json(service.review(house, { id: request.params.findingId as string, body: adaptiveReviewInput(request.body),
      actor: requestPrincipal(response).userId }));
  });
}
