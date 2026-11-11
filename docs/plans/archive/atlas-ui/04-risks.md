# Risks

What could be lost or regress, each keyed to the parity-checklist row(s) and the decomposition card
whose DoD is the thing actually preventing it. Ordered the same way as the gaps in
`01-parity-checklist.md` §J, plus three structural risks that aren't single-row gaps.

| Risk | Checklist ref | Prevented by | How |
|---|---|---|---|
| Companion's Chat interface, read-only Terminal mode, or one of its 10 Manage sections (e.g. capability grants, restricted-tools) silently has no home in the final tree, because every round so far homed all 20 writes to one undifferentiated tab | §B, §J.1 | P2-6 | DoD requires each of the 3 modes and the Manage sub-sections to individually land on the tree, not just "a Companion tab exists" |
| The session node ships with an invented 5-tab/4-tab shape that doesn't match what Queue/Wakes/the task card actually are today (inline sections), either silently flattening them or inventing tabs nobody decided on | §B, §J.2 | P2-7 | DoD requires an explicit decision (escalated to the owner if not already made) before building, and a Playwright check against the *decided* shape |
| A keyboard shortcut (Cmd+Enter submit, Cmd+F scoped find, terminal smart clipboard) quietly stops firing because the new component tree re-wires `onKeyDown` differently or the DocFind/Terminal component isn't reused verbatim | §F, §J.3 | P2-8 | DoD is per-shortcut Playwright checks in the new location, not just "the page renders" |
| Board's multi-select priority/lane filters regress to the mockup's weaker single-select approximation, because that's what got proven interactively first | §C (Board group), §J.4 | P2-9 | DoD explicitly tests combining two priorities and two lanes, not just that *a* filter exists |
| A shared link (`?task=`, `?profile=&grant=`) silently 404s or opens the wrong thing once the URL scheme changes, breaking an existing bookmark or a cross-feature deep link (e.g. a capability-grant review flow that depends on `?profile=&grant=` landing correctly) | §G, §J.5 | P2-10 | DoD is a fresh-load Playwright test of both params against the Atlas scheme, not an assumption that "the destination exists so the link must work" |
| A brand-new install's first-run experience (the welcome modal) is simply missing because nobody ported `App.tsx`'s `FirstRunWelcome`, since it's easy to miss — it renders only once, gated on an empty project list | §E, §J.6 | P2-11 | DoD includes seeding a fresh-install state and asserting the modal renders |
| The credential-recovery banner regresses to printing nothing actionable, or worse, to verifying a pasted credential with a plain read (the exact anti-pattern `@decision 093981dd` names) — easy to get subtly wrong when re-implementing rather than reusing the component | §E, §J.7 | P2-11 | DoD exercises the banner with a deliberately wrong token and confirms it still uses the guarded verify-then-store path, not a new one |
| Browser-notification opt-in or the per-category mute in Settings stops being respected, so a muted category starts pinging again (worse than just losing a feature — it's a regression a user would experience as a bug, not an omission) | §E, §J.8 | P2-11 | DoD confirms the mute set from `lib/attention.ts` is still consulted in the new toast/notification path |
| A Settings section lands on the wrong side of the project/workspace split (e.g. a daemon-global section mistakenly scoped under one project, or vice versa) — this is a correctness regression, not just a placement gap, because the underlying `api.ts` call (`updateProjectConfig` vs `updatePlatformConfig`) differs per section | §A (row 17), §C (Workspace settings group), §J.9 | P2-12 | DoD walks every section against which `api.*` call it actually makes, not just where round 2's prose put it |
| `DocFind` (or any other "building block that moves with its page") is quietly dropped because nobody checks blocks inside a page, only the page itself | §F, §J.10 | P2-8 (folded in — DocFind is one of the 6 keyboard-shortcut rows) | same Playwright-per-shortcut discipline closes this alongside the others |

## Structural risks (not single checklist rows)

**Risk: the data layer gets forked "just this once," and correctness silently diverges.**
The single biggest protection in this plan is `02-architecture.md`'s hard rule — every Atlas screen reuses
`api.ts` + the existing react-query hooks verbatim. The danger is a well-intentioned one-off: a card
author adds a bespoke fetch inside a new Atlas component because it's "simpler for this one screen,"
bypassing `guardedFetch`'s credential-guard chokepoint or inventing a second cache key for the same data.
**Mitigated by:** P1-0's Reviewer pass on the switch + empty shell (catches the pattern early, while there's only one
card to review) and the "no new `api.ts` member without review" rule in the architecture doc — a bespoke
fetch inside a component is exactly the shape a Reviewer should flag on sight.

**Risk: phase 3 never actually happens, and the repo is left running two UIs indefinitely.**
A parity sign-off that never gets scheduled is the most common way a "build it alongside, switch later"
plan quietly fails — the old UI keeps working, so there's no forcing function to finish. **Mitigated by:**
making P3-sign-off a named card with its own DoD (not a vague "do this eventually"), and by this plan's
own §I row count (183 parity rows) being the literal, mechanical checklist that card runs against — there
is a concrete, finishable list, not an open-ended "make sure nothing's missing."

**Risk: this plan itself goes stale before the build starts.** The parity checklist is a snapshot of
`packages/web/src` at commit `436e55c6`. If substantial web changes land on `main` before phase 1 starts
(plausible — this is an actively-developed repo), some rows could drift (a new write action added to
`api.ts`, a nav destination renamed). **Mitigated by:** P3-sign-off re-running the same extraction method
rather than trusting this document's numbers frozen in time — the method (AST-parse + caller-scan with
positive/negative controls) is the durable artifact; the specific row counts in this plan are not.
