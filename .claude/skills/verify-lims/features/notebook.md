# Lab notebook: write, sign, witness

Electronic lab notebook entries (`ELN-YYYY-NNNN`). The author writes with autosave, signs "Authored" to lock the entry, and a colleague signs "Witnessed". Corrections after signing are addenda. Code: `public/js/views/notebook.js`, routes in `server/routes/quality.js`, rules in `ENTRY_RULES` (`server/notebook.js`). Permission `notebook.write`: manager, scientist, analyst, QA. `notebook.witness`: manager, scientist, QA (not analysts). The title input, editor and the Sign, Witness and Addendum buttons come from the entry's `can` flags (`edit`, `sign`, `witness`, `addendum`), so a button is shown exactly when the entry's rule allows the action; `can.attach` drives the attachments drop zone, not a header button, and Print is always shown. Readiness the author can fix is checked by the action itself: Sign on an empty entry is offered, and the server answers 400 "The entry is empty", shown in the signing modal's `.modal .form-error` (proven live 2026-10-18).

## Sub-features

- **Create:** `button[data-act=new]` "New entry". The modal has `input[name=title]` (required), `select[name=template]`, `input[name=tags]`, `select[name=document]` ("No — text only"), `select[name=project_id]` and `select[name=method_id]`. The button is "Create entry". The template defaults to "Experiment", which pre-fills the body; pick `blank` ("Blank page") to test the empty-entry refusal.
- **Edit:** the title is `input.title-input[data-title]` and saves on change with the toast "Title updated". The body is `textarea[data-body]` (aria-label "Entry text"), with insert buttons `[data-ins=h|table|list|bold|stamp]`.
- **Autosave:** about 1.2 s after typing, and again when the editor loses focus, PUT `/api/notebook/:id`. The status shows in `span[data-save-state]`: "All changes saved" on open, then "Editing…", "Saving…", then "Saved" plus a locale time ("Saved 04:25 AM"). CSS uppercases it, so read `textContent` and match starts-with "Saved" (see SKILL.md, text matching).
- **Sign & lock:** `[data-act=sign]`, meaning "Authored". Only the author can sign, and only while their role still has `notebook.write` (editing needs the same). The body must be non-empty. Signing also freezes the entry's documents.
- **Witness:** `[data-act=witness]` "Witness", meaning "Witnessed". The modal has an optional `textarea[name=comment]` before the password, and the button "Sign as witness".
- **Addendum:** `[data-act=addendum]`, then `textarea[name=body]`, then "Add addendum". Toast "Addendum added". Any `notebook.write` holder can add one once the entry is signed or witnessed.
- Word/Excel documents on an entry: `[data-new-doc=xlsx|replicates|docx|upload]`, and per document `[data-act=open|upload|remove|versions|preview]`. Every change to a document, including WebDAV, follows the entry's `edit` rule, so documents lock with the entry. Not driven yet.

## How to get to it (user POV)

- **Lab notebook** in the sidebar (`/notebook`) → "New entry", or open an entry `/notebook/<id>`.
- Top bar **New** menu → Notebook entry.
- **My drafts:** the Dashboard card "My drafts" (only rendered when the person has drafts, so absent rather than empty otherwise; sub-line "Notebook entries you can still edit and sign", at most five rows, button "All my drafts" → `/notebook?view=drafts`) and the Notebook tab "My drafts" among the tabs All entries, Mine, My drafts and Awaiting witness (`?view=drafts`). Both are `ENTRY_QUEUES.drafts`: the author's Drafts they may still edit, so a draft leaves both once it is signed or its author loses `notebook.write`. The tab reads `GET /api/notebook?work=drafts`; any other `work` except `witness` is a 400 "Work filter must be one of: witness, drafts". Another person's draft is not on it. "Awaiting witness" is plain `status=Signed`, so unlike the Reviews witness tab it includes the person's own Signed entries.
- Witness: `/reviews?tab=witness` → "Read & witness" (`a.btn[href="/notebook/<id>"]`). The tab is `ENTRY_QUEUES.witness`: the Signed entries the person may witness, so their own Signed entry is never on it, and each one also counts in the Reviews badge. The label follows the entry's `can.witness`. Where it is false, as in the administrator's oversight, the same link reads "Read".

## Driving it with agent-browser

```bash
agent-browser open "$B/notebook"
agent-browser click 'button[data-act=new]'
agent-browser fill '.modal input[name=title]' 'Verification entry'
agent-browser click '.modal-foot button[data-submit]'           # "Create entry" → /notebook/<id>
agent-browser wait 'textarea[data-body]'
agent-browser fill 'textarea[data-body]' 'Weighed 10.02 mg of RS lot 2291.'
agent-browser wait --fn 'document.querySelector("span[data-save-state]").textContent.startsWith("Saved")'
agent-browser click 'button[data-act=sign]'
agent-browser wait '.modal input[name=password]'
agent-browser fill '.modal input[name=password]' demo1234
agent-browser click '.modal-foot button[data-submit]'           # "Sign & lock"
```

Then sign in as sarah.lindqvist, open the same `/notebook/<id>`, and witness it with the same modal steps.

End state that proves it:

- **Screen:** toast "Entry signed and locked". `.locked-banner` reads "Signed by <name> on <date> · awaiting witness. This entry can no longer be changed." After witnessing: toast "Entry witnessed", and "· witnessed by <name> on <date>" replaces "· awaiting witness".
- **API:** `GET /api/notebook/<id>` returns `{entry, addenda, signatures, documents, can}`. `entry.status` goes Draft, then Signed, then Witnessed, and `signatures[].meaning` is "Authored", then "Witnessed".
- **Audit:** `GET /api/audit?entity=notebook_entries&entity_id=<id>` (as daniel.okafor: it needs `audit.view`) shows `CREATE Notebook entry started`, `UPDATE Draft edited`, `SIGN Signed: Authored`, `STATUS Signed by author — entry locked`, `SIGN Signed: Witnessed` and `STATUS Witnessed`. "Draft edited" appears only when the title or body changed. An entry with documents also gets `UPDATE Documents signed with the entry: …` when signed. An addendum is a `CREATE` on `notebook_addenda`, so it does not show under this filter.
- **Refusals:**
  - PUT `/api/notebook/<id>` after signing, as the author, returns 400 ("Signed entries are locked — add an addendum instead"). Anyone else gets 403 first ("Only the author can edit this entry"), and someone without `notebook.write` a plain 403.
  - Witnessing as tom.fletcher returns 403, because analysts lack `notebook.witness`. That check runs first, so Tom's attempt doesn't prove the self-witness rule.
  - To prove the self-witness rule, have a witness-capable author (sarah.lindqvist) sign her own entry, then POST `/api/notebook/<id>/witness` as her. It returns 403 ("You cannot witness your own entry").

## Gotchas

- **Behavior** (`notebook.js` `beforeunload` guard). Wait for `span[data-save-state]` to read "Saved…" before navigating or reloading. Unsaved drafts have a `beforeunload` guard, which raises a native dialog that blocks automation.
- **Behavior** (`notebook.js`). `[data-act=print]` calls `window.print()`, a native print dialog. Don't click it.
- **Behavior** (`openForm` and `esign` in `public/js/core/ui.js`). The modal submit button is `.modal-foot button[data-submit]`. Its text differs per modal ("Create entry", "Sign & lock", "Sign as witness").
- **Hypothesis** (cause not proven; the opening animation of SKILL.md's "Let modals finish opening" fits). A "Create entry" click chained straight after filling the title can report `✓ Done` without creating the entry: the modal closes and the URL stays `/notebook`. Check that the URL became `/notebook/<id>` before going on; if not, open the modal and try again.
- **Harness quirk** (proven live 2026-10-18). The first click on the new entry's page, right after the create modal closed, landed on the closing `.modal-backdrop.out` even after animations had settled (it is removed on a 150 ms timer, `ui.js`; see SKILL.md). Wait for `!document.querySelector(".modal-backdrop")` first.
- **Behavior** (`notebook.js`). Autosave can also show "Not saved" when a save fails.
