# Stugu premium redesign review package

Baseline: `main@827cf0d` · Review date: 1 August 2026 · Final implementation truth pass: 1 August 2026

This package preserves the frozen pre-change audit and records the completed
premium implementation separately. Historical route, element, and test counts
remain labelled as baseline or tranche evidence; the final repository-wide
web suite passes 958/958 tests across 140 files and the focused route/deep-link
state matrix passes 82/82 across nine files. Final-tree root `npm test` passed
every workspace, including 744/744 API tests across 121 files; final-tree root
typecheck, build, version, and whitespace gates also pass.

The final production Chromium responsive matrix covers all 27 requested route
deep links at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768. The phone and
tablet matrix supplements the earlier desktop and narrow-desktop runs.

1. [`00-executive-status.md`](00-executive-status.md) — outcome, scope, and coverage.
2. [`01-evidence-and-current-system.md`](01-evidence-and-current-system.md) — method, architecture, runtime evidence, constraints, and retrieved guidance.
3. [`02-surface-register.csv`](02-surface-register.csv) — 64 canonical, legacy, global-state, and native surface dispositions with explicit coverage status.
4. [`03-element-content-register.csv`](03-element-content-register.csv) — 31 mechanical UI/content families with decisions and explicit coverage status.
5. [`04-findings-and-target-experience.md`](04-findings-and-target-experience.md) — prioritized findings, target model, and lifecycle scenarios.
6. [`05-redesign-and-design-system-deltas.md`](05-redesign-and-design-system-deltas.md) — IA, component, token, design-system, and migration specification.
7. [`06-implementation-ledger.md`](06-implementation-ledger.md) — production changes, tests, completed scope, and visual evidence.
8. [`07-validation-and-release-decision.md`](07-validation-and-release-decision.md) — preserved tranche evidence and the current release decision.
9. [`08-v0.28.0-release-addendum.md`](08-v0.28.0-release-addendum.md) — final receipts, independent review fixes, performance evidence, accepted limits, and 0.28.0 release scope.
10. [`evidence/`](evidence/) — normal-viewport before/after browser captures.

Implementation status: the defined responsive-web and local-API programme is complete, including
design-system convergence, structured confirmations, bookmarkable evidence
state across Property and Home workflows, legacy Setup removal, plain-language copy, principal-scoped browser
storage, role/action/API parity, and safe Home retirement. Native catalogue,
Watch, and route/error work already present in the tree remains recorded, but
iOS acceptance and device work are explicitly deferred and are not part of this
web completion claim.

Release decision: D1 — Ship with limited refinement. The responsive web and
local appliance release is approved as 0.28.0; iOS remains explicitly deferred.
The cross-browser, assistive-technology, real-user, long-duration, live-hardware,
and true Core Web Vitals gaps are disclosed follow-up evidence, not hidden
passes. See the 0.28.0 addendum for the superseding final receipts and scope.
