---
name: verify-lims
description: Launch a throwaway Aliquot LIMS (Node + SQLite lab system and electronic notebook) loaded with the demo lab, drive the Staff web app or the Client portal in a real headless browser with agent-browser as a demo person, and prove behavior with screenshots plus API and audit-trail read-backs. Use to confirm a change works in the running app, not just in `npm test`, or to reproduce a reported behavior as a user would see it.
---

# Verify Aliquot LIMS by driving it

Aliquot is one Node server (`server.js`, no npm dependencies, no build step) over one SQLite file. It serves two browser surfaces:

- **Staff app** at `/`: history routes such as `/worklist`, `/tests/:id`, `/investigations/:id`, `/invoices/:id`, `/audit`. The full list is `ROUTES` in `public/js/main.js`. This is the primary surface.
- **Client portal** at `/portal/`: hash routes such as `#/samples` and `#/submit`.

There is also a WebDAV endpoint under `/dav/` for Word/Excel round-trips; it needs desktop Office and is not driven by this skill.

Everything here uses the four helpers in `.claude/skills/verify-lims/scripts/`. Each run has a name, `verify` by default. Pick another name to run two instances side by side; every run gets its own port, data folder and browser session.

| Path | Holds | Cleanup |
|---|---|---|
| `.verify/runs/<run>/` | data folder, `server.log`, `seed.log`, `pid`, `base`, API cookies, `fake/` (the stand-in Claude's replies and call log) | deleted by `stop.sh` |
| `.verify/evidence/<run>/` | screenshots and JSON read-backs | kept |

`.verify/` is gitignored.

Never drive `data/` (the lab's real database) and never drive `data-dev/` behind a user's `npm run dev` on :3001. Those belong to the user. The helpers only ever touch `.verify/`.

## Launch

```bash
.claude/skills/verify-lims/scripts/launch.sh verify     # prints http://127.0.0.1:<port>
```

`launch.sh`:

1. Seeds the fictional demo lab into a fresh data folder with `scripts/seed-demo.js` (migrations run inside it, so an empty folder is enough).
2. Starts `node server.js` with `PORT=0 HOST=127.0.0.1 ALIQUOT_DATA=.verify/runs/<run>/data`, plus, unless `VERIFY_REAL_CLAUDE=1`, `ALIQUOT_CLAUDE_BIN=test/fake-claude.mjs FAKE_CLAUDE_DIR=.verify/runs/<run>/fake` (see **The stand-in Claude** below).
3. Waits until `GET /api/setup` answers, then prints the base URL. Ready means the API answers with `needsSetup:false` and `demo:true`; `doctor.sh` checks both.

It refuses to start if that run is already up. Server code is loaded once at launch, so relaunch after `server/` changes. A `public/` change only needs a browser reload. Node 22.13 or newer is required (`node:sqlite`).

### The stand-in Claude

The portal's submission assistant ([features/submission-assistant.md](features/submission-assistant.md)) runs the `claude` command on the server's computer. A run never reaches the real one by default: `launch.sh` points `ALIQUOT_CLAUDE_BIN` at `test/fake-claude.mjs` and `FAKE_CLAUDE_DIR` at `.verify/runs/<run>/fake/`, an empty folder you fill:

- `replies.json`: a JSON array of answers to the assistant's calls, used in order; the last one repeats. Each is `{ "output": <the model's structured answer> }`, or `{ "raw": "<text>", "exit": 1 }` for what a broken CLI prints. Either may add `delay_ms` (the answer's wall time), `ignore_term: true` (outlasts the server's stop signal, for timeout tests), and `stream: ["I drafted", " one lot."]` with `stream_delay_ms` (the reply's words, streamed a piece at a time before the answer). The format is the comment at the top of `test/fake-claude.mjs`.
- `calls.jsonl`: written by the fake. `auth status` adds one line; a draft call (`-p`) adds one line with its `pid` when it starts and one with its `input` (the prompt) when it answers. Count the lines holding `"input"` (`grep -c '"input"'`) to prove how many draft calls were answered, or that none were.
- `signed-out`: create this empty file and `claude auth status` reports no account, so turning the assistant on is refused. Delete it to sign back in as `lab@example.com` (max plan).

The fake reads the folder on every call, so change replies between turns without relaunching.

Only with the user's explicit approval in this conversation, launch with `VERIFY_REAL_CLAUDE=1 .claude/skills/verify-lims/scripts/launch.sh <run>`. That run uses the computer's real `claude`: turning the assistant on binds the user's own Claude account and every draft spends its usage.

Demo people all use password `demo1234`:

| Username | Role | Use for |
|---|---|---|
| `tom.fletcher` | analyst | receive samples, enter results, submit, raise investigations |
| `sarah.lindqvist` | senior scientist | peer review, witnessing, assigning |
| `daniel.okafor` | QA | approval, closing investigations, CoAs, audit trail |
| `priya.raman` | lab manager | dashboard, workload, approvals |
| `grace.holloway` | business & finance | clients, projects, invoices |
| `admin` | administrator | accounts, settings; cannot sign lab data |
| `customer@example.com` | portal contact (Acme) | client portal |

## Doctor

Run this first, and again whenever anything looks off:

```bash
.claude/skills/verify-lims/scripts/doctor.sh verify
```

Read-only. It checks that the recorded pid is alive and is `node server.js`, that the port is owned by that pid, that the server logs this run's data folder, and that the lab is set up with demo data. It prints the commit (`+dirty` when the tree has changes) and a `claude:` line: `fake (test/fake-claude.mjs, replies in …/fake)` on a normal run, `REAL claude: …` when the server can reach the real model. Stop if it says REAL and the user did not ask for that. Any `FAIL:` line means: stop, run cleanup, relaunch.

## Drive

**Browser.** Use the `agent-browser` CLI with one isolated session per run. Set the session with the environment variable; don't build it into a `$VAR` (the shell is zsh and won't word-split it).

```bash
export AGENT_BROWSER_SESSION=aliquot-lims-verify
B=$(cat .verify/runs/verify/base); E=$PWD/.verify/evidence/verify
agent-browser set viewport 1440 1000            # demo sign-in buttons sit below the fold at the default size
agent-browser set media light reduced-motion    # skips the lock-screen helix intro, which otherwise covers the buttons
agent-browser open "$B/"
agent-browser wait '[data-demo="daniel.okafor"]'
agent-browser scrollintoview '[data-demo="daniel.okafor"]'
agent-browser click '[data-demo="daniel.okafor"]'
agent-browser wait 2000 && agent-browser get title    # "Dashboard · Aliquot" when signed in
```

**Switching person.** Open the user menu with `button.me-btn[data-menu="me"]`, wait until the logout button is visible (`agent-browser wait '[data-act=logout]'`), then click `button[data-act="logout"]`. Right after sign-in the menu can close again while `.route-progress` covers it, so the click lands on a 0×0 button; if the wait fails, let the page settle and open the menu again. Or run `agent-browser cookies clear` and reopen `$B/`.

**Screenshots** need an absolute path. A relative path lands in `~/.agent-browser/tmp`.

**Selectors.** Prefer `data-*` handles (`data-act`, `data-demo`, `data-pick`, `data-bill`), `name=` attributes and `aria-label`s. The feature files list the real ones. The top bar's **New** menu keeps hidden copies of links such as `a[href="/samples/receive"]` in the DOM and `wait`/`click` act on the first match, so scope to the visible one (`a.btn[href=…]`). The e-signature modal is the same everywhere:

1. Wait for `.modal input[name=password]`.
2. Fill it with `demo1234`.
3. Click `.modal-foot button[data-submit]`.

A wrong password keeps the modal open with `.modal .form-error`. Five failures lock the account for 15 minutes, and signature failures count toward the five; a locked signature returns 423.

Toasts appear in `.toasts`: `agent-browser eval 'document.querySelector(".toasts")?.textContent'`. The Client portal uses a single `.toast`. A success toast lasts 4.2 s; an error toast (`.toast.error`) lasts twice that, about 8.4 s (`toast()` in `public/js/core/ui.js`). While it is up it can cover the button you click next, and agent-browser refuses the click (proven live 2026-10-18 on the receive form). Before clicking after an error toast:

```bash
agent-browser wait --fn '!document.querySelector(".toast.error")'
```

**Match text with `textContent`.** CSS `text-transform: uppercase` styles buttons, badges, tabs, card titles and the notebook's save state, so `innerText` returns "SAVED 03:59 AM", "REVIEWED", "SIGN & ISSUE" where the markup says "Saved 03:59 AM" (`agent-browser get text` likely does the same). A starts-with "Saved" check on `innerText` waited out its 25 s timeout on 2026-10-18. Use `textContent` for any text match, or compare case-insensitively.

**Let modals finish opening.** Every modal plays an opening animation, and a `mousedown` that lands on its backdrop closes it as Cancel. A click fired while the modal is still animating can hit the backdrop, so the dialog closes silently and nothing happens. Before any click on a modal that just opened, wait for animations to settle:

```bash
agent-browser wait --fn 'document.getAnimations().every(a=>a.playState!=="running")'
```

After a modal closes, that is not enough. The closing backdrop (`.modal-backdrop.out`) stays in the page for 150 ms on a timer (`setTimeout(() => backdrop.remove(), 150)` in `public/js/core/ui.js`), and under reduced motion its fade is already over, so animations read as settled while it still blocks clicks; it took the first click on the next page on 2026-10-18. Wait until it is gone:

```bash
agent-browser wait --fn '!document.querySelector(".modal-backdrop")'
```

`agent-browser` exits 1 when a step fails. Chain steps with `&&` and stop on the first failure. Never let a later write probe run after an earlier step failed, because the probe then acts on a record in the wrong state.

**Check every click that should change something.** A click can report done and change nothing, most often in a fast chain straight after `open` or after filling a modal. After each such click, read the toast, the URL or the record through `api.mjs`. If nothing changed, run doctor, then retry the click once.

**API read-back.** `scripts/api.mjs` signs in as a demo person and prints `{status, data}`; it exits 1 on HTTP ≥ 400. Use it to read the state a UI action should have changed, and to prove refusals:

```bash
.claude/skills/verify-lims/scripts/api.mjs verify tom.fletcher GET '/api/tests?scope=open&work=assigned'
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET '/api/investigations?status=open'      # lowercase: every investigation not Closed
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET '/api/audit?q=OOS-2026-001&limit=10'   # audit.view: QA, manager, admin
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET /api/audit/verify                     # {ok:true, count}
.claude/skills/verify-lims/scripts/api.mjs verify tom.fletcher POST /api/investigations/<id>/close '{"password":"demo1234"}'   # expect 403
```

Demo record IDs and codes depend on the seed date. Look them up through the API or the list screens on each run. Never hardcode them.

## Evidence

A proof is a set of files in `.verify/evidence/<run>/`, numbered in the order taken:

- a screenshot before the action;
- a screenshot of the signing modal or form;
- a screenshot of the resulting screen;
- a JSON read-back of the record (`api.mjs … > $E/NN-record.json`);
- the audit rows the action wrote, and `/api/audit/verify`.

Proof standards:

- **Drive the real user path.** A browser click as the right role. Use `api.mjs` to read, or to prove a refusal, never to make the change you are claiming works.
- **Try bad input when a form changed.** Drive blank and partly filled rows, a double click on submit, and too much pasted text, not just the documented path. Three portal bugs passed happy-path reviews this way.
- **Show the action and the resulting state.** Status badge, toast, signature card, and the API record (`status`, `signatures[].meaning`, `can.*` flags).
- **Check side effects.** Every write leaves `audit_log` rows (`CREATE`/`UPDATE`/`STATUS`/`SIGN`; entity names are table names such as `tests`, `investigations`, `invoices`). `/api/audit/verify` must still return `ok: true`.
- **Prove refusals on the server.** A hidden button is not a proof. Call the endpoint as the person who must be refused and capture the 4xx: wrong person or missing permission is 403, wrong state (locked record, open investigation, draft-only action) is 400, another client's portal record is 404.
- **Side effects beyond the API.** Attachments land in `.verify/runs/<run>/data/files/`; a CoA or invoice "PDF" is only the browser's print dialog (`/print/coa/:id`, `/print/invoice/:id` render printable pages, nothing is written server-side).

## Cleanup

```bash
.claude/skills/verify-lims/scripts/stop.sh verify
```

`stop.sh` closes this run's browser session (`aliquot-lims-<run>`), kills only the pid that `launch.sh` recorded after checking it is still `node server.js`, and deletes `.verify/runs/<run>/`. It never kills by process name. Evidence in `.verify/evidence/<run>/` survives; delete it yourself once reported. Run cleanup after every failed attempt too.

## Feature map

`features/README.md` indexes one file per user-facing feature, each with routes, real selectors, end state and gotchas. A proof of a feature covers every entry point its file lists, not just the most convenient one. Each gotcha opens with its kind in bold: **App bug** links its issue in the v3 repo, **Behavior** (the app works as built, and the gotcha says how to drive it) cites the code that does it, **Harness quirk** names the evidence for its cause, and **Hypothesis** marks an unproven cause. Keep the map honest with `/maintain-verification-skill`.
