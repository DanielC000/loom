# c4ccae66 — H1a's intermittent gate failure is a test-check conflation, not a production repeat-delivery bug

## Verdict, up front

**DoD-1: test bug, NOT `spawnControlDelivery` rig contamination in the write-mixing sense the card proposed, and NOT a production defect.** `fa` never received a write intended for another session — `fakes[i]` is a stable object reference, and every test file in this suite runs as its own child process (`scripts/test-daemon.mjs` › `runOne`), so there is no cross-*file* state to bleed either. The real mechanism: `sendEnterAndVerify` (host.ts) legitimately re-writes the exact `BRACKET_PASTE_START` byte sequence (`"\x1b[200~"`, aliased `PASTE_START` in this test) as part of its designed Enter-confirmation retry — a bare, zero-length `BRACKET_PASTE_START + BRACKET_PASTE_END` "reassert-paste" pair, carrying NO kickoff body text — once `SUBMIT_VERIFY_TIMEOUT_MS` elapses with no confirming hook. H1a deliberately never delivers one (that is the whole point of the scenario: "nothing else starts a turn"), so this retry is *guaranteed* to eventually fire. The old check, `countIn(fa, PASTE_START) >= 2`, could not tell that apart from a genuine second delivery of the kickoff body.

**DoD-2/DoD-3: forced deterministically** — see below.

**DoD-4: the fix does not touch `NEGATIVE_WINDOW_MS` or `SUBMIT_VERIFY_TIMEOUT_MS`** — it changes what the check counts, which removes the race entirely rather than shrinking its probability.

## DoD-1 — excluding the rig

`fa` is captured once, right after `kick-A`'s own `host.spawn(...)` call, as `lastFake()` — `fakes[fakes.length - 1]` at that instant. `fakes` is a module-level array that every `createPty` call (including every later `spawnControlDelivery` control session) pushes a NEW element onto, but `fa` itself stays a fixed reference to kick-A's own fake object; pushing more elements onto `fakes` cannot retroactively change what `fa` already points to. There is no shared mutable buffer between `fa` and the control session's own `fake` — each `TestPtyHost.createPty` call constructs its own `writes` array closure. So a write genuinely landing on `fa.writes` can only come from a real `PtyHost` write call scoped to `kick-A`'s own `sessionId`, never the control's.

Cross-*file* contamination is separately excluded structurally: `scripts/test-daemon.mjs`'s `runOne` spawns every hermetic test file as its own **child process** (`spawn(process.execPath, [file], {env: {..., LOOM_HOME: home, LOOM_PORT: String(port)}})`) — own temp `LOOM_HOME`, own port, own Node process, own module-level state. Nothing in another concurrently-running test file (even in the same `pool size 3` gate run) can touch this file's `fakes`/`host`/`live` state.

**What actually happened:** `fa.writes` genuinely contains two `BRACKET_PASTE_START` byte sequences under gate load — the observation the card's own `assertNeverWithControl` correctly reported (`check()` returning false is a real, not-censored, second occurrence — matches the card's own §WHAT-IS-NOT-ESTABLISHED framing that this is a genuine observed violation, not an instrument failure). But the SECOND occurrence carries no kickoff body text: it is `sendEnterAndVerify`'s own attempt-2 reassert-paste, a real, designed, in-scope production behavior (see host.ts:44-66's own doc for why a retry re-asserts a zero-length `START+END` pair before its Enter). The test's own `countIn(fa, PASTE_START)` check cannot distinguish "the kickoff was delivered twice" from "the kickoff was delivered once, and its own unconfirmed-Enter retry chain reasserted an empty paste marker" — both produce `countIn(..., PASTE_START) === 2`.

## DoD-2 — enumerating paths to a second `PASTE_START`-bearing write

Within THIS test file's (H) hermetic-host-only section (no `SessionService`, no `onKickoffGiveUpExhausted` wiring — `events` only defines `onEngineSessionId`/`onContextStats`/`onRateLimited`/`onExit`/`onBusy`):

1. **A genuine second `submit()` call** (the bug this test exists to guard against) — `scheduleKickoffGuarantee`'s own internal `firstTurnStarted` recheck is what prevents this; H1b/H1c directly test it.
2. **`sendEnterAndVerify`'s own attempt>1 reassert-paste** (host.ts:6080-6081) — writes `BRACKET_PASTE_START + BRACKET_PASTE_END` on every retry once `SUBMIT_VERIFY_TIMEOUT_MS` elapses unconfirmed. **This is the one that fires in H1a** — confirmed live via the reproduction below (`[submit] kick-A Enter attempt 1 NOT confirmed within 5000ms — retrying` immediately followed by `tag=reassert-paste`).
3. **`submit()`'s own defensive clear-prefix reassert** (host.ts:5957/5971, the `composerDirtyLen > 0` branches) — NOT reachable here: `composerDirtyLen` starts at 0 for a fresh session and kick-A's kickoff is its first-ever write, so the plain (non-dirty) `else` branch (line 5973-5977) is the one that runs.
4. **The give-up RE-MINT path** (`SessionService.handleKickoffGiveUpExhausted`, service.ts:6789) — the manager's own leading suspect, given the live specimen's climbing `unconfirmedDeliveryMs`. **Structurally unreachable inside this test's (H) section**: `scheduleKickoffGuarantee`'s `onGiveUpExhausted` callback is `() => this.events.onKickoffGiveUpExhausted?.(...)`, and this test's `events` object never defines `onKickoffGiveUpExhausted` — the optional-chained call is a no-op. A re-mint would additionally require `GIVE_UP_REQUEUE_LIMIT`(1)-many in-session requeues on TOP of `SUBMIT_MAX_ATTEMPTS`(4) full Enter-retry cycles — several multiples of `SUBMIT_VERIFY_TIMEOUT_MS` — never reached by the `NEGATIVE_WINDOW_MS`-bounded observation here regardless. **This mechanism is real (see `ee9f3974`'s own findings for a direct, deterministic reproduction of a re-mint racing a mismatched confirming hook) but is NOT what produced THIS card's H1a gate failure** — it is a different, structurally distinct code path from the one actually exercised in this scenario.
5. **A mode-cycle re-signal** (`logLandedMode`'s auto-heal, host.ts:7415-7420) — not reachable for kick-A: the fake pty is never fed footer text, so `detectPermissionMode` reads "unknown" and no heal fires (the heal requires a definite mismatched-mode read).
6. **The reconcile tick** (`healIfStuck`) — only clears `busy`; it never writes to the pty.

So within this test's own harness, path (2) is the only one reachable, and it is a real, correct, in-scope production behavior — not a defect.

## DoD-3 — deterministic reproduction

Built a standalone reproduction (session scratchpad, not committed — mirrors this test's exact H1a shape) that spawns kick-A identically, waits for its real delivery, then waits for kick-A's own Enter-attempt-1 write to physically land (fixing its `SUBMIT_VERIFY_TIMEOUT_MS`(5000ms, pinned) confirmation deadline to a concrete real-clock instant), THEN injects a deliberate, bounded, synchronous busy-wait (simulating host-contention-induced event-loop lag) before running `assertNeverWithControl` exactly as the real test does.

**Measured natural margin (zero injected delay, `positiveControl`'s own real cost only):** kick-A's Enter attempt 1 fires at ≈t+4100ms (dominated by `logLandedMode`'s own footer-read poll — `MODE_LOG_POLL_MS` defaults to 500ms × `MODE_LOG_MAX_ATTEMPTS`(8, not env-overridable) ≈ 4000ms before `markReady` lets delivery proceed, since the fake pty here never feeds footer text and `markReady` gates every kickoff delivery on that poll settling first). Its retry deadline is therefore ≈t+9100ms. `positiveControl()` itself pays the SAME ≈4000ms cost for its OWN throwaway `spawnControlDelivery` control session, so the real `observeOnce` window on `fa` doesn't even START until ≈t+8600ms and ends ≈t+8800-8900ms — a genuine but THIN ≈200-500ms margin, not the "25x"/"comfortably under" the old check's own comment claimed (which never accounted for `positiveControl`'s own non-negligible real cost).

**Forcing it red:** injecting **700ms** of extra delay after kick-A's Enter-attempt-1 write (before `positiveControl` starts) reliably reproduced the exact observed gate failure against the OLD (`PASTE_START`-counting) check:

```
[submit] kick-A Enter attempt 1 NOT confirmed within 5000ms — retrying
[submit] kick-A Enter attempt 2/4 written gen=1 — awaiting confirmation
RESULT: FAIL  (H1a) still exactly ONE delivery (no repeat firing)
FINAL countIn(fa, PASTE_START) = 2
```

Reverting the injection (0ms) reliably passed. This is a forced precondition, not a sampled flake — the same 700ms injection was then re-run against the FIXED (kickoff-body-text-counting) check, and against a much larger 4500ms injection (guaranteeing attempt-2 fires mid-window), and BOTH stayed green:

```
[submit] kick-A Enter attempt 1 NOT confirmed within 5000ms — retrying
[pty-write] kick-A ... tag=reassert-paste ...
[submit] kick-A Enter attempt 2/4 written gen=1 — awaiting confirmation
RESULT: PASS  (H1a) still exactly ONE delivery of the kickoff body (no repeat firing)
FINAL countIn(fa, PASTE_START)=2 countIn(fa, KICKOFF)=1
```

`countIn(fa, PASTE_START)` genuinely reaches 2 in both the failing and the fixed run — the retry really fires either way — but `countIn(fa, KICKOFF)` correctly stays at 1, since the reassert-paste carries no body text to match.

## DoD-4 — the fix does not widen any budget

`NEGATIVE_WINDOW_MS` (200ms) and `LOOM_SUBMIT_VERIFY_TIMEOUT_MS` (5000ms, pinned) are both unchanged. The fix changes WHAT the check counts — `countIn(fa, KICKOFF)` (the kickoff body text) instead of `countIn(fa, PASTE_START)` (a byte marker `sendEnterAndVerify` also legitimately writes on its own, unrelated retry path) — which structurally cannot be tripped by a bare reassert-paste, regardless of how much real time elapses before the check runs. The 4500ms-injection run above (§DoD-3) demonstrates this holds even far past where the old check would have failed with certainty. `positiveControl` was updated in lockstep (it must force a genuine repeat of the SAME control-kickoff text, not an unrelated string, to remain a valid proof that the new check can catch a real violation — `assertNeverWithControl` itself refuses to run without a positive control that actually flips its own `check()` true).

## DoD-5 — static guards

All four run directly against the modified file:

- `node test/clock-path-regression-guard.mjs` → PASS (0 new bare/indented clock-derived-path sites).
- `node test/fixed-wait-negative-guard.mjs` → PASS (0 new fixed-wait-guarding-a-negative-assertion sites; the file's existing `assertNeverWithControl` usage is unchanged in shape, only its `check`/`positiveControl` closures' content changed).
- `node test/onexit-discard-guard.mjs` → PASS (no onExit-discarding fake-pty handle; this file's `TestPtyHost`/fake shape is unchanged).
- `node test/codescape-privacy-guard.mjs` → PASS (unaffected by this change).

## Which world (DoD-6 / DoD-1's own framing)

**Test bug — the check counted the wrong thing, not "the rig contaminated `fa`."** No production code changed. `worker-kickoff-guarantee.mjs` re-run 3× post-fix, full file (`LOOM_GATE_TEST_CONCURRENCY=2 node scripts/test-daemon.mjs --only=worker-kickoff-guarantee`), all green, ~29s each (unchanged wall-clock — the fix does not touch timing, only the check's discriminator).

## What this does NOT establish

- Does not bear on `kickoff-real-spawn`'s own gate failure (card `3a6f04cc`) — cited by the parent card only as a neighbouring observation, out of this card's scope, untouched here.
- Does not establish that the give-up/re-mint mechanism (`ee9f3974`'s own subject) is bug-free — that investigation stands on its own; this card's mechanism is a structurally different code path (§DoD-2, item 4) that happens to share a symptom family (a second `BRACKET_PASTE_START`-bearing write) with it.
- Does not touch `pty/host.ts`'s mismatch-notice suppression or `drainPending`/`deferForHumanDraft` (card `2521bf51`'s scope) — no production file was modified by this investigation at all.
