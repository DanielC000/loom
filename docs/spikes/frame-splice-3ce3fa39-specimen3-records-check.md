# Frame-splice specimen #3 — records check (card `3ce3fa39`)

Worker session, 2026-07-29, follow-up to the corpus splice sweep (`frame-splice-3ce3fa39-corpus-sweep.md`). Specimen #3 landed live minutes after that sweep concluded: the manager's own progress report (this worker) was rendered spliced into worker `795883ce`'s `done` report, mid-word (`requeueGiveU` + [full report] + `pOrigin`). Full write-up: `~/.loom/workspaces/frame-splice-3ce3fa39-specimen3.md`.

This is analysis only. No fix, no ConPTY harness. Card stays open.

## Snapshot

Snapshotted `daemon-output.log` + `.1` immediately on task receipt (64,710→ now current live tail, ~8,516 lines in the fresh `daemon-output.log`). The recipient is manager session `062c9897-988d-4a52-bffb-098df1e54970`; host-frame sender `795883ce-8f16-42c3-922a-cc9445f93737` (task `ccb407eb`); injected-payload sender `a6b659dc-89bc-4a3b-84cc-6635d470cc58` (task `3ce3fa39`, this worker).

## Controls (both required by the kickoff, both run before trusting any verdict)

**Known-benign discriminator control** — the card's own worked example (session `8806b9fc`, 2026-07-23, `corpus1.log:10415/10461/10540`, `len=1024 h=a72da5ee`, `gen 33→35` with a `GIVE-UP RECOVERY: re-queued` line between):

```
Classified BENIGN: True (expect True)
```

PASS.

**Timestamp parser control** — a synthetic old-style line ending in a small bare number (a port, mimicking the card's `60848` warning) vs. a real corpus line with a genuine trailing epoch-ms:

```
probe (ends in bare "port 60848"):  ts=None stamped=False   (correctly rejected — magnitude gate)
probe (real trailing epoch-ms):     ts=1785317173031 stamped=True
```

PASS. Magnitude gate is `> 1.7e12`; anything else is `unstamped`, never `0`.

## Applying the discriminator to specimen #3's window

Grouped all `[pty-write] tag=chunk` records for session `062c9897` by `(len, hash)` and classified every cross-occurrence pair. Two false-positive classes surfaced on the first pass, both fixed before trusting the result:

1. **`gen=0 len=3 h=015b94f4`, repeated same-gen** — a fixed 3-byte sequence written immediately after every session's `spawn-startup-prompt`, confirmed identical across unrelated sessions (`062c9897`, `795883ce`, others). A new instance of the card's already-documented false-positive class #1 (fixed control sequences are byte-identical by construction) — noted, not folded into anything.
2. **`len=1024 h=f77751c5`, appearing across gen=9 and gen=10 with no requeue line between them** — on the raw discriminator this reads as the real-bug signature (`1f74080a`: different gen, no requeue between). It is not. `f77751c5` is the **give-up-recovery CLEAR-FILL chunk** — every "clearing the stranded give-up injection" write sends a fixed filler pattern chunked in ~1024-byte pieces, and that filler is identical regardless of which message is being cleared. Confirmed directly: `f77751c5` sits between `clearing the stranded give-up injection` and the following `-> false (give-up-recovery-cleared)` line for **both** 795883ce's clear (gen=9) and a6b659dc's clear (gen=10) — two unrelated messages, same filler bytes. Between those two clears sits a `dropped for real` line, not a `re-queued` line, so the requeue-line check didn't catch it either. Fixed by excluding chunk records structurally (by position inside a clearing-span), not by hash — hash is exactly what's misleading here. This is a fifth false-positive class, not one of the card's four, found live in this window; worth folding into the card's discriminator notes.

After excluding both noise sources, every **real content** duplicate in the window classifies cleanly:

| message | content | gen pair | verdict |
|---|---|---|---|
| `5671ceb6` report (len=612) | h=`3047e655` | 6→8 | BENIGN (requeue line 8359/8389 between) |
| `795883ce` report (len=3917, host frame) | h=`b4216734`/`98835b6c`/`36f204ec`/`f92939e7` | 7→9 | BENIGN (requeue line 8389 between) |
| `a6b659dc` report (len=4438, injected payload) | h=`9c6b6a4f`/`77c9e7cd`/`c8325c29`/`fb65a880`/`867bfde3` | 10→11 | BENIGN (requeue line 8475 between) |

**No `9ed20572` (daemon double-emit) and no `1f74080a` (one send, two deliveries) in the real content of either implicated message.** Same clean-records shape step 1 already established for specimen #2.

## The new fact the discriminator table doesn't cover

`795883ce`'s report — the **host frame** of the observed splice — was written twice (gen=7, gen=9), failed Enter-confirmation both times (4 attempts each, ~900ms apart, no engine output observed), and at gen=9 **exhausted its requeue budget and was dropped for real** (`[submit] ... message 090082fb-1687-4553-9119-f1d7cab09ca7 (3917 chars) exhausted its requeue budget (1) ... dropping for real`, line 8441, ts `1785317173018`). Per the write-layer records, **this message was never successfully confirmed or delivered again, anywhere in this snapshot.**

`a6b659dc`'s report — the **injected payload** — was written at gen=10 (also failed once), requeued, and at gen=11 got a genuine confirming `UserPromptSubmit` hook on the first Enter attempt (line 8490, ts `1785317209142`, 464ms after the Enter write) — a clean, real, one-shot success.

So: the content that appears as the *outer, framing* text in the rendered specimen is exactly the content whose only two delivery attempts were abandoned by the daemon's own queue. The content that appears *inserted* is exactly the content that was actually, successfully submitted. Timing: `795883ce`'s first attempt at `1785317138333` → dropped for real at `1785317173018` (34.7s of failed cycling) → `a6b659dc` confirmed at `1785317209142` (36.1s after the drop; 70.8s total window).

**What this does and does not support:**
- It is consistent with a *rendering-side* explanation specific to this window: the give-up-recovery clear write is a same-length filler, and nothing in these records proves it achieves full visual erasure on screen — if it doesn't, stale composer text can remain visually resident after the daemon has already written it off, and a subsequent successful write's rendering can land in/around that residue. That would produce exactly this shape: a dropped message's content framing a confirmed message's content.
- It does **not** prove that mechanism. The write-layer has no visibility into what ConPTY/the terminal actually rendered — the same evidentiary ceiling already established for specimen #2. This is inference from a real, specific, records-backed correlation (dropped-content-frames-confirmed-content), not proof.
- **It does not generalize to specimen #2.** Specimen #2's write records (already established, not re-checked here) show both implicated frames confirmed cleanly on the first Enter attempt — no give-up cycling at all. If insufficient-clear-during-give-up-recovery were *the* mechanism, specimen #2 shouldn't have spliced. Either two distinct paths produce the same visual symptom, or the give-up cycling here is a coincidental effect of the same high-concurrency conditions rather than a cause. Flagging this discrepancy rather than resolving it — resolving it would need instrumentation this corpus doesn't have.
- This is explicitly **not** a re-assertion of the refuted re-delivery correlation from step 1. That correlation was "the same message delivered twice." This is a different, new observation: "a dropped message's content appears to frame a subsequently-confirmed message's content." Different shape, different evidence, not previously examined or refuted.

## Discriminator script

Extends the corpus-sweep detector with the three-way classifier, the known-benign control, the timestamp-magnitude control, and the clear-fill-span exclusion. Kept alongside the corpus-sweep script for reproducibility; not shipped daemon code.
