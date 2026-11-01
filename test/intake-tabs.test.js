// Receiving & Review, the tab definitions: `GET /api/intake` sends every tab's label, actions, filters, search and empty
// state, and the screen draws only that. These tests hold the definitions to the rules (a record shows an action only as
// its `can` says) and to the server's own matching (a tab lists exactly the filters it applies). Starts a real server on
// a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-tabs.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
const LAURA = 'customer@example.com'; // Acme
const TABS = ['incoming', 'pending', 'hold', 'ready'];
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

const intake = (who, query = '') => who.ok('GET', `/api/intake${query}`);
/** The records a tab answer lists, whichever kind they are. */
const recordsOf = (q) => [...q.groups.flatMap((g) => g.samples), ...q.submissions];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-tabs-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const clients = await priya.ok('GET', '/api/clients');
  lab = {
    acme: clients.find((c) => c.code === 'ACME').id,
    kf: (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    project: (await priya.ok('GET', '/api/projects')).find((p) => p.client_id === clients.find((c) => c.code === 'ACME').id)?.id,
  };
  // Something on every tab: a Submission on its way, a held Sample, an accepted one with its Test still to assign,
  // and the demo lab's Samples waiting in Pending review.
  const laura = session(server.base);
  await laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
  await laura.ok('POST', '/api/portal/submissions', { samples: [{ description: 'Tabs test shipment' }], method_ids: [lab.kf] });
  const { samples } = await priya.ok('POST', '/api/samples/receive', { client_id: lab.acme, samples: [{ description: 'Tabs held' }, { description: 'Tabs ready' }], method_ids: [lab.kf] });
  await priya.ok('POST', `/api/samples/${samples[0].id}/hold`, { reason: 'Which batch is this?' });
  await priya.ok('POST', `/api/samples/${samples[1].id}/accept`);
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the answer defines every tab, in order, with Pending review the default', async () => {
  const priya = await staff('priya.raman');
  const q = await intake(priya);
  assert.equal(q.tab, 'pending', 'no tab asked for: the default one');
  assert.deepEqual(q.tabs.map((t) => t.key), TABS);
  assert.deepEqual(q.tabs.filter((t) => t.default).map((t) => t.key), ['pending']);
  assert.deepEqual(q.tabs.map((t) => t.label), ['Incoming', 'Pending review', 'On hold', 'Ready to assign']);
  assert.deepEqual(Object.fromEntries(q.tabs.map((t) => [t.key, t.kind])), { incoming: 'submission', pending: 'sample', hold: 'sample', ready: 'sample' });
  assert.deepEqual(Object.fromEntries(q.tabs.map((t) => [t.key, t.actions])), {
    incoming: ['acknowledge', 'decline', 'receive'],
    pending: ['accept', 'hold', 'reject'],
    hold: ['accept', 'release', 'reject'],
    ready: ['assign'],
  });
  for (const t of q.tabs) {
    assert.deepEqual(Object.keys(t).sort(), ['actions', 'default', 'empty', 'filters', 'key', 'kind', 'label', 'search'], `${t.key} sends its definition and nothing of its Queue`);
    assert.ok(t.search && t.empty.title && t.empty.filtered && t.empty.text && t.empty.icon, `${t.key} has a search placeholder and empty state`);
  }
  assert.deepEqual(q.tabs.find((t) => t.key === 'incoming').search, 'Search submissions…');
  assert.deepEqual(q.tabs.find((t) => t.key === 'ready').search, 'Search samples…');

  for (const key of TABS) {
    const shown = await intake(priya, `?tab=${key}`);
    assert.equal(shown.tab, key);
    assert.deepEqual(shown.tabs, q.tabs, 'the same definitions whichever tab is shown');
    assert.ok(recordsOf(shown).length > 0, `${key} lists something to check against`);
    assert.equal(shown.counts[key], recordsOf(shown).length);
  }
  const unknown = await priya.get('/api/intake?tab=archive');
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /incoming, pending, hold, ready/);
});

test('each record shows its tab\'s actions, enabled exactly where its can allows them', async () => {
  for (const username of ['priya.raman', 'sarah.lindqvist', 'tom.fletcher']) {
    const who = await staff(username);
    for (const key of TABS) {
      const q = await intake(who, `?tab=${key}`);
      const { actions } = q.tabs.find((t) => t.key === key);
      for (const r of recordsOf(q)) {
        const shown = Object.keys(r.locks);
        assert.deepEqual(shown, actions.filter((a) => shown.includes(a)), `${username} ${key} ${r.code}: only the tab's actions, in its order`);
        for (const a of shown) assert.equal(r.locks[a] === null, r.can[a], `${username} ${key} ${r.code} ${a}: a refusal exactly when can refuses`);
      }
    }
  }
  // The manager holds every permission these actions need, so each row shows all of them.
  const priya = await staff('priya.raman');
  for (const key of TABS) {
    const q = await intake(priya, `?tab=${key}`);
    const { actions } = q.tabs.find((t) => t.key === key);
    for (const r of recordsOf(q)) assert.deepEqual(Object.keys(r.locks), actions, `${key} ${r.code}`);
  }
});

test('an action the person has no permission for is not shown at all, rather than disabled on every row', async () => {
  // An analyst may receive samples but does not respond to clients: Incoming shows them Receive only.
  const tom = await staff('tom.fletcher');
  const q = await intake(tom, '?tab=incoming');
  assert.ok(q.submissions.length > 0, 'an analyst is offered Submissions to receive');
  for (const su of q.submissions) {
    assert.deepEqual(su.locks, { receive: null });
    assert.deepEqual([su.can.acknowledge, su.can.decline, su.can.receive], [false, false, true]);
  }
  // A person without samples.review is offered no Sample on the review tabs, so none of their actions.
  for (const key of ['pending', 'hold', 'ready']) assert.deepEqual((await intake(tom, `?tab=${key}`)).groups, [], key);
  // QA responds to clients but does not receive, so is offered nothing on Incoming.
  assert.deepEqual((await intake(await staff('daniel.okafor'), '?tab=incoming')).submissions, []);
});

test('a tab lists exactly the filters it applies: every other one is ignored, in its records and its count', async () => {
  const priya = await staff('priya.raman');
  const base = await intake(priya);
  const filtersOf = Object.fromEntries(base.tabs.map((t) => [t.key, t.filters]));
  assert.deepEqual(filtersOf, {
    incoming: ['client'],
    pending: ['client', 'project', 'priority', 'overdue'],
    hold: ['client', 'project', 'priority', 'overdue'],
    ready: ['client', 'project', 'priority', 'overdue'],
  });
  // A value that matches nothing empties a tab that applies the filter and leaves a tab that does not untouched.
  const nothing = { client: 'client_id=999999', project: 'project_id=999999', priority: 'priority=No+such+tier' };
  for (const [name, param] of Object.entries(nothing)) {
    const counts = (await intake(priya, `?${param}`)).counts;
    for (const key of TABS) {
      const applies = filtersOf[key].includes(name);
      assert.equal(counts[key], applies ? 0 : base.counts[key], `${name} on ${key}: ${applies ? 'applied' : 'ignored'}`);
      assert.equal(recordsOf(await intake(priya, `?tab=${key}&${param}`)).length, counts[key], `${name} on ${key}: the records follow the count`);
    }
  }
  // A project or overdue filter left over from a Sample tab leaves Incoming as it was.
  const incoming = await intake(priya, '?tab=incoming');
  const leftOver = await intake(priya, `?tab=incoming&project_id=${lab.project ?? 999999}&priority=Same+day&overdue=1`);
  assert.deepEqual(leftOver.submissions.map((x) => x.id), incoming.submissions.map((x) => x.id));
  // The client filter and the search apply on every tab.
  for (const key of TABS) {
    const q = await intake(priya, `?tab=${key}&client_id=${lab.acme}`);
    assert.ok(recordsOf(q).every((r) => r.client_id === lab.acme), `${key} filters by client`);
    assert.equal(recordsOf(await intake(priya, `?tab=${key}&q=nothing-matches-this`)).length, 0, `${key} searches`);
  }
});
