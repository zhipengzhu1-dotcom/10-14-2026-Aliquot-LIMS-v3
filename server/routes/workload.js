// Workload: each analyst's open tests and the projects they are on, for the people who assign work.

import { all, get, ph } from '../db.js';
import { can } from '../auth.js';
import { forbidden } from '../http.js';
import { INTAKE_ACCEPTED, PROJECT_OPEN, rolesWith } from '../lookups.js';
import { today, addDays } from '../util.js';
import { TEST_RETURNED } from '../workflow.js';
import { TEST_WORK } from '../test-work.js';

const [RETURNED_SQL, ...RETURNED_PARAMS] = TEST_RETURNED;

export default function routes(r) {
  r.get('/api/workload', (ctx) => {
    if (!can(ctx.user, 'tests.assign') && !can(ctx.user, 'work.oversee')) throw forbidden();
    const t = today();
    const week = addDays(t, 7);
    const performers = rolesWith('tests.perform');
    const open = TEST_WORK.open();
    const overdue = TEST_WORK.overdue(open);
    const { review, approval } = TEST_WORK.inReview();
    const returned = new Set(all(`SELECT t.id FROM tests t WHERE ${RETURNED_SQL}`, ...RETURNED_PARAMS).map((x) => x.id));

    // Each analyst's load, split by status and due date for the load bar.
    const analysts = all(`SELECT id, full_name, initials, title, role FROM users WHERE active = 1 AND role IN (${ph(performers)})`, ...performers).map((u) => {
      const load = TEST_WORK.load(u.id, open);
      return {
        ...u,
        pending: load.filter((x) => x.status === 'Pending').length,
        in_progress: load.filter((x) => x.status === 'In Progress').length,
        open: load.length,
        overdue: TEST_WORK.load(u.id, overdue).length,
        due_week: load.filter((x) => x.due_date >= t && x.due_date <= week).length,
        returned: load.filter((x) => returned.has(x.id)).length,
        awaiting_review: [...review, ...approval].filter((x) => x.analyst_id === u.id).length,
      };
    }).sort((a, b) => b.open - a.open || a.full_name.localeCompare(b.full_name));

    const byId = new Map(analysts.map((a) => [a.id, { ...a, projects: [] }]));
    const held = open.filter((x) => x.analyst_id && x.project_id).map((x) => x.id);
    const links = all(`SELECT x.user_id, p.id, p.code, p.title, c.code AS client_code, p.status, p.due_date, MAX(x.lead) AS lead, SUM(x.open_tests) AS open_tests,
        (SELECT COUNT(*) FROM tests pt JOIN samples ps ON ps.id = pt.sample_id WHERE ps.project_id = p.id AND pt.status != 'Cancelled') AS test_count,
        (SELECT COUNT(*) FROM tests pt JOIN samples ps ON ps.id = pt.sample_id WHERE ps.project_id = p.id AND pt.status = 'Approved') AS tests_done
      FROM (
        SELECT lead_id AS user_id, id AS project_id, 1 AS lead, 0 AS open_tests FROM projects WHERE lead_id IS NOT NULL AND status IN (${ph(PROJECT_OPEN)})
        UNION ALL
        SELECT t.analyst_id, s.project_id, 0, COUNT(*) FROM tests t JOIN samples s ON s.id = t.sample_id
        WHERE t.id IN (${ph(held)}) GROUP BY t.analyst_id, s.project_id
      ) x
      JOIN projects p ON p.id = x.project_id JOIN clients c ON c.id = p.client_id
      GROUP BY x.user_id, p.id
      ORDER BY lead DESC, p.due_date IS NULL, p.due_date, p.id`, ...PROJECT_OPEN, ...held);
    for (const { user_id, lead, ...project } of links) byId.get(user_id)?.projects.push({ ...project, lead: !!lead });

    return {
      unassigned: get(`SELECT COUNT(*) AS n FROM tests t JOIN samples s ON s.id = t.sample_id WHERE t.analyst_id IS NULL AND t.status = 'Pending' AND s.intake = ?`, INTAKE_ACCEPTED).n,
      analysts: [...byId.values()],
      // The Worklist's All open and Overdue views, which the totals link to; the rows count assigned work only.
      open: open.length,
      overdue: overdue.length,
    };
  });
}
