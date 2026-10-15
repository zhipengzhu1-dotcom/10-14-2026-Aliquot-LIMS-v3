# Invoices: ready to bill, draft, issue, pay, void

Business & Finance turns approved tests into invoice lines, edits the draft, issues it (locks it), marks it paid, or voids it with a reason (which makes its tests billable again). Code: `public/js/views/invoices.js`, `public/js/views/print.js`; rules in `INVOICE_RULES` and `createInvoice`/`setInvoiceStatus` (`server/routes/business.js`). Statuses: Draft → Sent → Paid, or Void from Draft or Sent. Codes look like `INV-2026-0012`. Every action needs `billing.edit`, held by the business, manager and admin roles (grace.holloway, oliver.grant, priya.raman, admin).

## Sub-features

- **Ready to bill:** `/invoices?view=unbilled` lists approved, uninvoiced tests grouped by project (`GET /api/invoices/unbilled`). `button[data-bill="<projectId>"]` "Create invoice" POSTs `/api/invoices` with `include_unbilled: true`, toasts "Draft INV-… created" and navigates to the new draft. The "Ready to bill" KPI card on `/invoices` links to this view.
- **New invoice by hand:** `button[data-act=new]` "New invoice": choose project or client, optional notes (POST `/api/invoices`).
- **Edit a draft:** on `/invoices/:id` while Draft: `[data-act=add-line]`, line inputs, `input[name=tax_rate]` (aria-label "Tax rate %"), `[data-act=save]` "Save draft" (PUT `/api/invoices/:id`); `[data-act=pull]` "Add N completed tests" (POST `…/add-unbilled`) appears when more approved work exists.
- **Issue:** `[data-act=issue]` "Issue invoice" (from `can.issue`, Draft only, needs at least one line) opens a confirm dialog "Issue INV-…?" with the total. Its `.modal [data-ok]` "Issue invoice" saves the draft and then POSTs `/api/invoices/:id/issue`; toast "Invoice issued"; status Sent, `issued_date` today, `due_date` = issued + client payment terms.
- **Mark paid:** `[data-act=paid]` opens a small form with `input[name=paid_date]` (defaults to today). Its submit is `.modal-foot button[data-submit]` "Mark paid" (a `type=button`, not `type=submit`) → POST `…/paid`; toast "Marked as paid"; status Paid, `paid_date` set.
- **Void:** `[data-act=void]` asks for a reason (`textarea[name=reason]`, then Continue) → POST `…/void` with `{reason}`; status Void and its tests get `invoice_id` cleared.
- **Print / PDF:** `a.btn[href="/print/invoice/<id>"]` opens the printable page in a new tab. No file is produced server-side.

## How to get to it (user POV)

- Sign in as `grace.holloway` → **Invoices** in the sidebar (`/invoices`). KPI cards: Ready to bill, Awaiting payment, Overdue; chips for status views.
- From a project page (`/projects/:id`), the billing card has a `[data-act=invoice]` button, "Invoice $X" or "New invoice". It opens the "New invoice" modal with the project filled in; it does not create a draft by itself.
- Search with ⌘K for the invoice code.

## Driving it with agent-browser

```bash
.claude/skills/verify-lims/scripts/api.mjs verify grace.holloway GET /api/invoices/unbilled     # [{id (project), code, title, tests, value}]
```

Signed in as Grace:

```bash
agent-browser open "$B/invoices?view=unbilled"
agent-browser wait 'button[data-bill]'
agent-browser screenshot $E/01-ready-to-bill.png
agent-browser click 'button[data-bill="<projectId>"]'
agent-browser wait 2000 && agent-browser get url                   # …/invoices/<id>
agent-browser eval 'document.querySelector(".toasts")?.innerText'   # "Draft INV-2026-… created"
agent-browser screenshot $E/02-draft.png
agent-browser click '[data-act=issue]'
agent-browser wait '.modal [data-ok]'      # confirm dialog; let it settle (SKILL.md) before clicking
agent-browser click '.modal [data-ok]'
agent-browser wait 1500 && agent-browser eval 'document.querySelector(".toasts")?.innerText'   # "Invoice issued"
agent-browser screenshot $E/03-issued.png
```

End state that proves it:

- **Screen:** badge SENT, "Issued <date> · due <date>" in the header meta, the line editor replaced by read-only lines, "Issue invoice" gone and "Mark paid" / "Void" present.
- **API:** `GET /api/invoices/<id>` returns `invoice.status = "Sent"`, `issued_date`, `due_date`, `lines[]` non-empty with `total` matching the Ready-to-bill value, `can.issue` and `can.edit` false, `can.paid` and `can.void` true. `GET /api/invoices/unbilled` no longer lists that project (or lists fewer tests). Each billed test (`GET /api/tests/<id>`) carries `invoice_id` = the new invoice.
- **Audit:** `GET /api/audit?q=<INV code>` (as daniel.okafor or priya.raman) shows `CREATE` "Draft invoice created" and `STATUS` "Invoice issued to client" (plus `UPDATE` "Draft invoice edited" rows only if the draft was edited), all by grace.holloway. `/api/audit/verify` is `ok: true`.
- **Refusals:** as `tom.fletcher`, POST `/api/invoices` returns 403 (no `billing.edit`). As Grace, PUT `/api/invoices/<id>` on a Sent invoice returns 400 "Issued invoices are locked. Void and re-issue to make changes."; POST `…/issue` on a Sent invoice returns 400 "Only draft invoices can be issued"; POST `…/void` without a reason returns 400 `REASON_REQUIRED`; POST `…/paid` on a Draft returns 400 "Only issued invoices can be marked paid"; POST `…/void` on a Paid invoice returns 400 "A paid invoice can't be voided". Prove the void-on-paid refusal only after reading back status Paid: on a Sent invoice the same call succeeds and voids it.

## Gotchas

- Issuing a draft with no lines is refused with 400 "Add at least one line before issuing". A hand-made invoice for a client with no approved work needs a manual line first.
- `[data-act=pull]` only appears while the project has further unbilled approved tests; its absence after "Create invoice" is expected.
- No invoice signature is involved: issue, paid and void are plain status changes with audit rows, not e-signatures. Void is the only one that asks for a reason.
- The `/print/invoice/:id` link opens a new tab; `agent-browser` stays on the invoice tab. To capture the printable page, `open "$B/print/invoice/<id>"` directly in the same session.
- The demo seed may already have invoiced most projects. If Ready to bill is empty, approve a test chain first ([review-approve.md](review-approve.md)); report that as the precondition rather than editing the database.
