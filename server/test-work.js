// Test work: each view of the lab's Tests that a count or a list shows, named once, so that a count and the list it
// links to cannot disagree. The Dashboard, Workload, the Assign dialog and the Worklist all read these views. They are
// lab-wide views by status, the same for everyone, and not Queues (GLOSSARY.md): a person's work for one action is a
// Queue in TEST_QUEUES. A Test is work only once intake review has accepted its Sample, the fact intakeGate refuses on.

import { all, ph } from './db.js';
import { priorityRank } from './lookups.js';
import { today } from './util.js';
import { TEST_SELECT, TEST_EDITABLE, TEST_QUEUES, acceptedAtIntake } from './workflow.js';

export const TEST_WORK = {
  /** open: the Tests still to be performed, Pending or In Progress, on accepted Samples, the most urgent first. */
  open: () => all(`${TEST_SELECT} WHERE t.status IN (${ph(TEST_EDITABLE)}) ORDER BY ${priorityRank('s.priority')}, t.due_date, t.id`, ...TEST_EDITABLE)
    .filter(acceptedAtIntake),

  /** overdue: the Tests of `open` past their due date. */
  overdue(open = TEST_WORK.open()) {
    const day = today();
    return open.filter((t) => t.due_date && t.due_date < day);
  },

  /** load(analyst): the Tests of `open` assigned to `analystId`. */
  load: (analystId, open = TEST_WORK.open()) => open.filter((t) => t.analyst_id === analystId),

  /** in review: the Tests waiting for peer review and for approval, the stages of those Queues read unfiltered as oversight reads them. */
  inReview: () => ({ review: TEST_QUEUES.review.stage(), approval: TEST_QUEUES.approval.stage() }),

  // unassigned: #59 fills it, as the unassigned and claimable Test Queues.
};
