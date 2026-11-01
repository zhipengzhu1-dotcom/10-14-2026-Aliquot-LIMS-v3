// Test work: every count of the lab's Tests equals the list it links to, because both read one view in
// server/test-work.js. The Dashboard, Workload and the Assign dialog are checked against the Worklist.
// Starts a real server on a temporary database with the demo lab and drives it over HTTP.
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
  async ok(method, url, body) {
    const r = await this.req(method, url, body);
    assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

const sessions = {};
async function as(username) {
  if (!sessions[username]) {
    const c = new Client();
    await c.ok('POST', '/api/auth/login', { username, password: PASSWORD });
    sessions[username] = c;
  }
  return sessions[username];
}

const lab = {};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-test-'));
  server = await startServer(dataDir);
  BASE = server.base;
  const setup = await new Client().req('POST', '/api/setup', { mode: 'demo' });
  assert.equal(setup.status, 200, `demo setup failed: ${JSON.stringify(setup.data)} ${server.log()}`);
  const priya = await as('priya.raman');
  lab.client = (await priya.ok('GET', '/api/clients'))[0].id;
  lab.kf = (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id;
  lab.users = Object.fromEntries((await priya.ok('GET', '/api/users')).map((u) => [u.username, u.id]));
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const yesterday = () => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A Karl Fischer Test due yesterday on a new Sample, left Pending review unless `accept`. */
async function newTest({ accept = true } = {}) {
  const priya = await as('priya.raman');
  const { samples } = await priya.ok('POST', '/api/samples/receive', { client_id: lab.client, due_date: yesterday(), samples: [{ description: 'Test work' }], method_ids: [lab.kf] });
  if (accept) await priya.ok('POST', `/api/samples/${samples[0].id}/accept`);
  return { sampleId: samples[0].id, testId: (await priya.ok('GET', `/api/samples/${samples[0].id}`)).tests[0].id };
}

const ids = async (query) => (await (await as('priya.raman')).ok('GET', `/api/tests?limit=3000&${query}`)).map((t) => t.id);

/** Every count of Test work, as the Dashboard, Workload and the Assign dialog show it. */
async function counts() {
  const priya = await as('priya.raman');
  const { kpis, workload: dashboard } = await priya.ok('GET', '/api/dashboard');
  const workload = await priya.ok('GET', '/api/workload');
  const { analysts: dialog } = await priya.ok('GET', '/api/intake/assign-options');
  return { kpis, dashboard, workload, dialog };
}

/** Each count equals the length of the Worklist view its tile or row links to. */
async function agree(label) {
  const { kpis, dashboard, workload, dialog } = await counts();
  const open = await ids('scope=open');
  const overdue = await ids('scope=open&overdue=1');
  const inReview = await ids('scope=review');
  assert.equal(kpis.tests_open, open.length, `${label}: Dashboard Tests to do vs Worklist All open`);
  assert.equal(workload.open, open.length, `${label}: Workload Open tests vs Worklist All open`);
  assert.equal(kpis.tests_overdue, overdue.length, `${label}: Dashboard overdue vs Worklist Overdue`);
  assert.equal(workload.overdue, overdue.length, `${label}: Workload Overdue vs Worklist Overdue`);
  assert.equal(kpis.awaiting_review + kpis.awaiting_approval, inReview.length, `${label}: Dashboard awaiting review / approval vs Worklist In review`);
  assert.deepEqual(inReview.sort(), (await ids('status=Submitted,Reviewed')).sort(), `${label}: In review is every Test waiting for review or approval`);
  assert.ok(workload.analysts.length > 1, 'several analysts');
  for (const a of workload.analysts) {
    const load = await ids(`scope=open&analyst_id=${a.id}`);
    assert.equal(a.open, load.length, `${label}: ${a.full_name} Workload open vs Worklist`);
    assert.equal(dashboard.find((x) => x.id === a.id).open, load.length, `${label}: ${a.full_name} Dashboard workload vs Worklist`);
    assert.equal(dialog.find((x) => x.id === a.id).open, load.length, `${label}: ${a.full_name} Assign dialog vs Worklist`);
    const late = await ids(`scope=open&overdue=1&analyst_id=${a.id}`);
    assert.equal(a.overdue, late.length, `${label}: ${a.full_name} Workload overdue vs Worklist`);
    assert.equal(dashboard.find((x) => x.id === a.id).overdue, late.length, `${label}: ${a.full_name} Dashboard overdue vs Worklist`);
  }
}

test('the demo lab: every count of Test work equals the list it links to', async () => {
  await agree('demo lab');
  const open = await (await as('priya.raman')).ok('GET', '/api/tests?limit=3000&scope=open');
  assert.deepEqual([...new Set(open.map((t) => t.status))].sort(), ['In Progress', 'Pending'], 'All open lists the Tests still to be performed, not those in review');
});

test('a Test on a Sample not yet accepted is not work: neither counted nor listed until accepted', async () => {
  const before = await counts();
  const t = await newTest({ accept: false });
  const pending = await counts();
  assert.equal(pending.kpis.tests_open, before.kpis.tests_open, 'Tests to do leaves it out');
  assert.equal(pending.kpis.tests_overdue, before.kpis.tests_overdue, 'overdue leaves it out');
  assert.ok(!(await ids('scope=open')).includes(t.testId), 'All open leaves it out');
  await agree('Test on a Sample Pending review');

  await (await as('priya.raman')).ok('POST', `/api/samples/${t.sampleId}/accept`);
  const accepted = await counts();
  assert.equal(accepted.kpis.tests_open, before.kpis.tests_open + 1, 'counted once accepted');
  assert.equal(accepted.kpis.tests_overdue, before.kpis.tests_overdue + 1, 'and overdue');
  assert.ok((await ids('scope=open&overdue=1')).includes(t.testId), 'and listed');
  await agree('Test on an accepted Sample');
});

test('an In Progress Test stays open work in its analyst\'s load, and leaves it for review once submitted', async () => {
  const priya = await as('priya.raman');
  const tom = await as('tom.fletcher');
  const tomId = lab.users['tom.fletcher'];
  const row = (c) => c.workload.analysts.find((a) => a.id === tomId);
  const t = await newTest();
  const before = await counts();
  await priya.ok('POST', '/api/tests/assign', { test_ids: [t.testId], analyst_id: tomId });
  await tom.ok('POST', `/api/tests/${t.testId}/start`);
  const started = await counts();
  assert.equal(started.kpis.tests_open, before.kpis.tests_open, 'still to do');
  assert.equal(row(started).open, row(before).open + 1, 'in Tom\'s load');
  assert.equal(row(started).in_progress, row(before).in_progress + 1);
  assert.equal(row(started).overdue, row(before).overdue + 1, 'and overdue in it');
  assert.ok((await ids(`scope=open&analyst_id=${tomId}`)).includes(t.testId), 'listed for Tom');
  await agree('In Progress Test');

  const d = await priya.ok('GET', `/api/tests/${t.testId}`);
  await tom.ok('PUT', `/api/tests/${t.testId}`, { instrument_id: d.instruments.find((i) => i.code === 'KF-01').id, results: d.results.map((r) => ({ id: r.id, value: '0.21' })) });
  await tom.ok('POST', `/api/tests/${t.testId}/submit`, { password: PASSWORD });
  const submitted = await counts();
  assert.equal(submitted.kpis.tests_open, before.kpis.tests_open - 1, 'no longer to do');
  assert.equal(submitted.kpis.tests_overdue, before.kpis.tests_overdue - 1, 'nor overdue');
  assert.equal(submitted.kpis.awaiting_review, started.kpis.awaiting_review + 1, 'waiting for review');
  assert.equal(row(submitted).open, row(before).open, 'out of Tom\'s load');
  assert.equal(row(submitted).awaiting_review, row(started).awaiting_review + 1);
  assert.ok(!(await ids('scope=open')).includes(t.testId), 'All open leaves it out');
  assert.ok((await ids('scope=review')).includes(t.testId), 'In review lists it');
  await agree('submitted Test');
});

test('the counts of Test work are lab-wide: the same for a person who cannot perform or assign Tests', async () => {
  const mine = (await (await as('priya.raman')).ok('GET', '/api/dashboard')).kpis;
  const theirs = (await (await as('grace.holloway')).ok('GET', '/api/dashboard')).kpis;
  for (const key of ['tests_open', 'tests_overdue', 'awaiting_review', 'awaiting_approval']) assert.equal(theirs[key], mine[key], key);
  assert.equal((await (await as('grace.holloway')).ok('GET', '/api/tests?limit=3000&scope=open')).length, mine.tests_open, 'and the list they link to');
});
