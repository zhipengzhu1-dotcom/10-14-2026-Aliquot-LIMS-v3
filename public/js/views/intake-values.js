// The review pane's values sections: what the client submitted beside what the Sample holds now, the receipt condition,
// the client's notes and sheet details, the Submission's portal thread, and the corrections the manager makes while
// reviewing. The server decides what is offered (`corrections.can`) and why not (`corrections.locks`); nothing here
// checks a status. Corrections use the Sample and Test actions, so the audit trail records old and new values.
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { icon } from '../core/icons.js';
import { card, kv, badge, statusBadge, fmtDateTime, plural, field, openForm, promptReason, toast, showError, busy } from '../core/ui.js';

const INTAKE_TONES = { 'Pending review': 'blue', 'On hold': 'amber', Accepted: 'green' };
export const intakeBadge = (intake) => badge(intake, INTAKE_TONES[intake] ?? 'gray');

const dash = html`<span class="muted">—</span>`;
const show = (v) => (v === null || v === '' || v === undefined ? dash : v);

// The fields a manager may correct in review, with how each is entered.
const CORRECTIONS = [
  { key: 'description', label: 'Description', required: true, span: 2 },
  { key: 'batch_no', label: 'Batch / lot' },
  { key: 'client_ref', label: 'Client reference' },
  { key: 'priority', label: 'Turnaround', select: () => state.lookups.priorities },
  { key: 'storage', label: 'Storage', select: () => state.lookups.storageConditions, empty: '—' },
];

/** Disabled-with-reason beside an action: the button carries the refusal as its title and a visible line follows. */
const why = (key, lock) => (lock ? html`<span class="sub-line" data-why="${key}">${lock}</span>` : '');

function comparison(r) {
  const direct = !r.submitted;
  const c = r.corrections;
  return card({
    title: 'Submitted and current values',
    sub: direct ? 'Received at the front desk: there is no client submission to compare with.' : html`From Submission <a class="code" href="/portal-inbox/submissions/${r.submitted.submission.id}">${r.submitted.submission.code}</a>. Changed values are marked.`,
    actions: html`<button class="btn sm" data-edit-sample ${c.can.edit ? '' : raw('disabled')} title="${c.locks.edit ?? ''}">${icon('edit', { size: 13 })}Correct values</button>`,
    body: html`<div class="table-wrap"><table class="table" data-values>
      <thead><tr><th>Field</th>${direct ? '' : html`<th>Submitted</th>`}<th>Current</th></tr></thead>
      <tbody>${r.fields.map((f) => html`<tr data-field="${f.key}" data-changed="${f.changed}">
        <td class="muted">${f.label}</td>
        ${direct ? '' : html`<td data-submitted>${show(f.submitted)}</td>`}
        <td data-current><strong>${show(f.current)}</strong>${f.changed ? html` ${badge('Changed', 'amber')}` : ''}</td>
      </tr>`)}</tbody></table></div>${why('edit', c.locks.edit)}`,
  });
}

function receipt(r) {
  const k = r.condition;
  return card({
    title: 'Receipt and storage',
    body: kv([
      ['Condition', k.condition && k.condition !== 'Acceptable' ? badge(k.condition, 'amber') : k.condition],
      ['Storage condition', k.storage], ['Storage location', k.location],
      ['Received', fmtDateTime(k.received_at)], ['Received by', k.received_by_name], k.receipt_note && ['Receipt note', k.receipt_note],
    ]),
  });
}

function clientNotes(r) {
  const d = r.details;
  const none = !d.submission_notes && !d.notes && !d.sheet.length;
  return card({
    title: 'Client notes and sheet details',
    body: none ? html`<p class="muted">The client added no notes or sheet details.</p>` : kv([
      d.submission_notes && ['Submission notes', html`<span style="white-space:pre-wrap">${d.submission_notes}</span>`],
      d.notes && ['Sample notes', html`<span style="white-space:pre-wrap">${d.notes}</span>`],
      ...d.sheet.map((x) => [x.label, x.value]),
    ]),
  });
}

const SIDES = { client: 'Client', lab: 'Lab', system: 'System' };

function thread(r) {
  if (!r.thread) return card({ title: 'Portal thread', body: html`<p class="muted">Received at the front desk, so there is no client thread.</p>` });
  return card({
    title: 'Portal thread',
    sub: r.thread.subject,
    body: html`<ul class="list" data-thread>${r.thread.messages.map((m) => html`<li data-message="${m.side}"><div class="grow">
      <div class="meta"><strong>${m.author_name}</strong> ${badge(SIDES[m.side], m.side === 'client' ? 'blue' : m.side === 'lab' ? 'green' : 'gray', { dot: false })} <span class="muted small">${fmtDateTime(m.created_at)}</span></div>
      <div style="white-space:pre-wrap">${m.body}</div></div></li>`)}</ul>`,
  });
}

function testCorrections(r) {
  const c = r.corrections;
  return card({
    title: 'Add or cancel tests',
    sub: plural(c.tests.filter((t) => t.status !== 'Cancelled').length, 'test'),
    actions: html`<button class="btn sm" data-add-test ${c.can.addTests ? '' : raw('disabled')} title="${c.locks.addTests ?? ''}">${icon('plus', { size: 13 })}Add test</button>`,
    flush: true,
    body: html`<ul class="list">${c.tests.map((t) => html`<li data-correct-test="${t.id}"><div class="grow">
      <div class="title"><span class="code">${t.code}</span> ${t.method_title}</div>
      <div class="meta">${t.method_code} v${t.method_version}</div>${why(`cancel-${t.id}`, t.locks.cancel)}</div>
      ${statusBadge(t.status)}
      <button class="btn sm" data-cancel-test="${t.id}" data-code="${t.code}" ${t.can.cancel ? '' : raw('disabled')} title="${t.locks.cancel ?? ''}">${icon('xCircle', { size: 13 })}Cancel</button></li>`)}</ul>
      ${why('addTests', c.locks.addTests)}`,
  });
}

function editSample(r, reload) {
  const need = r.corrections.reason_required;
  return openForm({
    title: `Correct ${r.sample.code}`,
    size: 'lg',
    body: html`
      <p class="span-2 notice ${need ? 'warn' : ''}">${icon('shield', { size: 15 })}<span>${need ? 'Testing has started, so a reason is required. ' : ''}Each change is recorded in the audit trail with the old and the new value.</span></p>
      ${CORRECTIONS.map((f) => field({
        label: f.label, name: f.key, value: r.current[f.key], required: f.required, span: f.span,
        ...(f.select ? { type: 'select', options: [...new Set([...f.select(), r.current[f.key]].filter(Boolean))], empty: f.empty } : {}),
      }))}
      ${field({ label: need ? 'Reason' : 'Reason (optional)', name: 'reason', type: 'textarea', rows: 2, span: 2, required: need, placeholder: 'e.g. Batch number corrected from the delivery note' })}`,
    onSubmit: async (data) => {
      const patch = Object.fromEntries(Object.entries(data).filter(([key, v]) => key === 'reason' ? v.trim() : (v ?? '') !== (r.current[key] ?? '')));
      if (!Object.keys(patch).filter((k) => k !== 'reason').length) throw new Error('Nothing was changed');
      await api.put(`/api/samples/${r.sample.id}`, patch);
      toast('Sample corrected');
      await reload();
    },
  });
}

async function addTest(r, reload) {
  const methods = await api.get('/api/methods', { usable: 1 });
  const have = new Set(r.corrections.tests.filter((t) => t.status !== 'Cancelled').map((t) => t.method_code));
  return openForm({
    title: `Add a test to ${r.sample.code}`,
    submitLabel: 'Add test',
    body: html`${field({
      label: 'Method', name: 'method_id', type: 'select', required: true, span: 2, empty: 'Choose a method…',
      options: methods.map((m) => ({ value: m.id, label: `${m.code} v${m.version} · ${m.title}${have.has(m.code) ? ' (already requested)' : ''}` })),
    })}`,
    onSubmit: async (data) => {
      await api.post(`/api/samples/${r.sample.id}/tests`, { method_ids: [Number(data.method_id)] });
      toast('Test added');
      await reload();
    },
  });
}

async function cancelTest(button, reload) {
  const reason = await promptReason('Why is this test being cancelled? It will no longer be billed or reported');
  if (!reason) return;
  await busy(button, async () => {
    await api.post(`/api/tests/${button.dataset.cancelTest}/cancel`, { reason });
    toast(`${button.dataset.code} cancelled`);
    await reload();
  });
}

/** The values half of the review pane: `render(review)` is its markup, `wire(root, review, { reload })` its actions. */
export const section = {
  key: 'values',
  render: (r) => html`<div class="stack" data-section="values">${comparison(r)}${testCorrections(r)}${receipt(r)}${clientNotes(r)}${thread(r)}</div>`,
  wire(root, r, { reload }) {
    root.querySelector('[data-edit-sample]')?.addEventListener('click', () => editSample(r, reload));
    root.querySelector('[data-add-test]')?.addEventListener('click', () => addTest(r, reload).catch(showError));
    root.querySelectorAll('[data-cancel-test]').forEach((b) => b.addEventListener('click', () => cancelTest(b, reload).catch(showError)));
  },
};
