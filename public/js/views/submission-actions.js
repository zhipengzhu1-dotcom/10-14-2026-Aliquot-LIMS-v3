// The decisions on a client Submission: acknowledge, decline and receive. Shared by the Submission's page in the Portal
// inbox and the Incoming tab of Receiving & Review. Each opens its dialog, posts, tells the person, and resolves the
// server's answer, or null if the dialog was dismissed. The server decides which of them are offered (`can`).
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { refreshNav } from '../core/nav.js';
import { field, openForm, toast, plural, localDateTimeValue } from '../core/ui.js';

export async function acknowledgeSubmission(s) {
  const done = await openForm({
    title: `Acknowledge ${s.code}`,
    submitLabel: 'Acknowledge',
    body: field({ label: 'Message to the client (optional)', name: 'note', type: 'textarea', rows: 3, span: 2, placeholder: 'e.g. Slot booked for receipt on Tuesday morning.' }),
    onSubmit: (d) => api.post(`/api/portal-admin/submissions/${s.id}/acknowledge`, d),
  });
  if (done) { toast('Submission acknowledged — the client has been notified'); refreshNav(); }
  return done;
}

export async function declineSubmission(s) {
  const done = await openForm({
    title: `Decline ${s.code}`,
    submitLabel: 'Decline submission',
    danger: true,
    body: field({ label: 'Reason (shown to the client)', name: 'reason', type: 'textarea', rows: 3, span: 2, required: true }),
    onSubmit: (d) => api.post(`/api/portal-admin/submissions/${s.id}/decline`, d),
  });
  if (done) { toast('Submission declined'); refreshNav(); }
  return done;
}

/** `s` is the Submission as `GET /api/portal-admin/submissions/:id` returns it, `projects` that answer's open Projects. */
export async function receiveSubmission(s, projects) {
  const L = state.lookups;
  const methods = await api.get('/api/methods', { usable: 1 });
  const usable = methods.filter((m) => !m.client_id || m.client_id === s.client_id);
  const res = await openForm({
    title: `Receive ${plural(s.samples.length, 'sample')} from ${s.code}`,
    size: 'lg',
    submitLabel: 'Receive & create samples',
    body: html`
      ${field({ label: 'Received at', name: 'received_at', type: 'datetime-local', value: localDateTimeValue(), required: true })}
      ${field({ label: 'Condition on receipt', name: 'condition', type: 'select', options: L.receiptConditions, value: 'Acceptable' })}
      ${field({ label: 'Storage', name: 'storage', type: 'select', options: L.storageConditions, value: s.storage, empty: 'Select…' })}
      ${field({ label: 'Location', name: 'location', placeholder: 'e.g. Sample store A · Shelf 2' })}
      ${field({ label: 'Project', name: 'project_id', type: 'select', options: projects.map((p) => [p.id, `${p.code} — ${p.title}`]), value: s.project_id, empty: 'No project' })}
      ${field({ label: 'Shipment turnaround', name: 'priority', type: 'select', options: L.priorities, value: L.priorities.includes(s.priority) ? s.priority : L.defaultPriority, hint: `${L.priorities.includes(s.priority) ? 'As the client asked' : `The client asked for ${s.priority}, which is retired`}. Rows with their own urgency keep it.` })}
      ${field({ label: 'Due date', name: 'due_date', type: 'date', hint: 'Default: from the turnaround tier' })}
      <div class="field span-2"><span class="label">Tests to assign</span>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px;max-height:220px;overflow:auto">
          ${usable.map((m) => html`<label class="check"><input type="checkbox" name="method_ids" value="${m.id}" ${s.method_ids.includes(m.id) ? raw('checked') : ''}><span><span class="code">${m.code}</span> ${m.title}</span></label>`)}
        </div></div>
      ${field({ label: 'Receipt notes', name: 'notes', type: 'textarea', rows: 2, span: 2 })}`,
    onSubmit: (d) => api.post(`/api/portal-admin/submissions/${s.id}/receive`, {
      ...d, received_at: d.received_at ? new Date(d.received_at).toISOString() : null, project_id: d.project_id ? Number(d.project_id) : null,
      storage: d.storage || null, due_date: d.due_date || null, method_ids: (d.method_ids || []).map(Number),
    }),
  });
  if (res) { toast(`Received as ${res.samples.map((x) => x.code).join(', ')}`); refreshNav(); }
  return res;
}
