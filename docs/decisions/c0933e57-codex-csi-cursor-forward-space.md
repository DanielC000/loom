# c0933e57 — codex renders some spaces as CSI cursor-forward, not a literal space byte

## Narrative

Named mechanism for card `427590d2`'s "mechanism A" (the codex trust dialog never answered at boot, wedging a fresh worktree's first spawn). `isTrustDialogPrompt` (`packages/daemon/src/pty/codex-host.ts`) matched `TRUST_DIALOG_MARKER` — the literal, space-separated string "Do you trust the contents of this directory?" — against the raw accumulated pty string (`live.screenScan`, `pty/host.ts`'s `spawnCodexProcess` onData handler) via a plain `.includes()`.

MEASURED on all four archived mechanism-A specimens (`~/.loom/gate-output-archive/427590d2-mechA-*.log`: `7ad449f1`, `9bde96e3`, `9c2ecef0`, `b21383f6`) via `od -c`: codex renders the dialog's body text with CSI cursor-forward standing in for each inter-word space — `D o ESC[1C y o u ESC[1C t r u s t …` — never a literal space byte in that span. Literal-marker `.includes()` hits: 0 across all four. `Do\x1b[1Cyou` hits: 1-2 each. A raw `.includes()` can never match that rendering, so the dialog is never answered — no `[codex-trust]` log line, boot readiness never latches (`[codex-boot-stuck] … unmet: model-loaded`).

## The fix: `normalizeCodexScreenText` (`codex-doctrine.ts`)

`ESC[<n>C` (CSI Cursor Forward, ECMA-48; an omitted/zero `n` defaults to 1 cell) is replaced with `n` plain spaces — not stripped. Every other CSI sequence (color spans, cursor positioning, erase-line) and OSC sequence (the title-bar spinner) is then stripped with NO replacement, since those never stand in for a space. Whitespace runs collapse to one space afterward.

Why not just reuse `stripAnsiCsi` on the whole buffer: it removes the escape bytes with no replacement. With nothing left between "Do" and "you" once the bytes vanish, the words glue together ("Doyoutrust") and a literal-space marker still cannot match — same defect, different byte shape. `stripAnsiCsi` is correct for styling/positioning codes that carry no text of their own; a cursor-forward sequence here is standing in for real content (a space) and needs a replacement, not a deletion.

`isTrustDialogPrompt` now matches `TRUST_DIALOG_MARKER` against `normalizeCodexScreenText(screen)` instead of raw `screen`.

## Sibling marker sweep (this card's DoD-3)

Checked every other codex screen marker matched against raw/lightly-processed scan text, against the same four specimens:

- **`CODEX_READY_PLACEHOLDER`** ("Ask Codex to do anything", matched via `screen.includes(...)` in `isCodexReadyMarkerPresent`): MEASURED NOT exposed. All four specimens render this literally, with real space bytes (`od -c` verified, e.g. `... ›[22m [2mAsk Codex to do anything[22m[K`). Left unchanged — no defect confirmed, and this project's own minimal-change discipline says don't touch a path with no measured problem.
- **`CODEX_MODEL_LOADED_RE`** (tested against `stripAnsiCsi(screen)` in `isCodexModelLoaded`): MEASURED NOT exposed. All four specimens render `model:` followed by literal space bytes before the CSI-wrapped value token (`model:     \x1b[3mloading\x1b[23m   ...`), consistent with the existing `448f1b4a` decision record for this same regex. Left unchanged.
- **`BUSY_STATUS_MARKER`** (`/Working \(\d+s.*esc to interrupt\)/`, tested against the latest raw chunk `d` in `isCodexBusy`): UNMEASURED either way. None of the four specimens ever reach codex's busy state — mechanism A wedges at the trust dialog, before any turn starts, so the real busy status line never appears in a captured log. `isCodexBusy` was changed to test `normalizeCodexScreenText(d)` instead of raw `d` anyway, since this is a strict no-op on every currently-passing case (a literal-space match still matches once whitespace runs collapse to one, and the regex's own `.*` already tolerates any intervening escape bytes) and can only ever turn a previously-missed CSI-cursor-forward rendering into a real match, never the reverse. This is a defensive hardening, not a proven fix for an observed defect — disclosed as such, not claimed as measured.
- **Update-available dialog**: no runtime screen-text detector exists for this at all — it is suppressed entirely via a per-invocation config override (`CODEX_UPDATE_CHECK_OVERRIDE_ARGS`, `-c check_for_update_on_startup=false`) rather than being detected-and-answered from screen text, so this exposure class doesn't apply.

## Do not

- Do not `stripAnsiCsi` a buffer as a substitute for converting `ESC[<n>C` to spaces first — it deletes the separator entirely rather than replacing it, gluing adjacent words together with nothing left to match on.
- Do not assume `CODEX_READY_PLACEHOLDER`/`CODEX_MODEL_LOADED_RE` are exposed to this same defect without a fresh specimen — the four available specimens measure them as literal-space, not CSI-cursor-forward, and normalizing them isn't a decision to make speculatively.
- Do not treat `isCodexBusy`'s normalization as a confirmed fix — no specimen has ever captured codex's real busy-status-line rendering; it is a zero-regression-risk hardening, not a verified repair.

## Source

`packages/daemon/src/pty/codex-doctrine.ts`, the JSDoc above `normalizeCodexScreenText`, as of the commit introducing this fix.
