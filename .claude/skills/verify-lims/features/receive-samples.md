# Receive samples

Log a delivery from a client: one form for the delivery, a row per sample (or paste rows from a spreadsheet), and the tests to run on each. Aliquot assigns sample codes `S-YYYY-NNNN` and creates one Pending, unassigned test `T-YYYY-NNNNN` per sample per method. Code: `public/js/views/samples.js` (`receive`, `showReceived`), server `receiveSamples` in `server/routes/lab.js`. Permission `samples.receive`: admin, manager, scientist, analyst. QA and the business role are refused with 403.

## Sub-features

- Delivery fields:
  - `select[name=client_id]` (required; active clients only, preselected by `?client=<id>`), then `select[name=project_id][data-project]`, which fills in after a client is chosen. It lists only that client's open Projects (Quoted, Active, On Hold), picks the one automatically when there is exactly one (unless `?project=<id>` names one), and reads "No open projects for this client" when there are none.
  - `select[name=sample_type]`, `select[name=condition]`, `select[name=storage]`, `input[name=location]`, `input[name=received_at]`, `textarea[name=notes]`.
  - Turnaround `a[data-p="Same day|Next day|3 days|One week"]`, One week active. Due date is receipt + 0, 1, 3 or 5 working days; the surcharge (Settings, default 200, 100, 50, 0 %) of the selected tier shows in `[data-prio-hint]` beside the label, blank on One week ("· +100%" after clicking Next day; proven live 2026-10-18). The Receive dialog on a portal submission has a `select[name=priority]` "Shipment turnaround" defaulting to the tier the client asked for, or to One week when that tier is retired (the hint then says so).
- Sample rows `tbody[data-rows] tr`:
  - Inputs `input[data-k=description|product_code|batch_no|client_ref|quantity|container]` and `select[data-k=stage]`, aria-labels like "Description row 1", "Product code row 1", "Stage row 1" and "Batch row 1". Description is required for every non-empty row.
  - `[data-act=add]` "Add row", `[data-act=add5]` "Add 5 rows", `[data-act=fill]` "Copy first description down", delete with `button[data-del="<i>"]` (aria-label "Remove row").
  - `[data-act=paste]` "Paste from spreadsheet": a modal with `textarea[name=text]`, `select[name=headings]` "Heading row" (`auto` "Find it automatically", the default; `first` "First row is column headings"; `none` "No headings: every row is a sample") and the button "Add rows". It reads headings through `public/portal/sheet.js` with `LAB_FIELDS`. On `auto` the heading row is looked for in the first 5 rows, so a title row above it is skipped, and a one-row paste is always a sample (proven live 2026-10-21, #20). When `auto` finds no heading row, the columns follow that list's order: Description, Batch, Client reference, Quantity, Container, Product code, Stage. The two other choices only say whether row 1 is headings; the columns keep the uses the automatic guess gave them (`withHeader` in `sheet.js`, proven live 2026-10-21). So `none` on `Qty / Batch / Name` plus a row `x3 / L9 / Reorder` adds the heading row as a sample whose Description is "Name" (the Name column) and Quantity is "Qty", not Description "Qty". `first` always takes row 1 as the headings, so with a title above the real headings the title is dropped and the real headings come in as a sample: `Intake form / Name⇥Lot / Aspirin⇥L1` gives 1 row on `auto`, 3 on `none` (title, headings, Aspirin) and 2 on `first` (headings, Aspirin). The modal's help text names only the first five, and a one-column paste is read as descriptions. Unknown columns stay on the row as the client's extra detail (`input[type=hidden][data-k=details]`, shown as `.row-details` under the description).
- Tests: checkboxes `input[name=method_ids]` in `label.method-opt`, filter `input[data-mfilter]`. Due date `input[name=due_date][data-due]`. Summary counters `[data-s=samples|methods|tests|codes]`, plus `[data-s=value]` "est. value" only for people with `billing.view` (absent for tom.fletcher, proven live 2026-10-18). The form is `novalidate`: the browser never blocks submit, the page's own checks do.
- Labels: "Print N label(s)" (`[data-act=labels]`) opens `/print/labels` in a new window. It is on the result screen after receiving, not on the form.

## How to get to it (user POV)

- **Samples** in the sidebar → the "Receive samples" button in the page head (`a.btn[href="/samples/receive"]`). The bare `a[href="/samples/receive"]` first matches the hidden copy in the New menu.
- Top bar **New** menu → Receive samples.
- The Dashboard's "Receive samples" button.
- A client's page (`/clients/:id`): `a.btn[href="/samples/receive?client=<id>"]` pre-selects the client.
- A Project's page (`/projects/:id`): `a.btn[href="/samples/receive?client=<id>&project=<id>"]` pre-selects the client and the Project. It is offered only from the Project's `can.receive`, so a Completed or Cancelled Project has no such button.
- From the staff Client portal inbox, on `/portal-inbox/submissions/:id`: `button[data-act=receive]` "Receive samples" is offered from the submission's `can.receive`, while it is Submitted or Acknowledged and to someone with `samples.receive`. It opens a modal "Receive N sample(s) from SUB-…". It has `input[name=received_at]` (now), `select[name=condition]` (Acceptable), `select[name=storage]` (the submission's storage; clients have no storage of their own, proven live 2026-10-18 on SUB-2026-0003), `input[name=location]`, `select[name=project_id]` (the client's open Projects, the submission's preselected), `select[name=priority]` (see Turnaround above), `input[name=due_date]` (empty means from the tier), `input[name=method_ids]` inside `label.check` (not `label.method-opt`; the methods the client asked for are pre-ticked) and `textarea[name=notes]`. Click "Receive & create samples" (`.modal-foot button[data-submit]`). The result is the toast "Received as S-…", not the "N sample(s) received" screen.

## Driving it with agent-browser

```bash
agent-browser open "$B/samples/receive"
agent-browser wait 'form[data-receive] select[name=client_id]'
agent-browser select 'select[name=client_id]' <client id>     # ids: api.mjs verify tom.fletcher GET /api/clients
agent-browser fill 'input[aria-label="Description row 1"]' 'Verification batch A'
agent-browser click 'label.method-opt:has(input[name=method_ids][value="<method id>"])'
agent-browser click 'form[data-receive] button[type=submit]'  # "Receive samples"
agent-browser wait 1500
agent-browser screenshot $E/receive-done.png
```

End state that proves it:

- **Screen:** heading "N sample(s) received", and a "Samples logged" card of `a.code[href="/samples/<id>"]` links.
- **API:** `GET /api/samples/<id>` returns `{sample, tests, assignable, custody, notebook, investigations, signatures, details, can}` (`details` is the client's extra detail, `[]` when none): `sample.status` is `Received`, `custody[].action` includes "Received", and each of `tests[]` is `Pending` with `analyst_id` null.
- **Audit:** `CREATE` "Sample received" on `samples` for each sample, and `CREATE` "ATM-xxxx vN requested on S-…" on `tests` for each test.
- **Refusals:**
  - POST `/api/samples/receive` as daniel.okafor returns 403.
  - The server checks the rows too: none gives 400 "Add at least one sample" (the Project is checked first, so an empty list into a Completed Project gets the Project's message), and more than 200 gives 400 "At most 200 samples at a time" (proven live 2026-10-18 with 201 rows).
  - Receiving into a Completed Project, as someone allowed to receive, returns 400 ("That project is completed — reopen it before adding samples to it"); a Cancelled one gives "That project is cancelled — samples can't be added to it", and another client's Project "That project belongs to a different client". The demo lab has a Completed Acme Project, so no setup is needed: look it up with `GET /api/projects?client_id=<id>&status=all`. Editing a Sample into a closed Project is refused the same way.

## Gotchas

- **Behavior** (`samples.js`). With no method ticked, a confirm modal opens. Click "Receive without tests" (`[data-ok]`). It is an in-DOM modal, not a native dialog.
- **Harness quirk** (proven live 2026-10-18: the next submit click was refused while the toast was up). Validation errors are error toasts, not inline: "Choose the client", "Add at least one sample", "Every sample needs a description". An error toast stays about 8.4 s (twice `toast()`'s 4200 ms, `ui.js`) and `.toast.error` covers the submit button. Wait with `agent-browser wait --fn '!document.querySelector(".toast.error")'` before clicking submit again.
- **Hypothesis** (the checkbox is visible, `.method-opt input` in `app.css`, so a direct click may work too; only the label click is proven). Click the `label.method-opt` that contains the method checkbox.
- **Behavior** (`receiveSamples` in `server/routes/lab.js`). The new tests are unassigned. To continue into [test-results.md](test-results.md), assign one as sarah or priya: `/worklist?view=unassigned` → tick `td.sel input[data-id="<test id>"]` → `[data-act=assign]` (disabled until a row is ticked) → click `.modal input[name=analyst_id][value="<user id>"]` (one radio per person, labelled with the name; untrained people are disabled) → "Assign". Toast: "1 test assigned". The analyst must be trained on the method; Tom is trained on ATM-0001, 0002, 0004, 0006 and 0012.
