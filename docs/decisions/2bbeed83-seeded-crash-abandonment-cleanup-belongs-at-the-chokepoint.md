# 2bbeed83 — A seeded `session_recovery_abandoned` is cleaned at the seeding chokepoint, not in the seeding spec

Card `2bbeed83` (discovered from `ec1aa18e`). Fixed 2026-10-28. Anchor: `@decision 2bbeed83` in `packages/web/e2e/fixtures/daemon.ts`.

## Do not

- **Do not loosen a victim spec's assertion to absorb this, and never hard-code the inflated count.** The badge assertion in `nav-cleanup.spec.ts` is correct as written; what was wrong was the leak reaching it.
- **Do not move this cleanup into the seeding spec's own `afterEach`.** The seeder is incidental (below) — the next spec that names the kind for an unrelated reason re-opens the leak with nobody suspecting it.
- **Do not widen the cleanup beyond the ids this fixture itself recorded at seed time**, and do not move the call earlier than test teardown. Either change makes it capable of clearing a row a later spec legitimately depends on.
- **Do not reason about shared-daemon state across a test FAILURE boundary** (see the measurement trap below). In particular, do not read a spec passing right after a failing one as evidence that leaked state cleared.
- **Do not downgrade the read-back to best-effort.** A verified mismatch must throw: this cleanup exists precisely because a quiet no-op reddens a *later* spec, and the blamed spec is never the one that caused it.

## The defect

`nav-cleanup.spec.ts:43` (the classic rail's Alerts badge) read `2` where it expects `1`, deterministically, whenever `atlas-wave-replay.spec.ts` had run earlier on the shared worker-scoped e2e daemon. Pre-existing, and independent of `ec1aa18e` (it reproduced on the pre-`ec1aa18e` build too).

Measured by instrumenting the failing test and dumping the rendered attention plane plus the raw event rows: the extra item is **CRASH-LOOPED** (`cl-<eventId>`), from `lib/attention.ts`'s archived-crash-loop branch via `activeCrashLoopAbandonments`. The badge's `2` was that leaked item plus `nav-cleanup`'s own intended MERGE REQUEST.

## Why archival reveals this item instead of clearing it

`activeCrashLoopAbandonments` keys **purely** off the event stream — no liveness filter, no expiry, by design (`@decision 7be85378`: the disclosure must outlive the session it is about). It clears only when a later `session_recovered` for the same session supersedes it (latest-by-ts per session).

That inverts the relationship every other seeded attention item has with cleanup. A `merge_request` item needs a live manager *and* a live worker, so it self-cleans the moment `archiveSeededSessions` runs. This one is the opposite: the only thing suppressing it is the live-session dedupe inside the helper itself (`liveSessionIds.has(sessionId)` ⇒ skip), so archiving the subject session is what makes the item **appear** — daemon-wide, in `Sidebar.tsx`'s global Alerts count (`attentionItems.filter(it => !it.questionId)`) — for the rest of that worker daemon's lifetime.

## Why the chokepoint, and not the seeding spec's own `afterEach`

The precedents (`crash-loop-attention-archived.spec.ts`, `codex-isolation-gap-attention.spec.ts`) each hand-rolled this cleanup in their own `afterEach`, because each *deliberately* seeds the row it then has to clear.

This specimen is different, and that difference is the whole decision. `atlas-wave-replay.spec.ts`'s 420px fit check seeds the real event-kind **vocabulary** — `FIT_CHECK_KINDS` in `e2e/helpers/replayRow.ts` — purely for its long NAMES, which are what consumed the row's width in the defect that list exists to pin. It does not want a crash-loop item, and nothing at the call site hints it creates one. (The list contains `session_recovered` *before* `session_recovery_abandoned`, so the abandonment is latest-by-ts and active; reordering it would hide this specimen without fixing the class.)

An incidental seeder cannot be expected to clean up after a kind it never meant to seed. So the cleanup went to `seedOrchestrationEvent` — the single place every such row is created — rather than to the third spec in a row to be surprised by it, as the fifth forward leak `autoIsolation` closes centrally. The subject session is keyed `workerSessionId ?? managerSessionId`, matching what `activeCrashLoopAbandonments` itself reads, so the superseding row lands on the row the attention derivation actually consumed. `crash-loop-attention-archived.spec.ts`'s own `afterEach` was left in place: latest-by-ts makes a second `session_recovered` a no-op, and its read-back is still its own guard.

## The measurement trap this cost two runs on

`nav-cleanup.spec.ts:70` ("Alerts badge is empty when the only attention is requests", which asserts the badge has **count 0**) PASSED on every run in which `:43` failed just before it. That reads exactly like the leaked item having cleared itself, and it is not.

Playwright stops the worker process after a test failure and starts a new one, re-creating the worker-scoped `loomDaemon` fixture — i.e. a **brand new** isolated daemon on a fresh temp `LOOM_HOME`. Measured across that boundary: `allEventRows` 63 → 0, `archivedCount` 9 → 0. `:70` was passing against an empty daemon, not a cleaned one.

The control that settles it: re-run the same pair with `--grep-invert "<the failing test's title>"` so nothing fails. The leak then reddens the **next** test instead — `:70` went `Expected: 0, Received: 1` — proving the item is permanent for the worker daemon's whole lifetime and that whichever spec runs first after the seeder is the one that pays.

## Verification

2-file repro `pnpm --filter @loom/web test:e2e atlas-wave-replay nav-cleanup`: 1 failed / 9 passed before (`Expected "1"`, `Received "2"`), 10/10 after; `nav-cleanup` alone 4/4. RED proof: reverting **only** the single `supersedeSeededCrashAbandonments()` call in `autoIsolation` reproduces the exact original failure. Wide set, four foreground chunks: 318/318, 0 failed. `pnpm build` 0; `guards` 31/31.
