// Intake review, values and corrections: what the client submitted beside what a Sample holds now, its receipt
// condition, the client's notes and sheet details, the Submission's portal thread and the corrections the person may
// make during review. Reads only; the corrections themselves go through the Sample and Test actions.

import { all, get, ph } from './db.js';
import { flags, locks } from './http.js';
import { SAMPLE_RULES, TEST_RULES, TEST_SELECT } from './workflow.js';

// The Sample fields a client's row can state, in the order the review compares them..
const FIELDS = [
  ['description', 'Description'], ['batch_no', 'Batch / lot'], ['client_ref', 'Client reference'], ['product_code', 'Product code'], ['stage', 'Stage'],
  ['quantity', 'Quantity'], ['container', 'Container'], ['sample_type', 'Sample type'], ['priority', 'Turnaround'], ['storage', 'Storage'],
];
// The choices a Submission makes once for all its Samples; a row that states none of its own inherits them.
const SUBMISSION_WIDE = ['sample_type', 'priority', 'storage'];
/** Every Sample field a correction can touch, by name. */
export const FIELD_LABELS = { ...Object.fromEntries(FIELDS), due_date: 'Due date', notes: 'Notes', project_id: 'Project' };
const CURRENT = [...FIELDS.map(([key]) => key), 'due_date', 'notes', 'project_code'];

const text = (v) => (v == null ? '' : String(v).trim());
const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * The Submission each of Samples `ids` arrived in, by Sample id: its columns the review reads and that Sample's own
 * `row` as the client stated it. A Sample received at the front desk has no entry.
 */
export function submissionsOf(ids) {
  if (!ids.length) return new Map();
  const rows = all(`SELECT j.value AS sample_id, json_extract(su.samples, '$[' || j.key || ']') AS row,
      su.id, su.code, su.status, su.received_at, su.notes, su.courier, su.tracking_no, su.ship_date, su.sample_type, su.priority, su.storage
    FROM portal_submissions su, json_each(su.sample_ids) j WHERE su.sample_ids IS NOT NULL AND j.value IN (${ph(ids)})`, ...ids);
  return new Map(rows.map(({ sample_id, row, ...submission }) => [sample_id, { ...submission, row: json(row, {}) }]));
}

function messagesOf(threadId) {
  return all(`SELECT m.id, m.author_name, m.body, m.kind, m.created_at,
    CASE WHEN m.portal_user_id IS NOT NULL THEN 'client' WHEN m.user_id IS NOT NULL THEN 'lab' ELSE 'system' END AS side
    FROM portal_messages m WHERE m.thread_id = ? ORDER BY m.id`, threadId);
}

/**
 * The values half of the review of `sample` (a SAMPLE_SELECT row) for `me`: `submitted` (the Submission and the client's
 * row, null when received at the front desk), `current`, `fields` (each compared value and whether it changed),
 * `condition`, `details`, `thread` (null without a Submission) and `corrections` (what `me` may change now, each with
 * the rule's answer).
 */
export function reviewValues(sample, me) {
  const s = sample;
  const sub = submissionsOf([s.id]).get(s.id) ?? null;
  const row = sub ? sub.row : null;

  const fields = FIELDS.map(([key, label]) => {
    const submitted = row ? text(row[key] ?? (SUBMISSION_WIDE.includes(key) ? sub[key] : null)) : null;
    return { key, label, submitted, current: text(s[key]), changed: submitted !== null && submitted !== text(s[key]) };
  });

  const sheet = json(get('SELECT details FROM sample_details WHERE sample_id = ?', s.id)?.details, []);
  const received = get(`SELECT ce.note FROM custody_events ce WHERE ce.sample_id = ? AND ce.action = 'Received' ORDER BY ce.id LIMIT 1`, s.id);
  const thread = sub ? get('SELECT id, subject, status, created_at FROM portal_threads WHERE submission_id = ?', sub.id) : null;
  const tests = all(`${TEST_SELECT} WHERE t.sample_id = ? ORDER BY t.id`, s.id);

  return {
    sample: { id: s.id, code: s.code, intake: s.intake, status: s.status, client_name: s.client_name },
    submitted: sub && {
      submission: { id: sub.id, code: sub.code, status: sub.status, received_at: sub.received_at, notes: sub.notes, courier: sub.courier, tracking_no: sub.tracking_no, ship_date: sub.ship_date },
      row,
    },
    current: Object.fromEntries(CURRENT.map((key) => [key, s[key] ?? null])),
    fields,
    condition: { condition: s.condition, storage: s.storage, location: s.location, received_at: s.received_at, received_by_name: s.received_by_name, receipt_note: received?.note ?? null },
    details: { notes: s.notes, submission_notes: sub?.notes ?? null, sheet },
    thread: thread && { ...thread, messages: messagesOf(thread.id) },
    corrections: {
      can: flags(SAMPLE_RULES, s, me),
      locks: locks(SAMPLE_RULES, s, me, 'edit', 'addTests'),
      // Once testing has started the edit demands a reason; the screen asks for it up front.
      reason_required: s.status !== 'Received',
      tests: tests.map((t) => ({
        id: t.id, code: t.code, status: t.status, method_code: t.method_code, method_version: t.method_version, method_title: t.method_title,
        can: flags(TEST_RULES, t, me),
        locks: locks(TEST_RULES, t, me, 'cancel'),
      })),
    },
  };
}

/** The intake state of Sample `s` and every decision taken on it (who, when, why), newest first. */
export function intakeHistory(s) {
  return {
    state: s.intake,
    decisions: all(`SELECT d.id, d.decision, d.reason, d.decided_by, u.full_name AS decided_by_name, d.decided_at
      FROM intake_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE d.sample_id = ? ORDER BY d.id DESC`, s.id),
  };
}
