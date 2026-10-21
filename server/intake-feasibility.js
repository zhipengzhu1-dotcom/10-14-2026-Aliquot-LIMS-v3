// Intake review, feasibility: for each Test requested on a Sample, can the lab do it? Three indicators computed from
// data the lab already keeps (Methods, qualifications, the Sample's priority and due date); nothing is stored.

import { all, get, ph } from './db.js';
import { METHOD_USABLE, rolesWith } from './lookups.js';
import { addBusinessDays, today } from './util.js';
import { isQualified } from './workflow.js';

/**
 * Why Method `m` cannot be requested for testing, or undefined when it can. The one check behind requesting a Test and
 * the "Method usable" indicator: a Method is usable while it is In Development, In Validation or Effective and has result
 * parameters defined. Draft and Retired Methods are not.
 */
export function methodProblem(m) {
  if (!METHOD_USABLE.includes(m.status)) return `${m.code} v${m.version} is ${m.status.toLowerCase()} and cannot be used for testing`;
  if (!get('SELECT 1 FROM method_analytes WHERE method_id = ?', m.id)) return `${m.code} has no result parameters defined yet`;
}

const methodUsable = (m) => {
  const problem = methodProblem(m);
  if (problem) return { ok: false, reason: problem };
  const state = m.status === 'Effective' ? 'in effect' : `${m.status.toLowerCase()}, usable for testing but not yet in effect`;
  return { ok: true, reason: `${m.code} v${m.version} is ${state}` };
};

/** How many of `analysts` are currently qualified on Method `code`, with the names for the reason. */
function qualifiedOn(code, analysts) {
  const names = analysts.filter((u) => isQualified(u.id, code)).map((u) => u.full_name);
  const reason = names.length ? `${names.length} ${names.length === 1 ? 'analyst' : 'analysts'} currently qualified on ${code}: ${names.join(', ')}` : `Nobody is currently qualified on ${code}`;
  return { count: names.length, ok: names.length > 0, reason };
}

/** Whether Sample `s` can be finished by its due date if testing starts today, given Method `m`'s turnaround in working days. */
function dueDateMet(s, m) {
  const days = m.tat_days || 5;
  const earliest = addBusinessDays(today(), days);
  const ok = !s.due_date || s.due_date >= earliest;
  const need = `${m.code} takes ${days} working ${days === 1 ? 'day' : 'days'}, so the earliest finish is ${earliest}`;
  return { ok, reason: `Priority ${s.priority}, due ${s.due_date}:${need}, ${ok ? 'in time' : 'too late'}` };
}

/** The feasibility indicators of each open Test requested on Sample `s` (a Sample row): [{ id, name, method_code, method_version, indicators }]. */
export function testFeasibility(s) {
  const performers = rolesWith('tests.perform');
  const analysts = all(`SELECT id, full_name FROM users WHERE active = 1 AND role IN (${ph(performers)}) ORDER BY full_name`, ...performers);
  const tests = all(`SELECT t.id, m.id AS method_id, m.code, m.version, m.title, m.status, m.tat_days
    FROM tests t JOIN methods m ON m.id = t.method_id WHERE t.sample_id = ? AND t.status != 'Cancelled' ORDER BY t.id`, s.id);
  const qualified = new Map();
  return tests.map((t) => {
    if (!qualified.has(t.code)) qualified.set(t.code, qualifiedOn(t.code, analysts));
    return {
      id: t.id,
      name: t.title,
      method_code: t.code,
      method_version: t.version,
      indicators: { method_usable: methodUsable({ ...t, id: t.method_id }), qualified: qualified.get(t.code), due_date: dueDateMet(s, t) },
    };
  });
}
