/** Clip legacy overlapping prices without scanning the whole price timeline. */
export const SQLITE_EFFECTIVE_PRICE_END = `MIN(price.end_at, COALESCE((
  SELECT following.start_at FROM electricity_price_points AS following
  WHERE following.property_id = price.property_id AND following.start_at > price.start_at
  ORDER BY following.start_at LIMIT 1
), price.end_at))`;

/**
 * Only the latest price at the interval start, and prices starting inside the
 * interval, can overlap it after next-price clipping. Seek that predecessor,
 * then range-scan the existing (property_id, start_at) primary-key index.
 * CROSS JOIN keeps normalized intervals outside the indexed price loop; a
 * materialized full-price window otherwise produces a synchronous N x M scan.
 * Both placeholders bind the same Property ID.
 */
export function sqlitePriceOverlapSql(basis: "energy" | "power"): string {
  const start = basis === "energy" ? "normalized.window_start" : "normalized.window_start_at";
  const end = basis === "energy" ? "normalized.current_at" : "normalized.window_end_at";
  return `FROM normalized CROSS JOIN electricity_price_points AS price
    WHERE price.property_id = ?
      AND price.start_at >= COALESCE((
        SELECT boundary.start_at FROM electricity_price_points AS boundary
        WHERE boundary.property_id = ? AND boundary.start_at <= ${start}
        ORDER BY boundary.start_at DESC LIMIT 1
      ), ${start})
      AND price.start_at < ${end}
      AND price.end_at > ${start}`;
}
