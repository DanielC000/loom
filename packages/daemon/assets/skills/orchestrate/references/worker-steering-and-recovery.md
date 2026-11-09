# Worker steering, delivery, and recovery — detail

Read this when a steering message's delivery is in doubt (a PARKED notice, a held message, a redelivered
or stale-looking notice), when a worker looks idle-but-dead or its composer may be stuck, when you need
to set a worker's permission mode, when a card policy blocks a spawn or merge, when a report may have
been missed, or when a defect turns up in an already-merged worker's commit. The core doctrine keeps the
rules that must fire unprompted: `worker_message` vs `worker_redirect` and the bright line, verify the
tree before you hold a worker, the investigate-first checkpoint, verify-landed, and don't
double-dispatch.

## Messages that arrive without a body

**A report or message that arrives as a collapsed paste placeholder with no body is almost always Loom's own write, not a human message.** Check your own context first (often your own kickoff, earlier in this session); only then `inbox_pull` and check artifacts (a diff, a commit). Then split by WHOSE message is missing, and when the cases are indistinguishable, decide by cost:
- **No named sender** (your own kickoff/context, or a `[loom:prompt-mismatch]` on your own submit path): nobody to ask — say what could not be read, and move on.
- **A NAMED party's message is missing** and its content is nowhere in your context: **ask them to re-send it, and say why.** A `CONFIRMED` delivery means a turn RAN, not that the bytes ARRIVED. Asking wrongly costs one message; not asking wrongly silently destroys a real one.

## Queue vs composer; held messages; context

**⚠️ QUEUE and COMPOSER are different things, and `worker_redirect` only replaces the QUEUE.** It discards Loom's internal message queue; it does NOT clear text already written into the worker's terminal composer. A worker wedged by a **stranded, never-confirmed paste in its composer** is a different failure: `discarded:0` just means the queue was empty, not that the composer is clean, and the redirect's own instruction can land ON TOP of the stuck text, growing the stranded payload. **For a stuck composer, don't use `worker_redirect`**; use the composer ladder below (`worker_flush`, then `worker_recycle`).

**A held `worker_message` that will sit a while may come back with an advisory pointing you at `worker_redirect` as the faster path** (shown only when the wait is genuinely long). Read it as a prompt to re-decide, not as an obligation. **The reverse pairing:** a `worker_redirect` that discards queued direction reports how many messages it discarded. Before re-sending any, check whether the redirect's own new instruction already covers that content; if so, re-sending is a redundant second instruction, not a safety net. Re-send only what the redirect's text does NOT carry, and only once the worker has reconciled onto the new direction. Better, fold what's still missing into the redirect up front.

**Check a worker's context before relaying a heavy round.** `worker_message`/`worker_redirect` can carry an advisory `contextWarning` when the target's live context is already high (informational only, never blocks the call). Before piling a large round onto a worker near its limit, recycle it first (it keeps the worktree/branch/task).

## Permission mode

**Drive a worker's permission mode with `worker_set_mode`.** Valid values for a worker are `acceptEdits` / `auto`. **`acceptEdits` auto-approves FILE EDITS ONLY** (Edit/Write in the worktree). A worker that must **shell out (Bash) or call a non-allowlisted MCP tool** still hits a confirmation prompt under it, and an unattended worker can't answer, so it wedges; give THAT worker **`auto`**. Match the mode to the risk: a well-scoped, edits-only mechanical change runs fine on `acceptEdits`; anything that shells out or reaches beyond the allowlist needs `auto`. You **cannot** hold a worker in `plan` mode: the daemon rejects `worker_set_mode('plan')` because plan mode gates the worker's own `worker_report` behind a prompt nobody can answer. For an investigate-first gate, use a kickoff instruction (the core doctrine's investigate-first paragraph).

## Verifying a steering message landed; not double-dispatching

**Verify a steering message actually landed — but read the result precisely.** After `worker_message`/`worker_redirect`, two "not delivered" cases need OPPOSITE responses. **Held / queued** (the result names a queue position, or a reason like `held`) is a SUCCESS: the worker was busy, the message is durably enqueued and WILL land at its next turn boundary; do **not** re-send it (that is the double-dispatch forbidden below). A result that reached **nobody** (session gone / dead-dropped, no queue position) is the only genuine drop: re-check `worker_list`/`worker_transcript` for the worker's state and re-dispatch or recycle it.

**Don't double-dispatch an already-approved worker.** After you've unblocked or approved a worker, a redundant "start now" / "keep driving" nudge queues on top of work in flight, and if it lands mid-report it trips the `worker_report(done)` pending-guard (the daemon refuses the report until the worker reconciles the queued instruction), forcing a drain-and-re-report round-trip. Prefer ONE durable dispatch per decision. If you must nudge, first check `worker_list`/`worker_transcript` that the worker is genuinely idle, not working or mid-report.

## Investigate-first / plan-approval gates

**An investigate-first / plan-approval instruction given as loose PROSE is NOT a gate — make it a required checkpoint in the kickoff.** "Report your root cause + fix plan before you edit" phrased loosely is optional narration to a worker, which can write the plan as chat prose and edit in the very next step. Enforce it explicitly: require the worker to `worker_report` its root cause + plan as a `blocked` checkpoint (not `progress`: that relies solely on a push nudge that can be missed, while `blocked` also sets the durable `awaitingReview` flag `worker_list` shows you; `progress` stays right for an ordinary "FYI, still working"), then STOP and wait for your approval before any edit. A plan narrated as prose followed by edits does not satisfy it (the `/worker` doctrine backs this). Where the owner configured a **card policy** requiring this, the daemon already appends the instruction to the worker's kickoff and refuses the merge without a checkpoint report that precedes the first commit: don't re-add it by hand.

## Card policies

**Card policies are owner-set rules, enforced by the daemon.** `tasks_get` returns a `policy` field (present only when a policy matches the card) listing each requirement with a `status`: `met`, `unmet`, `unreadable`, `waived`, or `deferred`. Read it before dispatching or merging a card, and satisfy what's unmet: for a required review, `worker_spawn` a reviewer with `reviewOfTaskId` set to the card and wait for its `done` report (a later commit to the branch needs a fresh review); for a required approval, file a Request linked to the card (`question_ask` with `taskId`, type `permission`) and wait for the owner. A `worker_spawn` or `worker_merge_confirm` refusal naming a card policy is the rule working, not an error: satisfy it, or escalate. Never route around it (a different card, a batch, a recycle), and never ask a worker, another agent or the Lead to relax it; only the owner can waive a requirement.

## A PARKED notice, and the idle-but-dead worker

**A PARKED directive notice is not proof of loss — verify before recycling.** Loom's redelivery retries are bounded; when exhausted before the engine confirms a write, you get a notice that the message was PARKED. That is Loom's retry budget giving up, not evidence the worker never received it: the engine can confirm a write minutes later (no established upper bound). Before treating a parked notice as a reason to `worker_recycle` or `worker_stop`+respawn, check that SPECIFIC message with `worker_status({workerSessionId, msgId})`, which resolves it independently of whatever you've sent since. This matters doubly once you've sent a SECOND message: the tracked latest-directive state moves on, but the first message's resolution keeps happening, so check it by its own id. If still unresolved, give it real time (a safe floor is several minutes, not seconds, and not a hard ceiling); "no confirmation yet" means "still pending", never "confirmed lost". Recycling on a parked notice alone risks discarding a healthy, merely slow session and its accumulated work.

**A worker that looks idle-but-dead needs `composerDirtyLen`, not `busy`/`lastEngineOutputAt` — those two discriminate NOTHING in this failure mode.** The shape: Loom wrote text into a worker's composer (a kickoff or nudge) but the engine never confirmed submitting it, so no turn ran, yet the row can read `busy:false` like a healthy idle worker, and `lastEngineOutputAt` is silent since no turn produced output. Read `composerDirtyLen` (on `worker_list`/`worker_status`): `0` means genuinely clean, `null` means "not live in this process" (never read an absent signal as a measured zero). It has a blind window: Loom's give-up/retry budget needs tens of seconds to exhaust before it marks a stranded composer dirty, so a `0` moments after you dispatch or message a worker is not yet proof of health; give it a few minutes.

**On a non-Claude harness (e.g. codex), `composerDirtyLen` AND `lastEngineOutputAt` ALWAYS read `null`, for the life of the session.** That instrumentation is specific to Claude's Ink-TUI plumbing; a `null` there is an honest "not applicable", never evidence the worker is dead. Don't diagnose it. Fall back to `turnSeq`/`neverCompletedTurn` and `lastActivity` (DB-persisted, harness-agnostic) or a direct transcript read; the "free discriminator" paragraph below still applies. A non-null, advancing `lastEngineOutputAt` on such a worker is a live regression (terminal repaint read as liveness), not a feature; distrust it.

**Non-zero `composerDirtyLen` paired with a stalled `lastActivity` is weaker evidence than it looks — the two are not independent.** `lastActivity` only marks turn START, so ANY long-running turn stalls it, healthy or not. Loom's give-up/retry can also be a false negative (it gives up on a delivery that reached the engine a moment later, and a real long turn starts). That yields exactly this pairing on a perfectly healthy session. Treat it as SUSPICION at most, never strong evidence on its own, whatever `turnSeq:0` + an empty transcript suggest inside the blind window above.

**The free discriminator: something ADVANCING, or a real turn-end.** `turnSeq`/`ctxTurns` moving between two reads, or a `Stop` hook having fired for the worker, proves a turn genuinely ran; check either before trusting the composerDirtyLen+lastActivity pairing. When daemon logs are readable, a `[submit] … CONFIRMED` line followed by `[prompt-echo] byteIdentical=true` settles delivery outright. **`byteIdentical=false` is the other half of that signal; never read a CONFIRMED line alone as proof of delivery.** It means the submitted content did not match what was written for that turn: the text you intended may never have reached the worker (a possible LOSS), and what WAS submitted may be a re-delivery of an earlier message resurfacing as new (a possible DUPLICATE). A dedicated mismatch notice naming both possibilities, with observed lengths/hashes, is delivered into the affected session; read it as a real signal, and re-check what that turn actually acted on before trusting a report or decision that followed it.

## The composer ladder

**Try `worker_flush` BEFORE you trust a non-zero `composerDirtyLen` — a disambiguator first, a remedy second.** A non-zero reading isn't always a stranded composer: one give-up shape (the engine produced output after Loom's final Enter attempt, so Loom believed the turn started) has no automatic clear path and can sit non-zero indefinitely against an empty composer and a healthy worker. `worker_flush` presses Enter on that worker's OWN composer, writing nothing new, and answers directly: `composer-empty` means nothing was stranded (stop there); a genuine attempt-and-fail means something really is sitting unsubmitted. It is also a real remedy once you know the composer is dirty, alternative to `worker_message` (which APPENDS, compounding an oversized unconfirmed payload) and `worker_stop` + respawn (which DISCARDS accumulated work); call it FIRST, before any destructive remedy. It is a no-op on a clean composer, so speculative calls cost nothing; `confirmed:false` on a dirty one just means this attempt didn't land. **Read `recovered` alongside `confirmed`:** `recovered:true` means your call unstuck the worker (busy cleared, stranded text requeued for its next natural drain), so don't keep re-flushing; `recovered:false`/absent with `confirmed:false` means still unresolved: a real turn may yet land the hook, or the worker is stuck and another flush is worth trying.

**The remedy ladder for a stuck COMPOSER, in order: `worker_flush` → wait → `worker_recycle`. ⛔ `worker_redirect` is NOT a rung.** Once `worker_flush` shows a genuinely stranded, unconfirmed composer (not a queued message), redirect replaces the QUEUE, not the composer, and lands its instruction on top of the stuck text. If repeated flushes keep returning `confirmed:false` with no `recovered`, escalate to `worker_recycle`, which keeps the SAME worktree/branch/task so code and intent survive. Bias toward waiting before recycling; when you do, **board whatever direction the successor must see as a card (or update the task's body), not just a chat message or queued send**, since a card survives a recycle and a message in a discarded session's queue or composer does not.

**Whichever signal flags it, bias toward waiting, not stopping** (same asymmetry as the parked-directive guidance). Loom's retry/heal can resolve a dirty composer on its own, while `worker_stop` + a fresh `worker_spawn` discards a live, recoverable session and its work. Verify via `worker_transcript`/`worker_list` that nothing is happening and try `worker_flush` first; stop-and-respawn is a last resort, not a first response to an idle-looking row.

## Missed reports and stale notices

**`staleReport` (on `worker_list`/`worker_status`) is about YOUR OWN session, not the worker's.** It fires once you've kept taking turns since a worker's report landed without resolving it, which can mean the report never surfaced in your context though durably recorded. Pull `worker_report_get(workerSessionId)` to read it in full before deciding there's nothing to act on; it reads straight from durable event storage, so a truncated tool-call argument or rotated engine session id can't lose anything. `worker_transcript(lastN:2)` is fine for general context but is not the recovery path for a specific missed report.

**A redelivered notice can itself be stale — decline it, don't trust its own framing.** A `[loom:paste-recovery]` or `[loom:possible-duplicate root:…]`-tagged (or similarly-worded) notice claims you haven't seen the message it re-presents, but that claim comes from the delivery machinery and is false for anything you already fully processed, in both directions (a redelivered `worker_report` you already acted on, possibly re-presenting a stale instruction or authorization as current, or a redelivered instruction of your own). Check your own state for evidence you already handled it (a merge confirmed, a decision relayed, a board state that reflects it). The cheapest tell: the payload quotes state OLDER than something you've produced since (elapsed time, a commit sha, a decision already acted on). Found an artifact that **postdates** it? DECLINE the notice, don't re-act, and say so in your next update, naming what you checked. Found none? Treat it as live.

## A worker's own stray process

**A WORKER's own stray process (escaped/detached dev server, stuck test runner, post-crash zombie)
has a dedicated on-demand path: `worker_reap`.** It is daemon-executed, scoped strictly to that
worker's worktree (matched by executable path/cwd/command line, never a bare image name or port),
and doesn't stop the worker. Use it instead of hand-rolling a `kill`/`taskkill` yourself or asking
the worker to (a raw kill may be blocked by Claude Code's auto-mode safety classifier).

## A defect in an already-merged worker's commit

**A defect found in an already-merged worker's commit → `worker_revive`, not a fresh guess.** After
a merge the worker's worktree and branch are gone but its conversation survives. File a NEW
follow-up card for the fix (its title becomes the squash subject; never reopen the merged card),
then call `worker_revive({workerSessionId, taskId, note})`: it forks that worker's context onto a
fresh worktree cut from current main, bound to the follow-up card. It counts against your worker
cap and is refused for an unmerged/live/non-yours worker, a codex-harness worker, or a missing
transcript (then `worker_spawn` a fresh worker with the offending commit sha in its kickoff). The
revived worker is told its remembered paths are stale; expect it to re-read before editing.
**Revive carries the whole old conversation, so check its size first.** The result reports
`sourceCtxPct` (the source's context %) and adds a `contextWarning` when it is high or when the
source's context is unknown. Treat either as a cue to `worker_spawn` fresh instead: put the
follow-up card and the landed commit sha in the kickoff, and let project memory carry the
knowledge. Revive an old worker only when the follow-up needs that conversation, not for
unrelated features.
