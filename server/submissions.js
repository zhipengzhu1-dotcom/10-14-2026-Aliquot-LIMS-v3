// Client Submissions: a client contact announces a shipment from the portal, the lab acknowledges, declines or receives
// it, or the client withdraws it first. Every status change is one move in SUBMISSION_MOVES, applied by moveSubmission;
// the rules, the Incoming Queue and the counts of open Submissions are derived from it here. The portal routes, intake
// review and the demo seed all ask this module.

import { all, get, ph, tx } from './db.js';
import { insert, update, nextCode, mustGet } from './repo.js';
import { bad, forbidden, notFound, guard } from './http.js';
import { can } from './auth.js';
import { PRIORITIES, PRIORITY_TIERS } from './lookups.js';
import { clean, idList, longDate, nowIso } from './util.js';
import { checkSubmission, submissionContext } from './submission-gate.js';
import { createThread, postMessage, notice, threadOf } from './portal-threads.js';
import { receiveSamples } from './routes/lab.js';

export const SUBMISSION_STATUSES = ['Submitted', 'Acknowledged', 'Received', 'Declined', 'Withdrawn'];
// Open: announced, and its parcel not yet received, declined or withdrawn.
export const SUBMISSION_OPEN = ['Submitted', 'Acknowledged'];

const json = (v, fallback) => { try { return JSON.parse(v) ?? fallback; } catch { return fallback; } };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The arrival notice's completion line: one date, or each tier's date and samples when a shipment mixes them. */
function dueSummary(samples) {
  const dates = new Set(samples.map((s) => s.due_date));
  if (dates.size === 1) return `Expected completion ${longDate(samples[0].due_date)}.`;
  const tiers = Object.keys(PRIORITY_TIERS).map((tier) => [tier, samples.filter((s) => s.priority === tier)]).filter(([, list]) => list.length);
  return `Expected completion: ${tiers.map(([tier, list]) => `${tier} ${longDate(list[0].due_date)} (${list.map((s) => s.code).join(', ')})`).join('; ')}.`;
}

/** Physical receipt: creates real samples (codes, custody, tests) through the normal receiving workflow. */
function receiveParcel(ctx, sub, input) {
  clean(input, { priority: { type: 'enum', values: PRIORITIES } }, { partial: true });
  const res = receiveSamples(ctx, {
    client_id: sub.client_id,
    project_id: input.project_id === undefined ? sub.project_id : input.project_id,
    sample_type: input.sample_type ?? sub.sample_type,
    storage: input.storage ?? sub.storage,
    location: input.location,
    condition: input.condition,
    priority: input.priority ?? sub.priority,
    received_at: input.received_at || nowIso(),
    due_date: input.due_date,
    notes: [input.notes, `Client submission ${sub.code}`].filter(Boolean).join('\n'),
    samples: json(sub.samples, []),
    method_ids: input.method_ids !== undefined ? idList(input.method_ids) : json(sub.method_ids, []),
  }, { legacyTiers: true });
  return {
    fields: { received_by: ctx.user.id, received_at: nowIso(), sample_ids: JSON.stringify(res.samples.map((s) => s.id)) },
    summary: `Samples received: ${res.samples.map((s) => s.code).join(', ')}`,
    condition: input.condition,
    result: res,
  };
}

// Every status change of a Submission, one move each: the statuses it moves `from`, the status it moves `to`, who may
// make it (a staff `permission`, or the `client`'s own contact), the refusal when it is in another status (by default
// "This submission is <status>") and the `notice` posted into its thread. `apply` runs the move's own work and returns
// its columns (`fields`), its audit `summary` and `reason`, a `note` in the person's own words, posted after the notice,
// and the `result` to send back. Submit makes the record rather than moving it: the gate in submission-gate.js is its rule.
export const SUBMISSION_MOVES = {
  submit: {
    from: [], to: 'Submitted',
    notice: (ctx, { code, samples, tests }) => `Submission ${code} received: ${plural(samples, 'sample')}${tests ? `, ${plural(tests, 'test')} requested` : ''}. We'll confirm as soon as it has been reviewed.`,
  },
  acknowledge: {
    from: ['Submitted'], to: 'Acknowledged', permission: 'portal.respond',
    refusal: (sub) => (sub.status === 'Acknowledged' ? 'Already acknowledged' : undefined),
    apply: (ctx, sub, input) => {
      const note = String(input.note || '').trim();
      return { fields: { status_note: note || null, acknowledged_by: ctx.user.id, acknowledged_at: nowIso() }, summary: 'Submission acknowledged', note };
    },
    notice: (ctx) => `Submission acknowledged by ${ctx.user.full_name} — we're expecting your shipment.`,
  },
  receive: {
    from: SUBMISSION_OPEN, to: 'Received', permission: 'samples.receive',
    apply: receiveParcel,
    notice: (ctx, { result, condition }) => `Your samples have arrived and are logged as ${result.samples.map((s) => s.code).join(', ')}.${condition && condition !== 'Acceptable' ? ` Condition on receipt: ${condition}.` : ''} ${dueSummary(result.samples)}`,
  },
  decline: {
    from: SUBMISSION_OPEN, to: 'Declined', permission: 'portal.respond',
    apply: (ctx, sub, input) => {
      const reason = String(input.reason || '').trim();
      if (!reason) throw bad('Give the client a reason', 'REASON_REQUIRED');
      return { fields: { status_note: reason }, summary: 'Submission declined', reason };
    },
    notice: (ctx, { reason }) => `Submission declined by ${ctx.user.full_name}: ${reason}`,
  },
  withdraw: {
    from: ['Submitted'], to: 'Withdrawn', client: true,
    refusal: (sub) => `This submission is ${sub.status.toLowerCase()} — contact the laboratory to change it`,
    apply: () => ({ summary: 'Withdrawn by the client' }),
    notice: (ctx) => `${ctx.user.full_name} withdrew this submission.`,
  },
};

const refuse = (move, sub) => bad(move.refusal?.(sub) ?? `This submission is ${sub.status.toLowerCase()}`);

const staffRule = (move) => (sub, me) => {
  if (!can(me, move.permission)) return forbidden();
  if (!move.from.includes(sub.status)) return refuse(move, sub);
};

// The client's own moves take the signed-in portal user, never a staff user. Another client's submission is refused as
// not found, so a contact cannot learn that it exists.
const clientRule = (move) => (sub, pu) => {
  if (sub.client_id !== pu.client_id) return notFound('Submission');
  if (!move.from.includes(sub.status)) return refuse(move, sub);
};

const rulesOf = (pick, rule) => Object.fromEntries(Object.entries(SUBMISSION_MOVES).filter(([, move]) => pick(move)).map(([action, move]) => [action, rule(move)]));

export const SUBMISSION_RULES = rulesOf((move) => move.permission, staffRule);
export const CLIENT_SUBMISSION_RULES = rulesOf((move) => move.client, clientRule);

export const SUBMISSION_LIST = `SELECT su.id, su.code, su.status, su.priority, su.sample_type, su.courier, su.tracking_no, su.ship_date, su.created_at, su.updated_at,
    json_array_length(su.samples) AS sample_count, json_array_length(su.method_ids) AS method_count,
    c.id AS client_id, c.name AS client_name, c.code AS client_code, pu.full_name AS submitted_by
  FROM portal_submissions su JOIN clients c ON c.id = su.client_id LEFT JOIN portal_users pu ON pu.id = su.portal_user_id`;

// `incoming`: the open Submissions a person is offered to receive, oldest first. Receiving & Review's Incoming tab.
export const SUBMISSION_QUEUES = {
  incoming: { rule: 'receive', stage: () => all(`${SUBMISSION_LIST} WHERE su.status IN (${ph(SUBMISSION_OPEN)}) ORDER BY su.id`, ...SUBMISSION_OPEN) },
};

// The open Submissions are counted three ways, each on purpose:
// - the `incoming` Queue (above), one person's work: what they may receive. Receiving & Review counts it on its Incoming tab.
// - `open`, the Queue's stage unfiltered: every open Submission, whoever may act on it. The Portal inbox lists and counts
//   this oversight view, so QA, who acknowledge and decline but do not receive, still see each one.
// - `new`, what nobody at the lab has moved yet. The Client portal badge counts what is new, which is not a Queue.
export const SUBMISSION_COUNTS = {
  open: () => SUBMISSION_QUEUES.incoming.stage().length,
  new: () => get('SELECT COUNT(*) n FROM portal_submissions WHERE status = ?', SUBMISSION_MOVES.submit.to).n,
};

export const getSubmission = (id) => mustGet('SELECT * FROM portal_submissions WHERE id = ?', id, 'Submission');

/** A client contact announces a shipment. ctx is a portal audit context (see portalCtx). */
export function submitSamples(ctx, pu, input) {
  const gate = checkSubmission(submissionContext(pu.client_id), input);
  if (!gate.ok) throw bad(gate.problems[0].message);
  const { samples: rows, method_ids: methodIds, ...b } = gate.submission;
  const move = SUBMISSION_MOVES.submit;
  return tx(() => {
    const code = nextCode('SUB');
    const t = nowIso();
    const id = insert(ctx, 'portal_submissions', {
      code, client_id: pu.client_id, portal_user_id: pu.id, ...b, samples: JSON.stringify(rows), method_ids: JSON.stringify(methodIds),
      status: move.to, created_at: t, updated_at: t,
    }, { summary: `Sample submission from ${pu.full_name} (${plural(rows.length, 'sample')})` });
    const thread = createThread({ client_id: pu.client_id, subject: `Sample submission ${code}`, submission_id: id });
    postMessage(thread, { body: move.notice(ctx, { code, samples: rows.length, tests: methodIds.length }), kind: 'event' });
    if (b.notes) postMessage(thread, { portalUser: pu, body: b.notes });
    return { id, code };
  });
}

/**
 * Moves Submission `id` by `action` for `person` (the staff user, or the portal user for a client's move): refuses through
 * the move's rule, then in one transaction runs its work, records the status change in the audit trail and posts its
 * notice. Returns the work's `result`, or `{ ok: true }`.
 */
export function moveSubmission(ctx, person, id, action, input = {}) {
  const move = SUBMISSION_MOVES[action];
  const sub = getSubmission(id);
  guard((move.client ? CLIENT_SUBMISSION_RULES : SUBMISSION_RULES)[action](sub, person));
  return tx(() => {
    const done = move.apply(ctx, sub, input);
    update(ctx, 'portal_submissions', sub.id, { status: move.to, ...done.fields, updated_at: nowIso() }, { action: 'STATUS', summary: done.summary, reason: done.reason });
    notice({ submission_id: sub.id }, move.notice(ctx, done));
    const thread = done.note && threadOf({ submission_id: sub.id });
    if (thread) postMessage(thread.id, { user: ctx.user, body: done.note });
    return done.result ?? { ok: true };
  });
}
