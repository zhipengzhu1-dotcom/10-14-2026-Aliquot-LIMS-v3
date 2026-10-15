# Client portal

A separate sign-in at `/portal/` where a client's contacts follow their own samples, download issued CoAs, submit samples and message the lab. Each contact only sees their own company's records. Code: `public/portal/portal.js` (hash routes), server `server/routes/portal.js`, staff side `public/js/views/portal-inbox.js`.

## Sub-features

- Sign-in card: form `#signin` with `input[name=email]`, `input[name=password]` and `#signin button[type=submit]` "Sign in". Below it is one demo button per contact: `button[data-demo="customer@example.com"]` (Dr. Laura Chen, Acme), `felix.romero@bluestone-bio.example` (Bluestone) and `hannah.schultz@northwind-tx.example` (Northwind). A first sign-in with a temporary password lands on form `#pw` "Choose your password".
- Samples: `#/samples?tab=open|reported|all|shipments`, detail at `#/samples/<id>`, CoA at `#/coa/<id>`. A submission's detail is `#/submissions/<id>`.
- Submit samples (`#/submit`, "Tell us what is coming") is a packing-slip form `#submission`:
  - Sample rows `li[data-row]` in `.js-rows`. Each has `input[name="s.description"]` (aria-label "Sample description"; at least one row needs one) and a `.js-more` link "Add batch, quantity, container" that reveals `s.batch_no`, `s.client_ref`, `s.quantity` and `s.container`. `.js-add` is "Add another sample"; `.remove` drops a row.
  - `.js-paste` "Paste a list" opens `textarea.js-paste-text` (one sample per line). `.js-paste-add` "Add these" replaces the empty rows with one row per line.
  - Tests are chips, `label.chip input[name=method_ids]`, with a filter `input.js-filter` when there are more than six methods. The send bar's `.js-count` reads "Name at least one sample to send" with no named sample, "2 samples" with no tests, "2 samples · 1 test on each" with tests, and "1 sample · 2 tests" for one sample.
  - Priority is the radio group `input[name=priority]`, Standard checked. `.js-priority-hint` follows the `PRIORITY_HINT` table: Standard "Normal turnaround", Rush "Faster, may cost more", Urgent "We call you first".
  - Optional details come from the `EXTRAS` table and stay hidden until their "+" chip is clicked: `button[data-show=project|sample_type|storage|shipping|notes]` ("+ Project", "+ Sample type", "+ Storage", "+ Courier & tracking", "+ Note to lab") reveals `fieldset[data-extra=<key>]`, and its `.js-hide` "Remove" clears and hides it again. The Project chip appears only when the client has open Projects.
  - Fields inside the extras: `select[name=project_id]`, `select[name=sample_type]`, `select[name=storage]`, `input[name=courier]`, `input[name=tracking_no]`, `input[name=ship_date]`, `textarea[name=notes]`. The project list holds only the client's open Projects (Quoted, Active, On Hold), from `GET /api/portal/lookups` → `projects`; a closed Project, or another client's, is refused with 400 "Project not found". On `#/submissions/<id>` a picked Project shows as `.js-project` ("Project": code in mono, then title) above Priority; no row when none was picked.
  - `#submission button[type=submit]` is "Send to lab". With no description the form shows "Tell us what at least one sample is." and sends nothing.
- Confirmation: after sending, the portal goes to `#/submissions/<id>?sent=1`. While the submission is open, that page shows `.label-card` with the number in `.label-card .big` and the buttons `.js-copy` "Copy number" and `.js-print` "Print"; a "What happens next" card with the status pill and `ol.timeline`; and the links "Your shipments" and "Send another". Without `?sent=1`, or once the submission is closed, the same route shows a normal page head with the code as `h1` and a "Conversation" link.
- Timeline (`SUBMISSION_STEPS`): "Sent to the lab" → "Lab is expecting it" → "Box received". It ends at Received; after that each sample has its own progress, linked under "Logged as S-…". A Declined or Withdrawn submission stops after its last reached step, with an extra `li.stop` row. The `SUBMISSION` table gives each status its pill: Submitted "Sent to lab", Acknowledged "Expected", Received "Received", Declined "Declined", Withdrawn "Withdrawn". Look for "Expected" on screen and `Acknowledged` in the API.
- Withdraw a submission: while `can.withdraw` is true (`GET /api/portal/submissions/<id>` → `can`; true while Submitted), the status card shows "Sent by mistake? Withdraw SUB-…. Available until the lab confirms.", where "Withdraw SUB-…" is the link-button `.js-withdraw`. Toast "Submission withdrawn"; the pill becomes Withdrawn, the timeline ends with "You withdrew this shipment…", and the line goes.
- Requests for method development, validation, transfer or other work: `#/requests`, new at `#/requests/new` (form `#request`, "Send request"). The client's request detail is read-only. The lab moves a request only forward: Submitted → Under review → Proposal sent → Accepted (a proposal can also go straight from Submitted), or Declined while open; Accept only from Proposal sent, and a response that keeps the status is a reply.
- Messages:
  - `#/messages` lists threads.
  - "New" (`.threads-card a[href="#/messages/new"]`; the bare selector matches more than one link) opens form `#newthread` with `input[name=subject]`, `select[name=sample_id]` and `textarea[name=body]`, then "Send".
  - Reply with form `#reply` and its `textarea[name=body]`. Cmd/Ctrl+Enter sends.
- Account (`#/account`, which also has its own `button.js-out` "Sign out") and sign-out: `button.avatar.js-me`, then `button.js-signout`.

## How to get to it (user POV)

- Open `<base>/portal/` and sign in as a client contact.
- Navigate with the top nav: `.nav a[data-nav=overview|samples|submit|requests|messages]`. Below desktop width `.nav` is hidden; use `nav.tabbar a[data-nav=…]` instead.
- Staff see the other side under **Client portal** in the sidebar (`/portal-inbox`). It opens on Messages. Submissions are at `/portal-inbox?tab=submissions` (open ones by default), and a submission's detail is at `/portal-inbox/submissions/<id>`, with Acknowledge, Decline and "Receive samples" (`button[data-act=receive]`) offered from its `can` flags. Acknowledge and Decline need `portal.respond` (manager, QA, scientist, business); Receive needs `samples.receive` (admin, manager, scientist, analyst). On an open submission priya.raman sees all three, tom.fletcher only Receive, and grace.holloway and daniel.okafor get `can.receive: false`, so no "Receive samples". Requests are at `/portal-inbox?tab=requests` and `/portal-inbox/requests/<id>`.

## Driving it with agent-browser

```bash
agent-browser open "$B/portal/"
agent-browser wait --fn '!document.getElementById("splash")'   # the splash can cover the demo buttons after they render
agent-browser wait '[data-demo="customer@example.com"]'
agent-browser scrollintoview '[data-demo="customer@example.com"]'
agent-browser click '[data-demo="customer@example.com"]'
agent-browser wait 'header.top nav.nav a[data-nav]'
agent-browser tab new "$B/portal/#/"                           # clicks stop landing in the sign-in tab (see Gotchas)
agent-browser wait 'header.top nav.nav a[data-nav]'
agent-browser click '.nav a[data-nav=submit]'
agent-browser wait '#submission input[name="s.description"]'
agent-browser fill '#submission input[name="s.description"]' 'Portal verification sample'
agent-browser click '#submission button[type=submit]'          # "Send to lab"
agent-browser wait '.label-card .big'                          # "SUB-YYYY-NNNN"
agent-browser eval 'location.hash'                             # "#/submissions/<id>?sent=1"
```

End state that proves it:

- **Screen:** `#/submissions/<id>?sent=1` with the code in `.label-card .big`, the pill "Sent to lab", "Sent to the lab" as the current timeline step, the Withdraw line, and the links "Your shipments" and "Send another".
- **API:** as a staff user, `GET /api/portal-admin/submissions` lists the new code with status `Submitted`, and `GET /api/portal-admin/threads` has an automatic thread "Sample submission SUB-…".
- **Messages:** after sending, the new `.msg.client .bubble` appears in `#msgs`. The staff badge is `[data-badge=portal]` in the sidebar, the same number as `GET /api/nav` → `portal`. It counts Submitted submissions, Submitted method requests, and threads with unread client messages. A new submission without notes adds 1, because its automatic thread holds only a system event; with notes it adds 2, because the notes are posted as a client message. A new client thread adds 1. Withdrawing takes the submission's 1 off again.
- **Isolation:** a contact from another company (e.g. `felix.romero@bluestone-bio.example`) must not see Acme's records. Under Felix's portal session:
  - GET `/api/portal/samples/<acme id>`, `/samples/<id>/coa`, `/threads/<id>`, `/submissions/<id>` and `/requests/<id>` return 404, and so do POST `/threads/<id>/messages` and POST `/submissions/<id>/withdraw`.
  - His lists hold only Bluestone's rows, and some are empty in the seed: `/api/portal/samples` defaults to open samples and returns `[]`, while `?status=all` returns his 3 samples; `/api/portal/submissions` may be empty. Check that no list contains Acme codes or subjects.
- **Withdraw:** the API then returns `status: "Withdrawn"` and `can.withdraw: false`; the staff list `GET /api/portal-admin/submissions?status=Withdrawn` holds it and the default open list does not; the audit has `STATUS` on `portal_submissions` "Withdrawn by the client". A second withdraw returns 400 ("This submission is withdrawn — contact the laboratory to change it").

## Gotchas

- The portal uses its own cookie and session, separate from the staff app's. Signing in to one does not sign in to the other.
- The nav links render twice (desktop `.nav` and mobile `nav.tabbar`). Scope selectors to `.nav` on desktop and to `nav.tabbar` at phone width.
- On desktop the sticky `.send-bar` can cover the "+" chips, and agent-browser refuses the click. Scroll the chip into view first.
- "Withdraw" on a submission (`.js-withdraw`) calls native `confirm()`, which blocks automation. Before clicking, run `agent-browser eval 'window.confirm=()=>true'`.
- Portal toasts are a single `.toast` element, not the Staff app's `.toasts`: `agent-browser eval 'document.querySelector(".toast")?.innerText'`.
- The portal shows a splash and an `.arrive` animation, plus skeleton loaders after about 160 ms. Wait for content selectors, not fixed times.
- `scripts/api.mjs` signs in through the staff login only. For portal API reads, sign in yourself and keep the jar in the run folder so cleanup removes it:
  ```bash
  curl -s -c .verify/runs/verify/portal-acme.jar -H 'X-Requested-With: aliquot' -H 'Content-Type: application/json' \
    -d '{"email":"customer@example.com","password":"demo1234"}' "$B/api/portal/login"
  curl -s -b .verify/runs/verify/portal-acme.jar "$B/api/portal/submissions"
  ```
  Every non-GET needs `X-Requested-With: aliquot`, or the server answers 403. A portal cookie gets 401 on staff endpoints.
- **Input wedge after the demo sign-in.** In the tab where the demo sign-in was clicked, agent-browser's later clicks soon stop reaching the page. They still report `✓ Done`, but nothing happens: nav links don't change `location.hash`, "Add another sample" adds no row and test chips don't tick. `fill`, `eval` and `open` keep working, so a filled description is no proof that clicks land. Visiting `#/submit` is not the trigger; the wedge shows up without it. Right after signing in, open a fresh tab with `agent-browser tab new "$B/portal/#/"` and drive everything there; the portal session carries over, and clicks in the new tab keep working through `#/submit` and after it. Check `agent-browser eval 'location.hash'` after each navigation click. The cause is not known.
