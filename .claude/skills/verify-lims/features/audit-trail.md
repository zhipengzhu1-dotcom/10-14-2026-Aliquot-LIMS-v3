# Audit trail: search, verify integrity, export

QA reads the append-only, hash-chained audit log, filters it by text, person, action and record type, verifies the chain, and exports CSV. Code: `public/js/views/audit.js`; server `server/audit.js` (`audit()`, `verifyChain()`), routes in `server/routes/core.js`. Needs `audit.view` (QA, manager, admin). Every write in the app lands here through `repo.insert`/`repo.update`, so this screen is also how every other feature's side effects are proven.

## Sub-features

- **Filter:** `input[name=q]` (code, text, reason), `select[name=user]`, `select[name=action]` (CREATE, UPDATE, STATUS, SIGN, LOGIN, LOGIN_FAILED, SIGNATURE_FAILED, CUSTODY, VERIFY, PRINT…), `select[name=entity]` (record type), date `from`/`to`; `a.btn.ghost[href="/audit"]` "Reset". The table shows who, when (UTC), action, record (linked), summary and old → new values with the reason.
- **Verify integrity:** `button[data-act=verify]` "Verify integrity" calls `GET /api/audit/verify` and renders into `[data-verify]` either `.notice.ok` "Integrity verified. All N audit entries are intact and in sequence" or `.notice.bad` "Integrity check failed at entry #…". The verify call itself writes an audit row.
- **Export CSV:** `button[data-act=csv]` builds a CSV of the loaded rows client-side and triggers a download named `aliquot-audit-<date>.csv`; toast "Exported N entries".

## How to get to it (user POV)

- Sign in as `daniel.okafor` (or `priya.raman`, `admin`) → **Audit trail** in the sidebar (`/audit`).
- Record pages have no link into `/audit`. Each shows its own History panel inline (from `GET /api/history/:entity/:id`), visible to every role that can see the record. To see one record in the trail, filter `/audit` by its code.
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

- **Screen:** the green `.notice.ok` with a count; the filtered table shows only rows whose record column carries the code, each row linking to the record.
- **API:** `GET /api/audit/verify` returns `{ok: true, count: N}` with N equal to the number in the notice. `GET /api/audit?q=<code>&limit=10` returns the same rows as the screen, newest first, each with `username`, `full_name`, `action`, `entity`, `entity_id`, `entity_code`, `summary`, `changes`, `reason`, `at`, `ip`, `prev_hash` and `hash`. The table foot reads "Showing the latest N matching entries".
- **Side effect of verifying:** a fresh `GET /api/audit?action=…&limit=3` shows the verification row itself as the newest entry (by daniel.okafor): action `VERIFY` on entity `audit_log`, "Audit trail integrity verified (N entries)". A second `/api/audit/verify` is still `ok: true`. Read back through `api.mjs`, the count rises by 2, not 1, because each `api.mjs` call signs in and writes its own `LOGIN` row before the verify.
- **Refusals:** `GET /api/audit` as `tom.fletcher` or `grace.holloway` returns 403.

## Gotchas

- The screen loads at most 1000 rows (`limit: 1000`); the demo seed has more. Filter before counting rows on screen, or compare against the API's `count`.
- CSV export is client-side: `agent-browser` cannot observe the downloaded file. Prove it by the toast "Exported N entries" and by reading `toCsv` rows count against the table; the CSV itself is unverified from the browser harness.
- Timestamps are UTC with no time-zone setting. Date filters (`YYYY-MM-DD`, otherwise 400 "Dates must be in YYYY-MM-DD format") start at the server's local midnight converted to UTC.
- Tamper detection covers edits to `audit_log` rows only. Proving "an edit outside the app is detected" by changing a row in the SQLite file is a destructive test on the run's own throwaway DB; do it only against `.verify/runs/<run>/data/aliquot.db`, never `data/`, and relaunch afterwards.
