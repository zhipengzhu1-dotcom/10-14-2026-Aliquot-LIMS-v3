// A client's sample sheet, pasted from Excel or read from a .csv, becomes a grid; a guessed column mapping the client
// may change reads it into sample rows with per-cell problems and extra detail.
// Run with:  node --test test/sheet.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridFromText, guessMapping, remap, withHeader, dropRows, readSheet, PORTAL_FIELDS, LAB_FIELDS } from '../public/portal/sheet.js';

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
        { label: 'Status', use: 'stage' }, { label: 'Urgency', use: 'priority' }, { label: 'Test requested', use: 'tests_requested' }, { label: 'Quantity', use: 'quantity' },
      ],
    },
    rows: [
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin HCl 500 mg', batch_no: 'MF-2701', stage: 'Stability', priority: 'Same day', tests_requested: 'Water', quantity: '100' },
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin HCl 500 mg "film-coated"', batch_no: 'MF-2702', stage: 'Finished product', priority: 'One week', tests_requested: 'Karl Fischer', quantity: '60' },
      { problems: {}, details: [], product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B\t12', stage: 'R&D', priority: 'Next day', tests_requested: 'ATM-0002', quantity: '30' },
      {
        problems: {
          stage: '"frozen" is not a stage we know. Use Stability, R&D, Finished product, Initial, Bulk hold, Other.',
          priority: '"soonish" is not a turnaround we know. Use Same day, Next day, 3 days, One week.',
        },
        details: [{ label: 'Status', value: 'frozen' }, { label: 'Urgency', value: 'soonish' }],
        product_code: 'IBU400', description: 'Ibuprofen 400 mg', batch_no: 'B-13', stage: null, priority: null, tests_requested: 'Water', quantity: '30',
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

test('a client’s own sheet where most headings are theirs, not ours, is still read by its headings', () => {
  const { mapping, rows } = read([
    'Product Code\tPRODUCT NAME\tTYPE\tLOT#\tCLIENT\tEXP DATE\tTESTING\tPO NUMBER',
    '0836J\tDiphenhydramine 50mg Capsule\tInitial\tR635939\tCPC\t2027-01\tTBD\tPO-77',
  ].join('\n'));
  assert.deepEqual(mapping, { header: true, columns: [
    { label: 'Product Code', use: 'product_code' }, { label: 'PRODUCT NAME', use: 'description' }, { label: 'TYPE', use: 'extra' }, { label: 'LOT#', use: 'batch_no' },
    { label: 'CLIENT', use: 'extra' }, { label: 'EXP DATE', use: 'extra' }, { label: 'TESTING', use: 'extra' }, { label: 'PO NUMBER', use: 'extra' },
  ] });
  assert.deepEqual(rows, [{
    problems: {}, product_code: '0836J', description: 'Diphenhydramine 50mg Capsule', batch_no: 'R635939',
    details: [{ label: 'TYPE', value: 'Initial' }, { label: 'CLIENT', value: 'CPC' }, { label: 'EXP DATE', value: '2027-01' }, { label: 'TESTING', value: 'TBD' }, { label: 'PO NUMBER', value: 'PO-77' }],
  }]);
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
        { label: 'Column E', use: 'priority' }, { label: 'Column F', use: 'tests_requested' }, { label: 'Column G', use: 'quantity' },
      ],
    },
    rows: [
      { problems: {}, details: [], product_code: 'MF500', description: 'Metformin', batch_no: 'MF-1', stage: 'Bulk hold', priority: '3 days', tests_requested: 'Water', quantity: '10' },
      { problems: { description: 'Every sample needs a name.' }, details: [], product_code: 'MF500', batch_no: 'MF-2', stage: 'Initial', priority: 'Same day', quantity: '5' },
    ],
  });
  assert.deepEqual(uses(read('a\tb\tc\td\te\tf\tg\th\ti\tj\tk').mapping),
    ['product_code', 'description', 'batch_no', 'stage', 'priority', 'tests_requested', 'quantity', 'client_ref', 'container', 'limits', 'extra']);
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

test('Tests requested stays as the client wrote it, whether or not the lab offers that test', () => {
  const { rows } = read('Name\tTest\nA\tWater\nB\tFTIR, water\nC\tNitrosamines');
  assert.deepEqual(rows.map((r) => [r.tests_requested, r.problems.tests_requested]), [['Water', undefined], ['FTIR, water', undefined], ['Nitrosamines', undefined]]);
});

// The lab's Sample Submission Log, as Excel copies it: a No. column, TYPE with its legend, a starred TAT in days.
const LOG = [
  'No.\tSAMPLE DESCRIPTION\tTYPE (FP/IP/RM/R&D, Stab. Condition)\t*TAT #\tLOT NUMBER\tPRODUCT CODE\tTESTS REQUESTED\tLIMITS',
  '1\tAcetaminophen 500mg Tablet\tFP\t1\tR00001\t1234\tNitrosamine Impurity by LC-MS\t<26.5ng/day',
].join('\r\n');

test('the Sample Submission Log fills every column of the form, and its numbering column is ignored', () => {
  const { mapping, rows } = read(LOG);
  assert.deepEqual(uses(mapping), ['ignore', 'description', 'stage', 'priority', 'batch_no', 'product_code', 'tests_requested', 'limits']);
  assert.deepEqual(rows, [{
    problems: {}, details: [], description: 'Acetaminophen 500mg Tablet', stage: 'Finished product', priority: 'Next day',
    batch_no: 'R00001', product_code: '1234', tests_requested: 'Nitrosamine Impurity by LC-MS', limits: '<26.5ng/day',
  }]);
});

test('a bare Type or Sample type column and an Item column stay as the client’s detail, never read as stage or a row number', () => {
  const { mapping, rows } = read('Description\tBatch\tSample type\tItem\nAspirin\tB1\tDrug Product\tTablet 100mg', LAB_FIELDS);
  assert.deepEqual(uses(mapping), ['description', 'batch_no', 'extra', 'extra']);
  assert.deepEqual(rows[0].details, [{ label: 'Sample type', value: 'Drug Product' }, { label: 'Item', value: 'Tablet 100mg' }]);
});

test('a type or turnaround we have no value for is flagged and kept as detail, not lost', () => {
  const { rows } = read(LOG.replace('\tFP\t1\t', '\tIP\t2\t'));
  assert.deepEqual(rows[0].details, [{ label: 'TYPE (FP/IP/RM/R&D, Stab. Condition)', value: 'IP' }, { label: '*TAT #', value: '2' }]);
  assert.deepEqual([rows[0].stage, rows[0].priority], [null, null]);
  assert.equal(Object.keys(rows[0].problems).length, 2);
});
