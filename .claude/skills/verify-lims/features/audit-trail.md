# Audit trail: search, verify integrity, export

QA reads the append-only, hash-chained audit log, filters it by text, person, action and record type, verifies the chain, and exports CSV. Code: `public/js/views/audit.js`; server `server/audit.js` (`audit()`, `verifyChain()`), routes in `server/routes/core.js`. Needs `audit.view` (QA, manager, admin). Every write in the app lands here, mostly through `repo.insert`/`repo.update` and otherwise through a direct `audit()` call (sign-ins, the integrity check, settings), so this screen is also how every other feature's side effects are proven.

## Sub-features

- **Filter:** `input[name=q]` (matches record code, summary, changes, reason, username and full name), `select[name=user]`, `select[name=action]` (CREATE, UPDATE, STATUS, SIGN, CUSTODY, LOGIN, LOGIN_FAILED, SIGNATURE_FAILED, PRINT, VERIFY; the server also writes actions not listed, such as VIEW), `select[name=entity]` (record type), date `from`/`to`; `a.btn.ghost[href="/audit"]` "Reset". The table shows who, when, action, record, summary and old → new values with the reason. When is the browser's local time (`fmtDateTime`), not UTC; only the CSV's `timestamp_utc` and the API's `at` are UTC. A record links to its page only for the entity types in `ROUTE` in `audit.js` (samples, tests, methods, instruments, inventory, notebook entries, investigations, projects, clients, invoices, users); other rows show the code unlinked.
- **Verify integrity:** `button[data-act=verify]` "Verify integrity" calls `GET /api/audit/verify` and renders into `[data-verify]` either `.notice.ok` "Integrity verified. All N audit entries are intact and in sequence" or `.notice.bad` "Integrity check failed at entry #…". N has thousands separators ("All 3,893 audit entries…" on 2026-10-18; also the toast and the table foot), so strip the commas before comparing with the API's `count`. The verify call itself writes an audit row, after counting, so the notice's N leaves that row out. The table does not reload, so the new row shows only after Apply or a reload.
- **Export CSV:** `button[data-act=csv]` builds a CSV of the loaded rows client-side and triggers a download named `aliquot-audit-<date>.csv`; toast "Exported N entries".

## How to get to it (user POV)

- Sign in as `daniel.okafor` (or `priya.raman`, `admin`) → **Audit trail** in the sidebar (`/audit`).
- Record pages have no link into `/audit`. Each has a History tab beside Files in its record footer (`.record-footer button[data-ft=history]`, loaded from `GET /api/history/:entity/:id` on the first click), visible to every role that can see the record; the team page has none. To see one record in the trail, filter `/audit` by its code.
- Analysts and business users do not see the item; `GET /api/audit` as them is 403.

## Driving it with agent-browser

Signed in as Daniel:

```bash
agent-browser open "$B/audit"
agent-browser wait 'button[data-act=verify]'
agent-browser screenshot $E/01-audit.png
agent-browser click 'button[data-act=verify]'
agent-browser wait '[data-verify] .notice'
agent-browser eval 'document.querySelector("[data-verify] .notice")?.innerText'    # "Integrity verified. All N audit entries…"
agent-browser screenshot $E/02-audit-verified.png
agent-browser fill 'input[name=q]' '<a test or OOS code>'
agent-browser click 'form[data-filters] button[type=submit]'   # "Apply": typing alone does not filter
agent-browser wait 1000
agent-browser screenshot $E/03-audit-filtered.png
```

End state that proves it:

- **Screen:** the green `.notice.ok` with a count; every filtered row carries the code in some searched field. A sample code also matches its tests, whose summaries name the sample, so not every record column shows the code. Rows of a linked entity type link to their record.
- **API:** `GET /api/audit/verify` returns `{ok: true, count}`. Right after a verify on screen that showed N, the count is N+1 (the screen's own `VERIFY` row), or N+2 when this is the person's first `api.mjs` call of the run (its `LOGIN` row); proven live 2026-10-18 with N=3809 and 3811. `GET /api/audit?q=<code>&limit=10` returns the same rows as the screen, newest first, each with `username`, `full_name`, `action`, `entity`, `entity_id`, `entity_code`, `summary`, `changes`, `reason`, `at`, `ip`, `prev_hash` and `hash`. The table foot reads "Showing the latest N matching entries".
- **Side effect of verifying:** a fresh `GET /api/audit?action=…&limit=3` shows the verification row itself as the newest entry (by daniel.okafor): action `VERIFY` on entity `audit_log`, "Audit trail integrity verified (N entries)". A second `/api/audit/verify` is still `ok: true`. Read back through `api.mjs`, the count rises by 1. It rises by 2 only on a person's first `api.mjs` call in a run, because that call signs in and writes a `LOGIN` row; later calls reuse the saved cookie.
- **Refusals:** `GET /api/audit` as `tom.fletcher` or `grace.holloway` returns 403.

## Gotchas

- **Behavior** (`audit.js`, `limitParam` in `server/routes/core.js`). The screen loads at most 1000 rows (`limit: 1000`). The API returns 300 rows when `limit` is left out and at most 2000; the demo seed has more. Filter before counting rows on screen, or compare against the API's `count`.
- **Harness quirk** (`audit.js` builds the CSV as a Blob download in the browser). CSV export is client-side: `agent-browser` cannot observe the downloaded file. Prove it by the toast "Exported N entries" and by reading `toCsv` rows count against the table; the CSV itself is unverified from the browser harness.
- **Behavior** (`fmtDateTime` in `public/js/core/ui.js`). Timestamps on screen are the browser's local time (seen live 2026-10-18: "Oct 18, 2026, 03:56 AM" for an `at` of 07:56Z); the API and CSV are UTC. Date filters (`YYYY-MM-DD`, otherwise 400 "Dates must be in YYYY-MM-DD format") start at the server's local midnight converted to UTC.
- **Behavior** (`verifyChain()` in `server/audit.js`). Tamper detection covers edits to `audit_log` rows only. Proving "an edit outside the app is detected" by changing a row in the SQLite file is a destructive test on the run's own throwaway DB; do it only against `.verify/runs/<run>/data/aliquot.db`, never `data/`, and relaunch afterwards.
