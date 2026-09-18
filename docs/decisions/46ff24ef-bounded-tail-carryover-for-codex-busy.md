# 46ff24ef — a bounded tail carryover closes the busy-marker chunk-straddle gap, never an unbounded accumulation

## Narrative

Spun out of `427590d2` (the codex real-spawn flake corpus) as its own card, so landing this fix could not close that corpus on one proven mechanism.

`isCodexBusy(d)` (`packages/daemon/src/pty/codex-host.ts`) tested `BUSY_STATUS_MARKER` against the RAW single pty chunk `d` — never an accumulation, unlike every sibling codex check (`isTrustDialogPrompt`, `isCodexReadyMarkerPresent`, `isCodexModelLoaded`), which all scan `live.screenScan` because "regex markers can straddle a chunk boundary". Worker `5d3ac261` proved, deterministically: splitting `"Working (12s • esc to interrupt)"` at two independent points makes each half return `false`; the halves concatenated (what accumulation would hold) fire `true` — the loss is a raw-chunk-scanning artifact. Same failure class already hit production for the trust-dialog marker (card `353f6dc4`) before its own accumulation fix.

## Why not accumulation (the obvious fix, proven wrong)

Simulating `isCodexBusy` against `live.screenScan`'s own 8 KB-cap/eviction shape: marker fired once, then only idle filler — busy kept reporting true for ~8192 bytes of idle output before the cap evicted the stale match, reintroducing the "stale match latches busy forever" regression Code Review C2/M3 already closed once.

Deliberate asymmetry: trust-dialog/ready-marker/model-loaded are PRESENCE checks (accumulation safe, answer never reverts). Busy/idle is a LIVENESS/FRESHNESS read (accumulation is poison — it can never un-see a stale match until eviction).

## The fix: a small, bounded tail carryover

`codex-host.ts#scanCodexBusy(prevTail, chunk)`: scans `prevTail + chunk` with the existing `isCodexBusy`, derives the NEXT tail as the last `CODEX_BUSY_MARKER_MAX_CHARS - 1` chars of that concatenation (never accumulated beyond that window). `pty/host.ts`'s onData handler threads `live.codexBusyTail` through it instead of calling `isCodexBusy(d)` directly.

`CODEX_BUSY_MARKER_MAX_CHARS` (`codex-doctrine.ts`) is the two LITERAL segments of `BUSY_STATUS_MARKER` plus a bounded ALLOWANCE for each of its two unbounded segments — not a clean derivation, since `\d+` and `.*` admit arbitrary length on their own:
- `"Working ("` — 9 chars, literal fact.
- `\d+s` — no finite max on `\d+` alone, so an ALLOWANCE (judgement, not fact): `CODEX_BUSY_ELAPSED_DIGITS_MAX` (6) digits + `"s"` — 999999s ≈ 11.5 days, far beyond any real turn, still finite.
- `.*` — the only open-ended span. Post-`normalizeCodexScreenText`, real content is *expected* to be just `" • "` (~5 chars); ALLOWANCE bounded to `CODEX_BUSY_MIDDLE_MAX_CHARS` (16), two orders of magnitude below `CODEX_SCREEN_SCAN_CAP` (8192). Judgement, not fact.
- `"esc to interrupt)"` — 17 chars, literal fact.

Both allowances rest on the SAME never-captured real rendering `c0933e57`'s open exposure names — nobody actually knows the real marker's length. If it's ever captured, check its length against this bound rather than trusting the allowances silently.

Total 49 chars; carryover window is 48. Also covers `BUSY_TITLE_SPINNER_RE` (~5 chars) — the status marker is the binding case.

## Real defect caught by verification: a self-contained match must not be carried forward

First implementation derived `tail` unconditionally. Running `codex-queue-state-machine.mjs` (drives the real onData handler with scripted chunks) caught it RED: its boot-episode scenario pushes a busy marker in ONE self-contained chunk, lets it go stale via the real timer, then pushes an unrelated model-loading chunk — wrongly read as busy again.

Mechanism: a short chunk that IS the whole marker becomes the entire carried-forward tail. The staleness TIMER turning `busy` false doesn't touch that tail (independent state). Whenever the next chunk finally arrives, `tail + chunk` still contains the old marker's literal text and re-matches — even though that chunk has nothing to do with busy. Same regression class, bounded by CHUNK ARRIVAL instead of bytes, hence not bounded by time at all.

**Fix:** after computing the bounded candidate tail, if it ALONE already satisfies `isCodexBusy`, reset to `""` — nothing incomplete is left to stitch onto a future chunk. This closes the gap for both a self-contained match and a confirmed split match: once confirmed, nothing is retained past it. A tail is kept only when it is a genuine, still-incomplete PREFIX. DoD-1(b) freshness is proven by test against this exact defect (`codex-host-decisions.mjs`'s regression guard), not merely asserted.

## Scope

Settles that the mechanism exists and the bounded-tail-carryover shape survives both proofs. Does NOT settle incidence (how often real codex output splits here) or the `c0933e57` real-byte-match exposure — both stay open on `427590d2`, which this card's landing must not close.

## Do not

- Do not point `isCodexBusy`/`scanCodexBusy` at `live.screenScan` or any unbounded accumulation — reintroduces the closed "stale match latches busy forever" regression.
- Do not hardcode the carryover window as a flat number — derive it from `BUSY_STATUS_MARKER`'s own segments.
- Do not carry a candidate tail forward unconditionally — a tail that is ITSELF already a complete match must reset to `""`, or it re-triggers busy against unrelated later content (the RED-proved defect above).
- Do not treat this card as closing `427590d2` — the corpus stays open; this card owns one proven mechanism.

## Source

`packages/daemon/src/pty/codex-doctrine.ts` (`CODEX_BUSY_MARKER_MAX_CHARS`), `packages/daemon/src/pty/codex-host.ts` (`scanCodexBusy`), `packages/daemon/src/pty/host.ts` (onData call site), as of the commit introducing this fix.
