// The portal submission desk's table view in a real headless browser: after every check result each cell's title
// follows the field's problem, else its provenance, exactly as a full redraw gives it (issue #44). Needs the
// agent-browser CLI and is skipped where it is not installed, as on CI.
// Run with:  node --test test/portal-draft-title.test.js
// Once PR #42 lands, the sign-in and session setup below can move onto its shared portal browser helper.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const HAVE_BROWSER = spawnSync('agent-browser', ['--version']).status === 0;
const SESSION = `aliquot-title-test-${process.pid}`;
let server;
let dataDir;

const ab = (...args) => execFileSync('agent-browser', args, {
  env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
  encoding: 'utf8',
  timeout: 60_000,
}).trim();
const evalJs = (js) => JSON.parse(ab('eval', js));
const titleOf = (field) => evalJs(`document.querySelector('[data-field="${field}"]').getAttribute('title') ?? ''`);
const classOf = (field) => evalJs(`document.querySelector('[data-field="${field}"]').className`);
// The check runs 250 ms after the last keystroke; wait until the send bar has the result rather than a fixed sleep.
const settled = () => ab('wait', '--fn', 'document.querySelector(".as-hint") && !document.querySelector(".as-hint").textContent.includes("checking")', '--timeout', '5000');

before(async () => {
  if (!HAVE_BROWSER) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-title-test-'));
  server = await startServer(dataDir);
  const setup = await fetch(`${server.base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aliquot' },
    body: JSON.stringify({ mode: 'demo' }),
  });
  assert.equal(setup.status, 200, `demo setup failed: ${server.log()}`);
});

after(async () => {
  if (!HAVE_BROWSER) return;
  spawnSync('agent-browser', ['close'], { env: { ...process.env, AGENT_BROWSER_SESSION: SESSION } });
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a table cell title follows the check result and provenance without a redraw', { skip: !HAVE_BROWSER && 'agent-browser is not installed' }, () => {
  const B = server.base;
  ab('set', 'viewport', '1440', '1000');
  ab('set', 'media', 'light', 'reduced-motion');
  ab('open', `${B}/portal/`);
  ab('wait', '--fn', '!document.getElementById("splash")');
  ab('wait', '[data-demo="customer@example.com"]');
  ab('scrollintoview', '[data-demo="customer@example.com"]');
  ab('click', '[data-demo="customer@example.com"]');
  ab('wait', 'header.top nav.nav a[data-nav]');
  // Issue #11: drive the desk in a fresh tab after signing in.
  ab('tab', 'new', `${B}/portal/#/`);
  ab('wait', '--fn', '!document.getElementById("splash")');
  ab('wait', 'header.top nav.nav a[data-nav]');
  ab('eval', 'location.hash = "#/submit"');
  ab('wait', '#d-samples-0-batch_no');
  assert.ok(evalJs('!!document.querySelector(".as-tbl")'), 'the draft shows as a table at 1440 wide');

  // An empty draft has no problem: the description cell is unmarked with an empty title.
  settled();
  assert.equal(titleOf('samples.0.description'), '', 'an unmarked cell has an empty title');

  // Typing a batch number into an otherwise empty row makes the description required.
  ab('fill', '#d-samples-0-batch_no', 'LOT-44');
  ab('wait', '--fn', 'document.querySelector(\'[data-field="samples.0.description"]\').classList.contains("p-ask")', '--timeout', '5000');
  assert.equal(titleOf('samples.0.description'), 'Sample 1 description is required', 'the cell carries the message once it is marked');
  // The edited cell has provenance and no problem: its title is the provenance text.
  const edited = titleOf('samples.0.batch_no');
  assert.equal(edited, 'you edited: You set or confirmed this', 'a cell without a problem shows its provenance');

  // Giving the row a description clears the message.
  ab('fill', '#d-samples-0-description', 'Paracetamol 500 mg');
  ab('wait', '--fn', '!document.querySelector(\'[data-field="samples.0.description"]\').classList.contains("p-ask")', '--timeout', '5000');
  settled();
  assert.equal(titleOf('samples.0.description'), 'you edited: You set or confirmed this', 'the message goes once the description is given');
  assert.equal(titleOf('samples.0.stage'), '', 'an untouched cell stays empty');

  // A full redraw (adding a row rebuilds the table) gives the same titles the refresh gave.
  const before = { d: titleOf('samples.0.description'), b: titleOf('samples.0.batch_no'), s: titleOf('samples.0.stage'), dc: classOf('samples.0.description') };
  ab('click', 'button[data-add]');
  ab('wait', '#d-samples-1-description');
  settled();
  assert.deepEqual({ d: titleOf('samples.0.description'), b: titleOf('samples.0.batch_no'), s: titleOf('samples.0.stage'), dc: classOf('samples.0.description') }, before, 'a redraw and a refresh agree');
});
