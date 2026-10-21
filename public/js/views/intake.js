// Receiving & Review: the Queue of received Samples waiting for an intake decision, grouped by Submission. The server
// decides everything shown here: which Samples are listed, which actions each is offered (`can`) and why an action is
// refused (`locks`). This screen carries no status check of its own.
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { state, can } from '../core/state.js';
import { icon } from '../core/icons.js';
import { navigate, refreshNav, setQuery } from '../core/nav.js';
import {
  pageHead, segmented, searchBox, priorityBadge, dueChip, fmtDateTime, plural, emptyState, badge, toast, showError, busy, confirmDialog, debounce,
} from '../core/ui.js';
import { assignAction } from './intake-assign.js';

// The tabs, in order. Each is a stage of intake; the server returns the Samples of the tab asked for.
const TABS = [
  { key: 'pending', label: 'Pending review' },
  { key: 'hold', label: 'On hold' },
  { key: 'ready', label: 'Ready to assign' },
];

// The decisions the screen offers on one Sample. `key` is the rule's name: the button is enabled when `can[key]`, and
// disabled with `locks[key]` beside it otherwise. `bulk` is set for the ones that also apply to a selection.
const ACTIONS = [
  { key: 'accept', label: 'Accept', icon: 'check', primary: true, bulk: { path: '/api/samples/accept', done: 'accepted' } },
  assignAction, // opens its own dialog (`run`) instead of posting to /api/samples/<id>/<key>
];

const FILTERS = ['client', 'project', 'priority', 'overdue'];

function actionButtons(s) {
  return html`<span class="row nowrap" style="gap:6px">${ACTIONS.map((a) => html`
    <button class="btn sm ${a.primary && s.can[a.key] ? 'primary' : ''}" data-act="${a.key}" data-id="${s.id}" data-code="${s.code}" ${s.can[a.key] ? '' : raw('disabled')} title="${s.locks[a.key] ?? ''}">${icon(a.icon, { size: 13 })}${a.label}</button>`)}</span>
    ${ACTIONS.map((a) => (s.locks[a.key] ? html`<span class="sub-line" style="white-space:normal;max-width:300px" data-why="${a.key}">${s.locks[a.key]}</span>` : ''))}`;
}

function groupTable(group) {
  const pickable = (s) => ACTIONS.some((a) => a.bulk && s.can[a.key]);
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th class="sel">${group.samples.some(pickable) ? html`<input type="checkbox" data-all aria-label="Select every sample in this group">` : ''}</th><th>Sample</th><th>Client</th><th>Type</th><th>Tests</th><th>Priority</th><th>Due</th><th>Received</th><th>Decision</th></tr></thead>
    <tbody>${group.samples.map((s) => html`<tr data-row="${s.id}">
      <td class="sel">${pickable(s) ? html`<input type="checkbox" data-pick value="${s.id}" aria-label="Select ${s.code}">` : ''}</td>
      <td class="title-cell"><a class="code" href="/samples/${s.id}">${s.code}</a> <strong>${s.description}</strong>
        <span class="sub-line">${[s.batch_no && `Batch ${s.batch_no}`, s.client_ref].filter(Boolean).join(' · ') || ' '}</span></td>
      <td><span title="${s.client_name}">${s.client_code}</span>${s.project_code ? html`<span class="sub-line">${s.project_code}</span>` : ''}</td>
      <td>${s.sample_type || html`<span class="muted">—</span>`}</td>
      <td class="num">${s.test_count}</td>
      <td>${priorityBadge(s.priority) || s.priority}</td>
      <td>${dueChip(s.due_date)}</td>
      <td class="nowrap muted small">${fmtDateTime(s.received_at)}</td>
      <td>${actionButtons(s)}</td>
    </tr>`)}</tbody></table></div>`;
}

function groupCard(group) {
  const sub = group.submission;
  const first = group.samples[0];
  return html`<section class="card" data-group="${sub ? sub.id : 'direct'}">
    <header class="card-head"><div>
      <h2>${sub ? html`<a class="code" href="/portal-inbox/submissions/${sub.id}">${sub.code}</a> · ${first.client_name}` : 'Received at the front desk'}</h2>
      <p class="sub">${sub ? `Client Submission received ${fmtDateTime(sub.received_at)}` : 'Not part of a client Submission'} · ${plural(group.samples.length, 'sample')}</p>
    </div></header>
    ${groupTable(group)}
  </section>`;
}

function outcomePanel(r, verb) {
  const refused = r.results.filter((x) => !x.ok);
  return html`<section class="card mb" data-outcomes><header class="card-head"><div><h2>${plural(r.accepted, 'sample')} ${verb}${refused.length ? `, ${refused.length} refused` : ''}</h2>
    <p class="sub">Each sample was decided on its own, so a refusal does not stop the others.</p></div><div class="card-actions"><button class="btn sm ghost" data-dismiss>Dismiss</button></div></header>
    <ul class="list">${r.results.map((x) => html`<li><div class="grow"><span class="code">${x.code ?? `#${x.id}`}</span> ${x.ok ? badge('Accepted', 'green') : badge('Refused', 'red')}
      ${x.ok ? '' : html`<span class="sub-line">${x.error}</span>`}</div></li>`)}</ul></section>`;
}

export async function render(ctx) {
  ctx.title('Receiving & Review');
  const tab = TABS.some((t) => t.key === ctx.query.tab) ? ctx.query.tab : 'pending';
  const [clients, projects] = await Promise.all([api.get('/api/clients'), api.get('/api/projects')]);
  let search = ctx.query.q || '';
  let data;

  ctx.el.innerHTML = String(html`
    ${pageHead({ title: 'Receiving & Review', sub: 'Samples received and waiting for a decision before their tests can be assigned.', back: { href: '/samples', label: 'Samples' } })}
    <div class="toolbar" data-toolbar></div>
    <div data-outcomes-host></div>
    <div data-list></div>`);

  const query = () => ({
    tab,
    client_id: ctx.query.client,
    project_id: ctx.query.project,
    priority: ctx.query.priority,
    overdue: ctx.query.overdue,
    q: search,
  });

  function drawToolbar() {
    const hasFilter = FILTERS.some((f) => ctx.query[f]);
    const bar = ctx.el.querySelector('[data-toolbar]');
    bar.innerHTML = String(html`
      ${segmented(TABS.map((t) => ({ ...t, count: data.counts[t.key], href: setQuery({ tab: t.key === 'pending' ? null : t.key }) })), tab)}
      <select data-filter-client class="auto-w" aria-label="Client"><option value="">All clients</option>
        ${clients.map((c) => html`<option value="${c.id}" ${String(c.id) === ctx.query.client ? raw('selected') : ''}>${c.name}</option>`)}</select>
      <select data-filter-project class="auto-w" aria-label="Project"><option value="">All projects</option>
        ${projects.map((p) => html`<option value="${p.id}" ${String(p.id) === ctx.query.project ? raw('selected') : ''}>${p.code}</option>`)}</select>
      <select data-filter-priority class="auto-w" aria-label="Priority"><option value="">Any priority</option>
        ${state.lookups.priorities.map((p) => html`<option value="${p}" ${p === ctx.query.priority ? raw('selected') : ''}>${p}</option>`)}</select>
      <label class="row" style="gap:6px"><input type="checkbox" data-filter-overdue ${ctx.query.overdue ? raw('checked') : ''}> Overdue</label>
      ${hasFilter ? html`<a class="btn sm ghost" href="${setQuery({ client: null, project: null, priority: null, overdue: null })}">Clear filters</a>` : ''}
      <span class="spacer"></span>
      ${searchBox('Search samples…', search)}`);
    const pick = (sel, key) => bar.querySelector(sel).addEventListener('change', (e) => navigate(setQuery({ [key]: e.target.value })));
    pick('[data-filter-client]', 'client');
    pick('[data-filter-project]', 'project');
    pick('[data-filter-priority]', 'priority');
    bar.querySelector('[data-filter-overdue]').addEventListener('change', (e) => navigate(setQuery({ overdue: e.target.checked ? 1 : null })));
    const box = bar.querySelector('[data-filter]');
    box.addEventListener('input', debounce(() => {
      search = box.value;
      history.replaceState(null, '', setQuery({ q: search }));
      load({ keepToolbar: true });
    }, 250));
  }

  function drawList() {
    const host = ctx.el.querySelector('[data-list]');
    const filtered = search || FILTERS.some((f) => ctx.query[f]);
    if (!data.groups.length) {
      host.innerHTML = String(emptyState({
        icon: 'inbox',
        title: filtered ? 'No samples match' : tab === 'pending' ? 'Nothing waiting for review' : tab === 'hold' ? 'No samples on hold' : 'Nothing ready to assign',
        text: filtered ? 'Clear a filter or the search to see more.' : can('samples.review') ? 'Newly received samples appear here.' : 'Intake decisions are made by managers and scientists.',
      }));
      return;
    }
    const bulk = ACTIONS.filter((a) => a.bulk && data.groups.some((g) => g.samples.some((s) => s.can[a.key])));
    host.innerHTML = String(html`
      ${bulk.length ? html`<div class="toolbar">${bulk.map((a) => html`<button class="btn ${a.primary ? 'primary' : ''}" data-bulk="${a.key}" disabled>${icon(a.icon, { size: 15 })}${a.label} selected</button>`)}
        <button class="btn" data-select-all>Select all shown</button></div>` : ''}
      ${data.groups.map(groupCard)}`);
    wireList(host);
  }

  function wireList(host) {
    const picked = () => [...host.querySelectorAll('[data-pick]:checked')].map((c) => Number(c.value));
    const sync = () => {
      const n = picked().length;
      host.querySelectorAll('[data-bulk]').forEach((b) => {
        const a = ACTIONS.find((x) => x.key === b.dataset.bulk);
        b.disabled = !n;
        b.innerHTML = String(html`${icon(a.icon, { size: 15 })}${a.label} selected${n ? ` (${n})` : ''}`);
      });
    };
    host.addEventListener('change', (e) => {
      if (e.target.matches('[data-all]')) e.target.closest('table').querySelectorAll('[data-pick]').forEach((c) => { c.checked = e.target.checked; });
      sync();
    });
    host.querySelector('[data-select-all]')?.addEventListener('click', () => {
      const boxes = [...host.querySelectorAll('[data-pick]')];
      const on = !boxes.every((c) => c.checked);
      boxes.forEach((c) => { c.checked = on; });
      host.querySelectorAll('[data-all]').forEach((c) => { c.checked = on; });
      sync();
    });
    const outcomesHost = () => ctx.el.querySelector('[data-outcomes-host]');
    host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const a = ACTIONS.find((x) => x.key === b.dataset.act);
      if (a.run) return a.run({ ids: [Number(b.dataset.id)], outcomes: outcomesHost(), after });
      return busy(b, async () => {
        await api.post(`/api/samples/${b.dataset.id}/${b.dataset.act}`);
        toast(`${b.dataset.code} ${a.bulk?.done ?? 'updated'}`);
        await after();
      });
    }));
    host.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
      const a = ACTIONS.find((x) => x.key === b.dataset.bulk);
      const ids = picked();
      if (a.run) return a.run({ ids, outcomes: outcomesHost(), after });
      if (!await confirmDialog({ title: `${a.label} ${plural(ids.length, 'sample')}`, message: 'Each sample is decided on its own and the outcome of every one is listed.', confirmLabel: a.label })) return;
      await busy(b, async () => {
        const r = await api.post(a.bulk.path, { sample_ids: ids });
        toast(`${plural(r.accepted, 'sample')} ${a.bulk.done}${r.refused ? `, ${r.refused} refused` : ''}`, r.refused ? 'info' : 'success');
        await after();
        const outcomes = ctx.el.querySelector('[data-outcomes-host]');
        outcomes.innerHTML = String(outcomePanel(r, a.bulk.done));
        outcomes.querySelector('[data-dismiss]').addEventListener('click', () => { outcomes.innerHTML = ''; });
      });
    }));
  }

  /** Reload the Queue after a decision, keeping the filters, and move the sidebar badge. */
  async function after() {
    refreshNav();
    await load();
  }

  async function load({ keepToolbar = false } = {}) {
    try {
      data = await api.get('/api/intake', query());
    } catch (e) {
      showError(e);
      return;
    }
    if (keepToolbar) {
      ctx.el.querySelectorAll('[data-toolbar] .segmented a').forEach((a, i) => {
        a.querySelector('.count').textContent = data.counts[TABS[i].key];
      });
    } else {
      drawToolbar();
    }
    drawList();
  }

  await load();
}
