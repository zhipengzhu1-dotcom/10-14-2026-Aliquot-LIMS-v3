# Aliquot LIMS feature map

One file per user-facing feature. Each says how a user reaches it, how to drive it with `agent-browser`, and what end state proves it works. Keep these honest with `/maintain-verification-skill`.

| Feature | File | Who | Proven end to end |
|---|---|---|---|
| Enter results and submit a test | [test-results.md](test-results.md) | analyst (tom.fletcher) | yes, 2026-10-18 |
| Receive samples | [receive-samples.md](receive-samples.md) | analyst (tom.fletcher) | yes, 2026-10-18 |
| Intake review: accept a received Sample before its Tests are assigned | [intake-review.md](intake-review.md) | priya.raman or sarah.lindqvist (tom.fletcher refused) | API only, 2026-10-21; no screen yet |
| Peer review and QA approval, issue CoA | [review-approve.md](review-approve.md) | sarah.lindqvist, then daniel.okafor | yes, 2026-10-18 |
| Lab notebook: write, sign, witness | [notebook.md](notebook.md) | tom.fletcher, then sarah.lindqvist | yes, 2026-10-18 |
| Client portal | [client-portal.md](client-portal.md) | customer@example.com | yes, 2026-10-18 |
| OOS investigations: auto-raise, record, QA close | [oos-investigation.md](oos-investigation.md) | daniel.okafor (tom.fletcher to raise) | yes, 2026-10-18 |
| Invoices: ready to bill, issue, pay, void | [invoices.md](invoices.md) | grace.holloway | yes, 2026-10-18 |
| Audit trail: search, verify integrity, export | [audit-trail.md](audit-trail.md) | daniel.okafor | yes, 2026-10-18 |
| Submission assistant: admin switch, drafting on the stand-in Claude | [submission-assistant.md](submission-assistant.md) | admin, then customer@example.com | yes, 2026-10-18 |

Not mapped yet: dashboard, methods and method versions, instruments and calibration, standards and reagents (inventory), clients, projects, insights, workload, team and training matrix, settings other than the Submission assistant card (laboratory details, pricing, security, demo mode), portal inbox (staff side), Word/Excel notebook documents over WebDAV (needs desktop Office; not drivable headless), the administrator's read-only oversight, first-time "Set up my laboratory" (needs an empty data folder, not the demo seed).
