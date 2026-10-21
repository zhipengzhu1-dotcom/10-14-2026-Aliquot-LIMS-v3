// Intake review, assigning from the Receiving & Review screen: an accepted Sample's Tests go to an analyst, singly or in
// bulk across several Samples, with an outcome for every Test. An unqualified analyst is refused for that Test only.
// Starts a real server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-assign.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const PASSWORD = 'demo1234';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-assign-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const users = await priya.ok('GET', '/api/users');
  const { qualifications } = await priya.ok('GET', '/api/qualifications');
  const methods = (await priya.ok('GET', '/api/methods?usable=1')).filter((m) => m.status === 'Effective');
  const tom = users.find((u) => u.username === 'tom.fletcher');
  const toms = new Set(qualifications.filter((q) => q.user_id === tom.id).map((q) => q.method_code));
  lab = {
    acme: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    // Tom is qualified on `kf` and not on `other`; both are usable Methods.
    kf: methods.find((m) => m.code === 'ATM-0002'),
    other: methods.find((m) => !toms.has(m.code)),
    tom,
  };
  assert.ok(toms.has('ATM-0002'), 'the demo qualifies tom.fletcher on Karl Fischer');
  assert.ok(lab.other, 'the demo has a usable Method tom.fletcher is not qualified on');
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A Sample received at the front desk with one Test per Method of `methods`. Accepted unless `accept` is false. Returns { id, code, tests }. */
async function receive(methods = [lab.kf], { accept = true } = {}) {
  const priya = await staff('priya.raman');
  const res = await priya.ok('POST', '/api/samples/receive', {
    client_id: lab.acme, samples: [{ description: 'Assign test' }], method_ids: methods.map((m) => m.id),
  });
  const id = res.samples[0].id;
  if (accept) await priya.ok('POST', `/api/samples/${id}/accept`);
  const { sample, tests } = await priya.ok('GET', `/api/samples/${id}`);
  return { id, code: sample.code, tests };
}

const assignBulk = (who, body) => who.req('POST', '/api/intake/assign', body);

test('bulk assign gives the Tests of several accepted Samples to one analyst and reports an outcome for each Test', async () => {
  const a = await receive();
  const b = await receive();
  const priya = await staff('priya.raman');

  const r = await assignBulk(priya, { sample_ids: [a.id, b.id], analyst_id: lab.tom.id });

  assert.equal(r.status, 200);
  assert.equal(r.data.assigned, 2);
  assert.equal(r.data.refused, 0);
  assert.deepEqual(r.data.results.map((x) => [x.test_id, x.sample_code, x.ok]), [[a.tests[0].id, a.code, true], [b.tests[0].id, b.code, true]]);
  for (const s of [a, b]) {
    const { tests } = await priya.ok('GET', `/api/samples/${s.id}`);
    assert.equal(tests[0].analyst_id, lab.tom.id);
  }
});

const testsOf = async (id) => (await (await staff('priya.raman')).ok('GET', `/api/samples/${id}`)).tests;
const byMethod = (tests, method) => tests.find((t) => t.method_code === method.code);

test('an unqualified analyst is refused for that Test only: the others in the batch are assigned', async () => {
  const mixed = await receive([lab.kf, lab.other]);
  const plain = await receive();
  const priya = await staff('priya.raman');

  const r = await assignBulk(priya, { sample_ids: [mixed.id, plain.id], analyst_id: lab.tom.id });

  assert.equal(r.status, 200);
  assert.equal(r.data.assigned, 2);
  assert.equal(r.data.refused, 1);
  const refused = r.data.results.find((x) => !x.ok);
  assert.equal(refused.method_code, lab.other.code);
  assert.equal(refused.sample_code, mixed.code);
  assert.equal(refused.status, 400);
  assert.match(refused.error, new RegExp(`not qualified on ${lab.other.code}`));
  const after = await testsOf(mixed.id);
  assert.equal(byMethod(after, lab.kf).analyst_id, lab.tom.id);
  assert.equal(byMethod(after, lab.other).analyst_id, null, 'the unqualified Test stays unassigned');
  assert.equal((await testsOf(plain.id))[0].analyst_id, lab.tom.id);
});

test('assign is refused for a Test on a Sample that has not been accepted, naming the missing step, and the accepted Sample is still assigned', async () => {
  const waiting = await receive([lab.kf], { accept: false });
  const accepted = await receive();
  const priya = await staff('priya.raman');

  const r = await assignBulk(priya, { sample_ids: [waiting.id, accepted.id], analyst_id: lab.tom.id });

  assert.equal(r.status, 200);
  const refused = r.data.results.find((x) => x.sample_id === waiting.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.test_id, waiting.tests[0].id);
  assert.match(refused.error, /not been accepted at intake review/);
  assert.equal(r.data.results.find((x) => x.sample_id === accepted.id).ok, true);
  assert.equal((await testsOf(waiting.id))[0].analyst_id, null);

  // Naming the Test directly is refused the same way.
  const byTest = await assignBulk(priya, { test_ids: [waiting.tests[0].id], analyst_id: lab.tom.id });
  assert.equal(byTest.data.results[0].ok, false);
  assert.match(byTest.data.results[0].error, /not been accepted at intake review/);
});

test('one accepted Sample can be assigned alone, by Sample or by Test, with a due date', async () => {
  const bySample = await receive();
  const byTest = await receive();
  const priya = await staff('priya.raman');

  const one = await assignBulk(priya, { sample_ids: [bySample.id], analyst_id: lab.tom.id, due_date: '2030-01-15' });
  const two = await assignBulk(priya, { test_ids: [byTest.tests[0].id], analyst_id: lab.tom.id });

  assert.deepEqual([one.data.assigned, two.data.assigned], [1, 1]);
  const [t] = await testsOf(bySample.id);
  assert.equal(t.analyst_id, lab.tom.id);
  assert.equal(t.due_date, '2030-01-15');
});

test('a Sample whose Tests are all assigned, and an id that does not exist, are reported as refused outcomes', async () => {
  const s = await receive();
  const priya = await staff('priya.raman');
  await assignBulk(priya, { sample_ids: [s.id], analyst_id: lab.tom.id });

  const r = await assignBulk(priya, { sample_ids: [s.id, 999999], test_ids: [999998], analyst_id: lab.tom.id });

  assert.equal(r.status, 200);
  assert.equal(r.data.assigned, 0);
  assert.equal(r.data.refused, 3);
  assert.match(r.data.results.find((x) => x.sample_id === s.id).error, /already assigned/);
  assert.equal(r.data.results.filter((x) => x.status === 404).length, 2);
});

test('a request with nothing selected, or with no analyst who can take work, is refused as a whole', async () => {
  const s = await receive();
  const priya = await staff('priya.raman');
  const grace = (await priya.ok('GET', '/api/users')).find((u) => u.username === 'grace.holloway');

  assert.equal((await assignBulk(priya, { analyst_id: lab.tom.id })).status, 400);
  assert.equal((await assignBulk(priya, { sample_ids: [s.id] })).status, 400);
  assert.equal((await assignBulk(priya, { sample_ids: [s.id], analyst_id: 999999 })).status, 400);
  const notAnAnalyst = await assignBulk(priya, { sample_ids: [s.id], analyst_id: grace.id });
  assert.equal(notAnAnalyst.status, 400);
  assert.match(notAnAnalyst.data.error, /active analyst/);
  assert.equal((await testsOf(s.id))[0].analyst_id, null);
});

test('a person without the assign permission is refused for every Test and the dialog data', async () => {
  const s = await receive();
  const tom = await staff('tom.fletcher');

  const r = await assignBulk(tom, { sample_ids: [s.id], analyst_id: lab.tom.id });

  assert.equal(r.status, 200);
  assert.equal(r.data.assigned, 0);
  assert.equal(r.data.results[0].status, 403);
  assert.equal((await testsOf(s.id))[0].analyst_id, null);
  assert.equal((await tom.get(`/api/intake/assign-options?sample_ids=${s.id}`)).status, 403);
});

test('POST /api/tests/assign still aborts the whole batch on the first unqualified analyst', async () => {
  const s = await receive([lab.kf, lab.other]);
  const priya = await staff('priya.raman');

  const r = await priya.post('/api/tests/assign', { test_ids: s.tests.map((t) => t.id), analyst_id: lab.tom.id });

  assert.equal(r.status, 400);
  assert.match(r.data.error, /not qualified/);
  assert.ok((await testsOf(s.id)).every((t) => t.analyst_id === null), 'nothing was assigned');
});

test('the dialog data lists each analyst with a qualified flag per Method and their open workload', async () => {
  const s = await receive([lab.kf, lab.other]);
  const waiting = await receive([lab.kf], { accept: false });
  const priya = await staff('priya.raman');
  const load = async () => (await priya.ok('GET', `/api/intake/assign-options?sample_ids=${s.id}`)).analysts.find((a) => a.id === lab.tom.id).open;
  const before = await load();

  const o = await priya.ok('GET', `/api/intake/assign-options?sample_ids=${s.id},${waiting.id}`);

  assert.deepEqual(o.methods.map((m) => m.code).sort(), [lab.kf.code, lab.other.code].sort());
  assert.equal(o.tests.length, 3);
  assert.equal(o.tests.find((t) => t.sample_id === s.id).why, null);
  assert.match(o.tests.find((t) => t.sample_id === waiting.id).why, /not been accepted at intake review/);
  const tom = o.analysts.find((a) => a.id === lab.tom.id);
  assert.equal(tom.qualified[lab.kf.code], true);
  assert.equal(tom.qualified[lab.other.code], false);
  assert.equal(typeof tom.open, 'number');
  assert.ok(o.analysts.every((a) => a.role !== 'business'), 'only people who can perform tests are listed');

  await assignBulk(priya, { test_ids: [byMethod(s.tests, lab.kf).id], analyst_id: lab.tom.id });
  assert.equal(await load(), before + 1, 'the workload counts the Test just assigned');
});

test('the review screen offers assign where the rule allows it and says which step is missing where it does not', async () => {
  const waiting = await receive([lab.kf], { accept: false });
  const ready = await receive();
  const priya = await staff('priya.raman');
  const find = (q, id) => q.groups.flatMap((g) => g.samples).find((x) => x.id === id);

  const pending = find(await priya.ok('GET', '/api/intake?tab=pending'), waiting.id);
  const accepted = find(await priya.ok('GET', '/api/intake?tab=ready'), ready.id);

  assert.equal(pending.can.assign, false);
  assert.match(pending.locks.assign, /not been accepted at intake review/);
  assert.equal(accepted.can.assign, true);
  assert.equal(accepted.locks.assign, null);
  const tom = await staff('tom.fletcher');
  assert.deepEqual((await tom.ok('GET', '/api/intake?tab=ready')).groups, []);
});
