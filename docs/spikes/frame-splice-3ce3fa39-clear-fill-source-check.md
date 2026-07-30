# Frame-splice specimen #3 — clear-fill source check (card `3ce3fa39`)

Worker session, 2026-07-29, follow-up to the specimen #3 records check. No fix, no ConPTY harness. Card stays open.

## The question

Manager's prediction: `795883ce`'s report was written but never Enter-confirmed, so it sat stranded and unsubmitted in the composer; the give-up clear-fill ran but (if fixed-length) couldn't fully erase a message that long; `a6b659dc`'s report was then written into the same composer, landing at the cursor inside the stranded text; its Enter succeeded, submitting the combined composer as one turn. Testable prediction: **is the give-up clear-fill a fixed-length write, or derived from the actual stranded content's length?**

## Answer: length-derived, not fixed. The fixed-filler mechanism is refuted.

`packages/daemon/src/pty/host.ts:4647`:

```ts
this.writeChunked(sessionId, BACKSPACE.repeat(l2.lastPrompt.length), () => {
  this.setBusy(sessionId, false, "give-up-recovery-cleared");
  this.requeueGiveUpOrigin(sessionId, gen);
});
```

`BACKSPACE` (`host.ts:215`) is a single DEL byte, `"\x7f"`. `l2.lastPrompt` (`host.ts:4340`, `live.lastPrompt = text`) is the **exact same string object** originally submitted — its `.length` is the identical value logged as `len=` on the original `[submit-write]` line. The erase count is therefore always exactly as many single-byte DELs as the stranded content had characters, by construction — there is no code path where the filler is a fixed size.

**Positive control, from specimen #3's own records** (not from reading the code in isolation — cross-checked against two differently-sized real clears in the same window):

| message | original `len=` | clear-fill chunk total | match |
|---|---|---|---|
| `795883ce` (gen=9 clear) | 3917 | `1024+1024+1024+845 = 3917` | exact |
| `a6b659dc` (gen=10 clear) | 4438 | `1024+1024+1024+1024+342 = 4438` | exact |

Both differently-sized clears total exactly their original content's length — the mechanism that produced the false "REAL BUG" verdict in the prior report (identical `h=f77751c5` hash across both clears) is now explained precisely: `BACKSPACE.repeat(N)` is a single repeated byte, so any full 1024-byte chunk of it is content-identical regardless of which message it's clearing or how long that message was — a hash collision from repeated-byte chunking, not a fixed-size-filler bug. The clear-fill length tracks the original exactly in both observed cases.

**This specific mechanism is refuted.** A stranded composer of any length gets exactly enough backspaces to erase it, by the code as written.

## What the same source turned up instead — directly relevant, not what was asked

Reading the surrounding attempt loop (`sendEnterAndVerify` / `fireEnterAndVerify`, `host.ts:4491-4657`) to verify the clear-fill's trigger condition surfaced two things worth reporting, both from the code's own comments — not inferred, not tested against records here.

**1. Give-ups are documented and measured to be usually false negatives — and this is card `04de8bbf`'s own finding, cited by name in this exact code path.**

```
Card 71de1f9c: most give-ups are FALSE NEGATIVES — the Enter genuinely registered and
a turn is running, only the confirming hook's round-trip is slow (observed under fleet
load: 79% of a measured sample of give-ups WERE followed by a UserPromptSubmit for the
same session).
...
Card 441499ee (hardening — card 04de8bbf measured ~86% of give-ups reaching THIS point
are followed by a confirming hook, i.e. the OUTPUT discriminator above just missed a
turn that actually started)
```

This means the manager's "confirmed false negative" finding for `795883ce`'s report is not a novel failure mode — it is a concrete, timestamped, records-and-recipient-corroborated instance of a class this exact subsystem's own authors already measured at 79–86% of give-ups. What specimen #3 adds to card `04de8bbf` is not the existence of the false-negative class (already known and quantified) but the first case caught with full write-layer records AND an independent recipient confirmation together in the same timestamped window — worth relaying to that card directly, independent of the splice question.

**2. An acknowledged, explicitly NOT-mitigated residual risk in the same clear path: if the re-assert-paste write itself silently drops, the backspace bytes get swallowed as paste content instead of erasing anything.**

The give-up clear only fires when `attempt > 1` (`host.ts:4636`), reasoning that this attempt's own re-assert-paste write (`host.ts:4495`, `BRACKET_PASTE_START + BRACKET_PASTE_END`, sent before every retry past the first) already closed any open paste bracket, so the backspace bytes will be read as literal erasing keystrokes rather than folded into an open paste. The comment block above it (`host.ts:4631-4635`) states plainly:

```
Residual risk even when attempt>1: that SAME re-assert write could itself also drop (a
second, independent ConPTY drop stacked on the original Enter drop) — not mitigated
further here; a paste-markers-then-Backspace sequence was outside the real-claude
probe's validated scope (only START+END+Enter was probed), so we don't stack another
unverified re-assert on top of the burst.
```

If that specific drop happened for `795883ce`'s gen=9 clear, the daemon's own `[pty-write]` log would look exactly like what was observed (a clean write attempted, chunked, hashed) — the log only proves the daemon called `pty.write()`, not that ConPTY/the terminal actually applied it as a paste-close. This is a plausible, code-acknowledged path to "the clear-fill was sent but didn't actually erase anything visible" that doesn't require positing a below-daemon byte replay — but it is **not verified against specimen #3's records**, because nothing in `daemon-output.log` can distinguish "written and applied" from "written and dropped" at that layer. Flagging it as a candidate the authors already anticipated, not a confirmed cause.

## What this does and does not change

- The manager's specific fixed-vs-derived prediction is refuted by source, cleanly, with a positive control from real records. Reported as instructed either way.
- The false-negative framing for `795883ce`'s "dropped for real" report is not new to the codebase — it's the documented, ~80%-measured norm for this exact give-up path (card `04de8bbf`), now with one confirmed, records-backed, recipient-corroborated instance.
- The composer-concatenation shape the manager described (stranded text + new text landing together in one submitted turn) remains a live, plausible hypothesis — just not via a fixed-length filler. The acknowledged re-assert-paste drop risk is a concrete, code-level candidate for how it could still happen with a correctly-sized clear-fill, but it is unverified here and verifying it would need instrumentation below the write() call — the same ceiling already hit for specimen #2.
- Still does not generalize to specimen #2 (no give-up cycling there at all). Not resolved, not assumed.
