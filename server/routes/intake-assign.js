// Intake review, assigning from the Receiving & Review screen: the Tests of accepted Samples go to an analyst, singly or in
// bulk, and every Test gets its own outcome. This applies the same rules as POST /api/tests/assign (TEST_RULES.assign and
// the qualification refusal) to each Test on its own, so a refusal on one Test blocks none of the others. That endpoint
// keeps aborting its whole batch on the first refusal for its other callers.

import { all, get, ph } from '../db.js';
import { update } from '../repo.js';
import { HttpError, bad, locks } from '../http.js';
import { can } from '../auth.js';
import { rolesWith } from '../lookups.js';
import { clean, idList } from '../util.js';
import { TEST_EDITABLE, TEST_RULES, TEST_SELECT, SAMPLE_RULES, assignBlocker, isQualified } from '../workflow.js';

/** The outcome line for a refusal `e` on Test `t` (or on Sample `sample` when it has no Test to name). */
function refusal(e, t, sample) {
  if (!(e instanceof HttpError)) throw e;
  return {
    test_id: t?.id ?? null, code: t?.code ?? null, sample_id: t?.sample_id ?? sample?.id ?? null, sample_code: t?.sample_code ?? sample?.code ?? null,
    method_code: t?.method_code ?? null, ok: false, status: e.status, error_code: e.code ?? null, error: e.message,
  };
}

/** The Tests still waiting for an analyst on Sample `sampleId`, whatever the Sample's intake state, so a refusal is reported per Test. */
const unassignedOf = (sampleId) => all(`${TEST_SELECT} WHERE t.sample_id = ? AND t.analyst_id IS NULL AND t.status IN (${ph(TEST_EDITABLE)}) ORDER BY t.id`, sampleId, ...TEST_EDITABLE);

/** The analyst a body names, or the refusal when there is none. */
function analystOf(body) {
  const analyst = body.analyst_id ? get('SELECT * FROM users WHERE id = ?', +body.analyst_id) : null;
  if (!analyst || !analyst.active || !can(analyst, 'tests.perform')) throw bad('Choose an active analyst');
  return analyst;
}

/** Assigns the Tests of `sample_ids` (every Test still unassigned) and the Tests of `test_ids` to one analyst, Test by Test. */
export function assignEach(ctx, body) {
  const sampleIds = idList(body.sample_ids);
  const testIds = idList(body.test_ids);
  if (!sampleIds.length && !testIds.length) throw bad('Select at least one sample or test');
  const analyst = analystOf(body);
  const due = body.due_date ? clean(body, { due_date: { type: 'date' } }).due_date : undefined;

  const wanted = new Map();
  const results = [];
  for (const id of sampleIds) {
    const sample = get('SELECT id, code FROM samples WHERE id = ?', id);
    if (!sample) {
      results.push({ test_id: null, code: null, sample_id: id, sample_code: null, method_code: null, ok: false, status: 404, error_code: 'NOT_FOUND', error: 'Sample not found' });
      continue;
    }
    const tests = unassignedOf(id);
    if (!tests.length) results.push(refusal(SAMPLE_RULES.assign(get('SELECT * FROM samples WHERE id = ?', id), ctx.user) ?? bad('Every test on this sample is already assigned'), null, sample));
    for (const t of tests) wanted.set(t.id, t);
  }
  for (const id of testIds) {
    const t = get(`${TEST_SELECT} WHERE t.id = ?`, id);
    if (t) wanted.set(id, t);
    else results.push({ test_id: id, code: null, sample_id: null, sample_code: null, method_code: null, ok: false, status: 404, error_code: 'NOT_FOUND', error: 'Test not found' });
  }

  for (const t of wanted.values()) {
    const refused = TEST_RULES.assign(t, ctx.user) ?? assignBlocker(t, analyst);
    if (refused) {
      results.push(refusal(refused, t));
      continue;
    }
    update(ctx, 'tests', t.id, { analyst_id: analyst.id, due_date: due }, { summary: `Assigned to ${analyst.full_name}` });
    results.push({ test_id: t.id, code: t.code, sample_id: t.sample_id, sample_code: t.sample_code, method_code: t.method_code, ok: true });
  }
  const assigned = results.filter((x) => x.ok).length;
  return { results, assigned, refused: results.length - assigned };
}

/** What the assign dialog shows: the Tests to be assigned and, for each analyst, whether they are qualified on each Method and how many tests they have open. */
export function assignOptions(ctx, sampleIds) {
  const tests = sampleIds.flatMap(unassignedOf).map((t) => ({
    id: t.id, code: t.code, sample_id: t.sample_id, sample_code: t.sample_code, method_code: t.method_code, method_title: t.method_title,
    why: locks(TEST_RULES, t, ctx.user, 'assign').assign,
  }));
  const methods = [...new Map(tests.map((t) => [t.method_code, { code: t.method_code, title: t.method_title }])).values()];
  const performers = rolesWith('tests.perform');
  const analysts = all(`SELECT u.id, u.full_name, u.initials, u.title, u.role,
      (SELECT COUNT(*) FROM tests t WHERE t.analyst_id = u.id AND t.status IN (${ph(TEST_EDITABLE)})) AS open
    FROM users u WHERE u.active = 1 AND u.role IN (${ph(performers)}) ORDER BY u.full_name`, ...TEST_EDITABLE, ...performers)
    .map((u) => ({ ...u, qualified: Object.fromEntries(methods.map((m) => [m.code, isQualified(u.id, m.code)])) }));
  return { tests, methods, analysts };
}

export default function routes(r) {
  r.post('/api/intake/assign', (ctx) => assignEach(ctx, ctx.body));
  r.get('/api/intake/assign-options', (ctx) => assignOptions(ctx, idList(ctx.query.sample_ids)), { perm: 'tests.assign' });
}
