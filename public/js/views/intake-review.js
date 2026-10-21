// The review pane of Receiving & Review: opens over the Queue for one Sample, so the manager can look at it and go back
// to the list without losing their place. It fetches the review endpoint once and renders each of SECTIONS from the
// answer; a section is a function from the answer to markup, kept in a file of its own.
import { html } from '../core/html.js';
import { api } from '../core/api.js';
import { openModal, showError } from '../core/ui.js';
import { feasibilitySection } from './intake-feasibility.js';

const SECTIONS = [feasibilitySection];

export async function openReview(sampleId, { title = 'Review sample' } = {}) {
  const pane = openModal({ title, size: 'xl', body: html`<div data-review-body><p class="muted">Loading…</p></div>` });
  try {
    const review = await api.get(`/api/intake/samples/${sampleId}/review`);
    pane.el.querySelector('[data-review-body]').innerHTML = String(html`${SECTIONS.map((section) => section(review))}`);
  } catch (e) {
    pane.close();
    showError(e);
  }
}
