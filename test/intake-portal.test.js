// Intake review, the client's side: the Client portal shows a Sample as awaiting review, on hold or accepted, never
// shows another client's Sample, and accepting a Sample that came in a Submission tells the client when to expect it.
// Starts a real server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-portal.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
const FELIX = 'felix.romero@bluestone-bio.example'; // Bluestone, a second client
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
async function clientSession(email) {
  const c = session(server.base);
  await c.ok('POST', '/api/portal/login', { email, password: PASSWORD });
  return c;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-portal-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  lab = {
    client: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    kf: (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    laura: await clientSession(LAURA),
    felix: await clientSession(FELIX),
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A Sample received at the front desk for Acme: it has no Submission, so no portal thread. */
async function receiveDirect(description = 'Direct arrival') {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', { client_id: lab.client, samples: [{ description }], method_ids: [lab.kf] });
  return res.samples[0].id;
}

/** An Acme Submission of `count` Samples, acknowledged and received; returns its id and its Sample ids. */
async function receiveSubmission(count = 1) {
  const method = (await lab.laura.ok('GET', '/api/portal/lookups')).methods[0].id;
  const sub = await lab.laura.ok('POST', '/api/portal/submissions', { samples: Array.from({ length: count }, (_, i) => ({ description: `Shipment sample ${i + 1}` })), method_ids: [method] });
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/acknowledge`, {});
  const received = await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  return { id: sub.id, samples: received.samples.map((s) => s.id) };
}

/** What the client sees of Sample `id` in the list and on its own page. */
async function clientView(id) {
  const listed = (await lab.laura.ok('GET', '/api/portal/samples?status=all')).find((s) => s.id === id);
  const detail = (await lab.laura.ok('GET', `/api/portal/samples/${id}`)).sample;
  assert.deepEqual(listed, detail, 'the list and the page tell the same story');
  return detail;
}

/** The messages the client sees in the thread of Submission `submissionId`. */
async function messagesOf(submissionId) {
  const thread = (await lab.laura.ok('GET', '/api/portal/threads')).find((t) => t.submission_id === submissionId);
  return (await lab.laura.ok('GET', `/api/portal/threads/${thread.id}`)).messages;
}
const acceptances = async (submissionId) => (await messagesOf(submissionId)).filter((m) => /has been accepted/.test(m.body));
const codeOf = async (id) => (await (await staff('priya.raman')).ok('GET', `/api/samples/${id}`)).sample.code;

test('the client sees a Sample awaiting review, then on hold, then accepted', async () => {
  const { samples: [id] } = await receiveSubmission();
  const priya = await staff('priya.raman');

  assert.equal((await clientView(id)).intake, 'Pending review');
  await priya.ok('POST', `/api/samples/${id}/hold`, { reason: 'Which batch is this?' });
  assert.equal((await clientView(id)).intake, 'On hold');
  await priya.ok('POST', `/api/samples/${id}/release`);
  assert.equal((await clientView(id)).intake, 'Pending review');
  await priya.ok('POST', `/api/samples/${id}/accept`);
  const accepted = await clientView(id);
  assert.equal(accepted.intake, 'Accepted');
  assert.equal(accepted.status, 'Received', 'intake is separate from the Sample status');
});

test('a rejected Sample reads as cancelled, with no intake state left over', async () => {
  const { samples: [id] } = await receiveSubmission();
  await (await staff('priya.raman')).ok('POST', `/api/samples/${id}/reject`, { reason: 'Container leaked in transit' });
  const view = await clientView(id);
  assert.equal(view.status, 'Cancelled');
  assert.equal(view.intake, null);
});

test('the client\'s Sample views carry no staff ids and none of the hold or reject reasons', async () => {
  const { id: subId, samples: [held, rejected] } = await receiveSubmission(2);
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/samples/${held}/hold`, { reason: 'SECRET-HOLD-REASON' });
  await priya.ok('POST', `/api/samples/${rejected}/reject`, { reason: 'SECRET-REJECT-REASON' });
  const views = [
    await lab.laura.ok('GET', '/api/portal/samples?status=all'),
    await lab.laura.ok('GET', `/api/portal/samples/${held}`),
    await lab.laura.ok('GET', `/api/portal/samples/${rejected}`),
    await lab.laura.ok('GET', `/api/portal/submissions/${subId}`),
  ];
  for (const view of views) {
    const body = JSON.stringify(view);
    assert.doesNotMatch(body, /SECRET-/, 'the reasons reach the client only through the portal thread');
    assert.doesNotMatch(body, /decided_by|decided_at|reviewed_by|"user_id"|intake_decisions/);
  }
  const shown = views[3].submission.received_samples.map((s) => [s.id, s.intake]);
  // The overview also quotes the newest thread message, which is where the client is meant to read the reason.
  assert.doesNotMatch(JSON.stringify((await lab.laura.ok('GET', '/api/portal/overview')).inProgress), /SECRET-|decided_by/);
  assert.deepEqual(shown, [[held, 'On hold'], [rejected, null]], 'the Submission page tells the same story');
});

test('another client cannot see the Sample or its intake state', async () => {
  const { samples: [id] } = await receiveSubmission();
  const felix = lab.felix;
  assert.equal((await felix.get(`/api/portal/samples/${id}`)).status, 404);
  assert.equal((await felix.get(`/api/portal/samples/${id}/coa`)).status, 404);
  const listed = await felix.ok('GET', '/api/portal/samples?status=all');
  assert.ok(!listed.some((s) => s.id === id), 'not in the other client\'s list');
  assert.ok(!JSON.stringify(await felix.ok('GET', '/api/portal/overview')).includes(`"id":${id},`), 'nor on the overview');
  assert.equal((await session(server.base).get(`/api/portal/samples/${id}`)).status, 401, 'signed out is refused too');
});

test('accepting a Sample from a Submission tells the client, with the expected due date, in the Submission\'s thread', async () => {
  const { id: subId, samples: [id] } = await receiveSubmission();
  const priya = await staff('priya.raman');
  const { sample } = await priya.ok('GET', `/api/samples/${id}`);
  assert.equal((await acceptances(subId)).length, 0, 'nothing before the decision');

  await priya.ok('POST', `/api/samples/${id}/accept`);
  const [message, ...rest] = await acceptances(subId);
  assert.equal(rest.length, 0);
  assert.equal(message.side, 'lab');
  assert.equal(message.author_name, 'Priya Raman');
  assert.ok(message.body.startsWith(`${sample.code} has been accepted`), message.body);
  const long = new Date(`${sample.due_date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  assert.ok(message.body.includes(`Expected completion ${long}`), message.body);
});

test('accepting from hold posts the same notice, and hold and reject keep their wording', async () => {
  const { id: subId, samples: [held, rejected] } = await receiveSubmission(2);
  const priya = await staff('priya.raman');
  const [heldCode, rejectedCode] = [await codeOf(held), await codeOf(rejected)];
  await priya.ok('POST', `/api/samples/${held}/hold`, { reason: 'Which batch?' });
  await priya.ok('POST', `/api/samples/${held}/accept`);
  await priya.ok('POST', `/api/samples/${rejected}/reject`, { reason: 'Leaked' });
  // The system notice that the box arrived names every Sample, so only the lab's own messages count.
  const bodies = (await messagesOf(subId)).filter((m) => m.side === 'lab').map((m) => m.body).filter((b) => b.includes(heldCode) || b.includes(rejectedCode));
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0], `Question about ${heldCode}, which is on hold until we hear from you: Which batch?`);
  assert.match(bodies[1], new RegExp(`^${heldCode} has been accepted`));
  assert.equal(bodies[2], `${rejectedCode} has been rejected and will not be tested. Reason: Leaked`);
});

test('a refused accept posts nothing', async () => {
  const { id: subId, samples: [id] } = await receiveSubmission();
  const tom = await staff('tom.fletcher');
  assert.equal((await tom.post(`/api/samples/${id}/accept`)).status, 403);
  assert.equal((await acceptances(subId)).length, 0, 'forbidden, nothing posted');
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/samples/${id}/accept`);
  assert.equal((await priya.post(`/api/samples/${id}/accept`)).status, 400);
  assert.equal((await acceptances(subId)).length, 1, 'accepting twice posts once');
});

test('bulk accept posts one notice for each Sample it accepts and none for one it refuses', async () => {
  const { id: subId, samples: [a, b, c] } = await receiveSubmission(3);
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/samples/${b}/accept`);
  const res = await priya.ok('POST', '/api/samples/accept', { sample_ids: [a, b, c] });
  assert.equal(res.accepted, 2);
  assert.equal(res.refused, 1, 'b was already accepted');
  const notices = await acceptances(subId);
  assert.equal(notices.length, 3, 'b once on its own, a and c in the bulk');
  for (const id of [a, b, c]) {
    const code = await codeOf(id);
    assert.equal(notices.filter((m) => m.body.startsWith(`${code} has been accepted`)).length, 1, code);
  }
});

test('accepting a directly received Sample posts no message and makes no thread', async () => {
  const id = await receiveDirect();
  const priya = await staff('priya.raman');
  const threadsBefore = (await lab.laura.ok('GET', '/api/portal/threads')).length;
  const staffThreadsBefore = (await priya.ok('GET', '/api/portal-admin/threads')).length;
  await priya.ok('POST', `/api/samples/${id}/accept`);
  assert.equal((await lab.laura.ok('GET', '/api/portal/threads')).length, threadsBefore);
  assert.equal((await priya.ok('GET', '/api/portal-admin/threads')).length, staffThreadsBefore);
  assert.equal((await clientView(id)).intake, 'Accepted', 'the client still sees it accepted in the Sample views');
});
