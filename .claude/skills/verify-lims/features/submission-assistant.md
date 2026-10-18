# Submission assistant: admin switch, server contract, driving it on the stand-in

An administrator turns on an assistant that drafts portal sample submissions from what a client writes or attaches. It runs the `claude` command on the server's computer, signed in to the lab's own Claude subscription, and never saves or sends anything: the client reviews the draft on the submission desk and presses Send to lab. Code: card in `public/js/views/settings.js`, logic in `server/assistant.js`, the only caller of `claude` in `server/claude.js`, routes in `server/routes/core.js` (`/api/settings/assistant`) and `server/routes/portal.js` (`/api/portal/assistant`). The client's side, the `#/submit` desk, is in [client-portal.md](client-portal.md).

A verify run drives it on the stand-in Claude, never the real one. SKILL.md's **The stand-in Claude** says how `launch.sh` sets that up and what goes in `.verify/runs/<run>/fake/`.

## Sub-features

- **Settings card.** Staff app `/settings` as `admin` (Alex Morgan; `settings.edit` is the administrator's alone). The card "Submission assistant" (`[data-assistant]`) first reads "Looking for a Claude account on this computer…", then shows Status `[data-assistant-state]` "On" or "Off", "Approved by" (or "Last approved by" once turned off) with the date, "Approved account", "Claude account found" (the account's name, such as "lab@example.com, max plan" on the stand-in, or the problem in muted text), the selects `[name=assistant_model]` (Opus 5.5, Sonnet 5.5, Haiku 5.5) and `[name=assistant_effort]` (low, medium, high), and `button[data-act=assistant-on]` "Turn on" or `button[data-act=assistant-off]` "Turn off".
  - A change to either select posts at once (no Save) and toasts "Default model saved".
  - "Turn on" / "Turn off" post with the selected default, toast "Submission assistant turned on" / "Submission assistant turned off", and redraw the card.
  - The page's own "Save settings" never touches the assistant: `GET /api/settings` leaves the `assistant_*` keys out and `PUT /api/settings` ignores them.
- **Allowed choices.** One table, `MODELS` x `EFFORTS` in `server/assistant.js`: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` at `low`, `medium` or `high`. The default is Opus 5.5, low (`DEFAULTS` in `server/settings.js`; a lab that saved another default keeps it). Anything else is refused with 400 "Model must be one of: …" or "Effort must be one of: …", on the settings route and on every draft.
- **Settings API (admin only, 403 for anyone else).**
  - `GET /api/settings/assistant` returns `{ setting, choices, account, problem }`. `setting` is `{ enabled, model, effort, approved_by, approved_at, account }`; `choices` is `{ models: [{id, label}], efforts }`; `account` is `{ loggedIn, email, method, plan, name }` or null; `problem` says why there is no account, such as "No Claude account is signed in. On the computer that runs Aliquot, run: claude auth login".
  - `POST /api/settings/assistant` takes `{ enabled?, model?, effort? }` and answers like the GET. Turning on runs `claude auth status` first. It is refused with 400 `CLAUDE_SIGNED_OUT` "No Claude account is signed in on this computer. On the computer that runs Aliquot, run: claude auth login" when none is signed in, and with 503 `ASSISTANT_UNAVAILABLE` when the command is missing ("The claude command was not found on the computer that runs Aliquot (…)") or prints something that is not its sign-in.
- **Audit.** Each write is one `UPDATE` on `settings` under the admin, and only when a value changed:
  - turning on: "Submission assistant turned on with the Claude account <email>, <plan> plan (Opus 5.5, low effort by default)";
  - turning off: "Submission assistant turned off";
  - a default changed: "Submission assistant default set to Sonnet 5.5, high effort".
- **Portal API.** Both routes need a portal session; without one they answer 401 `PORTAL_AUTH`.
  - `GET /api/portal/assistant` returns `{ enabled, model, model_label: "Opus 5.5", effort: "low", choices }`.
  - `POST /api/portal/assistant` takes `{ message, draft, history, declined, model?, effort? }`. `declined` holds the proposals the client turned down with "Keep what I set", which are not asked again. It answers `{ reply, draft (body + provenance + questions + next_row), gate, attempts, unresolved, model, model_label, effort, ms }` and saves nothing. It refuses with 400 "Write a message first", 400 "That message is too long (max 20000 characters)", 400 for a model or effort outside the table, and 503 `ASSISTANT_UNAVAILABLE` when the assistant is off ("The assistant is off. Your lab has not turned it on."), busy, timed out, or Claude cannot be reached. A reply that is not a draft, or whose draft still fails the gate on something it did not ask the client about, is retried, three tries at most (`attempts`). After the third the reply says "I could not produce a draft in three tries…" and the draft comes back unchanged.
  - The portal sends `Accept: application/x-ndjson` and gets the same turn streamed: `{ "type": "reply", "text": "<the reply so far>" }` lines while the model writes (starting over on a retry), then one `{ "type": "done", ...the answer above }`. A refusal before the first line keeps its status and JSON body; after it, the stream ends with `{ "type": "error", "error", "code" }` and status 200. Without that header the answer is plain JSON.
- **Lean model contract** (`DRAFT_SCHEMA` and `SYSTEM` in `server/assistant.js`). The model leaves out every field it has no value for, except a row's `description` and `batch_no`, and lists provenance by source: `{ client: [paths], sheet: [paths], default: [paths], guessed: [{ path, reason }] }`. `readModelDraft` fills the nulls back in and marks any filled value the model listed nowhere as guessed, so the browser's draft shape is unchanged.
- **`server/claude.js` limits.** `ALIQUOT_CLAUDE_BIN` overrides the binary; a `.js`/`.mjs` path runs under the server's own Node. Each call runs in an empty temp folder of its own (`aliquot-claude-…`), with no tools, no settings and no session saved, as `--output-format stream-json --include-partial-messages`, so the reply's words can be read from the partial JSON. At most 2 calls run at once and 8 wait; a call beyond that gets 503 "The assistant is busy. Try again in a minute.". A draft call is stopped after 120 s (`ALIQUOT_CLAUDE_TIMEOUT_MS` shortens it) and killed 2 s later if it ignores the stop, with 503 "Claude did not answer within N seconds.". `auth status` gets 20 s.

## How to get to it (user POV)

- Admin: sign in as `admin` → **Settings** in the sidebar (`/settings`) → the "Submission assistant" card, right column, below Security.
- Client: portal → **Submit samples** (`#/submit`). See [client-portal.md](client-portal.md).

## Driving it with agent-browser

Launch normally (doctor must print `claude: fake …`), then give the stand-in its answers. This file was run as written on 2026-10-18 through `POST /api/portal/assistant`: the reply read "I drafted one lot." in 3.0 s, batch L-1, storage guessed. It fills the courier as the client's words and leaves storage, ship date and the sample row without a claimed source, so they show as guessed. `stream` makes the words arrive one piece at a time, `stream_delay_ms` apart, before `delay_ms` and the answer. Set `ship_date` to a date after the run:

```bash
R=.verify/runs/verify
cat > $R/fake/replies.json <<'JSON'
[{"stream": ["I drafted", " one lot."], "stream_delay_ms": 1500, "delay_ms": 1500, "output": {
  "reply": "I drafted one lot.",
  "draft": {"storage": "Refrigerated (2–8 °C)", "courier": "FedEx", "ship_date": "2026-10-20",
            "samples": [{"description": "Paracetamol 500mg tablet", "batch_no": "L-1", "stage": "Finished product"}]},
  "provenance": {"client": ["courier"]},
  "questions": []}}]
JSON
```

Signed in as admin in the Staff app:

```bash
agent-browser open "$B/settings"
agent-browser wait 'button[data-act=assistant-on]'
agent-browser wait --fn 'document.getAnimations().every(a=>a.playState!=="running")'
agent-browser click 'button[data-act=assistant-on]'
agent-browser wait --fn 'document.querySelector("[data-assistant-state]")?.textContent === "On"'
agent-browser screenshot $E/01-assistant-on.png
```

Then in the portal (sign-in and fresh-tab steps from [client-portal.md](client-portal.md)), in a tab opened after the admin turned it on:

```bash
agent-browser tab new "$B/portal/?v=$RANDOM#/submit"
agent-browser wait 'textarea#as-message'
agent-browser fill 'textarea#as-message' '1 lot of Paracetamol 500mg, batch L-1, by FedEx, keep cool, ship Tuesday'
agent-browser click '.js-composer button[type=submit]'
agent-browser wait --fn 'document.querySelector(".js-partial")?.textContent.length > 0'
agent-browser eval 'document.querySelector(".js-partial")?.textContent'   # "I drafted": the words so far, ahead of the typing dots
agent-browser wait --fn '!document.querySelector(".as-typing")'
agent-browser eval '[...document.querySelectorAll(".js-answered-by")].pop()?.textContent'   # "Opus 5.5 · low effort · 4.5 s"
grep -c '"input"' $R/fake/calls.jsonl                     # draft calls answered
```

End state that proves it:

- **Screen:** the card reads On with the stand-in's account; the toast "Submission assistant turned on". On the desk, while the turn runs, the typing bubble `.msg.lab.as-live` shows the words so far in `.js-partial` followed by the `.as-typing` dots; then the reply "I drafted one lot." with "Opus 5.5 · low effort · 4.5 s", courier tagged "from you", storage and ship date under Guessed with "needed to send", and `button.js-send` disabled while they are unconfirmed. Clicking both `button[data-confirm]` "Looks right" tags them "you edited" and lets the submission send.
- **API:** `GET /api/settings/assistant` as admin has `setting.enabled: true`, `setting.account: "lab@example.com, max plan"`. `GET /api/portal/assistant` under the portal cookie has `enabled: true`.
- **Calls:** `calls.jsonl` has an `auth status` line from each card load and from turning on, and two lines per draft call (start, then answer). The answer line's `input` is the prompt the server sent.
- **Audit:** the `UPDATE` on `settings` "Submission assistant turned on with the Claude account lab@example.com, max plan (Opus 5.5, low effort by default)" by admin; `/api/audit/verify` is `ok: true`.
- **Refusals:**
  - With the assistant off, `POST /api/portal/assistant` is 503 `ASSISTANT_UNAVAILABLE` and `calls.jsonl` gains no `-p` line.
  - `touch $R/fake/signed-out`, then turning on is 400 `CLAUDE_SIGNED_OUT`.
  - `GET` or `POST /api/settings/assistant` as priya.raman is 403.

The end state above was proven live on 2026-10-18 (evidence `.verify/evidence/maint/13-16`). Turning off, the default-change toast and audit row, and the 400 and busy refusals of `POST /api/portal/assistant` are read from source, not yet driven.

## Gotchas

- **Behavior** (`let desk` in `public/portal/portal.js` is module state). The submission desk is built once per page load and kept while the client moves around the portal. A desk built while the assistant was off keeps an empty conversation with no greeting after the admin turns it on. Load the portal afresh (`agent-browser tab new "$B/portal/?v=$RANDOM#/submit"`) after changing the setting.
- **Behavior** (`server/claude.js`). On the stand-in, a turn takes the reply's `delay_ms`, not a model's time. With `VERIFY_REAL_CLAUDE=1` (only with the user's approval) a turn can take up to 120 s, so wait on `!document.querySelector(".as-typing")` with `--timeout 180000`, never a fixed time.
- **Behavior** (`test/fake-claude.mjs`). The stand-in counts answered `-p` calls in `calls.jsonl` to pick the next reply. Deleting `calls.jsonl` restarts `replies.json` from the first entry.
- **Behavior** (`setSettings` in `server/settings.js`). Choosing the default that is already set writes no audit row, so pick a different value to prove the default-change row.
