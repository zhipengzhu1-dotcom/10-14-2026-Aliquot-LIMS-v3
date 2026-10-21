// The portal submission desk in a real headless browser: typing in a draft field and clicking Send to lab straight
// away, without leaving the field first, sends on the first click (issue #29). Needs the agent-browser CLI and is
// skipped where it is not installed, as on CI.
// Run with:  node --test test/portal-send.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalBrowser, skip } from './portal-browser.js';

const { ab, evalJs, signIn } = portalBrowser('send');

test('the first Send to lab click after typing sends, with the field still focused', { skip }, () => {
  signIn();

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
