import { type Request } from "express";
import { discoverHomeAssistant } from "../discovery.js";
import { IntegrationDiscoveryJobs } from "../integration-discovery-jobs.js";
import { HttpError, bodyObject, boundedSseWriter, credentialString, localAuthorizationFingerprint, requestPrincipal, requiredString, requireWorkspaceAdmin } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Network discovery of Home Assistant, TP-Link, Gree and Tuya devices, run inline or as background jobs. Returns the job registry so shutdown can stop running jobs. */
export function registerIntegrationDiscoveryRoutes(context: ApiRouteRegistrationContext): IntegrationDiscoveryJobs {
  const integrationDiscovery = async (
      houseId?: string,
      draftCredentials?: { username: string; password: string },
    ) => {
      if (context.options.integrationDiscoverer) {
        const result = await context.options.integrationDiscoverer(houseId, draftCredentials);
        return { ...result, tuya: [] };
      }
      const [homeAssistantResult, tpLinkResult, greeResult] = await Promise.allSettled([
        discoverHomeAssistant(),
        context.tpLink.discoverSources(houseId, draftCredentials),
        context.gree.discoverSources(houseId),
      ]);
      const warnings: string[] = [];
      if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
      if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.");
      else warnings.push(...tpLinkResult.value.warnings);
      if (greeResult.status === "rejected" && (context.config.greeConnections?.length ?? 0) > 0) {
        warnings.push("Gree/Wilfa heat-pump discovery was unavailable.");
      }
      return {
        homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
        tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value.sources : [],
        gree: greeResult.status === "fulfilled" ? greeResult.value : [],
        tuya: [],
        warnings,
      };
    };
  const discoveryInput = (request: Request) => {
      const body = bodyObject(request.body);
      const houseId = body.houseId === undefined ? undefined : requiredString(body, "houseId");
      if (houseId && !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      if (houseId) context.stuguby.assertHouseLocalAuthority(houseId);
      const hasDraftUsername = body.tpLinkUsername !== undefined;
      const hasDraftPassword = body.tpLinkPassword !== undefined;
      if (hasDraftUsername !== hasDraftPassword) {
        throw new HttpError(400, "INVALID_TP_LINK_CREDENTIALS", "tpLinkUsername and tpLinkPassword must be supplied together");
      }
      const draftCredentials = hasDraftUsername && hasDraftPassword
        ? {
            username: credentialString(body, "tpLinkUsername", 320, true),
            password: credentialString(body, "tpLinkPassword", 4_096),
          }
        : undefined;
      return { houseId, draftCredentials };
    };
  const integrationDiscoveryJobs = new IntegrationDiscoveryJobs();
  context.app.post(`${context.prefix}/integrations/discover`, requireWorkspaceAdmin, async (request, response) => {
      const { houseId, draftCredentials } = discoveryInput(request);
      response.json(await integrationDiscovery(houseId, draftCredentials));
    });
  context.app.post(`${context.prefix}/integrations/discovery-jobs`, requireWorkspaceAdmin, (request, response) => {
      const { houseId, draftCredentials } = discoveryInput(request);
      if (!houseId) throw new HttpError(400, "HOUSE_REQUIRED", "houseId is required for background discovery");
      const principal = requestPrincipal(response);
      const ownerId = principal.userId;
      const job = integrationDiscoveryJobs.start(
        ownerId,
        houseId,
        () => integrationDiscovery(houseId, draftCredentials),
      );
      response.status(202).json({ job });
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/latest`, (request, response) => {
      const houseId = requiredString(request.query, "houseId");
      if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      response.json({ job: integrationDiscoveryJobs.latest(requestPrincipal(response).userId, houseId) });
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/events`, (request, response) => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const ownerId = requestPrincipal(response).userId;
      const jobId = requiredString(request.query, "jobId");
      const initialJob = integrationDiscoveryJobs.get(ownerId, jobId);
      if (!initialJob) throw new HttpError(404, "DISCOVERY_JOB_NOT_FOUND", "Device discovery job not found");
      context.stuguby.assertHouseLocalAuthority(initialJob.houseId);
      const releaseStream = context.acquireEventStream(response);
      if (!releaseStream) {
        response.setHeader("retry-after", "5");
        throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
      }
      const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders();
      const writer = boundedSseWriter(response);
      const write = (job: ReturnType<typeof integrationDiscoveryJobs.get>) => {
        if (!job || job.id !== jobId || response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access?.house(job.houseId)) return;
        writer.send(`event: integration-discovery\ndata: ${JSON.stringify(job)}\n\n`);
      };
      const unsubscribe = integrationDiscoveryJobs.subscribe(ownerId, write);
      write(integrationDiscoveryJobs.get(ownerId, jobId));
      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
        writer.send(": keep-alive\n\n");
      }, 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    });
  context.app.get(`${context.prefix}/integrations/discovery-jobs/:id`, (request, response) => {
      const job = integrationDiscoveryJobs.get(requestPrincipal(response).userId, request.params.id as string);
      if (!job) throw new HttpError(404, "DISCOVERY_JOB_NOT_FOUND", "Device discovery job not found");
      context.stuguby.assertHouseLocalAuthority(job.houseId);
      response.json({ job });
    });
  return integrationDiscoveryJobs;
}
