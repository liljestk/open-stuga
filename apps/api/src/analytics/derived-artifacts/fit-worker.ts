import { parentPort, workerData } from "node:worker_threads";
import type { MoistureResponseInput } from "../thermal/moisture-response.js";
import { runMoistureResponse } from "../thermal/moisture-response.js";
import type { ThermalIsolationInput } from "../thermal/isolation.js";
import { runThermalIsolation } from "../thermal/isolation.js";
import { qualifyAdaptiveClimateModel, type QualificationInput } from "../adaptive-monitoring/climate-qualification.js";

export type DerivedFitWorkerRequest =
  | { kind: "thermal-isolation"; input: ThermalIsolationInput }
  | { kind: "moisture-response"; input: MoistureResponseInput }
  | { kind: "adaptive-climate"; input: Omit<QualificationInput, "signal"> };

function fit(request: DerivedFitWorkerRequest) {
  switch (request.kind) {
    case "thermal-isolation": return runThermalIsolation(request.input);
    case "moisture-response": return runMoistureResponse(request.input);
    case "adaptive-climate": return qualifyAdaptiveClimateModel(request.input);
  }
}

function errorPayload(error: unknown): {
  name: string;
  message: string;
  code?: string;
} {
  const code = error && typeof error === "object" && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code.slice(0, 120)
    : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: (error instanceof Error ? error.message : "Derived analytics fit failed").slice(0, 1_000),
    ...(code ? { code } : {}),
  };
}

if (!parentPort) throw new Error("Derived fit worker requires a parent port");

try {
  const request = workerData as DerivedFitWorkerRequest;
  const result = fit(request);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: errorPayload(error) });
}
