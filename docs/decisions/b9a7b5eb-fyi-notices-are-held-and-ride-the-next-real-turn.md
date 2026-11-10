# b9a7b5eb — no-action (FYI) notices are held and ride the next real turn

## Problem

A "no reply owed" `[loom:worker-idle]` notice and a resume-time project-memory re-inject each went out through `enqueueStdin` as a turn of their own. On a parked or snoozed manager that is a full no-op turn on a large context, for text that asks for nothing.

## Decision

- `EnqueueStdinTail.fyi` marks an entry as FYI. An FYI is held on `Live.heldFyi`, **never** pushed to `live.pending`. It therefore cannot start a turn, cannot drain, and is invisible to `getPending`, the worker `done` guard (unconsumed manager direction), `flushPending`, the restart-intent snapshot and every pending-keyed purge.
- It is bundled at the two points a real turn is written — `enqueueStdin`'s immediate-submit branch and `drainPending` — as a block placed FIRST (`[loom:fyi, no action needed] … [/loom:fyi]`, one line per entry; a multi-line entry such as a memory digest stays verbatim). The real turn's own text is LAST. The bundled text is what `submit()` records as `lastPrompt`, so a rate-limit replay re-sends the same turn.
- It never joins a coalesce run: it is not in `live.pending`, so the agent-kind and route-keyed loops cannot see it, and cross-sender one-per-turn is unchanged.
- A same-`questionId` held copy is superseded. Held FYI is bounded by `FYI_HELD_MAX_COUNT` (8, oldest dropped) and `FYI_HELD_TTL_MS` (6h), swept in `reconcile()`. Code constants, no config key.
- `purgeQueuedWorkerIdleNudges` (worker re-engage edge) and `purgeQueuedByQuestionIds` also reach a held FYI.
- A recycle/revive drops held FYI by construction (`flushPending` never sees them). The successor's kickoff carries fresh memory.
- **Claude-only.** A codex session (`liveCodex`) returns through `enqueueStdinCodex` before the FYI branch and gets the entry as a plain turn, exactly as before.

## Classified FYI

`notifyManagerOfIdleWorker`: `parked-wake`, `parked-background`, `parked-merge` (tag `fyi:worker-idle:<workerId>`). Resume's standalone project-memory re-inject (tag `fyi:project-memory`).

Left as wakes: every notice that asks the manager to act (`stranded`, `parked-gate-stale`, `parked-background-stale`, `parked-ack`, broken-spawn, never-completed, silent-finish, mid-first-turn-stale), the periodic `[loom:idle]` and every watcher note, the e3ccfb5f worker-report reminder (a deliberate wake to the worker itself), `resume-doc-watcher`'s note (it tells the manager to rotate its doc), and every `kind:"agent"` entry. Not changed: the companion-memory re-inject (`assistant` role) and the fork memory enqueue.

## Round 2 — when a held FYI may be bundled, and when it counts as delivered

- **Never bundled into a slash-command turn.** If the real turn's text, after `trimStart`, starts with `/` (the owner's `/compact` in a parked manager's composer, companion `/new` → `/clear`), the FYI is left held for the next ordinary turn: a block ahead of it would stop the harness running it as a command.
- **Never taken for a no-body submit.** When the submit will be an Enter-only redelivery or the ownership-mismatch give-up (`willRedeliverWithoutBody`, mirroring those two branches in `submit()`), no FYI is taken, so nothing is marked delivered that was never written, and `lastPrompt` equals what was actually written.
- **Delivered means confirmed.** A bundled FYI is tracked on `Live.bundledFyi` (per submit generation). Its `onDeliver` fires on that turn's confirm signal (`UserPromptSubmit` for the outstanding submit, or `Stop`), exactly once. A give-up (`requeueGiveUpOrigin`) puts the FYIs back on the FRONT of `heldFyi` (no duplicate id/`questionId`, still cap-bound) and fires nothing.

## Project-memory digest

The pool digest is stamped only from the FYI's `onDeliver`, i.e. once the turn that carried it is confirmed. A held-then-dropped (cap, TTL, recycle, restart) or given-up memory FYI stays unstamped and re-fires on the next resume. With nothing to send, the digest is stamped immediately as before.

**Scope:** the resume re-inject is an FYI only for a role that parks via `idle_report` (`manager`, `platform`). Every other role (plain/owner sessions, companion `assistant`, workers) keeps the own-turn behaviour with an immediate stamp, so a raw-terminal session is never left waiting for a turn that may never come.

## Do not

- Do not push an FYI to `live.pending` (or give it any path to `drainPending`/immediate submit on its own): that is exactly the wake this record removes.
- Do not stamp the project-memory digest at enqueue or at write; stamp it on the carrying turn's confirm only.
- Do not bundle an FYI into a turn whose text starts with `/` (it would no longer run as a slash command), nor into a no-body redelivery.
- Do not mark a bundled FYI delivered before its turn is confirmed; a give-up re-holds it.
- Do not make the resume memory re-inject an FYI for a role that does not park via `idle_report`.
- Do not reclassify an actionable notice as FYI to save a turn, and do not reclassify the e3ccfb5f worker-report reminder: it is a deliberate wake.
- Do not make FYI persist across a restart or a recycle; it is advisory and regenerated.
- Do not give codex a held-FYI path without first giving `enqueueStdinCodex` a real hold/bundle design.
