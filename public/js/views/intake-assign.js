// Receiving & Review, assigning: the dialog that gives the Tests of one or several accepted Samples to an analyst, and
// the card that reports an outcome for every Test. The server decides which Samples are offered assign (`can.assign`),
// which Tests can be assigned and who is qualified; this file carries no status or qualification check of its own.
import { html } from '../core/html.js';
import { api } from '../core/api.js';
import { refreshNav } from '../core/nav.js';
import { plural, badge, field, openForm, toast } from '../core/ui.js';

/** Analysts in the order they are best offered the work: qualified on the most Methods first, then the lightest workload. */
function ranked(options) {
  const score = (a) => options.methods.filter((m) => a.qualified[m.code]).length;
  return [...options.analysts].sort((a, b) => (score(b) - score(a)) || (a.open - b.open) || a.full_name.localeCompare(b.full_name));
}

function analystRow(a, options) {
  return html`<label data-analyst="${a.id}"><input type="radio" name="analyst_id" value="${a.id}">
    <span class="grow"><strong>${a.full_name}</strong><small>${a.title || a.role}</small>
      <span class="row" style="gap:4px;flex-wrap:wrap;margin-top:4px">${options.methods.map((m) => html`<span data-qualified="${m.code}" data-ok="${a.qualified[m.code] ? 1 : 0}">${a.qualified[m.code]
        ? badge(`${m.code} qualified`, 'green', { title: `${a.full_name} is qualified on ${m.code}` })
        : badge(`${m.code} not qualified`, 'red', { title: `${a.full_name} would be refused ${m.code}` })}</span>`)}</span></span>
    <span class="badge ${a.open > 8 ? 'amber' : 'gray'}" data-open title="Open tests">${a.open} open</span>
  </label>`;
}

/** Opens the assign dialog for the Samples `sampleIds`. Resolves with the server's outcomes, or null when cancelled. */
export async function assignDialog(sampleIds) {
  const options = await api.get('/api/intake/assign-options', { sample_ids: sampleIds.join(',') });
  const blocked = options.tests.filter((t) => t.why);
  const samples = new Set(options.tests.map((t) => t.sample_id)).size;
  return openForm({
    title: `Assign ${plural(options.tests.length - blocked.length, 'test')}`,
    submitLabel: 'Assign',
    body: html`
      <p class="span-2 muted small" data-scope>${plural(options.tests.length, 'unassigned test')} on ${plural(samples, 'sample')}, Methods ${options.methods.map((m) => m.code).join(', ') || 'none'}.
        An analyst who is not qualified on a Method is refused for that test only; the others are still assigned.</p>
      ${blocked.length ? html`<ul class="span-2 small" data-blocked>${blocked.map((t) => html`<li><span class="code">${t.sample_code}</span> ${t.method_code}: ${t.why}</li>`)}</ul>` : ''}
      <div class="span-2 pick-list" style="max-height:320px">${ranked(options).map((a) => analystRow(a, options))}</div>
      ${field({ label: 'Due date (optional)', name: 'due_date', type: 'date', hint: 'Leave empty to keep the current due date' })}`,
    onSubmit: async (d) => {
      if (!d.analyst_id) throw new Error('Choose an analyst');
      return api.post('/api/intake/assign', { sample_ids: sampleIds, analyst_id: Number(d.analyst_id), due_date: d.due_date || null });
    },
  });
}

/** The card listing the outcome of every Test in `r`, with the server's reason for each refusal. */
function outcomePanel(r) {
  return html`<section class="card mb" data-outcomes><header class="card-head"><div><h2>${plural(r.assigned, 'test')} assigned${r.refused ? `, ${r.refused} refused` : ''}</h2>
    <p class="sub">Each test was decided on its own, so a refusal does not stop the others.</p></div><div class="card-actions"><button class="btn sm ghost" data-dismiss>Dismiss</button></div></header>
    <ul class="list">${r.results.map((x) => html`<li><div class="grow"><span class="code">${x.sample_code ?? `#${x.sample_id}`}</span> ${x.method_code ?? ''} ${x.ok ? badge('Assigned', 'green') : badge('Refused', 'red')}
      ${x.ok ? '' : html`<span class="sub-line">${x.error}</span>`}</div></li>`)}</ul></section>`;
}

/** The Assign action of the screen: opens the dialog for the Samples chosen, reports each Test's outcome, then reloads. */
export const assignAction = {
  key: 'assign',
  label: 'Assign',
  icon: 'users',
  bulk: true,
  async run({ ids, outcomes, after }) {
    const r = await assignDialog(ids);
    if (!r?.results) return;
    toast(`${plural(r.assigned, 'test')} assigned${r.refused ? `, ${r.refused} refused` : ''}`, r.refused ? 'info' : 'success');
    refreshNav();
    await after();
    outcomes.innerHTML = String(outcomePanel(r));
    outcomes.querySelector('[data-dismiss]').addEventListener('click', () => { outcomes.innerHTML = ''; });
  },
};
