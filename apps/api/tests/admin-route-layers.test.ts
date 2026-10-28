import express, { type Application } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { apiErrorMiddleware } from "../src/app/error-handling.js";
import { registerScheduledDataExportRoutes, type ScheduledDataExportRouteContext } from "../src/app/scheduled-data-export-routes.js";
import { registerSystemUpdateRoutes, type SystemUpdateRouteContext } from "../src/app/system-update-routes.js";
import type { LocalRequestPrincipal } from "../src/app/support/local-sessions.js";
import { SystemUpdateError } from "../src/system-updates.js";

function principal(role: LocalRequestPrincipal["role"]): LocalRequestPrincipal {
  return { userId: `user-${role}`, email: `${role}@example.test`, role, joinedAt: "2026-01-01T00:00:00.000Z", grants: [], bootstrap: false };
}

/** An app that signs every request in as `role` and answers errors like the API does. */
function appAs(role: LocalRequestPrincipal["role"], register: (app: Application) => void): Application {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.localPrincipal = principal(role);
    next();
  });
  register(app);
  app.use(apiErrorMiddleware(() => undefined));
  return app;
}

describe("system update routes", () => {
  const status = { schema: "stugu-system-update/v1", revision: 3, workflow: { id: "workflow-1", targets: { hostVersion: "0.52.0" } } };

  function updateRoutes(role: LocalRequestPrincipal["role"], systemUpdates: Record<string, unknown>) {
    const recordSecurityAudit = vi.fn();
    const app = appAs(role, (target) => registerSystemUpdateRoutes({
      app: target,
      prefix: "/api/v1",
      systemUpdates,
      recordSecurityAudit,
    } as unknown as SystemUpdateRouteContext));
    return { app, recordSecurityAudit };
  }

  it("answers a refused install with its update error and records no audit", async () => {
    const { app, recordSecurityAudit } = updateRoutes("owner", {
      queueLatest: vi.fn(async () => { throw new SystemUpdateError(409, "UPDATE_ALREADY_RUNNING", "An update is already running"); }),
    });
    const response = await request(app).post("/api/v1/system/updates/install").expect(409);
    expect(response.body.error).toEqual({ code: "UPDATE_ALREADY_RUNNING", message: "An update is already running" });
    expect(recordSecurityAudit).not.toHaveBeenCalled();
  });

  it("hides an unexpected check failure behind INTERNAL_ERROR", async () => {
    const { app } = updateRoutes("owner", {
      check: vi.fn(async () => { throw new TypeError("Cannot read properties of undefined (reading 'tag')"); }),
    });
    const response = await request(app).post("/api/v1/system/updates/check").expect(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("tag");
  });

  it("audits an accepted operation with the requested action and target version", async () => {
    const { app, recordSecurityAudit } = updateRoutes("owner", { requestOperation: vi.fn(async () => status) });
    await request(app).post("/api/v1/system/updates/operations").send({ action: "update-everything" }).expect(202);
    expect(recordSecurityAudit).toHaveBeenCalledWith(expect.objectContaining({ role: "owner" }), {
      eventType: "system.update.requested",
      subjectType: "system-update",
      subjectId: "new",
      details: { action: "update-everything", revision: 3, version: "0.52.0" },
    });
  });

  it("refuses members before touching the update service", async () => {
    const systemUpdates = { status: vi.fn(), check: vi.fn(), queueLatest: vi.fn(), requestOperation: vi.fn() };
    const { app } = updateRoutes("member", systemUpdates);
    await request(app).get("/api/v1/system/updates").expect(403);
    await request(app).post("/api/v1/system/updates/check").expect(403);
    await request(app).post("/api/v1/system/updates/install").expect(403);
    await request(app).post("/api/v1/system/updates/operations").send({ action: "update-everything" }).expect(403);
    for (const method of Object.values(systemUpdates)) expect(method).not.toHaveBeenCalled();
  });
});

describe("scheduled data export routes", () => {
  function exportRoutes(role: LocalRequestPrincipal["role"] = "owner") {
    const schedule = { id: "export-1", houseId: "house-a", name: "Weekly" };
    const scheduledDataExports = {
      get: vi.fn((id: string) => (id === schedule.id ? schedule : null)),
      list: vi.fn(() => [schedule]),
      create: vi.fn(),
      update: vi.fn(() => schedule),
      delete: vi.fn(),
      runNow: vi.fn(async () => schedule),
    };
    const app = appAs(role, (target) => registerScheduledDataExportRoutes({
      app: target,
      prefix: "/api/v1",
      database: { getHouse: (id: string) => (id === "house-a" || id === "house-b" ? { id } : null) },
      scheduledDataExports,
      visibility: () => ({ house: () => true }),
    } as unknown as ScheduledDataExportRouteContext));
    return { app, scheduledDataExports };
  }

  it("does not reach another Home's schedule through this Home's URL", async () => {
    const { app, scheduledDataExports } = exportRoutes();
    const other = "/api/v1/houses/house-b/scheduled-data-exports/export-1";
    await request(app).put(other).send({ name: "Renamed" }).expect(404);
    await request(app).delete(other).expect(404);
    await request(app).post(`${other}/run`).expect(404);
    expect(scheduledDataExports.update).not.toHaveBeenCalled();
    expect(scheduledDataExports.delete).not.toHaveBeenCalled();
    expect(scheduledDataExports.runNow).not.toHaveBeenCalled();
    await request(app).post("/api/v1/houses/house-a/scheduled-data-exports/export-1/run").expect(202);
    expect(scheduledDataExports.runNow).toHaveBeenCalledWith("export-1");
  });

  it("answers an unknown Home with 404 and refuses members", async () => {
    await request(exportRoutes().app).get("/api/v1/houses/house-missing/scheduled-data-exports").expect(404);
    await request(exportRoutes("member").app).get("/api/v1/houses/house-a/scheduled-data-exports").expect(403);
  });
});
