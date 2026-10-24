// Intake review: a received Sample waits for a person with `samples.review` to accept it before its Tests can be
// assigned or claimed. Starts a real server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake.test.js

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-test-'));
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
async function receive(description = 'Intake test') {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', { client_id: lab.client, samples: [{ description }], method_ids: [lab.kf] });
  return res.samples[0].id;
}

const detail = async (id) => (await staff('priya.raman')).ok('GET', `/api/samples/${id}`);
const assign = (who, testIds) => who.post('/api/tests/assign', { test_ids: testIds, analyst_id: lab.analyst });

test('a Sample received directly is Pending review', async () => {
  const id = await receive();
  const { sample } = await detail(id);
  assert.equal(sample.intake, 'Pending review');
  assert.equal(sample.status, 'Received', 'intake is separate from the Sample status');
});

test('a Sample received from a Submission is Pending review', async () => {
  const laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  const method = (await laura.ok('GET', '/api/portal/lookups')).methods[0].id;
  const sub = await laura.ok('POST', '/api/portal/submissions', { samples: [{ description: 'Shipment A' }, { description: 'Shipment B' }], method_ids: [method] });
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/acknowledge`, { note: 'See you tomorrow' });
  const received = await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  assert.equal(received.samples.length, 2);
  for (const s of received.samples) assert.equal((await detail(s.id)).sample.intake, 'Pending review');
});

test('Tests on a Sample that is not Accepted cannot be assigned or claimed, and the refusal names the missing step', async () => {
  const id = await receive();
  const { sample, tests, assignable, can } = await detail(id);
  const priya = await staff('priya.raman');
  const tom = await staff('tom.fletcher');

  const assigned = await assign(priya, [tests[0].id]);
  assert.equal(assigned.status, 400);
  assert.match(assigned.data.error, new RegExp(`${sample.code}.*intake review.*accept`, 'i'));
  const claimed = await tom.post(`/api/tests/${tests[0].id}/claim`);
  assert.equal(claimed.status, 400);
  assert.match(claimed.data.error, new RegExp(`${sample.code}.*intake review.*accept`, 'i'));

  assert.deepEqual(assignable, [], 'the Sample page offers no Test to assign');
  assert.equal(can.assign, false);
  assert.equal((await priya.ok('GET', `/api/tests/${tests[0].id}`)).can.assign, false);
  assert.equal((await tom.ok('GET', `/api/tests/${tests[0].id}`)).can.claim, false);
  assert.equal((await priya.ok('GET', `/api/tests/${tests[0].id}`)).test.analyst_id, null, 'nothing was assigned');
});

test('a person with samples.review accepts a Pending review Sample, and its Tests can then be assigned and claimed', async () => {
  const id = await receive();
  const priya = await staff('priya.raman');
  const before = await detail(id);
  assert.equal(before.can.accept, true);

  await priya.ok('POST', `/api/samples/${id}/accept`);
  const after = await detail(id);
  assert.equal(after.sample.intake, 'Accepted');
  assert.equal(after.can.accept, false, 'an Accepted Sample offers no second accept');
  assert.deepEqual(after.assignable, [before.tests[0].id]);

  assert.equal((await assign(priya, [before.tests[0].id])).status, 200);
  const second = await detail(await receive('Claimed'));
  await priya.ok('POST', `/api/samples/${second.sample.id}/accept`);
  assert.equal((await (await staff('tom.fletcher')).post(`/api/tests/${second.tests[0].id}/claim`)).status, 200);
});

test('accept is refused for a Sample already Accepted, for a cancelled Sample and for a person without samples.review', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();

  for (const username of ['tom.fletcher', 'grace.holloway', 'daniel.okafor']) {
    const who = await staff(username);
    assert.equal((await detail(id)).sample.intake, 'Pending review');
    const r = await who.post(`/api/samples/${id}/accept`);
    assert.deepEqual([username, r.status, r.data.code], [username, 403, 'FORBIDDEN']);
  }
  assert.equal((await detail(id)).sample.intake, 'Pending review', 'the refused accepts changed nothing');

  await priya.ok('POST', `/api/samples/${id}/accept`);
  const again = await priya.post(`/api/samples/${id}/accept`);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already accepted/i);
  assert.equal((await staff('tom.fletcher').then((c) => c.post(`/api/samples/${id}/accept`))).status, 403, 'permission is checked before state');

  const cancelled = await receive('Withdrawn');
  await priya.ok('POST', `/api/samples/${cancelled}/cancel`, { reason: 'Client withdrew the batch' });
  const r = await priya.post(`/api/samples/${cancelled}/accept`);
  assert.equal(r.status, 400);
  assert.equal((await detail(cancelled)).sample.intake, 'Pending review');
  assert.equal((await priya.post('/api/samples/99999/accept')).status, 404);
});

test('a scientist, who holds tests.assign, holds samples.review too; an analyst does not', async () => {
  const id = await receive();
  const sarah = await staff('sarah.lindqvist');
  assert.equal((await sarah.ok('GET', `/api/samples/${id}`)).can.accept, true);
  assert.equal((await (await staff('tom.fletcher')).ok('GET', `/api/samples/${id}`)).can.accept, false);
  assert.equal((await sarah.post(`/api/samples/${id}/accept`)).status, 200);
});

test('the accept decision is audited with the person and the time', async () => {
  const id = await receive();
  const sarah = await staff('sarah.lindqvist');
  const t0 = Date.now();
  await sarah.ok('POST', `/api/samples/${id}/accept`);
  const trail = await (await staff('admin')).ok('GET', `/api/audit?entity=samples&entity_id=${id}&limit=10`);
  const entry = trail.find((a) => a.changes.includes('intake'));
  assert.ok(entry, `no audit entry for the accept in ${JSON.stringify(trail)}`);
  assert.equal(entry.username, 'sarah.lindqvist');
  assert.ok(Math.abs(Date.parse(entry.at) - t0) < 60_000, 'stamped with the time of the decision');
  assert.deepEqual(JSON.parse(entry.changes).intake, ['Pending review', 'Accepted']);
  assert.match(entry.summary, /accepted/i);

  const record = (await (await staff('admin')).ok('GET', '/api/audit?entity=intake_decisions&limit=5')).find((a) => a.entity_code === entry.entity_code);
  assert.ok(record, 'the decision record itself is audited');
  assert.equal(record.username, 'sarah.lindqvist');
  assert.equal(JSON.parse(record.changes).decision[1], 'Accepted');
});
