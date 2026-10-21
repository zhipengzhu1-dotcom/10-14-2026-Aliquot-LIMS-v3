# Intake review

A received Sample waits for a decision before its Tests can be assigned. The decision is separate from the Sample's `status` (which stays `Received` and is derived from its Tests): `sample.intake` is `Pending review`, `On hold` or `Accepted`. Receipt, from the direct form or from a client Submission, always starts at `Pending review`. This map covers what exists so far: the state, the accept action, the assign/claim refusal, and the Receiving & Review screen with its Queue and sidebar badge. Hold, release and reject, the detail pane, feasibility and assigning from the screen come in later tickets of spec #48, and this map grows with them. Code: rules `SAMPLE_RULES.accept` and the Test gate in `TEST_RULES.assign` / `TEST_RULES.claim`, Queues `SAMPLE_QUEUES.intake` (rule `accept`) and `SAMPLE_QUEUES.ready` (rule `assign`) in `server/workflow.js`, routes, `acceptSample` and `acceptSamples` in `server/routes/intake.js`, the screen in `public/js/views/intake.js`, state names `INTAKE_PENDING`, `INTAKE_HOLD`, `INTAKE_ACCEPTED` in `server/lookups.js`. Permission `samples.review`: manager and scientist, the same roles as `tests.assign`; analysts, QA, business and the administrator are refused with 403.

## Sub-features

- Accept: `POST /api/samples/<id>/accept`, no body. Allowed while `intake` is `Pending review` or `On hold` and the Sample is open. Refused: 403 without `samples.review` (checked first), 400 "This sample is already accepted", 400 when the Sample is cancelled or otherwise closed, 404 for an unknown id. The Sample's `can.accept` says whether the signed-in person is offered it.
- The assign gate: while `intake` is not `Accepted`, `POST /api/tests/assign` and `POST /api/tests/<id>/claim` are refused with 400 "S-… has not been accepted at intake review yet — accept it before its tests are assigned or picked up". `can.assign` on the Sample and its Tests, `can.claim` on its Tests and `assignable` on the Sample are all empty or false until it is accepted.
- Receiving & Review: `GET /api/intake?tab=pending|hold|ready` (also `client_id`, `project_id`, `priority`, `overdue=1`, `q`) returns `{ tab, counts: {pending, hold, ready}, groups: [{ submission: {id, code, status, received_at} | null, samples: [...] }] }`. Each Sample is the usual Sample row plus `can` (every `SAMPLE_RULES` flag) and `locks` (the refusal message of each action the screen offers, `null` when allowed). Groups are the Submissions the Samples arrived in, in Queue order (due date, then priority); Samples received directly form one group with `submission` null. Pending review and On hold read `SAMPLE_QUEUES.intake`; Ready to assign reads `SAMPLE_QUEUES.ready` (accepted Samples with Tests left to assign). A person without `samples.review` (or, for Ready to assign, `tests.assign`) gets `groups: []` and zero counts. An unknown tab is 400.
- Bulk accept: `POST /api/samples/accept` with `{ "sample_ids": [..] }` applies the accept rule to each Sample on its own and answers 200 with `{ results: [{ id, code, ok, status?, error_code?, error? }], accepted, refused }`, in the order asked. A refusal (403 without the permission, 400 already accepted or cancelled, 404 unknown id) is that Sample's outcome and blocks none of the others. An empty list is 400.
- Sidebar badge: `GET /api/nav` has `intake`, the length of `SAMPLE_QUEUES.intake` for the person, shown on the sidebar item "Receiving & Review" (`a[data-nav=intake]`, `[data-badge=intake]`), visible only with `samples.review`.
- Tests on a Sample still waiting for review are not "unassigned work": `GET /api/tests?unassigned=1` (the Worklist Unassigned view), the Dashboard `kpis.unassigned` and the Workload `unassigned` count leave them out until the Sample is accepted.
- Each accept is audited twice: a STATUS entry on `samples` (`intake` Pending review → Accepted, summary "Sample accepted at intake review", with the person and time) and a CREATE entry on `intake_decisions` (the decision record: `decision`, `reason`, `decided_by`, `decided_at`).
- Samples that existed before the upgrade are `Accepted`. The demo lab is Accepted except its newest arrivals: the two Acme release Samples of the last few hours and the two Samples of the received Acme Submission, which wait Pending review.

## How to get to it (user POV)

Sign in as priya.raman and click "Receiving & Review" in the sidebar (Laboratory group, under Samples), or open `/samples/review` (`?tab=hold`, `?tab=ready`, filters `client`, `project`, `priority`, `overdue=1`, `q` live in the URL). The page is `public/js/views/intake.js`:

- Tabs `.segmented a` "Pending review", "On hold", "Ready to assign", each with its count; selects `[data-filter-client]`, `[data-filter-project]`, `[data-filter-priority]`, checkbox `[data-filter-overdue]`, search `[data-filter]` (debounced, reloads the list in place).
- One card per group, `[data-group="<submission id>|direct"]`, with a row `[data-row=<sample id>]` per Sample and a checkbox `[data-pick]` (`value` is the Sample id; the header `[data-all]` ticks the group).
- Per-Sample action `button[data-act=accept][data-id=<id>][data-code=S-…]`: enabled only when `can.accept`; when disabled it carries the refusal as `title` and as a visible `[data-why=accept]` line beside it (on the Ready to assign tab: "This sample is already accepted").
- Bulk: `[data-bulk=accept]` ("Accept selected (n)", disabled until something is ticked) opens a confirm dialog (`.modal [data-ok]`), then a card `[data-outcomes]` lists every Sample as Accepted or Refused with the server's reason; `[data-select-all]` ticks every Sample shown; `[data-dismiss]` closes the outcome card.
- A person without the permission (tom.fletcher) has no sidebar item; `/samples/review` shows the empty state "Nothing waiting for review".

To prove a bulk refusal in the browser, tick two Pending review Samples, then cancel one through the API (`POST /api/samples/<id>/cancel` with a reason) before clicking "Accept selected": the card shows one Accepted and one Refused ("Sample is cancelled and can't be accepted"), and the toast reads "1 sample accepted, 1 refused". Drive the API directly as a person with the permission:

```bash
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman GET '/api/samples?limit=50'      # pick a sample, then read its intake
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman GET '/api/samples/<id>'          # sample.intake, can.accept, assignable
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman POST '/api/samples/<id>/accept'
```

End state that proves it:

- **Screen:** after Accept the toast reads "S-… accepted", the Sample leaves Pending review, the tab counts and the sidebar badge drop by one, and the Sample appears under Ready to assign.
- **API:** `GET /api/samples/<id>` shows `sample.intake` `Accepted`, `can.accept` false and `assignable` listing its unassigned Tests.
- **Audit:** `GET /api/history/samples/<id>` has the "Sample accepted at intake review" entry under the accepting person's name.
- **Refusals:** as tom.fletcher the same POST returns 403 (the bulk POST returns 200 with `ok: false, status: 403` for each Sample); a second accept returns 400; assigning a Test of a Pending review Sample returns 400 naming intake review (`api.mjs verify priya.raman POST /api/tests/assign` with `{"test_ids":[<id>],"analyst_id":<id>}`).

## Gotchas

- Seeded Pending review Samples: the demo opens with 4 in the Queue (badge 4 for priya.raman), two of them the received Submission SUB-2026-0001. The Ready to assign tab starts empty because every other seeded Sample already has its Tests assigned; accepting one makes it appear there.
- The sweep in `test/agreement.test.js` builds Pending review Samples with `receiveSample({ pendingReview: true })`; every other helper in `test/` accepts the Sample straight after receipt.

## Review values and corrections (#54)

Code: `GET /api/intake/samples/<id>/review` in `server/routes/intake.js` (needs `samples.review`: 403 without it, 404 for an unknown Sample), computed by `reviewValues` in `server/intake-values.js`; the pane `public/js/views/intake-review.js` (`openReview`) with its values section in `public/js/views/intake-values.js`; `intakeHistory` for the Sample detail.

- Review keys (values half): `sample` {id, code, intake, status}; `submitted` null for a Sample received at the front desk, else `{ submission: {id, code, status, received_at, notes, courier, tracking_no, ship_date}, row }` (the client's stored row for this Sample); `current` (the Sample's values now); `fields` [{ key, label, submitted, current, changed }] (`submitted` null without a Submission; a row inherits the Submission's sample type, turnaround and storage); `condition` {condition, storage, location, received_at, received_by_name, receipt_note}; `details` {notes, submission_notes, sheet: [{label, value}]}; `thread` null or {id, subject, status, messages: [{author_name, body, kind, side: client|lab|system, created_at}]}; `corrections` {can, locks (edit, addTests), reason_required, tests: [{id, code, status, method_code, method_version, method_title, can, locks}]}.
- Corrections use the existing actions: `PUT /api/samples/<id>` (description, batch_no, client_ref, priority, storage; a reason is required once `status` is not Received), `POST /api/samples/<id>/tests` `{method_ids}`, `POST /api/tests/<id>/cancel` `{reason}` (needs `tests.cancel`, manager only: a scientist sees `corrections.tests[].can.cancel` false and the refusal in `locks.cancel`). Each is audited with old and new value (`/api/history/samples/<id>`, `/api/history/tests/<id>`).
- Sample detail: `GET /api/samples/<id>` has `intake` `{ state, decisions: [{ id, decision, reason, decided_by_name, decided_at }] }`, newest first.
- Screen: on Receiving & Review each row has `button[data-review=<sample id>]` which opens the pane (`.modal.intake-review`, `[data-section=values]`). Table `[data-values]` rows `[data-field=<key>][data-changed=true|false]`; `[data-edit-sample]` opens the correction form (`name=batch_no`, `priority`, `reason`...; a refusal shows inline); `[data-add-test]` opens `select[name=method_id]`; each Test row `[data-test=<id>]` has `[data-cancel-test=<id>]` (opens the reason dialog); disabled actions show their refusal in `[data-why]`; `[data-thread]` lists the messages. The Sample page (`/samples/<id>`) has an "Intake review" card with `[data-intake-history]`.
