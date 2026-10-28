import type { MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import type { Locale } from "../i18n";
import { type HistoricalImportMapping, type ImportCell, type ImportMode, type ImportSheet, type InputUnit, METRIC_ALIASES, SENSOR_ALIASES, TIMESTAMP_ALIASES, UNIT_ALIASES, VALUE_ALIASES, isBlank, normalizeImportToken } from "./importModel";

export function aliasScore(value: ImportCell | undefined, aliases: string[]): number {
  const normalized = normalizeImportToken(value);
  if (!normalized) return 0;
  if (aliases.includes(normalized)) return 5;
  return aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized)) ? 2 : 0;
}

export function detectHeaderRow(rows: ImportCell[][]): number {
  let best = { index: 0, score: -Infinity };
  rows.slice(0, 20).forEach((row, index) => {
    const populated = row.filter((cell) => !isBlank(cell));
    const strings = populated.filter((cell) => typeof cell === "string").length;
    const aliases = populated.reduce<number>((score, cell) => score
      + Math.max(aliasScore(cell, TIMESTAMP_ALIASES), aliasScore(cell, SENSOR_ALIASES), aliasScore(cell, METRIC_ALIASES), aliasScore(cell, VALUE_ALIASES)), 0);
    const score = populated.length + strings * 2 + aliases * 4 - index * 0.1;
    if (populated.length >= 2 && score > best.score) best = { index, score };
  });
  return best.index;
}

export function columnLabels(sheet: ImportSheet, headerRow: number): string[] {
  const header = sheet.rows[headerRow] ?? [];
  const width = Math.max(header.length, ...sheet.rows.slice(headerRow + 1, headerRow + 21).map((row) => row.length), 0);
  const used = new Map<string, number>();
  return Array.from({ length: width }, (_, column) => {
    const base = String(header[column] ?? "").trim() || `Column ${column + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function findColumn(headers: string[], aliases: string[]): number {
  let best = { column: -1, score: 0 };
  headers.forEach((header, column) => {
    const score = aliasScore(header, aliases);
    if (score > best.score) best = { column, score };
  });
  return best.column;
}

export function metricAliases(definition: MeasurementDefinition): string[] {
  const aliases = [definition.id, ...Object.values(definition.labels)];
  if (definition.id === "temperature") aliases.push("temp", "air temperature", "lampotila");
  if (definition.id === "humidity") aliases.push("rh", "relative humidity", "kosteus", "ilmankosteus");
  if (definition.id === "co2") aliases.push("carbon dioxide", "carbon-dioxide", "hiilidioksidi");
  return aliases.map(normalizeImportToken).filter(Boolean);
}

export function guessMetric(header: string, definitions: MeasurementDefinition[]): MeasurementDefinition | null {
  const token = normalizeImportToken(header.replace(/\b(deg(?:rees?)?|celsius|fahrenheit|kelvin|ppm|percent|pct)\b/gi, ""));
  let best: { definition: MeasurementDefinition; score: number } | null = null;
  for (const definition of definitions) {
    for (const alias of metricAliases(definition)) {
      const score = token === alias ? 10 : token.startsWith(alias) || alias.startsWith(token) ? 6 : token.includes(alias) ? 4 : 0;
      if (score > (best?.score ?? 0)) best = { definition, score };
    }
  }
  return best?.definition ?? null;
}

export function unitFromHeader(header: string, metric: string): InputUnit {
  const normalized = header.toLocaleLowerCase();
  if (metric === "temperature" && (/°\s*f/.test(normalized) || /fahrenheit|deg(?:rees?)?\s*f/.test(normalized))) return "fahrenheit";
  if (metric === "temperature" && (/\bkelvin\b/.test(normalized) || /\(k\)/.test(normalized))) return "kelvin";
  return "canonical";
}

export function createInitialMapping(
  sheet: ImportSheet,
  definitions: MeasurementDefinition[],
  sensors: Sensor[],
  locale: Locale,
  headerRow = detectHeaderRow(sheet.rows),
): HistoricalImportMapping {
  const headers = columnLabels(sheet, headerRow);
  const timestampColumn = Math.max(0, findColumn(headers, TIMESTAMP_ALIASES));
  const sensor = findColumn(headers, SENSOR_ALIASES);
  const metric = findColumn(headers, METRIC_ALIASES);
  const value = findColumn(headers, VALUE_ALIASES);
  const unit = findColumn(headers, UNIT_ALIASES);
  const mode: ImportMode = metric >= 0 && value >= 0 ? "long" : "wide";
  const excluded = new Set([timestampColumn, sensor]);
  const wideColumns = headers.flatMap((header, column) => {
    if (excluded.has(column)) return [];
    const definition = guessMetric(header, definitions);
    return definition ? [{ column, metric: definition.id, inputUnit: unitFromHeader(header, definition.id) }] : [];
  });
  return {
    headerRow,
    mode,
    timestampColumn,
    sensorColumn: sensor >= 0 ? sensor : null,
    fallbackSensorId: sensors[0]?.id ?? "",
    dateOrder: locale === "en" ? "auto" : "dmy",
    wideColumns,
    longMetricColumn: metric >= 0 ? metric : null,
    longFixedMetric: definitions[0]?.id ?? "",
    longValueColumn: value >= 0 ? value : Math.min(1, Math.max(0, headers.length - 1)),
    longUnitColumn: unit >= 0 ? unit : null,
  };
}
