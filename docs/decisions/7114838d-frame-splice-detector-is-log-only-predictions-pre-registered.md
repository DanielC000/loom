# 7114838d — the frame-splice detector is LOG-ONLY (fixes nothing); four predictions were pre-registered before any observation existed

## Narrative

Card `7114838d`: at `UserPromptSubmit`, compares the engine's own report of what it actually submitted (`hook.prompt`) against the daemon's own record of what it intended to write for this turn (`live.lastPrompt`). LOG-ONLY — fixes nothing; unblocks card `3ce3fa39` (root-cause question stays open) by giving it real observations. Meaningful specifically because the two sides come from genuinely INDEPENDENT sources, not two views of the same mocked/written state.

Logged via `console.log` (stdout), deliberately the SAME stream as `[pty-write]`/`[submit-write]`/`[stdin-write]` — the point is correlating a splice against the write records around it, and `console.warn` (stderr) is a separately buffered/timestamped stream, so line order between the two in the combined log file is not guaranteed. Correlate by EPOCH-MS TIMESTAMPS, never by line order — the corpus is mixed with other stderr output too.

Gated on `submitWasOutstanding` (captured before this hook flips `enterConfirmed` — see `fca6af6d`): per `Live.lastPrompt`'s own doc, that field is set ONLY by Loom-originated `submit()` calls, never by a raw human-typed turn. An ungated always-compare would misfire on EVERY raw-terminal turn, against a stale `lastPrompt` left over from an earlier, unrelated turn.

**Why not a systematic benign mismatch** (checked at manager review): `live.lastPrompt` is set from the EXACT literal `text` argument `submit()` receives, and every caller builds any `[loom:from-manager]\n…`-style frame BEFORE calling in (e.g. `sessions/service.ts`'s `messageWorker` builds `framed` first) — so `lastPrompt` already holds the FULL post-framing text, same form as typed into the composer. `writeChunked` (`submit()`'s writer) writes that string byte-for-byte with no daemon-side normalization (no trim, no CRLF conversion, no appended newline — Enter is a separate write). What remains UNCONFIRMED — it lives entirely on the engine/CLI side, outside this repo — is whether Claude Code's own hook reports that identical string back verbatim (e.g. Ink-side trimming); only the first real hook after deploy could answer that. `lenDelta`/tail-length fields exist so that observation self-classifies on arrival.

## The four PRE-REGISTERED predictions (2026-07-29) — made BEFORE any real observation existed

At registration, whether `UserPromptSubmit`'s hook payload even carries a `prompt` field at all was itself unverified — that uncertainty is the whole reason the detector exists.

1. **SILENCE** ⇒ Claude Code echoes the framed string back identically. Detector armed and working, no splice observed yet — the expected steady state.
2. **`prompt-field-absent`** (fires once) ⇒ the hook payload doesn't carry the prompt text at all. This card's premise dies here, cleanly — `3ce3fa39` goes back to its accept-risk-vs-real-terminal choice with nothing new to add.
3. **Mismatch with TINY tails** (both `tailReportedLen`/`tailIntendedLen` small) and/or a small `lenDelta`, divergence near the very END ⇒ benign normalization on Claude Code's own side (e.g. trailing-whitespace trimming). NOT a splice — report it, don't suppress it; the comparison would need relaxing/scoping, not the detector declared broken.
4. **Mismatch with LARGE tails on BOTH sides**, divergence MID-STRING, `lenDelta` roughly the size of a whole stranded message ⇒ the real thing: a live frame splice, captured with full context.

## OBSERVED 2026-08-04 (card `201d0d95`, session `363002b9` gen=8, real production traffic)

Whole-content EXACT REPLACEMENT by an UNRELATED, OLDER, ALREADY-CONFIRMED prior generation's own text: `reportedHash` matched a PRIOR generation's `writtenHash` byte-for-byte (not this generation's own), `divergesAtChar` landed right after the shared literal prefix (the message-type tag), and `reportedLen` did not correspond to any splice/concatenation of the intended text — a clean duplicate of a fully separate past submission, confirmed independently via the archived transcript (the duplicate turn was byte-identical to the original, ~168s apart, both `len=1864`).

This matched NONE of the four original predictions: not silence, not absent-field, not benign end-of-string normalization, and not a mid-string splice with an ADDED tail — it is a REPLACEMENT, whose effect is to DOUBLE a real prior turn's delivery while DROPPING the new one, not merely to lose it. Surfaced to the affected session via `[loom:prompt-mismatch]`, added by the same card.

**OBLIGATION FULFILLED 2026-08-04** (card `201d0d95`): the pre-registration recorded its first real observation, per its own rule. The four ORIGINAL predictions stay — still the right shape to recognize a splice/normalization/absent-field — but are no longer all untested; one has fired. A future first observation of any of the remaining three untested predictions should get the same treatment: append what was actually seen, cite the card, don't just believe the prediction.

## Do not

- Do not compare `hook.prompt` against `live.lastPrompt` unconditionally — gate on `submitWasOutstanding` or a raw-terminal turn misfires against a stale `lastPrompt`.
- Do not correlate log lines against `[pty-write]`/`[submit-write]` by line order — streams are separately buffered; correlate by EPOCH-MS timestamp only.
- Do not treat a fired prediction as closing the other three — each gets its own first-observation treatment when it fires.
- Do not read this detector as fixing anything — LOG-ONLY; the fix lives at `3ce3fa39`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `UserPromptSubmit` case in `deliverHook`), as of `main` `0cac46b89a9d2ad236117c355fb93d43f4f0f03f` (this tranche's starting HEAD). Extracted by card `7f448888` (tranche 19 on `pty/host.ts`).
