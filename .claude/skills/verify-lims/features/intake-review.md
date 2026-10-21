# Intake review

A received Sample waits for a decision before its Tests can be assigned. The decision is separate from the Sample's `status` (which stays `Received` and is derived from its Tests): `sample.intake` is `Pending review`, `On hold` or `Accepted`. Receipt, from the direct form or from a client Submission, always starts at `Pending review`. This map covers what exists so far: the state, the accept action and the assign/claim refusal. Hold, release and reject, the Receiving & Review screen and the sidebar badge come in later tickets of spec #48, and this map grows with them. Code: rules `SAMPLE_RULES.accept` and the Test gate in `TEST_RULES.assign` / `TEST_RULES.claim` (`server/workflow.js`), route and `acceptSample` in `server/routes/intake.js`, state names `INTAKE_PENDING`, `INTAKE_HOLD`, `INTAKE_ACCEPTED` in `server/lookups.js`. Permission `samples.review`: manager and scientist, the same roles as `tests.assign`; analysts, QA, business and the administrator are refused with 403.

## Sub-features

- Accept: `POST /api/samples/<id>/accept`, no body. Allowed while `intake` is `Pending review` or `On hold` and the Sample is open. Refused: 403 without `samples.review` (checked first), 400 "This sample is already accepted", 400 when the Sample is cancelled or otherwise closed, 404 for an unknown id. The Sample's `can.accept` says whether the signed-in person is offered it.
- The assign gate: while `intake` is not `Accepted`, `POST /api/tests/assign` and `POST /api/tests/<id>/claim` are refused with 400 "S-… has not been accepted at intake review yet — accept it before its tests are assigned or picked up". `can.assign` on the Sample and its Tests, `can.claim` on its Tests and `assignable` on the Sample are all empty or false until it is accepted.
- Each accept is audited twice: a STATUS entry on `samples` (`intake` Pending review → Accepted, summary "Sample accepted at intake review", with the person and time) and a CREATE entry on `intake_decisions` (the decision record: `decision`, `reason`, `decided_by`, `decided_at`).
- Samples that existed before the upgrade are `Accepted`. The demo lab is Accepted except its newest arrivals: the two Acme release Samples of the last few hours and the two Samples of the received Acme Submission, which wait Pending review.

## How to get to it (user POV)

No screen yet. Drive it through the API as a person with the permission:

```bash
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman GET '/api/samples?limit=50'      # pick a sample, then read its intake
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman GET '/api/samples/<id>'          # sample.intake, can.accept, assignable
.claude/skills/verify-lims/scripts/api.mjs verify priya.raman POST '/api/samples/<id>/accept'
```

End state that proves it:

- **API:** `GET /api/samples/<id>` shows `sample.intake` `Accepted`, `can.accept` false and `assignable` listing its unassigned Tests.
- **Audit:** `GET /api/history/samples/<id>` has the "Sample accepted at intake review" entry under the accepting person's name.
- **Refusals:** as tom.fletcher the same POST returns 403; a second accept returns 400; assigning a Test of a Pending review Sample returns 400 naming intake review (`api.mjs verify priya.raman POST /api/tests/assign` with `{"test_ids":[<id>],"analyst_id":<id>}`).

## Gotchas

- The sweep in `test/agreement.test.js` builds Pending review Samples with `receiveSample({ pendingReview: true })`; every other helper in `test/` accepts the Sample straight after receipt.
