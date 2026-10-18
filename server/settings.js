import { all, run, tx } from './db.js';
import { audit } from './audit.js';

export const DEFAULTS = {
  lab_name: 'Your Laboratory',
  lab_address: '',
  lab_phone: '',
  lab_email: '',
  lab_accreditation: '',
  currency: 'USD',
  tax_rate: '0',
  same_day_surcharge_pct: '200',
  next_day_surcharge_pct: '100',
  three_day_surcharge_pct: '50',
  rush_surcharge_pct: '50',
  urgent_surcharge_pct: '100',
  payment_terms_days: '30',
  session_idle_minutes: '60',
  coa_statement: 'The results in this certificate relate only to the samples tested as received. This certificate shall not be reproduced except in full without the written approval of the laboratory.',
  demo_mode: '0',
  // The submission assistant. Only enableAssistant / disableAssistant (server/assistant.js) write these.
  assistant_enabled: '0',
  assistant_model: 'claude-opus-5-5',
  assistant_effort: 'medium',
  assistant_approved_by: '',
  assistant_approved_at: '',
  assistant_account: '',
};

export const ASSISTANT_SETTINGS = Object.keys(DEFAULTS).filter((key) => key.startsWith('assistant_'));

let cache = null;

export function getSettings() {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const row of all('SELECT key, value FROM settings')) cache[row.key] = row.value;
  }
  return { ...cache };
}

export const getSetting = (key) => getSettings()[key];
export const getNumber = (key) => Number(getSetting(key)) || 0;

export function setSettings(ctx, patch, summary = 'Laboratory settings changed') {
  const current = getSettings();
  const changes = {};
  tx(() => {
    for (const [key, raw] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      const value = raw == null ? '' : String(raw);
      if (current[key] === value) continue;
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      changes[key] = [current[key], value];
    }
    if (Object.keys(changes).length) audit(ctx, { action: 'UPDATE', entity: 'settings', summary, changes });
  });
  cache = null;
  return getSettings();
}

export function resetSettingsCache() {
  cache = null;
}
