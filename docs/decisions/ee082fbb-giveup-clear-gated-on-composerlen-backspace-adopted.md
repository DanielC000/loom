# ee082fbb — the give-up recovery clear is gated on `composerLen === 0`, and Backspace was adopted only after probing the real engine

## Narrative

GIVE-UP RECOVERY (the branch `sendEnterAndVerify` falls through to when the engine produced no output at all after the final Enter write — see card `71de1f9c`'s record for the suppression this is the complement of) recovers `busy` and clears the stranded injection from the composer — but ONLY when `composerLen === 0`. `composerLen` tracks ONLY human raw-terminal keystrokes, never our own `pty.write`, so `=== 0` proves the composer holds NOTHING but this give-up'd injection: a human never got a chance to start a draft during the failed retries. If one did, `composerLen > 0` and the box is left alone — `deferForHumanDraft`'s existing hold still protects it (card `e1829591`, never destroy a user's uncommitted draft). This is the HUMAN-DRAFT SAFETY half of the fix; the CLEAR-EFFICACY half (does a clear byte actually empty a real multi-line composer, or does it truncate/strand a partial remnant?) needed real-engine validation, not just hermetic bytes-written assertions.

The exact length to un-type is `live.lastPrompt` — already the literal text `submit()` pinned for this turn (line ~3007) — so no new state is needed; give-up walks it back char-by-char via the same `writeChunked` large-write path `submit()` itself uses (a giant Backspace burst is just as subject to ConPTY's write-size limits as a giant paste).

This same mechanism (exact-count Backspace burst sized off `live.lastPrompt.length`, gated on `composerLen === 0`) is REUSED, not reinvented, by `healIfStuck`'s own stale-busy backstop — see card `b64b3726`'s record (Half 2) for that reuse and why a second clear path must never be invented.

### REAL-CLAUDE FINDINGS (claude 2.1.207, probe: `test/_probe-composer-clear{,-2}.mjs`)

- The TUI COLLAPSES a multi-line/long bracketed paste into a single `"[Pasted text #N +K lines]"` placeholder token — the raw lines are NOT individually editable once pasted.
- A single Esc does NOT clear it — it only ARMS a "Esc again to clear" confirm; a second Esc (or any other key right after) leaves the composer in an inconsistent, still-dirty state. **REJECTED.**
- Ctrl-U (kill-line) cleared the COLLAPSED placeholder in one shot (it reads as one "line" to readline-style kill semantics) — but on a SHORT multi-line paste that stayed under the placeholder-collapse threshold (rendered as literal editable lines, not a placeholder), Ctrl-U only killed the CURRENT line and SILENTLY STRANDED the earlier line(s) — confirmed via the engine's own transcript, which recorded the stranded first line concatenated with the next turn. Exactly the "partial clear worse than concatenation" risk this card was deferred over. **REJECTED** as a general-purpose clear.
- Exact-count Backspace (`\x7f` × the injected text's length) reliably emptied the composer in EVERY case tested: the collapsed placeholder (backspace #1 deletes the whole atomic token, the rest floor at 0 and no-op — safe even though the count overshoots the placeholder's own visual length; a VERSION-PINNED assumption about claude 2.1.207's composer/backspace handling — worth re-verifying against the probes if a future claude version changes that behavior), a short un-collapsed multi-line paste (backspace walks back through the embedded newlines exactly like `nextComposerLen`'s own counting model), and a single-line paste. **ADOPTED.**

## Do not

- Do not attempt this clear while `composerLen > 0` — that is the same human-draft-safety gate every other clear in this file uses (card `e1829591`).
- Do not use Esc as the clear mechanism — it only arms a second-Esc confirm and a second key leaves the composer inconsistently dirty.
- Do not use Ctrl-U as a general-purpose clear — it silently strands earlier lines on a short, un-collapsed multi-line paste.
- Do not invent a second clear path — reuse the exact-count Backspace burst via `writeChunked`, the same mechanism `healIfStuck`'s backstop reuses (card `b64b3726`, Half 2).
- Do not assume Backspace's overshoot-is-safe behavior holds on a future claude version without re-running the probes — it is version-pinned to 2.1.207.

## CR item ② — the retired `attempt > 1` proxy on `markGiveUpDirty`'s own call sites

`markGiveUpDirty`'s callers used to gate the dirty-mark itself on `attempt > 1` — a cheap proxy for "the paste bracket is closed" (only a RETRIED attempt had sent its own re-assert first), skipping the mark at `attempt === 1` to avoid folding raw backspaces in as literal paste content while the bracket might still be open. Once this card's clear-prefix started ALWAYS force-closing the bracket first (a fresh START+END pair, before backspacing), that residual risk was covered structurally instead — the proxy was retired as redundant (guarded by `pty-giveup-clear-single-attempt.mjs`), not as a correctness fix.

### Do not (2)

- Do not skip the dirty-mark at `attempt === 1` "to be safe" — that reintroduces the original stray-text bug the force-closing clear-prefix already covers.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`sendEnterAndVerify`'s own method doc, the GIVE-UP RECOVERY paragraph and its embedded REAL-CLAUDE FINDINGS probe narrative). Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 35 (card `905cf0ce`).

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`awaitGiveUpConfirmSettle`'s `confirmed:false` callback), lines 8461-8468, as of `main` `5fa1465e` (this tranche's starting HEAD). Condensed, not verbatim. Not shared with `sessions/service.ts`. Extracted by tranche 38 (card `639cf9ae`).
