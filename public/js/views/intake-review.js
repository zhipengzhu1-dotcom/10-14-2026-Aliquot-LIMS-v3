// The review pane of one received Sample, opened over the Receiving & Review Queue so the manager can look at it and go
// back to the list without losing their place. The pane is only a shell: each of SECTIONS renders from the review the
// server returns (GET /api/intake/samples/:id/review) and wires its own actions; `reload` redraws every section after
// one of them changes the Sample.
import { html } from '../core/html.js';
import { api } from '../core/api.js';
import { openModal, showError } from '../core/ui.js';
import { section as values, intakeBadge } from './intake-values.js';
import { feasibilitySection } from './intake-feasibility.js';

// One entry per section, in the order shown: { render(review), wire?(root, review, { reload }) }, each kept in its own file.
const SECTIONS = [values, { render: feasibilitySection }];

/** Opens the review of Sample `sampleId`; `onChange` runs after a correction so the screen behind can reload. */
export async function openReview(sampleId, { onChange } = {}) {
  let review;
  try {
    review = await api.get(`/api/intake/samples/${sampleId}/review`);
  } catch (e) {
    showError(e);
    return null;
  }
  const modal = openModal({
    title: html`<span class="mono" data-review-title></span>`,
    size: 'xl',
    cls: 'intake-review',
    body: html`<div class="stack" data-review-body></div>`,
  });
  const root = modal.el.querySelector('[data-review-body]');

  function draw() {
    modal.el.querySelector('[data-review-title]').innerHTML = String(html`${review.sample.code} ${intakeBadge(review.sample.intake)}`);
    root.innerHTML = String(html`${SECTIONS.map((s) => s.render(review))}`);
    for (const s of SECTIONS) s.wire?.(root, review, { reload });
  }

  async function reload() {
    review = await api.get(`/api/intake/samples/${sampleId}/review`);
    draw();
    onChange?.();
  }

  draw();
  return modal;
}
