import ExcelJS from 'exceljs';

import { BadRequestError } from '../../core/errors.js';
import { normalizeVarKey, type RecipientRow } from '../../domain/campaign.js';

/**
 * Pulling phone numbers out of an uploaded spreadsheet.
 *
 * An operator's number list almost never arrives as a clean column of E.164 -
 * it is an export from somewhere, with a header row, a name column, maybe a
 * notes column, and the phone numbers stored as text in one place and as Excel
 * *numbers* in another. Rather than ask the operator to reshape their file, we
 * scan every cell and keep the ones that LOOK like a phone number.
 *
 * "Looks like a phone number" is deliberately loose here: 10-15 digits, with an
 * optional leading +. That is loose enough to catch a bare 10-digit mobile and a
 * full +91 number, and tight enough to reject the things that share a spreadsheet
 * with them - a 6-digit pincode, a row index, a rent amount, a header like
 * "Phone". The real validation (and the country-code default) happens later, when
 * the campaign is created; this step only has to separate "plausible number" from
 * "everything else". Extracted values are de-duplicated in first-seen order.
 */

/** 10-15 digits, optional leading +. The wide net; campaign creation does the strict E.164 check. */
const PHONE_CANDIDATE = /^\+?\d{10,15}$/;

/** Strip the punctuation a human (or a spreadsheet) puts in a number before testing it. */
function cleaned(value: unknown): string {
  return String(value)
    .trim()
    .replace(/[\s()\-.]/g, '');
}

function collect(value: unknown, seen: Set<string>): void {
  if (value === null || value === undefined) return;
  const candidate = cleaned(value);
  if (PHONE_CANDIDATE.test(candidate)) seen.add(candidate);
}

/** The extensions we can read. `.xls` (legacy binary) is intentionally excluded - it is rare and needs a different parser. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Returns the phone-number-like strings found in the file, de-duplicated, in the
 * order they first appear. Never normalises or validates beyond the loose shape -
 * that is the campaign service's job.
 */
export async function extractRecipientsFromFile(buffer: Buffer, filename: string): Promise<string[]> {
  const ext = extensionOf(filename);
  const seen = new Set<string>();

  if (ext === 'csv' || ext === 'txt') {
    // A CSV is just text: split on the same separators the paste box accepts.
    for (const token of buffer.toString('utf8').split(/[\s,;]+/)) {
      collect(token, seen);
    }
    return [...seen];
  }

  if (ext === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    // exceljs types load() for ArrayBuffer; copy the Buffer's bytes into a clean,
    // exactly-sized ArrayBuffer rather than casting a Node Buffer through `unknown`.
    const bytes = new Uint8Array(buffer);
    await workbook.xlsx.load(bytes.buffer);

    for (const sheet of workbook.worksheets) {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          // Two reads, because they disagree in the cases that matter: `text` is
          // the displayed string (best for a number stored as text like
          // "+919876543210"), while `value` is the raw datum (best for a number
          // stored as an Excel number, which `text` might render in scientific
          // notation on a narrow column). Feeding both, then de-duping, is robust
          // to however the column was formatted.
          collect(cell.text, seen);
          collect(cell.value, seen);
        });
      });
    }

    return [...seen];
  }

  throw new BadRequestError(
    `Cannot read a "${ext || 'unknown'}" file. Upload a .xlsx (Excel) or .csv file — in Excel, "Save As" and pick one of those.`,
  );
}

// ---------------------------------------------------------------------------
// Name + number pairs
// ---------------------------------------------------------------------------

/**
 * Pulling name↔number PAIRS out of an uploaded spreadsheet, for `{name}`
 * personalisation.
 *
 * This is the richer sibling of {@link extractRecipientsFromFile}. Where that one
 * flattens the file to a bag of phone numbers, this one keeps each number tied to
 * the name sitting next to it, so the campaign can send "Hi Sharvesh," to one row
 * and "Hi Bala," to the next.
 *
 * The hard part is that operators' files are not uniform - a header row may or may
 * not be present, the phone column could be anywhere, and the name column has no
 * fixed position either. So rather than trust a layout, we read the whole grid and
 * work out which column is which by looking at the DATA: the column with the most
 * phone-shaped cells is the number column; a "name"-headed column (or, failing
 * that, the most text-heavy other column) is the name column. If nothing lines up
 * as a phone column, we fall back to the loose all-cells scan and return the
 * numbers without names - a personalised send simply degrades to a plain one.
 */
export async function extractRecipientRowsFromFile(buffer: Buffer, filename: string): Promise<RecipientRow[]> {
  const grid = await readGrid(buffer, filename);

  const rows = rowsToRecipients(grid);
  if (rows.length > 0) return rows;

  // No column lined up as phone numbers (an odd layout, or a plain dump of numbers
  // with no structure). Fall back to the battle-tested loose scan, which finds the
  // numbers but not the names.
  const phones = await extractRecipientsFromFile(buffer, filename);
  return phones.map((phone) => ({ phone, name: null }));
}

/** Does this value look like a phone number once its punctuation is stripped? */
function isPhoneCandidate(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return PHONE_CANDIDATE.test(cleaned(value));
}

/** Has letters and is not itself a number - i.e. plausibly a person's name. */
function isNameLike(value: string): boolean {
  return value.trim() !== '' && /\p{L}/u.test(value) && !isPhoneCandidate(value);
}

/** Index of the largest entry; the first on a tie. Returns -1 for an empty array. */
function argmaxIndex(scores: number[]): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i]! > bestScore) {
      bestScore = scores[i]!;
      best = i;
    }
  }
  return best;
}

/**
 * Turn a grid of cell strings into recipient rows by inferring the phone and name
 * columns from the data. De-duplicates by number, first-seen order.
 */
function rowsToRecipients(grid: string[][]): RecipientRow[] {
  if (grid.length === 0) return [];

  const width = gridWidth(grid);
  if (width === 0) return [];

  const phoneCol = inferPhoneColumn(grid, width);
  if (phoneCol === -1) return []; // No numbers anywhere.

  // Which column holds the names? Prefer a header literally called "name"; else the
  // most text-heavy column that isn't the phone column.
  const header = (grid[0] ?? []).map((h) => h.toLowerCase());
  let nameCol = header.findIndex((h, c) => c !== phoneCol && /name/.test(h));
  if (nameCol === -1) {
    const textScore = new Array<number>(width).fill(0);
    for (const row of grid) {
      for (let c = 0; c < width; c += 1) {
        if (c !== phoneCol && isNameLike(row[c] ?? '')) textScore[c] = (textScore[c] ?? 0) + 1;
      }
    }
    nameCol = argmaxIndex(textScore);
    if (nameCol === -1 || textScore[nameCol] === 0) nameCol = -1; // No name column at all.
  }

  const headerPresent = hasHeaderRow(grid, phoneCol);

  const out: RecipientRow[] = [];
  const seen = new Set<string>();
  for (let r = headerPresent ? 1 : 0; r < grid.length; r += 1) {
    const row = grid[r]!;
    const phone = cleaned(row[phoneCol]);
    if (!PHONE_CANDIDATE.test(phone)) continue; // Row without a number in the number column.
    if (seen.has(phone)) continue;
    seen.add(phone);
    const name = nameCol >= 0 ? row[nameCol]?.trim() || null : null;
    out.push({ phone, name });
  }
  return out;
}

/**
 * The best string for one Excel cell: its displayed text, falling back to the raw
 * primitive value. `cell.text` already renders the object-valued cells (rich text,
 * formulas, dates), so the fallback only needs to handle primitives - anything
 * else is left blank rather than stringified to "[object Object]".
 */
function cellString(cell: ExcelJS.Cell): string {
  const text = cell.text;
  if (typeof text === 'string' && text.trim() !== '') return text.trim();

  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** Read the first worksheet into a dense grid of cell strings (row-major, 0-indexed columns). */
async function parseXlsxGrid(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  const bytes = new Uint8Array(buffer);
  await workbook.xlsx.load(bytes.buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellString(cell);
    });
    grid.push(Array.from(cells, (c) => c ?? ''));
  });
  return grid;
}

/**
 * Split delimited text (CSV/TSV) into a grid. Fields are separated by comma,
 * semicolon or tab - NOT whitespace, because a name like "John Smith" must stay in
 * one cell. Surrounding quotes are trimmed.
 */
function parseDelimitedGrid(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.split(/[,;\t]/).map((field) =>
        field
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .trim(),
      ),
    );
}

// ---------------------------------------------------------------------------
// Reading the whole sheet - every column, for multi-variable templates
// ---------------------------------------------------------------------------

/**
 * The full uploaded table, so a campaign body can merge in ANY number of columns.
 *
 * {@link extractRecipientRowsFromFile} answers one fixed question - "which number,
 * and whose name?" - and that was enough while `{name}` was the only variable. It
 * is not enough for "Hi {name}, your rent of {amount} is due on {due_date}": the
 * sheet now carries as many columns as the operator wants to merge, and only they
 * know which column feeds which placeholder.
 *
 * So this parser does NOT decide. It reads the sheet as it is - headers, sample
 * values, and every data row - guesses which column holds the phone numbers and
 * what each header would be called as a variable, and hands the whole thing back
 * for the operator to confirm in the panel. Mapping is a decision with the
 * operator's fingerprints on it, because getting it wrong texts a thousand people
 * the wrong figure.
 */

/** How many columns we will describe. Well past any real contact sheet; a guard against a 500-column export. */
const MAX_COLUMNS = 50;

export interface RecipientColumn {
  /** 0-based position in the sheet. The panel sends this back as the column it mapped. */
  index: number;
  /** The header cell as written ("Due Date"), or "Column C" when the sheet has no header row. */
  header: string;
  /** Suggested variable key for the body: the header, normalised ("due_date"). Unique within the table. */
  key: string;
  /** Our guess. `phone` for the inferred number column, `variable` for everything else. */
  role: 'phone' | 'variable';
  /** The first non-empty value under this header, so the panel can show the operator real data. */
  sample: string | null;
}

export interface RecipientTable {
  columns: RecipientColumn[];
  /** Data rows only - the header row, if there was one, is gone. Each row is aligned to `columns`. */
  rows: string[][];
  /** Whether the first row of the file was read as headers. */
  headerPresent: boolean;
  /** Index into `columns` of the inferred phone column, or -1 when nothing looked like numbers. */
  phoneColumn: number;
  /** Rows dropped because their phone cell held no number (a footer, a spacer, a total). */
  skipped: number;
  /** True when the sheet had more rows than `maxRows` and the tail was not returned. */
  truncated: boolean;
}

/** The widest row in the grid - the column count the table is squared off to. */
function gridWidth(grid: string[][]): number {
  return grid.reduce((max, row) => Math.max(max, row.length), 0);
}

/**
 * Which column holds the phone numbers? The one with the most phone-shaped cells.
 * Returns -1 when no column has any - an odd layout, or a file of something else
 * entirely.
 */
function inferPhoneColumn(grid: string[][], width: number): number {
  const score = new Array<number>(width).fill(0);
  for (const row of grid) {
    for (let c = 0; c < width; c += 1) {
      if (isPhoneCandidate(row[c])) score[c] = (score[c] ?? 0) + 1;
    }
  }
  const best = argmaxIndex(score);
  return best === -1 || score[best] === 0 ? -1 : best;
}

/**
 * Is the first row headers?
 *
 * With a known phone column the test is exact: the header says "Phone", the data
 * below says "9876543210", so a first row whose phone cell is NOT a number is a
 * header. Without one, fall back to "the first row is all words, no numbers",
 * which is what a header row looks like.
 */
function hasHeaderRow(grid: string[][], phoneCol: number): boolean {
  const first = grid[0];
  if (!first) return false;
  if (phoneCol >= 0) return !isPhoneCandidate(first[phoneCol]);
  return first.some((cell) => cell.trim() !== '') && !first.some(isPhoneCandidate);
}

/** Read an uploaded file into a grid of cell strings, or reject the format. */
async function readGrid(buffer: Buffer, filename: string): Promise<string[][]> {
  const ext = extensionOf(filename);
  if (ext === 'csv' || ext === 'txt') return parseDelimitedGrid(buffer.toString('utf8'));
  if (ext === 'xlsx') return parseXlsxGrid(buffer);

  throw new BadRequestError(
    `Cannot read a "${ext || 'unknown'}" file. Upload a .xlsx (Excel) or .csv file — in Excel, "Save As" and pick one of those.`,
  );
}

/** "Column A", "Column B", ... "Column AA" - the label for a sheet with no header row. */
function columnLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Column ${label}`;
}

/**
 * Read the uploaded file as a table: what the columns are, what they look like,
 * and every data row.
 *
 * `maxRows` caps what comes back - the whole table crosses the wire to the panel,
 * and a spreadsheet may hold far more rows than a campaign is allowed to target.
 * When it bites, `truncated` says so rather than the operator silently losing the
 * tail of their list.
 */
export async function extractRecipientTableFromFile(
  buffer: Buffer,
  filename: string,
  options: { maxRows?: number } = {},
): Promise<RecipientTable> {
  const maxRows = options.maxRows ?? 100_000;
  const grid = await readGrid(buffer, filename);

  const width = Math.min(gridWidth(grid), MAX_COLUMNS);
  if (width === 0) {
    return { columns: [], rows: [], headerPresent: false, phoneColumn: -1, skipped: 0, truncated: false };
  }

  const phoneColumn = inferPhoneColumn(grid, width);
  const headerPresent = hasHeaderRow(grid, phoneColumn);
  const headerRow = headerPresent ? (grid[0] ?? []) : [];

  // Data rows: everything below the header that has a usable number in the phone
  // column. A row with no number is a footer or a spacer, not a recipient - counted
  // as skipped so the panel can say "3 rows had no number" instead of quietly
  // shrinking the list. With no phone column at all we keep every non-empty row and
  // let the operator map one themselves.
  const rows: string[][] = [];
  let skipped = 0;
  let truncated = false;

  for (let r = headerPresent ? 1 : 0; r < grid.length; r += 1) {
    const source = grid[r] ?? [];
    const row = Array.from({ length: width }, (_, c) => (source[c] ?? '').trim());
    if (row.every((cell) => cell === '')) continue;

    if (phoneColumn >= 0 && !isPhoneCandidate(row[phoneColumn])) {
      skipped += 1;
      continue;
    }

    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row);
  }

  // Column descriptions. Keys are made unique because two columns headed "Name"
  // would otherwise both claim `{name}` and the second would silently win.
  const usedKeys = new Set<string>();
  const columns: RecipientColumn[] = [];

  for (let c = 0; c < width; c += 1) {
    const header = headerPresent ? (headerRow[c] ?? '').trim() || columnLabel(c) : columnLabel(c);

    let key = normalizeVarKey(header) || `column_${c + 1}`;
    if (usedKeys.has(key)) {
      let suffix = 2;
      while (usedKeys.has(`${key}_${suffix}`)) suffix += 1;
      key = `${key}_${suffix}`;
    }
    usedKeys.add(key);

    const sample = rows.find((row) => (row[c] ?? '') !== '')?.[c] ?? null;

    columns.push({
      index: c,
      header,
      key,
      role: c === phoneColumn ? 'phone' : 'variable',
      sample,
    });
  }

  return { columns, rows, headerPresent, phoneColumn, skipped, truncated };
}
