# 38ef3d5f — the restart notice and `question_pull` share ONE "pullable answered" predicate

## Part 1 — false "you have an answered question awaiting question_pull"

`[loom:daemon-restarted]` printed that line when `wake-impact.hasUnconsumedAnswer` found any `state = 'answered'` row for the session (`listQuestionsForSession`). `question_pull` excludes an answered ssh-approval hold (`permission_action` starts with `SSH_APPROVAL_ACTION_PREFIX`; its answer reaches the worker through the `[loom:ssh-approval-answered]` nudge and `ssh_exec`'s own claim), so such a row stays `answered` for the life of its grant and the notice fired on every restart while `question_pull` returned `{questions:[], remaining:0}`. Real specimen: a Homelab manager's standing-grant ssh approval row. A second, smaller drift: the notice was session-id scoped, `question_pull` is agent-lineage scoped.

Now `pullableAnsweredWhere(alias)` in `db.ts` is the single SQL fragment every pull variant, the answered-stuck watchdog and `Db.hasPullableAnsweredQuestionForAgent` (the notice's peek) interpolate.

## Part 2 — `question_resolve` recorded an EARLIER owner message

The owner's reply arrived while the manager was busy, sat in `live.pending` with its `ownerText`, and was handed over by `inbox_pull` (`PtyHost.consumePending`), which spliced the queue and returned only the text. Nothing attributed that `ownerText`, so `question_resolve` (`active ?? recentOwnerTurns[0]`) took the previous, genuinely attributed owner turn. Not a regression of `d326c3c2` (no raw-terminal race) and not a Companion path.

`consumePending` now records each pulled entry's `ownerText` in FIFO order (`attributePulledOwnerText`), writing ONLY `activeTurnOwnerText` and the recent-owner ring, never a `lastPrompt*` field. The pull happens MID-TURN, and `lastPrompt`/`lastPromptSenderId` still describe the in-flight (possibly agent-authored) turn, so rewriting `lastPromptOwnerText` would let `resumeAfterRateLimit`'s blocked branch re-queue that turn carrying the pulled owner text under the agent's sender id (the `f286919e` split). A codex Live (reachable via `findAnyLive`) gets the same active + ring write, as `drainCodexPending` does.

The pull path is deliberately STRICTER than the normal drain. The drain delivers in order, so it can never meet an entry older than one already attributed; a pull can (a requeued entry with an older rank). It therefore skips an entry whose numeric rank is below `Live.highestOwnerTextSeq`, the highest rank ever recorded on that Live (monotone). The baseline is NOT `lastPromptOwnerTextSeq`: `submit()` nulls that on every non-owner turn, so "rank 5 owner turn, worker-report turn, pulled rank 4" would overwrite the newer turn (`2400d0bc`/`270b963c`). An unknown (`null`) rank is recorded but never outranks and never clears the race marker.

Tests: `test/inbox-pull-owner-attribution.mjs` (checks 6 and 7 pin the two points above).

## Do not

- Do not re-spell the ssh-approval exclusion at a call site, or decide "has something to pull" from a raw `state === "answered"` count.
- Do not scope the notice's peek by session id; it must use the same agent-lineage JOIN as `question_pull` (see `f88e91f0`).
- Do not splice a queued entry out of `live.pending` for delivery (inbox_pull or any new consume path) without attributing its `ownerText`.
- Do not let an older-ranked pulled entry overwrite a newer attributed owner turn; baseline the check on `highestOwnerTextSeq`, never on `lastPromptOwnerTextSeq`.
- Do not write any `lastPrompt*` field from the pull path.
- `consumePending` is manager-only (`pullManagerInbox`); widening it to any other role (especially assistant/Companion) needs a trust-window review first, since every `activeTurnSenderId`/attestation reader is a Companion lever.
