// Intake review, values and corrections: the review of one received Sample shows what the client submitted beside what
// the Sample holds now, its condition, the client's notes and sheet details and the Submission's portal thread; during
// review the manager corrects the Sample, adds a Test or cancels one through the existing actions. Starts a real server
// on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-review.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
const STORAGE = 'Refrigerated (2–8 °C)';
let server;
let dataDir;
let lab;

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
    get: (url) => req('GET', url),
    post: (url, body = {}) => req('POST', url, body),
    put: (url, body = {}) => req('PUT', url, body),
    async ok(method, url, body) {
      const r = await req(method, url, body);
      assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
  };
}

const people = {};
async function staff(username) {
  if (!people[username]) {
    people[username] = session(server.base);
    await people[username].ok('POST', '/api/auth/login', { username, password: PASSWORD });
  }
  return people[username];
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-review-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const methods = await priya.ok('GET', '/api/methods?usable=1');
  lab = {
    client: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    kf: methods.find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    other: methods.find((m) => m.code !== 'ATM-0002' && m.status === 'Effective').id,
    analyst: (await priya.ok('GET', '/api/users')).find((u) => u.username === 'tom.fletcher').id,
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A Sample received at the front desk with one Karl Fischer Test; it waits for intake review. */
async function receiveDirect(description = 'Front desk sample', extra = {}) {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', { client_id: lab.client, samples: [{ description }], method_ids: [lab.kf], ...extra });
  return res.samples[0].id;
}

/** A client Submission of one Sample, acknowledged and received; the Sample waits for intake review. */
async function receiveFromSubmission() {
  const laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  const sub = await laura.ok('POST', '/api/portal/submissions', {
    priority: 'Next day',
    storage: STORAGE,
    sample_type: 'Drug Product',
    notes: 'Handle with care, hygroscopic',
    samples: [{ description: 'Buffer lot 12', batch_no: 'B-12', client_ref: 'PO-9', tests_requested: 'Water content', limits: '<0.5 %', details: [{ label: 'Grade', value: 'USP' }] }],
    method_ids: [lab.kf],
  });
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/acknowledge`, { note: 'We will look after it' });
  const rec = await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, { condition: 'Damaged container', location: 'Store A', storage: STORAGE });
  return { submission: sub, sampleId: rec.samples[0].id };
}

const review = async (who, id) => (await staff(who)).ok('GET', `/api/intake/samples/${id}/review`);
const field = (r, key) => r.fields.find((f) => f.key === key);

test('the review of a Submission Sample shows the submitted row beside the current values', async () => {
  const { submission, sampleId } = await receiveFromSubmission();
  const r = await review('priya.raman', sampleId);

  assert.equal(r.submitted.submission.code, submission.code);
  assert.equal(r.submitted.row.description, 'Buffer lot 12');
  assert.equal(r.submitted.row.batch_no, 'B-12');
  assert.equal(r.current.description, 'Buffer lot 12');
  assert.equal(r.current.batch_no, 'B-12');

  // The submission-level choices count as submitted for the Sample as well.
  assert.deepEqual([field(r, 'priority').submitted, field(r, 'priority').current, field(r, 'priority').changed], ['Next day', 'Next day', false]);
  assert.equal(field(r, 'storage').submitted, STORAGE);
  assert.equal(field(r, 'description').changed, false);
});

test('the review carries the receipt condition, storage, client notes, sheet details and the Submission thread', async () => {
  const { sampleId } = await receiveFromSubmission();
  const r = await review('priya.raman', sampleId);

  assert.equal(r.condition.condition, 'Damaged container');
  assert.equal(r.condition.storage, STORAGE);
  assert.equal(r.condition.location, 'Store A');
  assert.ok(r.condition.received_at);
  assert.match(r.condition.receipt_note, /Damaged container/);

  assert.equal(r.details.submission_notes, 'Handle with care, hygroscopic');
  assert.deepEqual(r.details.sheet, [{ label: 'Tests requested', value: 'Water content' }, { label: 'Limits', value: '<0.5 %' }, { label: 'Grade', value: 'USP' }]);

  assert.match(r.thread.subject, /^Sample submission SUB-/);
  const bodies = r.thread.messages.map((m) => m.body).join('\n');
  assert.match(bodies, /Handle with care/, 'the client wrote it');
  assert.match(bodies, /We will look after it/, 'the lab acknowledged it');
  assert.match(bodies, /arrived and are logged/, 'the receipt notice');
  assert.deepEqual([...new Set(r.thread.messages.map((m) => m.side))].sort(), ['client', 'lab', 'system']);
});

test('a Sample received at the front desk has nothing submitted and no thread', async () => {
  const id = await receiveDirect('Walk-in', { condition: 'Acceptable', storage: STORAGE });
  const r = await review('priya.raman', id);
  assert.equal(r.submitted, null);
  assert.equal(r.thread, null);
  assert.equal(r.current.description, 'Walk-in');
  assert.equal(r.condition.condition, 'Acceptable');
  assert.ok(r.fields.every((f) => f.submitted === null && f.changed === false), 'nothing to compare against');
});

test('the review is refused without samples.review and is a 404 for an unknown Sample', async () => {
  const id = await receiveDirect();
  for (const username of ['tom.fletcher', 'daniel.okafor', 'grace.holloway']) {
    const res = await (await staff(username)).get(`/api/intake/samples/${id}/review`);
    assert.equal(res.status, 403, username);
  }
  assert.equal((await (await staff('priya.raman')).get('/api/intake/samples/99999/review')).status, 404);
  assert.equal((await (await staff('sarah.lindqvist')).get(`/api/intake/samples/${id}/review`)).status, 200, 'a scientist holds the permission');
});

const history = async (entity, id) => (await staff('priya.raman')).ok('GET', `/api/history/${entity}/${id}`);

test('a correction made during review is audited with the old and new value, and the comparison shows it', async () => {
  const { sampleId } = await receiveFromSubmission();
  const priya = await staff('priya.raman');
  const before = await review('priya.raman', sampleId);
  assert.equal(before.corrections.can.edit, true);
  assert.equal(before.corrections.reason_required, false, 'a Sample nobody has started needs no reason');

  await priya.ok('PUT', `/api/samples/${sampleId}`, { description: 'Buffer lot 12 (relabelled)', batch_no: 'B-12A', client_ref: 'PO-10', priority: 'One week', storage: 'Frozen (−20 °C)' });

  const after = await review('priya.raman', sampleId);
  assert.equal(after.current.description, 'Buffer lot 12 (relabelled)');
  assert.deepEqual([field(after, 'description').submitted, field(after, 'description').changed], ['Buffer lot 12', true]);
  assert.deepEqual([field(after, 'batch_no').submitted, field(after, 'batch_no').current], ['B-12', 'B-12A']);
  assert.deepEqual([field(after, 'priority').submitted, field(after, 'priority').current, field(after, 'priority').changed], ['Next day', 'One week', true]);
  assert.equal(field(after, 'storage').changed, true);
  assert.equal(after.submitted.row.description, 'Buffer lot 12', 'what the client submitted never changes');

  const entry = (await history('samples', sampleId)).find((h) => h.summary === 'Sample details edited');
  assert.equal(entry.username, 'priya.raman');
  const changes = JSON.parse(entry.changes);
  assert.deepEqual(changes.batch_no, ['B-12', 'B-12A']);
  assert.deepEqual(changes.client_ref, ['PO-9', 'PO-10']);
  assert.deepEqual(changes.description, ['Buffer lot 12', 'Buffer lot 12 (relabelled)']);
  assert.deepEqual(changes.storage, [STORAGE, 'Frozen (−20 °C)']);
  assert.deepEqual(changes.priority, ['Next day', 'One week']);
});

test('a correction is refused without the permission, once testing has started without a reason, and on a cancelled Sample', async () => {
  const priya = await staff('priya.raman');
  const id = await receiveDirect('Correction refusals');
  assert.equal((await (await staff('daniel.okafor')).put(`/api/samples/${id}`, { batch_no: 'X' })).status, 403);
  assert.equal((await priya.put(`/api/samples/${id}`, { priority: 'No such tier' })).status, 400);

  // Testing started: the same edit now demands a reason, and the review says so up front.
  const started = await receiveDirect('Correction after start');
  await priya.ok('POST', `/api/samples/${started}/accept`);
  const test = (await priya.ok('GET', `/api/samples/${started}`)).tests[0];
  await priya.ok('POST', '/api/tests/assign', { test_ids: [test.id], analyst_id: lab.analyst });
  await (await staff('tom.fletcher')).ok('POST', `/api/tests/${test.id}/start`);
  assert.equal((await review('priya.raman', started)).corrections.reason_required, true);
  const refused = await priya.put(`/api/samples/${started}`, { batch_no: 'LATE' });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'REASON_REQUIRED');
  assert.equal((await review('priya.raman', started)).current.batch_no, null, 'nothing changed');
  await priya.ok('PUT', `/api/samples/${started}`, { batch_no: 'LATE', reason: 'Label misread at intake' });
  const entry = (await history('samples', started)).find((h) => h.summary === 'Sample details edited');
  assert.equal(entry.reason, 'Label misread at intake');

  const cancelled = await receiveDirect('Cancelled sample');
  await priya.ok('POST', `/api/samples/${cancelled}/cancel`, { reason: 'Sent in error' });
  const closed = await review('priya.raman', cancelled);
  assert.equal(closed.corrections.can.edit, false);
  assert.match(closed.corrections.locks.edit, /cancelled/i);
  assert.equal((await priya.put(`/api/samples/${cancelled}`, { batch_no: 'X' })).status, 400);
});

test('a Test added during review is a new Pending Test through the existing action, and the refusals stand', async () => {
  const priya = await staff('priya.raman');
  const id = await receiveDirect('Add a test');
  const added = await priya.ok('POST', `/api/samples/${id}/tests`, { method_ids: [lab.other] });
  assert.equal(added.ids.length, 1);

  const r = await review('priya.raman', id);
  assert.equal(r.corrections.tests.length, 2);
  const mine = r.corrections.tests.find((t) => t.id === added.ids[0]);
  assert.equal(mine.status, 'Pending');
  assert.equal(mine.method_code, (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.id === lab.other).code);
  assert.ok((await history('tests', mine.id)).some((h) => h.action === 'CREATE'), 'the new Test is audited');

  assert.equal((await (await staff('daniel.okafor')).post(`/api/samples/${id}/tests`, { method_ids: [lab.other] })).status, 403, 'QA does not receive Samples');
  assert.equal((await priya.post(`/api/samples/${id}/tests`, { method_ids: [] })).status, 400);
  const retired = (await priya.ok('GET', '/api/methods')).find((m) => !['In Development', 'In Validation', 'Effective'].includes(m.status));
  assert.equal((await priya.post(`/api/samples/${id}/tests`, { method_ids: [retired.id] })).status, 400, 'a method that cannot be used is refused');

  await priya.ok('POST', `/api/samples/${id}/cancel`, { reason: 'Sent in error' });
  assert.equal((await priya.post(`/api/samples/${id}/tests`, { method_ids: [lab.other] })).status, 400, 'no Test is added to a cancelled Sample');
  assert.equal((await review('priya.raman', id)).corrections.can.addTests, false);
});

test('a Test cancelled during review needs a reason and tests.cancel, and the audit trail keeps both', async () => {
  const priya = await staff('priya.raman');
  const id = await receiveDirect('Cancel a test');
  await priya.ok('POST', `/api/samples/${id}/tests`, { method_ids: [lab.other] });

  const asManager = await review('priya.raman', id);
  const asScientist = await review('sarah.lindqvist', id);
  const [keep, drop] = asManager.corrections.tests;
  assert.equal(drop.can.cancel, true);
  assert.equal(asScientist.corrections.tests[1].can.cancel, false, 'a scientist reviews Samples but cannot cancel Tests');
  assert.match(asScientist.corrections.tests[1].locks.cancel, /permission/i);

  assert.equal((await (await staff('sarah.lindqvist')).post(`/api/tests/${drop.id}/cancel`, { reason: 'Not needed' })).status, 403);
  assert.equal((await (await staff('tom.fletcher')).post(`/api/tests/${drop.id}/cancel`, { reason: 'Not needed' })).status, 403);
  const missing = await priya.post(`/api/tests/${drop.id}/cancel`, { reason: '  ' });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.code, 'REASON_REQUIRED');
  assert.equal((await review('priya.raman', id)).corrections.tests[1].status, 'Pending', 'nothing was cancelled');

  await priya.ok('POST', `/api/tests/${drop.id}/cancel`, { reason: 'Client does not need this method' });
  const after = await review('priya.raman', id);
  assert.deepEqual(after.corrections.tests.map((t) => t.status), [keep.status, 'Cancelled']);
  assert.equal(after.corrections.tests[1].can.cancel, false, 'a Cancelled Test cannot be cancelled again');
  const entry = (await history('tests', drop.id)).find((h) => h.reason === 'Client does not need this method');
  assert.equal(entry.username, 'priya.raman');
  assert.deepEqual(JSON.parse(entry.changes).status, ['Pending', 'Cancelled']);
  assert.equal((await priya.ok('GET', `/api/samples/${id}`)).sample.test_count, 1);
});

test('the Sample detail carries the intake state and the decision history', async () => {
  const priya = await staff('priya.raman');
  const id = await receiveDirect('Decision history');
  const pending = await priya.ok('GET', `/api/samples/${id}`);
  assert.deepEqual(pending.intake, { state: 'Pending review', decisions: [] });

  await priya.ok('POST', `/api/samples/${id}/accept`);
  const { intake } = await priya.ok('GET', `/api/samples/${id}`);
  assert.equal(intake.state, 'Accepted');
  assert.equal(intake.decisions.length, 1);
  const [decision] = intake.decisions;
  assert.equal(decision.decision, 'Accepted');
  assert.equal(decision.decided_by_name, 'Priya Raman');
  assert.match(decision.decided_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(decision.reason, null);

  // Whoever may see the Sample sees how it was decided.
  assert.equal((await (await staff('tom.fletcher')).ok('GET', `/api/samples/${id}`)).intake.decisions.length, 1);
});
