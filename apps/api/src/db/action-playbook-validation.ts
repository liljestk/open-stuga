import type { ActionPlaybookInput } from "@climate-twin/contracts";
import { ClimateDataValidationError } from "./support/03-sensor-data-gap-row-to-canonical-json-value.js";

/** Validate the merged record, so partial updates cannot evade cross-field checks. */
export function validateActionPlaybook(input: ActionPlaybookInput): void {
  const ranges = [
    ["minimumImprovement", input.minimumImprovement, 0, Number.MAX_VALUE],
    ["waitSeconds", input.waitSeconds, 0, 604_800],
    ["verificationWindowSeconds", input.verificationWindowSeconds, 60, 2_592_000],
  ] as const;
  for (const [field, value, minimum, maximum] of ranges) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", `${field} must be between ${minimum} and ${maximum}`);
    }
  }
  if (input.targetValue !== null && !Number.isFinite(input.targetValue)
    || (input.goal === "below" || input.goal === "above") && input.targetValue === null) {
    throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "below and above goals require a finite targetValue");
  }
}
