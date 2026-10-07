# ed0858dc — a parentless codex session's isolation-gap disclosure reaches the human through the attention queue

## Do not

- Do not filter these rows on `detail.nudged === false` alone. That field is `!alreadyNudged && !!s?.parentSessionId`, so `false` has TWO causes that are indistinguishable from the field by itself: *nobody to tell* (the gap this surfaces) and *a manager was already told earlier in this recycle lineage* (an ordinary managed worker, which re-files on every subsequent spawn — pure noise). The second filter, `managerSessionId === workerSessionId`, is what separates them.
- Do not add a liveness filter to `activeCodexIsolationGapAlerts`, by analogy with `activeBootStuckAlerts`. A boot-dialog alert is actionable only while the session is live; this one reports a standing CONFIGURATION fact whose remedy (the agent's profile harness) outlives the session that disclosed it.
- Do not key the alert per session. The actionable unit is "this agent's harness drops these protections" — ONE decision however many sessions disclose it. Per-session keying emits N rows for N runs of one misconfigured agent.
- Do not move the parentless/`nudged` test INSIDE the latest-wins fold (i.e. `continue` before `latest.set`). That makes the alert permanent, because a superseding row would be skipped rather than win its key. See "Why the test runs after the fold" below.
- Do not re-add a per-manager fan-out to fetch these rows. That is card 43084723's standing rule, for the same reason it was made there: the row must stay reachable once its filing session is no longer a live manager.
- Do not describe these items to the user as "read-deny protections", and do not tell the user the codex session "can read those files". `permissionDeny` is the project's AUTHORED `permission.deny` rule set, which can deny edits and commands too — see `codexPermissionDenyReason` (`daemon/src/profiles/codex-compat.ts`). Only the other three ids are read-denies.
- Do not read the 500-row `listRecentEventsByKinds` window as a cleared bound (see "The disclosed bound" below).

## The gap

`handleCodexIsolationGapDisclosed` (`daemon/src/sessions/service.ts`) files a durable `codex_isolation_gap_disclosed` row on EVERY codex spawn that drops a claude-side protection, but only nudges a recipient when the session has a `parentSessionId`:

```ts
const nudged = !alreadyNudged && !!s?.parentSessionId;
```

Run sessions (`startRun`) are parentless by design, and card 2127d695 ruled a codex-harness run legitimate. Nothing under `packages/web/src` read either `codex_isolation_gap_disclosed` or `codex_unsupported_capability` (verified: zero grep matches, with the same pattern returning hits on `packages/shared/src/types.ts` and on web src for the kinds web *does* read, so the search was capable of finding them). So for a codex run session the only trace was a durable `nudged:false` row nobody was pointed at.

This is the same blindness shape as `claude_boot_dialog_stuck` (cards b1da256d / 43084723): an event filed under `parentSessionId ?? sessionId` that no per-manager fan-out could reach. It gets the same remedy — ONE cross-session, kind-filtered fetch feeding `useAttention`.

## Why the attention queue, and not the run detail or the session panel

The run detail (`web/src/pages/Runs.tsx`) and the session panel (`web/src/pages/SessionView.tsx`) are both passive notices on pages nobody opens unprompted; the run detail also covers only run sessions, while the gap is parentless sessions generally. Loom's own project memory records the measured split: a passive notice was acted on 0 times, an addressed signal 4/4. The attention queue is the one surface that reaches a human without them going looking (Mission Control, the owner's Overview, the bell, the toast, the command palette).

The session panel is not lost by this choice: `attentionOpenTarget`'s generic branch already routes any item carrying `sessionId` to `/session/:id`, so "Open" lands there with no change to that function.

## How parentlessness is derived, and where that invariant is pinned

The daemon files `managerSessionId: s?.parentSessionId ?? sessionId` and `workerSessionId: sessionId`, so the two ids coincide exactly when there was no parent. The web helper reads that, which means **a web reader depends on a daemon invariant.**

An explicit additive `detail.parentless` flag was considered and rejected: pre-existing rows lack the key, which would force the web code to carry two read paths forever. One path, pinned by a test, is cleaner.

So the invariant is pinned behaviourally in `packages/daemon/test/codex-permission-deny-disclosure.mjs` section (6), with a negative control: the same predicate is run against a counterfeit row filed under a DIFFERENT `managerSessionId` and must reject it. Without that control the assertion would pass on `nudged:false` alone and prove nothing about the id equality that actually does the discriminating.

## Why the test runs after the fold

`activeCodexIsolationGapAlerts` folds EVERY `codex_isolation_gap_disclosed` row by (agent, item-set) first, and only then tests the winner for parentlessness. This is the same two-phase shape `activeBootStuckAlerts` and `activeVaultLockAlerts` use, and for the same reason: **a later row has to be able to supersede an earlier alarm.**

The superseding row here is a disclosure for the same (agent, item-set) that was NOT parentless — meaning the most recent thing Loom knows about this configuration did reach a manager, so the human's copy of it has been handed off and should clear. Without the two phases the alert is permanent: a managed worker of the same agent disclosing the same set would be skipped by the filter rather than winning its key, leaving the human item up forever even after the issue was routed to a manager.

Two notes on the scope of that clearing:

- A superseding row with `nudged:false` (lineage-deduped) also clears it. That is correct — that value means this lineage already nudged its manager for this exact item set.
- An agent is project-scoped in Loom, so "a managed worker of the same agent" can never be a worker in a different project. The clearing cannot leak across projects.

This also happens to be what lets the e2e spec clean up after itself without any new daemon surface. That is a consequence, not the reason — the behaviour above is right on its own merits, and it was found by asking why the sibling `merge_request` spec self-cleans (its item has a liveness filter) while this one would not.

## The disclosed bound

These rows arrive via `db.listRecentEventsByKinds`, whose `limit = 500` its own doc describes as "sized for a rare, detector-fired kind pair". **This kind is not rare**: `settingsDirReadDeny` is pushed unconditionally for every codex spawn (`pty/host.ts`), so on a codex-heavy fleet the newest-first window can truncate.

The per-(agent, item-set) keying is what makes that harmless in practice — an agent's gap falls out of view only after 500 NEWER rows, by which point a newer row for that same agent has almost certainly re-seeded the same key. Raising the limit was considered and deliberately not done: it is a disclosed bound, not a cleared one.

## Keying detail

The item's React/toast `key` is `cig-<event id>`, NOT the dedup key — considered and chosen, not an oversight. The visible ROW is already deduped to one per (agent, item-set) by the helper, so the only thing the event-id key changes is that a *fresh* disclosure of the same gap (a new run of the same misconfigured agent) counts as a new item for `useNewAttention` and so re-raises its transient toast. That is defensible: a new run really did newly drop those protections. And it cannot nag, because `useNewAttention` reads `useAttention()`'s already-dismiss-filtered list — so once the human dismisses the gap, later runs of the same agent re-raise nothing.

The dedup key is `${detail.agentId ?? detail.lineageRootId ?? sessionId}:${detail.itemsKey}`. `detail.agentId` can legitimately be `null` (the handler reads it off a session row that may be gone), so the key degrades through `lineageRootId` to the session id rather than collapsing every null-agent row onto one shared key. The same string is the item's `dismissKey`, so a dismiss sticks for that agent's current item set and a NEWER, larger item set re-surfaces as its own row.
