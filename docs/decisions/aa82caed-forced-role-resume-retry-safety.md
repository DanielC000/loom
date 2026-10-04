# aa82caed — make `resume()`'s forced-role-to-claude redirect retry-safe

## Background

`resume()`'s `resumeForcedRoleAsFreshClaude` (ruling 1(b) of card `7955458e`) boots a codex-pinned
manager/Lead/auditor/workspace-auditor/setup/assistant row FRESH on claude, under the same session id,
when its ROLE is in `TRANSCRIPT_ROOT_DENY_ROLES`. Before this card, `Db.setSessionHarness(session.id,
undefined)` ran BEFORE `pty.spawn`, and never touched the row's `engineSessionId`.

That ordering had two failure windows, both producing the identical bad state — `harness` flipped to
claude, paired with the OLD codex `engineSessionId`:

1. The fresh claude `pty.spawn` itself throws (`reconcileFailedSpawn` catches, rethrows).
2. The daemon dies after `pty.spawn` returns but before the fresh claude session's own SessionStart hook
   fires and overwrites `engineSessionId` via `Db.setEngineSessionId`.

In either window, the NEXT `resume()` call computed `forcedRoleFreshStart = session.harness === "codex"
&& ...` as `false` (harness was already claude), fell into the ordinary resume path, and called
`engineTranscriptExists(session.cwd, <stale codex id>, "claude")` — which can never match a codex engine
id against claude's own transcript store. That threw `"session is no longer resumable (engine transcript
missing)"` and called `db.setResumability(session.id, "dead")`. Boot's `sweepDeadSessions` (which runs
EARLIER in boot than fleet-resume, and independently) performs the identical check
(`s.engineSessionId && !engineTranscriptExists(s.cwd, s.engineSessionId, s.harness)`) and marked the row
dead on its own, before `resume()` ever got a chance to run. Either way, a transient spawn failure or an
ordinary crash in a narrow (but real — OS process startup, not JS-tick-narrow) window permanently
stranded a manager or Platform Lead.

## Decision

**Move the harness flip to run ONLY after `pty.spawn` has returned without throwing, and clear the
row's stale `engineSessionId` in the SAME write as the flip.**

1. `resumeForcedRoleAsFreshClaude` no longer calls `Db.setSessionHarness` before `pty.spawn`. It now
   calls it immediately after the `try { this.pty.spawn(...) } catch { reconcileFailedSpawn; throw; }`
   block succeeds (same spot `recordHarnessRoleForced` already ran from).
2. `Db.setSessionHarness` now clears `engine_session_id` to `NULL` in the SAME `UPDATE` statement that
   flips `harness`, rather than leaving the old codex id in place.

This closes both windows:

- **Window 1 (spawn throws):** the flip line is never reached at all. The row keeps `harness: "codex"`
  and its real codex `engineSessionId`, untouched — exactly its pre-redirect-attempt state. The next
  `resume()` recomputes `forcedRoleFreshStart = true` and retries the redirect from scratch, cleanly.
- **Window 2 (daemon dies after spawn, before SessionStart):** the flip (now also clearing the engine
  id) already ran synchronously right after `pty.spawn` returned, so the row is left as `harness:
  "claude"`, `engineSessionId: NULL`. `sweepDeadSessions`'s guard (`s.engineSessionId && ...`)
  short-circuits on the falsy id and never marks it dead. `resume()`'s own guard
  (`if (!session.engineSessionId) throw new Error("session has no engine id to resume")`) throws that
  same ordinary, pre-existing, non-dead-marking error every other "no engine id yet" row already throws
  (asserted directly by `codex-role-force-start-matrix.mjs`'s own `(RESUME CONTROL)` case) — never
  `setResumability("dead")`. The row is not marked dead; it is still not auto-resumable (`resume()`
  throws `"session has no engine id to resume"`) — the same accepted residual as an ordinary fresh row
  that crashed before its own first SessionStart, not a new or worse failure mode.

## Why this split, not the alternatives considered

- **Why not ALSO widen `forcedRoleFreshStart`'s detection (e.g. to fire on `engineSessionId == null` for
  a `TRANSCRIPT_ROOT_DENY_ROLES` role) so Window 2 fully re-enters the redirect too, not just avoids
  "dead"?** Rejected: `engineSessionId == null` is NOT specific to a role-forced redirect-in-progress — it
  is the SAME state an ORDINARY (never-codex) fresh claude manager row is in if it crashes before its
  very first SessionStart ever fires. Widening the condition on `engineSessionId == null` alone would
  route that ordinary case into `resumeForcedRoleAsFreshClaude` too, which composes a notice claiming
  "Your prior engine was 'codex'" — false for a session that never was. Window 2 "merely" throws the same
  benign, already-accepted "no engine id to resume" error every such row throws today; it does not
  self-heal into a fresh boot, but it does not lie to the resumed agent or get marked dead either, and
  this mirrors the ALREADY-ACCEPTED residual gap documented for codex's own lazy rollout-file write (see
  project memory `codex-rollout-written-at-first-turn-not-boot`) — "fails safe with a named, caught
  error" is the established bar for this class of narrow boot-crash race in this codebase, not full
  auto-recovery.
- **Why not a bidirectional self-heal in `sweepDeadSessions`/`resume()`'s transcript-exists guard (flip
  harness back to "codex" when the stored id resolves under the OTHER harness's transcript store)?**
  Considered, and strictly more correct (it WOULD make Window 2 re-enter the redirect automatically), but
  it reaches into the generic, harness-agnostic liveness sweep and resume's generic transcript guard —
  shared code paths this card's narrow P2 scope does not need to touch. The chosen fix needs no change to
  either generic guard: Window 2 already never reaches them, because the cleared engine id short-circuits
  both before they'd ever evaluate `engineTranscriptExists`.
- **Why not leave the stale engine id in place and ONLY move the flip's timing (option 1 alone, no
  engine-id clear)?** Rejected: this closes Window 1 but not Window 2 — the flip still happens
  synchronously right after a successful `pty.spawn` return, well before SessionStart can fire, so a
  crash in that gap reproduces the exact original mismatch (`harness: claude`, stale codex
  `engineSessionId`) just inside a narrower window. `sweepDeadSessions` still marks it dead.

## Judgement call left to this card: the isolation-gap nudge dedupe-per-lineage gap

Raised by `7955458e`'s own approving review: the manager-side `codex_isolation_gap_disclosed` nudge is
deduped per LINEAGE (`Db.hasNudgedEventForLineageItems`, keyed on `(lineageRootId, itemsKey)`) — so a
manager recycled AFTER its predecessor was already nudged for a given item-set is never itself nudged
again for that same item-set. The durable `codex_isolation_gap_disclosed` EVENT still fires on every
spawn regardless (audit trail intact); only the manager-facing NUDGE is suppressed for a repeat within
the same lineage.

**Decision: leave this as-is, do not change it.** The dedupe's entire stated purpose (ruling 4 of
`7955458e`) is to stop a long-lived manager/Lead/assistant's repeated resumes from flooding its own
inbox with a notice it already received — a recycle is, from the nudge's perspective, just another
resume-shaped event in the SAME lineage, and the isolation gap it would be renotifying about (codex
dropping the transcript-root/settings-dir/permission-deny protections) has not changed since the
predecessor was told. Re-nudging on every recycle would defeat the exact flooding problem ruling 4 fixed,
for no new information. If a FUTURE item is added to the same lineage's isolation-gap set, the existing
`itemsKey` component of the dedupe key already re-nudges for that (a new item-set is a new key) — so the
dedupe is not blind to genuinely new information, only to a repeat of an already-disclosed set. Not
built here — no action is warranted, so no follow-up card or note is filed for it either; this record
is where the judgement call and its reasoning live.

## Do not

- Do not call `Db.setSessionHarness` before `pty.spawn` in `resumeForcedRoleAsFreshClaude` again — that
  reopens both windows this card closed.
- Do not widen `forcedRoleFreshStart`'s `session.harness === "codex"` condition to also fire on
  `engineSessionId == null` — that collides with an ordinary (never-codex) fresh session crashing before
  its own first SessionStart, and would send that session a false "your prior engine was codex" notice.
- Do not treat Window 2 landing on `"session has no engine id to resume"` as a regression to fix further
  in this card — it is the same pre-existing, accepted, non-dead-marking outcome every other "no engine
  id yet" row already produces (see `codex-role-force-start-matrix.mjs`'s `(RESUME CONTROL)` case), not a
  new failure mode.
- Do not add a self-heal to `sweepDeadSessions`/`resume()`'s generic `engineTranscriptExists` guard to
  "fully" close Window 2 — out of this card's scope; the chosen fix already prevents Window 2 from ever
  reaching those guards.

## Source

Implementation: `packages/daemon/src/db.ts` (`Db.setSessionHarness` — now clears `engine_session_id` in
the same write), `packages/daemon/src/sessions/service.ts` (`resumeForcedRoleAsFreshClaude` — the flip
moved to after a successful `pty.spawn`).

Tests: `packages/daemon/test/forced-role-resume-retry-safety.mjs` (new — Window 1: a forced throw on the
fresh claude spawn, then a second `resume()` re-enters the redirect and boots, row never marked dead;
Window 2: a row manufactured directly in the post-flip/pre-SessionStart state, then `sweepDeadSessions`
+ `resume()` are both run against it and neither marks it dead).

## Amendment (card 2911bc9b): considered no-build for Window 2

Card `2911bc9b` asked whether to fully close Window 2 by keeping `harness` at "codex" until claude's fresh engine id actually arrives, marking the redirect "in progress" so a crash in the window re-enters cleanly instead of landing on "no engine id to resume".

Decision: no-build. The residual is real but narrow, and closing it costs more than the residual carries.

### Window width (measured)

`resumeForcedRoleAsFreshClaude`'s spawn is a FRESH, non-resume, unattended-role spawn — the same shape `CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS`'s own telemetry comment is sized from (`pty/host.ts:1374-1381`): 778 real fresh-spawn SessionStart latencies measured on the owner's fleet, median ~3.2s, p99 ~10.6s, worst observed 90.4s.

So the exposed window — spawn succeeding to SessionStart actually firing — is single-digit seconds typically, under ~11s 99% of the time, and has never been observed past ~91s.

### Population (decaying, not steady-state)

`forcedRoleFreshStart` only fires when `session.harness === "codex"` on a row whose role is in `TRANSCRIPT_ROOT_DENY_ROLES`.

`resolveAgentSpawn`'s `roleForcesClaude` (`sessions/service.ts` ~line 2853) already forces claude at spawn time for these roles going forward — a fresh session can no longer be created with this combination.

`Db.setSessionHarness` is documented as the one deliberate exception to harness being write-once-at-insert (`db.ts` ~line 5925), and it is only ever called from this one redirect, after a successful spawn — so a row that redirects once is harness="claude" permanently afterward and can never re-enter this branch again.

The only rows that can ever reach this branch are legacy rows pinned "codex" before card `7955458e`'s enforcement shipped, or a row created via the explicit-role-start bypass this record's own "Do not" section above names — a fixed, one-shot-per-row, shrinking population, never replenished by anything in the current codebase.

### Cost when it lands

Unchanged from this record's own Window 2 analysis above: the row is not marked dead, `resume()` throws the same benign "no engine id to resume" error every other pre-first-SessionStart crash already produces, and a human starts it fresh — the established, already-accepted bar for this class of race (see the codex-rollout-lazy-write residual cited above).

### Verdict

A crash landing in a single-digit-second window, on a population that only shrinks and is never replenished, producing the same already-accepted outcome every other such crash produces — not worth the cost of closing below.

## Documented option, if a non-decaying source of codex-pinned deny-role rows ever appears

If some future change makes this population ongoing rather than one-shot-and-decaying (e.g. a new way to pin harness="codex" onto a deny-role row, or a bypass that persists), the following design closes Window 2 fully, with no new DB column.

Move both the harness flip (`Db.setSessionHarness`) and `recordHarnessRoleForced` out of `resumeForcedRoleAsFreshClaude`'s post-spawn block, into the `onEngineSessionId` handler (fired from `deliverHook`'s `SessionStart` case, `pty/host.ts` ~line 7148; wired generically in `index.ts` ~line 329).

Gate the flip on the same condition `forcedRoleFreshStart` already computes: `session.harness === "codex" && role in TRANSCRIPT_ROOT_DENY_ROLES`. When `onEngineSessionId` fires and the gate is true, do one atomic UPDATE — harness to claude AND `engine_session_id` to the new real id — instead of the ordinary write, then fire `recordHarnessRoleForced`.

No new "redirect in progress" marker is needed: the gate condition can only be true during a genuine pending redirect, because (per the population argument above) no other live code path can produce or reproduce that combination.

This closes Window 2 fully: a crash (or any pty exit) between spawn and SessionStart leaves the row untouched — harness still "codex", original engine id still intact — so the next `resume()` recomputes `forcedRoleFreshStart = true` and retries the whole redirect cleanly, identical to Window 1.

### If SessionStart never arrives (hook genuinely lost, not a crash)

The live pty keeps running fine regardless — its actual role/permission/MCP wiring came from the `spawn()` call's own opts, not from the DB harness column — but the row stays mismatched (harness "codex", stale codex engine id) for as long as the hook is missing.

Two consequences: anything keying off `(cwd, engineSessionId, harness)` for this row — transcript/context-stat lookups — won't resolve correctly while pending, a cosmetic gap, not a crash; and if this live session later exits for any reason while still pending, the redirect self-heals and retries fresh on the next resume, repeating the role-forced notice.

That repeat-notice behavior is a regression in "shows a stale notice again" terms, but a win in self-healing terms: today's eager-flip design leaves that same later-crash case permanently stuck needing a human, where the deferred design keeps retrying automatically. No sub-case was found where the deferred design is strictly worse than today's.

### Do not

- Do not move the flip into `onEngineSessionId` without first showing a non-decaying source of codex-pinned deny-role rows actually exists — the population argument above is the entire basis for this no-build, and it only holds while the population stays one-shot-and-decaying.
