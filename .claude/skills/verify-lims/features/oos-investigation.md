# OOS investigations: auto-raise, record, QA close

An out-of-specification result opens an investigation automatically when the analyst submits the test. QA (or a manager) records root cause, impact and CAPA, picks a conclusion, saves, then e-signs to close. Closing locks the record and unblocks approval of the related result. Code: `public/js/views/investigations.js`, rules in `INVESTIGATION_RULES` (`server/investigations.js`), auto-raise in `submitTest` (`server/workflow.js`). Statuses: Open → Under Investigation → CAPA → Closed. Codes look like `OOS-2026-001`; other types have their own prefixes: OOT `OOT-`, Deviation `DEV-`, Lab Incident `INC-`, Client Complaint `CC-` (`server/lookups.js`).

## Sub-features

- **Auto-raise on submit:** a failing numeric result (or a text result marked "Does not", radio value `Fail`) submitted from `/tests/:id` opens an OOS investigation of severity Major and shows the toast "Submitted. OOS investigation <code> opened". It is raised only when the test has no open investigation yet (`submitTest` in `server/workflow.js`). The test's `investigations[]` becomes non-empty. On the now Submitted test `approve-ok` is absent; once the test is Reviewed, the approver sees it disabled while the investigation is open.
- **Raise by hand:** `/investigations` → `button[data-act=new]` "Raise investigation" (needs `investigations.raise`: analyst, scientist, manager, QA). Form fields `select[name=type]` (default Deviation, or OOS when raised from a test), `select[name=severity]` (default Minor), `input[name=title]`, `textarea[name=description]`, `select[name=owner_id]` ("Lab manager decides" when empty), `input[name=due_date]` and `select[name=instrument_id]`. The test, sample and project links are hidden inputs prefilled by the page the form was opened from (`newInvestigation(prefill)` in `investigations.js`); from `/investigations` they are empty. Modal button "Raise".
- **Record the investigation:** on `/investigations/:id`, the `form[data-inv]` has `textarea[name=root_cause]`, `textarea[name=impact]`, `textarea[name=capa]`, `select[name=conclusion]`, `select[name=status]` (stage, never Closed), `select[name=owner_id]`, `input[name=due_date]`, `select[name=severity]`, then `form[data-inv] button[type=submit]` "Save" (PUT `/api/investigations/:id`). Toast "Investigation saved". Anyone with raise or close rights may edit while it is open; a Closed investigation is locked (400 "Closed investigations are locked"). After closing, `form[data-inv]` stays in the page as a read-only container (no inputs, no Save), so its presence does not mean the investigation is editable.
- **Close:** `[data-act=close]` "Close investigation" is shown from `can.close` (needs `investigations.close`: QA and manager; the person who performed the test under investigation is refused). The button first checks root cause and conclusion are filled, saves the form, then opens the e-sign modal (meaning `investigation.close.oos`, confirm "Sign & close", optional closure comment) and POSTs `/api/investigations/:id/close`. Toast "Investigation closed".
- **From the test page:** `/tests/:id` has `[data-act=investigate]` "Raise investigation" inside the More actions dropdown (`button[data-dd][aria-label="More actions"]`, then `.dropdown-menu button[data-act=investigate]`), and its Investigations card has `[data-act=close-investigation]` "Close" for an open one. That close modal requires `textarea[name=root_cause]` and `textarea[name=conclusion]` (free text here, not the select of the investigation page; no separate comment field), which go in the close POST body.
- **Results table:** when linked to a test, the page shows that test's results with the failing row in `tr.row-fail`.

## How to get to it (user POV)

- Sign in as `daniel.okafor` → **Investigations** in the sidebar (`/investigations`, filter chips by status; the sidebar badge counts open ones) → click the reference `a.code[href="/investigations/<id>"]`.
- From the test page: the open investigation is linked in the Investigations card. The red notice "Investigation <code> is open — this result cannot be approved until it is closed." with its link shows only to the approver of a Reviewed test (`can.return` and not `can.accept`).
- From a sample page: the out-of-specification notice links each open investigation by its code ("Investigation OOS-… is open."), and the Investigations card lists it as `li.link[data-href="/investigations/<id>"]`.
- Search with ⌘K for the OOS code.

## Driving it with agent-browser

Find an open OOS first. The demo seed ships at least one; otherwise submit a failing result as Tom ([test-results.md](test-results.md)) to create one. Never insert a row to make one: a missing precondition is reported, not worked around.

```bash
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET '/api/investigations'       # or ?status=open, which returns every investigation that is not Closed, including "Under Investigation"
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET /api/investigations/<id>     # investigation.{status,test_id,root_cause,conclusion}, can.{edit,close}
```

On the 2026-10-14 seed this was id 5, `OOS-2026-003`, Under Investigation, on test 245.

Then, signed in as Daniel:

```bash
agent-browser open "$B/investigations/<id>"
agent-browser wait 'form[data-inv]'
agent-browser screenshot $E/01-oos-open.png
agent-browser fill 'textarea[name=root_cause]' 'Phase I: standard preparation error confirmed (wrong dilution). Lab error proven.'
agent-browser fill 'textarea[name=impact]' 'Single result on this test only; no other batches affected.'
agent-browser fill 'textarea[name=capa]' 'Retrain on dilution scheme; add second-person check to the worksheet.'
agent-browser select 'select[name=conclusion]' 'Invalidated — assignable laboratory error'   # OOS options: Confirmed OOS — result valid · Invalidated — assignable laboratory error · Inconclusive — escalated to client · Not applicable
agent-browser click 'form[data-inv] button[type=submit]'
agent-browser wait 1200 && agent-browser eval 'document.querySelector(".toasts")?.innerText'   # "Investigation saved"
agent-browser click '[data-act=close]'
agent-browser wait '.modal input[name=password]'
agent-browser screenshot $E/02-oos-sign-modal.png
agent-browser fill '.modal input[name=password]' demo1234
agent-browser click '.modal-foot button[data-submit]'
agent-browser wait 1500 && agent-browser eval 'document.querySelector(".toasts")?.innerText'   # "Investigation closed"
agent-browser screenshot $E/03-oos-closed.png
```

End state that proves it:

- **Screen:** the badge reads CLOSED, the stepper is on Closed, the Signatures card shows the closing signature by Daniel Okafor, the form is replaced by a read-only Conclusion, and "Close investigation" is gone.
- **API:** `GET /api/investigations/<id>` returns `investigation.status = "Closed"`, `closed_by`/`closed_at` set, `conclusion` as chosen, `can.close`, `can.edit` and `can.attach` false, and a `signatures[]` entry with meaning "OOS investigation closed". The related test (`GET /api/tests/<test_id>` as Daniel) now has `can.accept` true (approval unblocked) if it is Reviewed, and its `investigations[]` entry reads Closed.
- **Audit:** `GET /api/audit?q=<OOS code>` shows, newest first, `SIGN` "Signed: OOS investigation closed", `STATUS` "Investigation closed" and `UPDATE` "Investigation updated", all by daniel.okafor, above the seed's rows: a priya.raman `UPDATE`, then `CREATE` "OOS investigation opened automatically when the result was submitted". `GET /api/audit/verify` returns `ok: true`.
- **Refusals:** as `tom.fletcher`, POST `/api/investigations/<id>/close` with `{"password":"demo1234"}` returns 403 "You do not have permission to do that." (no `investigations.close`). The "You performed the test under investigation" refusal is only reachable by a QA or manager who was the test's analyst. Closing also refuses with 400 "Record the root cause before closing", "Record a conclusion before closing" and "Already closed". After closing, PUT `/api/investigations/<id>` as Daniel returns 400 "Closed investigations are locked".

## Gotchas

- **Behavior** (`investigations.js`, error toast). Clicking "Close investigation" with an empty root cause or no conclusion shows the toast "Record the root cause and a conclusion, then save, before closing" and does nothing else. Fill and save first.
- **Behavior** (`investigations.js`). The Conclusion options differ by type: OOS uses `lookups.oosConclusions`; other types offer "No impact", "Impact — see CAPA", "Not applicable". Read the `<option>` texts with `agent-browser eval` before `select`ing.
- **Behavior** (`server/routes/quality.js` leaves Closed out of the status values; confirmed live 2026-10-18). The Stage select deliberately omits Closed. Closing only happens through the signed button.
- **Behavior** (`investigations.js`). The page shows an "OOS procedure" card (Phase I / Phase II) only while the investigation is open and of type OOS; its disappearance is part of the closed end state.
