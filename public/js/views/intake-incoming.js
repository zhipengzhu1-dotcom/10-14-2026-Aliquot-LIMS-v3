// Receiving & Review, the card of client Submissions announced from the portal whose parcel is still to be received
// (the Incoming tab). Receiving one creates its Samples straight into Pending review. The server decides which
// Submissions are listed and which actions each shows (`can`, `locks`); intake.js wires the buttons.
import { html } from '../core/html.js';
import { badge, priorityBadge, fmtDateTime, relTime, plural } from '../core/ui.js';
import { actionButtons } from './intake-actions.js';

const STATUS_TONE = { Submitted: 'blue', Acknowledged: 'teal' };

/** The card listing `submissions`, each row with the buttons of the actions `actions`. */
export function incomingCard(submissions, actions) {
  return html`<section class="card" data-incoming>
    <header class="card-head"><div><h2>Client Submissions to receive</h2>
      <p class="sub">${plural(submissions.length, 'submission')} announced from the portal. Receiving one creates its samples, which then wait in Pending review.</p></div></header>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Ref</th><th>Client</th><th>Samples</th><th>Turnaround</th><th>Shipping</th><th>Submitted</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${submissions.map((su) => html`<tr data-submission="${su.id}">
        <td><a class="code" href="/portal-inbox/submissions/${su.id}">${su.code}</a></td>
        <td class="title-cell"><strong>${su.client_name}</strong><span class="sub-line">${su.submitted_by || ''}</span></td>
        <td>${plural(su.sample_count, 'sample')}${su.method_count ? html`<span class="sub-line">${plural(su.method_count, 'test')}</span>` : ''}</td>
        <td>${priorityBadge(su.priority) || su.priority}</td>
        <td>${su.courier || '—'}${su.tracking_no ? html`<span class="sub-line mono">${su.tracking_no}</span>` : ''}</td>
        <td class="nowrap" title="${fmtDateTime(su.created_at)}">${relTime(su.created_at)}</td>
        <td>${badge(su.status, STATUS_TONE[su.status])}</td>
        <td>${actionButtons(su, actions)}</td>
      </tr>`)}</tbody></table></div>
  </section>`;
}
