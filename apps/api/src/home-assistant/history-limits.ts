import type { MeasurementSample } from "@climate-twin/contracts";
import { HA_HISTORY_CHUNK_MS } from "./support/01-home-assistant-measurement-binding-to-validate-entit.js";

export const HA_HISTORY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const HA_HISTORY_MAX_CHUNKS = 30;
export const HA_HISTORY_MAX_SAMPLES = 100_000;

export class HomeAssistantHistoryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeAssistantHistoryLimitError";
  }
}

function boundedTestLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

export function assertHomeAssistantHistoryChunkLimit(startMs: number, endMs: number): void {
  const chunks = Math.ceil((endMs - startMs) / HA_HISTORY_CHUNK_MS);
  if (chunks > HA_HISTORY_MAX_CHUNKS) {
    throw new HomeAssistantHistoryLimitError(
      `Home Assistant history recovery exceeds the ${HA_HISTORY_MAX_CHUNKS}-chunk (30-day) limit`,
    );
  }
}

export async function boundedHomeAssistantHistoryJson(
  response: Response,
  maximumBytes?: number,
): Promise<unknown> {
  const limit = boundedTestLimit(maximumBytes, HA_HISTORY_MAX_RESPONSE_BYTES);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new HomeAssistantHistoryLimitError(
      `Home Assistant history response exceeds the ${limit}-byte limit`,
    );
  }
  if (!response.body) throw new Error("Home Assistant history returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HomeAssistantHistoryLimitError(
        `Home Assistant history response exceeds the ${limit}-byte limit`,
      );
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Home Assistant history returned invalid JSON");
  }
}

export function storeBoundedHomeAssistantHistorySample(
  samples: Map<string, MeasurementSample>,
  sample: MeasurementSample,
  maximumSamples?: number,
): void {
  const limit = boundedTestLimit(maximumSamples, HA_HISTORY_MAX_SAMPLES);
  if (!samples.has(sample.timestamp) && samples.size >= limit) {
    throw new HomeAssistantHistoryLimitError(
      `Home Assistant history recovery exceeds the ${limit}-sample limit`,
    );
  }
  samples.set(sample.timestamp, sample);
}
