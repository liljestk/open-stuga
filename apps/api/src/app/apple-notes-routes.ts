import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppleNotesMaintenanceCaptureResult } from "@climate-twin/contracts";
import { ClimateDatabase, ClimateDataValidationError } from "../db.js";
import { updateIntegrationSecrets, type AppleNotesGrantSecret } from "../integration-secrets.js";
import { HttpError, appleNotesCaptureInput, appleNotesCaptureMatches, appleNotesGrant, appleNotesGrantSummary, appleNotesSnapshot, bodyObject, refreshAppleNotesStatus, requestPrincipal, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Apple Notes Shortcut grants, setup, snapshots and captures. */
export function registerAppleNotesRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.use(`${context.prefix}/integrations/apple-notes`, (_request, response, next) => {
      response.setHeader("cache-control", "no-store");
      next();
    });
  context.app.get(`${context.prefix}/integrations/apple-notes/grants`, (_request, response) => response.json({
      grants: config.appleNotesGrants.map(appleNotesGrantSummary),
    }));
  context.app.post(`${context.prefix}/integrations/apple-notes/grants`, (request, response) => {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      const deviceLabel = requiredString(body, "deviceLabel");
      if (Array.from(deviceLabel).length > 100) throw new HttpError(400, "INVALID_FIELD", "deviceLabel must be at most 100 characters");
      if (!context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const token = `stuga_notes_${randomBytes(32).toString("base64url")}`;
      const grant: AppleNotesGrantSecret = {
        id: randomUUID(),
        tokenHash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
        deviceLabel,
        houseId,
        createdAt: new Date().toISOString(),
      };
      const secrets = updateIntegrationSecrets(config.integrationSecretsFile, { addAppleNotesGrant: grant });
      context.integrationMetadata.saveAppleNotesGrant(grant);
      config.appleNotesGrants = secrets.appleNotesGrants ?? [];
      refreshAppleNotesStatus(config, context.status);
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.grant.issued",
        subjectType: "integration-grant",
        subjectId: `apple-notes:${grant.id}`,
        details: { integration: "apple-notes", houseId: grant.houseId },
      });
      response.status(201).json({ ...appleNotesGrantSummary(grant), token, integration: structuredClone(context.status.value) });
    });
  context.app.delete(`${context.prefix}/integrations/apple-notes/grants/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!config.appleNotesGrants.some((grant) => grant.id === id)) {
        throw new HttpError(404, "NOT_FOUND", "Apple Notes Shortcut grant not found");
      }
      const secrets = updateIntegrationSecrets(config.integrationSecretsFile, { removeAppleNotesGrantId: id });
      context.integrationMetadata.retireAppleNotesGrant(id);
      config.appleNotesGrants = secrets.appleNotesGrants ?? [];
      refreshAppleNotesStatus(config, context.status);
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.grant.revoked",
        subjectType: "integration-grant",
        subjectId: `apple-notes:${id}`,
        details: { integration: "apple-notes" },
      });
      response.json({ ok: true, integration: structuredClone(context.status.value) });
    });
  context.app.get(`${context.prefix}/integrations/apple-notes/setup`, (_request, response) => response.json({
      available: true,
      snapshotPath: "/integrations/apple-notes/snapshot",
      capturePath: "/integrations/apple-notes/capture",
      steps: [
        "Create a house-scoped Shortcut grant in Stugu and copy its bearer token; the token is shown only once.",
        "In Shortcuts, fetch the snapshot URL with an Authorization: Bearer header containing that token.",
        "Create a new dated Apple Note from the returned text on a schedule or when you run the Shortcut; do not overwrite an existing note.",
        "For quick capture, generate one UUID before any in-run retry block and POST it as operationId in the documented command JSON.",
        "Reuse that UUID variable for every HTTP attempt in the same run; Stugu returns the original task without duplicating it. Restarting the Shortcut generates a new operation unless you persist the UUID, so check Stugu before rerunning after an unknown result.",
      ],
      limitations: [
        "Apple Notes has no server API. This is a user-run iOS Shortcuts bridge, not live Apple Account synchronization.",
        "Stugu is the source of truth. Notes checkboxes and arbitrary note edits are never parsed or applied.",
        "Capture creates maintenance tasks only; completing, verifying, rescheduling, and deleting tasks stays in Stugu.",
        "The iPhone must be able to reach this Stugu address, preferably over private HTTPS or a trusted home network.",
      ],
    }));
  context.app.get(`${context.prefix}/integrations/apple-notes/snapshot`, (request, response) => {
      const grant = appleNotesGrant(request, config);
      const houseQuery = request.query.houseId;
      if (typeof houseQuery !== "string" || !houseQuery.trim()) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
      const houseId = houseQuery.trim();
      if (grant.houseId !== houseId) throw new HttpError(403, "APPLE_NOTES_HOUSE_SCOPE", "This Shortcut grant cannot access the requested house");
      const snapshot = appleNotesSnapshot(context.database, houseId);
      const appleNotes = context.status.value.appleNotes!;
      appleNotes.lastSyncAt = snapshot.generatedAt;
      appleNotes.error = null;
      context.status.changed();
      response.json(snapshot);
    });
  context.app.post(`${context.prefix}/integrations/apple-notes/capture`, (request, response) => {
      const grant = appleNotesGrant(request, config);
      const capture = appleNotesCaptureInput(request.body);
      if (capture.input.houseId !== grant.houseId) {
        throw new HttpError(403, "APPLE_NOTES_HOUSE_SCOPE", "This Shortcut grant cannot create tasks for the requested house");
      }
      const id = capture.input.id!;
      let captureResult: ReturnType<ClimateDatabase["getOrCreateMaintenanceTask"]>;
      try {
        captureResult = context.database.getOrCreateMaintenanceTask(capture.input, "local-rest");
      } catch (error) {
        if (error instanceof ClimateDataValidationError && error.code === "MAINTENANCE_ID_CONFLICT") {
          throw new HttpError(409, "APPLE_NOTES_OPERATION_CONFLICT", "operationId was already used with different maintenance content");
        }
        throw error;
      }
      const { task, created } = captureResult;
      const deduplicated = !created;
      if (deduplicated) {
        const original = context.database.listMaintenanceTaskRevisions(id)[0]?.snapshot;
        if (!original || !appleNotesCaptureMatches(original, capture.input)) {
          throw new HttpError(409, "APPLE_NOTES_OPERATION_CONFLICT", "operationId was already used with different maintenance content");
        }
      }
      const result: AppleNotesMaintenanceCaptureResult = {
        ok: true,
        deduplicated,
        task,
        receipt: `apple-notes:${capture.operationId}`,
      };
      const appleNotes = context.status.value.appleNotes!;
      appleNotes.lastSyncAt = new Date().toISOString();
      appleNotes.error = null;
      context.status.changed();
      response.status(deduplicated ? 200 : 201).json(result);
    });
}
