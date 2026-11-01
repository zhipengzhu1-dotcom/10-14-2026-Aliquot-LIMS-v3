// Receiving & Review: every action the screen offers, on Samples and on client Submissions, under one contract. The
// server's tab definition says which of them a tab shows, and each record's `can` and `locks` whether one is enabled
// and why not; this file only says how each is done.
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { icon } from '../core/icons.js';
import { navigate } from '../core/nav.js';
import { toast, plural, confirmDialog, promptReason } from '../core/ui.js';
import { askHoldReason } from './intake-hold.js';
import { assignDialog } from './intake-assign.js';
import { showOutcomes } from './intake-outcomes.js';
import { acknowledgeSubmission, declineSubmission, receiveSubmission } from './submission-actions.js';

/** Asks why a Sample is rejected; resolves `{ reason }`, or null if dismissed. */
const askRejectReason = async () => {
  const reason = await promptReason('Why is this sample being rejected? It and its open tests are cancelled, and the client is told the reason');
  return reason ? { reason } : null;
};

/** A decision posted to /api/samples/<id>/<key>. `ask`, when given, resolves the request body for the Sample, or null to cancel. */
const decide = (key, done, ask) => async ([s], { after }) => {
  const body = ask ? await ask(s) : undefined;
  if (ask && !body) return;
  await api.post(`/api/samples/${s.id}/${key}`, body);
  toast(`${s.code} ${done}`);
  await after();
};

async function acceptMany(samples, { outcomes, after }) {
  if (!await confirmDialog({ title: `Accept ${plural(samples.length, 'sample')}`, message: 'Each sample is decided on its own and the outcome of every one is listed.', confirmLabel: 'Accept' })) return;
  const r = await api.post('/api/samples/accept', { sample_ids: samples.map((s) => s.id) });
  toast(`${plural(r.accepted, 'sample')} accepted${r.refused ? `, ${r.refused} refused` : ''}`, r.refused ? 'info' : 'success');
  await after();
  showOutcomes(outcomes, { noun: 'sample', verb: 'accepted', done: 'Accepted', rows: r.results.map((x) => ({ label: x.code ?? `#${x.id}`, ok: x.ok, error: x.error })) });
}

async function assign(samples, { outcomes, after }) {
  const r = await assignDialog(samples.map((s) => s.id));
  if (!r?.results) return;
  toast(`${plural(r.assigned, 'test')} assigned${r.refused ? `, ${r.refused} refused` : ''}`, r.refused ? 'info' : 'success');
  await after();
  showOutcomes(outcomes, { noun: 'test', verb: 'assigned', done: 'Assigned', rows: r.results.map((x) => ({ label: `${x.sample_code ?? `#${x.sample_id}`} ${x.method_code ?? ''}`.trim(), ok: x.ok, error: x.error })) });
}

/** A decision on a Submission: `open` shows its dialog, posts and tells the person; the screen reloads once it was done. */
const onSubmission = (open) => async ([su], { after }) => {
  if (await open(su)) await after();
};

async function receive([su]) {
  const { submission, projects } = await api.get(`/api/portal-admin/submissions/${su.id}`);
  // The Samples it creates wait in Pending review, which is where the lab goes next.
  if (await receiveSubmission(submission, projects)) navigate('/samples/review');
}

// By rule name. `run(records, env)` does the action on one record from its row's button; `bulk`, when set, on every
// ticked record. Both resolve once done (or dismissed). `env` is `{ outcomes, after }`: the host for an outcome card,
// and the reload once something changed. A Sample record carries the `submission` it came in, or null.
export const ACTIONS = {
  accept: { label: 'Accept', icon: 'check', primary: true, run: decide('accept', 'accepted'), bulk: acceptMany },
  hold: { label: 'Hold', icon: 'clock', run: decide('hold', 'put on hold', (s) => askHoldReason({ sample: s, submission: s.submission })) },
  release: { label: 'Release', icon: 'undo', run: decide('release', 'released') },
  reject: { label: 'Reject', icon: 'x', run: decide('reject', 'rejected', askRejectReason) },
  assign: { label: 'Assign', icon: 'users', run: assign, bulk: assign },
  acknowledge: { label: 'Acknowledge', icon: 'check', run: onSubmission(acknowledgeSubmission) },
  decline: { label: 'Decline', icon: 'x', run: onSubmission(declineSubmission) },
  receive: { label: 'Receive samples', icon: 'tube', primary: true, run: receive },
};

/**
 * The buttons of the actions `keys` that `record` shows: those its `locks` names. Each is enabled when `can` allows it,
 * and otherwise disabled with the refusal beside it.
 */
export function actionButtons(record, keys) {
  const shown = keys.filter((key) => Object.hasOwn(record.locks, key));
  return html`<span class="row nowrap" style="gap:6px">${shown.map((key) => html`
    <button class="btn sm ${ACTIONS[key].primary && record.can[key] ? 'primary' : ''}" data-act="${key}" data-id="${record.id}" data-code="${record.code}" ${record.can[key] ? '' : raw('disabled')} title="${record.locks[key] ?? ''}">${icon(ACTIONS[key].icon, { size: 13 })}${ACTIONS[key].label}</button>`)}</span>
    ${shown.map((key) => (record.locks[key] ? html`<span class="sub-line" style="white-space:normal;max-width:300px" data-why="${key}">${record.locks[key]}</span>` : ''))}`;
}
