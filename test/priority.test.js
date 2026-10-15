// Turnaround tiers: new samples take one of the day-based tiers, which set each Test's due date and surcharged price;
// the retired Standard / Rush / Urgent tiers are refused as new input but still govern the records that carry them.
// Run with:  node --test test/priority.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';
import { addBusinessDays, today } from '../server/util.js';

const PASSWORD = 'demo1234';
let BASE;
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

const signIn = async (url, body) => { const c = new Client(); await c.ok('POST', url, body); return c; };
const staff = (username) => signIn('/api/auth/login', { username, password: PASSWORD });
const portal = (email) => signIn('/api/portal/login', { email, password: PASSWORD });

// Wednesday 14 October 2026, midday UTC, so the receipt date is the 14th in any lab's time zone.
const RECEIVED_AT = '2026-10-14T12:00:00.000Z';
const TIERS = {
  'Same day': { due: '2026-10-14', price: 450 },
  'Next day': { due: '2026-10-15', price: 300 },
  '3 days': { due: '2026-10-19', price: 225 },
  'One week': { due: '2026-10-21', price: 150 },
};

let nadia;
let acme;
let kf;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-priority-test-'));
  server = await startServer(dataDir);
  BASE = server.base;
  assert.equal((await new Client().req('POST', '/api/setup', { mode: 'demo' })).status, 200, server.log());
  nadia = await staff('nadia.rossi');
  acme = (await nadia.ok('GET', '/api/clients')).find((c) => c.code === 'ACME');
  kf = (await nadia.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective');
  assert.equal(kf.price, 150);
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const receive = (priority) => nadia.req('POST', '/api/samples/receive', {
  client_id: acme.id, priority, received_at: RECEIVED_AT, samples: [{ description: `Tier ${priority}` }], method_ids: [kf.id],
});
const testOf = async (sampleId) => (await nadia.ok('GET', `/api/samples/${sampleId}`)).tests[0];

test('the lookups offer only the day-based tiers, One week by default', async () => {
  const lk = await nadia.ok('GET', '/api/lookups');
  assert.deepEqual(lk.priorities, ['Same day', 'Next day', '3 days', 'One week']);
  assert.equal(lk.defaultPriority, 'One week');
  const laura = await portal('customer@example.com');
  assert.deepEqual((await laura.ok('GET', '/api/portal/lookups')).priorities, ['Same day', 'Next day', '3 days', 'One week']);
});

test('lab receipt: each tier sets the due date and the surcharged test price', async () => {
  for (const [tier, want] of Object.entries(TIERS)) {
    const r = await receive(tier);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.due_date, want.due, `${tier} due date`);
    const t = await testOf(r.data.samples[0].id);
    assert.deepEqual({ due: t.due_date, price: t.price }, want, tier);
  }
  const r = await nadia.ok('POST', '/api/samples/receive', { client_id: acme.id, received_at: RECEIVED_AT, samples: [{ description: 'No tier given' }], method_ids: [kf.id] });
  assert.equal((await nadia.ok('GET', `/api/samples/${r.samples[0].id}`)).sample.priority, 'One week');
});

test('a changed surcharge setting prices the next receipt', async () => {
  const admin = await staff('admin');
  await admin.ok('PUT', '/api/settings', { next_day_surcharge_pct: '120' });
  const r = await receive('Next day');
  assert.equal((await testOf(r.data.samples[0].id)).price, 330);
  assert.equal((await admin.req('PUT', '/api/settings', { same_day_surcharge_pct: 'lots' })).status, 400);
  await admin.ok('PUT', '/api/settings', { next_day_surcharge_pct: '100' });
});

test('portal submission: each tier is carried to receipt, due date and price', async () => {
  const laura = await portal('customer@example.com');
  for (const [tier, want] of Object.entries(TIERS)) {
    const sub = await laura.ok('POST', '/api/portal/submissions', { priority: tier, samples: [{ description: `Portal ${tier}` }], method_ids: [kf.id] });
    const rec = await nadia.ok('POST', `/api/portal-admin/submissions/${sub.id}/receive`, { received_at: RECEIVED_AT });
    assert.equal(rec.due_date, want.due, `${tier} due date`);
    const t = await testOf(rec.samples[0].id);
    assert.deepEqual({ due: t.due_date, price: t.price }, want, tier);
  }
});

test('a retired tier is refused as new input everywhere', async () => {
  const laura = await portal('customer@example.com');
  const refusal = 'Priority must be one of: Same day, Next day, 3 days, One week';
  for (const tier of ['Standard', 'Rush', 'Urgent']) {
    const r = await receive(tier);
    assert.deepEqual([r.status, r.data.error], [400, refusal], `receive as ${tier}`);
    const s = await laura.req('POST', '/api/portal/submissions', { priority: tier, samples: [{ description: 'x' }] });
    assert.deepEqual([s.status, s.data.error], [400, refusal], `submit as ${tier}`);
  }
  const fresh = await receive('One week');
  const edit = await nadia.req('PUT', `/api/samples/${fresh.data.samples[0].id}`, { description: 'Tier One week', priority: 'Rush' });
  assert.equal(edit.status, 400);
  const sub = await laura.ok('POST', '/api/portal/submissions', { priority: 'Next day', samples: [{ description: 'x' }] });
  const rec = await nadia.req('POST', `/api/portal-admin/submissions/${sub.id}/receive`, { priority: 'Urgent' });
  assert.deepEqual([rec.status, rec.data.error], [400, refusal]);
});

test('a sample stored with a retired tier keeps it, and new tests on it are dated and priced by that tier', async () => {
  const r = await receive('One week');
  const id = r.data.samples[0].id;
  // Stands in for a sample received before this release: the server is stopped while the row is rewritten.
  await server.stop();
  const db = new DatabaseSync(path.join(dataDir, 'aliquot.db'));
  db.prepare("UPDATE samples SET priority = 'Rush', due_date = NULL WHERE id = ?").run(id);
  db.close();
  server = await startServer(dataDir);
  BASE = server.base;
  nadia = await staff('nadia.rossi');

  const before = await nadia.ok('GET', `/api/samples/${id}`);
  assert.equal(before.sample.priority, 'Rush');
  await nadia.ok('PUT', `/api/samples/${id}`, { description: 'Edited, tier untouched', priority: 'Rush' });
  const added = await nadia.ok('POST', `/api/samples/${id}/tests`, { method_ids: [kf.id] });
  const t = (await nadia.ok('GET', `/api/samples/${id}`)).tests.find((x) => x.id === added.ids[0]);
  // Rush halves the slowest method's turnaround (Karl Fischer: 2 working days) and adds the rush surcharge (50 %).
  assert.deepEqual({ due: t.due_date, price: t.price }, { due: addBusinessDays(today(), 1), price: 225 });
  const after = await nadia.ok('GET', `/api/samples/${id}`);
  assert.deepEqual([after.sample.priority, after.sample.description], ['Rush', 'Edited, tier untouched']);
});
