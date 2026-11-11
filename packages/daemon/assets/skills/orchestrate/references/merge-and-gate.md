# Review, merge and gate — detail

Read this when you are about to merge (`worker_merge` → `worker_merge_confirm`, or `merge_batch`), when a
gate is slow/pending/red, when a `[loom:*]` nudge arrives, when you title or retitle a card that is about
to land, or when you weigh a worker's claim before acting on it. The core doctrine (loop, step 5) keeps
the rule that must fire unprompted: review every artifact before it merges, never merge unreviewed work.

## The merge gate and batching

   - **The owner can switch a project's merge gate off** (human-only). A confirmed merge then lands
     WITHOUT running the gate command (`skipReason:"gate-disabled"` plus a warning): that is NOT a
     pass, so say "merged without a gate" in reports and expect problems to be caught after the fact.
   - **2+ workers ready to merge on the SAME repo? Use `merge_batch` instead of sequential
     `worker_merge_confirm` calls**: it gates the group in one run. Fewer than 2 eligible candidates
     falls through to the per-branch path. A red gate falls back to individual gating automatically, no
     bisection (read `fallback`; nothing to re-call); if main advances mid-gate the whole batch forfeits
     and re-gates individually, so weigh that before habitually batching large groups. A batched landing
     is not capped at the weakest verification tier: each landed commit carries the same path-set digest
     a solo squash gets, so `merged.verification:"pathset"` (or `"content"` while the branch ref exists)
     is expected. `"trailer-only"` is right for history landed before that stamping existed; on a
     **fresh** batch it means the best-effort stamp didn't land, so look. All of this assumes your
     platform writes those machine markers; if the project turned them off (a human-only setting),
     expect an empty verification tier and possibly an unknown merged state on work that did ship.
     Measure batching savings in gate **wall-clock**, never run count.
   - **A batch reporting `settled` does NOT mean every fallback merge has finished.** `settled` covers
     the batch's own work (shared gate run, fast-forward, finalize). A dropped/over-cap/stranded
     candidate on a green batch, or every candidate on a rejected/forfeited one (not a cancelled one,
     which starts nothing), routes through its own per-branch gate, which can still be running. Read
     `gate_queue`'s `fallbackOfBatchOpId` (equal to the batch's `opId` on each fallback row) for their
     real completion.
   - **Before batching, run the retitle check on every candidate** (a batch never picks up a retitle):
     compare `ownTipSubject` to the card title, and for a multi-commit branch also read
     `ownNonTipCommitSubjects`/`ownNonTipCommitSubjectsConventional`. A branch that fails merges solo;
     batch the rest.

## Weighing a worker's claim

   - **Never card, retitle, plan, or dispatch off an intermediate `progress` report: wait for `done`,
     then verify against the tree.** It narrates intent written at the point of least certainty, and a
     report can be wrong in framing even when every cited fact is real (a failure called "pre-existing"
     or "a false positive" without being checked). Treat it as the worker claim it is (see Transport).
   - **A commit's `type(scope):` prefix classifies the change; it doesn't say what it touched.** Run
     `git show --stat` before citing a commit's scope in a card, report, or escalation, and type-tag
     every bare short hex id you write or relay (`commit <sha>` / `card <id>` / `session <id>`).
   - **Verify a claim before you write it into a DoD or use it to close/retract a card, with the same
     evidence bar in either direction.** Disputing part of a worker's report doesn't test the rest, and
     a DoD is what gets acted on; forwarding or ranking an unverified claim is endorsement. A "this is
     already done" claim reads as free and gets waved through, yet a wrongly-closed card is worse
     because nobody re-examines it. Before you build on any claim, including one that only asks you to
     retract, close, or mark done, mark it tested / untested / not-relied-upon.
   - **An owner-facing "the gate passed" claim cites the gate op that carries it.** A landed card's
     `tasks_get` `mergeGate` names how its landing was gated: `gateRan`, `skipReason`, `gateOpId` and
     `gatedTip`. Read the verdict through `gate_status` or `gate_history` by that `gateOpId` before
     you write "passed", and cite the opId in the notice. `gateRan:false` (an ungated, interval or
     reused landing) and `gateRan:null` (a landing recorded before the field existed: unknown) are never
     a pass. A batched landing's `gateOpId` is the batch's own gate op, shared by its branches, so say so rather than implying a gate per branch. A
     claim about the host or its config is labelled "verified (source)" with the file or command it
     came from, or "assumed".

## Titles at merge time

   - **Retitle a retracted or reclassified card BEFORE its branch merges (SOLO merge only; a batch
     lands commit subjects verbatim).** If the premise didn't survive (the "bug" didn't exist, the work
     changed nature) but you still merge the branch (say, for a regression test), update the title
     first so the squash subject says what landed, e.g. `test(x): regression coverage for … (premise
     retracted, not a bug)`. The title is permanent mainline history.
     - An automated backstop may warn at merge-review time, but only when the retraction is its own
       standalone line (`RETRACTED`, `WON'T-DO`, `NOT A BUG`; a heading or bullet counts). The word
       mid-sentence deliberately does not.
   - **A card subject describes the CHANGE, not the DEFECT it removes.** A present-tense defect
     description in the title becomes a stale permanent mainline record of a defect the commit just
     fixed. Put the defect in the commit body (`git log --grep` matches the full message). **This
     assumes your commits carry a body you write**: if your platform's merge squashes a branch down to
     the card title plus machine trailers, the title is the ENTIRE searchable record (some platforms
     carry per-commit messages into the squash body, within a bound; check). Where no body mitigation
     exists, get the title's SCOPE right at filing/retitling time.
   - **Title staleness has four axes you can check against the diff before merge or close: TYPE** (does
     the conventional-commit type match what landed?), **RETRACTION** (did the premise survive?),
     **TENSE** (defect rather than change?), **SCOPE** (does the title's breadth match the diff? Check
     both directions: one file named when several changed hides work; a title claiming more than the
     diff touched overstates it). A fifth, whether the evidence behind the title's claim belongs to the
     component it names, has no mechanical check; it only turns up on independent re-verification.

## A slow, pending, or stuck gate

   - **A slow gate degrades `worker_merge_confirm` (and `merge_batch`, for the batch as a whole) to
     `{status:"pending", opId}`: don't spin-poll.** Do other work and wait for the async nudge, which
     carries the same `opId`: for a solo merge `[loom:merge-done]` / `[loom:merge-rejected]` /
     `[loom:merge-failed]` / `[loom:merge-unknown]` / `[loom:merge-cancelled]` / `[loom:merge-orphaned]`;
     for a batch `[loom:merge-batch-done]` / `[loom:merge-batch-failed]` / `[loom:merge-batch-unknown]` /
     `[loom:merge-batch-cancelled]` (meanings in the vocabulary bullet below). For an earlier answer, poll the read-only `gate_status(opId)` or read
     `worker_list`'s `pendingMerge`; both are free, prefer them for pure status. Re-calling
     `worker_merge_confirm` with the same `workerSessionId` is always safe: same commit AND unmoved
     mainline returns the cached verdict; new commits or an advanced mainline gate for real; a refusal
     about the canonical checkout (dirty/staged overlap, squash failure) is never cached, so clean it
     and re-call. The ONLY way to force a genuine re-run of the SAME commit (retry a flake) is
     `forceRemoveWorktree:true` on the re-call. Don't fall back to `git log` guesswork while waiting.
   - **A worker refused because its branch was cut before the canonical checkout moved to a different
     lineage can't be cleared by recycling or rebasing alone** (the recorded fork point survives a plain
     recycle or respawn). Three remedies work: (1) switch the canonical checkout back to the branch the
     worker was cut from; (2) re-dispatch on a fresh worker cut from current mainline (cherry-pick the
     commits); (3) if your platform has it (`worker_restamp_cut_base`), have the worker rebase or
     cherry-pick LINEARLY onto the current target, then re-stamp the fork point. That tool refuses ANY
     merge commit beyond the target, including a forward-merge of mainline: rebase linearly and retry.
   - **A gate that never resolves is a defect to diagnose, never a license to merge around it.** Silence
     is not evidence it's "wedged" or "flaky, not your code": check live state (`gate_status` /
     `gate_queue`) first, and never hand-roll a squash-merge past a gate with no terminal signal.
     Elapsed time is scoped to the current phase: a large figure on a QUEUED entry is wait time; only a
     RUNNING entry's elapsed time says how long the gate command has run.
   - **A decision you just made can turn a worker's OWN in-flight self-check into dead weight; cancel
     it.** If a worker is parked on its own `run_gate` and you decide to merge, reject, or recycle the
     branch anyway (or Code Review sends the card back, making that gate moot), use `gate_cancel` on its `opId` (it settles as cancelled/superseded, never a false
     pass or fail) to free the slot. Do it yourself; don't relay it down (a worker's own `gate_cancel`
     covers only its own self-check, for reasons visible from inside its turn).
   - **Can't tell healthy contention from a leaked slot? Read the whole queue.** `gate_status` answers
     only "what is MY op doing". `gate_queue` returns the resolved cap plus every `running`/`queued` gate
     run (merge/deploy/self-check alike). About to fire a gate a peer might collide with?
     `gate_intent_declare` (advisory, shown in that read; `gate_intent_withdraw` clears it). For past
     durations or a timeline use `gate_history` / `events_search`. Cross-project entries withhold
     identity (task, branch, worker label, batch-fallback link) and carry `redacted: true`: deliberate,
     not a gap. The tool's own description is the contract for the field list.
   - **Treat "queued"/"running" as a belief, not a fact.** A gate timeout can free the slot without its
     process tree dying, so an orphaned process from an evicted attempt on the SAME worktree can still
     be consuming the box, invisible to `gate_status`/`gate_queue`. `recentTimeoutStreak` is carried on
     any entry with a `branch`, yours or a peer's (a bare integer discloses nothing about the peer);
     `0` is a measured zero, absent only where there's no `branch` (a deploy gate), and it is
     prospective only (live entries). A nonzero count on an otherwise quiet entry is a second signal to
     check before trusting that a worktree is idle.
   - **The gate is a shared, capped, daemon-global resource.** Directing a worker to hand-run the full
     suite outside the gate (even for a trustworthy wall-clock number) opts out of the queue, competes
     with admitted runs, and contaminates the number. Your gate tool's result duration already reflects
     real admitted run time (excluding queue wait); read it there.

## The `[loom:*]` nudge vocabulary

   - **Know the `[loom:*]` nudge vocabulary.**
     - Solo merge: `[loom:merge-done]` / `[loom:merge-rejected]` / `[loom:merge-failed]`;
       `[loom:merge-unknown]` (the confirm threw before it could tell whether the squash landed: check
       `git log` before re-dispatching or re-merging); `[loom:merge-cancelled]` (withdrawn before the
       gate ran: not a failure, no verdict).
     - Batch (`merge_batch`) has its own set: `[loom:merge-batch-done]`; `[loom:merge-batch-failed]`
       (a rejection with automatic per-candidate fallback); `[loom:merge-batch-unknown]` (errored op,
       canonical state unknown until you check `git log`); `[loom:merge-batch-cancelled]` (nothing was
       started, no fallback). A `-done` never means every fallback merge finished (see the `settled`
       bullet above).
     - `[loom:gate-orphaned]` / `[loom:merge-orphaned]`: a restart-orphaned self-check/merge with no
       recoverable verdict. NOT a failure; re-fire it.
     - `[loom:mainline-moved]`: a tripwire, NOT a refusal (nothing was blocked; a merge you confirmed
       still went ahead). Not always a real move: read its evidence tag first. For a genuine move, check
       `git log`/`git reflog` for the shas it names and ask the owner whether it was theirs.
     - `[loom:worker-idle]`: pick up its report / next step. `[loom:already-merged]`: no action.
     - `[loom:auto-recovered]` / `[loom:crash-recovered]`: **Loom has ALREADY recovered the worker**
       (resumed in place); do NOT re-spawn or stop it.
     - `[loom:daemon-restarted]`: tied to a DELIBERATE rebuild + restart, never a crash; it can reach
       any manager (requester and bystanders), as a durable queued notice at your next turn boundary.
       A resumed manager the restart didn't touch (no workers resumed, no replayed messages, no pending
       answer or stranded board work) resumes SILENTLY, which is healthy, so absence means either "still
       on its way" or "unaffected"; don't wait on silence. Neither your engine session id nor an intact
       context is evidence either way (a resumed session keeps both); only the tag is a reliable signal.

## No gate configured; schema changes

   - **No gate/build command configured? REQUEST the human set one; never hand-roll it.** The gate
     command is HUMAN-ONLY (an exec surface, never agent-writable). For a CODE project lacking one,
     surface a `question_ask`; until it exists every merge is UNVERIFIED, so say so and verify another
     way (read the diff, run the build yourself). **First check whether the project is gateless BY
     DESIGN:** a knowledge/vault/notes project has nothing to gate, so don't nag; verify by reading the
     diff (and any doc-lint the project runs).
   - **A schema or migration change to a persistent datastore gets exercised against a COPY of a real
     pre-migration snapshot, not just a fresh store** (a fresh store has no "before" state, so it is
     blind to a schema referencing a migration-added column or table). Require the worker, or do it
     yourself, and review for the inverse bug: no base-schema index or constraint may reference a
     column only a later migration adds.
