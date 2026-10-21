// Intake review: a received Sample waits here for a person with `samples.review` to decide on it before its Tests
// can be assigned. The rules (`SAMPLE_RULES.accept`) live in ../workflow.js; each decision is kept in intake_decisions.

import { all, get, ph, tx } from '../db.js';
import { insert, update, mustGet } from '../repo.js';
import { assertCan } from '../auth.js';
import { testFeasibility } from '../intake-feasibility.js';
import { HttpError, bad, guard, flags, locks, queued } from '../http.js';
import { assertCan } from '../auth.js';
import { INTAKE_PENDING, INTAKE_HOLD, INTAKE_ACCEPTED } from '../lookups.js';
import { idList, nowIso, today } from '../util.js';
import { SAMPLE_QUEUES, SAMPLE_RULES, cancelSampleAndTests } from '../workflow.js';
import { reviewValues } from '../intake-values.js';
import { postMessage } from './portal.js';

/**
 * Records who decided what on Sample `s`, when and why, in one transaction with moving it to intake state `intake`.
 * A decision that settles the Sample some other way (reject cancels it) passes no `intake`.
 */
function decide(ctx, s, decision, { intake, summary, reason = null, also }) {
  tx(() => {
    if (intake) update(ctx, 'samples', s.id, { intake }, { action: 'STATUS', summary, reason });
    also?.();
    insert(ctx, 'intake_decisions', { sample_id: s.id, decision, reason, decided_by: ctx.user.id, decided_at: nowIso() }, { code: s.code, summary });
  });
}

/**
 * Tells the client about Sample `sample` in its Submission's portal thread, as a message from the lab person `ctx.user`.
 * Posts nothing for a Sample that did not come in with a Submission. The intake permission is the gate, not `portal.respond`.
 */
export function tellClient(ctx, sample, body) {
  const thread = get(`SELECT t.id FROM portal_threads t JOIN portal_submissions su ON su.id = t.submission_id, json_each(su.sample_ids) j
    WHERE su.sample_ids IS NOT NULL AND j.value = ?`, sample.id);
  if (thread) postMessage(thread.id, { user: ctx.user, body });
}

export function acceptSample(ctx, sampleId) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.accept(s, ctx.user));
  decide(ctx, s, 'Accepted', { intake: INTAKE_ACCEPTED, summary: 'Sample accepted at intake review' });
  return { ok: true };
}

/** Turns a Sample away: cancels it and its open Tests under the stricter `reject` rule, keeps the decision and tells the client why. */
export function rejectSample(ctx, sampleId, body) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.reject(s, ctx.user));
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('A reason is required to reject a sample', 'REASON_REQUIRED');
  decide(ctx, s, 'Rejected', {
    summary: 'Sample rejected at intake review',
    reason,
    also: () => {
      cancelSampleAndTests(ctx, s, reason);
      tellClient(ctx, s, `${s.code} has been rejected and will not be tested. Reason: ${reason}`);
    },
  });
  return { ok: true };
}

/** Accepts each Sample of `ids` on its own, so a refusal on one blocks none of the others, and reports every outcome. */
export function acceptSamples(ctx, ids) {
  if (!ids.length) throw bad('Select at least one sample');
  const results = ids.map((id) => {
    const code = get('SELECT code FROM samples WHERE id = ?', id)?.code ?? null;
    try {
      acceptSample(ctx, id);
      return { id, code, ok: true };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { id, code, ok: false, status: e.status, error_code: e.code ?? null, error: e.message };
    }
  });
  const accepted = results.filter((x) => x.ok).length;
  return { results, accepted, refused: results.length - accepted };
}

// ---------------------------------------------------------------------------------------------
// Receiving & Review
// ---------------------------------------------------------------------------------------------

// The rules the screen offers on a Sample, each with its refusal message for the screen to show beside a disabled action.
// A later ticket adds its rule's name here and its button to ACTIONS in public/js/views/intake.js.
const SCREEN_ACTIONS = ['accept', 'reject'];

// Each tab is a stage of intake: the Queue it reads and the intake state its Samples are at.
const TABS = {
  pending: { queue: SAMPLE_QUEUES.intake, intake: INTAKE_PENDING },
  hold: { queue: SAMPLE_QUEUES.intake, intake: INTAKE_HOLD },
  ready: { queue: SAMPLE_QUEUES.ready, intake: INTAKE_ACCEPTED },
};

/** The Submission each of Samples `ids` arrived in, as { id, code, status, received_at } by Sample id. */
function submissionsOf(ids) {
  if (!ids.length) return new Map();
  const rows = all(`SELECT j.value AS sample_id, su.id, su.code, su.status, su.received_at
    FROM portal_submissions su, json_each(su.sample_ids) j WHERE su.sample_ids IS NOT NULL AND j.value IN (${ph(ids)})`, ...ids);
  return new Map(rows.map(({ sample_id, ...submission }) => [sample_id, submission]));
}

/** Whether Sample `s` passes the screen's filters `q` (client, Project, priority, overdue, search). */
function matches(s, q) {
  if (q.client_id && s.client_id !== +q.client_id) return false;
  if (q.project_id && s.project_id !== +q.project_id) return false;
  if (q.priority && s.priority !== q.priority) return false;
  if (q.overdue && !(s.due_date < today())) return false;
  const term = String(q.q ?? '').trim().toLowerCase();
  return !term || [s.code, s.description, s.batch_no, s.client_ref, s.client_name].some((v) => String(v ?? '').toLowerCase().includes(term));
}

export default function routes(r) {
  // The Receiving & Review Queue for `?tab=pending|hold|ready`, grouped by Submission in the Queue's order. The tab
  // counts follow the filters. A Queue lists only what the signed-in person is offered, so a person without
  // `samples.review` gets no groups; `can` and `locks` are the rules' answer for each Sample, for the screen to show.
  r.get('/api/intake', (ctx) => {
    const tab = ctx.query.tab || 'pending';
    if (!Object.hasOwn(TABS, tab)) throw bad(`Tab must be one of: ${Object.keys(TABS).join(', ')}`);
    const rows = {};
    for (const [name, t] of Object.entries(TABS)) rows[name] = queued(SAMPLE_RULES, t.queue, ctx.user).filter((s) => s.intake === t.intake && matches(s, ctx.query));
    const submissions = submissionsOf(rows[tab].map((s) => s.id));
    const groups = new Map();
    for (const s of rows[tab]) {
      const submission = submissions.get(s.id) ?? null;
      const key = submission ? `s${submission.id}` : 'direct';
      if (!groups.has(key)) groups.set(key, { submission, samples: [] });
      groups.get(key).samples.push({ ...s, can: flags(SAMPLE_RULES, s, ctx.user), locks: locks(SAMPLE_RULES, s, ctx.user, ...SCREEN_ACTIONS) });
    }
    return { tab, counts: Object.fromEntries(Object.keys(TABS).map((name) => [name, rows[name].length])), groups: [...groups.values()] };
  });

  // What the review pane shows for one Sample, one key per section, each computed in its own module: `tests` (the
  // feasibility indicators of each open Test) and the values keys of `reviewValues`.
  r.get('/api/intake/samples/:id/review', (ctx) => {
    assertCan(ctx, 'samples.review');
    const s = mustGet('SELECT * FROM samples WHERE id = ?', +ctx.params.id, 'Sample');
    return { ...reviewValues(s, ctx.user), tests: testFeasibility(s) };
  });

  r.post('/api/samples/accept', (ctx) => acceptSamples(ctx, idList(ctx.body.sample_ids)));
  r.post('/api/samples/:id/accept', (ctx) => acceptSample(ctx, +ctx.params.id));
  r.post('/api/samples/:id/reject', (ctx) => rejectSample(ctx, +ctx.params.id, ctx.body));
}
