// Intake review, accepted with changes: what was adjusted between a Sample's receipt and the decision to accept it,
// read from the audit trail. Nothing is stored for it; a Sample with no Accepted decision has no changes to report.

import { all, get, ph } from './db.js';
import { DECISION_ACCEPTED } from './lookups.js';
import { FIELD_LABELS } from './intake-values.js';

const parse = (json) => {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
};

const projectCode = (id) => (id == null ? null : get('SELECT code FROM projects WHERE id = ?', id)?.code ?? String(id));

/**
 * The Tests requested at receipt, which the audit trail writes straight after the Sample's own entry (and its sheet
 * details), in the same transaction, so nothing else lands between them.
 */
function requestedAtReceipt(sampleAuditId, testIds) {
  const next = all('SELECT id, entity, entity_id, action FROM audit_log WHERE id > ? ORDER BY id LIMIT ?', sampleAuditId, testIds.length + 1);
  const rows = next[0]?.entity === 'sample_details' ? next.slice(1) : next;
  const ids = new Set(testIds);
  const received = new Set();
  for (const row of rows) {
    if (row.entity !== 'tests' || row.action !== 'CREATE' || !ids.has(row.entity_id)) break;
    received.add(row.entity_id);
  }
  return received;
}

/**
 * Whether Sample `sampleId` was accepted with changes, and which: `accepted_with_changes`, who accepted it and when, and
 * the `edits` made to the Sample, the Tests `added_tests` and the Tests `cancelled_tests` between receipt and that
 * decision. Whatever happened after the Accept decision, or to the Sample's custody, is not a change to the request.
 */
export function acceptedWithChanges(sampleId) {
  const none = { accepted_with_changes: false, accepted_at: null, accepted_by_name: null, edits: [], added_tests: [], cancelled_tests: [] };
  const decision = get(`SELECT d.id, d.decided_at, u.full_name FROM intake_decisions d LEFT JOIN users u ON u.id = d.decided_by
    WHERE d.sample_id = ? AND d.decision = ? ORDER BY d.id DESC LIMIT 1`, sampleId, DECISION_ACCEPTED);
  if (!decision) return none;
  const accepted = { ...none, accepted_at: decision.decided_at, accepted_by_name: decision.full_name };
  const decidedAudit = get(`SELECT id FROM audit_log WHERE entity = 'intake_decisions' AND entity_id = ? AND action = 'CREATE'`, decision.id);
  const received = get(`SELECT id FROM audit_log WHERE entity = 'samples' AND entity_id = ? AND action = 'CREATE'`, sampleId);
  if (!decidedAudit || !received) return accepted;

  const between = [received.id, decidedAudit.id];
  const edits = all(`SELECT a.changes, a.reason, a.at, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity = 'samples' AND a.entity_id = ? AND a.action = 'UPDATE' AND a.id > ? AND a.id < ? ORDER BY a.id`, sampleId, ...between)
    .flatMap((a) => Object.entries(parse(a.changes)).map(([field, [from, to]]) => {
      const project = field === 'project_id';
      return { field, label: FIELD_LABELS[field] ?? field, from: project ? projectCode(from) : from, to: project ? projectCode(to) : to, by: a.full_name, at: a.at, reason: a.reason };
    }));

  const tests = all('SELECT t.id, t.code, m.code AS method_code, m.title AS method_title FROM tests t JOIN methods m ON m.id = t.method_id WHERE t.sample_id = ? ORDER BY t.id', sampleId);
  const byId = new Map(tests.map((t) => [t.id, t]));
  const testIds = tests.map((t) => t.id);
  const ofTests = testIds.length ? `a.entity = 'tests' AND a.entity_id IN (${ph(testIds)})` : '0';
  const atReceipt = requestedAtReceipt(received.id, all(`SELECT a.entity_id FROM audit_log a WHERE ${ofTests} AND a.action = 'CREATE'`, ...testIds).map((a) => a.entity_id));
  const added = all(`SELECT a.entity_id, a.at, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${ofTests} AND a.action = 'CREATE' AND a.id > ? AND a.id < ? ORDER BY a.id`, ...testIds, ...between)
    .filter((a) => !atReceipt.has(a.entity_id))
    .map((a) => ({ ...byId.get(a.entity_id), by: a.full_name, at: a.at }));
  const cancelled = all(`SELECT a.entity_id, a.changes, a.reason, a.at, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${ofTests} AND a.action = 'STATUS' AND a.id > ? AND a.id < ? ORDER BY a.id`, ...testIds, ...between)
    .filter((a) => parse(a.changes).status?.[1] === 'Cancelled')
    .map((a) => ({ ...byId.get(a.entity_id), reason: a.reason, by: a.full_name, at: a.at }));

  return { ...accepted, accepted_with_changes: !!(edits.length || added.length || cancelled.length), edits, added_tests: added, cancelled_tests: cancelled };
}
