# Aliquot

LIMS and electronic lab notebook for contract analytical labs. Read `README.md` for what it does and `GLOSSARY.md` for the words we use.

## Commands

- `npm run dev`: development copy on http://localhost:3001 with its own `data-dev/` folder. Never point development at `data/`.
- `PORT=3002 npm run dev`: a second development copy on another port. Before debugging a browser error on a port, check that the listener is this repo: `lsof -a -d cwd -p $(lsof -tiTCP:<port> -sTCP:LISTEN)` (another project's dev server can take :3001 after a reboot).
- `/verify-lims`: check a UI change in the running app. Invoke it first; it carries the logins, the splash and animation waits and the feature maps. The Claude-in-Chrome browsers are other machines and cannot reach localhost, so leave them out.
- CI queued or runner offline: `docs/ci-runner.md`. Run `scripts/animated-runner.sh status` from the `aliquot-ci-runner` worktree, never from the live copy.
- `npm run check`: syntax-check every JavaScript file and refuse hand-written writes that bypass the audit trail and verify feature maps that name code that is gone.
- `npm test`: end-to-end tests against a real server on a throwaway database.
- Public demo down, Cloudflare error 1033, or publishing `main` to app/animated.nitrolims-demo.com: README "The public demo". It runs from a separate live clone, not this one.

## Coding standards

- **Zero dependencies, no build step.** Node built-ins only (`http`, `crypto`, `node:sqlite`) on the server; plain ES modules in the browser. Don't add packages, bundlers or transpilers. The one exception is a vendored browser library, copied as a file into `public/vendor/<name>/` with its licence and served by our own server (never from a CDN, because labs run Aliquot without internet access): today only three.js, loaded lazily by `public/js/core/helix.js`.
- **All writes go through `repo.insert` / `repo.update`** so the audit trail records them. Never write `INSERT`/`UPDATE` against an audited table by hand.
- **Signed records stay locked.** Anything a signature depends on is never edited or deleted; corrections are new records.
- **E-signatures re-ask for the password** with `verifySignature` then `applySignature` (`server/auth.js`), with a stated meaning.
- **Schema changes are a new entry in `MIGRATIONS`.** Never edit a migration that has already run.
- **Everything else a reviewer enforces is in `CODING_STANDARDS.md`.** Read its "Every record's rules" and "Every list of work" bullets before adding or changing an action, a Queue, a badge (its surfaces and badges are registered in `test/surfaces.js`) or a `can` flag, and "Escape by default" before writing browser markup.

## Agent skills

### Issue tracker

GitHub Issues in `zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3`, this clone's `origin`; always pass `--repo`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
