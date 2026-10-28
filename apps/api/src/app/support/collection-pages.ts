import { HttpError } from "../../http-error.js";
import { boundedQueryInteger } from "./query-fields.js";

export function collectionPage(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: boundedQueryInteger(query.limit, "limit", 1, 500) ?? 500,
    offset: boundedQueryInteger(query.offset, "offset", 0, 1_000_000) ?? 0,
  };
}

export function visibleCollectionPage<T>(
  load: (limit: number, offset: number) => T[],
  visible: (item: T) => boolean,
  page: { limit: number; offset: number },
): T[] {
  const result: T[] = [];
  let rawOffset = 0;
  let visibleOffset = 0;
  for (;;) {
    const batch = load(500, rawOffset);
    for (const item of batch) {
      if (!visible(item)) continue;
      if (visibleOffset < page.offset) {
        visibleOffset += 1;
        continue;
      }
      result.push(item);
      if (result.length >= page.limit) return result;
    }
    if (batch.length < 500) return result;
    rawOffset += batch.length;
  }
}

export function completeVisibleCollection<T>(
  load: (limit: number, offset: number) => T[],
  visible: (item: T) => boolean,
  maximum = 10_000,
): T[] {
  const result: T[] = [];
  let rawOffset = 0;
  for (;;) {
    const batch = load(500, rawOffset);
    for (const item of batch) {
      if (!visible(item)) continue;
      result.push(item);
      if (result.length > maximum) {
        throw new HttpError(
          413,
          "COLLECTION_TOO_LARGE",
          `This collection contains more than ${maximum} visible records`,
        );
      }
    }
    if (batch.length < 500) return result;
    rawOffset += batch.length;
  }
}
