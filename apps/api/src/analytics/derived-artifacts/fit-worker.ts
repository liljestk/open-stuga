import { parentPort, workerData } from "node:worker_threads";
import type { MoistureResponseInput } from "../thermal/moisture-response.js";
import { runMoistureResponse } from "../thermal/moisture-response.js";
import type { ThermalIsolationInput } from "../thermal/isolation.js";
import { runThermalIsolation } from "../thermal/isolation.js";

export type DerivedFitWorkerRequest =
  | { kind: "thermal-isolation"; input: ThermalIsolationInput }
  | { kind: "moisture-response"; input: MoistureResponseInput };

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
  const result = request.kind === "thermal-isolation"
    ? runThermalIsolation(request.input)
    : runMoistureResponse(request.input);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: errorPayload(error) });
}
