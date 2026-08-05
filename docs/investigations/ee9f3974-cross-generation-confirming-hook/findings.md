# ee9f3974 — a re-mint's own confirming hook can arrive content-mismatched, so even a landed submit is unattributable

## Verdict, up front

**DoD-1: NOT foreclosed.** The cross-generation confirming-hook race is structurally reachable post-`cfd71868`, and `cfd71868` *widens* the kickoff's own exposure to it (a kickoff can now pass through a second generation via its re-mint, where before it had none). Code cited below.

**DoD-2: forced deterministically.** `packages/daemon/test/kickoff-giveup-content-mismatch.mjs` (new) drives the exact race — a genuine confirming hook (`UserPromptSubmit`+`Stop`) whose content is a small, realistic near-miss of the tracked signature — and observes the re-mint go on to drain and physically write a real, duplicate second paste. A negative control (byte-identical hook) proves the same rig resolves cleanly when the echo is exact, so the failure is specifically about the mismatch, not an artifact of the harness. Full run captured below.

Everything else in this doc (DoD-3 through DoD-6) is scoped narrower and should not be read past what's stated.

## Files changed

- `packages/daemon/test/kickoff-giveup-content-mismatch.mjs` (new) — the DoD-2 deterministic reproduction.
- This file.

No production code was changed. This investigation did not reach a fix (DoD-1 found the race still open; DoD's own text says finding that is a complete, valuable outcome in itself, distinct from "structurally foreclosed").

---

## DoD-1 — can a confirming hook still arrive while an earlier generation is ambiguous and a later one is current?

**Yes.** Two independent mechanisms in `pty/host.ts` make this reachable, and `cfd71868` does not touch either of them.

### The two resolution paths, and their asymmetry

A confirming hook (`UserPromptSubmit` or `Stop`/`StopFailure`) runs `purgeConfirmedGiveUpRequeue` (`pty/host.ts:6719`). It tries two paths, in order:

1. **Content match** (`pty/host.ts:6720-6781`) — iterates `Live.ambiguousDispatches` (a `Map<logicalId, {len, hash, ...}>`) and purges any entry whose `{len, hash}` exactly matches the hook's reported prompt. This is the *only* path that is content-verified.
2. **FIFO-position fallback** (`pty/host.ts:6782-6816`) — content-blind. It looks at the front of `Live.giveUpConfirmQueue` and purges it *only if* that generation is either the current `submitGeneration` or itself still in the ambiguous queue (`pty/host.ts:6786-6787`). If a fresher, non-ambiguous generation has since become current, it explicitly **declines to purge**, logging:

   > `GIVE-UP RECOVERY: a confirming hook arrived while generation ${gen} is still ambiguous, but generation ${live.submitGeneration} (a fresh, non-ambiguous submit) is now current — leaving generation ${gen}'s requeued entry un-purged rather than risk deleting a genuinely-unconfirmed message; it will still resolve via its own bounded hold` (`pty/host.ts:6808`)

   — **this is the exact log line the card's own pre-fix trace recorded**, and my reproduction below reproduces it verbatim, live, post-fix.

`requeueGiveUpOrigin` (`pty/host.ts:6358-6429`) is the single function that populates both structures, and it does so asymmetrically:

- `Live.ambiguousDispatches` is seeded **for every message it processes**, kept or exhausted alike (`pty/host.ts:6401`, comment at `6386-6392`: "seed/refresh `ambiguousDispatches` for THIS message's logicalId regardless of which branch below runs").
- `Live.giveUpConfirmQueue` is pushed **only for a KEPT message** (`pty/host.ts:6423-6425`, inside `if (kept.length > 0)`). An **exhausted** message (`requeues > GIVE_UP_REQUEUE_LIMIT`, `pty/host.ts:6404`) takes the `continue` branch and is never added.

So: an exhausted-and-reminted message's ambiguity can *only* ever be resolved by an exact content match. There is no generation-position backstop for it specifically — though, as my reproduction found, a *stale* queue entry can be left over from an earlier "kept" cycle of the *same* give-up chain (see below), which still declines to purge for the same reason.

### This is not kickoff-specific, and `cfd71868` widens it for the kickoff path

`requeueGiveUpOrigin` is the same function `handleGiveUpExhausted` (ordinary durable messages, `sessions/service.ts`) already routed through before `cfd71868` existed. The asymmetry above is not new. What `cfd71868` (+ card `7772176d`) changed is specific to the **kickoff**: before it, an exhausted kickoff went straight to park (`sessions/service.ts` pre-`cfd71868`, per that commit's own diff) — one generation, no re-mint, so a stale confirming hook for it had nothing to interleave with. After `cfd71868`, `handleKickoffGiveUpExhausted` (`sessions/service.ts:5957`) re-mints via `this.pty.enqueueStdin(...)` (`sessions/service.ts:~5980`, inside the `chainDepth < GIVE_UP_REMINT_LIMIT` branch) — a **new** dispatch, a **new** generation once it drains — before ever parking. That is a second generation for the kickoff to race against, where previously there was none. `GIVE_UP_REMINT_LIMIT = Number(process.env.LOOM_GIVE_UP_REMINT_LIMIT) || 1` (`sessions/service.ts:1299`) bounds it to one re-mint by default, but one is enough to reproduce the card's race, as shown below.

### Reproduction (DoD-2), full output

New test: `packages/daemon/test/kickoff-giveup-content-mismatch.mjs`. Built and run directly (`pnpm build`, then `node test/kickoff-giveup-content-mismatch.mjs`), no `run_gate`.

Scenario (C) drives a real two-cycle kickoff exhaustion (mirrors the existing `kickoff-giveup-remint-purge.mjs`'s own helper), lets the re-mint queue up (held), then delivers a **genuine** confirming hook (`UserPromptSubmit` with a `prompt` truncated by 5 chars — the same shape class as the original trace's `reportedLen=44365` vs `writtenLen=44405`, a 40-char delta — followed by `Stop`, closing out the turn that hook opened). Scenario (D) is the negative control: identical setup, byte-identical `prompt`.

Key excerpts from the real run (full log is longer; every `PASS`/`FAIL` line shown, condensed pty-write noise):

```
PASS  (kickoff-mismatch-unpurged) cycle 2 gave up: the kickoff EXHAUSTED (real two-cycle exhaustion, not the single-cycle shortcut)
PASS  (kickoff-mismatch-unpurged) rootMsgId was captured via onKickoffGiveUpExhausted
PASS  (C) setup: exactly ONE physical body write so far
PASS  (C) setup: the re-mint is queued (held)
PASS  (C) sanity: the mismatched prompt is genuinely a near-miss, not a wholesale different string
[hook] kickoff-mismatch-unpurged UserPromptSubmit session_id=-
[submit] kickoff-mismatch-unpurged GIVE-UP RECOVERY: a confirming hook arrived while generation 1 is still
  ambiguous, but generation 2 (a fresh, non-ambiguous submit) is now current — leaving generation 1's
  requeued entry un-purged rather than risk deleting a genuinely-unconfirmed message; it will still
  resolve via its own bounded hold
[prompt-echo] kickoff-mismatch-unpurged gen=2 byteIdentical=false reportedLen=124 writtenLen=129
  reportedHash=0aa9ed07 writtenHash=41e46d90 ambiguousMatch=false
[prompt-mismatch] kickoff-mismatch-unpurged engine-reported submitted prompt DIVERGES from what Loom
  intended to write — possible frame splice (diagnostic only, does not fix 3ce3fa39). reportedLen=124
  intendedLen=129 lenDelta=-5 divergesAtChar=124 tailReportedLen=0 tailIntendedLen=5
PASS  (C) NO content-matched CONFIRMED log fired — the mismatch defeated the ONLY resolution path that
  could actually purge this exhausted generation's re-mint
PASS  (C) THE RE-MINT IS STILL QUEUED — a genuine confirming hook arrived and changed nothing
[hook] kickoff-mismatch-unpurged Stop session_id=-
PASS  (C) after Stop: still un-purged
[submit-write] kickoff-mismatch-unpurged reason=immediate ... head="[loom:prompt-mismatch] Loom wrote 129 chars for this turn (g"
  ... (the daemon's own [loom:prompt-mismatch] notice fires, itself gives up, gets held ahead of the
      kickoff re-mint in pending — a real, separate side effect; see "Incidental finding" below)
[submit-write] kickoff-mismatch-unpurged reason=drain ... head="[loom:possible-duplicate root:da537d93] orchestrate task tk-"
  ... seq=17-21: reassert-paste, chunk (894 chars — the notice), bracket-start, chunk (129 chars — the
      ORIGINAL KICKOFF BODY, physically re-pasted a second time), bracket-end
PASS  (C) THE RACE, FORCED: the re-mint DRAINS and physically writes a genuine SECOND, duplicate paste of
  the kickoff body — DESPITE a real confirming hook having arrived in between. The hook's mere arrival
  did not resolve the ambiguity; only an exact content match would have, and this one wasn't exact.
```

Negative control (D), same run:

```
[hook] kickoff-mismatch-negctrl UserPromptSubmit session_id=-
[submit] kickoff-mismatch-negctrl CONFIRMED logicalId=d8fc8242-... latencyMs=960 (content-matched —
  resolving any still-queued duplicate copies)
[submit] kickoff-mismatch-negctrl GIVE-UP RECOVERY was a false negative (content-matched) — a confirming
  hook proves logicalId=d8fc8242-...'s turn actually started; purged a still-queued duplicate (128 chars)
  instead of letting it double-deliver
[prompt-echo] kickoff-mismatch-negctrl gen=2 byteIdentical=true reportedLen=128 writtenLen=128 ...
PASS  (D) NEGATIVE CONTROL: the content-matched CONFIRMED log DOES fire when the echo is exact
PASS  (D) NEGATIVE CONTROL: the re-mint IS purged
PASS  (D) NEGATIVE CONTROL: body count stays at 1 — this rig genuinely distinguishes an exact match (D,
  resolved) from a near-miss (C, unresolved), so (C)'s failure is specifically about the content
  mismatch, not an artifact of this harness

✅ ALL PASS — card ee9f3974: a GENUINE confirming hook (UserPromptSubmit+Stop) whose reported content is
NOT byte-identical to the exhausted generation's own tracked signature leaves a re-minted kickoff
un-purged, and it goes on to drain and physically write a real, duplicate second paste (C) — DoD-1's race
is forced deterministically, not sampled for. The identical setup with an exact-match hook resolves
cleanly and never duplicates (D), proving the rig discriminates the two cases rather than always failing.
```

Both scenarios: **PASS**, all checks. Exit code 0.

**Guards run directly** (this file is new under `packages/daemon/test/`, so the four `readdirSync`-based static guards were run per the kickoff's own instruction):
- `node test/clock-path-regression-guard.mjs` → PASS (0 new bare/indented clock-derived-path sites).
- `node test/fixed-wait-negative-guard.mjs` → **FAILED twice, for two distinct sites, both genuinely fixed (not exempted):**
  1. First failure: scenario (C)'s original drain wait (a single `sleep(HOLD_WAIT); host.reconcile();` before a positive-condition check) was insufficient on its own merits before it was even guard-flagged — the mismatched hook also triggers the real `[loom:prompt-mismatch]` notice (see "Incidental finding" below), which needs more than one hold window to clear out of the re-mint's way, so a fixed sleep there was genuinely flaky, not just guard-shaped. Fixed by replacing it with `reconcileUntil` — a bounded poll on the actual observable (`bodyCount(KICKOFF) >= 2`), not a fixed duration.
  2. Second failure (surfaced only after fixing (C), on the next guard run): `NEW kickoff-giveup-content-mismatch.mjs:269 "(D) NEGATIVE CONTROL: body count stays at 1 forever..."`. Unlike (C), this one did not need a poll at all — the content-match purge in (D) already resolves **synchronously** inside `deliverHook` (verified immediately, before `Stop` even fires: `check("(D) NEGATIVE CONTROL: the re-mint IS purged", ...)`), so the trailing `sleep(HOLD_WAIT)` was dead weight, not a genuine wait for anything. Removed it entirely — `host.reconcile()` alone, with nothing pending, is a true no-op, the identical justification `kickoff-giveup-remint-purge.mjs`'s own scenario (A) uses for its structurally-equivalent check (no wait precedes it there either).
  - Re-run after both fixes: **PASS, 0 new sites.**
- `node test/onexit-discard-guard.mjs` → PASS (no onExit-discarding fake-pty handle; this test's `SilentTestPtyHost`/fake pty shape was already covered by the discriminator's existing corpus scan, 714 files, 0 new).
- `node test/codescape-privacy-guard.mjs` → PASS (no codescape-named string reaches a user-visible surface; unaffected by this change).

### Incidental finding, worth naming even though out of this card's direct scope

Delivering the mismatched hook (with `submitWasOutstanding=true`, i.e. it looked like a confirmation of the currently in-flight generation) also fired the real `[loom:prompt-mismatch]` notice (`pty/host.ts:4522-4547`, gated on `hook.prompt !== live.lastPrompt`). That notice itself dispatches immediately, itself gives up (the fake pty emits nothing), and gets re-queued **ahead of** the still-held kickoff re-mint (`live.pending.unshift`, `pty/host.ts:6424`). This is a real, observed production side effect — a mismatched hook doesn't just fail to resolve the original ambiguity, it can also spawn a second, unrelated give-up chain that temporarily reorders the pending queue. It did not change this card's outcome (the kickoff re-mint still drained and duplicated once the notice's own chain cleared), so it is not separately carded here, just recorded as an observation for whoever picks this card's mechanism up next.

---

## DoD-3 — the `[prompt-echo]` hash is a fact whose interpretation is contested

Followed throughout this doc. Every place this investigation cites a `byteIdentical`/hash-equality result, it is cited as **the daemon's own internal resolution criterion firing or not firing** (a claim about `purgeConfirmedGiveUpRequeue`'s control flow, which I can observe directly in the test harness), never as an independent claim about what the real Claude Code engine actually executed. Per pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` and the card's own DoD-3, a real production `byteIdentical=true` is evidence the *echo* matched, not proof against a frame splice or a lagged/stale confirmation; I make no claim here about real engine behavior beyond what the daemon's own hooks reported in the corpus (DoD-6 section below), and every corpus-derived number there is stated with its own instrument and population named.

## DoD-4 — does any comment assert a confirming hook is unambiguously attributable to its generation?

Searched `pty/host.ts` and `sessions/service.ts` for overclaiming language (`unambiguously attributable`, `always attributable`, `guarantees resolution`, `guaranteed to resolve`, `never fails to`, `always resolves`, `always correctly attribut`):

```
$ grep -n "unambiguously attributable\|always attributable\|guarantees resolution\|guaranteed to resolve\|never fails to\|always resolves\|always correctly attribut" pty/host.ts sessions/service.ts
pty/host.ts:399: * to report whether its Enter actually confirmed, so the MCP call it backs always resolves instead of
pty/host.ts:3559:   * `resolveProjectId` that always resolves `null` both clean-skip the codescape MCP mount for every
```

Both hits are unrelated (Promise-resolution wording in a different context, not attribution claims). **No comment found asserting general/unconditional attribution.** The two places that make strong claims are both correctly scoped to the case that actually earns them:

- The content-match branch's `clearComposerDirtyOnConfirm` doc (`pty/host.ts:6674-6709`) calls an exact match "decisive proof" / "transitive proof of the WHOLE preceding write chain" — true, and explicitly conditioned on the content match having actually fired.
- The FIFO-fallback's own doc (`pty/host.ts:6699-6702`) explicitly *disclaims* the same strength: "does NOT carry this same transitive proof — it resolves by generation position alone, with no verification of what was actually echoed." This is the opposite of overclaiming.
- `purgeConfirmedGiveUpRequeue`'s own top-of-function doc (`pty/host.ts:~6650-6673`) carries an explicit "SCOPE — WHAT THIS DOES NOT CLOSE" section, itself citing the project's own "a comment is a claim" rule by name and naming a residual it does not close (already-dispatched duplicate writes). It does not, however, separately scope the *content-mismatch* residual this card is about — that's a documentation gap (the comment is honest about one residual and silent about a second, real one), not a false claim. Worth a follow-up doc note if/when this card's mechanism is fixed, but not itself "part of the defect" under DoD-4's own test (an affirmative false claim), since nothing asserts the opposite of what's true.

**DoD-4 answer: no defect-qualifying comment found.**

## DoD-5 — the durable-inbox/composer asymmetry

Loom already has a durable store for **ordinary** messages: `enqueueDurableMessage` (`sessions/service.ts:6319`) persists a `session_message_queued` row; an undelivered one is re-driven idempotently on the recipient's next resume/boot (`sessions/service.ts:4278`, "Re-drive ONE still-undelivered durable `session_message_queued` event onto its recipient, idempotently"). For that class of message, Loom **already does** what Codescape's peer scenario asks for — recovery already reads from the durable store, not just the live composer.

**The kickoff is the deliberate exception**, and it is exactly the mechanism this card investigates. `cfd71868`'s own doc says so directly: the re-mint is "routed... through `this.pty.enqueueStdin` directly rather than `enqueueDurableMessage`: the kickoff's synthetic origin was never durable in the first place (no `session_message_queued` row..." (`sessions/service.ts:6725`, comment block above `handleKickoffGiveUpExhausted`). So for this card's specific mechanism, there is no durable row to read from — the entire live state (`live.pending`, `live.ambiguousDispatches`) is in-memory only.

**Ruling:** yes, recovery should read from the durable store where one exists — and it already does, for every message *except* the kickoff. For the kickoff specifically, I am not recommending making it durable as part of this card: that would be a real design change (a `session_message_queued` row for a message that was deliberately kept synthetic per `cfd71868`'s own stated reasoning — no `sender` to attribute a park-notice to, see that method's doc at `sessions/service.ts:~5985`), it's a change to the fix, not the diagnosis DoD-1/2 asked for, and the card's own DoD-1 framing ("if it structurally forecloses it, close the card; if not, force it deterministically") never asked for a design. Flagging it as the honest, concrete next question for whoever picks up a fix: **if the kickoff re-mint is lost to a content-mismatch (this card's proven race) and the daemon restarts before it drains, is there currently ANY way to recover it — durable or otherwise?** I did not chase that sub-question (out of DoD-1/2/6's scope as filed), but it is a strictly worse failure mode than the duplicate-delivery this doc proves (loss, not duplication), and it follows directly from the same "kickoff is deliberately non-durable" fact this ruling establishes.

**⚠️ QUALIFICATION (2026-08-05, manager-relayed, after the ruling above was written) — the premise "the durable inbox retains what the composer drops" does not hold universally, even for messages that DO have a durable store.** Two specimens, relayed to me, not independently verified by me:

- The manager's own live session: an owner message arrived as a bare `[Pasted text #14 +16 lines]` (27 chars, zero body). `inbox_pull` — the documented recovery path, the one the peer's original "the inbox survived what the composer path lost" claim pointed at — **did not contain the message** (it returned an unrelated peer message; a true negative, not a broken call).
- The peer's own specimen 4: two user pastes lost from **both** the composer path and the durable-inbox path.

So my ruling above — "recovery should read from the durable store where one exists" — is still the right *design* answer (reading a durable store you have is strictly better than not reading it), but I am **weakening the claim that doing so is a reliable backstop**. It is not: the durable store can itself be missing the content, for reasons neither I nor the manager has diagnosed here (this is squarely out of DoD-1/2/6's scope as filed — I am recording the qualification, not chasing the mechanism). **Do not read this ruling, or the earlier `cfd71868`-quote about the kickoff's non-durable origin, as implying that making the kickoff durable would fully close the loss mode this card's race can produce.** It would close it only in the cases where the durable store actually holds the content — which, per these two specimens, is not guaranteed even for messages that already have one.

**On denominators, relayed alongside the above and worth stating explicitly for whoever reads this doc's counts:** a recovery-notice firing is not evidence the original was lost (the manager separately reports one firing for a message that had arrived completely intact) — so neither "count of mismatch/recovery notices" alone is a clean measure of how often real loss occurs; one direction undercounts (harmless firings nobody reads, per the addendum below) and the other overcounts (a notice can fire on content that needed no recovery at all). Every count in this document is a count of a specific **event class** (a `[prompt-mismatch]` log line, a length-decomposition match), never a count of "messages actually lost" — I have not conflated the two, but flagging the distinction here since the manager's correction makes clear it's easy to.

## DoD-6 — is the replay-the-previous-submission behavior universal or occurrence-specific?

**Partially determined — the universal reading is refuted by direct evidence; the narrower "always N-1, never older" reading (among mismatches that DO replay a same-session prior write) is not confirmed, and I found real counter-examples under a looser proxy, though not hash-verified.**

### Method

The code's own comment (`pty/host.ts:~4494-4503`) cites a "Platform sweep, 2026-08-05, over RETAINED logs": 3,816 `[prompt-echo]` records, 288 mismatches, **15** hash-verified "SUBSTITUTION-SIGNATURE" occurrences, all 15 replaying the immediately-preceding recorded generation. That sweep's own raw data/method is not in this repo for me to re-run, and its 15-sample population is a narrower, stricter (hash-verified) sub-class than "every mismatch."

I ran an independent, cheap check instead, directly against `~/.loom/logs/daemon-output.log{,.1,.2}` (the daemon's own un-rendered stdout tee — **not** the per-session `.log` terminal captures, which I found are contaminated: several contain the literal source-code strings `"IMMEDIATELY PRECEDING generation"` / `"not the immediately preceding one"` because an agent's own transcript was reading/quoting this exact file or this card's own body, not because a real notice fired — e.g. `~/.loom/logs/5a1f5884-....log` matched `"IMMEDIATELY PRECEDING generation"` 5 times but contains **zero** genuine `"[loom:prompt-mismatch] Loom wrote"` notice openers; `~/.loom/logs/f229f9e0-....log` has one real notice but the matched "not the immediately preceding one" lines include an unsubstituted template literal `{replayedEntry.gen}`, i.e. rendered *source*, not a delivered notice. This is exactly the "could this corpus have produced the failure I'm controlling against" trap — a naive full-text grep over per-session transcripts will match agents discussing the bug, not the bug. I discarded that approach and used the clean daemon-stdout tee instead.)

For each session, I built an ordered list of write lengths from every `[submit-write]` line (`pty/host.ts` logs `len=` on every dispatch, any reason), then for each `[prompt-mismatch] ... reportedLen=N intendedLen=M` line, checked whether `N` equals the length of that session's immediately-preceding write, an older one, or neither. This is a **length-only** proxy (a necessary, not sufficient, condition for "this is a replay of that write" — a coincidental length match is possible, and I did not verify hashes since the raw text isn't logged). Full script: `analyze-mismatch.mjs` (session scratchpad; reproducible from the description above against any `daemon-output.log*`).

### Result

```
Total [prompt-mismatch] events found (with per-session write history available): 345
Classification (by LENGTH equality against this session's own prior submit-write lengths):
  reportedLen == immediately-preceding write's len: 43
  reportedLen == an OLDER (non-adjacent) write's len: 16
  reportedLen matches NEITHER (no same-length prior write in this session's recorded history): 286
  reportedLen decomposes as (immediate-prior len) + (small 1..60 delta, placeholder-sized): 4
```

(345 events, 175+ distinct sessions, spanning `daemon-output.log.2` through the live `daemon-output.log`, roughly 2026-07-20 through 2026-08-05.)

### What this does and doesn't show

- **The literal universal claim — "every measured occurrence... replayed the immediately preceding submission" — read as a claim about ALL `[prompt-mismatch]` events, is refuted by this data.** 286/345 (83%) don't even length-match ANY recorded same-session prior write, immediate or older. The general form can only be true of the narrower sub-class the code comment itself scopes it to (hash-verified "SUBSTITUTION-SIGNATURE," 15 of 288 in that sweep, ~5%) — it is not, and was never claimed by the comment to be, a description of `[prompt-mismatch]` events as a whole. I want to be explicit that this is not a new finding contradicting the code comment; the comment's own wording already scopes "every measured occurrence of THIS class" to the narrower SUBSTITUTION-SIGNATURE population. What my check adds is a second, cheap, from-scratch measurement confirming that the *broader* population (all mismatches) does not share that property — useful context for anyone tempted to read the narrower claim as if it covered every mismatch.
- **The narrower "always N-1, never older" claim, restricted to mismatches that DO length-match some prior write** (43 + 16 = 59 of 345): 43/59 (73%) favor the immediate predecessor, but **16/59 (27%) length-match an older, non-adjacent write instead** — under my loose, length-only criterion. I cannot upgrade this to "the N-1 claim is false" — a length coincidence is plausible at these sizes (hundreds to low-thousands of characters, over dozens of candidate prior writes per session; `nOlderCandidates` in the raw output ranges up to 62 for some sessions), and I did not check hashes. But I also cannot repeat the code comment's "never older" as established fact beyond its own stated 15-sample population — my own cheap check, on a different and much larger population, finds real (if unverified) candidates for "older." **This is the honest boundary of what a cheap check can determine**, per DoD-6's own allowance.
- **The 4-event "decomposes as prior + small delta" count** is the closest analogue to the card's own `4258 = 4231 + 27` arithmetic that I could find mechanically in this corpus, under the same length-only method. I did not hand-verify these 4 (unlike the card's own arithmetic, which was verified against the actual `27`-char placeholder string). Reporting the count, not a stronger claim.

### Answer

**Not universal**, with directly cited counter-evidence (the 83%-no-match result). **Not confirmed as "always N-1 among the sub-population that does replay,"** with real but hash-unverified counter-examples (16 older-length matches) that this cheap method cannot rule in or out more precisely. I did not extend this into a hash-based re-verification of the full corpus (would require the raw submitted text, which is not retained at this length in the logs) — flagging that as the boundary of "cheap," not a gap I'm asserting is unimportant.

---

## Addendum (2026-08-05, manager-supplied model) — the placeholder-arithmetic signature across the FULL corpus, not just visible failures

After the above was written, the manager relayed a peer-project (Codescape) model built from three of their own specimens, all decomposing as `reportedLen = (one OR MORE paste-placeholder lengths) + {nothing | the CURRENT intended body | a PAST written body}` — three outcomes of the SAME underlying event: silent loss, a lossy stale-duplicate, or (the new insight) a harmless case where the correct body ends up attached anyway, invisible unless someone reads the notice. **Correction relayed after my first pass below: the model's original "the placeholder is always present (singular)" framing was wrong — a fourth peer specimen (`written 1004 / reported 4095`) carried TWO placeholders (27 + 26 = 53 chars combined), and its own decomposition (`4095 = 53 + 4042`) is explicitly UNVERIFIED by the peer (they don't hold the preceding submission's exact byte count) — recorded by them as "consistent with shape 2," not confirming it. In that same event, shape 1 (total loss) and shape 2 (stale replay) also co-occurred — the three shapes are not mutually exclusive outcomes of one event. I did not have this correction when I designed the scan below, so my window test (below) checks for exactly ONE placeholder-sized delta per event, not a sum of several — a real limit on this addendum's own coverage, stated here rather than silently absorbed.** The instruction: hunt this arithmetic shape across **every** `[loom:prompt-mismatch]` event, including the harmless ones nobody would have noticed — that population is likely larger and cheaper to characterize than chasing visible failures alone — and re-derive the placeholder length **per specimen**, never assume the one fixed value (27) (Codescape's own real examples ranged 26-28 depending on paste-line-count digit width; the window below already accounts for that range, not the two-placeholder case above).

### Method

Same corpus as DoD-6 (`~/.loom/logs/daemon-output.log{,.1,.2}`, the clean un-rendered daemon stdout tee), same per-session write-length history. For every `[prompt-mismatch]` event I do **not** have the raw placeholder text (the clean log line only carries `reportedLen`/`intendedLen`, never the submitted string), so I tested the **numeric shape** over a placeholder-length *window* (`[15, 50]` chars — generous around the 26-28 observed values, per the manager's own "never assume one value" caution) rather than a fixed constant:

- **"nothing"**: `reportedLen` itself falls in the window (bare placeholder, body entirely lost).
- **"current+placeholder" (harmless)**: `reportedLen - intendedLen` falls in the window (the correct body arrived, plus a stray placeholder tag).
- **"stale+placeholder" (lossy duplicate)**: `reportedLen - w` falls in the window for some **older** recorded write `w` in that session's own history (a past body replayed, plus the placeholder).

Script: `analyze-arithmetic-signature.mjs` (session scratchpad, same shape as `analyze-mismatch.mjs`).

### Result

```
Total [prompt-mismatch] events analyzed: 350
Placeholder-length window used: [15, 50] chars (NOT a fixed 27 — a numeric-shape test only, no raw placeholder text available in this log form)
Shape "nothing" (reportedLen itself placeholder-sized, i.e. body entirely lost): 12
Shape "current+placeholder" (harmless — reportedLen - intendedLen in placeholder window): 76
Shape "stale+placeholder" (reportedLen - an OLDER recorded write in placeholder window): 17
Does NOT fit any of the three shapes under this window: 245
```

105/350 (30%) fit one of the three shapes; 245/350 (70%) do not (see "Limits" below for what that 70% plausibly is instead — this is not evidence the model is wrong, the model was never claimed to cover every mismatch class).

**This independently reproduces the manager's own three cited specimens, verbatim, by session and line:** session `cb2a6c14` — `daemon-output.log:61390` (`reportedLen=27, intendedLen=4231`, "nothing" — row 1 of the manager's table), `daemon-output.log:61413` (`reportedLen=4258, intendedLen=4837`, delta from the OLDER write of 4231 is 27 — "stale+placeholder" — row 2), `daemon-output.log:63204` (`reportedLen=291, intendedLen=264`, delta 27 — "current+placeholder" — row 3). Same session, same three outcomes, same 27-char placeholder, found independently by a length-shape scan rather than hand-derivation.

**The "harmless" shape is the dominant one, exactly as the model predicts:** 76/105 (72%) of every fitting specimen, more than 4x the visibly-lossy "nothing"+"stale" count combined (29/105, 28%). And the deltas driving that bucket are tightly clustered, not scattered: overwhelmingly 26, 27, or 28 (matching the two independently-observed real placeholder lengths), with a smaller set at 12, 16, 18, 24, 30, 36, 42 — plausible for other paste-line-count digit widths, not random noise (full per-event deltas are in the script's output, reproducible against the same log files). **This is real, structural support for "the true incidence is higher than the count of noticed failures"**: for every visible loss, roughly 4-6 more events carry the identical arithmetic signature with no visible symptom at all.

### Limits — named per the standing verification posture, not glossed over

- **I do not have the raw placeholder text**, only lengths. A recurring 27-char delta across dozens of distinct, unrelated sessions is strong circumstantial evidence (a coincidence this consistent, this often, independently, would itself need explaining) but it is not the same as reading `[Pasted text #N +M lines]` in the actual transcript. I did not go further and pull raw pty output for a hand-verified subset — flagging that as the next cheap step if this model needs to move from "consistent with" to "confirmed," not a gap I'm asserting away.
- **The 245 (70%) "no-fit" population is not evidence against the model** — it was never claimed to cover every `[prompt-mismatch]`. The code's own four original predictions (silence/absent-field/benign-normalization/mid-string-splice) plus the separate `[composer-accumulation]` detector already account for other, non-placeholder mismatch shapes (e.g. several of my earlier DoD-6 raw rows show `reportedLen` far EXCEEDING `intendedLen` by thousands of characters — a composer-accumulation shape, not a placeholder one). I did not attempt to partition the 245 into those other named classes; I only checked whether they fit *this* model, and most don't, which is the expected/correct outcome for a model that was never claimed to be universal.
- **Per the manager's own caution, and per my own DoD-3 discipline:** a fitting delta is evidence the *arithmetic* holds, not proof of what the engine actually executed — the interpretation stays contested per pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`. I'm reporting a numeric pattern, not asserting a verified causal mechanism.
- **The manager's own 163/162 (1-char delta) caution is correctly excluded by this method already**: my window floor is 15, so any 1-5 char delta falls straight into "no-fit," matching the manager's own read that it's a different shape (not this model's population), not a failed fit of this one.
- **Single-placeholder assumption (relayed after this scan was already run — see the correction at the top of this addendum):** this scan tests for exactly one placeholder-sized delta. The manager's fourth peer specimen shows a real event with TWO co-occurring placeholders (53 combined) and BOTH shape-1-loss and shape-2-replay in the same event — a shape this scan's single-delta test cannot detect or classify. My 105-count is therefore a **floor**, not a ceiling: some of the 245 "no-fit" events could be genuine multi-placeholder or co-occurring-shape instances that a single-delta test structurally cannot see. I did not re-run a multi-placeholder-aware version of this scan (out of scope for what was asked — "hunt the arithmetic signature," not "build a complete classifier" — but naming the gap so it isn't mistaken for a completed census).
- **Recovery-notice counts are a biased denominator in BOTH directions, per the manager's separate correction, and this scan avoids that trap by construction but is worth stating explicitly:** a `[loom:paste-recovery]`/similar recovery notice firing is not evidence of real loss (the manager reports one firing for content that had arrived completely intact), and a benign placeholder+correct-body event produces no visible symptom at all (undercounting the other direction). Every count in this addendum is a count of `[prompt-mismatch]` **log events matching a numeric shape**, never a count of recovery notices or of "messages actually confirmed lost" — I did not use recovery-notice firings as a proxy for loss anywhere in this scan, so this correction doesn't invalidate the counts above, but it does mean nobody should read "105 fitting events" as "105 confirmed real losses/duplicates" — it's "105 events whose numbers are consistent with the shape," which is exactly the qualifier DoD-3's own discipline (hash/arithmetic equality ≠ proof of what was actually submitted) already requires me to carry.

### How this bears on DoD-1/DoD-6

This does not change the DoD-1 verdict (still NOT foreclosed — this addendum is corroborating context for reachability, not a new mechanism proof; per the card's own repeated warning, "same family" placeholder-arithmetic evidence is adjacent to, not identical to, the cross-generation confirming-hook attribution failure the give-up/re-mint code paths above demonstrate directly). It does **strengthen** the DoD-6 answer: the "harmless" shape being 2.5x the size of the two visibly-bad shapes combined is itself a concrete, corpus-derived argument for why the general "every occurrence replays the immediately preceding submission" claim is easy to under-measure from visible failures alone — most of the population that would count as "replayed" never produces a symptom, so a sweep built only from noticed mismatches (like this card's own original evidence) structurally undercounts it. This is exactly the manager's point, now with a number attached: 76 harmless + 17 lossy-stale = 93 replay-shaped events found by this scan, against the 15 the code's own hash-verified SUBSTITUTION-SIGNATURE sweep counted — consistent with "the true incidence is higher than the count of noticed failures," though the two counts use different instruments (length-shape vs. hash-verified) and are not directly comparable as a ratio, and (per the bullet above) 105/93 is itself a floor, not a final count.
