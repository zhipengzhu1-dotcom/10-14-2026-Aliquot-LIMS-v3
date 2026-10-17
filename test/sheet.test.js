// A client's sample sheet, pasted from Excel or read from a .csv, becomes a grid; a guessed column mapping the client
// may change reads it into sample rows with per-cell problems and extra detail, and the Test column ticks one set of
// the offered tests.
// Run with:  node --test test/sheet.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridFromText, guessMapping, remap, withHeader, dropRows, readSheet, planTests, PORTAL_FIELDS, LAB_FIELDS } from '../public/portal/sheet.js';

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

const read = (text, fields = PORTAL_FIELDS) => {
  const grid = gridFromText(text, 'paste');
  const mapping = guessMapping(grid, fields);
  return { mapping, rows: readSheet(grid, mapping).rows };
};
const uses = (mapping) => mapping.columns.map((c) => c.use);

test('an Excel copy with the client’s seven headings', () => {
  assert.deepEqual(read(EXCEL), {
    mapping: {
      header: true,
      columns: [
        { label: 'Product Code', use: 'product_code' }, { label: 'Product Name', use: 'description' }, { label: 'Lot#', use: 'batch_no' },
        { label: 'Status', use: 'stage' }, { label: 'Urgency', use: 'priority' }, { label: 'Test requested', use: 'test' }, { label: 'Quantity', use: 'quantity' },
      ],
    },
    rows: [
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin HCl 500 mg', batch_no: 'MF-2701', stage: 'Stability', priority: 'Same day', test: 'Water', quantity: '100' },
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin HCl 500 mg "film-coated"', batch_no: 'MF-2702', stage: 'Finished product', priority: 'One week', test: 'Karl Fischer', quantity: '60' },
      { problems: {}, details: [], product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B\t12', stage: 'R&D', priority: 'Next day', test: 'ATM-0002', quantity: '30' },
      {
        problems: {
          stage: '"frozen" is not a stage we know. Use Stability, R&D, Finished product, Initial, Bulk hold, Other.',
          priority: '"soonish" is not a turnaround we know. Use Same day, Next day, 3 days, One week.',
        },
        details: [],
        product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B-13', stage: null, priority: null, test: 'Water', quantity: '30',
      },
    ],
  });
});

test('headings in any order, some missing, an unknown one kept as extra detail', () => {
  assert.deepEqual(read('Qty\tBatch\tName\tStorage\nx3\tL1\tAspirin\t2-8 °C\nx4\tL2\tParacetamol\t\n'), {
    mapping: { header: true, columns: [{ label: 'Qty', use: 'quantity' }, { label: 'Batch', use: 'batch_no' }, { label: 'Name', use: 'description' }, { label: 'Storage', use: 'extra' }] },
    rows: [
      { problems: {}, quantity: 'x3', batch_no: 'L1', description: 'Aspirin', details: [{ label: 'Storage', value: '2-8 °C' }] },
      { problems: {}, quantity: 'x4', batch_no: 'L2', description: 'Paracetamol', details: [] },
    ],
  });
});

test('a heading repeated, a blank heading and an empty column', () => {
  const { mapping, rows } = read('Name\tName\t\t\tLot\nAspirin\tAcetylsalicylic acid\tshelf 2\t\tL1');
  assert.deepEqual(mapping.columns, [
    { label: 'Name', use: 'description' }, { label: 'Name', use: 'extra' }, { label: 'Column C', use: 'extra' }, { label: 'Column D', use: 'ignore' }, { label: 'Lot', use: 'batch_no' },
  ]);
  assert.deepEqual(rows[0].details, [{ label: 'Name', value: 'Acetylsalicylic acid' }, { label: 'Column C', value: 'shelf 2' }]);
});

test('no heading row: the client’s column order, a missing name flagged, columns past it kept as detail', () => {
  assert.deepEqual(read('MF500\tMetformin\tMF-1\tBulk-Hold\t3d\tWater\t10\r\nMF500\t\tMF-2\tinitial\tTODAY\t\t5'), {
    mapping: {
      header: false,
      columns: [
        { label: 'Column A', use: 'product_code' }, { label: 'Column B', use: 'description' }, { label: 'Column C', use: 'batch_no' }, { label: 'Column D', use: 'stage' },
        { label: 'Column E', use: 'priority' }, { label: 'Column F', use: 'test' }, { label: 'Column G', use: 'quantity' },
      ],
    },
    rows: [
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin', batch_no: 'MF-1', stage: 'Bulk hold', priority: '3 days', test: 'Water', quantity: '10' },
      { problems: { description: 'Every sample needs a name.' }, details: [], product_code: 'MF500', batch_no: 'MF-2', stage: 'Initial', priority: 'Same day', quantity: '5' },
    ],
  });
  assert.deepEqual(uses(read('a\tb\tc\td\te\tf\tg\th\ti\tj\tk').mapping),
    ['product_code', 'description', 'batch_no', 'stage', 'priority', 'test', 'quantity', 'client_ref', 'container', 'extra', 'extra']);
});

test('one name per line still works, and a first line that looks like a heading is a sample (#17)', () => {
  assert.deepEqual(read('Atorvastatin API, lot 2026-118\n\nAtorvastatin API, lot 2026-119\n').rows.map((r) => r.description), ['Atorvastatin API, lot 2026-118', 'Atorvastatin API, lot 2026-119']);
  assert.deepEqual(read('Sample\nAspirin'), {
    mapping: { header: false, columns: [{ label: 'Column A', use: 'description' }] },
    rows: [{ problems: {}, details: [], description: 'Sample' }, { problems: {}, details: [], description: 'Aspirin' }],
  });
  assert.deepEqual(read('Code\nX1').rows.map((r) => [r.description, r.problems]), [['Code', {}], ['X1', {}]]);
});

test('the client says whether the first row is headings; columns keep their uses', () => {
  const grid = gridFromText('Sample\nAspirin', 'paste');
  const headed = withHeader(grid, guessMapping(grid, PORTAL_FIELDS), true);
  assert.deepEqual(headed, { header: true, columns: [{ label: 'Sample', use: 'description' }] });
  assert.deepEqual(readSheet(grid, headed).rows.map((r) => r.description), ['Aspirin']);

  const four = gridFromText('Qty\tBatch\tName\tShelf\nx3\tL1\tAspirin\tA2', 'paste');
  const plain = withHeader(four, guessMapping(four, PORTAL_FIELDS), false);
  assert.deepEqual(plain.columns.map((c) => c.label), ['Column A', 'Column B', 'Column C', 'Column D']);
  assert.deepEqual(uses(plain), ['quantity', 'batch_no', 'description', 'extra']);
  assert.deepEqual(readSheet(four, plain).rows.map((r) => [r.description, r.details]), [
    ['Name', [{ label: 'Column D', value: 'Shelf' }]],
    ['Aspirin', [{ label: 'Column D', value: 'A2' }]],
  ]);
});

test('giving a field to a second column moves the first to extra detail, never drops it', () => {
  const grid = gridFromText('Name\tShelf\nAspirin\tA2', 'paste');
  const m = remap(guessMapping(grid, PORTAL_FIELDS), 1, 'description');
  assert.deepEqual(m.columns, [{ label: 'Name', use: 'extra' }, { label: 'Shelf', use: 'description' }]);
  assert.deepEqual(readSheet(grid, m).rows, [{ problems: {}, description: 'A2', details: [{ label: 'Name', value: 'Aspirin' }] }]);
  assert.deepEqual(uses(remap(remap(m, 0, 'ignore'), 1, 'extra')), ['ignore', 'extra']);
});

test('the lab reads its own fields: priority and test columns become detail', () => {
  const { mapping, rows } = read('Name\tLot\tUrgency\tTest\tContainer\nAspirin\tL1\tSame day\tWater\tvial', LAB_FIELDS);
  assert.deepEqual(uses(mapping), ['description', 'batch_no', 'extra', 'extra', 'container']);
  assert.deepEqual(rows[0].details, [{ label: 'Urgency', value: 'Same day' }, { label: 'Test', value: 'Water' }]);
  assert.deepEqual(uses(read('Metformin\tMF-1\tREL-1\t100 tablets\tHDPE bottle', LAB_FIELDS).mapping), ['description', 'batch_no', 'client_ref', 'quantity', 'container']);
});

test('CSV files: a byte-order mark, semicolons from European Excel, commas, quotes and line breaks in a cell', () => {
  assert.deepEqual(gridFromText('﻿Name;Lot\r\n"Aspirin; 100 mg";L1\r\n', 'csv'), [['Name', 'Lot'], ['Aspirin; 100 mg', 'L1']]);
  assert.deepEqual(gridFromText('Name,Lot,Note\nA,"L,1","line one\nline ""two"""\n', 'csv'), [['Name', 'Lot', 'Note'], ['A', 'L,1', 'line one\nline "two"']]);
  assert.deepEqual(gridFromText('Name\tLot\nA\tL1', 'csv'), [['Name', 'Lot'], ['A', 'L1']]);
  assert.deepEqual(gridFromText('Aspirin, 100 mg', 'paste'), [['Aspirin, 100 mg']]);
});

test('rows that did not fit stay as a sheet, headings kept', () => {
  const grid = gridFromText('Name\tNote\nA\t"x\ny"\nB\t\nC\tz', 'paste');
  const m = guessMapping(grid, PORTAL_FIELDS);
  assert.deepEqual(dropRows(grid, m, 2), [['Name', 'Note'], ['C', 'z']]);
  assert.deepEqual(dropRows(grid.slice(1), withHeader(grid.slice(1), m, false), 1), [['B', ''], ['C', 'z']]);
});

test('the Test column ticks the one test every row names, by title, words or code', () => {
  const { rows } = read(EXCEL);
  assert.deepEqual(planTests(rows, METHODS), { methodIds: [2], problem: null });
  assert.deepEqual(rows.map((r) => r.problems.test), [undefined, undefined, undefined, undefined]);
});

test('rows naming different tests, an unknown test and an ambiguous one are flagged', () => {
  const { rows } = read('Name\tTest\nA\tWater\nB\tFTIR, water\nC\tNitrosamines\nD\tAssay');
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
