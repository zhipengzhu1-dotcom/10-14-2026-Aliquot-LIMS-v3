// Intake review: a received Sample waits here for a person with `samples.review` to decide on it before its Tests
// can be assigned. The rules (`SAMPLE_RULES.accept`) live in ../workflow.js; each decision is kept in intake_decisions.

import { get, tx } from '../db.js';
import { insert, update, mustGet } from '../repo.js';
import { assertCan } from '../auth.js';
import { testFeasibility } from '../intake-feasibility.js';
import { HttpError, bad, guard, flags, locks, queued } from '../http.js';
import { INTAKE_PENDING, INTAKE_HOLD, INTAKE_ACCEPTED, DECISION_ACCEPTED, DECISION_HELD, DECISION_RELEASED, DECISION_REJECTED } from '../lookups.js';
import { idList, nowIso, today } from '../util.js';
import { SAMPLE_QUEUES, SAMPLE_RULES, SAMPLE_SELECT, cancelSampleAndTests } from '../workflow.js';
import { reviewValues, submissionsOf } from '../intake-values.js';
import { longDate, postMessage, SUBMISSION_QUEUES, SUBMISSION_RULES } from './portal.js';

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
  const submission = submissionsOf([sample.id]).get(sample.id);
  const thread = submission && get('SELECT id FROM portal_threads WHERE submission_id = ?', submission.id);
  if (thread) postMessage(thread.id, { user: ctx.user, body });
}

export function acceptSample(ctx, sampleId) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.accept(s, ctx.user));
  decide(ctx, s, DECISION_ACCEPTED, {
    intake: INTAKE_ACCEPTED,
    summary: 'Sample accepted at intake review',
    also: () => tellClient(ctx, s, `${s.code} has been accepted and will be tested. Expected completion ${longDate(s.due_date)}.`),
  });
  return { ok: true };
}

/** Puts a Pending review Sample on hold and asks the client `reason` in its Submission's thread, if it has one. */
export function holdSample(ctx, sampleId, rawReason) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.hold(s, ctx.user));
  const reason = String(rawReason ?? '').trim();
  if (!reason) throw bad('Give a reason for holding this sample — it is sent to the client as a question', 'REASON_REQUIRED');
  tx(() => {
    decide(ctx, s, DECISION_HELD, { intake: INTAKE_HOLD, summary: 'Sample put on hold at intake review', reason });
    tellClient(ctx, s, `Question about ${s.code}, which is on hold until we hear from you: ${reason}`);
  });
  return { ok: true };
}

export function releaseSample(ctx, sampleId) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.release(s, ctx.user));
  decide(ctx, s, DECISION_RELEASED, { intake: INTAKE_PENDING, summary: 'Sample released from hold at intake review' });
  return { ok: true };
}

/** Turns a Sample away: cancels it and its open Tests under the stricter `reject` rule, keeps the decision and tells the client why. */
export function rejectSample(ctx, sampleId, body) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.reject(s, ctx.user));
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('A reason is required to reject a sample', 'REASON_REQUIRED');
  decide(ctx, s, DECISION_REJECTED, {
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

// Receiving & Review

// The rules whose refusal message the screen shows beside a disabled action.
const SCREEN_ACTIONS = ['accept', 'hold', 'release', 'reject', 'assign'];
const SUBMISSION_SCREEN_ACTIONS = ['acknowledge', 'decline', 'receive'];

const TABS = {
  pending: { queue: SAMPLE_QUEUES.intake, intake: INTAKE_PENDING },
  hold: { queue: SAMPLE_QUEUES.intake, intake: INTAKE_HOLD },
  ready: { queue: SAMPLE_QUEUES.ready, intake: INTAKE_ACCEPTED },
};

const summary = ({ id, code, status, received_at }) => ({ id, code, status, received_at });

// The Incoming tab lists Submissions, not Samples, so only the client filter and the search apply to it.
function matchesSubmission(su, q) {
  if (q.client_id && su.client_id !== +q.client_id) return false;
  const term = String(q.q ?? '').trim().toLowerCase();
  return !term || [su.code, su.client_name, su.submitted_by, su.courier, su.tracking_no].some((v) => String(v ?? '').toLowerCase().includes(term));
}

function matches(s, q) {
  if (q.client_id && s.client_id !== +q.client_id) return false;
  if (q.project_id && s.project_id !== +q.project_id) return false;
  if (q.priority && s.priority !== q.priority) return false;
  if (q.overdue && !(s.due_date < today())) return false;
  const term = String(q.q ?? '').trim().toLowerCase();
  return !term || [s.code, s.description, s.batch_no, s.client_ref, s.client_name].some((v) => String(v ?? '').toLowerCase().includes(term));
}

export default function routes(r) {
  // The tab counts follow the filters. A person without `samples.review` is offered no Samples, so gets no groups.
  // `incoming` is the one tab of Submissions, read through their own Queue: `submissions` carries them, `groups` is empty.
  r.get('/api/intake', (ctx) => {
    const tab = ctx.query.tab || 'pending';
    if (tab !== 'incoming' && !Object.hasOwn(TABS, tab)) throw bad(`Tab must be one of: incoming, ${Object.keys(TABS).join(', ')}`);
    const rows = {};
    for (const [name, t] of Object.entries(TABS)) rows[name] = queued(SAMPLE_RULES, t.queue, ctx.user).filter((s) => s.intake === t.intake && matches(s, ctx.query));
    const incoming = queued(SUBMISSION_RULES, SUBMISSION_QUEUES.incoming, ctx.user).filter((su) => matchesSubmission(su, ctx.query));
    const shown = rows[tab] ?? [];
    const submissions = submissionsOf(shown.map((s) => s.id));
    const groups = new Map();
    for (const s of shown) {
      const submission = submissions.get(s.id) ? summary(submissions.get(s.id)) : null;
      const key = submission ? `s${submission.id}` : 'direct';
      if (!groups.has(key)) groups.set(key, { submission, samples: [] });
      groups.get(key).samples.push({ ...s, can: flags(SAMPLE_RULES, s, ctx.user), locks: locks(SAMPLE_RULES, s, ctx.user, ...SCREEN_ACTIONS) });
    }
    return {
      tab,
      counts: { incoming: incoming.length, ...Object.fromEntries(Object.keys(TABS).map((name) => [name, rows[name].length])) },
      groups: [...groups.values()],
      submissions: tab === 'incoming' ? incoming.map((su) => ({ ...su, can: flags(SUBMISSION_RULES, su, ctx.user), locks: locks(SUBMISSION_RULES, su, ctx.user, ...SUBMISSION_SCREEN_ACTIONS) })) : [],
    };
  });

  // One key per section of the review pane, each computed in its own module.
  r.get('/api/intake/samples/:id/review', (ctx) => {
    assertCan(ctx, 'samples.review');
    const s = mustGet(`${SAMPLE_SELECT} WHERE s.id = ?`, +ctx.params.id, 'Sample');
    return { ...reviewValues(s, ctx.user), tests: testFeasibility(s) };
  });

  r.post('/api/samples/accept', (ctx) => acceptSamples(ctx, idList(ctx.body.sample_ids)));
  r.post('/api/samples/:id/accept', (ctx) => acceptSample(ctx, +ctx.params.id));
  r.post('/api/samples/:id/hold', (ctx) => holdSample(ctx, +ctx.params.id, ctx.body.reason));
  r.post('/api/samples/:id/release', (ctx) => releaseSample(ctx, +ctx.params.id));
  r.post('/api/samples/:id/reject', (ctx) => rejectSample(ctx, +ctx.params.id, ctx.body));
}
