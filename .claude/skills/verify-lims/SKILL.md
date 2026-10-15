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
| `.verify/runs/<run>/` | data folder, `server.log`, `seed.log`, `pid`, `base`, API cookies | deleted by `stop.sh` |
| `.verify/evidence/<run>/` | screenshots and JSON read-backs | kept |

`.verify/` is gitignored.

Never drive `data/` (the lab's real database) and never drive `data-dev/` behind a user's `npm run dev` on :3001. Those belong to the user. The helpers only ever touch `.verify/`.

## Launch

```bash
.claude/skills/verify-lims/scripts/launch.sh verify     # prints http://127.0.0.1:<port>
```

`launch.sh`:

1. Seeds the fictional demo lab into a fresh data folder with `scripts/seed-demo.js` (migrations run inside it, so an empty folder is enough).
2. Starts `node server.js` with `PORT=0 HOST=127.0.0.1 ALIQUOT_DATA=.verify/runs/<run>/data`.
3. Waits until `GET /api/setup` answers, then prints the base URL. Ready means the API answers with `needsSetup:false` and `demo:true`; `doctor.sh` checks both.

It refuses to start if that run is already up. Server code is loaded once at launch, so relaunch after `server/` changes. A `public/` change only needs a browser reload. Node 22.13 or newer is required (`node:sqlite`).

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

Read-only. It checks that the recorded pid is alive and is `node server.js`, that the port is owned by that pid, that the server logs this run's data folder, and that the lab is set up with demo data. It prints the commit (`+dirty` when the tree has changes). Any `FAIL:` line means: stop, run cleanup, relaunch.

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

Toasts appear in `.toasts`: `agent-browser eval 'document.querySelector(".toasts")?.innerText'`. The Client portal uses a single `.toast`.

**Let modals finish opening.** Every modal plays an opening animation, and a `mousedown` that lands on its backdrop closes it as Cancel. A click fired while the modal is still animating can hit the backdrop, so the dialog closes silently and nothing happens. The fading backdrop of a closing modal (`.modal-backdrop.out`) also blocks the next click for about 150 ms. Before any click on or just after a modal, wait for animations to settle:

```bash
agent-browser wait --fn 'document.getAnimations().every(a=>a.playState!=="running")'
```

`agent-browser` exits 1 when a step fails. Chain steps with `&&` and stop on the first failure. Never let a later write probe run after an earlier step failed, because the probe then acts on a record in the wrong state.

**Check every click that should change something.** A click can report done and change nothing, most often in a fast chain straight after `open` or after filling a modal. After each such click, read the toast, the URL or the record through `api.mjs`. If nothing changed, run doctor, then retry the click once.

**API read-back.** `scripts/api.mjs` signs in as a demo person and prints `{status, data}`; it exits 1 on HTTP ≥ 400. Use it to read the state a UI action should have changed, and to prove refusals:

```bash
.claude/skills/verify-lims/scripts/api.mjs verify tom.fletcher GET '/api/tests?scope=open&work=assigned'
.claude/skills/verify-lims/scripts/api.mjs verify daniel.okafor GET '/api/investigations?status=Open'
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

`features/README.md` indexes one file per user-facing feature, each with routes, real selectors, end state and gotchas. A proof of a feature covers every entry point its file lists, not just the most convenient one. Keep the map honest with `/maintain-verification-skill`.
