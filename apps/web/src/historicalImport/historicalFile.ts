import { type ImportCell, type ImportSheet, MAX_FILE_BYTES, MAX_IMPORT_CELLS, MAX_IMPORT_ROWS, importSizeError, isBlank, validateImportSheet } from "./importModel";
import { parseCsv, readFileText } from "./delimitedText";
import { validateXlsxArchive } from "./xlsxArchive";

export async function readHistoricalFile(file: File): Promise<ImportSheet[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose a file smaller than 25 MB.");
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return [parseCsv(await readFileText(file), file.name)];
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an Excel .xlsx, CSV, or TSV file.");
  const buffer = await file.arrayBuffer();
  await validateXlsxArchive(buffer);
  const { default: readExcelFile } = await import("read-excel-file/browser");
  const sheets = await readExcelFile(buffer);
  const usable = sheets
    .map((sheet) => ({ name: sheet.sheet, rows: sheet.data as ImportCell[][] }))
    .filter((sheet) => sheet.rows.some((row) => row.some((cell) => !isBlank(cell))));
  if (!usable.length) throw new Error("This workbook does not contain any data rows.");
  let workbookCells = 0;
  let workbookRows = 0;
  for (const sheet of usable) {
    validateImportSheet(sheet);
    workbookRows += sheet.rows.length;
    for (const row of sheet.rows) workbookCells += row.length;
    if (workbookRows > MAX_IMPORT_ROWS || workbookCells > MAX_IMPORT_CELLS) throw importSizeError();
  }
  return usable;
}
