// Reads rows a client copies out of Excel or Google Sheets into sample rows. Pure functions with no imports, so the
// portal and the tests load the same module.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-.#:/]+/g, ' ').trim();

/** Each sample field and the header names a client's sheet may give it. */
export const COLUMNS = {
  description: ['product name', 'name', 'description', 'sample', 'sample name'],
  product_code: ['product code', 'code', 'item code', 'sku'],
  batch_no: ['lot', 'lot no', 'lot number', 'batch', 'batch no', 'batch number'],
  stage: ['status', 'stage'],
  priority: ['urgency', 'priority', 'tat', 'turnaround'],
  test: ['test requested', 'tests requested', 'test', 'tests'],
  quantity: ['quantity', 'qty', 'count'],
};

/** Column order assumed when the paste has no header row: the client's own sheet. */
export const DEFAULT_ORDER = ['product_code', 'description', 'batch_no', 'stage', 'priority', 'test', 'quantity'];

/** What clients write for each stage and turnaround tier, beyond the names themselves. */
export const VALUE_ALIASES = {
  stage: {
    Stability: ['stability', 'stab'],
    'R&D': ['r&d', 'rd', 'r and d', 'r & d', 'research'],
    'Finished product': ['finished product', 'fp', 'finished'],
    Initial: ['initial', 'init'],
    'Bulk hold': ['bulk hold', 'bulk'],
    Other: ['other'],
  },
  priority: {
    'Same day': ['same day', 'today', '0 days'],
    'Next day': ['next day', '1 day', '24h', '24 h', '24 hours'],
    '3 days': ['3 days', '3d', '3 day', 'three days'],
    'One week': ['one week', '1 week', '7 days', 'week', '5 days'],
  },
};

const FIELD_FOR_HEADER = new Map(Object.entries(COLUMNS).flatMap(([field, names]) => names.map((n) => [n, field])));
const VALUE_FOR = Object.fromEntries(Object.entries(VALUE_ALIASES).map(([field, table]) => [
  field, new Map(Object.entries(table).flatMap(([value, names]) => [value, ...names].map((n) => [norm(n), value]))),
]));
const LABEL = { stage: 'stage', priority: 'turnaround' };

/** Splits clipboard text into rows of cells: tab-separated, quoted cells may hold tabs, newlines and doubled quotes. */
export function splitCells(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const isHeader = (cells) => {
  const filled = cells.filter(Boolean);
  const known = filled.filter((c) => FIELD_FOR_HEADER.has(norm(c))).length;
  return known > 0 && known >= Math.ceil(filled.length / 2);
};

/**
 * Parses pasted sheet text into sample rows. Returns { header, columns, ignored, rows }: `columns` names the field each
 * pasted column fills (null when ignored), and each row holds its fields plus `problems`, a message per bad cell.
 */
export function parseSheet(text) {
  const grid = splitCells(text);
  if (!grid.length) return { header: false, columns: [], ignored: [], rows: [] };
  const header = isHeader(grid[0]);
  const width = Math.max(...grid.map((r) => r.length));
  const columns = header
    ? grid[0].map((c) => FIELD_FOR_HEADER.get(norm(c)) ?? null)
    : width === 1 ? ['description'] : DEFAULT_ORDER.slice(0, width);
  const ignored = header ? grid[0].filter((c, i) => c && !columns[i]) : [];
  const rows = grid.slice(header ? 1 : 0).map((cells) => {
    const row = { problems: {} };
    columns.forEach((field, i) => { if (field && cells[i] && !row[field]) row[field] = cells[i].replace(/\s*\n\s*/g, ' '); });
    for (const field of Object.keys(VALUE_FOR)) {
      if (!row[field]) continue;
      const value = VALUE_FOR[field].get(norm(row[field]));
      if (value) row[field] = value;
      else {
        row.problems[field] = `"${row[field]}" is not a ${LABEL[field]} we know. Use ${Object.keys(VALUE_ALIASES[field]).join(', ')}.`;
        row[field] = null;
      }
    }
    if (!row.description) row.problems.description = 'Every sample needs a name.';
    return row;
  });
  return { header, columns, ignored, rows };
}

const words = (s) => norm(s).replace(/[()[\],;]/g, ' ').split(' ').filter(Boolean);

/** The offered test a pasted name means: by code, by title, or by every word of it. Returns { method } or { problem }. */
export function matchTest(name, methods) {
  const q = norm(name);
  const qWords = words(name);
  const score = (m) => {
    if (norm(m.code) === q) return 4;
    if (norm(m.title) === q) return 3;
    if (q.length >= 3 && norm(m.title).includes(q)) return 2;
    const title = words(`${m.title} ${m.technique || ''}`);
    return qWords.length && qWords.every((w) => title.some((t) => t.startsWith(w))) ? 1 : 0;
  };
  const scored = methods.map((m) => [score(m), m]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  if (!scored.length) return { problem: `"${name}" matches none of the tests offered.` };
  const best = scored.filter(([s]) => s === scored[0][0]).map(([, m]) => m);
  if (best.length > 1) return { problem: `"${name}" could be ${best.map((m) => m.title).join(' or ')}. Tick the right test below.` };
  return { method: best[0] };
}

/**
 * Tests apply to the whole shipment, so the pasted Test column must name one set of tests. Returns { methodIds,
 * problem } and adds a `test` problem to each row whose test matches nothing offered.
 */
export function planTests(rows, methods) {
  const sets = [];
  for (const row of rows) {
    if (!row.test) continue;
    const ids = [];
    for (const name of row.test.split(/[,;+]/).map((s) => s.trim()).filter(Boolean)) {
      const m = matchTest(name, methods);
      if (m.method) ids.push(m.method.id);
      else row.problems.test = m.problem;
    }
    if (!row.problems.test) sets.push([...new Set(ids)].sort((a, b) => a - b).join(','));
  }
  const distinct = [...new Set(sets)];
  if (distinct.length > 1) {
    return { methodIds: [], problem: 'These rows ask for different tests. Tests apply to every sample in a shipment, so send rows with different tests as separate submissions.' };
  }
  return { methodIds: distinct.length ? distinct[0].split(',').map(Number) : [], problem: null };
}
