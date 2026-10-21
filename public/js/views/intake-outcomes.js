// Receiving & Review: the card that reports what happened to each Sample or Test of a bulk action, with the server's
// reason for every refusal. The caller words the rows; this file lays out the card and wires its Dismiss button.
import { html } from '../core/html.js';
import { plural, badge } from '../core/ui.js';

/**
 * Shows the outcomes in `host`. `noun` is what was acted on ('sample'), `verb` what was done to the ones that went through
 * ('accepted'), `done` the label of their badge, and `rows` one `{ label, ok, error }` per item.
 */
export function showOutcomes(host, { noun, verb, done, rows }) {
  const refused = rows.filter((x) => !x.ok).length;
  host.innerHTML = String(html`<section class="card mb" data-outcomes><header class="card-head"><div>
    <h2>${plural(rows.length - refused, noun)} ${verb}${refused ? `, ${refused} refused` : ''}</h2>
    <p class="sub">Each ${noun} was decided on its own, so a refusal does not stop the others.</p></div>
    <div class="card-actions"><button class="btn sm ghost" data-dismiss>Dismiss</button></div></header>
    <ul class="list">${rows.map((x) => html`<li><div class="grow"><span class="code">${x.label}</span> ${x.ok ? badge(done, 'green') : badge('Refused', 'red')}
      ${x.ok ? '' : html`<span class="sub-line">${x.error}</span>`}</div></li>`)}</ul></section>`);
  host.querySelector('[data-dismiss]').addEventListener('click', () => { host.innerHTML = ''; });
}
