import { ApiRequestError, UserFacingError } from "./api/support/request-error";
import type { TranslationKey } from "./i18n";

/** API failures every panel explains the same way, by HTTP status. */
const STATUS_TEXT: ReadonlyMap<number, TranslationKey> = new Map([
  [401, "requestErrors.signInRequired"],
  [403, "requestErrors.forbidden"],
  [429, "requestErrors.rateLimited"],
  [503, "requestErrors.unavailable"],
]);

/**
 * Text for a failed action in the viewer's language. The server's and the data
 * layer's English messages never reach the UI: a status every panel explains the
 * same way gets its shared text, a UserFacingError keeps its translated message,
 * and anything else shows the caller's fallback.
 */
export function errorText(error: unknown, t: (key: TranslationKey) => string, fallback: string): string {
  if (error instanceof UserFacingError) return error.message;
  const key = error instanceof ApiRequestError ? STATUS_TEXT.get(error.status) : undefined;
  return key ? t(key) : fallback;
}
