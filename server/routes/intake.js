// Intake review: a received Sample waits here for a person with `samples.review` to decide on it before its Tests
// can be assigned. The rules (`SAMPLE_RULES.accept`) live in ../workflow.js; each decision is kept in intake_decisions.

import { get, tx } from '../db.js';
import { insert, update, mustGet } from '../repo.js';
import { assertCan } from '../auth.js';
import { testFeasibility } from '../intake-feasibility.js';
import { HttpError, bad, guard, flags, locks, queued } from '../http.js';
import { INTAKE_PENDING, INTAKE_HOLD, INTAKE_ACCEPTED, DECISION_ACCEPTED, DECISION_HELD, DECISION_RELEASED, DECISION_REJECTED } from '../lookups.js';
import { idList, longDate, nowIso, today } from '../util.js';
import { SAMPLE_QUEUES, SAMPLE_RULES, SAMPLE_SELECT, cancelSampleAndTests } from '../workflow.js';
import { reviewValues, submissionsOf } from '../intake-values.js';
import { postMessage } from '../portal-threads.js';
import { SUBMISSION_QUEUES, SUBMISSION_RULES } from '../submissions.js';

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

// How each kind of record a tab lists is acted on and searched, and the key of the answer that carries it: Samples are
// grouped by the Submission they came in, Submissions are listed as they are.
const KINDS = {
  sample: { rules: SAMPLE_RULES, key: 'groups', terms: (s) => [s.code, s.description, s.batch_no, s.client_ref, s.client_name], present: (rows) => bySubmission(rows) },
  submission: { rules: SUBMISSION_RULES, key: 'submissions', terms: (su) => [su.code, su.client_name, su.submitted_by, su.courier, su.tracking_no], present: (rows) => rows },
};

// The filters a tab may apply, by the name its row lists them under. `param` is the query parameter that carries the value.
const FILTERS = {
  client: { param: 'client_id', test: (r, v) => r.client_id === +v },
  project: { param: 'project_id', test: (r, v) => r.project_id === +v },
  priority: { param: 'priority', test: (r, v) => r.priority === v },
  overdue: { param: 'overdue', test: (r) => r.due_date < today() },
};

const SAMPLE_FILTERS = ['client', 'project', 'priority', 'overdue'];

// One row per tab, the whole of its definition, sent with the data so the screen draws whichever tab it is given.
// `queue` is read through its rule, then narrowed by `part` (Pending review and On hold split one Queue). `actions` are
// the rules whose buttons each record shows, in order. `filters` and the search are the only ones the tab applies, so
// the screen shows exactly those. `default` is the tab shown when none is asked for.
const TABS = [
  {
    key: 'incoming', label: 'Incoming', kind: 'submission', queue: SUBMISSION_QUEUES.incoming,
    actions: ['acknowledge', 'decline', 'receive'], filters: ['client'], search: 'Search submissions…',
    empty: { icon: 'package', title: 'No submissions on their way', filtered: 'No submissions match', text: 'Clients announce shipments from the portal. Acknowledge them here, and receive them when the parcel arrives.' },
  },
  {
    key: 'pending', label: INTAKE_PENDING, default: true, kind: 'sample', queue: SAMPLE_QUEUES.intake, part: (s) => s.intake === INTAKE_PENDING,
    actions: ['accept', 'hold', 'reject'], filters: SAMPLE_FILTERS, search: 'Search samples…',
    empty: { icon: 'inbox', title: 'Nothing waiting for review', filtered: 'No samples match', text: 'Newly received samples wait here for a manager or scientist to decide on them.' },
  },
  {
    key: 'hold', label: INTAKE_HOLD, kind: 'sample', queue: SAMPLE_QUEUES.intake, part: (s) => s.intake === INTAKE_HOLD,
    actions: ['accept', 'release', 'reject'], filters: SAMPLE_FILTERS, search: 'Search samples…',
    empty: { icon: 'inbox', title: 'No samples on hold', filtered: 'No samples match', text: 'A sample put on hold waits here until the client has answered.' },
  },
  {
    key: 'ready', label: 'Ready to assign', kind: 'sample', queue: SAMPLE_QUEUES.ready,
    actions: ['assign'], filters: SAMPLE_FILTERS, search: 'Search samples…',
    empty: { icon: 'inbox', title: 'Nothing ready to assign', filtered: 'No samples match', text: 'Accepted samples with tests still to assign wait here.' },
  },
];

const summary = ({ id, code, status, received_at }) => ({ id, code, status, received_at });

/** `samples` grouped by the Submission each came in, in their order; the ones received directly form one group. */
function bySubmission(samples) {
  const submissions = submissionsOf(samples.map((s) => s.id));
  const groups = new Map();
  for (const s of samples) {
    const submission = submissions.get(s.id) ? summary(submissions.get(s.id)) : null;
    const key = submission ? `s${submission.id}` : 'direct';
    if (!groups.has(key)) groups.set(key, { submission, samples: [] });
    groups.get(key).samples.push(s);
  }
  return [...groups.values()];
}

/** Whether `record` passes the filters and search in `query` that `tab` applies; every other filter is ignored. */
function matches(tab, record, query) {
  if (tab.filters.some((name) => query[FILTERS[name].param] && !FILTERS[name].test(record, query[FILTERS[name].param]))) return false;
  const term = String(query.q ?? '').trim().toLowerCase();
  return !term || KINDS[tab.kind].terms(record).some((v) => String(v ?? '').toLowerCase().includes(term));
}

/**
 * The `locks` of the actions `tab` shows on `record`: each one's refusal, null when allowed. An action refused because
 * `person` lacks its permission is left out, so the screen hides it instead of showing it disabled on every row.
 */
function shownLocks(tab, record, person) {
  const { rules } = KINDS[tab.kind];
  return locks(rules, record, person, ...tab.actions.filter((name) => rules[name](record, person)?.code !== 'FORBIDDEN'));
}

const definition = ({ key, label, kind, actions, filters, search, empty, default: isDefault = false }) => ({ key, label, kind, actions, filters, search, empty, default: isDefault });

export default function routes(r) {
  // `tabs` defines every tab; only the one shown carries its records, each with `can` and the `locks` of the actions it
  // shows. Each count follows that tab's own filters. A person offered nothing in a tab's Queue gets none of its records.
  r.get('/api/intake', (ctx) => {
    const tab = ctx.query.tab ? TABS.find((t) => t.key === ctx.query.tab) : TABS.find((t) => t.default);
    if (!tab) throw bad(`Tab must be one of: ${TABS.map((t) => t.key).join(', ')}`);
    const queues = new Map();
    const listed = (t) => {
      if (!queues.has(t.queue)) queues.set(t.queue, queued(KINDS[t.kind].rules, t.queue, ctx.user));
      return queues.get(t.queue).filter((x) => (!t.part || t.part(x)) && matches(t, x, ctx.query));
    };
    const kind = KINDS[tab.kind];
    const shown = listed(tab).map((x) => ({ ...x, can: flags(kind.rules, x, ctx.user), locks: shownLocks(tab, x, ctx.user) }));
    return {
      tab: tab.key,
      tabs: TABS.map(definition),
      counts: Object.fromEntries(TABS.map((t) => [t.key, t === tab ? shown.length : listed(t).length])),
      groups: [],
      submissions: [],
      [kind.key]: kind.present(shown),
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
