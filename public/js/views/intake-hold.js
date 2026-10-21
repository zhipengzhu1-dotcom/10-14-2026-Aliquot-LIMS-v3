// Receiving & Review: the reason prompt for putting a Sample on hold. The reason is sent to the client as a question
// when the Sample arrived in a Submission, so the prompt says so; a directly received Sample has no one to ask.
import { html } from '../core/html.js';
import { field, openForm } from '../core/ui.js';
import { icon } from '../core/icons.js';

/** Asks why Sample `sample` is held. Resolves `{ reason }`, or null if dismissed. */
export function askHoldReason({ sample, submission }) {
  return openForm({
    title: `Put ${sample.code} on hold`,
    size: 'sm',
    submitLabel: 'Put on hold',
    body: html`
      <p class="span-2 notice">${icon('info', { size: 16 })}<span>${submission
        ? html`Your reason is posted as a question in the client's message thread for ${submission.code}. It is also stored in the audit trail.`
        : 'This sample was received at the front desk, so no message is sent. The reason is stored in the audit trail.'}</span></p>
      ${field({ label: submission ? 'Question for the client' : 'Reason', name: 'reason', type: 'textarea', rows: 4, required: true, span: 2, autofocus: true, placeholder: 'e.g. The label is smudged. Which batch is this?' })}`,
    onSubmit: (d) => ({ reason: d.reason.trim() }),
  });
}
