// The gate every sample submission passes, whoever wrote it: the client by hand or the assistant's draft. One ordered
// table of rules over a client's context and the submission body, saving nothing. submitSamples refuses the first
// problem; the dry run and the assistant read them all.

import { all, ph } from './db.js';
import { cleanAll, idList } from './util.js';
import { SAMPLE_TYPES, STORAGE_CONDITIONS, PRIORITIES, DEFAULT_PRIORITY, PROJECT_OPEN } from './lookups.js';
import { checkSampleRows } from './routes/lab.js';

// The Project is checked against the client's open Projects by the gate, which gives the same answer for one that does
// not exist, so the field itself only has to be an id.
export const submissionSchema = {
  project_id: { type: 'id', label: 'project' },
  sample_type: { type: 'enum', values: SAMPLE_TYPES },
  priority: { type: 'enum', values: PRIORITIES, default: DEFAULT_PRIORITY },
  storage: { type: 'enum', values: STORAGE_CONDITIONS },
  courier: { max: 120 },
  tracking_no: { max: 120, label: 'tracking number' },
  ship_date: { type: 'date', label: 'ship date' },
  notes: { type: 'text', max: 5000 },
};

const MAX_SUBMISSION_TEXT = 120;

/** Methods a client may request: effective, ready to use (has parameters), general or theirs. No prices. */
export const clientMethods = (clientId) => all(`
  SELECT m.id, m.code, m.version, m.title, m.technique, m.tat_days
  FROM methods m
  WHERE m.status = 'Effective' AND (m.client_id IS NULL OR m.client_id = ?)
    AND EXISTS (SELECT 1 FROM method_analytes a WHERE a.method_id = m.id)
  ORDER BY m.code`, clientId);

/** A client's open Projects, the ones a submission may name. Mirrors PROJECT_RULES.receive, reading the same open statuses. */
export const openProjects = (clientId) => all(`SELECT id, code, title FROM projects WHERE client_id = ? AND status IN (${ph(PROJECT_OPEN)}) ORDER BY code DESC`, clientId, ...PROJECT_OPEN);

/** What the gate knows about one client. */
export const submissionContext = (clientId) => ({ projects: openProjects(clientId), methods: clientMethods(clientId) });

const projectId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Each rule returns its problems: { path, message, fix? }, where fix.value at path resolves the problem.
// The order is the order a submission is refused in.
export const SUBMISSION_GATE = [
  {
    rule: 'project-open',
    check: ({ projects }, b) => {
      const id = projectId(b.project_id);
      return id && !projects.some((p) => p.id === id) ? [{ path: 'project_id', message: 'Project not found' }] : [];
    },
  },
  {
    rule: 'shipment-field',
    check: (_, b) => cleanAll(b, submissionSchema).problems.map(({ key, ...p }) => ({ path: key, ...p })),
  },
  {
    rule: 'sample-rows',
    check: (_, b) => checkSampleRows(b.samples, { max: MAX_SUBMISSION_TEXT }).problems,
  },
  {
    rule: 'tests-on-contract',
    check: ({ methods }, b) => {
      const ids = idList(b.method_ids);
      const kept = ids.filter((id) => methods.some((m) => m.id === id));
      return kept.length < ids.length ? [{ path: 'method_ids', message: 'One of the selected tests is not available', fix: { value: kept } }] : [];
    },
  },
];

/** Every gate problem in submission `input` for the client `context` describes, and the body to save when there are none. */
export function checkSubmission(context, input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const problems = SUBMISSION_GATE.flatMap(({ rule, check }) => check(context, b).map((p) => ({ rule, ...p })));
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems,
    submission: { ...cleanAll(b, submissionSchema).value, samples: checkSampleRows(b.samples, { max: MAX_SUBMISSION_TEXT }).rows, method_ids: idList(b.method_ids) },
  };
}
