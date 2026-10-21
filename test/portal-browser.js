// Shared setup for the portal tests that drive a real headless browser with the agent-browser CLI: a throwaway server
// with the demo lab, one browser session per test file, and the demo sign-in with the new-tab workaround (issue #11).
// Where agent-browser is not installed, as on CI, `skip` is the reason the tests give for skipping.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const HAVE_BROWSER = spawnSync('agent-browser', ['--version']).status === 0;
export const skip = !HAVE_BROWSER && 'agent-browser is not installed';

/** Registers the file's before/after hooks and returns the browser and server helpers its tests share. */
export function portalBrowser(name) {
  const session = `aliquot-${name}-${process.pid}`;
  const env = { ...process.env, AGENT_BROWSER_SESSION: session };
  let server;
  let dataDir;
  let tabs = 0;

  const ab = (...args) => execFileSync('agent-browser', args, { env, encoding: 'utf8', timeout: 60_000 }).trim();
  const evalJs = (js) => JSON.parse(ab('eval', js));

  before(async () => {
    if (!HAVE_BROWSER) return;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aliquot-${name}-test-`));
    server = await startServer(dataDir);
    const setup = await fetch(`${server.base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aliquot' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    assert.equal(setup.status, 200, `demo setup failed: ${server.log()}`);
    ab('set', 'viewport', '1440', '1000');
    ab('set', 'media', 'light', 'reduced-motion');
  });

  after(async () => {
    if (!HAVE_BROWSER) return;
    spawnSync('agent-browser', ['close'], { env });
    await server?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Opens `hash` in a new tab and waits for the splash to go; each tab loads a fresh portal, with a fresh submission desk. */
  const openTab = (hash = '#/') => {
    const url = `${server.base}/portal/?tab=${++tabs}${hash}`;
    if (tabs === 1) ab('open', url);
    else ab('tab', 'new', url);
    ab('wait', '--fn', '!document.getElementById("splash")');
  };

  /** Signed out, in a new tab: the sign-in card with its demo buttons. */
  const signInCard = (email = 'customer@example.com') => {
    ab('cookies', 'clear');
    openTab();
    ab('wait', `[data-demo="${email}"]`);
    ab('scrollintoview', `[data-demo="${email}"]`);
  };

  /** Signs in with the demo button and continues in a new tab, since clicks stop landing in the sign-in tab (issue #11). */
  const signIn = (email = 'customer@example.com') => {
    signInCard(email);
    ab('click', `[data-demo="${email}"]`);
    ab('wait', 'header.top nav.nav a[data-nav]');
    openTab();
    ab('wait', 'header.top nav.nav a[data-nav]');
  };

  return { ab, evalJs, signInCard, signIn, get base() { return server.base; } };
}
