// Intake review, the Receiving & Review Queue: Samples waiting for a decision, grouped by Submission, with the
// actions each person is offered, a sidebar badge, and bulk accept with an outcome for every Sample. Starts a real
// server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-queue.test.js

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-queue-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const clients = await priya.ok('GET', '/api/clients');
  lab = {
    acme: clients.find((c) => c.code === 'ACME').id,
    other: clients.find((c) => c.code !== 'ACME').id,
    kf: (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    analyst: (await priya.ok('GET', '/api/users')).find((u) => u.username === 'tom.fletcher').id,
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Samples received at the front desk, each with one Karl Fischer Test; they wait for intake review. Returns their ids. */
async function receive(descriptions = ['Queue test'], extra = {}) {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', {
    client_id: lab.acme, samples: descriptions.map((description) => ({ description })), method_ids: [lab.kf], ...extra,
  });
  return res.samples.map((s) => s.id);
}

/** A client Submission of `descriptions`, acknowledged and received. Returns its code and the Sample ids. */
async function receiveSubmission(descriptions) {
  const laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  const method = (await laura.ok('GET', '/api/portal/lookups')).methods[0].id;
  const sub = await laura.ok('POST', '/api/portal/submissions', { samples: descriptions.map((description) => ({ description })), method_ids: [method] });
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/acknowledge`, { note: 'See you tomorrow' });
  const received = await priya.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, {});
  const detail = await priya.ok('GET', `/api/portal-admin/submissions/${sub.id}`);
  return { id: sub.id, code: detail.submission.code, ids: received.samples.map((s) => s.id) };
}

const queue = (who, query = '') => who.ok('GET', `/api/intake${query}`);
const samplesOf = (q) => q.groups.flatMap((g) => g.samples);
const idsOf = (q) => samplesOf(q).map((s) => s.id);
const intakeOf = async (id) => (await (await staff('priya.raman')).ok('GET', `/api/samples/${id}`)).sample.intake;
const badge = async (who) => (await who.ok('GET', '/api/nav')).intake;

test('the Queue lists Pending review Samples grouped by Submission, each with the actions the person is offered', async () => {
  const sub = await receiveSubmission(['Shipment A', 'Shipment B']);
  const [direct] = await receive(['Walk-in']);
  const priya = await staff('priya.raman');
  const q = await queue(priya);

  const group = q.groups.find((g) => g.submission?.id === sub.id);
  assert.ok(group, 'the Submission is a group');
  assert.equal(group.submission.code, sub.code);
  assert.deepEqual(group.samples.map((s) => s.id).sort(), [...sub.ids].sort());
  const walkIn = q.groups.find((g) => g.samples.some((s) => s.id === direct));
  assert.equal(walkIn.submission, null, 'a Sample received directly belongs to no Submission');

  for (const s of samplesOf(q)) {
    assert.equal(s.intake, 'Pending review');
    assert.equal(s.can.accept, true, `${s.code} can.accept`);
    assert.equal(s.locks.accept, null);
    assert.ok(s.client_name && s.test_count >= 1 && s.due_date && s.priority && s.received_at, 'the columns the screen shows');
  }
  assert.equal(q.counts.pending, idsOf(q).length);
});

test('a Sample leaves Pending review when accepted, and then waits under Ready to assign', async () => {
  const [id] = await receive(['Will be accepted']);
  const priya = await staff('priya.raman');
  assert.ok(idsOf(await queue(priya)).includes(id));
  assert.ok(!idsOf(await queue(priya, '?tab=ready')).includes(id), 'not ready to assign before it is accepted');

  await priya.ok('POST', `/api/samples/${id}/accept`);
  assert.ok(!idsOf(await queue(priya)).includes(id));
  const ready = await queue(priya, '?tab=ready');
  const s = samplesOf(ready).find((x) => x.id === id);
  assert.ok(s, 'an Accepted Sample with Tests to assign is Ready to assign');
  assert.equal(s.can.assign, true);
  assert.equal(s.can.accept, false);
  assert.match(s.locks.accept, /already accepted/i, 'the screen can say why accept is disabled');

  await priya.ok('POST', '/api/tests/assign', { test_ids: (await priya.ok('GET', `/api/samples/${id}`)).assignable, analyst_id: lab.analyst });
  assert.ok(!idsOf(await queue(priya, '?tab=ready')).includes(id), 'every Test assigned: nothing left to assign');
});

test('the Queue never lists a cancelled Sample, and the On hold tab is empty while nothing is held', async () => {
  const [id] = await receive(['Withdrawn']);
  const priya = await staff('priya.raman');
  await priya.ok('POST', `/api/samples/${id}/cancel`, { reason: 'Client withdrew the batch' });
  assert.equal(await intakeOf(id), 'Pending review');
  assert.ok(!idsOf(await queue(priya)).includes(id));
  assert.deepEqual((await queue(priya, '?tab=hold')).groups, []);
  const unknown = await priya.get('/api/intake?tab=archive');
  assert.equal(unknown.status, 400);
});

test('a person without samples.review sees an empty Queue and an empty badge', async () => {
  await receive(['Unseen']);
  for (const username of ['tom.fletcher', 'grace.holloway', 'daniel.okafor']) {
    const who = await staff(username);
    for (const tab of ['pending', 'hold', 'ready']) {
      const q = await queue(who, `?tab=${tab}`);
      assert.deepEqual([username, tab, q.groups], [username, tab, []]);
    }
    assert.deepEqual([username, (await queue(who)).counts], [username, { pending: 0, hold: 0, ready: 0 }]);
    assert.equal(await badge(who), 0, `${username} badge`);
  }
});

test('a scientist, who holds samples.review, sees the same Queue as the manager', async () => {
  const [id] = await receive(['For Sarah']);
  assert.ok(idsOf(await queue(await staff('sarah.lindqvist'))).includes(id));
});

test('the Queue is sorted by due date, then priority', async () => {
  const [late] = await receive(['Sorted late'], { due_date: '2031-03-10', priority: 'Same day' });
  const [earlyLow] = await receive(['Sorted early low'], { due_date: '2031-03-01', priority: 'One week' });
  const [earlyHigh] = await receive(['Sorted early high'], { due_date: '2031-03-01', priority: 'Same day' });
  const ids = idsOf(await queue(await staff('priya.raman')));
  assert.ok(ids.indexOf(earlyHigh) >= 0 && ids.indexOf(earlyHigh) < ids.indexOf(earlyLow) && ids.indexOf(earlyLow) < ids.indexOf(late));
});

test('the sidebar badge counts the Samples waiting for the signed-in person, and moves on receipt and accept', async () => {
  const priya = await staff('priya.raman');
  const before = await badge(priya);
  const ids = await receive(['Badge 1', 'Badge 2']);
  assert.equal(await badge(priya), before + 2);
  await priya.ok('POST', `/api/samples/${ids[0]}/accept`);
  assert.equal(await badge(priya), before + 1);
  assert.equal(await badge(priya), (await queue(priya)).counts.pending + (await queue(priya)).counts.hold);
});

test('the Queue filters by client, priority and overdue, and searches by Sample, batch, client reference and client name', async () => {
  const priya = await staff('priya.raman');
  const body = (extra, samples) => priya.ok('POST', '/api/samples/receive', { samples, method_ids: [lab.kf], ...extra });
  const mine = (await body({ client_id: lab.acme, priority: 'Same day', due_date: '2020-01-02' }, [{ description: 'Filter overdue', batch_no: 'BATCH-ZQ-1', client_ref: 'REF-ZQ-9' }])).samples[0];
  const other = (await body({ client_id: lab.other, priority: 'One week' }, [{ description: 'Filter other client' }])).samples[0];

  const by = async (query) => idsOf(await queue(priya, query));
  assert.ok((await by(`?client_id=${lab.other}`)).includes(other.id));
  assert.ok(!(await by(`?client_id=${lab.other}`)).includes(mine.id));
  assert.deepEqual((await by('?priority=Same+day')).includes(other.id), false);
  assert.ok((await by('?priority=Same+day')).includes(mine.id));
  assert.ok((await by('?overdue=1')).includes(mine.id));
  assert.ok(!(await by('?overdue=1')).includes(other.id));
  for (const term of ['BATCH-ZQ-1', 'REF-ZQ-9', mine.code.toLowerCase()]) assert.deepEqual(await by(`?q=${term}`), [mine.id], `search for ${term}`);
  const clientName = (await priya.ok('GET', `/api/samples/${other.id}`)).sample.client_name;
  assert.ok((await by(`?q=${encodeURIComponent(clientName)}`)).includes(other.id));
  assert.deepEqual(await by('?q=nothing-matches-this'), []);
});

test('bulk accept applies the rule to each Sample and reports every outcome, so one refusal blocks no one', async () => {
  const priya = await staff('priya.raman');
  const [a, b, done, withdrawn] = await receive(['Bulk A', 'Bulk B', 'Bulk done', 'Bulk withdrawn']);
  await priya.ok('POST', `/api/samples/${done}/accept`);
  await priya.ok('POST', `/api/samples/${withdrawn}/cancel`, { reason: 'Client withdrew the batch' });

  const r = await priya.post('/api/samples/accept', { sample_ids: [a, done, withdrawn, 999999, b] });
  assert.equal(r.status, 200);
  const outcome = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
  assert.deepEqual(r.data.results.map((x) => x.id), [a, done, withdrawn, 999999, b], 'one outcome per Sample, in the order asked');
  assert.equal(outcome[a].ok, true);
  assert.equal(outcome[b].ok, true);
  assert.equal(outcome[done].ok, false);
  assert.match(outcome[done].error, /already accepted/i);
  assert.equal(outcome[withdrawn].ok, false);
  assert.equal(outcome[999999].ok, false);
  assert.equal(outcome[999999].status, 404);
  assert.deepEqual([r.data.accepted, r.data.refused], [2, 3]);

  assert.deepEqual([await intakeOf(a), await intakeOf(b), await intakeOf(withdrawn)], ['Accepted', 'Accepted', 'Pending review']);
  const trail = await (await staff('admin')).ok('GET', `/api/audit?entity=samples&entity_id=${a}&limit=10`);
  assert.equal(trail.find((e) => e.changes.includes('intake')).username, 'priya.raman', 'each accept is audited under the person');
});

test('bulk accept is refused per Sample for a person without samples.review, and changes nothing', async () => {
  const [id] = await receive(['Bulk forbidden']);
  const tom = await staff('tom.fletcher');
  const r = await tom.post('/api/samples/accept', { sample_ids: [id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => [x.id, x.ok, x.status]), [[id, false, 403]]);
  assert.equal(await intakeOf(id), 'Pending review');

  const priya = await staff('priya.raman');
  assert.equal((await priya.post('/api/samples/accept', { sample_ids: [] })).status, 400);
  assert.equal((await priya.post('/api/samples/accept', {})).status, 400);
});

test('Tests on a Sample waiting for review are not counted as unassigned work, and are once it is accepted', async () => {
  const priya = await staff('priya.raman');
  const [id] = await receive(['Unassigned gap']);
  const { tests } = await priya.ok('GET', `/api/samples/${id}`);
  const unassigned = async () => (await priya.ok('GET', '/api/tests?unassigned=1&limit=3000')).map((t) => t.id);
  const counts = async () => [(await priya.ok('GET', '/api/dashboard')).kpis.unassigned, (await priya.ok('GET', '/api/workload')).unassigned];

  const before = await counts();
  assert.ok(!(await unassigned()).includes(tests[0].id), 'the Worklist Unassigned view leaves it out');
  await priya.ok('POST', `/api/samples/${id}/accept`);
  assert.ok((await unassigned()).includes(tests[0].id));
  assert.deepEqual(await counts(), before.map((n) => n + 1), 'the Dashboard and Workload counts include it once accepted');
});

test('an analyst\'s Worklist lists no Test of a Sample that is Pending review or On hold, and lists it once accepted', async () => {
  const priya = await staff('priya.raman');
  const tom = await staff('tom.fletcher');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [pending, held] = await receive(['Worklist pending', 'Worklist held'], { due_date: yesterday });
  await priya.ok('POST', `/api/samples/${held}/hold`, { reason: 'Which batch is this?' });
  const testsOf = async (id) => (await priya.ok('GET', `/api/samples/${id}`)).tests.map((t) => t.id);
  const [pendingTest] = await testsOf(pending);
  const [heldTest] = await testsOf(held);

  const listed = async (query) => (await tom.ok('GET', `/api/tests?${query}&limit=3000`)).map((t) => t.id);
  for (const query of ['scope=open', 'scope=open&overdue=1', 'overdue=1', 'unassigned=1', 'work=assigned', `scope=open&method_id=${lab.kf}`]) {
    const ids = await listed(query);
    assert.ok(!ids.includes(pendingTest), `${query} leaves out a Test of a Pending review Sample`);
    assert.ok(!ids.includes(heldTest), `${query} leaves out a Test of an On hold Sample`);
  }
  assert.ok((await listed('scope=open')).length > 0, 'the Worklist still lists work on accepted Samples');

  await priya.ok('POST', `/api/samples/${pending}/accept`);
  assert.ok((await listed('scope=open')).includes(pendingTest), 'listed once accepted');
  assert.ok((await listed('overdue=1')).includes(pendingTest));
  assert.ok(!(await listed('scope=open')).includes(heldTest), 'the held Sample stays out');
});
