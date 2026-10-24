// Intake review pane, feasibility section: each Test requested on the Sample with the three indicators the server
// computed (Method usable, qualified analysts, due date). The values and their reasons come from the review endpoint;
// this file only shows them. A Test whose Method is not usable, or that nobody is qualified on, is flagged.
import { html } from '../core/html.js';
import { icon } from '../core/icons.js';
import { badge } from '../core/ui.js';

/** One indicator as a badge (hover shows the reason) with the reason written under it. `tone` is used when it is not ok. */
function indicator(key, i, label, notOkTone = 'red') {
  return html`<td data-indicator="${key}" data-ok="${i.ok}">${badge(label, i.ok ? 'green' : notOkTone, { title: i.reason })}
    <span class="sub-line" style="white-space:normal" title="${i.reason}">${i.reason}</span></td>`;
}

const flagged = (t) => !t.indicators.method_usable.ok || !t.indicators.qualified.ok;

function testRow(t) {
  const { method_usable: usable, qualified, due_date: due } = t.indicators;
  const why = [!usable.ok && usable.reason, !qualified.ok && qualified.reason].filter(Boolean).join('. ');
  return html`<tr data-test="${t.id}" data-flagged="${flagged(t)}">
    <td class="title-cell"><strong>${t.name}</strong>
      <span class="sub-line"><span class="code">${t.method_code}</span> v${t.method_version}</span>
      ${flagged(t) ? html`<span class="badge red" data-flag title="${why}">${icon('alert', { size: 12 })}Needs attention</span>` : ''}</td>
    ${indicator('method_usable', usable, usable.ok ? 'Usable' : 'Not usable')}
    ${indicator('qualified', qualified, `${qualified.count} qualified`)}
    ${indicator('due_date', due, due.ok ? 'Can be met' : 'At risk', 'amber')}
  </tr>`;
}

export function feasibilitySection(review) {
  const tests = review.tests ?? [];
  return html`<section data-section="feasibility">
    <h3 class="section-title">Tests requested</h3>
    ${tests.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Test</th><th>Method usable</th><th>Qualified analysts</th><th>Due date</th></tr></thead>
      <tbody>${tests.map(testRow)}</tbody></table></div>`
    : html`<p class="muted">No open Tests are requested on this sample.</p>`}
  </section>`;
}
