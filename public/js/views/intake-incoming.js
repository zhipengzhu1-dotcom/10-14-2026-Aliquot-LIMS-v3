// The Incoming tab of Receiving & Review: client Submissions announced from the portal whose parcel is still to be
// received. Receiving one creates its Samples straight into Pending review, so the person lands on that tab. The server
// decides which Submissions are listed and which actions each is offered (`can`) and why not (`locks`).
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { icon } from '../core/icons.js';
import { navigate } from '../core/nav.js';
import { badge, priorityBadge, fmtDateTime, relTime, plural, emptyState, busy } from '../core/ui.js';
import { acknowledgeSubmission, declineSubmission, receiveSubmission } from './submission-actions.js';

const STATUS_TONE = { Submitted: 'blue', Acknowledged: 'teal' };

// `key` is the rule's name: the button is enabled when `can[key]`, and disabled with `locks[key]` beside it otherwise.
// `run` takes the Submission and resolves truthy when it was done.
const ACTIONS = [
  { key: 'acknowledge', label: 'Acknowledge', icon: 'check', run: acknowledgeSubmission },
  { key: 'decline', label: 'Decline', icon: 'x', run: declineSubmission },
  {
    key: 'receive',
    label: 'Receive samples',
    icon: 'tube',
    primary: true,
    run: async (su) => {
      const { submission, projects } = await api.get(`/api/portal-admin/submissions/${su.id}`);
      return receiveSubmission(submission, projects);
    },
    // The Samples it creates wait in Pending review, which is where the lab goes next.
    then: () => navigate('/samples/review'),
  },
];

function actionButtons(su) {
  return html`<span class="row nowrap" style="gap:6px">${ACTIONS.map((a) => html`
    <button class="btn sm ${a.primary && su.can[a.key] ? 'primary' : ''}" data-incoming-act="${a.key}" data-id="${su.id}" ${su.can[a.key] ? '' : raw('disabled')} title="${su.locks[a.key] ?? ''}">${icon(a.icon, { size: 13 })}${a.label}</button>`)}</span>
    ${ACTIONS.map((a) => (su.locks[a.key] ? html`<span class="sub-line" style="white-space:normal;max-width:300px" data-why="${a.key}">${su.locks[a.key]}</span>` : ''))}`;
}

/** Draws `submissions` into `host`. `after` reloads the screen once one of them changed. */
export function drawIncoming(host, { submissions, filtered, after }) {
  if (!submissions.length) {
    host.innerHTML = String(emptyState({
      icon: 'package',
      title: filtered ? 'No submissions match' : 'No submissions on their way',
      text: filtered ? 'Clear a filter or the search to see more.' : 'Clients announce shipments from the portal. Acknowledge them here, and receive them when the parcel arrives.',
    }));
    return;
  }
  host.innerHTML = String(html`<section class="card" data-incoming>
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
        <td>${actionButtons(su)}</td>
      </tr>`)}</tbody></table></div>
  </section>`);
  host.querySelectorAll('[data-incoming-act]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    const a = ACTIONS.find((x) => x.key === b.dataset.incomingAct);
    const su = submissions.find((x) => x.id === Number(b.dataset.id));
    if (!await a.run(su)) return;
    if (a.then) a.then();
    else await after();
  })));
}
