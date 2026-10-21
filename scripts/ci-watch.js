// Watches a pull request until CI reaches a verdict. With --merge it merges a green pull request with a merge commit,
// and it diagnoses CI that is stuck or looping from what the Mac running the runners says (docs/ci-runner.md).
// No dependencies needed.
// Usage:  node scripts/ci-watch.js <pr-number> [--merge] [--require-verdict] [--interval <seconds>]
//                                  [--queued <minutes>] [--running <minutes>] [--timeout <minutes>]
// Exits 0 when the pull request is ready or merged, 1 when it failed, is stuck, loops or is blocked, 2 on a usage error.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = 'zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3';
const RUNNER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'animated-runner.sh');
const RUNNER_WORKTREE = '~/Desktop/Claude/10.\\ October\\ 2026/aliquot-ci-runner';
const SLOT_LOGS = path.join(os.homedir(), 'Library', 'Logs', 'animated-runner');
const USUAL_SECONDS = 35;
const MINUTE = 60_000;
export const DEFAULT_LIMITS = { queued: 3 * MINUTE, running: 10 * MINUTE, watch: 30 * MINUTE };
// Re-runs of one head commit that end non-green, and workflow runs created for it, before the watch calls it a loop.
const LOOP_ATTEMPTS = 3;
const LOOP_RUNS = 5;
const PASSING = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAILING = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/**
 * @typedef {{ name: string, status: string, conclusion: string, startedAt: string|null, completedAt: string|null, runId: number|null }} Check
 * @typedef {{ job: string, step: string, firstError: string, tail: string[] }} Failure
 * @typedef {{ id: number, attempt: number, status: string, conclusion: string, createdAt: string, failures?: Failure[] }} Attempt
 * @typedef {{ runId: number, id: number, name: string, status: string, step: string, startedAt: string|null }} Job
 * @typedef {{ author: string, body: string, createdAt: string }} Comment
 * @typedef {{ number: number, headSha: string, headCommittedAt: string, commits: string[], state: string, draft: boolean,
 *   mergeable: string, checks: Check[], runs: Attempt[], jobs: Job[], comments: Comment[], now: number, watchStartedAt: number }} Snapshot
 *   One poll of the pull request. `runs` holds every attempt of every workflow run for the head commit, re-runs included.
 * @typedef {{ code: string, text: string }} Reason
 * @typedef {{ kind: 'ready'|'pending'|'failed'|'blocked'|'stuck'|'looping'|'merged', reasons: Reason[] }} Judgment
 * @typedef {{ runners: { name: string, status: string, busy: boolean }[]|null, runnersError: string,
 *   docker: { ok: boolean, detail: string }, status: { code: number, out: string, awake: boolean, wrongRepo: { script: string, repo: string }[] },
 *   slotLogs: Record<string, string[]>, sleeps: string[], ahead: { id: number, status: string, createdAt: string }[], liveLogs: Record<string, string[]> }} Facts
 *   What the Mac and the runner registrations say, collected once when the watch is stuck or looping.
 */

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const minutes = (n) => `${Math.round(n / MINUTE * 10) / 10} min`;
const reason = (code, text) => ({ code, text });

/** The attempts that ended, oldest first. */
const completed = (s) => s.runs.filter((r) => r.status === 'COMPLETED').sort((a, b) => ms(a.createdAt) - ms(b.createdAt));

/** The latest PASS or FAIL comment on the head commit. A comment counts when it names the head, or names no commit of the pull request and came after the head. */
function verdictOn(s) {
  let latest = null;
  for (const c of [...s.comments].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) {
    const line = c.body.replace(/[*_`]/g, '').split('\n').map((l) => l.trim())
      .map((l) => l.match(/^(?:(?:[Ii]ndependent )?[Vv]erdict:\s*)?(PASS\+NOTES|PASS|FAIL)\b/)).find(Boolean);
    if (!line) continue;
    const named = (c.body.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter((t) => s.commits.some((oid) => oid.startsWith(t)));
    const onHead = named.length ? named.some((t) => s.headSha.startsWith(t)) : ms(c.createdAt) >= ms(s.headCommittedAt);
    if (onHead) latest = line[1] === 'FAIL' ? 'FAIL' : 'PASS';
  }
  return latest;
}

/** Two attempts in a row that failed the same job on the same first error line. */
function repeatedFailure(s) {
  const done = completed(s);
  for (let i = done.length - 1; i > 0; i--) {
    const [a, b] = [done[i - 1], done[i]];
    if (PASSING.has(a.conclusion) || PASSING.has(b.conclusion)) continue;
    const same = (b.failures ?? []).find((f) => (a.failures ?? []).some((g) => g.job === f.job && g.firstError === f.firstError));
    if (same) return { failure: same, attempts: [a, b] };
  }
  return null;
}

const green = (s) => s.checks.length > 0 && s.checks.every((c) => c.status === 'COMPLETED' && PASSING.has(c.conclusion));

const queuedSince = (s, c) => {
  const run = s.runs.filter((r) => r.id === c.runId).sort((a, b) => b.attempt - a.attempt)[0];
  return ms(run?.createdAt ?? c.startedAt);
};

// Each rule returns the reasons it matches, or none. The first rule with reasons decides the kind.
const JUDGE_RULES = [
  ['merged', (s) => (s.state === 'MERGED' ? [reason('merged', 'the pull request is already merged')] : [])],
  ['blocked', (s, limits, opts) => [
    s.state === 'CLOSED' && reason('closed', 'the pull request is closed'),
    s.draft && reason('draft', 'the pull request is a draft'),
    s.mergeable === 'CONFLICTING' && reason('conflicting', 'the pull request conflicts with its base branch'),
    opts.requireVerdict && verdictOn(s) === 'FAIL' && reason('verdict-fail', `the independent verdict on ${s.headSha.slice(0, 7)} is FAIL`),
  ].filter(Boolean)],
  ['looping', (s) => {
    // A re-run that finally passes is flaky, not looping, and green CI is ready.
    if (green(s)) return [];
    const nonGreen = completed(s).filter((r) => !PASSING.has(r.conclusion));
    const runIds = new Set(s.runs.map((r) => r.id));
    const repeated = repeatedFailure(s);
    return [
      nonGreen.length >= LOOP_ATTEMPTS && reason('reruns', `${nonGreen.length} runs of ${s.headSha.slice(0, 7)} ended without passing (${nonGreen.map((r) => `${r.id} attempt ${r.attempt} ${r.conclusion.toLowerCase()}`).join(', ')})`),
      runIds.size > LOOP_RUNS && reason('runs', `${runIds.size} workflow runs were created for ${s.headSha.slice(0, 7)}`),
      repeated && reason('repeated-failure', `"${repeated.failure.job}" failed twice in a row on: ${repeated.failure.firstError}`),
    ].filter(Boolean);
  }],
  ['failed', (s) => s.checks.filter((c) => FAILING.has(c.conclusion)).map((c) => reason('check-failed', `${c.name} ended ${c.conclusion.toLowerCase()}`))],
  ['ready', (s, limits, opts) => {
    if (!green(s)) return [];
    if (opts.requireVerdict && verdictOn(s) !== 'PASS') return [];
    return [reason('green', `${s.checks.length} checks passed on ${s.headSha.slice(0, 7)}${opts.requireVerdict ? ', with a PASS verdict' : ''}`)];
  }],
  ['stuck', (s, limits, opts) => {
    const waitingOnVerdict = green(s) && opts.requireVerdict;
    return [
      ...s.checks.filter((c) => c.status !== 'COMPLETED' && c.status !== 'IN_PROGRESS' && s.now - queuedSince(s, c) > limits.queued)
        .map((c) => reason('queued', `${c.name} has been queued for ${minutes(s.now - queuedSince(s, c))}, over the ${minutes(limits.queued)} limit`)),
      ...s.checks.filter((c) => c.status === 'IN_PROGRESS' && s.now - ms(c.startedAt) > limits.running)
        .map((c) => reason('running', `${c.name} has been running for ${minutes(s.now - ms(c.startedAt))}, over the ${minutes(limits.running)} limit (a run usually takes ${USUAL_SECONDS} s)`)),
      s.now - s.watchStartedAt > limits.watch && reason(waitingOnVerdict ? 'verdict-missing' : 'watch', waitingOnVerdict
        ? `CI passed but no PASS verdict names ${s.headSha.slice(0, 7)} after ${minutes(s.now - s.watchStartedAt)} of watching`
        : `no verdict after ${minutes(s.now - s.watchStartedAt)} of watching, over the ${minutes(limits.watch)} limit`),
    ].filter(Boolean);
  }],
];

/** What one poll means. It is pure, so everything it needs is in the snapshot. */
export function judge(s, limits = DEFAULT_LIMITS, opts = {}) {
  for (const [kind, rule] of JUDGE_RULES) {
    const reasons = rule(s, limits, opts);
    if (reasons.length) return { kind, reasons };
  }
  if (!s.checks.length) return { kind: 'pending', reasons: [reason('no-checks', `no checks yet on ${s.headSha.slice(0, 7)}`)] };
  const open = s.checks.filter((c) => c.status !== 'COMPLETED');
  if (!open.length) return { kind: 'pending', reasons: [reason('verdict-missing', `CI passed, waiting for a PASS verdict that names ${s.headSha.slice(0, 7)}`)] };
  return { kind: 'pending', reasons: open.map((c) => reason('waiting', `${c.name} is ${c.status.toLowerCase().replace('_', ' ')}`)) };
}

const ownRunners = (f) => (f.runners ?? []).filter((r) => r.name.startsWith('animated-runner-'));
const has = (j, code) => j.reasons.some((r) => r.code === code);

// Every rule whose match returns evidence is printed; the first one is the likely cause.
const DIAGNOSIS_RULES = [
  {
    cause: 'The same test fails the same way on every run. This is a real failure in the code, not the runner.',
    match: (f, s, j) => {
      const r = has(j, 'repeated-failure') && repeatedFailure(s);
      return r && [`${r.failure.job} failed at "${r.failure.step}" in run ${r.attempts[0].id} attempt ${r.attempts[0].attempt} and run ${r.attempts[1].id} attempt ${r.attempts[1].attempt}`, `first error: ${r.failure.firstError}`];
    },
    fix: () => ['Reproduce it locally with: npm test', 'Fix the code and push. Re-running CI will fail the same way.'],
  },
  {
    cause: 'CI passed, but no independent verdict names the head commit.',
    match: (f, s, j) => has(j, 'verdict-missing') && [`head ${s.headSha}`, `verdict on head: ${verdictOn(s) ?? 'none'}`],
    fix: (f, s) => [`Post the verdict as a comment on the pull request that starts with PASS or PASS+NOTES and names ${s.headSha.slice(0, 7)}, or watch without --require-verdict.`],
  },
  {
    cause: 'The runner slots serve another repo, so no runner takes this repo\'s jobs.',
    match: (f) => f.status.wrongRepo.length && f.status.wrongRepo.map((w) => `slots run ${w.script}, which serves ${w.repo || 'no repo'}`),
    fix: (f) => [...new Set(f.status.wrongRepo.map((w) => `"${w.script}" stop`)), `cd ${RUNNER_WORKTREE} && scripts/animated-runner.sh start`],
  },
  {
    cause: 'Docker Desktop is not running, so no runner container can start.',
    match: (f) => !f.docker.ok && [`docker info: ${f.docker.detail}`],
    fix: () => ['open -a Docker', `cd ${RUNNER_WORKTREE} && scripts/animated-runner.sh status`],
  },
  {
    cause: 'No animated-runner is online on the repo, so the jobs wait in the queue.',
    match: (f) => f.runners && !ownRunners(f).some((r) => r.status === 'online') && [
      ownRunners(f).length ? `registered: ${ownRunners(f).map((r) => `${r.name} ${r.status}`).join(', ')}` : 'no animated-runner is registered',
      f.status.awake ? 'the slots run under caffeinate, so read the slot logs' : 'no slot runs, so the runners are stopped',
    ],
    fix: (f) => (f.status.awake
      ? [`tail -50 ${path.join(SLOT_LOGS, '1.log')}`, `cd ${RUNNER_WORKTREE} && scripts/animated-runner.sh status`]
      : [`cd ${RUNNER_WORKTREE} && scripts/animated-runner.sh start`]),
  },
  {
    cause: 'A job runs far past its usual time while the Mac may have slept. A sleeping Mac freezes the runner, and GitHub fails the job about 10 minutes after the last heartbeat.',
    match: (f, s, j) => {
      if (!has(j, 'running')) return null;
      const since = Math.min(...s.checks.filter((c) => c.status === 'IN_PROGRESS').map((c) => ms(c.startedAt)));
      const slept = f.sleeps.filter((t) => ms(t) >= since);
      const busy = f.runners && ownRunners(f).filter((r) => r.status === 'online' && r.busy);
      if (!slept.length && (!busy || busy.length)) return null;
      return [slept.length ? `the Mac slept at ${slept.join(', ')}` : 'no Mac sleep logged since the job started',
        !busy ? `runners unknown: ${f.runnersError}` : busy.length ? `busy runners: ${busy.map((r) => r.name).join(', ')}` : 'no online runner is busy, so nothing is running the job'];
    },
    fix: (f, s) => [
      'Wait for GitHub to fail the job, then re-run it:',
      ...new Set(s.checks.filter((c) => c.status === 'IN_PROGRESS' && c.runId).map((c) => `gh run rerun ${c.runId} --failed --repo ${REPO}`)),
      'Keep the lid open while CI runs. Sleep from the Apple menu or a closed lid still sleeps the Mac.',
    ],
  },
  {
    cause: 'Every runner is busy with other jobs, so this one waits its turn.',
    match: (f, s, j) => {
      const online = ownRunners(f).filter((r) => r.status === 'online');
      return has(j, 'queued') && online.length && online.every((r) => r.busy) && [`busy: ${online.map((r) => r.name).join(', ')}`, `${f.ahead.length} other runs queued or running ahead of this one`];
    },
    fix: () => [`Nothing is broken. See the queue with: gh run list --repo ${REPO} --status in_progress`, 'Run the watch again once the queue drains.'],
  },
];

/** The likely causes of a stuck or looping watch, first match first. It is pure, so everything it needs is in its arguments. */
export function diagnose(facts, s, j) {
  return DIAGNOSIS_RULES.map((rule) => {
    const evidence = rule.match(facts, s, j);
    return evidence ? { cause: rule.cause, evidence, fix: rule.fix(facts, s) } : null;
  }).filter(Boolean);
}

/** The text of a `gh run view --log-failed` line, without its job, step and timestamp columns. */
const logText = (line) => line.split('\t').slice(2).join('\t').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');

/** Each job's failure out of a `--log-failed` log: the first failing test or error, and the lines before the cleanup. */
export function failuresIn(log, jobs) {
  const byJob = new Map();
  for (const line of log.split('\n')) {
    if (!line.includes('\t')) continue;
    const job = line.split('\t')[0];
    byJob.set(job, [...(byJob.get(job) ?? []), logText(line)]);
  }
  return [...byJob].map(([job, lines]) => {
    const end = lines.findIndex((l) => l === 'Post job cleanup.');
    const body = end === -1 ? lines : lines.slice(0, end);
    const first = body.map((l) => l.match(/^not ok \d+ - (.+)$/)?.[1] ?? l.match(/^✖ (?!failing tests)(.+?)(?: \([\d.]+m?s\))?$/)?.[1]).find(Boolean)
      ?? body.map((l) => l.match(/##\[error\](.+)/)?.[1]).find(Boolean) ?? body.findLast((l) => l.trim()) ?? '';
    const step = jobs.find((j) => j.name === job)?.steps.find((st) => FAILING.has(st.conclusion?.toUpperCase()))?.name ?? 'unknown step';
    return { job, step, firstError: first.trim(), tail: body.filter((l) => l.trim()).slice(-30) };
  });
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr || r.error?.message || '' };
}
function ghJson(args) {
  const r = gh(args);
  if (r.code) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${r.err.trim()}`);
  return JSON.parse(r.out || 'null');
}

const upper = (v) => String(v ?? '').toUpperCase();
const realTime = (iso) => (iso && !iso.startsWith('0001') ? iso : null);
// Attempts that ended never change, so each is fetched once, with its failure log.
const finished = new Map();

function attemptsOf(run) {
  const latest = { id: run.databaseId, attempt: run.attempt, status: upper(run.status), conclusion: upper(run.conclusion), createdAt: run.startedAt || run.createdAt };
  const all = [latest];
  for (let n = 1; n < run.attempt; n++) {
    const key = `${run.databaseId}/${n}`;
    if (!finished.has(key)) {
      const a = ghJson(['api', `repos/${REPO}/actions/runs/${run.databaseId}/attempts/${n}`]);
      finished.set(key, { id: a.id, attempt: a.run_attempt, status: upper(a.status), conclusion: upper(a.conclusion), createdAt: a.run_started_at || a.created_at });
    }
    all.push(finished.get(key));
  }
  return all.map((a) => {
    if (a.status !== 'COMPLETED' || PASSING.has(a.conclusion)) return a;
    const key = `${a.id}/${a.attempt}/failures`;
    if (!finished.has(key)) {
      const log = gh(['run', 'view', String(a.id), '--repo', REPO, '--attempt', String(a.attempt), '--log-failed']).out;
      const jobs = gh(['run', 'view', String(a.id), '--repo', REPO, '--attempt', String(a.attempt), '--json', 'jobs']);
      finished.set(key, failuresIn(log, jobs.code ? [] : JSON.parse(jobs.out).jobs));
    }
    return { ...a, failures: finished.get(key) };
  });
}

/** One poll of the pull request through gh. The only place that reads GitHub's view of the pull request. */
export function takeSnapshot(pr, watchStartedAt) {
  const p = ghJson(['pr', 'view', String(pr), '--repo', REPO, '--json', 'number,state,isDraft,mergeable,headRefOid,statusCheckRollup,comments,commits']);
  const checks = (p.statusCheckRollup ?? []).map((c) => (c.__typename === 'StatusContext'
    ? { name: c.context, status: c.state === 'PENDING' || c.state === 'EXPECTED' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: c.state === 'PENDING' || c.state === 'EXPECTED' ? '' : upper(c.state), startedAt: realTime(c.startedAt), completedAt: null, runId: null }
    : { name: c.name, status: upper(c.status), conclusion: upper(c.conclusion), startedAt: realTime(c.startedAt), completedAt: realTime(c.completedAt), runId: Number(c.detailsUrl?.match(/\/runs\/(\d+)/)?.[1]) || null }));
  const list = ghJson(['run', 'list', '--repo', REPO, '--commit', p.headRefOid, '--limit', '100', '--json', 'databaseId,attempt,status,conclusion,createdAt,startedAt']) ?? [];
  const runs = list.flatMap(attemptsOf);
  const jobs = list.filter((r) => upper(r.status) !== 'COMPLETED').flatMap((r) => {
    const v = gh(['run', 'view', String(r.databaseId), '--repo', REPO, '--json', 'jobs']);
    return v.code ? [] : JSON.parse(v.out).jobs.map((j) => ({ runId: r.databaseId, id: j.databaseId, name: j.name, status: upper(j.status), step: j.steps?.find((st) => upper(st.status) === 'IN_PROGRESS')?.name ?? '', startedAt: realTime(j.startedAt) }));
  });
  const head = p.commits?.at(-1);
  return {
    number: p.number, headSha: p.headRefOid, headCommittedAt: head?.committedDate ?? '', commits: (p.commits ?? []).map((c) => c.oid),
    state: p.state, draft: p.isDraft, mergeable: p.mergeable, checks, runs, jobs,
    comments: (p.comments ?? []).map((c) => ({ author: c.author?.login ?? '', body: c.body ?? '', createdAt: c.createdAt })),
    now: Date.now(), watchStartedAt,
  };
}

/** What `scripts/animated-runner.sh status` printed and exited with, read only for the lines that script prints. */
export function parseStatus(code, out) {
  const wrongRepo = [...out.matchAll(/^The slots run (.+), which serves (.+), not \S+\. Run /gm)].map((m) => ({ script: m[1], repo: m[2] === 'no repo' ? '' : m[2] }));
  return { code, out: out.trim(), awake: out.includes('The slots keep the Mac awake.'), wrongRepo };
}

const tail = (file, n) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-n) : [`${file} does not exist`]);

/** What the Mac says about the runners. Slow (the status command can wait 30 s), so it runs only when the watch is stuck or looping. */
export function collectFacts(s) {
  const runners = gh(['api', '--paginate', `repos/${REPO}/actions/runners`, '--jq', '.runners[] | [.name, .status, .busy] | @tsv']);
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20_000 });
  const status = spawnSync(RUNNER_SCRIPT, ['status'], { encoding: 'utf8', timeout: 90_000 });
  const pmset = spawnSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  const sleeps = [...(pmset.stdout ?? '').matchAll(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [-+]\d{4}) Sleep\s/gm)]
    .map((m) => new Date(m[1].replace(' ', 'T').replace(/ ([-+]\d\d)(\d\d)$/, '$1:$2')).toISOString())
    .filter((t) => ms(t) >= s.now - 2 * 60 * MINUTE);
  const active = ['queued', 'in_progress'].flatMap((st) => ghJson(['run', 'list', '--repo', REPO, '--status', st, '--limit', '100', '--json', 'databaseId,status,createdAt,headSha']) ?? []);
  const mine = Math.min(...s.runs.filter((r) => r.status !== 'COMPLETED').map((r) => ms(r.createdAt)));
  const liveLogs = Object.fromEntries(s.jobs.filter((j) => j.status === 'IN_PROGRESS').map((j) => {
    const r = gh(['api', `repos/${REPO}/actions/jobs/${j.id}/logs`]);
    return [j.name, r.code ? [`gh cannot give the live log yet: ${r.err.trim().split('\n')[0]}`] : r.out.split('\n').filter((l) => l.trim()).slice(-20)];
  }));
  return {
    runners: runners.code ? null : runners.out.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([name, st, busy]) => ({ name, status: st, busy: busy === 'true' })),
    runnersError: runners.code ? runners.err.trim() : '',
    docker: { ok: docker.status === 0, detail: docker.status === 0 ? `server ${docker.stdout.trim()}` : (docker.stderr || docker.error?.message || 'no answer').trim().split('\n')[0] },
    status: parseStatus(status.status ?? 1, `${status.stdout ?? ''}${status.stderr ?? ''}`),
    slotLogs: Object.fromEntries(['1', '2'].map((n) => [n, tail(path.join(SLOT_LOGS, `${n}.log`), 10)])),
    sleeps,
    ahead: active.filter((r) => r.headSha !== s.headSha && ms(r.createdAt) < mine).map((r) => ({ id: r.databaseId, status: r.status, createdAt: r.createdAt })),
    liveLogs,
  };
}

// A missing verdict is not the Mac's doing, so its diagnosis asks the Mac nothing.
const NO_FACTS = { runners: null, runnersError: '', docker: { ok: true, detail: '' }, status: { code: 0, out: '', awake: true, wrongRepo: [] }, slotLogs: {}, sleeps: [], ahead: [], liveLogs: {} };

const say = (lines, indent = '  ') => lines.forEach((l) => console.log(`${indent}${l}`));

function report(s, j, f) {
  const running = s.jobs.filter((job) => job.status === 'IN_PROGRESS');
  if (has(j, 'running')) {
    for (const job of running) {
      console.log(`${job.name} is at step "${job.step || 'unknown'}", running for ${minutes(s.now - ms(job.startedAt))} (usually ${USUAL_SECONDS} s in total).`);
      say(f.liveLogs[job.name] ?? []);
    }
  }
  const causes = diagnose(f, s, j);
  if (!causes.length) {
    console.log('No known cause matches. What the Mac and GitHub say:');
    say([`runners: ${f.runners ? f.runners.map((r) => `${r.name} ${r.status}${r.busy ? ' busy' : ''}`).join(', ') || 'none registered' : f.runnersError}`,
      `docker: ${f.docker.ok ? 'answers' : 'no answer'} (${f.docker.detail})`,
      `animated-runner.sh status exited ${f.status.code}:`, ...f.status.out.split('\n').map((l) => `  ${l}`),
      `Mac sleeps in the last 2 hours: ${f.sleeps.join(', ') || 'none'}`,
      `other runs ahead: ${f.ahead.length}`]);
  }
  causes.forEach((c, i) => {
    console.log(`${i ? 'Also seen' : 'Likely cause'}: ${c.cause}`);
    say(c.evidence);
    console.log(i ? '  What to do:' : 'What to do:');
    say(c.fix, '    ');
  });
  for (const [slot, lines] of Object.entries(f.slotLogs)) {
    console.log(`Slot ${slot} log (${path.join(SLOT_LOGS, `${slot}.log`)}):`);
    say(lines);
  }
}

const USAGE = 'usage: node scripts/ci-watch.js <pr-number> [--merge] [--require-verdict] [--interval <seconds>] [--queued <minutes>] [--running <minutes>] [--timeout <minutes>]';
const EXIT = { ready: 0, merged: 0, failed: 1, blocked: 1, stuck: 1, looping: 1 };

async function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: {
      merge: { type: 'boolean' }, 'require-verdict': { type: 'boolean' }, interval: { type: 'string', default: '30' },
      queued: { type: 'string', default: '3' }, running: { type: 'string', default: '10' }, timeout: { type: 'string', default: '30' },
    } });
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const { values: v, positionals } = args;
  const numbers = [v.interval, v.queued, v.running, v.timeout].map(Number);
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0]) || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
    console.error(USAGE);
    process.exit(2);
  }
  const pr = Number(positionals[0]);
  const [interval, queued, running, watch] = numbers;
  const limits = { queued: queued * MINUTE, running: running * MINUTE, watch: watch * MINUTE };
  const opts = { requireVerdict: Boolean(v['require-verdict']) };
  const started = Date.now();
  let last = '';
  console.log(`Watching ${REPO}#${pr} every ${interval} s${v.merge ? ', and merging it when ready' : ''}.`);
  for (;;) {
    let s;
    try {
      s = takeSnapshot(pr, started);
    } catch (e) {
      if (Date.now() - started > limits.watch) throw e;
      console.log(`${e.message}. Trying again.`);
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }
    const j = judge(s, limits, opts);
    const line = `${s.headSha.slice(0, 7)} ${j.kind}: ${j.reasons.map((r) => r.text).join('; ')}`;
    if (line !== last) console.log(`[${new Date(s.now).toLocaleTimeString()}] ${line}`);
    last = line;
    if (j.kind === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }
    if (j.kind === 'failed') {
      const attempt = s.runs.filter((r) => r.failures?.length).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
      for (const f of attempt?.failures ?? []) {
        console.log(`${f.job} failed at "${f.step}": ${f.firstError}`);
        say(f.tail);
      }
      if (!attempt) console.log(`No failure log yet. Read it with: gh run view --repo ${REPO} --log-failed`);
      console.log('Not merging after a failure. Fix it and push, and the watch can start again.');
    }
    if (j.kind === 'stuck' || j.kind === 'looping') {
      const onlyVerdict = j.reasons.every((r) => r.code === 'verdict-missing');
      if (!onlyVerdict) console.log('Collecting what the Mac says about the runners...');
      report(s, j, onlyVerdict ? NO_FACTS : collectFacts(s));
      console.log('Not merging. The runners are left as they are; run any stop or start yourself.');
    }
    if (j.kind === 'merged') console.log('Nothing to do.');
    if (j.kind === 'blocked') console.log('Not merging.');
    if (j.kind === 'ready' && !v.merge) console.log(`Ready to merge. Merge with: gh pr merge ${pr} --repo ${REPO} --merge --match-head-commit ${s.headSha}`);
    if (j.kind === 'ready' && v.merge) {
      const m = gh(['pr', 'merge', String(pr), '--repo', REPO, '--merge', '--match-head-commit', s.headSha]);
      if (!m.code) {
        console.log(`Merged ${REPO}#${pr} at ${s.headSha} with a merge commit.`);
        process.exit(0);
      }
      const now = takeSnapshot(pr, started);
      if (now.headSha !== s.headSha) {
        console.log(`The head moved to ${now.headSha.slice(0, 7)} before the merge, so GitHub refused it. Watching the new head.`);
        last = '';
        continue;
      }
      console.log(`The merge failed: ${m.err.trim()}`);
      process.exit(1);
    }
    process.exit(EXIT[j.kind]);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
