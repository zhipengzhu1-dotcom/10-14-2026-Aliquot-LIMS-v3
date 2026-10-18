# Enter results and submit a test

An analyst opens a test assigned to them, types results (checked live against specification), records the instrument, and e-signs "Performed" to submit it for peer review. Code: `public/js/views/tests.js`, rules in `TEST_RULES` (`server/workflow.js`). Statuses: Pending → In Progress → Submitted → Reviewed → Approved, or Cancelled. The header buttons come from the test's `can` flags (`GET /api/tests/:id` → `can`), so a button is shown when the server's rule for that action allows it. Submit still re-checks pending results, materials, the instrument and the password on the server, which `can` does not show. A reviewer's or approver's return sends the test back to In Progress.

## Sub-features

- Start a test (`[data-act=start]` "Start test", only for the assigned analyst on a Pending test, while their qualification on the method is current) or pick up an unassigned Pending one (`[data-act=claim]` "Pick up this test", only for someone qualified on the method). Both need `tests.perform`, which QA lacks. Toasts: "Test started", "Test assigned to you".
- Numeric results with a live outcome in `td[data-outcome]` as you type: "Pass", "OOS" for a failing value, "Not a number", "Reported" when the analyte has no limits. Text results get no live check (`evaluate` in `tests.js` returns null for them), so their outcome cell only changes after a save. A text result with a specification text has a Conforms / Does not toggle (radio values `Pass` / `Fail`) and stays Pending until one is ticked; without a specification it is "Reported".
- Instrument (`select[name=instrument_id]`), required unless the technique is Physical / Visual or Gravimetric. Instruments out of calibration, Out of Service or in Maintenance are disabled, and Retired ones are not listed. The exception is the instrument already recorded on the test, which stays listed and selectable whatever its state. In the demo seed, instrument 3 (HPLC-03) is disabled because its calibration is overdue (`cal_state: "overdue"`), even though `GET /api/instruments/3` reports `status: "Available"`.
- Standards, reagents and columns (`input[name=material_ids]`), raw data reference (`input[name=raw_data_ref]`), comments (`textarea[name=comments]`).
- Save (`button[data-save]`, PUT `/api/tests/:id`, moves Pending to In Progress).
- Save & submit (e-sign "Performed", POST `/api/tests/:id/submit`). It saves first, then refuses if any result is still Pending, so a refused submit has already written the save's audit row (and moved a Pending test to In Progress). A failing result opens an OOS investigation automatically, unless the test already has an open one.
- Changing a recorded result asks for a reason: modal `textarea[name=reason]`, then "Continue".
- Files (`TEST_RULES.attach`): only the assigned analyst, or someone who assigns tests, may attach, and only while the test is Pending or In Progress, so a returned test accepts files again. Once it is Submitted, Reviewed, Approved or Cancelled the Files panel shows "The test is <status> — attachments are locked" ("The test is submitted — …" after submitting) instead of the drop zone. Anyone else sees "Only the assigned analyst can attach files to this test".

## How to get to it (user POV)

- Sign in as `tom.fletcher` → **Worklist** in the sidebar (`/worklist`, defaults to "My tests") → click the test code `a.code[href="/tests/<id>"]`. My tests leaves out tests whose method the analyst's qualification has lapsed on.
- From a sample page (`/samples/:id`), click a test row.
- Search with ⌘K for the test code.

## Driving it with agent-browser

Find an open test first. Tom's list is usually short, and IDs change with the seed date:

```bash
.claude/skills/verify-lims/scripts/api.mjs verify tom.fletcher GET '/api/tests?scope=open&work=assigned'
.claude/skills/verify-lims/scripts/api.mjs verify tom.fletcher GET /api/tests/<id>    # results[].id, result_type, spec; instruments[]
```

Example from one seed (test 276, FTIR, one text result `518`, instrument 10 = Thermo Nicolet iS20). On 2026-10-05 the same steps proved a Pending Dissolution test with two numeric results and instrument 11. In the browser, Save & submit works straight from Pending, because it saves first and the save moves the test to In Progress. A direct POST `/api/tests/:id/submit` on a Pending test returns 400 ("Only tests in progress can be submitted").

```bash
agent-browser open "$B/tests/276"
agent-browser wait '.r-input[data-rid="518"]'
agent-browser screenshot $E/03-test-before.png
agent-browser fill '.r-input[data-rid="518"]' 'Conforms to reference spectrum'
agent-browser click 'label:has(input[name="o-518"][value=Pass])'      # text results need Conforms ticked
agent-browser select 'select[name=instrument_id]' 10
agent-browser click '.btn-group button[data-act=submit]'               # "Save & submit for review"
agent-browser wait '.modal input[name=password]'
agent-browser fill '.modal input[name=password]' demo1234
agent-browser click '.modal-foot button[data-submit]'                  # "Sign & submit"
agent-browser wait 1500
agent-browser eval 'document.querySelector(".toasts")?.innerText'      # "Submitted for review"
agent-browser screenshot $E/05-test-submitted.png
```

For numeric results, `fill '.r-input[data-rid="<id>"]' 99.8` and read `td[data-outcome]`. A missing instrument shows the error toast "Choose the instrument you used before submitting". Error toasts stay about 8.4 s and success toasts 4.2 s (`toast()` in `ui.js`), and they cover the header buttons; wait for `!document.querySelector(".toast.error")` before retrying.

End state that proves it:

- **Screen:** the badge reads SUBMITTED, the stepper is on Submitted, the Signatures card shows "Performed · Tom Fletcher", the result shows PASS, and the Files panel reads "The test is submitted — attachments are locked".
- **API:** `GET /api/tests/<id>` returns `test.status = "Submitted"`, `test.submitted_at` set, `test.instrument_id` set, a last `signatures[].meaning` of "Performed", and `can.edit` and `can.attach` false. A test that was returned earlier also carries older signatures. `GET /api/attachments?entity=tests&id=<id>` returns `can.attach: false` and the lock message in `locks.attach`.
- **Audit:** `GET /api/audit?q=<test code>` (as daniel.okafor) shows "Results recorded", `SIGN Signed: Performed` and `STATUS Submitted for review`, all by tom.fletcher. "Results recorded" is a `STATUS` row when the test was Pending and an `UPDATE` row when it was already In Progress. A save that changed no result line writes "Test details updated" instead, or no row when nothing changed at all. `GET /api/audit/verify` returns `ok: true`.
- **OOS path:** a failing result shows the toast "Submitted. OOS investigation <code> opened", and the test's `investigations[]` is non-empty. See [oos-investigation.md](oos-investigation.md).

## Gotchas

- **Behavior** (`app.css`: `.conform input { display: none; }`). The Conforms / Does not radios are not displayed; only their labels `label.p` / `label.f` are. A click on the `input` fails (agent-browser has reported it as "covered by div.route-progress", but the cause is the `display: none`). Click the `label:has(...)` instead.
- **Hypothesis** (not re-checked; CSS uppercases button text, see SKILL.md, which may be why a text search misses it). `agent-browser find text 'Save & submit for review'` does not find the button. Use `.btn-group button[data-act=submit]`. When the test is already In Progress, the header has a second `[data-act=submit]` ("Submit for review"), so scope to `.btn-group`.
- **Behavior** (`server/auth.js`; proven live 2026-10-18). A wrong password keeps the modal open with "Incorrect password — signature not applied" in `.modal .form-error`. Five failures lock the account for 15 minutes, and signature failures count toward the five. While locked, a signature returns 423.
- **Behavior** (`tests.js`). Submit refuses with the error toast "Complete every result first: <analytes>" until every result has a value (a text result with a specification also needs Conforms or Does not), and opens no modal. Read `.toasts` within about 8 s of the click.
- **Behavior** (`tests.js`). `/tests/:id` has a `beforeunload` guard when results are dirty. A full `open` or `reload` with unsaved input triggers a native dialog that blocks automation, so save first.
- **Behavior** (`TEST_RULES.review`). Analysts cannot review: POST `/api/tests/:id/review` as tom.fletcher returns 403 FORBIDDEN. The reviewer must also differ from the analyst, and the approver from both.
