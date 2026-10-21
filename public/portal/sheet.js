// Reads a client's sample sheet, pasted from Excel, uploaded as .csv, or an .xlsx the server read, into sample rows.
// Every source becomes a Grid (string[][] of display text, row 0 maybe headings). A Mapping says what each column
// means; the client can change it before readSheet applies it. Pure functions with no imports, so the portal, the
// lab and the tests load the same module.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-.#:/*]+/g, ' ').trim();

/**
 * Every sample field a sheet column may fill: the label shown for it, the headings clients give it and, for a pick
 * list, what clients write for each value. `noun` names a pick list in a problem message.
 */
export const FIELDS = {
  description: { label: 'Sample description', aliases: ['product name', 'name', 'description', 'sample', 'sample name', 'sample description'] },
  product_code: { label: 'Product code', aliases: ['product code', 'code', 'item code', 'sku'] },
  batch_no: { label: 'Lot number', aliases: ['lot', 'lot no', 'lot number', 'batch', 'batch no', 'batch number'] },
  stage: {
    label: 'Type',
    aliases: ['status', 'stage', 'type', 'sample type', 'type (fp ip rm r&d, stab condition)'],
    noun: 'stage',
    values: {
      Stability: ['stability', 'stab'],
      'R&D': ['r&d', 'rd', 'r and d', 'r & d', 'research'],
      'Finished product': ['finished product', 'fp', 'finished'],
      Initial: ['initial', 'init'],
      'Bulk hold': ['bulk hold', 'bulk'],
      Other: ['other'],
    },
  },
  priority: {
    label: 'TAT',
    aliases: ['urgency', 'priority', 'tat', 'turnaround'],
    noun: 'turnaround',
    values: {
      'Same day': ['same day', 'today', '0 days', '0'],
      'Next day': ['next day', '1 day', '24h', '24 h', '24 hours', '1'],
      '3 days': ['3 days', '3d', '3 day', 'three days', '3'],
      'One week': ['one week', '1 week', '7 days', 'week', '5 days', '5', '7'],
    },
  },
  tests_requested: { label: 'Tests requested', aliases: ['test requested', 'tests requested', 'test', 'tests'] },
  limits: { label: 'Limits', aliases: ['limits', 'limit', 'specification', 'specification limits', 'spec', 'specs'] },
  quantity: { label: 'Quantity', aliases: ['quantity', 'qty', 'count'] },
  client_ref: { label: 'Your reference', aliases: ['your ref', 'your reference', 'client ref', 'client reference', 'customer ref', 'reference'] },
  container: { label: 'Container', aliases: ['container', 'packaging'] },
};

// Each list is in the column order assumed when a sheet has no heading row: the portal's is the client's own sheet (Limits,
// added later, comes last so sheets pasted without headings keep their columns), the lab's is the order its paste box always took.
export const PORTAL_FIELDS = ['product_code', 'description', 'batch_no', 'stage', 'priority', 'tests_requested', 'quantity', 'client_ref', 'container', 'limits'];
export const LAB_FIELDS = ['description', 'batch_no', 'client_ref', 'quantity', 'container', 'product_code', 'stage'];

const FIELD_FOR_HEADER = new Map(Object.entries(FIELDS).flatMap(([field, f]) => f.aliases.map((n) => [n, field])));
// The row-number column ("No.", "#") of a client's log: it numbers the rows and is not a detail of any sample.
const isRowNumber = (heading) => String(heading).trim() === '#' || ['no', 'item', 'item no'].includes(norm(heading));
const VALUE_FOR = Object.fromEntries(Object.entries(FIELDS).filter(([, f]) => f.values).map(([field, f]) => [
  field, new Map(Object.entries(f.values).flatMap(([value, names]) => [value, ...names].map((n) => [norm(n), value]))),
]));

const tokenize = (src, delimiter) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
};

// European Excel saves "CSV" with semicolons, and a tab-separated file saved as .csv turns up too.
const sniffDelimiter = (src) => {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of src) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '\n') break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
};

/**
 * A Grid from text. `kind` 'paste' is Excel's clipboard: tab-separated, so a name like "Aspirin, 100 mg" stays one
 * cell. 'csv' is a file: comma, semicolon or tab, whichever its first line uses most. Quoted cells may hold
 * delimiters, line breaks and doubled quotes. Cells are trimmed and empty rows dropped.
 */
export function gridFromText(text, kind) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const grid = tokenize(src, kind === 'csv' ? sniffDelimiter(src) : '\t');
  return grid.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

// A client's sheet may carry more of its own headings than ours, so the first row is headings when it names more of
// ours than the next row does, not when most of its cells are ours.
const knownHeadings = (cells = []) => cells.filter((c) => FIELD_FOR_HEADER.has(norm(c))).length;
const isHeader = (grid) => knownHeadings(grid[0]) > knownHeadings(grid[1]);

const columnName = (i) => `Column ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`;
const widthOf = (grid) => Math.max(0, ...grid.map((r) => r.length));
const labelsOf = (grid, header) => Array.from({ length: widthOf(grid) }, (_, i) => (header && grid[0][i]) || columnName(i));

/**
 * Mapping: { header, columns: [{ label, use }] }, one column per grid column. `use` is a field key from `fields`,
 * 'extra' (kept as detail on each sample) or 'ignore'; no field is used twice. With headings, each known heading
 * fills its field and any other column is extra. Without, columns follow the order of `fields`. A one-column sheet
 * is never read as having headings, so a first sample called "Code" is not lost; the client can say otherwise.
 */
export function guessMapping(grid, fields) {
  const width = widthOf(grid);
  const header = width > 1 && isHeader(grid);
  const order = width === 1 ? ['description'] : fields;
  const taken = new Set();
  const columns = labelsOf(grid, header).map((label, i) => {
    if (!grid.slice(header ? 1 : 0).some((r) => r[i]) || (header && isRowNumber(grid[0][i]))) return { label, use: 'ignore' };
    const field = header ? FIELD_FOR_HEADER.get(norm(grid[0][i])) : order[i];
    const use = field && fields.includes(field) && !taken.has(field) ? field : 'extra';
    taken.add(use);
    return { label, use };
  });
  return { header, columns };
}

/** Gives column `col` the use `use`. A field another column had moves off it to 'extra', so nothing is dropped. */
export function remap(mapping, col, use) {
  const field = use !== 'extra' && use !== 'ignore';
  return {
    ...mapping,
    columns: mapping.columns.map((c, i) => (i === col ? { ...c, use } : field && c.use === use ? { ...c, use: 'extra' } : c)),
  };
}

/** Says whether the grid's first row is headings: the columns are relabelled and keep their uses. */
export function withHeader(grid, mapping, header) {
  const labels = labelsOf(grid, header);
  return { header, columns: mapping.columns.map((c, i) => ({ ...c, label: labels[i] })) };
}

/** What is left of a sheet once its first `n` sample rows are taken, headings kept. */
export function dropRows(grid, mapping, n) {
  return mapping.header ? [grid[0], ...grid.slice(1 + n)] : grid.slice(n);
}

/**
 * Reads the grid's sample rows through the mapping. Each row holds its fields, `details` ([{ label, value }] from the
 * extra columns, empty cells left out) and `problems`, a message per field the client has to fix.
 */
export function readSheet(grid, mapping) {
  const rows = grid.slice(mapping.header ? 1 : 0).map((cells) => {
    const row = { problems: {}, details: [] };
    mapping.columns.forEach(({ label, use }, i) => {
      const cell = cells[i];
      if (!cell || use === 'ignore') return;
      if (use === 'extra') row.details.push({ label, value: cell });
      else row[use] = cell.replace(/\s*\n\s*/g, ' ');
    });
    for (const field of Object.keys(VALUE_FOR)) {
      if (!row[field]) continue;
      const value = VALUE_FOR[field].get(norm(row[field]));
      if (value) row[field] = value;
      else {
        row.problems[field] = `"${row[field]}" is not a ${FIELDS[field].noun} we know. Use ${Object.keys(FIELDS[field].values).join(', ')}.`;
        row[field] = null;
      }
    }
    if (!row.description) row.problems.description = 'Every sample needs a name.';
    return row;
  });
  return { rows };
}
