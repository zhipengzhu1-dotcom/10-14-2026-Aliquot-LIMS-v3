import { html } from '../core/html.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { icon } from '../core/icons.js';
import { pageHead, card, field, formData, toast, busy, plural, fmtDateTime } from '../core/ui.js';

/** The submission assistant's card: what it does, whether it is on and who approved it, and the Claude account found now. */
function assistantBody(st) {
  const s = st.setting;
  return html`<p class="small" style="margin:0 0 10px">Drafts sample submissions in the client portal from what clients paste or attach. It uses the Claude subscription signed in on the computer that runs Aliquot (${s.model}, ${s.effort} effort). It never sends anything: the client reviews the draft and presses Send to lab.</p>
    <dl class="kv">
      <dt>Status</dt><dd data-assistant-state>${s.enabled ? 'On' : 'Off'}</dd>
      ${s.approved_by ? html`<dt>${s.enabled ? 'Approved by' : 'Last approved by'}</dt><dd>${s.approved_by}, ${fmtDateTime(s.approved_at)}</dd><dt>Approved account</dt><dd>${s.account}</dd>` : ''}
      <dt>Claude account found</dt><dd>${st.account ? st.account.name : html`<span class="muted">${st.problem}</span>`}</dd>
    </dl>
    <div style="margin-top:12px">${s.enabled
      ? html`<button class="btn" type="button" data-act="assistant-off">Turn off</button>`
      : html`<button class="btn primary" type="button" data-act="assistant-on">Turn on</button>`}</div>`;
}

async function mountAssistant(box) {
  let status;
  try {
    status = await api.get('/api/settings/assistant');
  } catch (e) {
    box.innerHTML = String(card({ title: 'Submission assistant', body: html`<p class="small muted" style="margin:0">${e.message}</p>` }));
    return;
  }
  box.innerHTML = String(card({ title: 'Submission assistant', body: assistantBody(status) }));
  box.querySelector('[data-act^=assistant]').addEventListener('click', async (e) => {
    const on = e.currentTarget.dataset.act === 'assistant-on';
    const st = await busy(e.currentTarget, () => api.post('/api/settings/assistant', { enabled: on }));
    if (!st) return;
    toast(on ? 'Submission assistant turned on' : 'Submission assistant turned off');
    mountAssistant(box);
  });
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'SGD', 'SEK', 'DKK', 'NOK', 'PLN', 'BRL', 'ZAR'];

export async function render(ctx) {
  ctx.title('Settings');
  const s = await api.get('/api/settings');
  const surcharges = Object.entries(state.lookups.priorityTiers).filter(([, t]) => t.surcharge);
  ctx.el.innerHTML = String(html`
    ${pageHead({ title: 'Settings', sub: 'Laboratory details used on certificates and invoices, pricing rules and security.' })}
    <form data-settings class="stack" novalidate>
      <div class="grid-2">
        ${card({ title: 'Laboratory', sub: 'Printed on every Certificate of Analysis and invoice.', body: html`<div class="form-grid">
          ${field({ label: 'Laboratory name', name: 'lab_name', value: s.lab_name, required: true, span: 2 })}
          ${field({ label: 'Address', name: 'lab_address', type: 'textarea', rows: 3, value: s.lab_address, span: 2 })}
          ${field({ label: 'Phone', name: 'lab_phone', value: s.lab_phone })}
          ${field({ label: 'Email', name: 'lab_email', value: s.lab_email })}
          ${field({ label: 'Accreditation / registration', name: 'lab_accreditation', value: s.lab_accreditation, span: 2, placeholder: 'e.g. ISO/IEC 17025 accredited, cert. no. 1234 · FDA registered' })}
          ${field({ label: 'Certificate statement', name: 'coa_statement', type: 'textarea', rows: 3, value: s.coa_statement, span: 2 })}
        </div>` })}
        <div class="stack">
          ${card({ title: 'Pricing & invoicing', body: html`<div class="form-grid">
            ${field({ label: 'Currency', name: 'currency', type: 'select', options: CURRENCIES, value: s.currency })}
            ${field({ label: 'Default tax rate (%)', name: 'tax_rate', type: 'number', value: s.tax_rate, min: 0, max: 100, step: '0.01' })}
            ${surcharges.map(([name, t]) => field({ label: `${name} surcharge (%)`, name: t.surcharge, type: 'number', value: s[t.surcharge], min: 0, hint: t.retired ? 'Retired tier: prices tests added to older samples' : `Due ${t.days ? `${plural(t.days, 'working day')} after receipt` : 'on the day of receipt'}` }))}
            ${field({ label: 'Default payment terms (days)', name: 'payment_terms_days', type: 'number', value: s.payment_terms_days, min: 0, hint: 'For new clients' })}
          </div>` })}
          ${card({ title: 'Security', body: html`<div class="form-grid">
            ${field({ label: 'Sign out after inactivity (minutes)', name: 'session_idle_minutes', type: 'number', value: s.session_idle_minutes, min: 5, max: 720, span: 2, hint: 'Shared bench computers: 15–30 minutes is typical. Accounts lock for 15 minutes after 5 wrong passwords.' })}
            ${field({ label: 'Show demo banner and demo sign-in buttons', name: 'demo_mode', type: 'checkbox', value: s.demo_mode === '1', span: 2 })}
          </div>` })}
          <div data-assistant>${card({ title: 'Submission assistant', body: html`<p class="small muted" style="margin:0">Looking for a Claude account on this computer…</p>` })}</div>
          ${card({ title: 'Backups', body: html`<p class="small" style="margin:0">${icon('shield', { size: 13 })} The server writes a consistent snapshot of the database every day to <code>data/backups/</code> and keeps the last 14. Copy that folder to another location (network drive, cloud storage) regularly — see the README.</p>` })}
        </div>
      </div>
      <div class="card mt"><div class="summary-bar"><span class="muted small">Changes are recorded in the audit trail.</span><span class="spacer"></span><button class="btn primary" type="submit">${icon('check', { size: 15 })}Save settings</button></div></div>
    </form>`);
  const form = ctx.el.querySelector('form');
  mountAssistant(ctx.el.querySelector('[data-assistant]'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    d.demo_mode = d.demo_mode ? '1' : '0';
    await busy(form.querySelector('[type=submit]'), async () => {
      const saved = await api.put('/api/settings', d);
      Object.assign(state.settings, {
        lab_name: saved.lab_name, currency: saved.currency, demo_mode: saved.demo_mode === '1',
        ...Object.fromEntries(surcharges.map(([, t]) => [t.surcharge, Number(saved[t.surcharge])])),
      });
      document.querySelectorAll('.brand-lab').forEach((el) => { el.textContent = saved.lab_name; });
      toast('Settings saved');
    });
  });
}
