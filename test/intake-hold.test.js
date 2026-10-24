// Intake review: hold a Pending review Sample with a reason the client is asked in the Submission's portal thread, and
// release it again or accept it directly. Starts a real server on a temporary database with the demo lab and drives it
// over HTTP. Run with:  node --test test/intake-hold.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
const REASON = 'The label is smudged: which batch is this?';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-hold-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  lab = {
    client: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    kf: (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    analyst: (await priya.ok('GET', '/api/users')).find((u) => u.username === 'tom.fletcher').id,
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A Sample received at the front desk with one Karl Fischer Test; it waits for intake review. */
async function receive(description = 'Hold test') {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', { client_id: lab.client, samples: [{ description }], method_ids: [lab.kf] });
  return res.samples[0].id;
}

/** A client Submission of two Samples, acknowledged and received; returns its id, its Sample ids and the client's session. */
async function receiveSubmission() {
  const laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  const method = (await laura.ok('GET', '/api/portal/lookups')).methods[0].id;
  const sub = await laura.ok('POST', '/api/portal/submissions', { samples: [{ description: 'Shipment A' }, { description: 'Shipment B' }], method_ids: [method] });
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/acknowledge`, {});
  const received = await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  return { id: sub.id, samples: received.samples.map((s) => s.id), laura };
}

const detail = async (id) => (await staff('priya.raman')).ok('GET', `/api/samples/${id}`);
const intakeOf = async (id) => (await detail(id)).sample.intake;
/** The messages the client sees in the thread of Submission `submissionId`. */
async function messagesOf(laura, submissionId) {
  const thread = (await laura.ok('GET', '/api/portal/threads')).find((t) => t.submission_id === submissionId);
  return (await laura.ok('GET', `/api/portal/threads/${thread.id}`)).messages;
}

test('holding a Pending review Sample needs a reason, moves it to the On hold tab and keeps its Tests unassignable', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');
  const { tests } = await detail(id);

  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const r = await priya.post(`/api/samples/${id}/hold`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, /reason/i);
  }
  assert.equal(await intakeOf(id), 'Pending review', 'the refused holds changed nothing');

  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  const held = await detail(id);
  assert.equal(held.sample.intake, 'On hold');
  assert.equal(held.sample.status, 'Received', 'intake is separate from the Sample status');
  assert.equal(held.can.hold, false);
  assert.equal(held.can.release, true);
  assert.equal(held.can.accept, true, 'a held Sample can still be accepted directly');

  const hold = await priya.ok('GET', '/api/intake?tab=hold');
  assert.deepEqual(hold.groups.flatMap((g) => g.samples.map((s) => s.id)), [id]);
  assert.equal(hold.groups[0].samples[0].can.release, true);
  assert.match(hold.groups[0].samples[0].locks.hold, /already on hold/i);
  const pending = await priya.ok('GET', '/api/intake?tab=pending');
  assert.ok(!pending.groups.flatMap((g) => g.samples.map((s) => s.id)).includes(id), 'no longer on the Pending review tab');
  assert.equal(pending.counts.hold, 1);

  const assigned = await priya.post('/api/tests/assign', { test_ids: [tests[0].id], analyst_id: lab.analyst });
  assert.equal(assigned.status, 400, 'a held Sample\'s Tests cannot be assigned');
  assert.equal((await (await staff('tom.fletcher')).post(`/api/tests/${tests[0].id}/claim`)).status, 400);
});

test('hold is allowed only from Pending review and release only from On hold', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');

  const early = await priya.post(`/api/samples/${id}/release`);
  assert.equal(early.status, 400);
  assert.match(early.data.error, /not on hold/i);

  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  const twice = await priya.post(`/api/samples/${id}/hold`, { reason: 'Again' });
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already on hold/i);

  await priya.ok('POST', `/api/samples/${id}/release`);
  assert.equal(await intakeOf(id), 'Pending review');
  assert.equal((await priya.post(`/api/samples/${id}/release`)).status, 400, 'a released Sample is not on hold');

  await priya.ok('POST', `/api/samples/${id}/accept`);
  for (const action of ['hold', 'release']) {
    assert.equal((await priya.post(`/api/samples/${id}/${action}`, { reason: REASON })).status, 400, `${action} on an Accepted Sample`);
  }
  assert.equal(await intakeOf(id), 'Accepted');

  const cancelled = await receive('Withdrawn');
  await priya.ok('POST', `/api/samples/${cancelled}/cancel`, { reason: 'Client withdrew the batch' });
  assert.equal((await priya.post(`/api/samples/${cancelled}/hold`, { reason: REASON })).status, 400);
  assert.equal((await priya.post('/api/samples/99999/hold', { reason: REASON })).status, 404);
  assert.equal((await priya.post('/api/samples/99999/release')).status, 404);
});

test('a held Sample is accepted directly, and its Tests can then be assigned', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  await priya.ok('POST', `/api/samples/${id}/accept`);
  const after = await detail(id);
  assert.equal(after.sample.intake, 'Accepted');
  assert.deepEqual(after.assignable, [after.tests[0].id]);
  assert.equal((await priya.post('/api/tests/assign', { test_ids: [after.tests[0].id], analyst_id: lab.analyst })).status, 200);
});

test('every action is forbidden for a person without samples.review, before the state or the reason is looked at', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');
  for (const username of ['tom.fletcher', 'grace.holloway', 'daniel.okafor']) {
    const who = await staff(username);
    for (const [action, body] of [['hold', { reason: REASON }], ['hold', {}], ['release', {}]]) {
      const r = await who.post(`/api/samples/${id}/${action}`, body);
      assert.deepEqual([username, action, r.status, r.data.code], [username, action, 403, 'FORBIDDEN']);
    }
  }
  assert.equal(await intakeOf(id), 'Pending review');
  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  const tom = await staff('tom.fletcher');
  assert.equal((await tom.post(`/api/samples/${id}/release`)).status, 403);
  assert.equal(await intakeOf(id), 'On hold');
  assert.equal((await tom.ok('GET', '/api/intake?tab=hold')).groups.length, 0, 'no permission, an empty Queue');
});

test('holding a Sample of a Submission asks the client in the Submission thread as the person who held it; releasing posts nothing', async () => {
  const sub = await receiveSubmission();
  const [held, other] = sub.samples;
  const sarah = await staff('sarah.lindqvist');
  const before = (await messagesOf(sub.laura, sub.id)).length;
  const code = (await detail(held)).sample.code;

  await sarah.ok('POST', `/api/samples/${held}/hold`, { reason: REASON });
  const posted = (await messagesOf(sub.laura, sub.id)).slice(before);
  assert.equal(posted.length, 1, 'exactly one message');
  assert.ok(posted[0].body.includes(REASON));
  assert.ok(posted[0].body.includes(code), 'names the Sample, since a thread covers the whole Submission');
  assert.equal(posted[0].author_name, 'Sarah Lindqvist');
  assert.equal(posted[0].side, 'lab');
  assert.equal(posted[0].kind, 'message', 'a question from a person, not a system notice');
  assert.equal(await intakeOf(other), 'Pending review', 'the Submission\'s other Sample is untouched');

  await sarah.ok('POST', `/api/samples/${held}/release`);
  assert.equal((await messagesOf(sub.laura, sub.id)).length, before + 1, 'release posts nothing');
});

test('a refused hold posts nothing to the thread', async () => {
  const sub = await receiveSubmission();
  const before = (await messagesOf(sub.laura, sub.id)).length;
  assert.equal((await (await staff('priya.raman')).post(`/api/samples/${sub.samples[0]}/hold`, { reason: '' })).status, 400);
  assert.equal((await (await staff('tom.fletcher')).post(`/api/samples/${sub.samples[0]}/hold`, { reason: REASON })).status, 403);
  assert.equal((await messagesOf(sub.laura, sub.id)).length, before);
});

test('a Sample received directly is held with no client message', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');
  const threads = (await priya.ok('GET', '/api/portal-admin/threads')).length;
  const messages = async () => (await priya.ok('GET', '/api/portal-admin/threads')).map((t) => `${t.id}:${t.last_message_at}`);
  const before = await messages();
  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  assert.equal(await intakeOf(id), 'On hold');
  assert.equal((await priya.ok('GET', '/api/portal-admin/threads')).length, threads, 'no thread was made');
  assert.deepEqual(await messages(), before, 'no thread was written to');
});

test('hold, release and the reason are audited with the person and the time', async () => {
  const id = await receive();
  const sarah = await staff('sarah.lindqvist');
  const admin = await staff('admin');
  const t0 = Date.now();
  await sarah.ok('POST', `/api/samples/${id}/hold`, { reason: REASON });
  await sarah.ok('POST', `/api/samples/${id}/release`);

  const trail = (await admin.ok('GET', `/api/audit?entity=samples&entity_id=${id}&limit=10`)).filter((a) => JSON.parse(a.changes).intake?.[0]);
  assert.equal(trail.length, 2, 'the receipt, which has no earlier intake state, is not a decision');
  const [release, hold] = trail;
  assert.deepEqual(JSON.parse(hold.changes).intake, ['Pending review', 'On hold']);
  assert.deepEqual(JSON.parse(release.changes).intake, ['On hold', 'Pending review']);
  assert.equal(hold.reason, REASON);
  for (const entry of trail) {
    assert.equal(entry.username, 'sarah.lindqvist');
    assert.ok(Math.abs(Date.parse(entry.at) - t0) < 60_000, 'stamped with the time of the decision');
  }
  assert.match(hold.summary, /hold/i);
  assert.match(release.summary, /release/i);

  const records = (await admin.ok('GET', '/api/audit?entity=intake_decisions&limit=50')).filter((a) => a.entity_code === hold.entity_code);
  assert.deepEqual(records.map((a) => JSON.parse(a.changes).decision[1]).sort(), ['Held', 'Released']);
  assert.ok(records.every((a) => a.username === 'sarah.lindqvist'));
});
