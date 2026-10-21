// Intake review, accepted with changes: the Test an analyst opens says whether its Sample was adjusted between receipt and
// the decision to accept it (edits to the Sample, Tests added or cancelled), derived from the audit trail. Starts a real
// server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-changes.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-changes-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const methods = (await priya.ok('GET', '/api/methods?usable=1')).filter((m) => m.status === 'Effective');
  lab = {
    acme: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    methods: methods.slice(0, 3),
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Receives one Sample (Pending review) with one Test for each of `methods`. Returns its id. */
async function receive(methods = [lab.methods[0]]) {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', {
    client_id: lab.acme, samples: [{ description: 'Changes sample', batch_no: 'B-1' }], method_ids: methods.map((m) => m.id),
  });
  return res.samples[0].id;
}

const accept = async (id) => (await staff('priya.raman')).ok('POST', `/api/samples/${id}/accept`);
const testsOf = async (id) => (await (await staff('priya.raman')).ok('GET', `/api/samples/${id}`)).tests;
/** What the analyst sees on the Test page: the `intake_changes` the Test endpoint returns. */
const changesOn = async (testId, who = 'tom.fletcher') => (await (await staff(who)).ok('GET', `/api/tests/${testId}`)).intake_changes;

test('a Sample accepted as received is not accepted with changes', async () => {
  const id = await receive([lab.methods[0], lab.methods[1]]);
  await accept(id);
  for (const t of await testsOf(id)) {
    const c = await changesOn(t.id);
    assert.equal(c.accepted_with_changes, false);
    assert.deepEqual([c.edits, c.added_tests, c.cancelled_tests], [[], [], []], 'the Tests requested at receipt are not "added"');
    assert.ok(c.accepted_at && c.accepted_by_name, 'who accepted it and when');
  }
});

test('a Sample edited before it is accepted says which values changed, from what, to what, and by whom', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await priya.ok('PUT', `/api/samples/${id}`, { description: 'Corrected description', batch_no: 'B-2', priority: 'Next day', notes: 'unchanged-looking' });
  await accept(id);
  const [t] = await testsOf(id);
  const c = await changesOn(t.id);
  assert.equal(c.accepted_with_changes, true);
  const byField = Object.fromEntries(c.edits.map((e) => [e.field, e]));
  assert.deepEqual(Object.keys(byField).sort(), ['batch_no', 'description', 'notes', 'priority'].sort());
  assert.equal(byField.description.from, 'Changes sample');
  assert.equal(byField.description.to, 'Corrected description');
  assert.equal(byField.batch_no.label, 'Batch / lot');
  assert.equal(byField.priority.to, 'Next day');
  assert.equal(byField.description.by, 'Priya Raman');
  assert.ok(byField.description.at);
});

test('a Test added or cancelled before the Sample is accepted is listed, and the others are not', async () => {
  const priya = await staff('priya.raman');
  const id = await receive([lab.methods[0], lab.methods[1]]);
  const [keep, drop] = await testsOf(id);
  await priya.ok('POST', `/api/tests/${drop.id}/cancel`, { reason: 'The client withdrew this request' });
  await priya.ok('POST', `/api/samples/${id}/tests`, { method_ids: [lab.methods[2].id] });
  await accept(id);

  const c = await changesOn(keep.id);
  assert.equal(c.accepted_with_changes, true);
  assert.deepEqual(c.added_tests.map((x) => x.method_code), [lab.methods[2].code]);
  assert.ok(c.added_tests[0].code && c.added_tests[0].method_title);
  assert.deepEqual(c.cancelled_tests.map((x) => x.code), [drop.code]);
  assert.equal(c.cancelled_tests[0].reason, 'The client withdrew this request');
  assert.equal(c.edits.length, 0);
  // The same answer on the added Test and on the cancelled one: it is a fact about the Sample.
  const added = (await testsOf(id)).find((t) => t.method_code === lab.methods[2].code);
  assert.equal((await changesOn(added.id)).accepted_with_changes, true);
  assert.equal((await changesOn(drop.id)).accepted_with_changes, true);
});

test('changes made after the Sample is accepted do not make it accepted with changes', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await accept(id);
  await priya.ok('PUT', `/api/samples/${id}`, { description: 'Edited later', batch_no: 'B-9' });
  await priya.ok('POST', `/api/samples/${id}/tests`, { method_ids: [lab.methods[1].id] });
  const [t] = await testsOf(id);
  const c = await changesOn(t.id);
  assert.equal(c.accepted_with_changes, false);
  assert.deepEqual([c.edits, c.added_tests, c.cancelled_tests], [[], [], []]);
});

test('an edit made while the Sample was on hold counts, and so does an edit that changes nothing not', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: 'Which batch is this?' });
  await priya.ok('PUT', `/api/samples/${id}`, { batch_no: 'B-1' }); // the value it already has
  let [t] = await testsOf(id);
  await priya.ok('POST', `/api/samples/${id}/release`);
  await accept(id);
  assert.equal((await changesOn(t.id)).accepted_with_changes, false, 'writing the same value is not a change');

  const held = await receive();
  await priya.ok('POST', `/api/samples/${held}/hold`, { reason: 'Which batch is this?' });
  await priya.ok('PUT', `/api/samples/${held}`, { batch_no: 'B-77' });
  await accept(held);
  [t] = await testsOf(held);
  const c = await changesOn(t.id);
  assert.equal(c.accepted_with_changes, true);
  assert.deepEqual(c.edits.map((e) => [e.field, e.from, e.to]), [['batch_no', 'B-1', 'B-77']]);
});

test('moving a Sample in custody is not a change to the request', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await priya.ok('POST', `/api/samples/${id}/custody`, { action: 'Moved', location: 'Sample store B — shelf 4' });
  await accept(id);
  const [t] = await testsOf(id);
  assert.equal((await changesOn(t.id)).accepted_with_changes, false);
});

test('each Sample of a shipment is judged on its own', async () => {
  const priya = await staff('priya.raman');
  const res = await priya.ok('POST', '/api/samples/receive', {
    client_id: lab.acme, samples: [{ description: 'First' }, { description: 'Second' }], method_ids: [lab.methods[0].id, lab.methods[1].id],
  });
  const [first, second] = res.samples.map((s) => s.id);
  await priya.ok('PUT', `/api/samples/${second}`, { description: 'Second, corrected' });
  await accept(first);
  await accept(second);
  assert.equal((await changesOn((await testsOf(first))[0].id)).accepted_with_changes, false);
  const c = await changesOn((await testsOf(second))[1].id);
  assert.equal(c.accepted_with_changes, true);
  assert.deepEqual(c.added_tests, []);
});

test('a Sample that is not yet accepted, and a seeded one accepted as received, are not accepted with changes', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await priya.ok('PUT', `/api/samples/${id}`, { description: 'Edited while waiting' });
  const [t] = await testsOf(id);
  const waiting = await changesOn(t.id);
  assert.equal(waiting.accepted_with_changes, false, 'no decision has been taken yet');
  assert.equal(waiting.accepted_at, null);

  const [seeded] = await priya.ok('GET', '/api/tests?status=Approved&limit=1');
  assert.equal((await changesOn(seeded.id)).accepted_with_changes, false);
});

test('refused: the Test page is not shown to someone who is not signed in, and an unknown Test is 404', async () => {
  assert.equal((await session(server.base).req('GET', '/api/tests/1')).status, 401);
  assert.equal((await (await staff('tom.fletcher')).req('GET', '/api/tests/999999')).status, 404);
});
