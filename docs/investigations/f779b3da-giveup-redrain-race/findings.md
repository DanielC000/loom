# f779b3da — the give-up-recovery / re-drain race: mechanism found for both specimens, from the still-live daemon log

## Verdict, up front

**The mechanism is now established for BOTH preserved specimens, not merely co-located.** The daemon's live `~/.loom/logs/daemon-output.log` still held the full generation-by-generation `[submit]`/`[submit-write]`/`[prompt-echo]`/`[prompt-mismatch]` trace for both sessions at investigation time (it had not yet rotated past either window) — a much richer record than either card body's own excerpted lines. Reconstructing generation-by-generation against that raw trace, every byte of both specimens' reported content is accounted for by known, already-existing code paths acting in combination — no new code needed to explain what happened, though the combination itself was not previously named.

**The `b9b8f8db` "retry the Enter only, not re-pasting the body" path is CONFIRMED — directly, by the log line itself, not inferred — as the path that fired for the generation whose report mismatched, in BOTH specimens** (`daf64e68` gen=10, `fb924e0a` gen=4). This directly answers the card's own "concrete place to start" question: yes, in both cases.

**But the Enter-only path is not itself sufficient to explain the reported bytes — it is a necessary ingredient, not the mechanism.** Because it writes zero new paste bytes (verified by reading `pty/host.ts:7676-7685` — the only bytes it sends are a zero-length bracket-paste pair, then Enter), whatever the engine reports for that generation must have already been sitting in the composer. What put it there, and why it wasn't cleared, is a **second, distinct, already-existing code path**: the "defensive clear-then-repaste" branch (`pty/host.ts:7686-7707`) that runs for the generation immediately *before* an Enter-only retry, whenever composerDirtyLen is already nonzero. That branch's own backspace-then-paste is not verified to have landed — a risk the file's own comments (card `3ce3fa39`, `2960c3bf`) already document at length, independently, without ever connecting it to `b9b8f8db`'s own core assumption ("the composer still holds this message's own content").

**The connection between those two already-documented, independently-reasoned mechanisms is the actual finding of this card:**

> `b9b8f8db`'s assumption — "the composer still holds THIS message's own physical write" — is invalidated the instant an *intervening* generation's own clear-then-repaste (`3ce3fa39`'s territory) fails to actually erase the terminal. Neither mechanism's own code or comments check the other's precondition. When the clear silently fails, the composer ends up holding **two different messages' content, concatenated in write order** — and an Enter-only retry of *either* message blindly resubmits whatever that concatenation currently is, with no way to detect the mismatch.

This also **retires the "40-char wrapper vanishes" framing** this investigation opened with (inherited from `c23e2869`'s DoD-1 arithmetic) as an open mystery *for these two specimens specifically*. It isn't that a wrapper mysteriously disappears from an otherwise-successful paste. It's that the *trailing* fragment in each specimen is a **different message's own first-ever physical attempt** — and a first attempt is never wrapped (the `[loom:possible-duplicate root:…]` tag is only added by `joinSubmittedText` on a *second* attempt, once `giveUpGen` is set). The "40 fewer characters than intended" pattern falls out for free once you know the trailing bytes are that message's *pristine* text, not its *current, wrapped* intended value. `c23e2869`'s own DoD-1 arithmetic (the clean 494db005/f6eeeb52 specimens, `divergesAtChar=0`, no foreign fusion) is a **separate, real phenomenon** — this note does not retract that finding, only narrows what it explains: not these two co-located specimens.

## Files changed

- This directory (new): `findings.md` + three preserved raw log specimens. No production code changed — the DoD explicitly allows closing with zero production changes, and a fix belongs on a separate card once the owner decides what "correct" should mean here (see "Open question, deliberately not answered" below).

## The evidence base, and why it's stronger than the card bodies alone

`c23e2869`'s and this card's own bodies quote a handful of already-extracted log lines. The **full** per-session trace was still live in `~/.loom/logs/daemon-output.log` at the time I worked this card (it had not yet rotated past either session's window — both are many hours old but the file is large and rotation is by size, not age). I extracted every `[submit]`/`[submit-write]`/`[prompt-echo]`/`[prompt-mismatch]`/`[heal]`/`GIVE-UP` line for each session id, in file order (= chronological order, since it's an append-only tee), plus one raw, unfiltered 37-line window around the critical `daf64e68` gen9→gen10 transition (needed because two *different* logical messages — root `c3cc651c` and root `ca3bf8ef` — turned out to be interleaved there, and the filtered trace alone doesn't show that; the raw window does, in an unrelated session's own interleaved lines).

Preserved verbatim, per this card's own inherited constraint (console-only, perishable):
- `specimen1-daf64e68-full-trace.txt` — full lifetime trace, session `daf64e68-9fd0-4ede-b7f3-bb34766d3d59`.
- `specimen2-fb924e0a-full-trace.txt` — full lifetime trace, session `fb924e0a-7d93-4a4e-86e7-2b000fbb0893`.
- `specimen1-daf64e68-gen9-10-interleaved-raw.txt` — the raw window that disambiguates the two roots.

Every generation number, byte count, and hash cited below is quoted directly from these files — I did not re-derive or estimate any of them.

## Specimen 2 (`fb924e0a`, gen=4, reportedLen=444) — full reconstruction

| gen | message | action | result |
|---|---|---|---|
| 1 | deploy-stale notice (root `ca4a43b7`), 42042 raw chars — the **paste body**; the same notice is recorded elsewhere as **42082**, the **wrapped write** (reconciled immediately below the table) | fresh paste (`reason=kickoff-guarantee`) | 4 Enter attempts fail → **GIVE-UP RECOVERY** (real, not suppressed) → requeued, `giveUpGen=1`, held 20s |
| 2 | `b889f8d7` (the `[loom:prompt-mismatch-unresolved]` notice), 444 raw chars | composerDirtyLen=42042>0 → **clear+repaste branch** (`host.ts:7686-7707`): backspace 42042, paste fresh 444 | 4 Enter attempts fail, but engine output *is* observed after the last one → **GIVE-UP SUPPRESSED** (`host.ts:7926-7947`) — busy left `true`, composerDirtyLen marked defensively: `42042+444=42486` |
| 3 (out-of-band) | — | `healIfStuck` (`host.ts:7217-7263`) fires ~45s later: busy still stuck, `enterConfirmed` still false → bumps `submitGeneration` to 3 with **no submit() call**, restores `live.giveUpOrigin` (still `b889f8d7`, unchanged since gen2) via `requeueGiveUpOrigin(gen=2)` | `b889f8d7` **only now** gets `giveUpGen=2` stamped and is unshifted onto `pending`, held 20s from this instant — gen1's original message's own 20s hold had *already expired* by this point |
| 4 | gen1's original message (redelivery, `giveUpGen=1`) | `pending` order: `[b889f8d7 (just-unshifted, HELD), gen1-original (hold long expired)]` → `drainPending`'s `startIdx` **skips the held head and picks gen1's message instead** → `isGiveUpRedelivery=true`, composerDirtyLen=42486>0 → **Enter-only** (`host.ts:7676-7685`, log line verbatim: *"redelivering an already-attempted message (composer possibly dirty, 42486 chars) — retrying the Enter only, not re-pasting the body (card b9b8f8db)"*) | **pastes nothing.** Whatever's really in the composer gets Entered. |

### Gen1's notice carries two byte counts — `42042` and `42082` — and neither is wrong

They are two instruments measuring two genuinely different quantities, and they should *not* be expected to match:

```
42042  (Loom's daemon log — the PASTE BODY)
  + 40  (the wrapper "[loom:possible-duplicate root:ca4a43b7] ")
= 42082  (the WRAPPED WRITE — gen4's redelivery, and the figure the peer's harness notice carries)
```

Both figures sit in the preserved trace. In `specimen2-fb924e0a-full-trace.txt`, the `33750:` line logs `len=42042` for gen1's fresh paste; the `33881:` line logs `len=42082` for gen4's redelivery, and its own `head=` shows the 40-character wrapper `[loom:possible-duplicate root:ca4a43b7] ` prepended to the identical body. The wrapper is added by `joinSubmittedText` only on a *second* attempt, once `giveUpGen` is set — the same mechanism that explains specimen 1's trailing fragment being unwrapped. The peer additionally reports that this wrapper's `root:` id is byte-identical to the `msgId` in their own notice for the same message, an independent join on a field neither side chose for the purpose; that is their reading, not one checkable from Loom's own artifacts.

**A 40-byte gap you can attribute and a 40-byte gap you cannot are the same number and opposite epistemic objects.** An unexplained exact agreement — or an exact-N gap — is not corroboration; it is a coincidence pending explanation, and it is *more* dangerous than a rough one, because exactness feels like confirmation. This gap was in fact waved through as "probably the wrapper, so it corroborates" before anyone had attributed it. The repair is a named producer for each number, which is what the arithmetic above supplies.

**What's actually in the composer at gen4's Enter:** gen2's own clear+repaste (backspace 42042, paste 444) is not shown to have failed here — and the observed result proves it *succeeded*: the reported content is **444 chars, byte-for-byte `b889f8d7`'s own content**, matching `logicalId=b889f8d7`'s independent content-match confirmation (`purgeConfirmedGiveUpRequeue`, `host.ts:8529-8591`) that fires two log lines later: *"CONFIRMED logicalId=b889f8d7-... latencyMs=49734 (content-matched...)"*. Gen1's own 42042-char stray was genuinely erased by gen2's backspace; gen3 and gen4 never touch the composer again (out-of-band bump and Enter-only respectively); so what gen4's blind Enter submits is exactly what gen2 left behind. **No fusion in this specimen — a clean substitution**, because the intervening clear happened to work.

### Gen1's notice was never delivered — and the cost of that is unknowable

**The 42042-char `[loom:deploy-stale]` notice erased by gen2's backspace is an established, permanent loss.** The reconstruction above, on its own, only shows the notice was gone from the composer by gen4 — which is still consistent with some later generation carrying it. Two further readings close that, both preserved in `specimen2-fb924e0a-full-trace.txt`:

- The `33892:` line — gen=4's `[loom:prompt-mismatch]`: `intendedLen=42082` against `reportedLen=444`, `writtenHash=5a2d3b33` / `reportedHash=40ac358a`, `divergesAtChar=7`, `reportedAround="[loom:prompt-mismatch-unresolved] an earlier [l"`. The engine reported gen2's content — a replay of the immediately-preceding generation, which is this note's own reconstruction observed by a second instrument. The peer independently reported these same figures from their own end.
- The `34128:` line — the later `[loom:prompt-mismatch-unresolved]` for gen=4: *"no confirming later generation resolved this within 600000ms; treating as an established loss and failing loud (card `f9b1ea00`)."* ⚠️ **Read at the claim, not in a footnote: this is a bounded-window determination made by the mechanism itself, not an observation that the notice was never delivered.** It is what upgrades the loss from *unobserved* to *permanent*, and it is strong — but it is not proof. (Separately checkable and consistent with it: the string `deploy-stale` occurs exactly twice in the session's whole lifetime trace — gen1's paste and gen4's redelivery — and never after.)

⚠️ **Do not count these as three independent parties agreeing.** Loom's daemon log and the peer's report may well be the same instrument read twice. The arithmetic and the hashes are checkable; the independence is not, and an unaudited "they confirmed it too" is exactly how a claim acquires credibility it has not earned.

**The cost of this loss is UNDETERMINED, and not merely unknown — it is UNKNOWABLE. The only artifact that could price a lost notice is the notice's own body, and that is precisely what was lost. The loss destroys the evidence required to measure the loss; it is self-sealing.**

**A real 22-day-stale deploy did exist in that project at that time. Its TYPE (`[loom:deploy-stale]`) was read from a ~60-char head; its SUBJECT was never read and is now unrecoverable. The two facts have never been connected and both parties have declined to connect them.**

Both directions out of that are unsupported, and this note refuses both — so the next reader inherits the refusal instead of re-deriving the temptation:

- **Not "this failure class has now cost something real."** That asserts a causal chain between the lost notice and the stale deploy which nobody has established, and which the party best placed to assert it explicitly declined to assert. A further reading confirming the *loss* licenses no claim whatever about its *effect*.
- **Not "it cost nothing" / "no impact" / "harmless".** Equally unsupported — and the easier of the two mistakes to make while trying to be conservative.

**This is the strongest thing this note has to say about why the defect matters, and it needs no causal link at all: a failure whose damage cannot be priced after the fact must be PREVENTED rather than MONITORED.** That is the case for the fix card `4796f999`, and it rests only on what is actually in evidence here.

## Specimen 1 (`daf64e68`, gen=10, reportedLen=11349) — full reconstruction

| gen | message | action | result |
|---|---|---|---|
| 5 | `dc766a0e`, 3917 raw chars | clear+repaste (backspacing gen4's own 9669-char stray, a different message not detailed here) | fails; **CONFIRMED late** (`latencyMs=26401`, i.e. ~26s after its own give-up) via content-match — this resets composerDirtyLen to 0 (`clearComposerDirtyOnConfirm`, `host.ts:8519-8527`), but **only because `composerDirtyMarkedForGen` happened to still equal 5** — see "Incidental finding" below |
| 7 | `1e105434` (root `c3cc651c`, a relayed `[loom:worker-report] worker 19e…`), fresh cross-remint, 9709 chars **with its wrapper already baked into `.text` at mint time** | composerDirtyLen=0 at this point (just reset) → **plain paste branch** (`host.ts:7708-7713`, no backspace at all) | 4 Enter attempts fail → GIVE-UP RECOVERY → composerDirtyLen marked: `0+9709=9709`, `giveUpGen=7` set, requeued, held 20s |
| 8 | `ca3bf8ef` (the `[loom:prompt-mismatch] Loom wrote 9709 chars for this turn (gen=6…)` notice — Loom's own self-generated notice about a *different*, gen=6 mismatch), fresh, 1640 raw chars | composerDirtyLen=9709>0 → **clear+repaste branch**: backspace 9709 (meant to erase gen7's stray), paste fresh 1640 | 4 Enter attempts fail → GIVE-UP RECOVERY → composerDirtyLen marked: `9709+1640=11349`, `giveUpGen=8` set, requeued, held 20s |
| 9 | `1e105434` redelivery (`giveUpGen=7` now set) | `pending`: `[ca3bf8ef (just-unshifted, HELD), 1e105434 (hold expired)]` → skips held head, picks `1e105434` → composerDirtyLen=11349>0, `isGiveUpRedelivery=true` → **Enter-only** (the log fires the *identical* "composer possibly dirty, 11349 chars" line, timestamp `1787797067811`, 337ms before gen9's own first Enter attempt — confirming composerDirtyLen was already at its final 11349 value before gen9 even ran, i.e. gen9 itself adds nothing) | pastes nothing; fails; **exhausts** its requeue budget (limit 1) — `onGiveUpExhausted` fires |
| 10 | `ca3bf8ef` redelivery (`giveUpGen=8` now set) | composerDirtyLen=11349>0, `isGiveUpRedelivery=true` → **Enter-only** (log line verbatim: *"redelivering an already-attempted message (composer possibly dirty, 11349 chars) — retrying the Enter only..."*) | pastes nothing; fails; exhausts |

**What's actually in the composer at gen10's Enter:** gen8's own backspace (meant to erase gen7's 9709-char stray, `[loom:possible-duplicate root:c3cc651c] [loom:worker-report] worker 19e…`) is **not** shown to have succeeded — and here the observed result proves the opposite of specimen 2: the reported content is **11349 bytes = 9709 (gen7's full, unaltered content) + 1640 (ca3bf8ef's own pristine, UNWRAPPED text), concatenated in exactly that order — gen7's stray first, gen8's fresh paste appended after it, never replacing it.**

This is independently confirmed three ways, all already present in the card body / preserved log, now correctly attributed:
1. `matchedLen=9709 recognizedGen=9` — the mismatch detector's own substring check recognizes the *leading* 9709 bytes as an exact match for generation 9's recorded write (which is `1e105434`'s content — the SAME bytes as gen7's, since gen9 never re-pasted anything).
2. `divergesAtChar=31`, `reportedAround="ble-duplicate root:c3cc651c] [loom:worker-report] worker 19e"` — the raw byte-for-byte comparison shows the reported string, at the exact point gen10's own intended text would say `root:ca3bf8ef`, instead continues with `root:c3cc651c` — i.e. it's still inside gen7's stranded content, 31 characters in.
3. `trailingRemainder="[loom:prompt-mismatch] Loom wrote 9709 chars for this turn (gen=6, written at 20…"` — exactly `ca3bf8ef`'s own pristine (unwrapped) text, matching gen8's own first-and-only physical paste attempt.

`9709 + 1640 = 11349` is not a coincidence of bookkeeping arithmetic lining up with reality — in this specimen the bookkeeping (`composerDirtyLen`) and the real terminal content happen to agree, because **neither** of the two contributing generations (7, 8) was ever actually cleared. In specimen 2, the bookkeeping total (42486) and the real terminal content (444) **disagree**, because the intervening clear (gen2's) *did* work. `composerDirtyLen`'s own documentation is explicit that it "never reads back real terminal content" — both specimens together are a clean demonstration of exactly that gap, in both directions.

## Incidental finding: `composerDirtyMarkedForGen` is a single scalar tracking an additive total

`composerDirtyLen` accumulates **additively** across multiple distinct unconfirmed generations, by design (its own doc: "a second unresolved give-up on top of an already-dirty composer must not lose track of the first"). But the field that gates *both* the increment-guard *and* the reset — `composerDirtyMarkedForGen: number | null` (`host.ts:2442-2450`) — is a **single scalar**, overwritten by whichever generation contributed *most recently*. `clearComposerDirtyOnConfirm` (`host.ts:8519-8527`) resets the *entire* `composerDirtyLen` total to 0 whenever `composerDirtyMarkedForGen === <the confirmed gen>` — with no way to distinguish "the whole total is now resolved" from "only the most recent contributor is resolved; earlier stacked contributions are still live."

This is exactly what happened in specimen 1's own gen4→gen5 sequence (not detailed in the table above, but present in the preserved trace): gen4's own 9669-char contribution and gen5's own 3917-char contribution both stacked into `composerDirtyLen` (13586), then gen5 alone got confirmed — and the confirm reset the *entire* 13586 to 0, silently discarding gen4's own still-genuinely-unresolved 9669 chars along with it. This did not turn out to matter for explaining gen10's final byte count (the reset happened before gen7/gen8's own accumulation, which is the part that actually explains `11349`), so I am not claiming it is *the* mechanism — but it is a real, separately-reportable gap in the same neighborhood, worth a card of its own if the owner wants it chased (I did not open one — out of this card's own scope, which is diagnosis, not a fix).

## What this does and doesn't establish

- **Established, from the raw log, not inferred:** both specimens' mismatched generation took the `b9b8f8db` Enter-only path. Both specimens' *other* fragment came from an immediately-preceding generation's own clear-then-repaste attempt, whose backspace success/failure is not directly observable in the log — only inferable from whether the *later* reported content still contains the *earlier* generation's bytes.
- **Established, by exact arithmetic on preserved, quoted figures:** `9709+1640=11349` (specimen 1, backspace failed — fusion) and `42042` cleanly replaced by `444` (specimen 2, backspace succeeded — clean substitution, confirmed independently via content-match). Specimen 2's notice appears in the record under two byte counts, and the gap between them is arithmetic rather than a discrepancy: `42042 + 40 = 42082` — the paste body plus the 40-character `[loom:possible-duplicate root:ca4a43b7] ` wrapper carried by gen4's redelivery, two instruments measuring different quantities (see "Gen1's notice carries two byte counts" above). **That reconciliation is specimen 2's alone — do not apply the +40 anywhere else.** `9709+1640=11349` needs no wrapper term: the 1640-char trailing fragment there is explicitly a first-ever, *unwrapped* attempt, and the 9709 already has its own wrapper baked in at mint time.
- **Established, with its limit stated at the claim:** specimen 2's gen1 `[loom:deploy-stale]` notice was permanently lost — never delivered in any generation. The gen=4 `[loom:prompt-mismatch]` is a direct log reading; the `[loom:prompt-mismatch-unresolved]` that makes the loss *permanent* is a bounded-window determination by the mechanism itself rather than an observation — strong, not proof, and not to be counted as an independent third party (see "Gen1's notice was never delivered" above).
- **NOT established, and unknowable rather than merely unmeasured:** what this loss cost. This note asserts neither a consequence nor its absence — the only artifact that could price a lost notice is the notice's own body, which is what was lost.
- **NOT established:** *why* the backspace succeeds sometimes and not others. That is exactly `3ce3fa39`'s own open question ("a live experiment is needed to discriminate" between the burst-misinterpreted-as-paste and engine-stopped-reading candidates) — this card does not add new evidence on that sub-question, and I did not attempt to (out of scope: this card is about the give-up-recovery/re-drain race, not the backspace-clear reliability question, which already has its own card history).
- **NOT established:** whether this exact combination (Enter-only riding on top of an unverified prior clear) is *common* — I have two specimens, both now fully explained by the same combination, which is stronger than "co-located" but is still n=2. I did not run a corpus-wide sweep for this specific signature (composerDirtyLen at an Enter-only retry log line matching, or nearly matching, the eventual reportedLen) — that would be the natural next step if the owner wants an incidence estimate, and I flag it rather than claim it.

## Open question, deliberately not answered here (diagnosis, not a fix)

Given the mechanism above, the actual defect is `b9b8f8db`'s own assumption having no way to verify itself: an Enter-only retry has no signal that tells it "the composer no longer holds what I think it holds" versus "it still does." Candidate directions (not evaluated, not recommended — this card's DoD is diagnosis):
- Make the clear-then-repaste branch's success *observable* somehow (echo verification, a readback) before a *later* Enter-only retry is allowed to trust it.
- Track *which* generation's content the composer is currently believed to hold (not just a dirty length), so an Enter-only retry can detect "the thing I'd be resubmitting isn't mine" and fall back to a full clear+repaste instead.
- Fix the `composerDirtyMarkedForGen` scalar-vs-additive mismatch identified above, independent of the main mechanism.

None of these are implemented here. Per the card's own explicit DoD, this is a complete, reportable outcome.

## Guards / tests

No `packages/daemon/test/*.mjs` file was added or changed by this card (a pure documentation/diagnosis deliverable), so `pnpm --filter @loom/daemon guards` and the MCP-surface test list in `CLAUDE.md` do not apply. `pnpm build` was not re-run since no source file changed.
