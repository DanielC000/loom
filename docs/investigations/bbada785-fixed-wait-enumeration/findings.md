# Card bbada785 — fixed-wait exposure enumeration + one conversion

DoD-1 (enumerate) + DoD-2 (classify the known specimens) + DoD-3/4 (convert one site, prove it) for
"the merge gate is rejecting valid branches on fixed-time waits." Scope per the card: test-reliability
only — no production code touched, `worker-kickoff-guarantee.mjs` untouched (card `c4ccae66` owns it),
exactly ONE site converted this pass.

## DoD-1 — enumeration

Method: `scripts/enumerate-fixed-waits.mjs` (committed alongside this note) mirrors
`fixed-wait-negative-guard.mjs`'s own idiom scan (`IDIOM_A`/`IDIOM_B`, 5-line window,
`CHECK_OR_ASSERT_RE`) but **without** the guard's `NEG_KEYWORDS` filter, so it surfaces both polarities —
the guard has only ever tracked negative-polarity sites (its own baseline: 115 `KNOWN_UNAUDITED_WAITS` +
51 `NEWLY_VISIBLE_UNAUDITED_WAITS`). It also separately enumerates two idiom shapes the guard's own header
says it cannot see at all: `sleepUntil(...)` absolute-deadline waits and `windowMs:`-style sampling
(the `observeOnce`/`assertNever` family — see card `0f744aa4`). Run from repo root:
`node docs/investigations/bbada785-fixed-wait-enumeration/scripts/enumerate-fixed-waits.mjs`.

**Counts, measured against this branch's tree (post-conversion, see DoD-3 below):**

- **413** `sleep(...)`/`setTimeout(...)`-idiom wait-then-check() sites total, of which **221 are
  POSITIVE-polarity** — i.e. never tracked by `fixed-wait-negative-guard.mjs` in any form, because that
  guard only ever classifies and baselines *negative*-polarity labels. This is the population most
  relevant to this card: a merge-gate rejection is a false FAIL, which is what a too-tight fixed wait does
  to a *positive* assertion (the guard's own concern — a negative assertion silently passing — is the
  opposite failure mode). Full file:line + label list is in the script's stdout, embedded below.
- **33** `sleepUntil(t0, targetMs)` absolute-deadline call sites (7 are the local helper's own function
  definition, not a call) across 6 files — this is run 4's family (`pty-giveup-clear-single-attempt.mjs`).
- **41** `windowMs:` sampling-window sites across 13 files — this is run 2's and run 5's family
  (`worker-kickoff-guarantee.mjs`, `pty-ready-fallback-race.mjs`).

⚠️ **This is a mechanical idiom-shape count, not a completed audit** — same posture as the guard's own
baseline. A site appearing here is a *candidate* for the "fixed wait racing a timer/engine-driven
transition" family, not a confirmed defect; and the converse also isn't proven — a positive-polarity
check *outside* a 5-line window of a wait, or a locally-reimplemented poll loop with a bad predicate, is
invisible to this scan the same way it's invisible to the guard (see the guard's own "WHAT IT CANNOT SEE"
header). `run-4`'s own site (`pty-giveup-clear-single-attempt.mjs:115`, converted below) is a `sleepUntil`
call, not a raw `sleep()`+check() pair — it's counted correctly in the `sleepUntil` list, and (post-
conversion) its checks now also appear in the wait-then-check list because the conversion itself added a
raw `sleep(20)` poll line.

<details>
<summary>Full script output (413/221/33/41, file:line, labels/budgets)</summary>

```
=== wait(sleep/setTimeout-idiom)-then-check(): TOTAL 413 sites, 221 POSITIVE-polarity (never tracked by fixed-wait-negative-guard.mjs) ===

--- POSITIVE-polarity wait-then-check sites (file:line "label") ---
agent-runs-primitive.mjs:174  "3 the disposable snapshot dir is GC'd on teardown"
agent-runs-primitive.mjs:244  "6 BUG2: the hard timeout FIRES → run marked timed_out (with an error)"
agent-runs-primitive.mjs:244  "6 BUG2: the fired timer is dropped from the run-timer registry"
agent-runs-rest.mjs:233  "B1 a terminal transition fired EXACTLY one webhook"
agent-runs-rest.mjs:233  "B1 webhook payload = { runId, status:'completed', result, error:null }"
agent-runs-rest.mjs:233  "B1 the delivery is BOUNDED (the injected per-POST timeout is plumbed through)"
agent-runs-rest.mjs:268  "B4 the cancel webhook fired with status=cancelled"
agent-runs-rest.mjs:268  "B5 cancelRun on a terminal run → idempotent no-op (returns its state)"
autonomy-rails.mjs:120  "KILL: worker reached processState 'live'"
capability-registry.mjs:330  "(venv) provisioning status reaches 'ready' via the FAKE provisioner"
claude-version-prewarm.mjs:45  "the gate still fails closed after a failed prewarm"
codescape-health-probe.mjs:583  "(8b) exactly one diagnostic for the FIRST failure reason"
codescape-health-probe.mjs:858  "(12) at least ${MIN_TICKS} more probe ticks completed after the one allowed restart"
codescape-health-probe.mjs:873  "(12) the drift RESOLVING (installed build now matches the running build) announces recovery, exactly ONCE"
codescape-health-probe.mjs:874  "(12) the drift RESOLVING (installed build now matches the running build) announces recovery, exactly ONCE"
codescape-health-probe.mjs:929  "(13) the first probe tick completed"
codescape-health-probe.mjs:1014  "(14) waitForTickReachingAttempts located the completed tick whose own loop reached the version-probe attempt budget"
codescape-mcp-spawn.mjs:421  "(e2e) spawnWorker's register-worktree hook fired exactly once"
codescape-mcp-spawn.mjs:421  "(e2e) it registered the SAME worktreeId that landed in the spawn opts"
codescape-mcp-spawn.mjs:421  "(e2e) it registered the worker's actual worktree path"
codescape-supervisor.mjs:144  "(dbPath) restart-on-death respawns using the SAME remembered dbPath (a 3rd 'serve' call recorded, new pid)"
codescape-supervisor.mjs:168  "(a) exactly 2 calls recorded (1 ingest + 1 serve)"
codescape-supervisor.mjs:168  "(a) call 1 is 'ingest /fake/repo/one'"
codescape-supervisor.mjs:295  "(a5c) after the negative TTL expires, the SAME repo now resolves the newly-ingested id"
codescape-supervisor.mjs:362  "(b) after the kill, a NEW serve call is recorded (a real restart happened)"
codescape-supervisor.mjs:362  "(b) the 3rd call is another 'serve'"
codescape-supervisor.mjs:430  "(bad-bin) spawn #${expected} recorded before killing it"
companion-mirror.mjs:115  "A: mirrored to A's bound telegram chat with the disclaimer"
companion-mirror.mjs:123  "B: in-app adapter still untouched"
companion-mirror.mjs:164  "slow-mirror: the mirror eventually lands once released"
companion-voice-enable-gate.mjs:76  "3a: isReady() true once the (fake) provision resolves"
companion-voice-enable-gate.mjs:76  "3a: exactly one provision call"
companion-voice-enable-gate.mjs:88  "3b: isReady() true once the (fake) provision resolves"
companion-voice-enable-gate.mjs:88  "3b: exactly one provision call"
companion-voice-tts-provision.mjs:75  "3: exactly two provision attempts were made (the first failure, then the retry)"
companion-voice-tts-provision.mjs:77  "3: exactly two provision attempts were made (the first failure, then the retry)"
gate-cancel.mjs:76  "(guard) both eventually complete"
gate-cancel.mjs:108  "(null-grouping) a bound + an unbound op both resolve"
gate-cancel.mjs:171  "(primitive gateType guard) found the queued merge entry via snapshot"
gate-cancel.mjs:196  "(primitive gateType guard) found the queued deploy entry via snapshot"
gate-idle-liveness.mjs:116  "(1) precondition: the entry is running"
gate-idle-liveness.mjs:116  "(1) lastOutputAt is null before ANY hook fires — nothing has run yet"
gate-queue.mjs:260  "(e2e, MCP) after handoff: exactly 1 running (now P2's, redacted) + 0 queued"
gate-queue.mjs:266  "(e2e, MCP) empty once both settle"
gate-queue.mjs:350  "(unit, streak) registry empty once the second (passing) op settles"
gate-queue.mjs:350  "(unit, streak) a PASSING result clears the streak back to 0"
gate-semaphore-concurrency.mjs:87  "(unit, snapshot) reports exactly 1 active + 1 queued"
gate-semaphore-concurrency.mjs:117  "(unit, throw) a queued gate is admitted after the holder throws (lane freed in finally)"
gate-semaphore-concurrency.mjs:208  "(repo-mutex, c) worker+deploy sharing a repoPath still run concurrently — guard is merge-only"
gate-semaphore-concurrency.mjs:244  "(repo-mutex, d3) precondition: a queued entry exists to cancel"
gate-semaphore-concurrency.mjs:246  "(repo-mutex, d3) precondition: a queued entry exists to cancel"
gate-semaphore-concurrency.mjs:246  "(repo-mutex, d3) cancelQueued reports success"
gate-semaphore-concurrency.mjs:266  "(repo-mutex, d4) precondition: a running entry exists to cancel"
gate-semaphore-concurrency.mjs:266  "(repo-mutex, d4) cancelRunning reports it asked a live entry"
gate-semaphore-concurrency.mjs:360  "(join) (1) A's at-admission concurrency reads 1 (admitted alone)"
gate-semaphore-concurrency.mjs:360  "(join) (1) A's max reads 1 before anything joins it"
gate-semaphore-concurrency.mjs:371  "(join) (2) A's max is bumped to 2 by B's admission — the ALREADY-RUNNING entry is attributed the join too"
gate-semaphore-concurrency.mjs:477  "(priority) all four ran"
gate-status.mjs:149  "(unit) findByOpId locates the RUNNING entry by its FULL opId"
gate-status.mjs:171  "(unit) a prefix matching TWO live opIds returns kind:\""
gate-timeout-tree-kill.mjs:124  "(no-fratricide) the worker-lookalike is alive before the gate runs"
gate-timeout-tree-kill.mjs:124  "(no-fratricide) the stray process is alive before the gate runs"
graceful-stop.mjs:136  "idle: exited cleanly via the double Ctrl-C (Stage 1)"
integration-e2e.mjs:74  "3. engine session id captured (terminal warmed)"
integration-e2e.mjs:82  "4. agent's tasks_list saw the board task T1"
kickoff-giveup-exhausted.mjs:211  "(H1) reconcile drained the requeued kickoff: busy re-armed"
kickoff-giveup-exhausted.mjs:242  "(H2) reconcile drained the requeued kickoff: busy re-armed"
manager-live.mjs:64  "live manager spawned a worker UNATTENDED (role=worker, parent=manager)"
manager-live.mjs:64  "worker has its worktree on disk"
mcp-ready-gate.mjs:83  "1: still unresolved shortly after spawn — nothing has marked MCP seen yet"
mcp-ready-gate.mjs:83  "1: resolves TRUE promptly once markMcpSeen fires"
merge-confirm-completion-nudge.mjs:237  "(2) exactly ONE rich merge-rejected nudge fired"
merge-confirm-completion-nudge.mjs:237  "(2) it names the worker + the gate-failure reason"
merge-confirm-completion-nudge.mjs:360  "(5) exactly ONE [loom:already-merged] nudge fired"
merge-confirm-completion-nudge.mjs:402  "(6) exactly ONE rich merge-rejected nudge fired"
merge-confirm-slow-gate-pending.mjs:114  "(3) the retry loop observes the SETTLED result (elapsed=${Date.now() - t1}ms)"
merge-gate-reuse.mjs:509  "(K) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)"
merge-gate-reuse.mjs:769  "(O) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)"
merge-gate-reuse.mjs:847  "(P) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)"
messaging.mjs:83  "worker reached idle before messaging"
orch-abort-warn.mjs:126  "(2) an ABORTED request logs exactly one diagnostic warning (got ${JSON.stringify(cap.warnings)})"
orch-spawn.mjs:87  "worker is live with role=worker, parent=manager, branch set"
orch-spawn.mjs:105  "worker booted and ran its kickoff turn (engine id captured, then idle)"
orchestration-e2e.mjs:123  "REPORT: both workers committed + called worker_report(done) → both tasks 'review'"
paste-placeholder-tripwire.mjs:348  "RECOVERY (i): a corrective turn was written to the pty, carrying the recovery tag"
paste-placeholder-tripwire.mjs:348  "RECOVERY (i): the corrective turn carries the ORIGINAL lost content"
paste-placeholder-tripwire.mjs:380  "RECOVERY (k): the corrective turn was written, carrying the recovery tag"
paste-placeholder-tripwire.mjs:394  "RECOVERY (k): exactly one new warning fires for the recovery's own collapse"
paste-placeholder-tripwire.mjs:428  "(l) THE FIX: exactly one new warning fires for this collapse"
paste-placeholder-tripwire.mjs:468  "(m) the already-queued unrelated message drains as the NEXT turn, ahead of the recovery mint"
paste-placeholder-tripwire.mjs:486  "(m) THE FIX: the delivered recovery still carries the recovery tag"
paste-placeholder-tripwire.mjs:566  "(n) THE FIX: a FRAMED recovery still carries its possible-duplicate frame verbatim"
paste-placeholder-tripwire.mjs:566  "(n) THE FIX: a FRAMED recovery still carries the recovery tag AFTER the frame"
paste-recovery-boundary-annotation.mjs:119  "(A) setup: the naive-shape entry is what actually drained"
paste-recovery-boundary-annotation.mjs:145  "(B) THE FIX: the delivered recovery still carries the recovery tag"
paste-recovery-boundary-annotation.mjs:145  "(B) THE FIX: the delivered recovery still carries the ORIGINAL lost content"
paste-recovery-boundary-annotation.mjs:183  "(C) setup: the in-session-shape entry is what actually drained (positive signal the wait was sufficient before the negative conjunct below inspects it)"
paste-recovery-boundary-annotation.mjs:183  "(C) CONTROL: an in-session mint (mintedAtGen present + stale) still uses generation wording"
pending-ops-registry.mjs:36  "(slow) still running past the wait budget → {settled:false, op}"
pending-ops-registry.mjs:36  "(slow) the pending op's kind/key are surfaced"
pending-ops-registry.mjs:60  "(concurrent) run() was invoked EXACTLY ONCE despite two unawaited concurrent attach() calls"
pending-ops-registry.mjs:72  "(evict-on-settle) peek shows it WHILE running"
pending-ops-registry.mjs:74  "(evict-on-settle) peek shows it WHILE running"
pending-ops-registry.mjs:91  "(failed slow) still running past the short wait budget"
pending-ops-registry.mjs:109  "(listByManager) scoped to the requesting manager only"
pending-ops-registry.mjs:134  "(nudge slow-ok) degrades to pending first"
pending-ops-registry.mjs:148  "(nudge slow-gate-failed) degrades to pending first"
pending-ops-registry.mjs:148  "(nudge slow-gate-failed) callback fires once with the gate-failed result (ok:true, merged:false)"
pending-ops-registry.mjs:151  "(nudge slow-gate-failed) callback fires once with the gate-failed result (ok:true, merged:false)"
pending-ops-registry.mjs:162  "(nudge retry) only the ORIGINAL (entry-creating) call's callback ever fires"
pending-ops-registry.mjs:165  "(nudge retry) only the ORIGINAL (entry-creating) call's callback ever fires"
pending-ops-registry.mjs:203  "(onSurfacedPending repeat) fires once per call that observes 'still pending' — idempotent-upsert-friendly"
pending-ops-registry.mjs:268  "(clobber guard) run_C's OWN settle correctly evicts once IT finishes"
pending-ops-registry.mjs:291  "(retain) the retained view expires after retainMs — peek() reverts to undefined"
pending-ops-registry.mjs:372  "(retain dedupe/expired) precondition: the retained view is gone"
pending-ops-registry.mjs:372  "(retain dedupe/expired) a re-call AFTER the window runs a genuinely FRESH op"
pending-ops-registry.mjs:429  "(retain ttl) the re-confirm partway through the window dedupe-hits the cached op-1 result"
pending-ops-registry.mjs:491  "(single-flight under rejection) run() invoked EXACTLY ONCE for the fresh op despite two concurrent rejecting callers (1 seed + 1 fresh)"
pending-ops-registry.mjs:518  "(onOpMinted slow) fires even though this op degrades to pending"
pending-ops-registry.mjs:571  "(onSettle surfaced) onSettle fires BEFORE onSettledAfterPending, in the same settle callback"
pending-ops-registry.mjs:592  "(onSettle clobber-guard precondition) evictDeadOwner removes the running entry"
pending-ops-registry.mjs:592  "(onSettle clobber-guard) the SUCCESSOR's own settle fires normally"
pending-ops-registry.mjs:617  "(durable POSITIVE CONTROL) WITHOUT retainVerdictUntilSuperseded, a re-call past retainMs mints a fresh op — the exact hazard this card fixes"
pending-ops-registry.mjs:629  "(durable dedupe) precondition: the DISPLAY-facing retained view is gone (peek reverts on schedule)"
periodic-snapshot.mjs:80  "(1) periodic tick fired at least once"
periodic-snapshot.mjs:80  "(1) liveA snapshotted by the periodic tick"
periodic-snapshot.mjs:80  "(1) liveB snapshotted by the periodic tick"
periodic-snapshot.mjs:80  "(1) tick returns 2 (both live+engine+JSONL sessions)"
periodic-snapshot.mjs:91  "(2) several more ticks fired"
pty-composer-runaway-bound.mjs:246  "(2) sanity: reconcile long after a clean finish changes nothing — still exactly one paste"
pty-giveup-clear-single-attempt.mjs:115  "GIVE-UP RECOVERY: busy fell back to false"
pty-giveup-clear-single-attempt.mjs:142  "the redrain (attempt===1 again, MAX_ATTEMPTS=1) also gave up — busy fell back to false a second time"
pty-giveup-clear.mjs:183  "(1) the redrain itself also gave up (nothing in this harness ever confirms) — the redelivery still recovers busy"
pty-giveup-hold-until-confirmed.mjs:302  "(4) THE DELIVERY: TEXT1 is genuinely redrained once its own hold expires — busy re-armed"
pty-giveup-requeue.mjs:218  "(1) reconcile drained the requeued message: busy re-armed"
pty-giveup-requeue.mjs:241  "(1) sanity: busy still false, nothing left queued"
pty-giveup-requeue.mjs:342  "(3) SUPPRESSED: busy is still true (the real Stop/UserPromptSubmit will finalize it)"
pty-giveup-requeue.mjs:444  "(5) still nothing queued and busy still reflects the running turn"
pty-giveup-requeue.mjs:494  "(6) reconcile drained the requeued kickoff: busy re-armed for a genuine second attempt"
pty-healifstuck-clear.mjs:199  "(1) THE RESTORE IS LIVE: busy re-armed for a genuine second attempt (the restored entry actually redrained)"
pty-healifstuck-clear.mjs:256  "(2) THE RESTORE IS LIVE on the busyStaleMs path too: busy re-armed for a genuine second attempt"
pty-human-submit-race.mjs:187  "(E) BACKSTOP: after the bound expires, the reconcile tick delivers the orphaned queued turn — a delayed but successful drain"
pty-interrupt-redirect.mjs:120  "after settle: the freshly-enqueued redirect DRAINED (written once)"
pty-interrupt-redirect.mjs:120  "after settle: busy re-armed for the redirect turn (drain submitted it)"
pty-interrupt-redirect.mjs:120  "after settle: the FIFO is empty (redirect was the only entry)"
pty-log-stream-error.mjs:105  "the session is still alive after further post-break output"
pty-mode-convergence.mjs:162  "1: the confirmed plan reading issued the SECOND Shift+Tab"
pty-mode-convergence.mjs:162  "1: fresh spawn converged to auto in EXACTLY 2 presses (matches resume's acceptEdits→auto contract)"
pty-mode-convergence.mjs:165  "1: fresh spawn converged to auto in EXACTLY 2 presses (matches resume's acceptEdits→auto contract)"
pty-mode-convergence.mjs:181  "2: 2nd press issued (plan → auto attempt)"
pty-mode-convergence.mjs:228  "4: the RAW cycler gave up WITHOUT a 2nd blind press, resting at the boot default (acceptEdits)"
pty-mode-convergence.mjs:247  "4: the widened heal also fires AT MOST ONCE per session (modeLogged guard)"
pty-mode-convergence.mjs:264  "5: 2nd press issued (plan → auto attempt)"
pty-mode-convergence.mjs:264  "5: 3rd press issued (auto → default attempt)"
pty-mode-convergence.mjs:267  "5: 3rd press issued (auto → default attempt)"
pty-mode-convergence.mjs:317  "8: main convergence issued its 2nd Shift+Tab (plan → auto attempt)"
pty-mode-convergence.mjs:317  "8: main cycle gave up WITHOUT a 3rd blind press, landed at plan"
pty-mode-convergence.mjs:320  "8: main cycle gave up WITHOUT a 3rd blind press, landed at plan"
pty-mode-convergence.mjs:320  "8: the role-gated heal STILL fires and corrects a stuck RESUME to its configured target `auto`"
pty-mode-convergence.mjs:361  "9: clean-manager 2nd press issued"
pty-mode-convergence.mjs:361  "9: clean-manager converged to its target (auto) in 2 presses"
pty-mode-convergence.mjs:364  "9: clean-manager converged to its target (auto) in 2 presses"
pty-mode-heal-retry.mjs:137  "still only 3 Shift+Tabs while the corrective press's effect isn't yet observable"
pty-owner-attestation.mjs:202  "11: even once the racing submit() genuinely runs (post-backstop), it already cleared the pending raw draft — the system turn attests NULL, exclusively its own attribution"
pty-proactive-turn.mjs:91  "5: attested true once the queued proactive message actually drains as its own turn"
pty-rate-limit-park-drain.mjs:148  "POST-RESUME: the held queue finally drained on the post-resume Stop (pending empty)"
pty-restart-nudge-atomicity.mjs:150  "(A) mid-race: the kickoff-guarantee QUEUED the kickoff instead of writing it now"
pty-resume-readiness.mjs:219  "5: Enter now written after the late confirmation"
pty-resume-readiness.mjs:219  "5: EXACTLY one Down total, ever (the overshoot-elimination invariant)"
pty-route-coalesce.mjs:70  "A: three cross-route messages queued behind busy"
pty-write-after-kill-race.mjs:220  "[graceful/resend] THE FIX: neither delayed Ctrl-C resend reached the pty after kill"
pty-write-after-kill-race.mjs:220  "[graceful/resend] THE FIX: neither delayed Ctrl-C resend threw"
pty-writechunked-done-on-death.mjs:128  "give-up recovered busy"
pty-writechunked-done-on-death.mjs:143  "sanity: the deferred clear-prefix burst genuinely started"
recycle.mjs:76  "old worker reached idle before recycle"
restart-giveup-hold.mjs:253  "(4) THE DELIVERY: past its restored hold, the entry is genuinely redrained (busy re-armed)"
run-gate-cancelled-retention.mjs:178  "(D) the fresh call degrades to pending (its own gate is genuinely slow)"
skills-e2e.mjs:41  "daemon up on alt port"
skills-e2e.mjs:52  "engine id captured (booted past the plugin-MCP prompt unattended)"
task-defer-until.mjs:86  "(3) getProjectTask second read: still deferred:false"
usage-limit-weekly-sentinel.mjs:184  "setup: the follow-up QUEUED behind the busy turn"
vault-pause-lease.mjs:56  "expired lease: commit() proceeds once the lease's time is up"
wake.mjs:229  "start-reconcile: a past-due wake fired once on start()"
worker-flush-composer.mjs:125  "(2) setup: GIVE-UP RECOVERY landed — busy fell back to false"
worker-flush-composer.mjs:125  "(2) setup: composerDirtyLen marked dirty, exactly the stranded length"
worker-flush-composer.mjs:197  "(3) setup: GIVE-UP RECOVERY landed — busy fell back to false"
worker-flush-composer.mjs:197  "(3) setup: composerDirtyLen marked dirty, exactly the stranded length"
worker-liveness-signal.mjs:117  "(1) getLastOutputAt ADVANCED after a simulated engine-output chunk"
worker-liveness-signal.mjs:142  "(2) a THIRD chunk advances lastEngineOutputAt again, read live through worker_list"
worker-liveness-signal.mjs:150  "(3) meanwhile real time has clearly moved past it"
worker-run-gate.mjs:307  "(E) a slow op degrades to {settled:false, op}"
worker-session-reap.mjs:169  "(C) the stray process (rooted in the TARGET worker's worktree) is alive before reap"
worker-session-reap.mjs:169  "(C) the sibling marker (rooted in an UNRELATED worker's worktree) is alive before reap"
worker-stop-reap.mjs:57  "(A) stopWorker triggered the worktree-path reap for the worker's OWN worktree"
worker-stop-reap.mjs:57  "(A) the reap excludes the worker's OWN live pty pid"
worker-stop-reap.mjs:100  "(B) BOTH live workers' worktrees were swept"
worktree-process-reap.mjs:324  "(real) child A (rooted in worktree A) is alive before reap"
worktree-process-reap.mjs:324  "(real) child B (rooted in a DIFFERENT worktree B) is alive before reap"
worktree-process-reap.mjs:324  "(real) child C (cwd rooted in worktree A, script path outside any worktree) is alive before reap"
ws-json-hardening.mjs:82  "(term) a valid frame after the malformed ones is still handled (writeStdin called)"
ws-json-hardening.mjs:96  "(companion) a valid frame after the malformed ones is still handled (handleInAppInbound called)"
_probe-composer-clear-2.mjs:144  "engine session id captured"
_probe-composer-clear-2.mjs:145  "engine session id captured"
_probe-composer-clear.mjs:188  "engine session id captured (real hook relay reached us)"
_probe-composer-dirty.mjs:56  "1) the half-line is echoed in the live composer"
_probe-composer-dirty.mjs:73  "3) the held report DELIVERED after the box was freed"
_probe-paste-companion.mjs:200  "engine session id captured"
_probe-paste-companion.mjs:201  "engine session id captured"
_probe-paste-resume.mjs:138  "engine session id captured"
_probe-paste-resume.mjs:139  "engine session id captured"
_probe-paste-resume.mjs:158  "LIVE turn: model can read back the pasted tail marker"
_probe-paste-stranded-resume.mjs:104  "engine session id captured"
_probe-paste-stranded-resume.mjs:105  "engine session id captured"
_probe-paste-stranded-resume.mjs:111  "composer shows the collapsed placeholder before any Enter"
_probe-resume-mode.mjs:170  "FRESH spawn (startupModeCycles:2) reaches AUTO — the host's blind cycle still works"
_probe-resume-mode.mjs:194  "captured an engine id to resume (resume phases ran)"
_probe-session-name.mjs:33  "0) claude version resolved (prewarm succeeded)"
_probe-session-name.mjs:33  "0) installed version clears the session-naming gate (>= 2.1.196)"
_probe-session-name.mjs:65  "1) the pty is still alive after boot (an unsupported -n would have exited it)"
_probe-session-name.mjs:67  "1) the pty is still alive after boot (an unsupported -n would have exited it)"
_probe-session-name.mjs:80  "3) still interactive after a named boot (typed text is echoed)"

=== sleepUntil(...) absolute-deadline sites: 33 ===
pty-giveup-clear.mjs:56  async function sleepUntil(t0, targetMs) {
pty-giveup-clear.mjs:240  await sleepUntil(t0, ENTER_DELAY + VERIFY_TIMEOUT / 2);
pty-giveup-false-negative.mjs:47  async function sleepUntil(t0, targetMs) {
pty-giveup-false-negative.mjs:85  * scenario (1)'s fix (above) surfaced a SEPARATE flake in scenario (2): its `sleepUntil(t0, giveUpAt() +
pty-giveup-false-negative.mjs:110  // must account for it or `sleepUntil(t0, giveUpAt() + …)` under-shoots the ACTUAL (now-later) give-up point.
pty-giveup-false-negative.mjs:205  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-giveup-false-negative.mjs:261  await sleepUntil(t0, writeAt(1) + 20);
pty-giveup-false-negative.mjs:294  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-giveup-mintedatgen-signature.mjs:56  async function sleepUntil(t0, targetMs) {
pty-giveup-mintedatgen-signature.mjs:240  await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
pty-giveup-mintedatgen-signature.mjs:242  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-giveup-mintedatgen-signature.mjs:248  await sleepUntil(t0, giveUpAt() + BUSY_STALE_MS + BUSY_STALE_MS / 2);
pty-healifstuck-clear.mjs:48  async function sleepUntil(t0, targetMs) {
pty-healifstuck-clear.mjs:156  await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
pty-healifstuck-clear.mjs:159  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-healifstuck-clear.mjs:174  await sleepUntil(t0, giveUpAt() + FIRST_TURN_STALE + FIRST_TURN_STALE / 2);
pty-healifstuck-clear.mjs:231  await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
pty-healifstuck-clear.mjs:233  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-healifstuck-clear.mjs:241  await sleepUntil(t0, giveUpAt() + BUSY_STALE_MS + BUSY_STALE_MS / 2);
pty-healifstuck-clear.mjs:280  await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
pty-healifstuck-clear.mjs:282  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
pty-healifstuck-clear.mjs:289  await sleepUntil(t0, giveUpAt() + FIRST_TURN_STALE / 4);
pty-submit-paste-end-retry.mjs:41  async function sleepUntil(t0, targetMs) {
pty-submit-paste-end-retry.mjs:125  await sleepUntil(t0, writeAt(1) + VERIFY_TIMEOUT / 2);
pty-submit-paste-end-retry.mjs:131  await sleepUntil(t0, writeAt(2) + VERIFY_TIMEOUT / 2);
pty-submit-paste-end-retry.mjs:137  await sleepUntil(t0, writeAt(3) + VERIFY_TIMEOUT / 2);
pty-submit-verify-retry.mjs:57  async function sleepUntil(t0, targetMs) {
pty-submit-verify-retry.mjs:151  await sleepUntil(t0, writeAt(1) + VERIFY_TIMEOUT / 2);
pty-submit-verify-retry.mjs:156  await sleepUntil(t0, writeAt(2) + VERIFY_TIMEOUT / 2);
pty-submit-verify-retry.mjs:175  await sleepUntil(t0, writeAt(3) + VERIFY_TIMEOUT + VERIFY_TIMEOUT / 2);
pty-submit-verify-retry.mjs:185  await sleepUntil(t1, writeAt(1) + VERIFY_TIMEOUT / 2);
pty-submit-verify-retry.mjs:239  await sleepUntil(tB0, writeAt(1) + VERIFY_TIMEOUT / 4);
pty-submit-verify-retry.mjs:286  await sleepUntil(tC0, writeAt(2) + VERIFY_TIMEOUT / 4);

=== windowMs: sampling-window sites: 41 ===
companion-pairing.mjs:59  budget=10 * 60_000
companion-pairing.mjs:252  budget=10 * 60_000
companion-unbind-pairing-codes.mjs:45  budget=10 * 60_000
companion-unbind-pairing-codes.mjs:120  budget=10 * 60_000
dev-server.mjs:99  budget=HEARTBEAT_INTERVAL_MS * 5
dev-server.mjs:106  budget=HEARTBEAT_INTERVAL_MS * 5
gate-semaphore-concurrency.mjs:169  budget=REPO_MUTEX_WINDOW_MS
gate-semaphore-concurrency.mjs:174  budget=REPO_MUTEX_WINDOW_MS
gate-semaphore-concurrency.mjs:318  budget=QUEUE_PATH_WINDOW_MS
gate-semaphore-concurrency.mjs:323  budget=QUEUE_PATH_WINDOW_MS
kickoff-readiness-fallback.mjs:112  budget=NEGATIVE_WINDOW_MS
kickoff-readiness-fallback.mjs:122  budget=NEGATIVE_WINDOW_MS
kickoff-readiness-fallback.mjs:145  budget=NEGATIVE_WINDOW_MS
kickoff-readiness-fallback.mjs:150  budget=NEGATIVE_WINDOW_MS
platform-forensics-reads.mjs:120  budget=600000
pty-ready-fallback-race.mjs:166  budget=150
pty-ready-fallback-race.mjs:266  budget=300
pty-ready-fallback-race.mjs:282  budget=300
pty-resume-kickoff-recapture.mjs:148  budget=NEGATIVE_WINDOW_MS
pty-resume-kickoff-recapture.mjs:156  budget=NEGATIVE_WINDOW_MS
pty-resume-kickoff-recapture.mjs:179  budget=NEGATIVE_WINDOW_MS
pty-resume-kickoff-recapture.mjs:182  budget=NEGATIVE_WINDOW_MS
remote-bind.mjs:178  budget=600000
remote-bind.mjs:184  budget=999 (<1s floor) rejected"
remote-bind.mjs:185  budget=999
remote-bind.mjs:188  budget=60000
remote-bind.mjs:205  budget=600000
worker-composer-dirty-signal.mjs:181  budget=VERIFY_TIMEOUT
worker-composer-dirty-signal.mjs:250  budget=VERIFY_TIMEOUT * (MAX_ATTEMPTS + 1)
worker-flush-composer.mjs:163  budget=20
worker-flush-composer.mjs:170  budget=VERIFY_TIMEOUT + SETTLE_MAX_POLLS * SETTLE_POLL
worker-kickoff-guarantee.mjs:156  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:166  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:200  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:204  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:231  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:234  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:256  budget=NEGATIVE_WINDOW_MS
worker-kickoff-guarantee.mjs:259  budget=NEGATIVE_WINDOW_MS
ws-fleet-session-feed.mjs:103  budget=DIRTY_FLUSH_MS + 100
ws-fleet-session-feed.mjs:118  budget=DIRTY_FLUSH_MS + 100
```

</details>

## DoD-2 — budget-too-tight vs. production-genuinely-late, per known specimen

- **Run 4 (`pty-giveup-clear-single-attempt.mjs:115`, converted below): BUDGET TOO TIGHT, and I can say why.**
  The removed `giveUpAt()` formula (`ENTER_DELAY + VERIFY_TIMEOUT + CONFIRM_SETTLE_BOUND`) is a naive sum
  of production's own configured constants, assuming zero scheduling overhead. Measured on an otherwise
  idle box (this session, no injected load): real completion was **752ms** against a **700ms** naive sum —
  already ~50ms of real overhead the formula doesn't model, from `awaitGiveUpConfirmSettle`
  (`pty/host.ts:6122`) being a chain of up to 5 sequential re-entrant `setTimeout` calls rather than one
  wait — each individually exposed to event-loop scheduling jitter. The fixed wait's extra 300ms margin
  absorbed that on an idle box; under real gate-host contention (competing test lanes) that margin is
  exactly the kind of thing that gets eaten. See DoD-4 for a direct, reproducible demonstration.
- **Run 2 (`worker-kickoff-guarantee.mjs`): NOT AUDITED — out of scope.** Card `c4ccae66` owns this file and
  I did not touch or deeply re-derive its verdict; per that card and this one's own header, its failure was
  a genuinely OBSERVED second delivery (a real event caught, not a timing artifact) — file membership in
  this card's "fixed-wait family" is about the *mechanism* (a `windowMs:` fixed sampling window), not a
  claim that run 2's specific failure was itself a false-fail.
- **Run 1 (`kickoff-real-spawn.mjs`): NOT the sleepUntil/windowMs family at all.** This file already uses
  `waitUntil(predicate, {timeoutMs})` — a condition-poll, the DoD-3 target pattern — for both waits near the
  failing assertion (`:190`, `:207`). Its `timeoutMs` is still a fixed BOUND (so a genuinely-late production
  transition could still time it out), but that's a different, much smaller exposure than an absolute
  deadline racing a transition with no polling at all. **Could not tell** whether run 1's specific rejection
  was budget-too-tight or a real regression — I did not have a captured failure detail beyond the file name,
  and reproducing a real-spawn test's timing failure is out of scope for this pass (it drives an actual
  Claude CLI process, not a hermetic fake pty).
- **Run 5 (`pty-ready-fallback-race.mjs:263-288`): could not tell, and here is exactly what I checked.**
  Read the file at source. Scenario 2's negative check ("the re-armed timer does not ALSO deliver a second
  time…") already uses `assertNeverWithControl` with a real `positiveControl` (lines 267-285) — **not** the
  bare, uncontrolled `observeOnce` pattern card `0f744aa4` flagged (that gap was scenario 1's, and the
  file's own "CODE REVIEW CORRECTION (2026-08-05)" comment at line 247 shows a reviewer already caught and
  narrowed an earlier over-claim in this exact block). So a FAIL here means the ≥2-delivery condition was
  genuinely observed inside the 300ms window — this is a controlled negative assertion, which can't
  spuriously FAIL the way a too-tight positive-assertion wait can (it can only spuriously *pass* if the
  window is too short, the opposite failure mode). Whether that observation reflects a real double-fire or
  a fault-injection/harness artifact (the file's own fault-injection technique intercepts `clearTimeout`) is
  something I did not determine — I did not re-run this file under load or repeated trials, and doing so
  productively would mean touching the file, which this pass's "convert exactly ONE site" scope reserves.
  🆕 **Discriminator from the manager, folded in here:** run 5 (op `87ea0e89`) ran at `cap=2
  concurrentAtStart=1 concurrentGatesMax=1` — it was the ONLY gate on the box for its entire run, so
  gate-vs-gate contention is EXCLUDED as an explanation for this specific failure. That does **not**
  license a conclusion either way between "budget too tight" and "production got late" (my "could not
  tell" verdict above stands) — it only rules out one candidate *source* of load; host load from non-gate
  processes (the daemon itself, other live sessions, the test pool's own internal parallelism racing its
  sibling files with zero external contention) is still uncontrolled and unmeasured. INSTRUMENT (per the
  manager, not independently re-verified by me): `cap`/`concurrentAtStart`/`concurrentGatesMax` come from
  the `[loom:merge-rejected]` nudge text, a DIFFERENT instrument from this doc's own ms-precision figures
  (the 752ms/700ms pair above came from a `node test/...` run I timed directly) — not differenced against
  each other here, and not to be combined into one duration series in any future pass on this card.

## DoD-3/4 — the one conversion, and proof it removes the exposure

**Site converted:** `packages/daemon/test/pty-giveup-clear-single-attempt.mjs:115` (run 4's specimen).
Commit `482afbd2` on this branch. Replaced `await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2)` — an
absolute wall-clock deadline racing the give-up transition — with a bounded (15s) condition-poll on the
actual observable (`busyLog[SID].at(-1) === false`), mirroring the pattern already used one wait later in
the same file (`:131-142`, pre-existing). Removed the now-dead `sleepUntil`/`giveUpAt` helpers.

**Proof (DoD-4 — pre-conversion fails under an injected delay, post-conversion survives it):** built two
throwaway harnesses (not committed — patched copies run from the scratch dir, importing `dist/pty/host.js`
and `_seam-host-fixture.mjs` directly, identical to the real files except for one addition: the fake
`events.onBusy(id, busy)` callback, when `busy === false`, delays pushing to `busyLog` by
`INJECT_ONBUSY_DELAY_MS` — a test-harness-only injection simulating the give-up-recovery signal arriving
late (e.g. event-loop contention on a busy host), touching no production code). One harness carries the
pre-conversion `sleepUntil` code (from `git show HEAD:...` before this commit), the other the post-
conversion condition-poll.

| run | harness | `INJECT_ONBUSY_DELAY_MS` | result |
|---|---|---|---|
| sanity | pre (fixed `sleepUntil`) | 0 | ✅ PASS (both checks) — confirms the injection mechanism itself isn't what breaks it |
| **RED** | pre (fixed `sleepUntil`) | 500 | ❌ **FAIL** `GIVE-UP RECOVERY: busy fell back to false` |
| **GREEN** | post (condition-poll) | 500 | ✅ **PASS**, whole file, 0 failures |

500ms exceeds the old fixed margin (`VERIFY_TIMEOUT/2` = 300ms) but is comfortably inside the new poll's
15s bound. This is the exact shape of exposure the card is about: a fixed budget guessed against a
timer-driven transition, versus observing the transition directly.

## What's NOT done

This enumeration is a mechanical idiom-shape count (413 wait-then-check sites, 33 `sleepUntil` sites, 41
`windowMs` sites), **not a completed audit** — most of these ~480 candidate sites are still unclassified
(budget-too-tight vs. production-late) and unconverted. Per this pass's scope ("convert exactly ONE site
this pass"), only run 4's specimen was converted and proven. The remaining `sleepUntil` population (6
files, mostly `pty-healifstuck-clear.mjs` and `pty-submit-verify-retry.mjs`, which each carry several
`sleepUntil` call sites of the same shape) and the `windowMs` population outside `worker-kickoff-
guarantee.mjs` (13 files) are the natural next targets for a follow-up pass.
