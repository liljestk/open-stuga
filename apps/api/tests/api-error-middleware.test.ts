import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsQueryError } from "../src/analytics.js";
import { apiErrorMiddleware } from "../src/app/error-handling.js";
import { MeasurementValidationError } from "../src/services.js";
import { IncompleteTelemetryHistoryError } from "../src/timeseries/read-facade.js";

function appThrowing(error: unknown, recordUnexpected = vi.fn()) {
  const app = express();
  app.get("/fails", () => { throw error; });
  app.use(apiErrorMiddleware(recordUnexpected));
  return { app, recordUnexpected };
}

describe("API error middleware", () => {
  it("answers a domain error with its own status and code", async () => {
    const { app, recordUnexpected } = appThrowing(new AnalyticsQueryError(422, "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED", "Too many points"));
    const response = await request(app).get("/fails").expect(422);
    expect(response.body.error).toEqual({ code: "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED", message: "Too many points" });
    expect(recordUnexpected).not.toHaveBeenCalled();
  });

  it("takes (status, code, message) for every domain error", async () => {
    const { app } = appThrowing(new MeasurementValidationError(404, "UNKNOWN_SENSOR", "Sensor not found"));
    const response = await request(app).get("/fails").expect(404);
    expect(response.body.error.code).toBe("UNKNOWN_SENSOR");
  });

  it("tells the client which archive state blocked complete history", async () => {
    const { app } = appThrowing(new IncompleteTelemetryHistoryError("not-ready"));
    const response = await request(app).get("/fails").expect(503);
    expect(response.body.error).toMatchObject({ code: "TELEMETRY_ARCHIVE_REQUIRED", details: { archiveState: "not-ready" } });
  });

  it("records a programming error and answers 500 instead of a client 400", async () => {
    const { app, recordUnexpected } = appThrowing(new TypeError("cannot read properties of undefined"));
    const response = await request(app).get("/fails").expect(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(recordUnexpected).toHaveBeenCalledOnce();
  });
});
