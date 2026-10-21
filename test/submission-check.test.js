// The submission gate's dry run: every problem a draft has, at its path, from the same checks the real submission runs,
// with nothing saved. Run with:  node --test test/submission-check.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
let server;
let dataDir;
let laura;
let manager;
let lookups;
let foreignProject;
let closedMethod;

const STORAGE = 'Ambient (15–25 °C), Refrigerated (2–8 °C), Frozen (−20 °C), Deep frozen (−80 °C), Ambient, protect from light';
const STAGES = 'Stability, R&D, Finished product, Initial, Bulk hold, Other';

function session(base) {
  let cookie = '';
  const req = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'X-Requested-With': 'aliquot', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  return {
    req,
    async ok(method, url, body) {
      const r = await req(method, url, body);
      assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-gate-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  manager = session(server.base);
  await manager.ok('POST', '/api/auth/login', { username: 'priya.raman', password: PASSWORD });
  lookups = await laura.ok('GET', '/api/portal/lookups');
  const acme = (await manager.ok('GET', '/api/clients')).find((c) => c.code === 'ACME');
  const other = (await manager.ok('GET', '/api/clients')).find((c) => c.id !== acme.id);
  foreignProject = (await manager.ok('POST', '/api/projects', { client_id: other.id, title: 'Not Acme’s', type: 'Other', status: 'Active' })).id;
  const offered = new Set(lookups.methods.map((m) => m.id));
  closedMethod = (await manager.ok('GET', '/api/methods')).find((m) => !offered.has(m.id)).id;
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const submissionCount = async () => (await manager.ok('GET', '/api/portal-admin/submissions?status=all')).length;

test('a draft gets every problem at its path, from the checks the real submission runs, and nothing is saved', async () => {
  const before = await submissionCount();
  const assay = lookups.methods[0].id;
  const draft = {
    project_id: foreignProject,
    storage: 'refrigerated (2-8 °C)',
    ship_date: '2026-13-45',
    samples: [{ description: '', batch_no: 'LOT-1' }, {}, { description: 'Paracetamol 500 mg', stage: 'stability' }],
    method_ids: [assay, closedMethod],
  };
  const check = await laura.ok('POST', '/api/portal/submissions/check', draft);
  assert.deepEqual(check, {
    ok: false,
    problems: [
      { rule: 'shipment-field', path: 'storage', message: `Storage must be one of: ${STORAGE}`, fix: { value: 'Refrigerated (2–8 °C)' } },
      { rule: 'shipment-field', path: 'ship_date', message: 'Ship date must be a valid date' },
      { rule: 'project-open', path: 'project_id', message: 'Project not found' },
      { rule: 'sample-field', path: 'samples.0.description', message: 'Sample 1 description is required' },
      { rule: 'sample-field', path: 'samples.2.stage', message: `Sample 2 stage must be one of: ${STAGES}`, fix: { value: 'Stability' } },
      { rule: 'tests-on-contract', path: 'method_ids', message: 'One of the selected tests is not available', fix: { value: [assay] } },
    ],
  });
  const sent = await laura.req('POST', '/api/portal/submissions', draft);
  assert.deepEqual([sent.status, sent.data.error], [400, `Storage must be one of: ${STORAGE}`], 'the real submission refuses the first problem the dry run lists');
  const missing = await laura.ok('POST', '/api/portal/submissions/check', { project_id: 999999, samples: [{ description: 'a' }] });
  assert.deepEqual(missing.problems, [{ rule: 'shipment-field', path: 'project_id', message: 'Project not found' }], 'a Project that does not exist is listed once, by its field');
  assert.equal(await submissionCount(), before, 'neither the dry run nor the refused submission saved anything');
});

test('applying every fix the gate offers makes the draft pass, and the same body then submits', async () => {
  const assay = lookups.methods[0].id;
  const draft = { storage: 'FROZEN (-20 °C)', samples: [{ description: 'Stability pull 6M', stage: 'Finished Product' }], method_ids: [closedMethod, assay] };
  const first = await laura.ok('POST', '/api/portal/submissions/check', draft);
  assert.deepEqual(first.problems.map((p) => [p.path, p.fix?.value]), [['storage', 'Frozen (−20 °C)'], ['samples.0.stage', 'Finished product'], ['method_ids', [assay]]]);
  const fixed = { storage: 'Frozen (−20 °C)', samples: [{ description: 'Stability pull 6M', stage: 'Finished product' }], method_ids: [assay] };
  assert.deepEqual(await laura.ok('POST', '/api/portal/submissions/check', fixed), { ok: true, problems: [] });
  const sub = await laura.ok('POST', '/api/portal/submissions', fixed);
  const saved = (await laura.ok('GET', `/api/portal/submissions/${sub.id}`)).submission;
  assert.deepEqual([saved.storage, saved.priority, saved.method_ids, saved.samples[0].stage], ['Frozen (−20 °C)', 'One week', [assay], 'Finished product']);
});

test('an empty draft is told to add a sample, and the dry run is the signed-in contact’s alone', async () => {
  assert.deepEqual(await laura.ok('POST', '/api/portal/submissions/check', {}), {
    ok: false,
    problems: [{ rule: 'sample-count', path: 'samples', message: 'Add at least one sample' }],
  });
  assert.equal((await session(server.base).req('POST', '/api/portal/submissions/check', {})).status, 401, 'no portal session');
  assert.equal((await manager.req('POST', '/api/portal/submissions/check', {})).status, 401, 'a staff session is not a portal session');
});

test('the body the submission desk sends, every field present and blank rows left in, checks and submits as typed', async () => {
  const blank = { description: null, product_code: null, batch_no: null, client_ref: null, quantity: null, container: null, stage: null, priority: null, tests_requested: null, limits: null, details: [] };
  const body = {
    project_id: null, sample_type: null, priority: 'One week', storage: 'Refrigerated (2–8 °C)', courier: 'FedEx', tracking_no: '7789 1123 0045', ship_date: '2026-10-20', notes: null,
    method_ids: [], samples: [blank, { ...blank, description: 'Paracetamol 500 mg tablet', batch_no: 'LOT-2291', stage: 'Finished product' }, blank],
  };
  assert.deepEqual(await laura.ok('POST', '/api/portal/submissions/check', body), { ok: true, problems: [] });
  const sub = await laura.ok('POST', '/api/portal/submissions', body);
  const saved = (await laura.ok('GET', `/api/portal/submissions/${sub.id}`)).submission;
  assert.deepEqual([saved.samples.length, saved.samples[0].batch_no, saved.samples[0].priority, saved.storage, saved.tracking_no], [1, 'LOT-2291', null, 'Refrigerated (2–8 °C)', '7789 1123 0045']);
});
