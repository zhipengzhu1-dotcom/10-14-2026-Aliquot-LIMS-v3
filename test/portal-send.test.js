// The portal submission desk in a real headless browser: typing in a draft field and clicking Send to lab straight
// away, without leaving the field first, sends on the first click (issue #29). Needs the agent-browser CLI and is
// skipped where it is not installed, as on CI.
// Run with:  node --test test/portal-send.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const HAVE_BROWSER = spawnSync('agent-browser', ['--version']).status === 0;
const SESSION = `aliquot-test-${process.pid}`;
let server;
let dataDir;

const ab = (...args) => execFileSync('agent-browser', args, {
  env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
  encoding: 'utf8',
  timeout: 60_000,
}).trim();
const evalJs = (js) => JSON.parse(ab('eval', js));

before(async () => {
  if (!HAVE_BROWSER) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-send-test-'));
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

test('the first Send to lab click after typing sends, with the field still focused', { skip: !HAVE_BROWSER && 'agent-browser is not installed' }, () => {
  const B = server.base;
  ab('set', 'viewport', '1440', '1000');
  ab('set', 'media', 'light', 'reduced-motion');
  ab('open', `${B}/portal/`);
  ab('wait', '--fn', '!document.getElementById("splash")');
  ab('wait', '[data-demo="customer@example.com"]');
  ab('scrollintoview', '[data-demo="customer@example.com"]');
  ab('click', '[data-demo="customer@example.com"]');
  ab('wait', 'header.top nav.nav a[data-nav]');
  ab('tab', 'new', `${B}/portal/#/`);
  ab('wait', '--fn', '!document.getElementById("splash")');
  ab('wait', 'header.top nav.nav a[data-nav]');

  for (let i = 1; i <= 3; i++) {
    ab('eval', 'location.hash = "#/submit"');
    ab('wait', '#d-samples-0-description');
    ab('fill', '#d-samples-0-description', `First-click sample ${i}`);
    ab('wait', '--fn', '!document.querySelector("button.js-send").disabled');
    assert.equal(evalJs('document.activeElement.id'), 'd-samples-0-description', 'the field still has focus when Send is clicked');
    ab('click', 'button.js-send');
    ab('wait', '--fn', 'location.hash.includes("sent=1")', '--timeout', '5000');
    assert.match(evalJs('location.hash'), /^#\/submissions\/\d+\?sent=1$/, `try ${i}: one click sent the submission`);
  }
});
