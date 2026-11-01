// Samples list work filters: "assigned", "review" and "approval", evaluated for the signed-in user.
// Starts a real server on a temporary database with the demo lab and drives Tests into each state over HTTP.
// Run with:  npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

let BASE;
const PASSWORD = 'demo1234';
let server;
let dataDir;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'X-Requested-With': 'aliquot', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(url) { return this.req('GET', url); }
  post(url, body = {}) { return this.req('POST', url, body); }
  put(url, body = {}) { return this.req('PUT', url, body); }
  async ok(method, url, body) {
    const r = await this.req(method, url, body);
    assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

async function as(username) {
  const c = new Client();
  await c.ok('POST', '/api/auth/login', { username, password: PASSWORD });
  return c;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-test-'));
  server = await startServer(dataDir);
  BASE = server.base;
  const setup = await new Client().post('/api/setup', { mode: 'demo' });
  assert.equal(setup.status, 200, `demo setup failed: ${JSON.stringify(setup.data)} ${server.log()}`);
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// One HPLC assay sample per scenario, so each sample's single Test is the only thing that can make it match.
const lab = {};

async function setupLab() {
  if (lab.ready) return lab;
  const priya = await as('priya.raman');
  const clients = await priya.ok('GET', '/api/clients');
  lab.acme = clients.find((c) => c.code === 'ACME');
  lab.other = clients.find((c) => c.code !== 'ACME');
  const methods = await priya.ok('GET', '/api/methods?usable=1');
  lab.hplc = methods.find((m) => m.code === 'ATM-0001' && m.status === 'Effective');
  // Tom is not qualified on ATM-0003.
  lab.unqualified = methods.find((m) => m.code === 'ATM-0003' && m.status === 'Effective');
  lab.users = Object.fromEntries((await priya.ok('GET', '/api/users')).map((u) => [u.username, u]));
  lab.ready = true;
  return lab;
}

async function receive(client = lab.acme, { method = lab.hplc, accept = true } = {}) {
  const priya = await as('priya.raman');
  const { samples } = await priya.ok('POST', '/api/samples/receive', {
    client_id: client.id, sample_type: 'Drug Product', storage: 'Ambient (15–25 °C)', priority: 'One week',
    samples: [{ description: 'Work filter sample' }], method_ids: [method.id],
  });
  if (accept) await priya.ok('POST', `/api/samples/${samples[0].id}/accept`);
  const detail = await priya.ok('GET', `/api/samples/${samples[0].id}`);
  return { id: samples[0].id, testId: detail.tests[0].id };
}

async function assign(s, username) {
  const priya = await as('priya.raman');
  await priya.ok('POST', '/api/tests/assign', { test_ids: [s.testId], analyst_id: lab.users[username].id });
}

const inSpec = (r) => (r.spec_min != null && r.spec_max != null ? (r.spec_min + r.spec_max) / 2 : r.spec_max != null ? r.spec_max / 2 : (r.spec_min ?? 0) + 1);

async function perform(s, username) {
  await assign(s, username);
  const analyst = await as(username);
  const d = await analyst.ok('GET', `/api/tests/${s.testId}`);
  const instrument = d.instruments.find((i) => !i.problem && i.code.startsWith('HPLC'));
  await analyst.ok('PUT', `/api/tests/${s.testId}`, { instrument_id: instrument.id, results: d.results.map((r) => ({ id: r.id, value: String(inSpec(r)) })) });
  await analyst.ok('POST', `/api/tests/${s.testId}/submit`, { password: PASSWORD });
}

async function review(s, username) {
  await (await as(username)).ok('POST', `/api/tests/${s.testId}/review`, { decision: 'approve', password: PASSWORD });
}

const ids = async (c, query) => new Set((await c.ok('GET', `/api/samples?limit=2000&${query}`)).map((s) => s.id));
const testIds = async (c, query) => new Set((await c.ok('GET', `/api/tests?limit=3000&${query}`)).map((t) => t.id));

/** A Test the analyst started and that was then unassigned before any result was entered: In Progress, with no analyst. */
async function startedThenUnassigned() {
  const s = await receive();
  await assign(s, 'tom.fletcher');
  await (await as('tom.fletcher')).ok('POST', `/api/tests/${s.testId}/start`);
  await (await as('priya.raman')).ok('POST', '/api/tests/assign', { test_ids: [s.testId], analyst_id: null });
  const { test: t } = await (await as('priya.raman')).ok('GET', `/api/tests/${s.testId}`);
  assert.deepEqual([t.status, t.analyst_id], ['In Progress', null]);
  return s;
}

test('analyst "assigned" lists samples with their unfinished Tests only', async () => {
  await setupLab();
  const pending = await receive();
  await assign(pending, 'tom.fletcher');
  const started = await receive();
  await assign(started, 'tom.fletcher');
  const tom = await as('tom.fletcher');
  const d = await tom.ok('GET', `/api/tests/${started.testId}`);
  await tom.ok('PUT', `/api/tests/${started.testId}`, { results: [{ id: d.results[0].id, value: String(inSpec(d.results[0])) }] });
  assert.equal((await tom.ok('GET', `/api/tests/${started.testId}`)).test.status, 'In Progress');
  const others = await receive();
  await assign(others, 'lucia.fernandez');
  const unassigned = await receive();
  const submitted = await receive();
  await perform(submitted, 'tom.fletcher');

  const mine = await ids(tom, 'work=assigned');
  assert.ok(mine.has(pending.id), 'Pending Test assigned to me');
  assert.ok(mine.has(started.id), 'In Progress Test assigned to me');
  assert.ok(!mine.has(others.id), 'Test assigned to someone else');
  assert.ok(!mine.has(unassigned.id), 'unassigned Test');
  assert.ok(!mine.has(submitted.id), 'Test I already submitted');
});

test('senior scientist "review" lists Submitted Tests by other people, not their own', async () => {
  await setupLab();
  const byTom = await receive();
  await perform(byTom, 'tom.fletcher');
  const bySarah = await receive();
  await perform(bySarah, 'sarah.lindqvist');
  const notSubmitted = await receive();
  await assign(notSubmitted, 'tom.fletcher');
  const reviewed = await receive();
  await perform(reviewed, 'tom.fletcher');
  await review(reviewed, 'priya.raman');

  const sarah = await as('sarah.lindqvist');
  const toReview = await ids(sarah, 'work=review');
  assert.ok(toReview.has(byTom.id), 'Submitted by someone else');
  assert.ok(!toReview.has(bySarah.id), 'my own submission');
  assert.ok(!toReview.has(notSubmitted.id), 'not yet submitted');
  assert.ok(!toReview.has(reviewed.id), 'already reviewed');

  // Same rule as the Reviews queue.
  const queue = await sarah.ok('GET', '/api/reviews');
  assert.deepEqual(toReview, new Set(queue.toReview.map((t) => t.sample_id)));
});

test('QA "approval" lists Reviewed Tests they neither performed nor reviewed', async () => {
  await setupLab();
  const reviewedBySarah = await receive();
  await perform(reviewedBySarah, 'tom.fletcher');
  await review(reviewedBySarah, 'sarah.lindqvist');
  const reviewedByDaniel = await receive();
  await perform(reviewedByDaniel, 'tom.fletcher');
  await review(reviewedByDaniel, 'daniel.okafor');
  const submitted = await receive();
  await perform(submitted, 'tom.fletcher');

  const daniel = await as('daniel.okafor');
  const toApprove = await ids(daniel, 'work=approval');
  assert.ok(toApprove.has(reviewedBySarah.id), 'Reviewed by someone else');
  assert.ok(!toApprove.has(reviewedByDaniel.id), 'Test I reviewed');
  assert.ok(!toApprove.has(submitted.id), 'not yet reviewed');
  assert.deepEqual(toApprove, new Set((await daniel.ok('GET', '/api/reviews')).toApprove.map((t) => t.sample_id)));

  // A Lab Manager can perform and approve, but never approve their own Test.
  const performedByPriya = await receive();
  await perform(performedByPriya, 'priya.raman');
  await review(performedByPriya, 'sarah.lindqvist');
  const priya = await as('priya.raman');
  assert.ok(!(await ids(priya, 'work=approval')).has(performedByPriya.id), 'Test I performed');
  assert.ok((await ids(daniel, 'work=approval')).has(performedByPriya.id), 'performed by someone else');
});

test('manager "assignable" lists the Tests they may assign or reassign, and unassigned=1 limits it to those nobody holds', async () => {
  await setupLab();
  const pending = await receive();
  const started = await startedThenUnassigned();
  const taken = await receive();
  await assign(taken, 'tom.fletcher');
  const priya = await as('priya.raman');

  const assignable = await testIds(priya, 'work=assignable');
  assert.ok(assignable.has(taken.testId), 'a Test assigned to someone can be reassigned');
  const unassigned = await testIds(priya, 'work=assignable&unassigned=1');
  assert.ok(unassigned.has(pending.testId), 'Pending Test with no analyst');
  assert.ok(unassigned.has(started.testId), 'In Progress Test with no analyst');
  assert.ok(!unassigned.has(taken.testId), 'Test assigned to someone');
});

test('analyst "claimable" lists only the Pending Tests with no analyst they are qualified to pick up', async () => {
  await setupLab();
  const qualified = await receive();
  const unqualified = await receive(lab.acme, { method: lab.unqualified });
  const started = await startedThenUnassigned();
  const notAccepted = await receive(lab.acme, { accept: false });

  const claimable = await testIds(await as('tom.fletcher'), 'work=claimable');
  assert.ok(claimable.has(qualified.testId), 'Pending, on a Method Tom is qualified on');
  assert.ok(!claimable.has(unqualified.testId), 'on a Method Tom is not qualified on');
  assert.ok(!claimable.has(started.testId), 'In Progress: only Pending Tests can be picked up');
  assert.ok(!claimable.has(notAccepted.testId), 'on a Sample intake review has not accepted');
});

test('oversight (lab=1) shows the administrator a Queue\'s stage unfiltered, and only the administrator', async () => {
  await setupLab();
  const accepted = await receive();
  const notAccepted = await receive(lab.acme, { accept: false });
  const admin = await as('admin');

  assert.deepEqual(await testIds(admin, 'work=assignable'), new Set(), 'the administrator assigns nothing, so their own Queue is empty');
  const stage = await testIds(admin, 'work=assignable&unassigned=1&lab=1');
  assert.ok(stage.has(accepted.testId));
  assert.ok(stage.has(notAccepted.testId), 'the stage is nobody\'s work, so the rule does not filter it');
  assert.equal((await (await as('priya.raman')).get('/api/tests?work=assignable&lab=1')).status, 403, 'oversight needs work.oversee');
});

test('the Dashboard and Workload count the unassigned Tests each person sees on their Worklist', async () => {
  await setupLab();
  await receive();
  await startedThenUnassigned();
  await receive(lab.acme, { accept: false });
  const count = async (c, query) => (await c.ok('GET', `/api/tests?limit=3000&${query}`)).length;

  // Who sees which: whoever assigns, the Queue they assign from; else an analyst, the one they pick up from; else oversight.
  const expected = {
    'priya.raman': { queue: 'assignable', query: 'work=assignable&unassigned=1' },
    'tom.fletcher': { queue: 'claimable', query: 'work=claimable' },
    admin: { queue: 'stage', query: 'work=assignable&unassigned=1&lab=1' },
  };
  for (const [username, { queue, query }] of Object.entries(expected)) {
    const c = await as(username);
    const n = await count(c, query);
    assert.ok(n > 0, `${username} has unassigned Tests to see`);
    assert.deepEqual((await c.ok('GET', '/api/dashboard')).kpis.unassigned, { queue, n }, `${username}: Dashboard`);
  }
  const counts = await Promise.all(['priya.raman', 'tom.fletcher', 'admin'].map(async (u) => count(await as(u), expected[u].query)));
  assert.equal(new Set(counts).size, 3, 'the three views differ, so a swapped Queue would show');
  assert.equal((await (await as('admin')).ok('GET', '/api/workload')).unassigned, counts[2], 'Workload, for oversight');
  assert.deepEqual((await (await as('daniel.okafor')).ok('GET', '/api/dashboard')).kpis.unassigned, { queue: null, n: 0 }, 'QA neither assigns nor picks up');
});

test('a work filter asked for without its permission returns 200 and an empty list', async () => {
  await setupLab();
  // Work waits at every stage, so an empty answer is the person's Queue, not an empty lab.
  await perform(await receive(), 'tom.fletcher');
  const reviewed = await receive();
  await perform(reviewed, 'tom.fletcher');
  await review(reviewed, 'sarah.lindqvist');
  await assign(await receive(), 'lucia.fernandez');

  const none = {
    'tom.fletcher': ['review', 'approval'],
    'sarah.lindqvist': ['approval'],
    'daniel.okafor': ['assigned'],
    'oliver.grant': ['assigned', 'review', 'approval'],
  };
  for (const [username, filters] of Object.entries(none)) {
    const c = await as(username);
    for (const work of filters) {
      for (const list of ['samples', 'tests']) {
        const r = await c.get(`/api/${list}?work=${work}`);
        assert.equal(r.status, 200, `${username}: ${list} work=${work}`);
        assert.deepEqual(r.data, [], `${username}: ${list} work=${work} is none of their work`);
      }
    }
  }
  assert.equal((await (await as('tom.fletcher')).get('/api/samples?work=everything')).status, 400, 'unknown work filter');
});

test('the work filter combines with the existing filters', async () => {
  await setupLab();
  const acme = await receive(lab.acme);
  await assign(acme, 'tom.fletcher');
  const other = await receive(lab.other);
  await assign(other, 'tom.fletcher');
  const tom = await as('tom.fletcher');

  const acmeOnly = await ids(tom, `work=assigned&client_id=${lab.acme.id}`);
  assert.ok(acmeOnly.has(acme.id));
  assert.ok(!acmeOnly.has(other.id), 'other client filtered out');
  const allClients = await ids(tom, 'work=assigned');
  assert.ok(allClients.has(other.id));
  const byText = await ids(tom, `work=assigned&q=${encodeURIComponent((await tom.ok('GET', `/api/samples/${acme.id}`)).sample.code)}`);
  assert.deepEqual(byText, new Set([acme.id]));
});
