// The portal's sign-in and submission desk at their edges, in a real headless browser: an unnamed row that has other
// details, a double demo sign-in, a spreadsheet over the 200-sample limit, and signing in from the card (issue #12).
// Needs the agent-browser CLI and is skipped where it is not installed, as on CI.
// Run with:  node --test test/portal-edge-cases.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portalBrowser, skip } from './portal-browser.js';

const { ab, evalJs, signInCard, signIn } = portalBrowser('edges');

const openDesk = () => {
  ab('eval', 'location.hash = "#/submit"');
  ab('wait', '#d-samples-0-description');
};

test('a row with only a lot number blocks Send to lab, with the problem on its description', { skip }, () => {
  signIn();
  openDesk();
  ab('fill', '#d-samples-0-description', 'Named sample');
  for (const id of ['#d-samples-1-description', '#d-samples-2-description']) {
    ab('scrollintoview', 'button[data-add]');
    ab('click', 'button[data-add]');
    ab('wait', id);
  }
  ab('fill', '#d-samples-2-batch_no', 'LOT-0003');
  // The fill marks the draft as checking at once; the wait ends when the server's check of that edit is back.
  ab('wait', '--fn', '!/checking your changes|checks have not run/.test(document.querySelector(".as-send").textContent)');

  const page = evalJs(`({
    hash: location.hash,
    disabled: document.querySelector("button.js-send").disabled,
    asks: [...document.querySelectorAll(".as-form .p-ask")].map((el) => el.dataset.field),
    bar: document.querySelector(".as-send .as-hint.block")?.textContent ?? "",
  })`);
  assert.equal(page.disabled, true, 'Send to lab stays disabled');
  assert.deepEqual(page.asks, ['samples.2.description'], 'the only problem is on the third row\'s description');
  assert.match(page.bar, /^Not ready to send\. Still needed: Sample \d+ description is required\.$/, 'the send bar names the problem');
  assert.equal(page.hash, '#/submit', 'nothing was sent');
});

// agent-browser's dblclick fires a single click event, so this clicks twice, holding the first /login until the
// second click is in: two clicks a person makes before the server answers.
test('two quick clicks on a demo sign-in button send one /login and end signed in', { skip }, () => {
  signInCard();
  ab('eval', `(() => {
    const send = window.fetch;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    window.__logins = { sent: 0, done: 0, release };
    window.fetch = async (url, opts) => {
      if (!String(url).endsWith('/api/portal/login')) return send(url, opts);
      window.__logins.sent++;
      await held;
      return send(url, opts).finally(() => { window.__logins.done++; });
    };
    return 1;
  })()`);
  ab('click', '[data-demo="customer@example.com"]');
  ab('click', '[data-demo="customer@example.com"]');
  ab('eval', 'window.__logins.release()');
  ab('wait', '.nav a[data-nav=overview][aria-current=page]');
  ab('wait', '--fn', 'window.__logins.sent === window.__logins.done');
  assert.equal(evalJs('window.__logins.sent'), 1, 'one /login request');
  assert.match(evalJs('document.querySelector("#main h1").textContent'), /Laura/, 'signed in as the demo contact');
});

test('a sheet over 200 rows fills the draft to 200 and says how many rows were left out', { skip }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sheet = path.join(dir, 'samples.csv');
  const rows = Array.from({ length: 205 }, (_, i) => `Overflow sample ${i + 1},LOT-${String(i + 1).padStart(4, '0')}`);
  fs.writeFileSync(sheet, ['Sample description,Lot number', ...rows].join('\n'));

  signIn();
  openDesk();
  ab('upload', 'input.js-file', sheet);
  ab('wait', '.toast');

  const page = evalJs(`({
    toast: document.querySelector(".toast").textContent,
    rows: document.querySelectorAll('.as-form [data-field$=".description"]').length,
    last: document.getElementById("d-samples-199-description")?.value,
    add: document.querySelector("button[data-add]").disabled,
  })`);
  assert.equal(page.toast, '200 samples added. Only 200 fit in one submission, 5 rows were not added.');
  assert.equal(page.rows, 200, 'the draft holds its 200-sample maximum');
  assert.equal(page.last, 'Overflow sample 200');
  assert.equal(page.add, true, 'Add a sample is disabled at the maximum');
});

test('a contact signs in from the card, and a wrong password keeps the card with the form error', { skip }, () => {
  signInCard();
  ab('fill', '#signin input[name=email]', 'customer@example.com');
  ab('fill', '#signin input[name=password]', 'not-the-password');
  ab('click', '#signin button[type=submit]');
  ab('wait', '--fn', '!document.querySelector("#signin button[type=submit]")?.disabled');
  const refused = evalJs(`({
    error: document.querySelector("#signin .form-error")?.textContent,
    nav: !!document.querySelector("header.top nav.nav"),
  })`);
  assert.equal(refused.error, 'Incorrect email or password');
  assert.equal(refused.nav, false, 'still on the sign-in card');

  ab('fill', '#signin input[name=password]', 'demo1234');
  ab('click', '#signin button[type=submit]');
  ab('wait', '.nav a[data-nav=overview][aria-current=page]');
  assert.match(evalJs('document.querySelector("#main h1").textContent'), /Laura/, 'the overview greets the contact');
});
