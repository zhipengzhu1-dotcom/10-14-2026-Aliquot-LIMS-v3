// Client portal — a small single-page app for the laboratory's customers. Hash routing (#/samples …)
// because the server falls back to the staff app for unknown paths. All text goes through html``, which
// escapes every interpolated value.

import { html, raw, esc } from '/js/core/html.js';
import { icon } from '/js/core/icons.js';
import { snapshot, settle } from '/js/core/motion.js';
import { FIELDS, PORTAL_FIELDS, gridFromText, guessMapping, remap, withHeader, readSheet, dropRows } from './sheet.js';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

const EXTRA_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  certificate: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h7"/><path d="M14 2v6h6"/><path d="M20 8v3"/><circle cx="17.5" cy="16.5" r="3"/><path d="m16 19-1 3.5 2.5-1 2.5 1-1-3.5"/>',
};
const ic = (name, size = 18) => (EXTRA_ICONS[name]
  ? raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA_ICONS[name]}</svg>`)
  : icon(name, { size }));

const MARK = (size = 32) => raw(`<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect class="sq" width="32" height="32" rx="1"/><path class="ink" d="M12 6.5h8M13.5 6.5v12a2.5 2.5 0 0 0 5 0v-12" fill="none" stroke-width="2.2" stroke-linecap="square"/><path class="fill" d="M13.5 14.5h5v4a2.5 2.5 0 0 1-5 0z"/><rect class="fill" x="14.6" y="24.4" width="2.8" height="2.8"/></svg>`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(v) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  if (Number.isNaN(+d)) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const fmtTime = (v) => { const d = new Date(v); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtDateTime = (v) => (v ? `${fmtDate(v)}, ${fmtTime(v)}` : '—');
function relTime(v) {
  if (!v) return '';
  const s = (Date.now() - Date.parse(v)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(v);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(v);
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return fmtDate(v);
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const initials = (name = '') => name.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

// Per-browser preferences only (theme, remembered lab name for the splash). Never anything sensitive.
const store = {
  read() { try { return JSON.parse(localStorage.getItem('aq.portal') || '{}') || {}; } catch { return {}; } },
  set(patch) { try { localStorage.setItem('aq.portal', JSON.stringify({ ...this.read(), ...patch })); } catch { /* private mode */ } },
};

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  store.set({ theme: theme || 'system' });
}

function toast(message) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = String(html`${ic('check', 16)}<span>${message}</span>`);
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.list) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); } else out[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; } else out[el.name] = el.value;
  }
  return out;
}

/** Disables a form's buttons while a request runs (labelled `busyText` if given) and shows any error in the form's .form-error slot. */
async function submitting(form, fn, busyText) {
  const btn = $('button[type=submit]', form) || $('.js-submit', form.closest('.card') || form);
  const errBox = $('.form-error', form);
  if (errBox) errBox.innerHTML = '';
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = String(html`<span class="spinner"></span>${busyText || btn.textContent.trim()}`); }
  try {
    return await fn();
  } catch (e) {
    if (e.handled) return undefined;
    if (errBox) {
      errBox.innerHTML = String(html`<div class="alert alert-bad" role="alert">${ic('alert', 16)}<span>${e.message}</span></div>`);
      errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else toast(e.message);
    return undefined;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

async function api(path, { method = 'GET', body, file } = {}) {
  const sent = file
    ? { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file }
    : body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: {} };
  let res;
  try {
    res = await fetch(`/api/portal${path}`, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'aliquot', ...sent.headers }, body: sent.body });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw refusal(res.status, data);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const UNREACHABLE = 'We could not reach the laboratory server. Check your connection and try again.';

function refusal(status, data) {
  const err = Object.assign(new Error(data?.error || `Request failed (${status})`), { status, code: data?.code });
  if (err.code === 'PORTAL_AUTH' && state.me) { state.me = null; showSignIn(err.message); err.handled = true; }
  if (err.code === 'PASSWORD_CHANGE_REQUIRED') { showPasswordChange(); err.handled = true; }
  return err;
}

async function postStreamed(path, body, onEvent) {
  let res;
  try {
    res = await fetch(`/api/portal${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'aliquot', 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await res.json().catch(() => null);
    if (!res.ok) throw refusal(res.status, data);
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error(UNREACHABLE);
    }
    buf += decoder.decode(chunk.value, { stream: !chunk.done });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'done') return event;
      if (event.type === 'error') throw refusal(null, event);
      onEvent(event);
    }
    if (chunk.done) throw new Error(UNREACHABLE);
  }
}

const state = { info: null, me: null, lookups: null };
const lookups = async () => (state.lookups ||= await api('/lookups'));

// ---------------------------------------------------------------------------------------------
// Splash: hidden as soon as the first screen is ready. If the progress line has appeared (after 150 ms)
// it stays for at least 400 ms so it never flickers.
// ---------------------------------------------------------------------------------------------

let barShownAt = null;
$('.splash-track')?.addEventListener('animationstart', (e) => { if (e.animationName === 'splash-show') barShownAt = performance.now(); });
function hideSplash() {
  const splash = $('#splash');
  if (!splash || splash.classList.contains('is-done')) return;
  const wait = barShownAt == null ? 0 : Math.max(0, barShownAt + 400 - performance.now());
  setTimeout(() => {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 400);
  }, wait);
}

// ---------------------------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------------------------

const SAMPLE_STAGE = { Received: 1, 'In Testing': 2, 'In Review': 3, Approved: 3, Reported: 4 };
const SAMPLE_LABEL = { Received: 'Received', 'In Testing': 'Testing', 'In Review': 'In review', Approved: 'Finalising', Reported: 'Reported', Cancelled: 'Cancelled', Disposed: 'Closed' };
const SAMPLE_TONE = { Received: 'info', 'In Testing': 'accent', 'In Review': 'accent', Approved: 'accent', Reported: 'ok', Cancelled: 'bad', Disposed: '' };
// A submission's lifecycle as data: what the client reads for each status, whether it is still open, and the reason
// shown when it stopped early. The timeline below ends at Received; after that the samples have their own progress.
const SUBMISSION = {
  Submitted: { label: 'Sent to lab', tone: 'info', open: true },
  Acknowledged: { label: 'Expected', tone: 'accent', open: true },
  Received: { label: 'Received', tone: 'ok' },
  Declined: { label: 'Declined', tone: 'bad', stop: 'The lab declined this shipment.' },
  Withdrawn: { label: 'Withdrawn', tone: '', stop: 'You withdrew this shipment. The lab is not expecting it.' },
};
const SUBMISSION_STEPS = [
  { status: 'Submitted', title: 'Sent to the lab', sub: 'You told us the box is on its way', at: 'created_at' },
  { status: 'Acknowledged', title: 'Lab is expecting it', sub: 'We confirm the shipment and watch for it', at: 'acknowledged_at' },
  { status: 'Received', title: 'Box received', sub: 'Samples are logged and checked in', at: 'received_at' },
];
const REQ_TONE = { Submitted: 'info', 'Under review': 'accent', 'Proposal sent': 'warn', Accepted: 'ok', Declined: 'bad' };

const pill = (label, tone = '') => html`<span class="pill ${tone}">${label}</span>`;
const samplePill = (s) => pill(SAMPLE_LABEL[s] || s, SAMPLE_TONE[s]);
const subPill = (s) => pill(SUBMISSION[s].label, SUBMISSION[s].tone);
const progress = (status) => {
  const n = SAMPLE_STAGE[status] || 0;
  return html`<div class="progress" role="img" aria-label="${`Step ${n} of 4`}">${[1, 2, 3, 4].map((i) => html`<i class="${i <= n ? 'on' : ''}"></i>`)}</div>`;
};
const empty = (iconName, text, action = '') => html`<div class="empty">${ic(iconName, 22)}<div>${text}</div>${action ? html`<div style="margin-top:14px">${action}</div>` : ''}</div>`;

const trustFooter = () => html`<div class="foot-trust">
  <span class="row">${ic('lock', 13)} ${location.protocol === 'https:' ? 'Encrypted connection' : 'Access-controlled'}</span>
  <span class="row">${ic('shield', 13)} Every action recorded in a 21 CFR Part 11 audit trail</span>
  ${state.info?.lab_accreditation ? html`<span>${state.info.lab_accreditation}</span>` : ''}
</div>`;

// ---------------------------------------------------------------------------------------------
// Sign-in and password change
// ---------------------------------------------------------------------------------------------

// Sign-in, first-time password and lockout share one plain card: the client's words, no lab jargon.
function authCard(body) {
  const lab = state.info?.lab_name || 'Client portal';
  app.innerHTML = String(html`<main class="auth">
    <div class="auth-in">
      <div class="auth-brand">${MARK(30)}<span><b>${lab}</b><span class="micro">Client portal</span></span></div>
      <div class="card card-pad auth-card">${body}</div>
      ${trustFooter()}
    </div>
  </main>`);
  hideSplash();
}

const labContact = () => {
  const { lab_phone: phone, lab_email: email } = state.info || {};
  if (!phone && !email) return 'contact the laboratory';
  return html`${phone ? html`call <b class="nowrap">${phone}</b>` : ''}${phone && email ? ' or ' : ''}${email ? html`email <a href="${`mailto:${email}`}">${email}</a>` : ''}`;
};

function showSignIn(message) {
  state.me = null;
  const info = state.info || {};
  document.title = `Sign in · ${info.lab_name || 'Client portal'}`;
  const demo = info.demo ? info.demo_accounts || [] : [];
  authCard(html`
    <h1>Sign in</h1>
    <p class="lead">Use the email the laboratory invited you with.</p>
    ${message ? html`<div class="alert alert-info">${ic('info', 16)}<span>${message}</span></div>` : ''}
    <form id="signin" novalidate>
      <label class="field"><span class="label">Email</span><input class="input" name="email" type="email" inputmode="email" required autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="you@company.com"></label>
      <label class="field"><span class="label">Password</span><input class="input" name="password" type="password" required autocomplete="current-password"></label>
      <div class="form-error"></div>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <p class="help">Forgot your password, or need an account? The lab resets it for you: ${labContact()}.</p>
    ${demo.length ? html`<div class="demo">
      <div class="micro">Demo accounts · password demo1234</div>
      ${demo.map((a) => html`<button type="button" data-demo="${a.email}"><span class="ini">${initials(a.full_name)}</span><span><b>${a.full_name}</b><small>${a.client_name}</small></span></button>`)}
    </div>` : ''}`);
  const form = $('#signin');
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const d = formData(form);
    const errBox = $('.form-error', form);
    if (!d.email.trim() || !d.password) {
      errBox.innerHTML = String(html`<div class="alert alert-bad" role="alert">${ic('alert', 16)}<span>Enter your email and password.</span></div>`);
      (d.email.trim() ? form.password : form.email).focus();
      return;
    }
    busy = true;
    const ok = await submitting(form, async () => {
      try {
        await post('/login', { email: d.email.trim(), password: d.password });
      } catch (err) {
        if (err.status === 423) { showLocked(err.message); err.handled = true; }
        throw err;
      }
      return true;
    }, 'Signing in').finally(() => { busy = false; });
    if (ok) await boot();
    else if (form.isConnected) form.password.select();
  });
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => {
    form.email.value = b.dataset.demo;
    form.password.value = 'demo1234';
    form.requestSubmit();
  }));
  form.email.focus();
}

function showLocked(message) {
  authCard(html`
    <h1>Too many tries</h1>
    <p class="lead">${message}</p>
    <div class="alert alert-warn">${ic('info', 16)}<span>If you cannot remember your password, the laboratory can reset it now: ${labContact()}.</span></div>
    <button class="btn btn-block js-back" type="button">Back to sign in</button>`);
  $('.js-back').addEventListener('click', () => showSignIn());
}

function passwordFields(firstTime) {
  return html`
    <label class="field"><span class="label">${firstTime ? 'Temporary password' : 'Current password'}</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
    <label class="field"><span class="label">New password</span><input class="input" name="next" type="password" autocomplete="new-password" required minlength="8"><div class="hint">At least 8 characters, with both letters and numbers.</div></label>
    <label class="field"><span class="label">Repeat new password</span><input class="input" name="again" type="password" autocomplete="new-password" required></label>`;
}

async function changePassword(form) {
  const d = formData(form);
  if (d.next !== d.again) throw new Error('The two new passwords do not match');
  await post('/password', { current: d.current, next: d.next });
}

function showPasswordChange() {
  document.title = `Choose your password · ${state.info?.lab_name || 'Client portal'}`;
  authCard(html`
    <h1>Choose your password</h1>
    <p class="lead">The temporary password the lab gave you works once. Pick your own to continue.</p>
    <form id="pw" novalidate>
      ${passwordFields(true)}
      <div class="form-error"></div>
      <button class="btn btn-primary btn-block" type="submit">Save and continue</button>
      <button class="btn btn-quiet btn-block js-signout" type="button">Not now, sign out</button>
    </form>`);
  const form = $('#pw');
  form.current.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await submitting(form, async () => { await changePassword(form); return true; }, 'Saving');
    if (ok) { toast('Password saved'); await boot(); }
  });
  $('.js-signout', form).addEventListener('click', signOut);
}

async function signOut() {
  await post('/logout').catch(() => {});
  state.me = null;
  state.lookups = null;
  location.hash = '';
  showSignIn('You have signed out.');
}

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

const NAV = [
  { href: '#/', key: 'overview', label: 'Overview', icon: 'home' },
  { href: '#/samples', key: 'samples', label: 'Samples', icon: 'tube' },
  { href: '#/submit', key: 'submit', label: 'Submit', long: 'Submit samples', icon: 'box' },
  { href: '#/requests', key: 'requests', label: 'Requests', long: 'Method requests', icon: 'method' },
  { href: '#/messages', key: 'messages', label: 'Messages', icon: 'message' },
];

function renderShell() {
  const { me, info } = state;
  app.innerHTML = String(html`
    <header class="top">
      <div class="top-in">
        <a class="brand" href="#/">${MARK(30)}<span class="txt"><span class="name">${info.lab_name}</span><span class="client">${me.client.name}</span></span></a>
        <nav class="nav" aria-label="Main">${NAV.map((n) => html`<a href="${n.href}" data-nav="${n.key}">${n.long || n.label}${n.key === 'messages' ? html` <span class="dot js-unread" hidden></span>` : ''}</a>`)}</nav>
        <div class="me">
          <button class="avatar js-me" aria-haspopup="true" aria-expanded="false" title="${me.user.full_name}">${initials(me.user.full_name)}</button>
          <div class="menu" hidden>
            <div class="who"><div style="font-weight:600">${me.user.full_name}</div><div class="small muted">${me.user.email}</div><div class="small muted">${me.client.name}</div></div>
            <a href="#/account">${ic('user', 16)} Account & security</a>
            <button type="button" class="js-theme">${ic('moon', 16)} Appearance: <span class="js-theme-label"></span></button>
            <button type="button" class="js-signout">${ic('logout', 16)} Sign out</button>
          </div>
        </div>
      </div>
    </header>
    <main class="main" id="main" tabindex="-1"></main>
    <nav class="tabbar" aria-label="Main">${NAV.map((n) => html`<a href="${n.href}" data-nav="${n.key}">${ic(n.icon, 21)}<span>${n.label}</span>${n.key === 'messages' ? html`<span class="dot js-unread" hidden></span>` : ''}</a>`)}</nav>`);
  const btn = $('.js-me');
  const menu = $('.menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  const themes = ['system', 'light', 'dark'];
  const label = () => { $('.js-theme-label').textContent = { system: 'System', light: 'Light', dark: 'Dark' }[store.read().theme || 'system']; };
  label();
  $('.js-theme').addEventListener('click', () => { const cur = store.read().theme || 'system'; applyTheme(themes[(themes.indexOf(cur) + 1) % 3]); label(); });
  $('.js-signout').addEventListener('click', signOut);
}

function setUnread(n) {
  $$('.js-unread').forEach((el) => { el.hidden = !n; el.textContent = n > 9 ? '9+' : String(n); });
}
async function refreshUnread() {
  if (!state.me) return;
  try { setUnread((await api('/threads')).filter((t) => t.unread).length); } catch { /* signed out */ }
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

let routeSeq = 0;
let lastRoute = null;
async function route() {
  if (!state.me) return;
  const { parts, query } = parseHash();
  const [a, b] = parts;
  const seq = ++routeSeq;
  const main = $('#main');
  const navKey = { samples: 'samples', coa: 'samples', submissions: 'samples', submit: 'submit', requests: 'requests', messages: 'messages' }[a] || (a ? '' : 'overview');
  $$('[data-nav]').forEach((el) => (el.dataset.nav === navKey ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current')));
  // Same screen (a tab, a thread, a refresh): no entrance and no jump to the top. Either way the current screen stays
  // until the next is ready; only a wait long enough to notice brings skeletons (new screen) or a dim (same screen).
  const screen = a === 'messages' ? a : `${a || ''}/${b || ''}`;
  const stay = screen === lastRoute && !!main.querySelector(':scope > .view');
  const wait = setTimeout(() => {
    if (seq !== routeSeq) return;
    if (stay) main.querySelector(':scope > .view')?.classList.add('pending');
    else main.innerHTML = String(html`<div class="skeleton" style="height:28px;width:220px"></div><div class="skeleton" style="height:120px;margin-top:24px"></div><div class="skeleton" style="height:240px;margin-top:16px"></div>`);
  }, 162);
  let view;
  try {
    if (!a) view = await overview();
    else if (a === 'samples' && b) view = await sampleDetail(+b);
    else if (a === 'samples') view = await samplesList(query.tab || 'open');
    else if (a === 'coa' && b) view = await coaView(+b);
    else if (a === 'submit') view = await submitView();
    else if (a === 'submissions' && b) view = await submissionDetail(+b, query);
    else if (a === 'requests' && b === 'new') view = await requestForm();
    else if (a === 'requests' && b) view = await requestDetail(+b);
    else if (a === 'requests') view = await requestsList();
    else if (a === 'messages' && b === 'new') view = await messagesView(null, query);
    else if (a === 'messages') view = await messagesView(b ? +b : null, query);
    else if (a === 'account') view = accountView();
    else view = { html: empty('info', 'This page does not exist.', html`<a class="btn" href="#/">Go to overview</a>`) };
  } catch (e) {
    if (e.handled) { clearTimeout(wait); return; }
    view = { html: html`<div class="card card-pad">${empty('alert', e.status === 404 ? 'We could not find that record.' : e.message, html`<a class="btn" href="#/">Back to overview</a>`)}</div>` };
  }
  if (seq !== routeSeq) return;
  clearTimeout(wait);
  const before = snapshot(main.querySelector(':scope > .view'));
  main.innerHTML = String(html`<div class="view">${view.html}${a === 'coa' ? '' : trustFooter()}</div>`);
  lastRoute = screen;
  settle(main.querySelector(':scope > .view'), before, { still: stay });
  document.title = `${view.title ? `${view.title} · ` : ''}${state.info.lab_name}`;
  view.mount?.(main);
  if (!view.keepScroll && !stay) window.scrollTo(0, 0);
  hideSplash();
  if (a !== 'messages') refreshUnread();
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

async function overview() {
  const o = await api('/overview');
  setUnread(o.counts.unread);
  const first = state.me.user.full_name.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').split(' ')[0];
  const stats = [
    { n: o.counts.in_lab, l: 'Samples in the lab', href: '#/samples' },
    { n: o.counts.reported_90d, l: 'Certificates, last 90 days', href: '#/samples?tab=reported' },
    { n: o.counts.submissions_open + o.counts.requests_open, l: 'Open submissions & requests', href: '#/requests' },
    { n: o.counts.unread, l: o.counts.unread === 1 ? 'Unread message' : 'Unread messages', href: '#/messages' },
  ];
  const open = [
    ...o.submissions.map((s) => ({ href: `#/submissions/${s.id}`, code: s.code, title: `Sample shipment · ${plural(s.sample_count, 'sample')}`, status: subPill(s.status), at: s.created_at })),
    ...o.requests.map((r) => ({ href: `#/requests/${r.id}`, code: r.code, title: r.title, status: pill(r.status, REQ_TONE[r.status]), at: r.created_at })),
  ].sort((x, y) => (y.at > x.at ? 1 : -1));
  return {
    title: 'Overview',
    html: html`
      <div class="page-head">
        <div><div class="eyebrow">${state.me.client.name}</div><h1>${greeting()}, ${first}</h1><p class="sub">Here is where your work with ${state.info.lab_name} stands today.</p></div>
      </div>
      <div class="stack-lg">
        <div class="stats">${stats.map((s) => html`<a class="card stat" href="${s.href}"><div class="n">${s.n}</div><div class="l">${s.l}</div></a>`)}</div>
        <div class="quick">
          <a class="card" href="#/submit"><span class="ic">${ic('box', 20)}</span><span><b>Submit samples</b><span>Tell us what is on its way</span></span></a>
          <a class="card" href="#/requests/new"><span class="ic">${ic('flask', 20)}</span><span><b>Request method work</b><span>Development, validation or transfer</span></span></a>
          <a class="card" href="#/messages/new"><span class="ic">${ic('message', 20)}</span><span><b>Message the lab</b><span>Questions go straight to your team</span></span></a>
        </div>
        <div class="cols">
          <div class="stack">
            <section class="card">
              <div class="card-head"><h2>Samples in progress</h2><a class="small" href="#/samples">View all</a></div>
              ${o.inProgress.length ? html`<ul class="list">${o.inProgress.map((s) => html`<li><a class="item item-stack" href="${`#/samples/${s.id}`}">
                <div class="grow"><div class="t ellipsis"><span class="mono">${s.code}</span> · ${s.description}</div><div class="s ellipsis">${[s.batch_no && `Batch ${s.batch_no}`, s.client_ref].filter(Boolean).join(' · ') || '—'}</div></div>
                <div class="end">${progress(s.status)}<div class="progress-label">${SAMPLE_LABEL[s.status]} · due ${fmtDate(s.due_date)}</div></div>
              </a></li>`)}</ul>` : empty('tube', 'No samples in the lab right now.', html`<a class="btn btn-sm" href="#/submit">Submit samples</a>`)}
            </section>
            <section class="card">
              <div class="card-head"><h2>Recently issued certificates</h2><a class="small" href="#/samples?tab=reported">All certificates</a></div>
              ${o.recentCoas.length ? html`<ul class="list">${o.recentCoas.map((s) => html`<li><a class="item" href="${`#/coa/${s.id}`}">
                <span class="coa-ic">${ic('certificate', 18)}</span>
                <div class="grow"><div class="t ellipsis">${s.description}</div><div class="s ellipsis"><span class="mono">${s.code}</span>${s.batch_no ? ` · Batch ${s.batch_no}` : ''}</div></div>
                <div class="end small muted">${fmtDate(s.reported_at)}</div>
              </a></li>`)}</ul>` : empty('certificate', 'Certificates appear here as soon as QA issues them.')}
            </section>
          </div>
          <div class="stack">
            <section class="card">
              <div class="card-head"><h2>Messages</h2><a class="small" href="#/messages">Open inbox</a></div>
              ${o.threads.length ? html`<ul class="list threads">${o.threads.map((t) => html`<li class="${t.unread ? 'unread' : ''}"><a class="item" href="${`#/messages/${t.id}`}">
                <div class="grow"><div class="row"><span class="t grow ellipsis">${t.subject}</span>${t.unread ? html`<span class="udot" aria-label="Unread"></span>` : ''}<span class="tiny faint nowrap">${relTime(t.last_message_at)}</span></div><div class="s ellipsis">${t.last_author}: ${t.excerpt}</div></div>
              </a></li>`)}</ul>` : empty('message', 'No conversations yet.')}
            </section>
            <section class="card">
              <div class="card-head"><h2>Open submissions & requests</h2></div>
              ${open.length ? html`<ul class="list">${open.map((x) => html`<li><a class="item" href="${x.href}"><div class="grow"><div class="t ellipsis">${x.title}</div><div class="s"><span class="mono">${x.code}</span> · ${fmtDate(x.at)}</div></div><div class="end">${x.status}</div></a></li>`)}</ul>` : empty('inbox', 'Nothing open.')}
            </section>
          </div>
        </div>
      </div>`,
  };
}

// ---------------------------------------------------------------------------------------------
// Samples & certificates
// ---------------------------------------------------------------------------------------------

async function samplesList(tab) {
  const isShip = tab === 'shipments';
  const [rows, lk] = await Promise.all([isShip ? api('/submissions') : api(`/samples?status=${encodeURIComponent(tab)}`), lookups()]);
  const tabs = [['open', 'In the lab'], ['reported', 'Reported'], ['all', 'All samples'], ['shipments', 'Shipments']];
  const table = isShip
    ? (rows.length ? html`<div class="table-wrap"><table class="table responsive"><thead><tr><th>Submission</th><th>Samples</th><th>Courier</th><th>Submitted</th><th>Status</th></tr></thead><tbody>
        ${rows.map((s) => html`<tr data-href="${`#/submissions/${s.id}`}" style="cursor:pointer">
          <td><a class="mono" href="${`#/submissions/${s.id}`}">${s.code}</a>${lk.priorityTones[s.priority] ? html` <span class="pill warn plain" style="margin-left:6px">${s.priority}</span>` : ''}</td>
          <td data-label="Samples">${plural(s.sample_count, 'sample')}${s.method_count ? ` · ${plural(s.method_count, 'test')}` : ''}</td>
          <td data-label="Courier">${s.courier || '—'}${s.tracking_no ? html`<div class="tiny muted mono">${s.tracking_no}</div>` : ''}</td>
          <td data-label="Submitted">${fmtDate(s.created_at)}</td>
          <td>${subPill(s.status)}</td></tr>`)}
      </tbody></table></div>` : empty('box', 'No shipments yet.', html`<a class="btn btn-sm" href="#/submit">Submit samples</a>`))
    : (rows.length ? html`<div class="table-wrap"><table class="table responsive"><thead><tr><th>Sample</th><th>Batch / lot</th><th>Your reference</th><th>Progress</th><th>${tab === 'reported' ? 'Reported' : 'Due'}</th><th></th></tr></thead><tbody>
        ${rows.map((s) => html`<tr>
          <td><a href="${`#/samples/${s.id}`}" style="color:inherit"><span class="mono" style="color:var(--accent-text)">${s.code}</span><div class="small muted" style="max-width:340px">${s.description}</div></a></td>
          <td data-label="Batch">${s.batch_no || '—'}</td>
          <td data-label="Ref.">${s.client_ref || '—'}</td>
          <td>${samplePill(s.status)}</td>
          <td data-label="${s.status === 'Reported' ? 'Reported' : 'Due'}" class="nowrap">${fmtDate(s.status === 'Reported' ? s.reported_at : s.due_date)}</td>
          <td class="num">${s.status === 'Reported' ? html`<a class="btn btn-sm" href="${`#/coa/${s.id}`}">${ic('certificate', 15)} CoA</a>` : ''}</td></tr>`)}
      </tbody></table></div>` : empty('tube', tab === 'open' ? 'No samples in the lab right now.' : 'No samples to show.'));
  return {
    title: 'Samples',
    html: html`
      <div class="page-head"><div><div class="eyebrow">${state.me.client.name}</div><h1>Samples</h1><p class="sub">Status of everything we hold for you, and every certificate we have issued.</p></div><a class="btn btn-primary" href="#/submit">${ic('plus', 16)} Submit samples</a></div>
      <div class="seg" role="tablist" style="margin-bottom:16px;max-width:100%;overflow-x:auto">${tabs.map(([k, l]) => html`<a href="${`#/samples?tab=${k}`}" aria-current="${String(k === tab)}">${l}</a>`)}</div>
      <section class="card">${table}</section>`,
    mount(root) { $$('tr[data-href]', root).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; })); },
  };
}

async function sampleDetail(id) {
  const [{ sample: s, tests, submission }, lk] = await Promise.all([api(`/samples/${id}`), lookups()]);
  const stage = SAMPLE_STAGE[s.status] || 0;
  const steps = [['Received', fmtDate(s.received_at)], ['Testing', ''], ['Review', ''], ['Reported', s.reported_at ? fmtDate(s.reported_at) : '']];
  return {
    title: s.code,
    html: html`
      <a class="back" href="#/samples">${ic('arrowLeft', 15)} Samples</a>
      <div class="page-head">
        <div><div class="eyebrow mono">${s.code}</div><h1>${s.description}</h1><p class="sub">${[s.batch_no && `Batch ${s.batch_no}`, s.client_ref && `Your ref. ${s.client_ref}`].filter(Boolean).join(' · ')}</p></div>
        <div class="row">
          <a class="btn" href="${`#/messages/new?sample=${s.id}`}">${ic('message', 16)} Ask about this sample</a>
          ${s.status === 'Reported' ? html`<a class="btn btn-primary" href="${`#/coa/${s.id}`}">${ic('certificate', 16)} Certificate</a>` : ''}
        </div>
      </div>
      <div class="cols">
        <div class="stack">
          <section class="card card-pad">
            <div class="row" style="justify-content:space-between;margin-bottom:18px"><h2>Progress</h2>${samplePill(s.status)}</div>
            <ol class="steps">${steps.map(([l, d], i) => html`<li class="${i + 1 <= stage ? 'done' : ''} ${i + 1 === stage ? 'current' : ''}"><div>${l}</div><div class="tiny faint">${d}</div></li>`)}</ol>
            ${s.status !== 'Reported' && s.due_date ? html`<p class="small muted" style="margin-top:18px">Expected completion <b style="color:var(--ink)">${fmtDate(s.due_date)}</b>${lk.priorityTones[s.priority] ? html` · ${s.priority} turnaround` : ''}</p>` : ''}
          </section>
          <section class="card">
            <div class="card-head"><h2>Tests</h2><span class="small muted">${s.tests_done} of ${s.test_count} complete</span></div>
            ${tests.length ? html`<ul class="list">${tests.map((t) => html`<li class="item"><div class="grow"><div class="t">${t.method_title}</div><div class="s"><span class="mono">${t.method_code} v${t.method_version}</span> · ${t.technique}</div></div><div class="end">${t.status === 'Approved' ? pill('Complete', 'ok') : t.status === 'Pending' ? pill('Queued') : pill('In progress', 'accent')}</div></li>`)}</ul>` : empty('flask', 'Tests will be listed once they are scheduled.')}
          </section>
        </div>
        <section class="card card-pad">
          <h2 style="margin-bottom:16px">Details</h2>
          <dl class="facts">
            <dt>Product code</dt><dd>${s.product_code || '—'}</dd>
            <dt>Stage</dt><dd>${s.stage || '—'}</dd>
            <dt>Sample type</dt><dd>${s.sample_type || '—'}</dd>
            <dt>Received</dt><dd>${fmtDateTime(s.received_at)}</dd>
            <dt>Due</dt><dd>${fmtDate(s.due_date)}</dd>
            <dt>Reported</dt><dd>${fmtDate(s.reported_at)}</dd>
            <dt>Project</dt><dd>${s.project_code ? html`<span class="mono">${s.project_code}</span> ${s.project_title}` : '—'}</dd>
            ${submission ? html`<dt>Shipment</dt><dd><a class="mono" href="${`#/submissions/${submission.id}`}">${submission.code}</a></dd>` : ''}
          </dl>
        </section>
      </div>`,
  };
}

async function coaView(id) {
  const c = await api(`/samples/${id}/coa`);
  const { sample: s, lab } = c;
  const outcome = (o) => (o === 'Pass' ? 'Complies' : o === 'Fail' ? html`<span class="fail">Does not comply</span>` : o === 'Report' ? 'For information' : o);
  return {
    title: `CoA ${s.code}`,
    html: html`
      <div class="coa-bar">
        <a class="back" style="margin:0" href="${`#/samples/${s.id}`}">${ic('arrowLeft', 15)} ${s.code}</a>
        <button class="btn btn-primary js-print" type="button">${ic('printer', 16)} Print or save as PDF</button>
      </div>
      <article class="sheet">
        <div class="lh">
          <div><div class="lab">${lab.lab_name}</div><div class="addr">${lab.lab_address}</div><div class="addr">${[lab.lab_phone, lab.lab_email].filter(Boolean).join(' · ')}</div>${lab.lab_accreditation ? html`<div class="addr">${lab.lab_accreditation}</div>` : ''}</div>
          <div class="ttl"><h1>Certificate of Analysis</h1><div class="no">${s.code}</div></div>
        </div>
        <table class="info"><tbody>
          <tr><td class="k">Client</td><td>${s.client_name}</td><td class="k">Sample ID</td><td class="mono">${s.code}</td></tr>
          <tr><td class="k">Description</td><td>${s.description}</td><td class="k">Batch / lot</td><td>${s.batch_no || '—'}</td></tr>
          <tr><td class="k">Client reference</td><td>${s.client_ref || '—'}</td><td class="k">Sample type</td><td>${s.sample_type || '—'}</td></tr>
          <tr><td class="k">Received</td><td>${fmtDate(s.received_at)}</td><td class="k">Condition</td><td>${s.condition || '—'}</td></tr>
          <tr><td class="k">Project</td><td>${s.project_code || '—'}</td><td class="k">PO number</td><td>${s.po_number || '—'}</td></tr>
          <tr><td class="k">Report date</td><td>${fmtDate(s.reported_at)}</td><td class="k">Quantity</td><td>${s.quantity || '—'}</td></tr>
        </tbody></table>
        ${c.tests.map((t) => html`<div class="res">
          <h3>${t.method_title}</h3>
          <div class="ref">${t.method_code} v${t.method_version}${t.reference ? ` · ${t.reference}` : ''}${t.approved_at ? ` · approved ${fmtDate(t.approved_at)}` : ''}</div>
          <table class="fixed"><thead><tr><th style="width:34%">Test / analyte</th><th style="width:26%">Specification</th><th style="width:22%">Result</th><th>Conclusion</th></tr></thead>
          <tbody>${t.results.map((r) => html`<tr><td class="an">${r.analyte}</td><td data-label="Specification">${r.spec}</td><td data-label="Result" class="num-t">${r.result}</td><td data-label="Conclusion">${outcome(r.outcome)}</td></tr>`)}</tbody></table>
        </div>`)}
        <div class="conclusion"><b>Conclusion:</b> ${c.complies ? 'The sample complies with the specifications listed above.' : 'One or more results do not comply with the specification. See results above.'}</div>
        ${lab.coa_statement ? html`<p class="stmt">${lab.coa_statement}</p>` : ''}
        <div class="sigs">
          <div class="sig"><div class="k">Performed by</div><div>${c.performed_by.join(', ') || '—'}</div></div>
          <div class="sig"><div class="k">Reviewed by</div><div>${c.reviewed_by.join(', ') || '—'}</div></div>
          <div class="sig"><div class="k">Approved & issued by (QA)</div><div>${c.issued?.full_name || '—'}</div><div class="k">${c.issued ? fmtDateTime(c.issued.signed_at) : ''}</div></div>
        </div>
        <div class="foot"><span>This certificate was electronically signed in accordance with 21 CFR Part 11.</span><span>${s.code}</span></div>
      </article>`,
    mount(root) { $('.js-print', root).addEventListener('click', () => window.print()); },
  };
}

// ---------------------------------------------------------------------------------------------
// Sample submission
// ---------------------------------------------------------------------------------------------

const MAX_SAMPLES = 200;
const USE_LABEL = { extra: 'Keep as extra detail', ignore: 'Ignore' };

/** One line per column of the client's sheet: its heading, two of its values, and what we read it as. */
function mapPanel(grid, mapping) {
  const body = grid.slice(mapping.header ? 1 : 0);
  return html`<div class="map">
    <label class="map-header"><input type="checkbox" class="js-header" ${mapping.header ? raw('checked') : ''}> First row is column headings</label>
    <div class="map-cols">${mapping.columns.map((c, i) => html`<label class="map-col ${c.use === 'ignore' ? 'is-ignored' : ''}">
      <span class="map-head">${c.label}</span>
      <span class="map-eg">${body.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ') || 'empty'}</span>
      <select class="select js-use" data-col="${i}" aria-label="${`What ${c.label} is`}">
        ${PORTAL_FIELDS.map((k) => html`<option value="${k}" ${c.use === k ? raw('selected') : ''}>${FIELDS[k].label}</option>`)}
        ${Object.entries(USE_LABEL).map(([k, l]) => html`<option value="${k}" ${c.use === k ? raw('selected') : ''}>${l}</option>`)}
      </select></label>`)}</div>
  </div>`;
}

/** A .csv is read here; an .xlsx is read by the server, which already reads workbooks for the notebook. */
async function sheetsFromFile(file) {
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  // The server drops the connection on a body over its limit, which fetch reports as an unreachable server.
  if (ext === 'xlsx' && file.size > 2 * 1024 * 1024) throw new Error('That workbook is larger than 2 MB. Save just the sample rows to a new file, or paste them.');
  if (ext === 'xlsx') return (await api('/sheets', { method: 'POST', file })).sheets;
  if (ext !== 'csv') throw new Error('Upload an .xlsx or .csv file. Save other spreadsheets as one of those first, or paste the rows.');
  const bytes = await file.arrayBuffer();
  let text;
  // Excel on Windows saves "CSV" in the Windows-1252 code page unless told to use UTF-8.
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  return [{ name: file.name, rows: gridFromText(text, 'csv'), truncated: false }];
}

/** The paste preview: every parsed row, with problem cells highlighted with their message. */
function pastePreview(rows, mapping, { fit }) {
  if (!rows.length) return '';
  const cols = mapping.columns.map((c) => c.use).filter((use) => FIELDS[use]).map((k) => [k, FIELDS[k].label]);
  const extra = rows.some((r) => r.details.length);
  const flagged = rows.filter((r) => Object.keys(r.problems).length).length;
  return html`
    <p class="paste-sum"><b>${plural(rows.length, 'sample')}</b> found${flagged ? html` · <span class="bad-text">${plural(flagged, 'row needs', 'rows need')} a look</span>` : ' · all look good'}${mapping.header ? '' : ' · no heading row, read as your usual column order'}</p>
    ${rows.length > fit ? html`<div class="alert alert-warn">${ic('alert', 16)}<span>Only ${plural(fit, 'more sample fits', 'more samples fit')} in this submission (${MAX_SAMPLES} at most). The rest stay here to send next time.</span></div>` : ''}
    <div class="table-wrap paste-table"><table class="table"><thead><tr><th>#</th>${cols.map(([, l]) => html`<th>${l}</th>`)}${extra ? html`<th>Extra detail</th>` : ''}</tr></thead>
      <tbody>${rows.map((r, i) => html`<tr><td class="muted">${i + 1}</td>${cols.map(([k]) => html`<td class="${r.problems[k] ? 'cell-bad' : ''}">${r[k] || (r.problems[k] ? '' : '—')}${r.problems[k] ? html`<div class="cell-why">${r.problems[k]}</div>` : ''}</td>`)}${extra ? html`<td class="cell-extra">${r.details.map((d) => html`<div><b>${d.label}</b> ${d.value}</div>`)}</td>` : ''}</tr>`)}</tbody>
    </table></div>`;
}

// The submission desk: a conversation with the assistant on the left, the draft it fills on the right. The draft is the
// submission body, every value marked with where it came from. The client can edit any of it by hand, with the
// assistant or without it, and only the client sends it.

/** Where a value came from: what each source is called and what it means. Checked and guessed never look alike. */
const SOURCES = {
  client: { tag: 'from you', help: 'Taken from what you wrote' },
  sheet: { tag: 'from sheet', help: 'Taken from your spreadsheet' },
  guessed: { tag: 'guessed', help: 'The assistant guessed this. Check it.' },
  fixed: { tag: 'fixed', help: 'Changed by an automatic check' },
  default: { tag: 'default', help: 'The portal default' },
  edited: { tag: 'you edited', help: 'You set or confirmed this' },
};
// The form asks for samples only. What the assistant drafts for the rest of the submission is dropped here, since
// the client has no field to check or change it.
const SHIPMENT_KEYS = ['project_id', 'sample_type', 'priority', 'storage', 'courier', 'tracking_no', 'ship_date', 'notes', 'method_ids'];
const ROW_FIELDS = [
  ['description', 'Sample description', 'text'], ['stage', 'Type', 'stages'], ['priority', 'TAT', 'tiers'], ['batch_no', 'Lot number', 'text'],
  ['product_code', 'Product code', 'text'], ['tests_requested', 'Tests requested', 'text'], ['limits', 'Limits', 'text'],
  ['quantity', 'Quantity', 'text'], ['client_ref', 'Your reference', 'text'], ['container', 'Container', 'text'],
];
// The form shows the columns of the lab's Sample Submission Log, in its order. The last three fields are not in the log:
// a spreadsheet or the assistant can still fill them and the lab sees them, but the form does not ask for them.
// The description leads, and stays in view while the other columns scroll sideways inside the table.
const TABLE_FIELDS = ROW_FIELDS.slice(0, 7);
/** The log's columns, then any of the other fields that a spreadsheet or the assistant filled in, so a problem with one can be fixed. */
const fieldsOf = (samples) => ROW_FIELDS.filter(([k]) => TABLE_FIELDS.some(([t]) => t === k) || samples.some((r) => r[k]));
const TABLE_MIN = 560;
const GREETING = 'Paste the shipping email or packing list, or attach your spreadsheet. I fill in the submission and mark what I checked and what I guessed. Nothing goes to the lab until you press Send to lab.';

// A row's id says which sample it is when the assistant adds, drops or reorders rows; it never reaches the lab. The
// browser and the server both take new ids from the draft's next_row and only count up, so no id comes back.
const blankRow = (id) => ({ id, description: null, product_code: null, batch_no: null, client_ref: null, quantity: null, container: null, stage: null, priority: null, tests_requested: null, limits: null, details: [] });
const blankDraft = (lk) => ({
  project_id: null, sample_type: null, priority: lk.defaultPriority, storage: null, courier: null, tracking_no: null, ship_date: null, notes: null,
  method_ids: [], samples: [blankRow('r1')], next_row: 2, provenance: { priority: { source: 'default' } }, questions: [],
});
/** The draft with everything but its samples as a blank draft has it. */
function samplesOnly(draft) {
  const blank = blankDraft(desk.lk);
  const provenance = Object.fromEntries(Object.entries(draft.provenance).filter(([path]) => !SHIPMENT_KEYS.includes(path)));
  return { ...draft, ...Object.fromEntries(SHIPMENT_KEYS.map((k) => [k, blank[k]])), provenance: { ...provenance, ...blank.provenance } };
}
const getAt = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
function setAt(o, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = value;
}
const bodyOf = ({ provenance, questions, next_row, ...body }) => ({ ...body, samples: body.samples.map(({ id, ...row }) => row) });
const fid = (path) => `d-${path.replace(/\./g, '-')}`;
const choiceLabel = (models, model, effort) => `${models.find((m) => m.id === model)?.label ?? model} · ${effort} effort`;

// The conversation and draft in progress, kept while the client moves around the portal and dropped once sent.
let desk = null;

function newDesk(lk, assistant) {
  return {
    lk, assistant, draft: blankDraft(lk), gate: null, checking: false, busy: false, partial: '', tab: 'chat', table: false, declined: [],
    choice: assistant.enabled ? { model: assistant.model, effort: assistant.effort } : null,
    messages: assistant.enabled ? [{ role: 'assistant', text: GREETING }] : [],
  };
}

/** An id no row of this conversation had. */
function newRow() {
  return blankRow(`r${desk.draft.next_row++}`);
}

const problemAt = (path) => desk.gate?.problems.find((p) => p.path === path);

function provClass(path) {
  const p = desk.draft.provenance[path];
  return [problemAt(path) ? 'p-ask' : '', p ? `p-${p.source}` : ''].filter(Boolean).join(' ');
}

function provTag(path) {
  const problem = problemAt(path);
  if (problem) return html`<span class="ptag ask" title="${problem.message}">needs you</span>`;
  const p = desk.draft.provenance[path];
  if (!p) return '';
  return html`<span class="ptag ${p.source}" title="${p.reason || SOURCES[p.source].help}">${SOURCES[p.source].tag}</span>`;
}

function control(path, kind, label) {
  const lk = desk.lk;
  const v = getAt(desk.draft, path);
  const id = fid(path);
  const lists = {
    stages: [['', 'Choose'], ...lk.stages.map((t) => [t, t])],
    tiers: [['', `As shipment (${desk.draft.priority})`], ...lk.priorities.map((t) => [t, t])],
  }[kind];
  if (lists) {
    const value = v == null ? '' : String(v);
    const options = lists.some(([o]) => o === value) ? lists : [...lists, [value, value]];
    return html`<select class="select" id="${id}" data-path="${path}" aria-label="${label}">${options.map(([o, l]) => html`<option value="${o}" ${o === value ? raw('selected') : ''}>${l}</option>`)}</select>`;
  }
  return html`<input class="input" id="${id}" data-path="${path}" type="text" value="${v ?? ''}" aria-label="${label}">`;
}

const fieldBox = (path, label, kind) => html`<div class="as-f ${provClass(path)}" data-field="${path}">
  <label class="as-lab" for="${fid(path)}"><span>${label}</span><span class="js-tag">${provTag(path)}</span></label>${control(path, kind, label)}</div>`;

const details = (row) => (row.details?.length ? html`<p class="srow-extra"><span class="micro">Extra detail</span> ${row.details.map((d, i) => html`${i ? ' · ' : ''}<b>${d.label}</b> ${d.value}`)}</p>` : '');

function samplesTable(d) {
  return html`<div class="table-wrap as-tbl"><table class="table"><thead><tr><th>#</th>${fieldsOf(d.samples).map(([, l]) => html`<th>${l}</th>`)}<th><span class="sr-only">Remove</span></th></tr></thead>
    <tbody>${d.samples.map((row, i) => html`<tr>
      <td class="muted">${i + 1}</td>
      ${fieldsOf(d.samples).map(([k, l, kind]) => {
        const path = `samples.${i}.${k}`;
        const p = d.provenance[path];
        const problem = problemAt(path);
        return html`<td class="as-f ${provClass(path)}" data-field="${path}" title="${problem?.message ?? (p ? `${SOURCES[p.source].tag}: ${p.reason || SOURCES[p.source].help}` : '')}">${control(path, kind, `${l}, sample ${i + 1}`)}${k === 'description' ? details(row) : ''}</td>`;
      })}
      <td><button class="btn btn-quiet btn-sm" type="button" data-remove="${i}" aria-label="${`Remove sample ${i + 1}`}" ${desk.busy ? raw('disabled') : ''}>${ic('x', 15)}</button></td>
    </tr>`)}</tbody></table></div>`;
}

function samplesCards(d) {
  return html`<ol class="as-samples">${d.samples.map((row, i) => html`<li class="as-sample">
    <div class="as-sample-head"><span class="as-idx">${i + 1}</span><span class="t">${[row.description, row.batch_no].filter(Boolean).join(' · ') || 'New sample'}</span>
      <button class="btn btn-quiet btn-sm" type="button" data-remove="${i}" aria-label="${`Remove sample ${i + 1}`}" ${desk.busy ? raw('disabled') : ''}>Remove</button></div>
    <div class="as-grid">${fieldsOf(d.samples).map(([k, l, kind]) => fieldBox(`samples.${i}.${k}`, l, kind))}</div>${details(row)}</li>`)}</ol>`;
}

/** What stops Send to lab, in plain words: the gate's problems, then the guesses that change handling. */
function blockers() {
  if (!desk.gate) return ['the checks have not run yet'];
  return [
    ...desk.gate.problems.map((p) => p.message),
    ...(desk.checking ? ['checking your changes'] : []),
    ...(desk.busy ? ['the assistant is still drafting'] : []),
  ];
}

function formHtml() {
  const d = desk.draft;
  return html`<section class="card as-form" aria-label="Submission draft">
    <div class="card-head"><h2>Submission draft</h2><span class="micro faint">Edit anything</span></div>
    <div class="slip-sec"><h2><span class="step-n">01</span>Samples <span class="micro faint">${d.samples.length} of ${MAX_SAMPLES} max</span></h2>
      ${desk.table ? samplesTable(d) : samplesCards(d)}
      <div class="row wrap" style="margin-top:10px"><button class="btn btn-sm" type="button" data-add ${d.samples.length >= MAX_SAMPLES || desk.busy ? raw('disabled') : ''}>${ic('plus', 15)} Add a sample</button>
        <button class="linkish js-paste" type="button">Add from a spreadsheet</button></div></div>
    <div class="as-legend"><span class="micro">Key</span>${Object.entries(SOURCES).map(([k, s]) => html`<span class="ptag ${k}" title="${s.help}">${s.tag}</span>`)}<span class="ptag ask">needs you</span></div>
  </section>`;
}

function sendHtml() {
  const d = desk.draft;
  const named = d.samples.filter((r) => r.description).length;
  const block = blockers();
  const soft = Object.entries(d.provenance).filter(([, v]) => v.source === 'guessed').length;
  return html`<div class="send-bar as-send">
    <div class="count"><b>${plural(named, 'sample')}</b>
      <span class="as-hint ${block.length ? 'block' : ''}">${block.length ? `Not ready to send. Still needed: ${block.join('; ')}.` : 'Ready. The lab sees it once you send.'}</span>
      ${soft ? html`<span class="as-hint">${plural(soft, 'other guess', 'other guesses')} unconfirmed. ${soft === 1 ? 'It does' : 'They do'} not hold up sending.</span>` : ''}</div>
    <div class="form-error"></div>
    <button class="btn btn-primary js-send" type="button" ${block.length || desk.sending ? raw('disabled') : ''}>${ic('send', 16)} Send to lab</button>
  </div>`;
}

function messageHtml(m, i) {
  if (m.role === 'note') return html`<div class="msg system"><div class="bubble">${m.text}</div></div>`;
  if (m.role === 'client') return html`<div class="msg client"><div class="meta">You</div><div class="bubble">${m.text}</div></div>`;
  return html`<div class="msg lab as-reply"><div class="meta">Assistant${m.meta ? html` · <span class="js-answered-by">${m.meta}</span>` : ''}</div><div class="bubble"><span class="as-text">${m.text}</span>
    ${m.unresolved?.length ? html`<div class="as-q"><b>Still open after ${plural(m.attempts, 'try', 'tries')}:</b> ${m.unresolved.map((p) => p.message).join('; ')}</div>` : ''}
    ${(m.questions ?? []).map((q, qi) => html`<div class="as-q"><b>${q.text}</b>${q.options.length ? html`<div class="as-choices">${q.options.map((o, oi) => html`<button class="as-choice" type="button" data-answer="${`${i}:${qi}:${oi}`}" data-value="${o}" ${q.answered || q.retired || desk.busy ? raw('disabled') : ''} aria-pressed="${String(q.answered === o)}">${o}</button>`)}</div>` : ''}${q.retired ? html`<div class="small muted as-retired">${q.retired}</div>` : ''}</div>`)}</div></div>`;
}

function chatHtml() {
  const a = desk.assistant;
  const head = html`<div class="card-head as-chat-head"><h2>Assistant</h2>
    ${a.enabled ? html`<select class="select as-pick js-pick" aria-label="Model and effort">${a.choices.models.flatMap((m) => a.choices.efforts.map((e) => html`<option value="${`${m.id}|${e}`}" ${m.id === desk.choice.model && e === desk.choice.effort ? raw('selected') : ''}>${choiceLabel(a.choices.models, m.id, e)}</option>`))}</select>` : ''}
    <span class="micro faint">Drafts only. Never sends.</span></div>`;
  if (!a.enabled) {
    return html`<section class="card as-chat">${head}<div class="msgs as-thread"><div class="as-off">${ic('info', 18)}<div><b>${a.error ? 'The assistant could not be reached.' : 'The assistant is off.'}</b>
      <p>${a.error ?? 'Your lab has not turned it on.'} Fill in the submission by hand. It is checked the same way, and you can attach a spreadsheet.</p></div></div></div></section>`;
  }
  return html`<section class="card as-chat">${head}
    <div class="msgs as-thread js-thread" aria-live="polite">${desk.messages.map(messageHtml)}${desk.busy ? html`<div class="msg lab as-live"><div class="meta">Assistant</div><div class="bubble"><span class="as-text js-partial" aria-live="off">${desk.partial}</span><span class="as-typing" aria-label="The assistant is drafting"><i></i><i></i><i></i></span></div></div>` : ''}</div>
    <form class="as-composer js-composer">
      <label class="sr-only" for="as-message">Message</label>
      <textarea class="textarea" id="as-message" name="message" placeholder="Paste an email or describe the shipment. For example: 3 lots of Paracetamol 500mg for assay, shipping Tuesday by FedEx." ${desk.busy ? raw('disabled') : ''}></textarea>
      <div class="row wrap"><button class="btn btn-sm js-paste" type="button">${ic('upload', 15)} Attach spreadsheet</button><span class="small muted as-kbd">Ctrl+Enter sends</span>
        <button class="btn btn-primary btn-sm" type="submit" ${desk.busy ? raw('disabled') : ''}>Send message</button></div>
    </form></section>`;
}

const pasteHtml = () => html`<section class="card as-paste paste" hidden aria-label="Add from a spreadsheet">
  <div class="card-head"><h2>Add from a spreadsheet</h2><button class="btn btn-quiet btn-sm js-paste-close" type="button">Close</button></div>
  <div class="card-pad">
    <label class="field"><span class="label">Paste rows from Excel or Google Sheets</span><textarea class="textarea js-paste-text" rows="4" placeholder="Copy the rows, header row included, and paste them here"></textarea></label>
    <div class="row wrap paste-file"><label class="btn btn-sm">${ic('upload', 15)} Upload .xlsx or .csv<input class="js-file" type="file" accept=".xlsx,.csv" hidden></label><span class="small muted js-file-name"></span></div>
    <p class="slip-sub">We match your columns to ours and show what we found below; change any that are wrong. Columns we have no place for are kept as extra detail for the lab.</p>
    <div class="js-sheet-pick"></div><div class="js-map"></div><div class="js-preview" role="status"></div><p class="help js-paste-note" role="status"></p>
    <button class="btn btn-sm btn-primary js-paste-add" type="button" hidden></button>
  </div></section>`;

async function submitView() {
  const lk = await lookups();
  let assistant;
  try {
    assistant = await api('/assistant');
  } catch (e) {
    if (e.handled) throw e;
    assistant = { enabled: false, error: e.message };
  }
  if (!desk) desk = newDesk(lk, assistant);
  desk.lk = lk;
  desk.assistant = assistant;
  if (assistant.enabled && !desk.choice) desk.choice = { model: assistant.model, effort: assistant.effort };
  if (!assistant.enabled) desk.tab = 'draft';
  return {
    title: 'Submit samples',
    html: html`<div class="page-head"><div><div class="eyebrow">New shipment</div><h1>Tell us what is coming</h1>
        <p class="sub">${assistant.enabled ? 'Paste the email, a packing list or a spreadsheet. The assistant fills in the submission as you talk. You review it and send it.' : 'Fill in what you are sending. Only the sample names are required.'} Nothing reaches the lab until you press Send to lab.</p></div></div>
      <div class="as-desk" data-tab="${desk.tab}">
        <div class="as-tabs" role="group" aria-label="View"><button type="button" data-tab="chat">Conversation</button><button type="button" data-tab="draft">Submission <span class="as-count js-count" hidden></span></button></div>
        <div class="as-chat-col js-chat"></div>
        <div class="as-draft-col"><div class="js-form"></div>${pasteHtml()}<div class="js-sendbar"></div></div>
      </div>`,
    mount: mountDesk,
  };
}

function mountDesk(root) {
  const $in = (sel) => $(sel, root);
  const deskEl = $in('.as-desk');
  const draftCol = $in('.as-draft-col');
  let timer = null;
  let seq = 0;

  const renderTabs = () => {
    deskEl.dataset.tab = desk.tab;
    $$('.as-tabs [data-tab]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === desk.tab)));
    const n = blockers().length;
    const count = $in('.js-count');
    count.hidden = !n || !desk.gate;
    count.textContent = n;
  };
  const renderChat = () => {
    $in('.js-chat').innerHTML = String(chatHtml());
    const thread = $in('.js-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  };
  const renderChecks = () => {
    $in('.js-sendbar').innerHTML = String(sendHtml());
    $$('[data-field]', root).forEach((el) => {
      const path = el.dataset.field;
      el.className = `as-f ${provClass(path)}`;
      const tag = $('.js-tag', el);
      if (tag) tag.innerHTML = String(provTag(path));
    });
    renderTabs();
  };
  const renderDraft = () => {
    const active = draftCol.contains(document.activeElement) ? document.activeElement : null;
    const caret = ['text', 'textarea'].includes(active?.type) ? [active.selectionStart, active.selectionEnd] : null;
    desk.table = draftCol.clientWidth >= TABLE_MIN;
    $in('.js-form').innerHTML = String(formHtml());
    renderChecks();
    const el = active?.id && document.getElementById(active.id);
    if (el) {
      el.focus();
      if (caret) el.setSelectionRange(...caret);
    }
  };
  // Every change runs the same checks the lab runs on a submission, without saving anything.
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const gate = await post('/submissions/check', bodyOf(desk.draft));
        if (mine === seq) Object.assign(desk, { gate, checking: false });
      } catch (e) {
        if (e.handled || mine !== seq) return;
        Object.assign(desk, { gate: null, checking: false });
      }
      if (root.isConnected) renderChecks();
    }, 250);
  };
  const changed = ({ structure = false } = {}) => {
    desk.checking = true;
    if (structure) renderDraft();
    else renderChecks();
    check();
  };
  const mark = (path, source, reason) => {
    desk.draft.provenance[path] = { source, ...(reason ? { reason } : {}) };
    desk.touched?.add(path);
  };
  // The draft stays editable while the assistant drafts, with its rows fixed. What the client changed in that time keeps
  // the client's value and provenance over the reply's, on the same row by id wherever the reply put it.
  const keepTouched = (reply) => {
    for (const path of desk.touched) {
      const m = /^samples\.(\d+)\.(\w+)$/.exec(path);
      let at = path;
      if (m) {
        const mine = desk.draft.samples[Number(m[1])];
        let i = reply.samples.findIndex((r) => r.id === mine.id);
        if (i < 0) {
          i = reply.samples.push(structuredClone(mine)) - 1;
          for (const [p, v] of Object.entries(desk.draft.provenance)) if (p.startsWith(`samples.${m[1]}.`)) reply.provenance[p.replace(/^samples\.\d+/, `samples.${i}`)] = v;
        }
        at = `samples.${i}.${m[2]}`;
      }
      setAt(reply, at, structuredClone(getAt(desk.draft, path)));
      reply.provenance[at] = desk.draft.provenance[path];
    }
    return reply;
  };

  renderChat();
  renderDraft();
  check();
  new ResizeObserver(() => {
    if (!root.contains(draftCol)) return;
    const wide = draftCol.clientWidth >= TABLE_MIN;
    if (draftCol.clientWidth && wide !== desk.table) renderDraft();
  }).observe(draftCol);

  const history = () => desk.messages.filter((m) => m.role === 'client' || m.role === 'assistant').map((m) => ({ role: m.role, text: m.text }));
  async function ask(text) {
    if (desk.busy || !text.trim()) return;
    const before = history();
    desk.messages.push({ role: 'client', text });
    desk.busy = true;
    desk.partial = '';
    desk.touched = new Set();
    renderChat();
    renderDraft();
    const showPartialReply = (event) => {
      if (event.type !== 'reply') return;
      desk.partial = event.text;
      const partial = $in('.js-partial');
      if (!partial) return;
      partial.textContent = event.text;
      const thread = $in('.js-thread');
      thread.scrollTop = thread.scrollHeight;
    };
    try {
      const res = await postStreamed('/assistant', { message: text, draft: desk.draft, history: before, declined: desk.declined, ...desk.choice }, showPartialReply);
      const editedMeanwhile = desk.touched.size > 0;
      desk.draft = samplesOnly(keepTouched(res.draft));
      // A proposal belongs to the turn that asked it; the new reply asks again whatever is still open.
      for (const q of desk.messages.flatMap((msg) => msg.questions ?? [])) if (q.proposal && !q.answered) q.retired = 'Replaced by the newer reply.';
      desk.gate = editedMeanwhile ? null : res.gate;
      desk.messages.push({
        role: 'assistant', text: res.reply, questions: res.draft.questions.filter((q) => !SHIPMENT_KEYS.includes(q.path)), attempts: res.attempts, unresolved: res.unresolved,
        meta: `${res.model_label} · ${res.effort} effort · ${(res.ms / 1000).toFixed(1)} s${res.attempts > 1 ? ` · ${res.attempts} tries` : ''}`,
      });
      check();
    } catch (e) {
      if (e.handled) return;
      desk.messages.push({ role: 'note', text: `${e.message} You can keep filling in the submission by hand.` });
    } finally {
      desk.busy = false;
      desk.touched = null;
      if (root.isConnected) {
        renderChat();
        renderDraft();
        if (!draftCol.contains(document.activeElement)) $in('#as-message')?.focus();
      }
    }
  }

  $in('.js-chat').addEventListener('submit', (e) => {
    e.preventDefault();
    const box = $in('#as-message');
    const text = box.value;
    box.value = '';
    ask(text);
  });
  $in('.js-chat').addEventListener('keydown', (e) => {
    if (e.target.id === 'as-message' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $in('.js-composer').requestSubmit();
  });
  $in('.js-chat').addEventListener('change', (e) => {
    if (!e.target.matches('.js-pick')) return;
    const [model, effort] = e.target.value.split('|');
    desk.choice = { model, effort };
  });
  $in('.js-chat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-answer]');
    if (!b || b.disabled || desk.busy) return;
    const [mi, qi, oi] = b.dataset.answer.split(':').map(Number);
    const q = desk.messages[mi].questions[qi];
    if (q.answered || q.retired) return;
    if (!q.proposal) {
      q.answered = b.dataset.value;
      ask(b.dataset.value);
      return;
    }
    // A change to a value the client set is theirs to take or turn down, here, without another turn of the model.
    const { row, field, value } = q.proposal;
    const i = row ? desk.draft.samples.findIndex((r) => r.id === row) : -1;
    if (row && i < 0) {
      q.retired = 'That sample is no longer in the draft.';
      renderChat();
      return;
    }
    q.answered = b.dataset.value;
    const path = row ? `samples.${i}.${field}` : field;
    if (oi === 0) {
      setAt(desk.draft, path, structuredClone(value));
      mark(path, 'edited', 'You took the assistant’s suggestion.');
    } else {
      desk.declined.push(q.proposal);
    }
    renderChat();
    changed({ structure: true });
  });
  $in('.as-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { desk.tab = b.dataset.tab; renderTabs(); }
  });

  const setValue = (el) => {
    const path = el.dataset.path;
    const value = el.value.trim() ? el.value.trim() : null;
    setAt(desk.draft, path, path === 'project_id' && value ? Number(value) : value);
    mark(path, 'edited');
  };
  draftCol.addEventListener('input', (e) => {
    if (!e.target.dataset.path || e.target.tagName === 'SELECT') return;
    setValue(e.target);
    changed();
  });
  // Text fields are already recorded on input. Their change fires on blur, often from the click on Send to lab, and
  // re-checking then would redraw the send bar under that click (#29).
  draftCol.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.path && el.tagName === 'SELECT') {
      setValue(el);
      changed({ structure: el.dataset.path === 'priority' });
    }
  });
  draftCol.addEventListener('click', async (e) => {
    const d = desk.draft;
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const i = Number(remove.dataset.remove);
      d.samples.splice(i, 1);
      if (!d.samples.length) d.samples.push(newRow());
      d.provenance = Object.fromEntries(Object.entries(d.provenance).flatMap(([path, p]) => {
        const m = /^samples\.(\d+)\.(.+)$/.exec(path);
        if (!m) return [[path, p]];
        const n = Number(m[1]);
        return n === i ? [] : [[`samples.${n > i ? n - 1 : n}.${m[2]}`, p]];
      }));
      changed({ structure: true });
      return;
    }
    if (e.target.closest('[data-add]')) {
      d.samples.push(newRow());
      changed({ structure: true });
      $(`#${fid(`samples.${d.samples.length - 1}.description`)}`, root)?.focus();
      return;
    }
    if (e.target.closest('.js-send')) {
      const btn = e.target.closest('.js-send');
      if (blockers().length || desk.sending) return;
      desk.sending = true;
      btn.disabled = true;
      try {
        const res = await post('/submissions', bodyOf(d));
        desk = null;
        location.hash = `#/submissions/${res.id}?sent=1`;
      } catch (err) {
        if (err.handled) return;
        $in('.js-sendbar .form-error').innerHTML = String(html`<div class="alert alert-bad" role="alert">${ic('alert', 16)}<span>${err.message}</span></div>`);
        desk.sending = false;
        if (btn.isConnected) btn.disabled = false;
      }
    }
  });

  // Spreadsheets are read here and on the server as before; their rows join the draft marked "from sheet".
  const panel = $in('.as-paste');
  const box = $('.js-paste-text', panel);
  let sheet = null;
  let book = [];
  let fileName = 'pasted rows';
  const blank = (r) => !ROW_FIELDS.some(([k]) => r[k]) && !r.details?.length;
  const preview = () => {
    if (sheet) {
      sheet.rows = readSheet(sheet.grid, sheet.mapping).rows;
    }
    const rows = sheet?.rows ?? [];
    const fit = MAX_SAMPLES - desk.draft.samples.filter((r) => !blank(r)).length;
    $('.js-map', panel).innerHTML = sheet ? String(mapPanel(sheet.grid, sheet.mapping)) : '';
    $('.js-preview', panel).innerHTML = sheet ? String(pastePreview(rows, sheet.mapping, { fit })) : '';
    const add = $('.js-paste-add', panel);
    const n = Math.min(rows.length, fit);
    add.hidden = n === 0;
    add.textContent = `Add ${plural(n, 'sample')}`;
    $('.js-paste-note', panel).textContent = '';
  };
  const load = (grid) => {
    sheet = grid.length ? { grid, mapping: guessMapping(grid, PORTAL_FIELDS) } : null;
    preview();
  };
  const loadBook = (sheets, pick = 0) => {
    book = sheets;
    $('.js-sheet-pick', panel).innerHTML = sheets.length > 1 ? String(html`<label class="field"><span class="label">Sheet</span><select class="select js-sheet">${sheets.map((x, i) => html`<option value="${i}" ${i === pick ? raw('selected') : ''}>${x.name}</option>`)}</select></label>`) : '';
    load(sheets[pick]?.rows ?? []);
    if (sheets[pick]?.truncated) $('.js-paste-note', panel).textContent = 'This sheet is longer than we read in one go: only its first 400 rows and 40 columns are shown.';
  };
  root.addEventListener('click', (e) => {
    if (e.target.closest('.js-paste')) {
      panel.hidden = false;
      desk.tab = 'draft';
      renderTabs();
      panel.scrollIntoView({ block: 'nearest' });
      box.focus();
    }
    if (e.target.closest('.js-paste-close')) panel.hidden = true;
  });
  box.addEventListener('input', () => { book = []; fileName = 'pasted rows'; $('.js-sheet-pick', panel).innerHTML = ''; $('.js-file-name', panel).textContent = ''; load(gridFromText(box.value, 'paste')); });
  $('.js-file', panel).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    box.value = '';
    fileName = file.name;
    $('.js-file-name', panel).textContent = file.name;
    try {
      loadBook(await sheetsFromFile(file));
    } catch (err) {
      if (err.handled) return;
      loadBook([]);
      $('.js-paste-note', panel).textContent = err.message;
    }
  });
  $('.js-sheet-pick', panel).addEventListener('change', (e) => loadBook(book, Number(e.target.value)));
  $('.js-map', panel).addEventListener('change', (e) => {
    if (e.target.matches('.js-use')) sheet.mapping = remap(sheet.mapping, Number(e.target.dataset.col), e.target.value);
    if (e.target.matches('.js-header')) sheet.mapping = withHeader(sheet.grid, sheet.mapping, e.target.checked);
    preview();
  });
  $('.js-paste-add', panel).addEventListener('click', () => {
    if (desk.busy) {
      $('.js-paste-note', panel).textContent = 'The assistant is drafting. Add these rows once it replies.';
      return;
    }
    const d = desk.draft;
    const kept = d.samples.filter((r) => !blank(r));
    const fit = MAX_SAMPLES - kept.length;
    const { rows: taken, grid, mapping } = sheet;
    const added = taken.slice(0, fit);
    const keptProvenance = Object.entries(d.provenance).filter(([path]) => {
      const m = /^samples\.(\d+)\./.exec(path);
      return !m || !blank(d.samples[+m[1]]);
    });
    d.samples = [...kept, ...added.map((r) => ({ ...newRow(), ...Object.fromEntries(ROW_FIELDS.map(([k]) => [k, r[k] || null])), details: r.details }))];
    d.provenance = Object.fromEntries(keptProvenance);
    added.forEach((r, j) => {
      for (const [k] of ROW_FIELDS) if (r[k]) mark(`samples.${kept.length + j}.${k}`, 'sheet');
      if (r.details.length) mark(`samples.${kept.length + j}.details`, 'sheet');
    });
    const left = taken.length - added.length;
    box.value = '';
    sheet = left > 0 ? { grid: dropRows(grid, mapping, fit), mapping } : null;
    preview();
    $('.js-paste-note', panel).textContent = left > 0 ? `Only ${MAX_SAMPLES} samples fit in one submission. ${plural(left, 'row was', 'rows were')} not added.` : '';
    panel.hidden = left <= 0;
    if (desk.assistant.enabled) {
      desk.messages.push({ role: 'note', text: `${plural(added.length, 'sample')} added from ${fileName}` });
      renderChat();
    }
    changed({ structure: true });
  });
}

/** The shipment's path to the lab, ending at Received; a Declined or Withdrawn submission stops after its last step. */
function submissionTimeline(s) {
  const st = SUBMISSION[s.status];
  const reachedTo = st.stop ? -1 : SUBMISSION_STEPS.findIndex((x) => x.status === s.status);
  const steps = st.stop ? SUBMISSION_STEPS.filter((x) => s[x.at]) : SUBMISSION_STEPS;
  return html`<ol class="timeline">
    ${steps.map((x, i) => {
      const done = st.stop || i <= reachedTo || !!s[x.at];
      const now = !st.stop && i === reachedTo;
      return html`<li class="${now ? 'now' : done ? 'done' : 'future'}"><i></i><b>${x.title}</b><span>${s[x.at] ? `${fmtDate(s[x.at])} · ` : ''}${x.sub}</span></li>`;
    })}
    ${st.stop ? html`<li class="stop now"><i></i><b>${st.label}</b><span>${fmtDate(s.updated_at)} · ${s.status_note || st.stop}</span></li>` : ''}
  </ol>`;
}

async function submissionDetail(id, query) {
  const { submission: s, thread_id, can } = await api(`/submissions/${id}`);
  const justSent = query.sent === '1' && SUBMISSION[s.status].open;
  const shownFields = fieldsOf(s.samples);
  return {
    title: s.code,
    html: html`
      <a class="back" href="#/samples?tab=shipments">${ic('arrowLeft', 15)} Shipments</a>
      ${justSent ? html`<section class="label-card">
        <div class="micro">Your submission number</div>
        <div class="big mono">${s.code}</div>
        <p>Write <b>${s.code}</b> on the outside of the box, or print this page and put it inside. That is how we match the box to this notice.</p>
        <div class="row wrap"><button class="btn btn-sm js-copy" type="button">Copy number</button><button class="btn btn-sm js-print" type="button">${ic('printer', 15)} Print</button></div>
      </section>` : html`<div class="page-head">
        <div><div class="eyebrow">Sample shipment</div><h1 class="mono" style="font-family:var(--font)">${s.code}</h1><p class="sub">${plural(s.samples.length, 'sample')} · sent ${fmtDateTime(s.created_at)}</p></div>
        ${thread_id ? html`<a class="btn" href="${`#/messages/${thread_id}`}">${ic('message', 16)} Conversation</a>` : ''}
      </div>`}
      <div class="stack">
        <section class="card card-pad">
          <div class="row" style="justify-content:space-between;margin-bottom:18px"><h2>${justSent ? 'What happens next' : 'Status'}</h2>${subPill(s.status)}</div>
          ${submissionTimeline(s)}
          ${s.received_samples.length ? html`<p class="small">Logged as ${s.received_samples.map((x, i) => html`${i ? ', ' : ''}<a class="mono" href="${`#/samples/${x.id}`}">${x.code}</a>`)}. Follow each sample's tests from its page.</p>` : ''}
          ${SUBMISSION[s.status].open ? html`<p class="hint">We will message you here when the box arrives.</p>` : ''}
          ${can.withdraw ? html`<p class="hint">Sent by mistake? <button class="linkish js-withdraw" type="button">Withdraw ${s.code}</button>. Available until the lab confirms.</p>` : ''}
        </section>
        <section class="card">
          <div class="card-head"><h2>What you told us</h2></div>
          <div class="table-wrap"><table class="table responsive"><thead><tr><th>#</th>${shownFields.map(([, l]) => html`<th>${l}</th>`)}</tr></thead>
          <tbody>${s.samples.map((r, i) => html`<tr><td class="muted">${i + 1}</td>${shownFields.map(([k, l]) => html`<td data-label="${l}">${(k === 'priority' ? r.priority || s.priority : r[k]) || '—'}</td>`)}</tr>`)}</tbody></table></div>
        </section>
        <div class="grid-2">
          ${s.methods.length ? html`<section class="card card-pad"><h2 style="margin-bottom:14px">Tests requested</h2>
            <ul class="list" style="margin:-6px 0">${s.methods.map((m) => html`<li style="padding:8px 0"><div style="font-weight:560">${m.title}</div><div class="small muted">${m.code} · ${m.technique}</div></li>`)}</ul>
          </section>` : ''}
          <section class="card card-pad"><h2 style="margin-bottom:14px">Handling & shipping</h2>
            <dl class="facts">
              ${s.project ? html`<dt>Project</dt><dd class="js-project"><span class="mono">${s.project.code}</span> ${s.project.title}</dd>` : ''}
              <dt>Turnaround</dt><dd>${s.priority}</dd>
              <dt>Sample type</dt><dd>${s.sample_type || '—'}</dd>
              <dt>Storage</dt><dd>${s.storage || '—'}</dd>
              <dt>Courier</dt><dd>${s.courier || '—'}</dd>
              <dt>Tracking</dt><dd class="mono">${s.tracking_no || '—'}</dd>
              <dt>Ship date</dt><dd>${fmtDate(s.ship_date)}</dd>
            </dl>
            ${s.notes ? html`<p class="small pre" style="margin-top:14px;color:var(--ink-2)">${s.notes}</p>` : ''}
          </section>
        </div>
        ${justSent ? html`<div class="row wrap"><a class="btn" href="#/samples?tab=shipments">Your shipments</a><a class="btn btn-quiet" href="#/submit">Send another</a></div>` : ''}
      </div>`,
    mount(root) {
      $('.js-copy', root)?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(s.code); } catch { /* clipboard blocked */ } toast(`${s.code} copied`); });
      $('.js-print', root)?.addEventListener('click', () => window.print());
      $('.js-withdraw', root)?.addEventListener('click', async (e) => {
        if (!confirm(`Withdraw ${s.code}? The lab will no longer expect this box.`)) return;
        e.target.disabled = true;
        try { await post(`/submissions/${s.id}/withdraw`); toast('Submission withdrawn'); route(); } catch (err) { if (!err.handled) toast(err.message); e.target.disabled = false; }
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Method development / validation requests
// ---------------------------------------------------------------------------------------------

async function requestsList() {
  const [reqs, subs] = await Promise.all([api('/requests'), api('/submissions')]);
  const openSubs = subs.filter((s) => SUBMISSION[s.status].open);
  return {
    title: 'Requests',
    html: html`
      <div class="page-head"><div><div class="eyebrow">${state.me.client.name}</div><h1>Method requests</h1><p class="sub">Method development, validation and transfer — from first scope to an agreed project.</p></div><a class="btn btn-primary" href="#/requests/new">${ic('plus', 16)} New request</a></div>
      <div class="stack">
        <section class="card">
          ${reqs.length ? html`<ul class="list">${reqs.map((r) => html`<li><a class="item" href="${`#/requests/${r.id}`}">
            <div class="grow"><div class="t ellipsis">${r.title}</div><div class="s ellipsis"><span class="mono">${r.code}</span> · ${r.type}${r.product ? ` · ${r.product}` : ''} · ${fmtDate(r.created_at)}</div></div>
            <div class="end">${pill(r.status, REQ_TONE[r.status])}</div></a></li>`)}</ul>` : empty('flask', 'No method requests yet.', html`<a class="btn btn-sm" href="#/requests/new">Start a request</a>`)}
        </section>
        ${openSubs.length ? html`<section class="card"><div class="card-head"><h2>Open sample submissions</h2><a class="small" href="#/samples?tab=shipments">All shipments</a></div>
          <ul class="list">${openSubs.map((s) => html`<li><a class="item" href="${`#/submissions/${s.id}`}"><div class="grow"><div class="t"><span class="mono">${s.code}</span> · ${plural(s.sample_count, 'sample')}</div><div class="s">${s.courier || 'Courier not given'} · ${fmtDate(s.created_at)}</div></div><div class="end">${subPill(s.status)}</div></a></li>`)}</ul></section>` : ''}
      </div>`,
  };
}

async function requestForm() {
  const lk = await lookups();
  const types = [
    ['Method development', 'A new method for your product or impurity.'],
    ['Method validation', 'Validate an existing method to ICH Q2(R2).'],
    ['Method transfer', 'Bring your method into our lab.'],
    ['Other', 'Something else — tell us below.'],
  ];
  return {
    title: 'New method request',
    html: html`
      <a class="back" href="#/requests">${ic('arrowLeft', 15)} Method requests</a>
      <div class="page-head"><div><div class="eyebrow">${state.me.client.name}</div><h1>Request method work</h1><p class="sub">Give us the essentials. A scientist reviews every request and replies with questions or a proposal, usually within two working days.</p></div></div>
      <form class="card" id="request" novalidate>
        <div class="form-section">
          <div class="about"><h2><span class="step-n"></span>Type of work</h2></div>
          <div class="choice cols-4">${types.map(([t, d], i) => html`<label><input type="radio" name="type" value="${t}" ${i === 0 ? raw('checked') : ''}><span class="t">${t}</span><span class="d">${d}</span></label>`)}</div>
        </div>
        <div class="form-section">
          <div class="about"><h2><span class="step-n"></span>What it is for</h2><p>The product and the analytical question.</p></div>
          <div class="stack">
            <label class="field"><span class="label">Short title</span><input class="input" name="title" required maxlength="200" placeholder="e.g. Assay and impurities method for XY-101 tablets"></label>
            <div class="grid-2">
              <label class="field"><span class="label">Product / molecule</span><input class="input" name="product" placeholder="e.g. XY-101 25 mg film-coated tablets"></label>
              <label class="field"><span class="label">Technique <span class="opt">(if known)</span></span><select class="select" name="technique"><option value="">No preference</option>${lk.techniques.map((t) => html`<option>${t}</option>`)}</select></label>
            </div>
          </div>
        </div>
        <div class="form-section js-params">
          <div class="about"><h2><span class="step-n"></span>Validation scope</h2><p>Performance characteristics per ICH Q2(R2). Tick what you need; we will advise on the rest.</p></div>
          <div class="checks cols">${lk.validationParameters.map((p) => html`<label class="check"><input type="checkbox" name="parameters" data-list="1" value="${p}"><span>${p}</span></label>`)}</div>
        </div>
        <div class="form-section">
          <div class="about"><h2><span class="step-n"></span>Context & timing</h2></div>
          <div class="stack">
            <label class="field"><span class="label">Scope and background</span><textarea class="textarea" name="scope" placeholder="Analytes and ranges, sample matrix, existing methods or literature, material available, acceptance criteria…"></textarea></label>
            <div class="grid-2">
              <label class="field"><span class="label">Regulatory context</span><select class="select" name="regulatory"><option value="">Select…</option>${lk.regulatoryContexts.map((t) => html`<option>${t}</option>`)}</select></label>
              <label class="field"><span class="label">Target date <span class="opt">(optional)</span></span><input class="input" type="date" name="target_date" min="${todayIso()}"></label>
            </div>
          </div>
        </div>
        <div class="form-actions"><div class="form-error grow"></div><a class="btn btn-quiet" href="#/requests">Cancel</a><button class="btn btn-primary" type="submit">${ic('send', 16)} Send request</button></div>
      </form>`,
    mount(root) {
      const form = $('#request', root);
      const params = $('.js-params', form);
      const sync = () => { const t = formData(form).type; params.hidden = !['Method validation', 'Method transfer'].includes(t); };
      form.addEventListener('change', (e) => { if (e.target.name === 'type') sync(); });
      sync();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(form);
        if (params.hidden) d.parameters = [];
        const res = await submitting(form, () => post('/requests', { ...d, technique: d.technique || null, regulatory: d.regulatory || null, target_date: d.target_date || null }));
        if (res) { toast(`Request ${res.code} sent`); location.hash = `#/requests/${res.id}`; }
      });
    },
  };
}

async function requestDetail(id) {
  const { request: r, thread_id } = await api(`/requests/${id}`);
  const flow = ['Submitted', 'Under review', 'Proposal sent', r.status === 'Declined' ? 'Declined' : 'Accepted'];
  const reached = flow.indexOf(r.status) + 1;
  return {
    title: r.code,
    html: html`
      <a class="back" href="#/requests">${ic('arrowLeft', 15)} Method requests</a>
      <div class="page-head">
        <div><div class="eyebrow"><span class="mono">${r.code}</span> · ${r.type}</div><h1>${r.title}</h1><p class="sub">Submitted ${fmtDateTime(r.created_at)}</p></div>
        ${thread_id ? html`<a class="btn btn-primary" href="${`#/messages/${thread_id}`}">${ic('message', 16)} Conversation</a>` : ''}
      </div>
      <div class="cols">
        <div class="stack">
          <section class="card card-pad">
            <div class="row" style="justify-content:space-between;margin-bottom:18px"><h2>Status</h2>${pill(r.status, REQ_TONE[r.status])}</div>
            <ol class="steps">${flow.map((st, i) => html`<li class="${i < reached ? 'done' : ''} ${i + 1 === reached ? 'current' : ''} ${st === 'Declined' ? 'stop' : ''}"><div>${st}</div></li>`)}</ol>
            ${r.response ? html`<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)"><div class="small muted" style="margin-bottom:6px">Latest response from the lab · ${fmtDate(r.responded_at)}</div><p class="pre">${r.response}</p></div>` : ''}
            ${r.project_code ? html`<div class="alert alert-ok" style="margin-top:16px">${ic('check', 16)}<span>Project <b class="mono">${r.project_code}</b> opened: ${r.project_title}</span></div>` : ''}
          </section>
          ${r.scope ? html`<section class="card card-pad"><h2 style="margin-bottom:10px">Scope and background</h2><p class="pre" style="color:var(--ink-2)">${r.scope}</p></section>` : ''}
        </div>
        <section class="card card-pad">
          <h2 style="margin-bottom:16px">Summary</h2>
          <dl class="facts">
            <dt>Type</dt><dd>${r.type}</dd>
            <dt>Product</dt><dd>${r.product || '—'}</dd>
            <dt>Technique</dt><dd>${r.technique || 'No preference'}</dd>
            <dt>Regulatory</dt><dd>${r.regulatory || '—'}</dd>
            <dt>Target date</dt><dd>${fmtDate(r.target_date)}</dd>
          </dl>
          ${r.parameters.length ? html`<h3 style="margin:20px 0 10px;font-size:13.5px">Validation parameters</h3><div class="row" style="flex-wrap:wrap;gap:6px">${r.parameters.map((p) => html`<span class="pill plain">${p}</span>`)}</div>` : ''}
        </section>
      </div>`,
  };
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

async function messagesView(threadId, query) {
  const threads = await api('/threads');
  const openId = threadId;
  const t = openId ? await api(`/threads/${openId}`) : null;
  if (t) {
    const row = threads.find((x) => x.id === openId);
    if (row) row.unread = 0;
  }
  setUnread(threads.filter((x) => x.unread).length);
  const composeNew = !openId && location.hash.startsWith('#/messages/new');
  let samples = [];
  if (composeNew) samples = await api('/samples?status=all');
  const preSample = query.sample ? +query.sample : null;
  const list = html`<section class="card threads-card">
    <div class="card-head"><h2>Conversations</h2><a class="btn btn-sm" href="#/messages/new">${ic('plus', 15)} New</a></div>
    ${threads.length ? html`<ul class="list threads">${threads.map((x) => html`<li class="${x.unread ? 'unread' : ''}"><a class="item" href="${`#/messages/${x.id}`}" aria-current="${String(x.id === openId)}">
      <div class="grow"><div class="row"><span class="t grow ellipsis">${x.subject}</span>${x.unread ? html`<span class="udot" aria-label="Unread"></span>` : ''}<span class="tiny faint nowrap">${relTime(x.last_message_at)}</span></div><div class="s ellipsis">${x.last_author}: ${x.excerpt}</div></div>
    </a></li>`)}</ul>` : empty('message', 'No conversations yet.')}
  </section>`;
  let pane;
  if (composeNew) {
    pane = html`<form class="card" id="newthread" novalidate>
      <div class="thread-head"><h2>New message</h2><p class="small muted" style="margin-top:2px">Goes to the team handling your account. We reply within one working day.</p></div>
      <div class="card-pad stack">
        <div class="form-error"></div>
        <label class="field"><span class="label">Subject</span><input class="input" name="subject" required maxlength="200" value="${preSample ? `Question about ${samples.find((s) => s.id === preSample)?.code || 'a sample'}` : ''}"></label>
        <label class="field"><span class="label">Related sample <span class="opt">(optional)</span></span><select class="select" name="sample_id"><option value="">None</option>${samples.map((s) => html`<option value="${s.id}" ${s.id === preSample ? raw('selected') : ''}>${s.code} — ${s.description}${s.batch_no ? ` (${s.batch_no})` : ''}</option>`)}</select></label>
        <label class="field"><span class="label">Message</span><textarea class="textarea" name="body" required style="min-height:160px"></textarea></label>
      </div>
      <div class="form-actions"><a class="btn btn-quiet" href="#/messages">Cancel</a><button class="btn btn-primary" type="submit">${ic('send', 16)} Send</button></div>
    </form>`;
  } else if (t) {
    const th = t.thread;
    const link = th.submission_id ? html`<a class="mono" href="${`#/submissions/${th.submission_id}`}">${th.submission_code}</a>` : th.request_id ? html`<a class="mono" href="${`#/requests/${th.request_id}`}">${th.request_code}</a>` : th.sample_id ? html`<a class="mono" href="${`#/samples/${th.sample_id}`}">${th.sample_code}</a>` : '';
    pane = html`<section class="card">
      <div class="thread-head"><a class="back" href="#/messages" style="margin-bottom:8px" data-phone-only>${ic('arrowLeft', 15)} All conversations</a><h2>${th.subject}</h2><p class="small muted" style="margin-top:2px">Started ${fmtDate(th.created_at)}${link ? html` · ${link}` : ''}</p></div>
      <div class="msgs" id="msgs">${t.messages.map((m) => html`<div class="msg ${m.side}"><div class="meta">${m.side === 'client' ? 'You' : m.author_name} · ${relTime(m.created_at)}</div><div class="bubble">${m.body}</div></div>`)}</div>
      <form id="reply" novalidate>
        <div class="composer">
          <label class="grow"><span class="sr-only">Reply</span><textarea class="textarea" name="body" rows="1" placeholder="Write a reply…" required></textarea></label>
          <button class="btn btn-primary" type="submit">${ic('send', 16)} Send</button>
        </div>
        <div class="form-error" style="padding:0 20px 14px"></div>
      </form>
    </section>`;
  } else {
    pane = html`<section class="card">${empty('message', threads.length ? 'Choose a conversation, or start a new one.' : 'Start a conversation with the laboratory.', html`<a class="btn btn-primary btn-sm" href="#/messages/new">New message</a>`)}</section>`;
  }
  const phoneShowsPane = composeNew || !!t;
  return {
    title: t ? t.thread.subject : 'Messages',
    html: html`
      <div class="page-head"><div><div class="eyebrow">${state.me.client.name}</div><h1>Messages</h1><p class="sub">Talk directly with the scientists and coordinators working on your samples.</p></div></div>
      <div class="inbox ${phoneShowsPane ? 'has-pane' : ''}">
        <div class="list-pane">${list}</div>
        <div class="thread-pane">${pane}</div>
      </div>`,
    mount(root) {
      // On phones show either the list or the open conversation, never both.
      if (window.matchMedia('(max-width: 959px)').matches) {
        $('.list-pane', root).hidden = phoneShowsPane;
        $('.thread-pane', root).hidden = !phoneShowsPane;
      } else $$('[data-phone-only]', root).forEach((el) => el.remove());
      const msgs = $('#msgs', root);
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      const nf = $('#newthread', root);
      nf?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formData(nf);
        const res = await submitting(nf, () => post('/threads', { subject: d.subject, body: d.body, sample_id: d.sample_id || null }));
        if (res) { toast('Message sent'); location.hash = `#/messages/${res.id}`; }
      });
      const rf = $('#reply', root);
      if (rf) {
        const ta = $('textarea', rf);
        const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; };
        ta.addEventListener('input', grow);
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) rf.requestSubmit(); });
        rf.addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = ta.value.trim();
          if (!body) return;
          const ok = await submitting(rf, () => post(`/threads/${openId}/messages`, { body }));
          if (ok) route();
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

function accountView() {
  const { user, client } = state.me;
  const theme = store.read().theme || 'system';
  return {
    title: 'Account',
    html: html`
      <div class="page-head"><div><div class="eyebrow">${state.me.client.name}</div><h1>Account & security</h1><p class="sub">Your sign-in details for the ${state.info.lab_name} client portal.</p></div></div>
      <div class="cols">
        <section class="card">
          <div class="card-head"><h2>Change password</h2></div>
          <form class="card-pad" id="pwform" novalidate>
            <div class="form-error"></div>
            ${passwordFields(false)}
            <div class="row" style="justify-content:flex-end;margin-top:22px"><button class="btn btn-primary" type="submit">Update password</button></div>
            <p class="hint">Changing your password signs you out on every other device.</p>
          </form>
        </section>
        <div class="stack">
          <section class="card card-pad">
            <h2 style="margin-bottom:16px">Profile</h2>
            <dl class="facts">
              <dt>Name</dt><dd>${user.full_name}</dd>
              <dt>Email</dt><dd>${user.email}</dd>
              ${user.job_title ? html`<dt>Role</dt><dd>${user.job_title}</dd>` : ''}
              <dt>Organisation</dt><dd>${client.name}</dd>
              <dt>Last sign-in</dt><dd>${fmtDateTime(user.last_login_at)}</dd>
            </dl>
            <p class="hint" style="margin-top:16px">To change these details or add colleagues, message the laboratory.</p>
          </section>
          <section class="card card-pad">
            <h2 style="margin-bottom:14px">Appearance</h2>
            <div class="seg" role="group" aria-label="Theme">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => html`<button type="button" data-theme-set="${k}" aria-pressed="${String(k === theme)}">${l}</button>`)}</div>
          </section>
          <button class="btn btn-block js-out" type="button">${ic('logout', 16)} Sign out</button>
        </div>
      </div>`,
    mount(root) {
      const form = $('#pwform', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await submitting(form, async () => { await changePassword(form); return true; });
        if (ok) { form.reset(); toast('Password updated'); }
      });
      $$('[data-theme-set]', root).forEach((b) => b.addEventListener('click', () => {
        applyTheme(b.dataset.themeSet);
        $$('[data-theme-set]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
      $('.js-out', root).addEventListener('click', signOut);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
  try {
    state.info ||= await api('/info');
    store.set({ lab: state.info.lab_name });
    const sn = $('#splash-name');
    if (sn) sn.textContent = state.info.lab_name;
  } catch (e) {
    app.innerHTML = String(html`<div class="auth-form" style="padding:96px 16px;text-align:center"><h1>We can't reach the portal right now</h1><p class="lede">${e.message}</p><button class="btn btn-primary js-retry" style="margin-top:24px">Try again</button></div>`);
    $('.js-retry').addEventListener('click', () => location.reload());
    hideSplash();
    return;
  }
  try {
    state.me = await api('/me');
  } catch (e) {
    if (e.status === 401) { showSignIn(); return; }
    throw e;
  }
  if (state.me.user.must_change_password) { showPasswordChange(); return; }
  renderShell();
  await route();
}

window.addEventListener('hashchange', route);
setInterval(refreshUnread, 60_000);
boot();
