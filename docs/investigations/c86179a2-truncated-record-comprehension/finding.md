# Does a truncated decision-record fragment mislead an agent more than no record at all? (card c86179a2)

## Bottom line

In 18 independent single-turn trials (two experimental designs, 3 arms x 3 trials each), zero agents violated the prohibition carried by the tested decision record, in every arm — truncated, complete, or absent. This is a **null result on this specific instrument**, not evidence that truncation is harmless in general. A design flaw found and fixed mid-investigation, and a residual confound found but not fixable within this investigation's scope, both point the same direction: the test question was answerable by generic epistemic caution ("don't affirm an unsupported parity claim") without needing the record's specific content at all. See "What this does NOT establish" below before drawing any conclusion from the raw numbers.

## What is established (from the card, not re-verified here)

Measured 2026-09-09 over 1,754 engine transcripts / 15,006 `Read` calls on Loom paths: 99.6% of reads on comment-heavy files are ranged (median window 50 lines); 76.6% of windows intersect a long (>=11-line) comment block; of 6,931 block/window intersections, 42.1% were truncated (median 44% of the block visible). This investigation does not re-measure any of that — it starts from "windows this size, on blocks this shape, are common" and asks whether a fragment of that shape changes agent behavior.

## The region and the mechanical selection method

**File:** `packages/daemon/src/orchestration/gate-semaphore.ts` (not touched by this investigation — read-only).

**The block:** the file's top-of-file class-level `/** ... */` doc comment, lines 1-103 (103 lines — a real comment block well over the >=11-line threshold used in the measurement, and over double the median 50-line read window).

**Mechanical anchor:** `grep -n "PER-REPO MERGE ADMISSION" gate-semaphore.ts` — a phrase a real investigator asking "does the merge-race guard cover reuse/gateless merges" would plausibly search for. Single hit, line 49.

**Arm 1 (truncated):** `sed -n '49,98p'` — i.e. a `Read(offset=49, limit=50)` starting exactly at the grep hit, the simplest and most common grep-then-read pattern (read forward from the match, no back-context). This is a real 50-line window, not hand-picked for content — it happens to include the full "PER-REPO MERGE ADMISSION" claim, the full "SCOPE, MADE EXPLICIT" / "THIS IS DELIBERATE" explanation, and the "WHAT ACTUALLY PROTECTS" paragraph, but cuts off 5 lines before the block's true end (line 103), removing only the final "RESIDUAL EXPOSURE" bullet for the REUSE path ("REUSE: has no such conditional escape — it's a live gap under every configuration... not asserted-low severity").

**Arm 2 (complete):** `sed -n '49,103p'` — the same starting point, uncut to the block's real end. Same content as arm 1 plus the missing REUSE bullet.

**Arm 3 (no record):** no reference material supplied at all.

Exact extraction commands and their output are reproduced in `prompts-v1.md` and `prompts-v2.md` in this directory (verbatim `sed` output, not retyped).

## The prohibition being tested

The full record (arm 2) states, verbatim: *"RESIDUAL EXPOSURE, PRECISELY SCOPED — do not round either of these up or down"* — followed by a bullet showing GATELESS is conditionally safe (unreachable given this project's actual configuration, but not a general guarantee) and a bullet showing REUSE is NOT conditionally safe (a live gap under every configuration, merely unobserved so far). The **arm-1 truncation removes exactly the REUSE bullet** — the one that says REUSE does *not* get the same conditional pass GATELESS gets.

The violation being measured: an agent that reads the (truncated or complete or absent) record and then agrees that REUSE-path and GATELESS merges "carry the same residual race risk" / can be "deprioritized equally for the same reason" has rounded the two together — the exact thing the record prohibits.

## Design 1 (v1) — task and result

Scenario + two yes/no questions (Q1: is the teammate's parity claim correct; Q2: is it safe to exclude REUSE-path merges from monitoring on the grounds that they behave like gateless merges). Full prompt text: `prompts-v1.md`.

Result: **9/9 non-violating** (all three arms, 3 trials each, all answered "NO" to both questions with correct differentiating reasoning — including all 3 arm-3/no-record trials).

**Design flaw found:** the shared scenario paragraph (identical across all three arms, by construction, to keep the task "identical except for what record they receive") itself explained *how* each path is excluded ("skips re-running the gate" vs. "no gate command configured"). That description alone was enough for a careful reasoner to derive the correct asymmetry without ever seeing the reference material — which is exactly what the arm-3 (zero-information) trials did, using the mechanism description in the *shared* preamble rather than anything arm-specific. This makes the design-1 null result uninformative on its own: it cannot distinguish "truncation doesn't matter" from "the test leaked the answer to every arm equally."

## Design 2 (v2) — corrected task and result

Rewrote the shared scenario to name the two excluded categories without explaining *how or why* either is excluded, and added an explicit "INSUFFICIENT INFORMATION" answer option so a genuinely uninformed agent has a non-violating way to decline rather than being forced into a directional guess. Full prompt text: `prompts-v2.md`.

Result: **9/9 non-violating** again (all three arms, 3 trials each, all answered "NO"; none used the INSUFFICIENT INFORMATION option).

Reading the arm-3 (zero-information) v2 transcripts: all three declined the parity claim on a purely structural/logical basis — "both being excluded from the same guard tells you they're unprotected by it, not that they carry equal risk; that's an unsupported inference regardless of what either mechanism actually is." This is a valid, generic epistemic move that requires no fact about REUSE or GATELESS specifically. It means even the leak-scrubbed v2 design still let agents reach the correct answer without the reference material, via general skepticism toward under-supported analogies rather than via specific knowledge from the record.

## Combined result, stated as a falsifiable claim

Across both designs, 18/18 trials (6/6 in arm 1, 6/6 in arm 2, 6/6 in arm 3) did not violate the record's prohibition. **In this specific instance** — this record, this truncation window, this task framing, evaluated with n=3 per arm per design — no difference in violation rate was detected between the truncated, complete, and absent conditions. This is an existence-level statement about 18 observed trials, not a measured frequency: with n=3 per arm, a true violation rate as high as roughly 1-in-3 to 1-in-2 per arm would still plausibly show 0/3 by chance, so this result cannot rule out a real but moderate truncation effect — it can only say none was visible at this n.

## What this does NOT establish

- It does **not** show truncation is harmless in general, or even for this specific record under a different task framing.
- It does **not** show the sibling injection-improvement work (card 661b7d46) is unnecessary — this investigation found no signal either way on the "does arm 1 land between arm 3 and arm 2, or below arm 3" question the card asked, because no arm separated from any other.
- It does **not** test the actual failure mode the delivery measurement is about: a coding agent mid-task, under real tool access, encountering a truncated block *incidentally* while reading for some other reason, and then *acting* on the incomplete guidance (writing code, making a design call) without being asked to evaluate someone else's claim. All 18 trials here were single-turn, closed-book, evaluate-a-claim tasks — a format that invites default skepticism toward analogical reasoning ("both excluded therefore equal" is a recognizable non-sequitur shape on its face) rather than requiring the agent to construct and act on a positive belief from the fragment. A task that instead asks the agent to *write* the monitoring rule from scratch, forcing it to decide unprompted what to include, was not tried and is a more direct test of the card's hypothesis.
- It does **not** test any other decision record, truncation window, or code region — only the one PER-REPO MERGE ADMISSION section, at one grep-anchored offset, in one file.
- It does **not** use real Read-tool mechanics (line-numbered `cat -n` output, surrounding code, a live coding task) — the reference material was pasted as plain text into an isolated reasoning prompt, which is a weaker approximation of the original 1,754-transcript delivery measurement's actual conditions (a real agent reading a real file for a real reason) than a live-task reproduction would be.
- It does **not** rule out that a *harder-to-verbally-refute* version of the false-parity claim (one that doesn't read as an obvious non-sequitur on its face) would separate the arms — the teammate's claim used here was refutable by structure alone, which may have made the test too easy across every arm including the control.

## Recommendation

If this question is still worth answering with better power, the next attempt should change the task shape, not just add more trials at this n: give the agent an affirmative task (produce an artifact, not evaluate a claim) where the correct output is directly gated on retaining the specific fact the truncation removes, and where declining to act is not a readily-available safe default the way "I won't agree with your under-supported analogy" was here.
