// The Test page's note that its Sample was accepted with changes, from `intake_changes` on GET /api/tests/:id.
// The server derives it from the audit trail; this file only words it. Nothing shows for a Sample accepted as received.
import { html } from '../core/html.js';
import { icon } from '../core/icons.js';
import { fmtDateTime } from '../core/ui.js';

const value = (v) => (v === null || v === '' || v === undefined ? 'empty' : v);

/** The notice for Sample `sampleCode`, or an empty string when it was accepted as received. */
export function acceptedWithChangesNotice(changes, sampleCode) {
  if (!changes?.accepted_with_changes) return '';
  const { edits, added_tests: added, cancelled_tests: cancelled } = changes;
  return html`<div class="notice info mb" data-intake-changes>${icon('edit', { size: 16 })}<span>
    <strong>${sampleCode} was accepted with changes</strong> by ${changes.accepted_by_name} on ${fmtDateTime(changes.accepted_at)}, so this request was adjusted after the lab received it.
    <ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${edits.map((e) => html`<li data-change="edit">${e.label}: ${value(e.from)} → <strong>${value(e.to)}</strong></li>`)}
      ${added.map((t) => html`<li data-change="added">Test <span class="code">${t.code}</span> (${t.method_code}) was added</li>`)}
      ${cancelled.map((t) => html`<li data-change="cancelled">Test <span class="code">${t.code}</span> (${t.method_code}) was cancelled${t.reason ? `: ${t.reason}` : ''}</li>`)}
    </ul></span></div>`;
}
