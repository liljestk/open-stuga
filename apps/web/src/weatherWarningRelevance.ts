import type { WeatherWarning } from "@climate-twin/contracts";

// FMI's CAP feed also contains advisories for personal exposure and travel.
// Those records remain available in the weather API, but they do not belong in
// house-condition, maintenance, or property-risk surfaces.
const NON_PROPERTY_WARNING_PATTERNS = [
  /\buv\b/i,
  /ultraviolet/i,
  /\bpedestrian(?:s)?\b/i,
  /\broad weather\b/i,
  /\btraffic weather\b/i,
] as const;

/**
 * Return whether an official warning has a plausible impact on a home or its
 * maintenance. Unknown warning categories stay visible so a new hazard cannot
 * be hidden merely because the upstream provider introduced new wording.
 */
export function isHomeRelevantWeatherWarning(warning: WeatherWarning): boolean {
  const categoryText = `${warning.event} ${warning.headline}`;
  return !NON_PROPERTY_WARNING_PATTERNS.some((pattern) => pattern.test(categoryText));
}

export function homeRelevantWeatherWarnings(
  warnings: readonly WeatherWarning[],
): WeatherWarning[] {
  return warnings.filter(isHomeRelevantWeatherWarning);
}
