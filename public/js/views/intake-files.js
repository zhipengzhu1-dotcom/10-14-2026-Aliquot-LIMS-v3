// The review pane's files section: the Sample's own attachments, through the panel every record page uses. Which files
// it lists, whether more can be added and which can be removed are the server's answers (GET /api/attachments).
import { html } from '../core/html.js';
import { card } from '../core/ui.js';
import { mountAttachments } from '../core/components.js';

export const filesSection = {
  render: () => html`<div data-section="files">${card({ title: 'Attachments', body: html`<div data-attachments></div>` })}</div>`,
  wire: (root, review) => mountAttachments(root.querySelector('[data-attachments]'), 'samples', review.sample.id),
};
