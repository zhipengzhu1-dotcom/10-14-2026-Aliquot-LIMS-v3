// Receiving & Review, Incoming tab: a client's Submission is listed there from the moment it is announced until it is
// received, declined or withdrawn; receiving it puts its Samples in Pending review; and the tab follows the same rules
// as the Portal inbox. Starts a real server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-incoming.test.js

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

const incoming = async (c, query = '') => (await c.ok('GET', `/api/intake?tab=incoming${query}`)).submissions;
const announce = (description = 'Incoming tab sample') => lab.laura.ok('POST', '/api/portal/submissions', { samples: [{ description }], method_ids: [lab.kf] });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-incoming-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  lab = {
    kf: (await priya.ok('GET', '/api/methods?usable=1')).find((m) => m.code === 'ATM-0002' && m.status === 'Effective').id,
    laura: session(server.base),
  };
  await lab.laura.ok('POST', '/api/portal/login', { email: LAURA, password: PASSWORD });
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a Submission is on the Incoming tab until it is received, with the actions it is offered', async () => {
  const priya = await staff('priya.raman');
  const { id } = await announce();
  const before = (await priya.ok('GET', '/api/intake?tab=incoming')).counts.incoming;

  const row = (await incoming(priya)).find((x) => x.id === id);
  assert.ok(row, 'the new Submission is listed');
  assert.deepEqual([row.can.acknowledge, row.can.decline, row.can.receive], [true, true, true]);
  assert.equal(row.client_name, 'Acme Pharmaceuticals Inc.');

  await priya.ok('POST', `/api/portal-admin/submissions/${id}/acknowledge`, { note: 'See you Tuesday' });
  const acknowledged = (await incoming(priya)).find((x) => x.id === id);
  assert.ok(acknowledged, 'an acknowledged Submission is still waiting for its parcel');
  assert.equal(acknowledged.can.acknowledge, false);
  assert.match(acknowledged.locks.acknowledge, /Already acknowledged/);

  const { samples } = await priya.ok('POST', `/api/portal-admin/submissions/${id}/receive`, {});
  assert.equal((await incoming(priya)).some((x) => x.id === id), false, 'a received Submission leaves the tab');
  assert.equal((await priya.ok('GET', '/api/intake?tab=incoming')).counts.incoming, before - 1);

  // The Samples it created wait for an intake decision, grouped under the Submission.
  const pending = await priya.ok('GET', '/api/intake?tab=pending');
  assert.ok(pending.groups.some((g) => g.submission && samples.every((s) => g.samples.some((x) => x.id === s.id))), 'its Samples are in Pending review');
});

test('a declined or withdrawn Submission is not on the Incoming tab', async () => {
  const priya = await staff('priya.raman');
  const declined = (await announce('To decline')).id;
  const withdrawn = (await announce('To withdraw')).id;
  await priya.ok('POST', `/api/portal-admin/submissions/${declined}/decline`, { reason: 'We do not run that test' });
  await lab.laura.ok('POST', `/api/portal/submissions/${withdrawn}/withdraw`);
  const ids = (await incoming(priya)).map((x) => x.id);
  assert.ok(!ids.includes(declined) && !ids.includes(withdrawn));
});

test('the tab filters by client and search, and the other tabs still carry their counts', async () => {
  const priya = await staff('priya.raman');
  const { id } = await announce('Searchable');
  const clientId = (await incoming(priya)).find((x) => x.id === id).client_id;
  assert.ok((await incoming(priya, `&client_id=${clientId}`)).some((x) => x.id === id));
  assert.equal((await incoming(priya, `&client_id=${clientId + 1000}`)).length, 0);
  const code = (await incoming(priya)).find((x) => x.id === id).code;
  assert.deepEqual((await incoming(priya, `&q=${code}`)).map((x) => x.id), [id]);
  assert.equal((await incoming(priya, '&q=no-such-submission')).length, 0);

  const counts = (await priya.ok('GET', '/api/intake?tab=incoming')).counts;
  assert.deepEqual(Object.keys(counts).sort(), ['hold', 'incoming', 'pending', 'ready']);
  assert.equal((await priya.ok('GET', '/api/intake?tab=incoming')).groups.length, 0, 'the Incoming tab lists no Samples');
});

test('a person who may not receive is offered no Submissions, and an unknown tab is still refused', async () => {
  const daniel = await staff('daniel.okafor'); // QA responds to clients but does not receive samples
  assert.equal((await incoming(daniel)).length, 0);
  const r = await daniel.get('/api/intake?tab=elsewhere');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /incoming/);
});
