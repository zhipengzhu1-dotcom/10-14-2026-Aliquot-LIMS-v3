// Intake review: a received Sample waits here for a person with `samples.review` to decide on it before its Tests
// can be assigned. The rules (`SAMPLE_RULES.accept`) live in ../workflow.js; each decision is kept in intake_decisions.

import { tx } from '../db.js';
import { insert, update, mustGet } from '../repo.js';
import { guard } from '../http.js';
import { INTAKE_ACCEPTED } from '../lookups.js';
import { nowIso } from '../util.js';
import { SAMPLE_RULES } from '../workflow.js';

/** Moves Sample `s` to intake state `intake` and records who decided it, when and why, in one transaction. */
function decide(ctx, s, decision, { intake, summary, reason = null }) {
  tx(() => {
    update(ctx, 'samples', s.id, { intake }, { action: 'STATUS', summary, reason });
    insert(ctx, 'intake_decisions', { sample_id: s.id, decision, reason, decided_by: ctx.user.id, decided_at: nowIso() }, { code: s.code, summary });
  });
}

export function acceptSample(ctx, sampleId) {
  const s = mustGet('SELECT * FROM samples WHERE id = ?', sampleId, 'Sample');
  guard(SAMPLE_RULES.accept(s, ctx.user));
  decide(ctx, s, 'Accepted', { intake: INTAKE_ACCEPTED, summary: 'Sample accepted at intake review' });
  return { ok: true };
}

export default function routes(r) {
  r.post('/api/samples/:id/accept', (ctx) => acceptSample(ctx, +ctx.params.id));
}
