# 5244adc2 — decision-records Read hook is wired only when a record store exists, re-evaluated per spawn

## Narrative

Card `5244adc2` is the remaining half of card `661b7d46` DoD-2's "no injection, no overhead": the
decision-records `PostToolUse` (`Read`) hook group is wired ONLY when `repoPath` resolves to a project
that has adopted at least one of the three record stores (`docs/adr`, `docs/decisions`,
`docs/investigations` — checked via `anyDecisionRecordStoreExists`, deliberately duplicated from
`decision-records.mjs`'s own runtime `anyStoreExists` bail rather than imported, since that script ships
as a standalone asset invoked via a bare `node <path>` spawn, independent of this package's compiled
`dist/` — the two must be kept in sync by hand). A project with none of the three never spawns the
hook's node process on ANY `Read`, meeting "no overhead" literally rather than via the script's own fast
in-process bail (which stays in place as the backstop for a store deleted mid-session). `repoPath`
OMITTED (not every caller threads it) falls back to the pre-`5244adc2` behavior of always wiring the
hook, so every existing caller stays byte-identical without change.

⚠️ STALENESS WINDOW: `writeSessionSettings` runs at every `createPty` (fresh/resume/fork/recycle), so
this decision re-evaluates on every respawn — a project that later adopts a record store picks the hook
up on its NEXT session with no daemon restart needed. A session already LIVE when the first store
appears will NOT have the hook wired until its own next resume; this is an accepted, documented gap, not
a bug.

## Do not

- Do not assume a record store adopted mid-session is picked up by a still-live session — it is only
  wired again on that session's next resume (fresh/fork/recycle all re-run `createPty` too).
- Do not remove or let drift the daemon-side `anyDecisionRecordStoreExists` duplicate check without also
  updating `decision-records.mjs`'s own `anyStoreExists` — `test/decision-records.mjs` pins
  `DECISION_RECORD_STORE_KINDS` against that script's own literal store-kind checks specifically to
  catch a divergence loudly instead of silently.

## Source

Inline comment in `packages/daemon/src/pty/claude-settings.ts` (`writeSessionSettings`'s own doc
comment, the decision-records hook paragraph), commit `67e5c6729` (2026-09-09).
