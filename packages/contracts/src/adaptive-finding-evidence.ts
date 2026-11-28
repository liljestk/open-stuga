export interface AdaptiveEvidenceRange { lower: number; upper: number }

export interface AdaptiveFindingEvidenceHour {
  hour: string;
  recordedAt: string;
  availableAt: string | null;
  observed: number | null;
  expected: number | null;
  range: AdaptiveEvidenceRange | null;
  coverage: number | null;
  reason: string;
  contextGuard: { reason: "opening-state-change" | "heating-setting-change"; sourceId: string; until: string } | null;
  model: { version: string; evaluatedThrough: string } | null;
}

export interface AdaptiveFindingEvidencePage {
  quantity: "measurement" | "temperature-offset";
  referenceSensorIds: string[];
  availability: "available" | "unavailable";
  items: AdaptiveFindingEvidenceHour[];
  nextBefore: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function date(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function numberOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isRange(value: unknown): boolean {
  return value === null || (object(value) && typeof value.lower === "number" && Number.isFinite(value.lower)
    && typeof value.upper === "number" && Number.isFinite(value.upper) && value.lower <= value.upper);
}

function isGuard(value: unknown): boolean {
  return value === null || (object(value) && ["opening-state-change", "heating-setting-change"].includes(String(value.reason))
    && typeof value.sourceId === "string" && date(value.until));
}

function isHour(value: unknown): value is AdaptiveFindingEvidenceHour {
  if (!object(value)) return false;
  const { coverage, model } = value;
  return date(value.hour) && date(value.recordedAt) && (value.availableAt === null || date(value.availableAt))
    && numberOrNull(value.observed) && numberOrNull(value.expected) && isRange(value.range) && isGuard(value.contextGuard)
    && typeof value.reason === "string" && (coverage === null || (typeof coverage === "number" && coverage >= 0 && coverage <= 1))
    && (model === null || (object(model) && typeof model.version === "string" && date(model.evaluatedThrough)));
}

export function isAdaptiveFindingEvidencePage(value: unknown): value is AdaptiveFindingEvidencePage {
  return object(value) && (value.quantity === "measurement" || value.quantity === "temperature-offset")
    && (value.availability === "available" || value.availability === "unavailable")
    && Array.isArray(value.referenceSensorIds) && value.referenceSensorIds.every((id) => typeof id === "string")
    && Array.isArray(value.items) && value.items.every(isHour) && (value.nextBefore === null || date(value.nextBefore));
}
