// Receiving & Review: client Submissions on their way in (the Incoming tab), then the Queue of received Samples waiting
// for an intake decision, grouped by Submission. The server decides everything shown here: the tabs and what each one
// shows (`tabs`: label, actions, filters, search, empty state), which records are listed, which actions each is offered
// (`can`) and why an action is refused (`locks`). This screen draws whichever tab it is given and carries no tab or
// status check of its own.
import { html, raw } from '../core/html.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { icon } from '../core/icons.js';
import { navigate, refreshNav, setQuery } from '../core/nav.js';
import {
  pageHead, segmented, searchBox, priorityBadge, dueChip, fmtDateTime, plural, emptyState, showError, busy, debounce,
} from '../core/ui.js';
import { openReview } from './intake-review.js';
import { incomingCard } from './intake-incoming.js';
import { ACTIONS, actionButtons } from './intake-actions.js';

// The filter controls, by the name a tab definition lists them under. `param` is the query parameter the server reads;
// the URL keeps the value under the control's name. `draw` takes the URL value and the client and project lists.
const FILTERS = {
  client: {
    param: 'client_id',
    draw: (v, { clients }) => html`<select data-filter-client class="auto-w" aria-label="Client"><option value="">All clients</option>
      ${clients.map((c) => html`<option value="${c.id}" ${String(c.id) === v ? raw('selected') : ''}>${c.name}</option>`)}</select>`,
  },
  project: {
    param: 'project_id',
    draw: (v, { projects }) => html`<select data-filter-project class="auto-w" aria-label="Project"><option value="">All projects</option>
      ${projects.map((p) => html`<option value="${p.id}" ${String(p.id) === v ? raw('selected') : ''}>${p.code}</option>`)}</select>`,
  },
  priority: {
    param: 'priority',
    draw: (v) => html`<select data-filter-priority class="auto-w" aria-label="Priority"><option value="">Any priority</option>
      ${state.lookups.priorities.map((p) => html`<option value="${p}" ${p === v ? raw('selected') : ''}>${p}</option>`)}</select>`,
  },
  overdue: {
    param: 'overdue',
    draw: (v) => html`<label class="row" style="gap:6px"><input type="checkbox" data-filter-overdue ${v ? raw('checked') : ''}> Overdue</label>`,
  },
};

const pickable = (s, actions) => actions.some((key) => ACTIONS[key].bulk && s.can[key]);

function groupTable(group, actions) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th class="sel">${group.samples.some((s) => pickable(s, actions)) ? html`<input type="checkbox" data-all aria-label="Select every sample in this group">` : ''}</th><th>Sample</th><th>Client</th><th>Type</th><th>Tests</th><th>Priority</th><th>Due</th><th>Received</th><th>Decision</th></tr></thead>
    <tbody>${group.samples.map((s) => html`<tr data-row="${s.id}">
      <td class="sel">${pickable(s, actions) ? html`<input type="checkbox" data-pick value="${s.id}" aria-label="Select ${s.code}">` : ''}</td>
      <td class="title-cell"><a class="code" href="/samples/${s.id}">${s.code}</a> <strong>${s.description}</strong>
        <span class="sub-line">${[s.batch_no && `Batch ${s.batch_no}`, s.client_ref].filter(Boolean).join(' · ') || ' '}</span>
        <button class="btn sm ghost" data-review="${s.id}" data-code="${s.code}">${icon('eye', { size: 13 })}Review</button></td>
      <td><span title="${s.client_name}">${s.client_code}</span>${s.project_code ? html`<span class="sub-line">${s.project_code}</span>` : ''}</td>
      <td>${s.sample_type || html`<span class="muted">—</span>`}</td>
      <td class="num">${s.test_count}</td>
      <td>${priorityBadge(s.priority) || s.priority}</td>
      <td>${dueChip(s.due_date)}</td>
      <td class="nowrap muted small">${fmtDateTime(s.received_at)}</td>
      <td>${actionButtons(s, actions)}</td>
    </tr>`)}</tbody></table></div>`;
}

function groupCard(group, actions) {
  const sub = group.submission;
  const first = group.samples[0];
  return html`<section class="card" data-group="${sub ? sub.id : 'direct'}">
    <header class="card-head"><div>
      <h2>${sub ? html`<a class="code" href="/portal-inbox/submissions/${sub.id}">${sub.code}</a> · ${first.client_name}` : 'Received at the front desk'}</h2>
      <p class="sub">${sub ? `Client Submission received ${fmtDateTime(sub.received_at)}` : 'Not part of a client Submission'} · ${plural(group.samples.length, 'sample')}</p>
    </div></header>
    ${groupTable(group, actions)}
  </section>`;
}

// How each kind of record the server's tabs list is read from the answer and drawn. A Sample carries the `submission`
// it came in, for the actions that tell the client.
const KINDS = {
  sample: {
    records: (data) => data.groups.flatMap((g) => g.samples.map((s) => ({ ...s, submission: g.submission }))),
    draw: (data, actions) => data.groups.map((g) => groupCard(g, actions)),
  },
  submission: {
    records: (data) => data.submissions,
    draw: (data, actions) => incomingCard(data.submissions, actions),
  },
};

export async function render(ctx) {
  ctx.title('Receiving & Review');
  const [clients, projects] = await Promise.all([api.get('/api/clients'), api.get('/api/projects')]);
  let search = ctx.query.q || '';
  let data;
  let tab; // the server's definition of the tab shown

  ctx.el.innerHTML = String(html`
    ${pageHead({ title: 'Receiving & Review', sub: 'Client Submissions on their way in, and received samples waiting for a decision before their tests can be assigned.', back: { href: '/samples', label: 'Samples' } })}
    <div class="toolbar" data-toolbar></div>
    <div data-outcomes-host></div>
    <div data-list></div>`);

  // Every filter in the URL is sent; the server applies only the ones the tab lists, and so does this screen.
  const query = () => ({
    tab: ctx.query.tab,
    ...Object.fromEntries(Object.entries(FILTERS).map(([name, f]) => [f.param, ctx.query[name]])),
    q: search,
  });
  const filtered = () => search || tab.filters.some((name) => ctx.query[name]);
  // A tab's link keeps only the filters that tab applies, so none carries over to a tab that would ignore it.
  const tabHref = (t) => setQuery({ tab: t.default ? null : t.key, ...Object.fromEntries(Object.keys(FILTERS).filter((name) => !t.filters.includes(name)).map((name) => [name, null])) });

  function drawToolbar() {
    const bar = ctx.el.querySelector('[data-toolbar]');
    bar.innerHTML = String(html`
      ${segmented(data.tabs.map((t) => ({ key: t.key, label: t.label, count: data.counts[t.key], href: tabHref(t) })), tab.key)}
      ${tab.filters.map((name) => FILTERS[name].draw(ctx.query[name], { clients, projects }))}
      ${tab.filters.some((name) => ctx.query[name]) ? html`<a class="btn sm ghost" href="${setQuery(Object.fromEntries(tab.filters.map((name) => [name, null])))}">Clear filters</a>` : ''}
      <span class="spacer"></span>
      ${searchBox(tab.search, search)}`);
    for (const name of tab.filters) {
      bar.querySelector(`[data-filter-${name}]`).addEventListener('change', (e) => navigate(setQuery({ [name]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : null) : e.target.value })));
    }
    const box = bar.querySelector('[data-filter]');
    box.addEventListener('input', debounce(() => {
      search = box.value;
      history.replaceState(null, '', setQuery({ q: search }));
      load({ keepToolbar: true });
    }, 250));
  }

  function drawList() {
    const host = ctx.el.querySelector('[data-list]');
    const kind = KINDS[tab.kind];
    const records = kind.records(data);
    if (!records.length) {
      host.innerHTML = String(emptyState({
        icon: tab.empty.icon,
        title: filtered() ? tab.empty.filtered : tab.empty.title,
        text: filtered() ? 'Clear a filter or the search to see more.' : tab.empty.text,
      }));
      return;
    }
    const bulk = tab.actions.filter((key) => ACTIONS[key].bulk && records.some((r) => r.can[key]));
    host.innerHTML = String(html`
      ${bulk.length ? html`<div class="toolbar">${bulk.map((key) => html`<button class="btn ${ACTIONS[key].primary ? 'primary' : ''}" data-bulk="${key}" disabled>${icon(ACTIONS[key].icon, { size: 15 })}${ACTIONS[key].label} selected</button>`)}
        <button class="btn" data-select-all>Select all shown</button></div>` : ''}
      ${kind.draw(data, tab.actions)}`);
    wireList(host, records);
  }

  function wireList(host, records) {
    const picked = () => [...host.querySelectorAll('[data-pick]:checked')].map((c) => Number(c.value));
    const sync = () => {
      const n = picked().length;
      host.querySelectorAll('[data-bulk]').forEach((b) => {
        const a = ACTIONS[b.dataset.bulk];
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
    const env = { outcomes: ctx.el.querySelector('[data-outcomes-host]'), after };
    const byId = (ids) => ids.map((id) => records.find((r) => r.id === id));
    host.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', () => openReview(Number(b.dataset.review), { onChange: () => load() })));
    host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => busy(b, () => ACTIONS[b.dataset.act].run(byId([Number(b.dataset.id)]), env))));
    host.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => busy(b, () => ACTIONS[b.dataset.bulk].bulk(byId(picked()), env))));
  }

  /** Reload the tab after a change, keeping the filters, and move the sidebar badge. */
  async function after() {
    refreshNav();
    await load();
  }

  async function load({ keepToolbar = false } = {}) {
    try {
      data = await api.get('/api/intake', query());
    } catch (e) {
      // A tab the server does not have (an old link) falls back to the default one.
      if (e.status === 400 && ctx.query.tab && !data) return navigate(setQuery({ tab: null }), { replace: true });
      showError(e);
      return;
    }
    tab = data.tabs.find((t) => t.key === data.tab);
    if (keepToolbar) {
      ctx.el.querySelectorAll('[data-toolbar] .segmented a').forEach((a, i) => {
        a.querySelector('.count').textContent = data.counts[data.tabs[i].key];
      });
    } else {
      drawToolbar();
    }
    drawList();
  }

  await load();
}
