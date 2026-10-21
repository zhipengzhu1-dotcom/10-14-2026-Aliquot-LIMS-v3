// scripts/ci-watch.js: what a poll of a pull request means, what the Mac's facts say about stuck CI, and the merge it
// runs, driven end to end through a stand-in for the gh command (test/fake-gh.mjs) so no test reaches GitHub.
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, diagnose, failuresIn, parseStatus, DEFAULT_LIMITS } from '../scripts/ci-watch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEAD = '78e66e21807616397c9b81766d04c6d886463584';
const OLD = '2d94508f778c056bfa42eb8f1aa55929f81794f4';
const NOW = Date.parse('2026-10-21T09:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const passed = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: ago(5), completedAt: ago(4), runId: 1 });

function snap(over = {}) {
  return {
    number: 36, headSha: HEAD, headCommittedAt: ago(10), commits: [OLD, HEAD], state: 'OPEN', draft: false, mergeable: 'MERGEABLE',
    checks: [passed('Linux / Node 22.13.0'), passed('Linux / Node 24')],
    runs: [{ id: 1, attempt: 1, status: 'COMPLETED', conclusion: 'SUCCESS', createdAt: ago(5) }],
    jobs: [], comments: [], now: NOW, watchStartedAt: NOW - 60_000, ...over,
  };
}
const failure = (firstError, job = 'Linux / Node 24') => ({ job, step: 'Run npm test', firstError, tail: [] });
const failedRun = (id, attempt, minutes, failures = [failure('the check passes the server as it is')]) =>
  ({ id, attempt, status: 'COMPLETED', conclusion: 'FAILURE', createdAt: ago(minutes), failures });
const codes = (j) => j.reasons.map((r) => r.code);

const healthy = {
  runners: [{ name: 'animated-runner-1-1', status: 'online', busy: false }, { name: 'animated-runner-2-2', status: 'online', busy: false }],
  runnersError: '', docker: { ok: true, detail: 'server 29.5.2' }, status: parseStatus(0, 'The slots keep the Mac awake.\n'),
  slotLogs: {}, sleeps: [], ahead: [], liveLogs: {},
};
const queuedSnap = () => snap({
  checks: [{ name: 'Linux / Node 24', status: 'QUEUED', conclusion: '', startedAt: null, completedAt: null, runId: 9 }],
  runs: [{ id: 9, attempt: 1, status: 'QUEUED', conclusion: '', createdAt: ago(5) }],
});
const runningSnap = () => snap({
  checks: [{ name: 'Linux / Node 24', status: 'IN_PROGRESS', conclusion: '', startedAt: ago(12), completedAt: null, runId: 9 }],
  runs: [{ id: 9, attempt: 1, status: 'IN_PROGRESS', conclusion: '', createdAt: ago(12) }],
});
const causes = (facts, s) => diagnose(facts, s, judge(s)).map((c) => c.cause);

test('every check passed on the head commit is ready', () => {
  assert.equal(judge(snap()).kind, 'ready');
});

test('a pull request with no checks yet is pending, never ready', () => {
  const j = judge(snap({ checks: [], runs: [] }));
  assert.equal(j.kind, 'pending');
  assert.deepEqual(codes(j), ['no-checks']);
});

test('a failed check fails the watch', () => {
  const j = judge(snap({ checks: [passed('Linux / Node 22.13.0'), { ...passed('Linux / Node 24'), conclusion: 'FAILURE' }], runs: [failedRun(1, 1, 5)] }));
  assert.equal(j.kind, 'failed');
  assert.match(j.reasons[0].text, /Linux \/ Node 24 ended failure/);
});

test('closed, draft and conflicting pull requests are blocked, and a merged one says so', () => {
  assert.deepEqual(codes(judge(snap({ state: 'CLOSED' }))), ['closed']);
  assert.deepEqual(codes(judge(snap({ draft: true }))), ['draft']);
  assert.deepEqual(codes(judge(snap({ mergeable: 'CONFLICTING' }))), ['conflicting']);
  assert.equal(judge(snap({ state: 'MERGED' })).kind, 'merged');
});

test('with --require-verdict, green CI waits for a PASS that names the head commit', () => {
  const opts = { requireVerdict: true };
  const verdict = (body, createdAt = ago(1)) => ({ author: 'owner', body, createdAt });
  assert.equal(judge(snap(), DEFAULT_LIMITS, opts).kind, 'pending');
  assert.equal(judge(snap({ comments: [verdict(`PASS+NOTES — independent review of head \`${HEAD}\`, tested in a separate worktree.`)] }), DEFAULT_LIMITS, opts).kind, 'ready');
  assert.equal(judge(snap({ comments: [verdict(`Head commit ${HEAD.slice(0, 7)}, checked out detached.\n\n**Verdict: PASS**`)] }), DEFAULT_LIMITS, opts).kind, 'ready');
  assert.equal(judge(snap({ comments: [verdict(`Independent verdict: PASS+NOTES at ${OLD.slice(0, 7)}.`)] }), DEFAULT_LIMITS, opts).kind, 'pending', 'a verdict on a stale head does not count');
  assert.equal(judge(snap({ comments: [verdict('Independent verdict: PASS+NOTES', ago(20))] }), DEFAULT_LIMITS, opts).kind, 'pending', 'a verdict naming no commit counts only after the head');
  assert.equal(judge(snap({ comments: [verdict(`PASS on ${HEAD.slice(0, 7)}`, ago(3)), verdict(`FAIL on ${HEAD.slice(0, 7)}`, ago(2))] }), DEFAULT_LIMITS, opts).kind, 'blocked');
});

test('a check queued past its limit is stuck', () => {
  const j = judge(queuedSnap());
  assert.equal(j.kind, 'stuck');
  assert.deepEqual(codes(j), ['queued']);
  assert.equal(judge(queuedSnap(), { ...DEFAULT_LIMITS, queued: 10 * 60_000 }).kind, 'pending');
});

test('a check running past its limit is stuck', () => {
  const j = judge(runningSnap());
  assert.equal(j.kind, 'stuck');
  assert.match(j.reasons[0].text, /running for 12 min, over the 10 min limit/);
});

test('a watch past its limit is stuck', () => {
  const s = snap({ checks: [{ name: 'Linux / Node 24', status: 'IN_PROGRESS', conclusion: '', startedAt: ago(1), completedAt: null, runId: 9 }], watchStartedAt: NOW - 31 * 60_000 });
  assert.deepEqual(codes(judge(s)), ['watch']);
});

test('three re-runs that end without passing are a loop', () => {
  const s = snap({
    checks: [{ name: 'Linux / Node 24', status: 'IN_PROGRESS', conclusion: '', startedAt: ago(1), completedAt: null, runId: 1 }],
    runs: [failedRun(1, 1, 30, [failure('a')]), failedRun(1, 2, 20, [failure('b')]), { ...failedRun(1, 3, 10, [failure('c')]), conclusion: 'CANCELLED' }, { id: 1, attempt: 4, status: 'IN_PROGRESS', conclusion: '', createdAt: ago(1) }],
  });
  const j = judge(s);
  assert.equal(j.kind, 'looping');
  assert.deepEqual(codes(j), ['reruns']);
});

test('the same job failing on the same first error twice in a row is a loop', () => {
  const s = snap({ checks: [{ ...passed('Linux / Node 24'), conclusion: 'FAILURE' }], runs: [failedRun(1, 1, 20), failedRun(1, 2, 10)] });
  const j = judge(s);
  assert.equal(j.kind, 'looping');
  assert.deepEqual(codes(j), ['repeated-failure']);
  assert.equal(judge(snap({ checks: [{ ...passed('Linux / Node 24'), conclusion: 'FAILURE' }], runs: [failedRun(1, 1, 20, [failure('other')]), failedRun(1, 2, 10)] })).kind, 'failed');
});

test('more than five workflow runs for one head commit are a loop', () => {
  const runs = [1, 2, 3, 4, 5, 6].map((id) => ({ id, attempt: 1, status: 'COMPLETED', conclusion: 'SUCCESS', createdAt: ago(id) }));
  const checks = [{ name: 'Linux / Node 24', status: 'IN_PROGRESS', conclusion: '', startedAt: ago(1), completedAt: null, runId: 6 }];
  assert.deepEqual(codes(judge(snap({ runs, checks }))), ['runs']);
});

test('a re-run that finally passes is ready, not a loop', () => {
  assert.equal(judge(snap({ runs: [failedRun(1, 1, 30), failedRun(1, 2, 20), failedRun(1, 3, 10), { id: 1, attempt: 4, status: 'COMPLETED', conclusion: 'SUCCESS', createdAt: ago(5) }] })).kind, 'ready');
});

test('a repeated identical failure is diagnosed as a real failure, not the runner', () => {
  const s = snap({ checks: [{ ...passed('Linux / Node 24'), conclusion: 'FAILURE' }], runs: [failedRun(1, 1, 20), failedRun(1, 2, 10)] });
  const [first] = diagnose(healthy, s, judge(s));
  assert.match(first.cause, /real failure in the code, not the runner/);
  assert.ok(first.evidence.some((e) => e.includes('the check passes the server as it is')));
});

test('no runner online is diagnosed, with start when the slots are stopped', () => {
  const facts = { ...healthy, runners: [], status: parseStatus(1, 'No slot keeps the Mac awake. Run stop, then start.\n') };
  const [first] = diagnose(facts, queuedSnap(), judge(queuedSnap()));
  assert.match(first.cause, /No animated-runner is online/);
  assert.ok(first.fix.some((f) => f.endsWith('scripts/animated-runner.sh start')));
});

test('slots serving the legacy repo are diagnosed from the status output, with the stop to run', () => {
  const script = '/Users/owner/Desktop/Claude/10. October 2026/live/scripts/animated-runner.sh';
  const out = `The slots keep the Mac awake.\nThe slots run ${script}, which serves zhipengzhu1-dotcom/10-04-2026-Animated-LIMS, not zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3. Run "${script}" stop, then start from the runner worktree (docs/ci-runner.md).\n`;
  const facts = { ...healthy, runners: [], status: parseStatus(1, out) };
  const [first, ...rest] = diagnose(facts, queuedSnap(), judge(queuedSnap()));
  assert.match(first.cause, /serve another repo/);
  assert.deepEqual(first.evidence, [`slots run ${script}, which serves zhipengzhu1-dotcom/10-04-2026-Animated-LIMS`]);
  assert.equal(first.fix[0], `"${script}" stop`);
  assert.ok(rest.some((c) => /No animated-runner is online/.test(c.cause)), 'every matching rule is reported');
});

test('Docker Desktop not running is diagnosed', () => {
  const facts = { ...healthy, runners: [], docker: { ok: false, detail: 'Cannot connect to the Docker daemon' } };
  assert.match(causes(facts, queuedSnap())[0], /Docker Desktop is not running/);
});

test('both runners busy is diagnosed with the runs ahead', () => {
  const facts = { ...healthy, runners: healthy.runners.map((r) => ({ ...r, busy: true })), ahead: [{ id: 5, status: 'in_progress', createdAt: ago(9) }, { id: 6, status: 'queued', createdAt: ago(8) }] };
  const [first] = diagnose(facts, queuedSnap(), judge(queuedSnap()));
  assert.match(first.cause, /Every runner is busy/);
  assert.ok(first.evidence.includes('2 other runs queued or running ahead of this one'));
});

test('a job running long while the Mac slept is diagnosed as a lost heartbeat', () => {
  const facts = { ...healthy, sleeps: [ago(8)] };
  const [first] = diagnose(facts, runningSnap(), judge(runningSnap()));
  assert.match(first.cause, /the Mac may have slept/);
  assert.ok(first.fix.includes('gh run rerun 9 --failed --repo zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3'));
  assert.deepEqual(diagnose({ ...healthy, runners: healthy.runners.map((r) => ({ ...r, busy: true })) }, runningSnap(), judge(runningSnap())), [], 'awake and busy is no known cause');
});

test('an unknown cause gives no diagnosis, so the raw facts are printed', () => {
  assert.deepEqual(diagnose(healthy, queuedSnap(), judge(queuedSnap())), []);
});

test('a failure log gives each job its first failing test and the lines before cleanup', () => {
  const row = (job, text) => `${job}\tUNKNOWN STEP\t2026-10-18T08:17:01.6003012Z ${text}`;
  const log = [
    row('Linux / Node 24', '✔ only people who assign work see the workload (112ms)'),
    row('Linux / Node 24', '✖ the check passes the server as it is (1726.10246ms)'),
    row('Linux / Node 24', '##[error]Process completed with exit code 1.'),
    row('Linux / Node 24', 'Post job cleanup.'),
    row('Linux / Node 24', '[command]/usr/bin/git version'),
    row('Linux / Node 22.13.0', 'not ok 109 - the check passes the server as it is'),
    row('Linux / Node 22.13.0', '##[error]Process completed with exit code 1.'),
  ].join('\n');
  const jobs = [{ name: 'Linux / Node 24', steps: [{ name: 'Run npm run check', conclusion: 'success' }, { name: 'Run npm test', conclusion: 'failure' }] }];
  const [node24, node22] = failuresIn(log, jobs);
  assert.deepEqual([node24.job, node24.step, node24.firstError], ['Linux / Node 24', 'Run npm test', 'the check passes the server as it is']);
  assert.equal(node24.tail.at(-1), '##[error]Process completed with exit code 1.');
  assert.equal(node22.firstError, 'the check passes the server as it is');
});

const prView = (sha, conclusion = 'SUCCESS', status = 'COMPLETED', extra = {}) => ({
  number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: sha,
  commits: [{ oid: sha, committedDate: '2026-10-21T08:00:00Z' }], comments: [],
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'Linux / Node 24', status, conclusion: status === 'COMPLETED' ? conclusion : '', startedAt: new Date().toISOString(), completedAt: null, detailsUrl: 'https://github.com/x/y/actions/runs/1/job/2' }],
  ...extra,
});

/** Runs the watcher with a fake gh on PATH; resolves to its exit code, output and the gh calls it made. */
function watch(scenario, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-fake-gh-'));
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test', 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ci-watch.js'), '7', '--interval', '0', ...args], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code) => {
    const log = path.join(dir, 'calls.jsonl');
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    fs.rmSync(dir, { recursive: true, force: true });
    resolve({ code, out, merges: calls.filter((c) => c[0] === 'pr' && c[1] === 'merge') });
  }));
}

test('--merge merges a green pull request with a merge commit pinned to the head it saw', async () => {
  const r = await watch({ prs: [prView(HEAD, '', 'IN_PROGRESS'), prView(HEAD)] }, '--merge');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.merges, [['pr', 'merge', '7', '--repo', 'zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3', '--merge', '--match-head-commit', HEAD]]);
  assert.match(r.out, /Merged .*#7 at 78e66e2/);
});

test('a merge refused because the head moved watches the new head and merges that', async () => {
  const r = await watch({ prs: [prView(OLD), prView(HEAD, '', 'IN_PROGRESS'), prView(HEAD)], merges: [1, 0] }, '--merge');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.merges.map((c) => c.at(-1)), [OLD, HEAD]);
  assert.match(r.out, /head moved to 78e66e2/);
});

test('without --merge a green pull request is reported ready and not merged', async () => {
  const r = await watch({ prs: [prView(HEAD)] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.merges, []);
  assert.match(r.out, /Ready to merge/);
});

test('a failed check is never merged', async () => {
  const r = await watch({ prs: [prView(HEAD, 'FAILURE')] }, '--merge');
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.merges, []);
  assert.match(r.out, /Not merging after a failure/);
});

test('with --require-verdict a green pull request without a verdict is not merged', async () => {
  const r = await watch({ prs: [prView(HEAD), prView(HEAD), prView(HEAD, 'SUCCESS', 'COMPLETED', { state: 'CLOSED' })] }, '--merge', '--require-verdict');
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.merges, []);
  assert.match(r.out, /waiting for a PASS verdict/);
});

test('a bad command line is a usage error', async () => {
  const r = await watch({ prs: [prView(HEAD)] }, '--interval', 'soon');
  assert.equal(r.code, 2);
  assert.match(r.out, /usage: node scripts\/ci-watch\.js/);
});
