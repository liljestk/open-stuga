import type {
  AnalyticsQueryResponse,
  MeasurementDefinition,
  Sensor,
  UnitSystem,
} from "@climate-twin/contracts";
import { strToU8, zipSync } from "fflate";
import { displayUnit, measurementLabel, toDisplayValue } from "./measurements";
import { compareCodeUnits } from "./textOrder";

export interface SensorExportLabels {
  localTime: string;
  utcTime: string;
  sensorName: string;
  sensorId: string;
}

export interface SensorExportColumn {
  id: string;
  label: string;
  unit: string;
  precision: number;
}

export interface SensorExportRow {
  timestamp: string;
  localTimestamp: string;
  sensorId: string;
  sensorName: string;
  values: Record<string, number | null>;
}

export interface SensorExportTable {
  labels: SensorExportLabels;
  columns: SensorExportColumn[];
  rows: SensorExportRow[];
  generatedAt: string;
  range: AnalyticsQueryResponse["resolvedRange"];
  resolution: AnalyticsQueryResponse["resolution"];
  aggregation: string;
}

function rounded(value: number, precision: number): number {
  const factor = 10 ** Math.min(6, Math.max(0, precision));
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function localTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
}

function localTimestamp(value: string, formatter: Intl.DateTimeFormat): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const zone = part("timeZoneName");
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}${zone ? ` ${zone}` : ""}`;
}

export function buildSensorExportTable(input: {
  result: AnalyticsQueryResponse;
  sensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  locale: string;
  units: UnitSystem;
  labels: SensorExportLabels;
}): SensorExportTable {
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const columns = input.definitions.map((definition) => ({
    id: definition.id,
    label: measurementLabel(definition, input.locale),
    unit: displayUnit(definition, input.units),
    precision: definition.precision,
  }));
  const sensors = new Map(input.sensors.map((sensor) => [sensor.id, sensor]));
  const sensorOrder = new Map(input.sensors.map((sensor, index) => [sensor.id, index]));
  const formatter = localTimestampFormatter(input.result.resolvedRange.timezone);
  const rows = new Map<string, SensorExportRow>();

  for (const series of input.result.series) {
    const sensor = sensors.get(series.entityId);
    const definition = definitions.get(series.measurementId);
    if (!sensor || !definition) continue;
    for (const point of series.points) {
      const key = JSON.stringify([series.entityId, point.timestamp]);
      let row = rows.get(key);
      if (!row) {
        row = {
          timestamp: point.timestamp,
          localTimestamp: localTimestamp(point.timestamp, formatter),
          sensorId: sensor.id,
          sensorName: sensor.name,
          values: {},
        };
        rows.set(key, row);
      }
      row.values[series.measurementId] = point.value === null
        ? null
        : rounded(toDisplayValue(point.value, definition, input.units), definition.precision);
    }
  }

  return {
    labels: input.labels,
    columns,
    rows: [...rows.values()].sort((left, right) => (
      Date.parse(left.timestamp) - Date.parse(right.timestamp)
      || (sensorOrder.get(left.sensorId) ?? 0) - (sensorOrder.get(right.sensorId) ?? 0)
      || left.sensorName.localeCompare(right.sensorName)
    )),
    generatedAt: input.result.generatedAt,
    range: input.result.resolvedRange,
    resolution: input.result.resolution,
    aggregation: input.result.series[0]?.aggregation ?? "raw",
  };
}

function safeCsvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  const formulaSafe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

function columnHeading(column: SensorExportColumn): string {
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

export function sensorExportCsv(table: SensorExportTable): string {
  const rows: Array<Array<string | number | null>> = [[
    table.labels.localTime,
    table.labels.utcTime,
    table.labels.sensorName,
    table.labels.sensorId,
    ...table.columns.map(columnHeading),
  ]];
  for (const row of table.rows) {
    rows.push([
      row.localTimestamp,
      row.timestamp,
      row.sensorName,
      row.sensorId,
      ...table.columns.map((column) => row.values[column.id] ?? null),
    ]);
  }
  return `${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`;
}

function cleanXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function excelColumn(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function inlineCell(reference: string, value: string, style = 0): string {
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${cleanXml(value)}</t></is></c>`;
}

function numericCell(reference: string, value: number | null, precision: number): string {
  if (value === null) return `<c r="${reference}"/>`;
  const style = precision <= 0 ? 2 : precision === 1 ? 3 : precision === 2 ? 4 : 5;
  return `<c r="${reference}" s="${style}"><v>${Number.isFinite(value) ? value : 0}</v></c>`;
}

function worksheetXml(table: SensorExportTable): string {
  const headers = [
    table.labels.localTime,
    table.labels.utcTime,
    table.labels.sensorName,
    table.labels.sensorId,
    ...table.columns.map(columnHeading),
  ];
  const lastColumn = excelColumn(headers.length - 1);
  const lastRow = Math.max(1, table.rows.length + 1);
  const widths = headers.map((header, index) => {
    const width = index < 2 ? 27 : index < 4 ? 23 : Math.min(30, Math.max(14, header.length + 3));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const header = headers.map((value, index) => inlineCell(`${excelColumn(index)}1`, value, 1)).join("");
  const rows = table.rows.map((row, rowIndex) => {
    const number = rowIndex + 2;
    const cells = [
      inlineCell(`A${number}`, row.localTimestamp),
      inlineCell(`B${number}`, row.timestamp),
      inlineCell(`C${number}`, row.sensorName),
      inlineCell(`D${number}`, row.sensorId),
      ...table.columns.map((column, columnIndex) => numericCell(
        `${excelColumn(columnIndex + 4)}${number}`,
        row.values[column.id] ?? null,
        column.precision,
      )),
    ];
    return `<row r="${number}">${cells.join("")}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${widths}</cols>
  <sheetData><row r="1" ht="24" customHeight="1">${header}</row>${rows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts>
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F5F92"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

function safeSheetName(value: string): string {
  const cleaned = value.replace(/[\\/*?:[\]]/gu, " ").trim();
  return (cleaned || "Sensor data").slice(0, 31);
}

export function sensorExportXlsx(table: SensorExportTable, requestedSheetName: string): Uint8Array {
  const sheetName = safeSheetName(requestedSheetName);
  const generatedAt = Number.isFinite(Date.parse(table.generatedAt)) ? table.generatedAt : new Date().toISOString();
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Stugu</dc:creator><cp:lastModifiedBy>Stugu</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${cleanXml(generatedAt)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${cleanXml(generatedAt)}</dcterms:modified></cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Stugu</Application><AppVersion>1.0</AppVersion></Properties>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${cleanXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(stylesXml),
    "xl/worksheets/sheet1.xml": strToU8(worksheetXml(table)),
  };
  return zipSync(files, { level: 6 });
}

export function mergeAnalyticsResponses(responses: readonly AnalyticsQueryResponse[], requestId: string): AnalyticsQueryResponse {
  const first = responses[0];
  if (!first) throw new Error("No analytics responses were returned");
  const series = responses.flatMap((response) => response.series);
  const summaries = responses.flatMap((response) => response.summaries);
  const coverage = summaries.length > 0
    ? summaries.reduce((sum, summary) => sum + summary.coverage, 0) / summaries.length
    : 0;
  const warnings = [...new Map(responses.flatMap((response) => response.warnings)
    .map((warning) => [`${warning.code}\u0000${warning.message}`, warning])).values()];
  return {
    ...first,
    requestId,
    series,
    summaries,
    quality: {
      coverage,
      seriesCount: series.length,
      sampleCount: summaries.reduce((sum, summary) => sum + summary.count, 0),
      excludedSampleCount: responses.reduce((sum, response) => sum + response.quality.excludedSampleCount, 0),
      includedQualities: [...new Set(responses.flatMap((response) => response.quality.includedQualities))],
      lowCoverageSeries: summaries.filter((summary) => summary.coverage < 0.75).length,
    },
    provenance: responses.flatMap((response) => response.provenance),
    warnings,
    generatedAt: responses.map((response) => response.generatedAt).sort(compareCodeUnits).at(-1) ?? first.generatedAt,
  };
}
