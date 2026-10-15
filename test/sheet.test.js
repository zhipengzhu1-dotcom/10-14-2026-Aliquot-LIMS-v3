// The client portal's spreadsheet paste: rows copied out of Excel come out as sample rows with per-cell problems,
// and the Test column ticks one set of the offered tests.
// Run with:  node --test test/sheet.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheet, planTests } from '../public/portal/sheet.js';

// What Excel puts on the clipboard: tabs between cells, CRLF between rows, a quoted cell where it holds a line break,
// a tab or a quote, and a trailing empty line.
const EXCEL = [
  'Product Code\tProduct Name\tLot#\tStatus\tUrgency\tTest requested\tQuantity',
  'MF500\tMetformin HCl 500 mg\tMF-2701\tStability\tsame day\tWater\t100',
  'MF500\t"Metformin HCl 500 mg\r\n""film-coated"""\tMF-2702\tFP\t1 week\tKarl Fischer\t60',
  'IBU400\tIbuprofen 400 mg\t"B\t12"\tR and D\t24h\tATM-0002\t30',
  'IBU400\tIbuprofen 400 mg\tB-13\tfrozen\tsoonish\tWater\t30',
  '',
  '',
].join('\r\n');

const METHODS = [
  { id: 2, code: 'ATM-0002', title: 'Water Content by Volumetric Karl Fischer Titration', technique: 'Karl Fischer' },
  { id: 1, code: 'ATM-0001', title: 'Assay and Related Substances of Metformin HCl Tablets by HPLC-UV', technique: 'HPLC-UV' },
  { id: 10, code: 'ATM-0010', title: 'Assay of Ibuprofen 400 mg Tablets by HPLC-UV', technique: 'HPLC-UV' },
  { id: 6, code: 'ATM-0006', title: 'Identification by FTIR (ATR)', technique: 'FTIR' },
];

test('an Excel copy with the client’s seven headers', () => {
  assert.deepEqual(parseSheet(EXCEL), {
    header: true,
    columns: ['product_code', 'description', 'batch_no', 'stage', 'priority', 'test', 'quantity'],
    ignored: [],
    rows: [
      { problems: {}, product_code: 'MF500', description: 'Metformin HCl 500 mg', batch_no: 'MF-2701', stage: 'Stability', priority: 'Same day', test: 'Water', quantity: '100' },
      { problems: {}, product_code: 'MF500', description: 'Metformin HCl 500 mg "film-coated"', batch_no: 'MF-2702', stage: 'Finished product', priority: 'One week', test: 'Karl Fischer', quantity: '60' },
      { problems: {}, product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B\t12', stage: 'R&D', priority: 'Next day', test: 'ATM-0002', quantity: '30' },
      {
        problems: {
          stage: '"frozen" is not a stage we know. Use Stability, R&D, Finished product, Initial, Bulk hold, Other.',
          priority: '"soonish" is not a turnaround we know. Use Same day, Next day, 3 days, One week.',
        },
        product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B-13', stage: null, priority: null, test: 'Water', quantity: '30',
      },
    ],
  });
});

test('headers in any order, some missing, an unknown one ignored', () => {
  assert.deepEqual(parseSheet('Qty\tBatch\tName\tShelf\nx3\tL1\tAspirin\tA2\n'), {
    header: true,
    columns: ['quantity', 'batch_no', 'description', null],
    ignored: ['Shelf'],
    rows: [{ problems: {}, quantity: 'x3', batch_no: 'L1', description: 'Aspirin' }],
  });
});

test('no header row: the client’s column order, a missing name flagged', () => {
  assert.deepEqual(parseSheet('MF500\tMetformin\tMF-1\tBulk-Hold\t3d\tWater\t10\r\nMF500\t\tMF-2\tinitial\tTODAY\t\t5'), {
    header: false,
    columns: ['product_code', 'description', 'batch_no', 'stage', 'priority', 'test', 'quantity'],
    ignored: [],
    rows: [
      { problems: {}, product_code: 'MF500', description: 'Metformin', batch_no: 'MF-1', stage: 'Bulk hold', priority: '3 days', test: 'Water', quantity: '10' },
      { problems: { description: 'Every sample needs a name.' }, product_code: 'MF500', batch_no: 'MF-2', stage: 'Initial', priority: 'Same day', quantity: '5' },
    ],
  });
});

test('one name per line still works, as the old list box did', () => {
  assert.deepEqual(parseSheet('Atorvastatin API, lot 2026-118\n\nAtorvastatin API, lot 2026-119\n'), {
    header: false,
    columns: ['description'],
    ignored: [],
    rows: [
      { problems: {}, description: 'Atorvastatin API, lot 2026-118' },
      { problems: {}, description: 'Atorvastatin API, lot 2026-119' },
    ],
  });
});

test('the Test column ticks the one test every row names, by title, words or code', () => {
  const { rows } = parseSheet(EXCEL);
  assert.deepEqual(planTests(rows, METHODS), { methodIds: [2], problem: null });
  assert.deepEqual(rows.map((r) => r.problems.test), [undefined, undefined, undefined, undefined]);
});

test('rows naming different tests, an unknown test and an ambiguous one are flagged', () => {
  const { rows } = parseSheet('Name\tTest\nA\tWater\nB\tFTIR, water\nC\tNitrosamines\nD\tAssay');
  assert.deepEqual(planTests(rows, METHODS), {
    methodIds: [],
    problem: 'These rows ask for different tests. Tests apply to every sample in a shipment, so send rows with different tests as separate submissions.',
  });
  assert.deepEqual(rows.map((r) => r.problems.test), [
    undefined,
    undefined,
    '"Nitrosamines" matches none of the tests offered.',
    '"Assay" could be Assay and Related Substances of Metformin HCl Tablets by HPLC-UV or Assay of Ibuprofen 400 mg Tablets by HPLC-UV. Tick the right test below.',
  ]);
});
