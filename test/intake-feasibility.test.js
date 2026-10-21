// Intake review, feasibility indicators: the review endpoint tells, for each Test requested on a Sample, whether its
// Method is usable, how many analysts are currently qualified on it and whether the Sample's due date can be met.
// Starts a real server on a temporary database with the demo lab and drives it over HTTP.
// Run with:  node --test test/intake-feasibility.test.js

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

const pad = (n) => String(n).padStart(2, '0');
const dateIn = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-intake-feasibility-test-'));
  server = await startServer(dataDir);
  await session(server.base).ok('POST', '/api/setup', { mode: 'demo' });
  const priya = await staff('priya.raman');
  const users = await priya.ok('GET', '/api/users');
  lab = {
    acme: (await priya.ok('GET', '/api/clients')).find((c) => c.code === 'ACME').id,
    tom: users.find((u) => u.username === 'tom.fletcher').id,
    nadia: users.find((u) => u.username === 'nadia.rossi').id,
    sarah: users.find((u) => u.username === 'sarah.lindqvist').id,
    helena: users.find((u) => u.username === 'helena.weiss').id,
  };
});

after(async () => {
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let serial = 0;
/** A new Method of `tat_days` that nobody is qualified on. In Development unless `status` says Effective or Retired. */
async function makeMethod({ tat_days = 5, status = 'In Development' } = {}) {
  const priya = await staff('priya.raman');
  serial += 1;
  const m = await priya.ok('POST', '/api/methods', {
    title: `Feasibility method ${serial}`, technique: 'Titration', tat_days, owner_id: lab.sarah, status: 'In Development',
    analytes: [{ name: 'Assay', unit: '%', spec_min: 90, spec_max: 110 }],
  });
  if (status === 'Effective' || status === 'Retired') await priya.ok('POST', `/api/methods/${m.id}/status`, { status: 'Effective', password: PASSWORD });
  return m;
}

const setStatus = async (m, status) => (await staff('priya.raman')).ok('POST', `/api/methods/${m.id}/status`, { status, password: PASSWORD });
const qualify = async (userId, code, extra = {}) => (await staff('priya.raman')).ok('POST', '/api/qualifications', { user_id: userId, method_code: code, ...extra });

/** A Sample (left Pending review) with one Test per Method of `methods`. Returns its id. */
async function receive(methods, extra = {}) {
  const res = await (await staff('priya.raman')).ok('POST', '/api/samples/receive', {
    client_id: lab.acme, samples: [{ description: 'Feasibility sample' }], method_ids: methods.map((m) => m.id), ...extra,
  });
  return res.samples[0].id;
}

const review = async (id, who = 'priya.raman') => (await staff(who)).ok('GET', `/api/intake/samples/${id}/review`);
const indicatorsOf = async (id, who) => (await review(id, who)).tests.map((t) => t.indicators);

test('each requested Test is listed with its Method and the three indicators, each with a reason', async () => {
  const m = await makeMethod();
  const id = await receive([m], { due_date: dateIn(30) });
  const { tests } = await review(id);
  assert.equal(tests.length, 1);
  const [t] = tests;
  assert.equal(typeof t.id, 'number');
  assert.equal(t.method_code, m.code);
  assert.equal(t.method_version, 1);
  assert.ok(t.name, 'the Test has a name to show');
  const { method_usable, qualified, due_date } = t.indicators;
  for (const i of [method_usable, qualified, due_date]) {
    assert.equal(typeof i.ok, 'boolean');
    assert.ok(i.reason && typeof i.reason === 'string', 'every indicator says why');
  }
  assert.equal(typeof qualified.count, 'number');
});

test('only a Method in effect is usable: In Development and In Validation are flagged with the status they are in', async () => {
  const dev = await makeMethod();
  const validating = await makeMethod();
  await setStatus(validating, 'In Validation');
  const eff = await makeMethod({ status: 'Effective' });
  const [a] = await indicatorsOf(await receive([dev]));
  const [v] = await indicatorsOf(await receive([validating]));
  const [b] = await indicatorsOf(await receive([eff]));
  assert.equal(a.method_usable.ok, false);
  assert.match(a.method_usable.reason, /in development/i);
  assert.equal(v.method_usable.ok, false);
  assert.match(v.method_usable.reason, /in validation/i);
  assert.equal(b.method_usable.ok, true);
  assert.match(b.method_usable.reason, /in effect/i);
});

test('requesting a Test still accepts a Method in development or validation: the indicator is stricter than the request check', async () => {
  const dev = await makeMethod();
  const id = await receive([dev]);
  const [t] = (await review(id)).tests;
  assert.ok(t.id, 'the Test was requested although its Method is not yet in effect');
  const add = await (await staff('priya.raman')).req('POST', `/api/samples/${id}/tests`, { method_ids: [(await makeMethod()).id] });
  assert.equal(add.status, 200);
});

test('a Test whose Method has since been retired is flagged as not usable, with the reason', async () => {
  const m = await makeMethod({ status: 'Effective' });
  const id = await receive([m]);
  await setStatus(m, 'Retired');
  const [t] = (await review(id)).tests;
  assert.equal(t.indicators.method_usable.ok, false);
  assert.match(t.indicators.method_usable.reason, /retired/i);
  assert.ok(t.indicators.method_usable.reason.includes(m.code), 'the reason names the Method');
});

test('a Method in effect without anyone qualified is usable but flagged for lack of an analyst', async () => {
  const m = await makeMethod({ status: 'Effective' });
  const [i] = await indicatorsOf(await receive([m]));
  assert.equal(i.method_usable.ok, true);
  assert.equal(i.qualified.ok, false);
});

test('a Test whose Method has gone back to Draft is flagged as not usable', async () => {
  const m = await makeMethod();
  const id = await receive([m]);
  await setStatus(m, 'Draft');
  const [i] = await indicatorsOf(id);
  assert.equal(i.method_usable.ok, false);
  assert.match(i.method_usable.reason, /draft/i);
});

test('a Test whose Method nobody is qualified on is flagged with a count of zero, and the count shows otherwise', async () => {
  const m = await makeMethod();
  const id = await receive([m]);
  let [i] = await indicatorsOf(id);
  assert.equal(i.qualified.count, 0);
  assert.equal(i.qualified.ok, false);
  assert.match(i.qualified.reason, /no (one|analyst)|nobody/i);
  assert.equal(i.method_usable.ok, false, 'a Method still in development is not usable');

  await qualify(lab.tom, m.code);
  [i] = await indicatorsOf(id);
  assert.equal(i.qualified.count, 1);
  assert.equal(i.qualified.ok, true);

  await qualify(lab.nadia, m.code);
  [i] = await indicatorsOf(id);
  assert.equal(i.qualified.count, 2);
  assert.match(i.qualified.reason, /2/);
});

test('a revoked or expired qualification, or one held by someone who cannot perform tests, is not counted', async () => {
  const priya = await staff('priya.raman');
  const m = await makeMethod();
  const id = await receive([m]);
  const tom = await qualify(lab.tom, m.code);
  await qualify(lab.nadia, m.code, { expires_at: dateIn(-1) });
  await qualify(lab.helena, m.code); // QA does not run tests
  let [i] = await indicatorsOf(id);
  assert.equal(i.qualified.count, 1, 'only Tom is current');

  await priya.ok('POST', `/api/qualifications/${tom.id}/revoke`, { reason: 'Retraining required' });
  [i] = await indicatorsOf(id);
  assert.equal(i.qualified.count, 0);
  assert.equal(i.qualified.ok, false);
});

test('the due date is met when the Method turnaround fits before it, and not when it does not', async () => {
  const slow = await makeMethod({ tat_days: 10 });
  const fast = await makeMethod({ tat_days: 1 });
  const tight = await receive([slow, fast], { due_date: dateIn(4) });
  const [slowIn, fastIn] = (await review(tight)).tests.map((t) => t.indicators.due_date);
  assert.equal(slowIn.ok, false, 'ten working days do not fit before a date four days away');
  assert.ok(slowIn.reason.includes('10'), 'the reason gives the Method turnaround');
  assert.equal(fastIn.ok, true);

  const roomy = await receive([slow], { due_date: dateIn(30) });
  assert.equal((await indicatorsOf(roomy))[0].due_date.ok, true);
});

test('the due date is judged for the Sample\'s priority: Same day cannot be met by a Method that takes days', async () => {
  const m = await makeMethod({ tat_days: 3 });
  const sameDay = await receive([m], { priority: 'Same day' });
  const [i] = await indicatorsOf(sameDay);
  assert.equal(i.due_date.ok, false);
  assert.match(i.due_date.reason, /same day/i);

  const oneWeek = await receive([m], { priority: 'One week' });
  assert.equal((await indicatorsOf(oneWeek))[0].due_date.ok, true, 'a week is enough for a three-day Method');
});

test('the reason names the tier with its working days, the Method turnaround and the due date, each clearly separated', async () => {
  const m = await makeMethod({ tat_days: 3 });
  const id = await receive([m], { priority: '3 days', due_date: dateIn(30) });
  const [i] = await indicatorsOf(id);
  assert.match(i.due_date.reason, /3 days/);
  assert.match(i.due_date.reason, /3 working days/);
  assert.match(i.due_date.reason, new RegExp(`due ${dateIn(30)}[,;.] `), 'the due date is followed by a separator, not run into the next clause');
  assert.doesNotMatch(i.due_date.reason, /\d:\S/, 'no colon is run into the text after it');
});

test('without a due date the priority tier decides: Same day is not met by a three-day Method, One week is', async () => {
  const priya = await staff('priya.raman');
  const m = await makeMethod({ tat_days: 3 });
  const rush = await receive([m], { priority: 'Same day' });
  const week = await receive([m], { priority: 'One week' });
  for (const id of [rush, week]) await priya.ok('PUT', `/api/samples/${id}`, { due_date: '' });
  const [r] = await indicatorsOf(rush);
  const [w] = await indicatorsOf(week);
  assert.equal(r.due_date.ok, false);
  assert.match(r.due_date.reason, /same day/i);
  assert.equal(w.due_date.ok, true);
  assert.match(w.due_date.reason, /one week/i);
});

test('a cancelled Test is no longer listed', async () => {
  const a = await makeMethod();
  const b = await makeMethod();
  const id = await receive([a, b]);
  const { tests } = await review(id);
  assert.equal(tests.length, 2);
  await (await staff('priya.raman')).ok('POST', `/api/tests/${tests[0].id}/cancel`, { reason: 'Client withdrew the request' });
  assert.deepEqual((await review(id)).tests.map((t) => t.id), [tests[1].id]);
});

test('the indicators do not depend on who asks, only on whether they may review', async () => {
  const m = await makeMethod();
  const id = await receive([m]);
  assert.deepEqual(await indicatorsOf(id, 'priya.raman'), await indicatorsOf(id, 'sarah.lindqvist'));
});

test('refused: an unknown Sample is 404', async () => {
  const r = await (await staff('priya.raman')).req('GET', '/api/intake/samples/999999/review');
  assert.equal(r.status, 404);
});

test('refused: a person without the review permission gets 403, even for an unknown Sample', async () => {
  const m = await makeMethod();
  const id = await receive([m]);
  for (const who of ['tom.fletcher', 'helena.weiss', 'grace.holloway']) {
    const me = await staff(who);
    assert.equal((await me.req('GET', `/api/intake/samples/${id}/review`)).status, 403, who);
    assert.equal((await me.req('GET', '/api/intake/samples/999999/review')).status, 403, `${who} learns nothing about unknown ids`);
  }
});

test('refused: nobody signed in gets 401', async () => {
  const r = await session(server.base).req('GET', '/api/intake/samples/1/review');
  assert.equal(r.status, 401);
});
