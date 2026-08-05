# 25f14a7b — does give-up/park incidence scale with session context size: findings

Worker investigation, 2026-08-05. **This is a hypothesis-measurement card, not a fix card — no production code was changed.** `filesChanged` for this task is this document plus one new throwaway probe script (`packages/daemon/test/_probe-context-scan-latency.mjs`, `_`-prefixed and excluded from the tracked suite). The retry/park budget was NOT widened — see DoD-6.

Every DoD item below is answered explicitly, in order, with raw command output pasted where a claim depends on it.

## DoD-1 — do a PARK and a DUPLICATE INBOUND DELIVERY share a mechanism?

**Answer: it depends which duplicate. There are two structurally distinct mechanisms that both produce a "possible duplicate" — only one of them shares its root cause with PARK.**

`framePossibleDuplicate` (`pty/host.ts:218`) is the tagging function behind every duplicate-delivery notice. It has exactly four call sites, verified by:

```
$ grep -n "framePossibleDuplicate(" -r packages/daemon/src
packages\daemon\src\pty\host.ts:218:export function framePossibleDuplicate(text: string, rootMsgId: string): string {
packages\daemon\src\pty\host.ts:506:      const t = m.giveUpGen !== undefined ? framePossibleDuplicate(m.text, m.logicalId) : m.text;
packages\daemon\src\pty\host.ts:6467:      const markedSig = textSignature(framePossibleDuplicate(text, logicalId));
packages\daemon\src\sessions\service.ts:4372:      const redrivenText = framePossibleDuplicate(text, rootMsgId);
packages\daemon\src\sessions\service.ts:6553:      const reminted = this.enqueueDurableMessage(recipientId, framePossibleDuplicate(text, rootMsgId), {
packages\daemon\src\sessions\service.ts:6808:      this.pty.enqueueStdin(sessionId, framePossibleDuplicate(kickoffText, rootMsgId), "system", ...
```
(line 6467 is a read-only signature comparison inside `hasAmbiguousMatch`, not a dispatch site — three genuine dispatch sites plus the in-turn one at host.ts:506.)

**Class A — the in-session give-up/remint chain (SAME mechanism as PARK):**
- `host.ts:506` (`joinSubmittedText`) — tags an in-turn requeued message (`m.giveUpGen !== undefined`) at the moment `drainPending` actually re-drains it.
- `service.ts:6553` (`handleGiveUpExhausted`) — cross-turn-boundary re-mint once a message's `GIVE_UP_REQUEUE_LIMIT` is exhausted within a turn.
- `service.ts:6808` (`handleKickoffGiveUpExhausted`) — the same re-mint, kickoff-specific.

These three are all stages of *one* chain: submit → give-up → in-turn requeue (host.ts:506) → exhausted → cross-turn re-mint (service.ts:6553/6808) → exhausted again → **PARK** (`handleGiveUpExhausted`'s park branch, once `GIVE_UP_REMINT_LIMIT` is also exhausted). A **duplicate** on this chain is the case where a re-mint fires (Loom concluded "not yet confirmed") and the *original* generation **also** later confirms — i.e. a false negative in the same confirmation-lag-vs-fixed-budget race that, if it goes the other way (no confirmation ever detected before every remint is spent), produces PARK instead. The code comments confirm this is a real, observed failure mode, not theoretical — `service.ts:6764/6792` (`purgeConfirmedGiveUpRequeue`) log `"GIVE-UP RECOVERY was a false negative (content-matched)"` exactly when this happens, and purge the would-be duplicate copy when they can catch it in time. **For a Class-A duplicate, PARK and DUPLICATE genuinely are two branches of the same race.**

**Class B — restart/resume redrive (a DIFFERENT mechanism, NOT tied to the give-up budget or context size):**
- `service.ts:4372` (`redriveQueuedMessage`) — fires when a durable `session_message_queued` event is still undelivered because its recipient wasn't live (daemon restart, or a resume/live-flip). Its own doc comment (`service.ts:4286-4288`) is explicit about why it tags unconditionally: *"this is Loom's ONLY redelivery route with no in-process signal of a prior attempt, so it tags unconditionally rather than silently guessing."* This has nothing to do with `SUBMIT_MAX_ATTEMPTS`/`GIVE_UP_REQUEUE_LIMIT`/`GIVE_UP_HOLD_MS`/`GIVE_UP_REMINT_LIMIT` at all — it fires purely because Loom cannot tell, across a restart boundary, whether the pre-restart attempt landed. **A Class-B duplicate does not share PARK's mechanism** — it would fire the same way regardless of the recipient's context size, message length, or how the give-up budget is configured.

**What this means for the card's own confound:** the manager's §DE-CONFOUND specimen (a byte-identical duplicate peer message, ~25min-old manager session, 344K context) could be *either* class, and I cannot tell which from what's available to me — that determination hinges on whether a daemon restart or that manager session's own resume happened in the ~03:5xZ–04:18:20Z window on 2026-08-02, which I have no visibility into (it's daemon-restart-log / manager-session-history state, not code). **This is the single most useful thing to get from the manager** — see DoD-2.

**Scoping implication:** the card's own framing ("if they don't [share a mechanism], re-scope to parks alone") doesn't collapse cleanly to yes/no. If the manager's specimen turns out to be Class A, the n=2-across-classes table stands as originally argued. If it's Class B, that specific data point should be dropped from the context-size table entirely (its mechanism is a restart-timing coincidence, not a context-size effect), narrowing the observation back to n=1 (the two PARK events on `89d60c6c`) — consistent with what the card already flags as the honest fallback ("n=1 with the confound intact").

## DoD-3 — is the retry budget genuinely fixed? Any derived scaling?

**Confirmed: every constant in the give-up/park machinery is a fixed literal (env-overridable, but scaling with nothing dynamic) — independently re-verified, not taken on the manager's word.**

```
$ grep -n "GIVE_UP_HOLD_MS\s*=|SUBMIT_MAX_ATTEMPTS\s*=|GIVE_UP_REQUEUE_LIMIT\s*=" packages/daemon/src/pty/host.ts
335:export const SUBMIT_MAX_ATTEMPTS = Number(process.env.LOOM_SUBMIT_MAX_ATTEMPTS) || 4;
346:export const GIVE_UP_REQUEUE_LIMIT = Number(process.env.LOOM_GIVE_UP_REQUEUE_LIMIT) || 1;
426:export const GIVE_UP_HOLD_MS = Number(process.env.LOOM_GIVE_UP_HOLD_MS) || 20_000;

$ grep -n "GIVE_UP_REMINT_LIMIT\s*=" packages/daemon/src/sessions/service.ts
1299:const GIVE_UP_REMINT_LIMIT = Number(process.env.LOOM_GIVE_UP_REMINT_LIMIT) || 1;
```

The manager's own check (DoD-3's premise) was right; the part it flagged as unchecked — **whether anything downstream derives a scaled value from them** — is also negative. The park-notice arithmetic (`service.ts:1314-1318`) is pure multiplication of these four fixed constants against each other, nothing else:

```javascript
const PARK_MESSAGE_OBJECTS = GIVE_UP_REMINT_LIMIT + 1;
const PARK_SUBMIT_CYCLES = (GIVE_UP_REQUEUE_LIMIT + 1) * PARK_MESSAGE_OBJECTS;
const PARK_ENTER_WRITES = PARK_SUBMIT_CYCLES * SUBMIT_MAX_ATTEMPTS;
const PARK_HOLDS = GIVE_UP_REQUEUE_LIMIT * PARK_MESSAGE_OBJECTS;
const PARK_MIN_HOLD_SECONDS = Math.round((PARK_HOLDS * GIVE_UP_HOLD_MS) / 1000);
```
No session id, context size, message length, or age is an input anywhere in this derivation. The other timing constants nearby in `host.ts` (`SUBMIT_VERIFY_TIMEOUT_MS=900`, `REASSERT_SETTLE_POLL_MS`/`_MAX_POLLS`, `GIVE_UP_CONFIRM_SETTLE_POLL_MS`/`_MAX_POLLS`, `FLUSH_CONFIRM_POLL_MS`/`_MAX_POLLS`, `AMBIGUOUS_DISPATCH_CAP=20`) are the same shape — all `Number(process.env.X) || <literal>` or a bare literal, each documented (per this file's own convention) as sized from a measured *distribution*, never from a per-session dynamic input. **Conclusion: the entire retry/park budget is fixed in every dimension checked. If accept-latency does scale with context size (DoD-4), the budget itself will not adapt — it is genuinely a race against a constant, exactly as the card's hypothesis requires.**

## DoD-4 — does time-to-accept-a-submit actually vary with context size at all?

This has two parts: what I deliberately did **not** attempt, and what I did.

### What I did not do, and why

The card's core hypothesis is about the **real `claude` engine's** turn-confirmation latency scaling with its own context occupancy. Testing that directly needs a real, unsubstituted `claude` child at genuinely large context (hundreds of K tokens, matching the `89d60c6c`/mgr-#101 scale) — and there is no cheap way to get there:
- Building that context organically costs dozens of real, paid API turns and real wall-clock time, with no bounded stopping point.
- Resuming an *existing* real large transcript (e.g. one of `89d60c6c`'s) via `--resume`/`--fork-session` would touch another session's private transcript content and risks interfering with a file that may still be referenced, for a benefit (one data point) that doesn't obviously justify the risk.

Both are real-cost, real-risk actions I judged outside a measure-only worker's authority to take unilaterally without sign-off. **I did not run this experiment.** This remains the single biggest open gap in answering DoD-4's actual question — see DoD-2's ask.

### What I did do: a safe, real, controlled probe of a different, code-verified mechanism

Loom's own Stop-hook handler (`pty/host.ts`, `deliverHook`, `case "Stop"`) calls `readContextStats(live.cwd, live.engineSessionId)` **synchronously** (`host.ts:4595`), inside the exact window the file's own comment calls the **M2 invariant**: *"From the setBusy(false) below to the drainPending below, execution MUST stay strictly SYNCHRONOUS… If a future edit `await`s anywhere in this window… an enqueueStdin scheduled during that yield would slip a second turn in"* (`host.ts:4556-4565`). `drainPending` — the call that actually writes the *next* queued message's Enter — runs later in this same synchronous block (confirmed: the comment at `host.ts:4685-4688` names it explicitly as *"This Stop-hook's OWN drainPending call (further down, outside this `if`)"*). So whatever `readContextStats` costs in wall-clock time is added, in full, to how long it takes before the next message can even be *attempted* — this is a real, code-level candidate mechanism for "context size delays the next submit," independent of anything the LLM itself does.

Despite its own doc-comment calling it a "tail-scan," `readContextStats` (`sessions/context.ts:87-124`) is **not** a bounded read: `fs.readFileSync(file, "utf8")` reads the entire transcript JSONL into memory, `raw.split("\n")` splits the whole thing, then every line is `JSON.parse`d. This is O(file size), and a session's transcript file size grows with its context.

**Real file-size distribution for this project** (not guessed — measured against this host's own `~/.claude/projects/C--Users-danie--loom` directory, n=52 files):
```
$ ls -la *.jsonl | awk '{print $5}' | sort -n | awk '{a[NR]=$1} END{print "n="NR; print "p10="a[int(NR*0.1)+1]; print "p50="a[int(NR*0.5)+1]; print "p90="a[int(NR*0.9)+1]; print "max="a[NR]}'
n=52
p10=407987
p50=1539121
p90=3705449
max=6645109
```
And a real (bytes → tokens) calibration from the top three files (last recorded `usage` line in each):
```
afa7093c-... size=6645109bytes last_usage="input_tokens":2,"cache_creation_input_tokens":621,"cache_read_input_tokens":400450
66cf4dff-... size=4811954bytes last_usage="input_tokens":2,"cache_creation_input_tokens":538,"cache_read_input_tokens":758984
ea6354ea-... size=3945381bytes last_usage="input_tokens":2,"cache_creation_input_tokens":538,"cache_read_input_tokens":745019
```
Multi-MB transcripts on this host really do correspond to hundreds-of-K-token context, in the same range as the card's own 215K–347K observations.

**Probe** (`packages/daemon/test/_probe-context-scan-latency.mjs`): calls the real, unmodified, compiled `readContextStats` (from `dist/sessions/context.js`) against six REAL transcript files already on this host, spanning the measured distribution above (25,840 B smallest found → 99,284 B → 1,379,025 B → 3,705,449 B (p90) → 4,811,954 B → 6,645,109 B (max)) — **no synthetic filler anywhere**. A deliberately bogus `cwd` is passed so `resolveTranscriptFile`'s direct-path check always misses, forcing the fallback scan on rep 1 (a **positive control**: that scan's cost was separately measured and documented elsewhere at ~197ms against a larger `~/.claude/projects` — landing in the same ballpark here corroborates the probe's own timing methodology) and hitting `resolvedPathCache` on reps 2-5 (isolating **pure parse cost**, the thing this probe actually targets). 5 reps per file.

Raw output (full run, unedited):
```
[measured] host ~/.claude/projects/ dir count (the fallback-scan cost driver, per the cited memory): 1919
[measured] sampling 6 REAL transcripts, 5 reps each (rep1=cold/scan+parse, rep2-5=warm/parse-only)

[result] dc25a3e8-af41-4230-b7e4-7211cc1af853 bytes=25840 ctxInputTokens=null turns=null | cold(rep1, scan+parse)=6.2ms | warm(rep2-5, parse-only) avg=0.5ms min=0.5ms max=0.7ms | all reps ms=[6.2, 0.7, 0.5, 0.5, 0.5]
[result] b70270b4-10f9-4d4c-b113-a6ea6545ead9 bytes=99284 ctxInputTokens=50526 turns=19 | cold(rep1, scan+parse)=11.7ms | warm(rep2-5, parse-only) avg=1.6ms min=1.4ms max=1.8ms | all reps ms=[11.7, 1.4, 1.5, 1.8, 1.6]
[result] 2416184a-ac16-406a-b111-7072ea460050 bytes=1379025 ctxInputTokens=290200 turns=191 | cold(rep1, scan+parse)=19.3ms | warm(rep2-5, parse-only) avg=22.4ms min=14.6ms max=35.3ms | all reps ms=[19.3, 35.3, 14.6, 22.0, 17.7]
[result] 9f1c6af8-6440-4fbb-a85a-b3bc319f23db bytes=3705449 ctxInputTokens=446626 turns=888 | cold(rep1, scan+parse)=70.6ms | warm(rep2-5, parse-only) avg=53.1ms min=42.8ms max=57.4ms | all reps ms=[70.6, 55.7, 57.4, 56.5, 42.8]
[result] 66cf4dff-c8f4-4116-b60d-9d613ee3af07 bytes=4811954 ctxInputTokens=759524 turns=793 | cold(rep1, scan+parse)=120.1ms | warm(rep2-5, parse-only) avg=76.8ms min=64.2ms max=112.5ms | all reps ms=[120.1, 112.5, 64.9, 64.2, 65.6]
[result] afa7093c-beb2-4610-badd-74c02cb85646 bytes=6645109 ctxInputTokens=401073 turns=397 | cold(rep1, scan+parse)=81.7ms | warm(rep2-5, parse-only) avg=103.1ms min=85.8ms max=134.8ms | all reps ms=[81.7, 85.8, 96.0, 134.8, 95.8]

[negative control] nonexistent id 00000000-0000-0000-0000-000000000000: result=null (must be null) elapsed=130.2ms (expected near the ~197ms documented full-scan-never-found cost, confirming this probe's cold-path timing is measuring the same thing that memory note measured)
[negative control] PASS — null, as expected for a genuinely absent transcript

[summary] bytes vs warm parse-only avg ms (sorted by size):
      25840 bytes  ctxInputTokens=   null  →      0.5 ms (warm, parse-only)
      99284 bytes  ctxInputTokens=  50526  →      1.6 ms (warm, parse-only)
    1379025 bytes  ctxInputTokens= 290200  →     22.4 ms (warm, parse-only)
    3705449 bytes  ctxInputTokens= 446626  →     53.1 ms (warm, parse-only)
    4811954 bytes  ctxInputTokens= 759524  →     76.8 ms (warm, parse-only)
    6645109 bytes  ctxInputTokens= 401073  →    103.1 ms (warm, parse-only)

[summary] largest/smallest byte ratio=257.2x, corresponding warm-parse-latency ratio=191.6x
```
Instrument: `performance.now()`, in-process, Node 22, this host, this worktree's `dist/` build (checked fresh before running). Condition: cold repo checkout, no concurrent daemon load during the run (I did not measure this probe under concurrent host load — see caveat below). Population: 6 real transcript files spanning this project's own measured size distribution, 5 reps each.

**Finding: YES — this specific mechanism scales clearly, close to linearly, with transcript file size**: ~0.5ms at 25.8KB up to ~103ms at 6.6MB (257.2× size → 191.6× latency). The negative control returns `null` (never fabricates a value) and its cold-path cost (130.2ms) is consistent with the previously-documented fallback-scan cost (~197ms measured when `~/.claude/projects` held 5778 dirs; it holds 1919 now, and a smaller directory count producing a smaller scan cost is the expected direction, not a contradiction).

**Honest magnitude caveat — this does NOT by itself explain a park.** Even the worst measured case here (~100ms at 6.6MB / ~400-760K tokens) is roughly two orders of magnitude smaller than the ~40s minimum hold the fixed retry budget requires before a message parks (DoD-3). A single ~100ms synchronous delay per Stop hook cannot, alone, exhaust that budget. What it *can* do, and what I have not measured: since this blocks Node's single event loop, it delays **every other live session's** hook/drain processing on the same daemon for that same window, not just the heavy session's own — so under concurrent load (several heavy sessions hitting Stop around the same moment), the effect could compound past what one file's parse cost alone suggests. I did not measure concurrent-load compounding — that would need a live multi-session daemon under real traffic, not a single-process probe, and is a distinct experiment from this one.

**Scope of this finding, stated plainly:** this confirms a real, measured, code-level mechanism by which heavier context adds latency to Loom's own message-processing pipeline (not the LLM's). It is corroborating evidence that "more context → more of some cost" is a real property of this system, at a small and clearly bounded magnitude — it is **not** a measurement of the engine-side confirmation lag the card's hypothesis is actually about, and should not be read as one.

## DoD-5 — mine the existing corpus, respecting the population-exclusion caveat

The pinned project memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` already carries a real, cross-verified measurement of confirmation latency: n=177 give-up-driven, content-matched confirmations pooled across 4 `daemon-output.log` rotations, p50=8.5s, p90=45.9s, p95=342s, p99=675s, max=970s (16min). I did not re-derive this number (it is recent, dated 2026-08-05, and already independently produced by multiple parties per its own text) — I **independently spot-checked** that the underlying corpus genuinely exists and behaves as claimed, rather than taking it on trust:

```
$ wc -l ~/.loom/logs/daemon-output.log
62161 /c/Users/danie/.loom/logs/daemon-output.log

$ grep -c '^\[submit\] .* CONFIRMED logicalId=' ~/.loom/logs/daemon-output.log
70
```
(70 in the *current* log rotation alone — consistent with the memory note's 177 being pooled across 4 rotations, not a discrepancy.)

**Critically, per the card's own warning, I checked directly whether `ctxInputTokens` (or any context-size field) ever co-occurs with these events — it does not:**
```
$ grep -c 'ctxInputTokens' ~/.loom/logs/daemon-output.log
2
$ grep '\[submit\]' ~/.loom/logs/daemon-output.log | grep -c 'ctxInputTokens\|contextTokens'
0
```
`ctxInputTokens` appears exactly twice in the entire current log, in neither case attached to a `[submit]` line — the log genuinely never stamps a give-up/confirm event with the recipient's context size. And the DB side offers no rescue either: `setContextCounters` (`db.ts:4739-4741`) **overwrites** a session's `ctxInputTokens` in place on every write — there is no history table, so even a fresh query only ever returns the session's *current* value, not what it was at the moment of some past give-up event.

**Conclusion, stated exactly as the card requires: this corpus structurally CANNOT be correlated with context size** — not "wasn't," CAN'T, independently confirmed by grep rather than inferred from the card's warning. Computing any context-size-vs-latency rate from it would be fabricating a join that doesn't exist in the data.

**Restating the card's own population-exclusion caveat, since it's the load-bearing limit here and easy to lose in a summary:** even setting the above aside, the n=177 population is every case that DID eventually confirm — by construction it excludes anything that stayed parked forever. It answers "how long did a successful confirmation take," never "did park incidence scale with size," which is the actual question. I have not computed, and am not reporting, any park-rate number from this corpus — there isn't one to compute.

## DoD-2 — the within-session contrast this card correctly says a worker cannot run

I have no `worker_message`/`worker_status` surface and cannot drive another live session — this needs the manager. What I need, precisely:

1. **Pick ONE live, currently-light-context session** (worker or manager) that's expected to keep running for a while.
2. **Send it a short, fixed probe message now** (exact same text you'll reuse in step 4) and record: wall-clock send time, and either the confirmation time (via the `CONFIRMED logicalId=…latencyMs=…` log line / `directive_status`) or a park.
3. Let it continue accumulating **real** context naturally through its own ordinary work (not synthetic filler) until it's grown substantially (ideally 2×+ its step-1 size).
4. **Send the exact same probe text again**, record the same way.
5. Hold constant: recipient identity, exact message text/length, sender identity. Cannot be held constant and should be reported alongside the result: busy/idle state at each send (the card's own table already shows idle-vs-busy is not the discriminator, but record it anyway), and ambient host load at each moment (`gate_queue` / concurrent session activity at both timestamps).
6. Report back the two (send, confirm-or-park) pairs — that comparison IS the missing data point; no further write-up is needed from me to use it.

**Separately, to resolve DoD-1's remaining open question**: was there a daemon restart, or did the manager's own session resume, between ~03:5xZ and 04:18:20Z on 2026-08-02? That single fact determines whether the manager's own duplicate specimen was Class A (shares PARK's mechanism) or Class B (restart/resume bookkeeping, unrelated to context size) — see DoD-1.

## DoD-6 — the budget was not widened

No constant named in DoD-3 was changed. `filesChanged` for this task is exactly this findings document plus the new `_`-prefixed probe script — no production code under `packages/daemon/src/**` was touched.

## DoD-7 — no run_gate, no full suite

Only the probe script above was run directly (`node packages/daemon/test/_probe-context-scan-latency.mjs`), plus read-only `grep`/`ls`/`wc` against the repo and `~/.loom/logs/`/`~/.claude/projects/`. No gate, no full suite, no `run_gate` call.

## Summary

This is a genuinely mixed result, not a clean confirm or a clean kill:

- **DoD-1**: two structurally distinct duplicate-delivery mechanisms exist; only one (the in-session give-up/remint chain) shares PARK's mechanism. Which one produced the manager's own specimen is unresolved without a manager-side fact (DoD-2).
- **DoD-3**: the retry/park budget is confirmed fixed in every dimension checked, including all derived arithmetic — it will not adapt to anything.
- **DoD-4**: the card's actual hypothesis (engine-side confirmation lag scaling with context) was **not** directly tested — I judged the real-engine experiment too costly/risky to run unilaterally, and said so rather than fake it. What I found instead is a different, real, code-verified mechanism (Loom's own synchronous transcript-file parse on the Stop-hook critical path) that **does** measurably scale with context/file size — real numbers, real files, a working negative control — but at a magnitude (tens to ~100ms at the observed real sizes) roughly two orders of magnitude too small to explain a park on its own.
- **DoD-5**: the existing corpus was independently re-verified to exist and behave as the pinned memory describes, and independently confirmed structurally incapable of answering the context-size question — no field anywhere links a confirmation/give-up event to the recipient's context size at that moment.
- **Net**: the hypothesis is **neither confirmed nor dead** — it is untested at the scale that matters (real engine, hundreds-of-K context), with one small, real, positive-but-insufficient mechanism found along the way. Closing this needs either the manager's within-session contrast (DoD-2) or an explicitly-authorized, budgeted real-engine probe at production context scale — not a wider retry budget (DoD-6 stands).
