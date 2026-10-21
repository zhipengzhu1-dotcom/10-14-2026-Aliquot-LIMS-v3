// Intake review, reject: a person with `samples.review` turns a received Sample away with a reason. The Sample and its
// open Tests are cancelled, the client is told in the Submission's thread, and the Sample leaves the intake Queue. Reject
// is stricter than cancelling a Sample: it is refused once any Test has been started. Starts a real server on a temporary
// database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-reject.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
const REASON = 'The vial arrived cracked and the contents have leaked';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-reject-test-'));
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
async function receive(description = 'Reject test') {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', { client_id: lab.client, samples: [{ description }], method_ids: [lab.kf] });
  return res.samples[0].id;
}

const detail = async (id) => (await staff('priya.raman')).ok('GET', `/api/samples/${id}`);
const reject = (who, id, body = { reason: REASON }) => who.post(`/api/samples/${id}/reject`, body);
const queued = async () => (await (await staff('priya.raman')).ok('GET', '/api/intake')).groups.flatMap((g) => g.samples.map((s) => s.id));

test('rejecting a Pending review Sample cancels it and its open Tests and takes it out of the intake Queue', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  assert.ok((await queued()).includes(id));
  assert.equal((await reject(priya, id)).status, 200);

  const { sample, tests } = await detail(id);
  assert.equal(sample.status, 'Cancelled');
  assert.ok(tests.length && tests.every((t) => t.status === 'Cancelled'));
  assert.ok(!(await queued()).includes(id), 'a rejected Sample leaves the intake Queue');
  assert.equal((await reject(priya, id)).status, 400, 'a rejected Sample cannot be rejected again');
});

test('reject is refused without a reason, and the Sample is left as it was', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  for (const body of [{}, { reason: '   ' }]) {
    const r = await reject(priya, id, body);
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'REASON_REQUIRED');
  }
  assert.equal((await detail(id)).sample.status, 'Received');
  assert.ok((await queued()).includes(id));
});

test('reject is refused for a person without samples.review, however the rest of their access reads', async () => {
  const id = await receive();
  for (const username of ['tom.fletcher', 'daniel.okafor', 'grace.holloway']) {
    const r = await reject(await staff(username), id);
    assert.equal(r.status, 403, `${username}: ${JSON.stringify(r.data)}`);
  }
  assert.equal((await detail(id)).sample.status, 'Received');
});

test('a scientist, who holds samples.review but not tests.cancel, can reject; cancelling the same Sample stays a manager’s act', async () => {
  const sarah = await staff('sarah.lindqvist');
  const id = await receive();
  assert.equal((await sarah.post(`/api/samples/${id}/cancel`, { reason: 'No' })).status, 403, 'cancel keeps its own permission');
  assert.equal((await reject(sarah, id)).status, 200);
  assert.equal((await detail(id)).sample.status, 'Cancelled');
});

test('reject is refused once a Test has been started, and once the Sample is accepted', async () => {
  const priya = await staff('priya.raman');
  const id = await receive();
  await priya.ok('POST', `/api/samples/${id}/accept`);
  const refused = await reject(priya, id);
  assert.equal(refused.status, 400, 'an accepted Sample is no longer rejected');

  const [t] = (await detail(id)).tests;
  await priya.ok('POST', '/api/tests/assign', { test_ids: [t.id], analyst_id: lab.analyst });
  await (await staff('tom.fletcher')).ok('POST', `/api/tests/${t.id}/start`);
  const started = await reject(priya, id);
  assert.equal(started.status, 400);
  assert.match(started.data.error, /started/i);
  const { sample, tests } = await detail(id);
  assert.equal(sample.status, 'In Testing');
  assert.equal(tests[0].status, 'In Progress');
  // Cancelling is not made stricter by this: a manager may still cancel the Sample once work is under way.
  assert.equal((await priya.post(`/api/samples/${id}/cancel`, { reason: 'Client withdrew the batch' })).status, 200);
});

test('the decision is audited with the person, the time and the reason', async () => {
  const id = await receive('Audit me');
  const { sample } = await detail(id);
  await reject(await staff('priya.raman'), id);
  const trail = await (await staff('daniel.okafor')).ok('GET', '/api/audit?entity=intake_decisions&limit=2000');
  const entry = trail.find((a) => a.entity_code === sample.code);
  assert.ok(entry, 'the decision is in the audit trail');
  assert.equal(entry.username, 'priya.raman');
  assert.ok(entry.at);
  assert.equal(entry.summary, 'Sample rejected at intake review');
  assert.match(JSON.stringify(entry.changes), /Rejected/);
  assert.ok(JSON.stringify(entry.changes).includes(REASON));
  const cancelled = (await (await staff('daniel.okafor')).ok('GET', '/api/audit?entity=samples&limit=2000')).find((a) => a.entity_code === sample.code && a.summary === 'Sample cancelled');
  assert.equal(cancelled?.reason, REASON);
});

// ----- The client notice -----

async function portalSession(email) {
  const s = session(server.base);
  await s.ok('POST', '/api/portal/login', { email, password: PASSWORD });
  return s;
}

test('rejecting a Sample from a Submission tells the client why in the Submission’s thread; a directly received Sample posts nothing', async () => {
  const priya = await staff('priya.raman');
  const laura = await portalSession(LAURA);
  const sub = await laura.ok('POST', '/api/portal/submissions', { samples: [{ description: 'Reject one' }, { description: 'Keep one' }], method_ids: [lab.kf] });
  const rec = await (await staff('nadia.rossi')).ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  const [first, second] = rec.samples;
  const threadId = (await laura.ok('GET', `/api/portal/submissions/${sub.id}`)).thread_id;
  const messages = async () => (await laura.ok('GET', `/api/portal/threads/${threadId}`)).messages;
  const before = (await messages()).length;

  // Refused rejects post nothing.
  assert.equal((await reject(priya, first.id, {})).status, 400);
  assert.equal((await messages()).length, before);

  assert.equal((await reject(priya, first.id)).status, 200);
  const posted = (await messages()).slice(before);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].side, 'lab');
  assert.ok(posted[0].body.includes(first.code) && posted[0].body.includes(REASON), posted[0].body);
  assert.equal((await detail(second.id)).sample.status, 'Received', 'the other Sample of the Submission is untouched');

  const threadsBefore = (await priya.ok('GET', '/api/portal-admin/threads')).length;
  const direct = await receive('Direct reject');
  assert.equal((await reject(priya, direct)).status, 200);
  assert.equal((await priya.ok('GET', '/api/portal-admin/threads')).length, threadsBefore);
});

test('the notice is posted when a scientist rejects, as it is when a manager does', async () => {
  const sarah = await staff('sarah.lindqvist');
  const laura = await portalSession(LAURA);
  const sub = await laura.ok('POST', '/api/portal/submissions', { samples: [{ description: 'Scientist reject' }], method_ids: [lab.kf] });
  const rec = await (await staff('nadia.rossi')).ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  assert.equal((await reject(sarah, rec.samples[0].id)).status, 200);
  const threadId = (await laura.ok('GET', `/api/portal/submissions/${sub.id}`)).thread_id;
  assert.ok((await laura.ok('GET', `/api/portal/threads/${threadId}`)).messages.some((m) => m.body.includes(REASON)));
});
