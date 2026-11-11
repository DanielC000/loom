# d9af5472 — the terminal image-paste key counts as ONE unit of dirty composer draft

The owner's Alt+V in a live session produced `[Image #N]` chips that sat unsent in the raw-terminal composer, and Loom submitted a programmatic turn on top of them. Cause: `nextComposerLen` treated ESC v as zero-length (its generic ESC branch does `i += 1` and then the loop's own `i++`, skipping the ESC AND the following byte), and 0x16 is an ignored C0 control, so a chip-only draft read as a clean composer. Background: `docs/investigations/7874ebfd-image-paste/README.md`.

## Decision

- `nextComposerLen(prevLen, data, imageKey?)` and `nextRawDraftState(prevText, data, imageKey?, prevImages?)` match the image-paste key BEFORE the generic ESC skip (outside a bracketed-paste span) and count it as exactly one unit. A chip-only draft is therefore dirty (`composerLen > 0`) until a freeing key (Enter / Ctrl-C / Ctrl-U / Esc) or backspace.
- The key is chosen by the DAEMON host's OS (`imagePasteKeyForPlatform`, via the injectable `PtyHost.imagePasteKey()` seam): the CLI reads the daemon host's clipboard, and its binding differs per OS. `win32` counts `\x1bv` (Alt+V); every other platform counts `\x16` (Ctrl+V). Only that one key is counted.
- `nextRawDraftState` tracks chips as a separate `images` count and NEVER appends them to `text`, so what a text draft reports as `submitted` is unchanged. An Enter outside a paste that frees a chip-only draft reports `imageSubmit`, and `writeStdin` arms `humanSubmitHeldUntil` for it exactly as for a text submit (no `lastRawSubmit` / `pendingRawOwnerSubmit` is captured: there is no text).

## Do not

- Do not collapse the dirty signal to a bool for chips: a chip is one length unit so backspace-to-empty still releases the hold (sha:c1d71ff2).
- Do not count both OS keys. The other OS's key is not the image key on this host, so counting it only over-holds.
- Do not read `process.platform` at the call site; go through `imagePasteKey()` so a test can cover both branches on one host.
- Do not skip the submit-hold arm for an image-only Enter: draining right after it races the queued turn into a composer the engine is still leaving (card 2521bf51).
- Do not append a chip marker to `rawDraftText`: it would change the text the paste tripwire and owner-text capture see for ordinary drafts.

## Chip weight (owner-confirmed)

A chip is counted as 1 because ONE Backspace deletes a whole `[Image #N]` chip. CONFIRMED by the owner (request 797c1414, 2026-11-11); no real engine was launched to check it. If that ever stops holding, the hold would release early (the unsafe direction) and the per-chip weight must change.

## Residuals

**Phantom chip.** The image key pressed with NO image on the clipboard adds no chip but is still counted. The hold has NO time limit: it lasts until Enter / Ctrl-C / Ctrl-U / Esc / Backspace. Three downstream effects, all in the hold-safe direction (they only ever wait or warn, never touch the human's bytes):
- companion auto-recycle defers indefinitely (`orchestration/context-watcher.ts` ~:485, `isComposerDirty`);
- a daemon restart records `hadUnsentDraft=true` and the resumed agent is told a draft was lost (`sessions/service.ts` ~:8568);
- Enter on a phantom-only box holds the queue for up to `HUMAN_SUBMIT_CONFIRM_HOLD_MS` (`pty/host.ts` ~:972).

**One key per OS is safe in Loom.** The web terminal swallows Ctrl+V (`web/src/components/Terminal.tsx` ~:176). The only Loom path that writes the image key is card 3da47390's image-only paste, which sends ESC v on Windows and `\x16` elsewhere, and only when the clipboard holds an image and no text. So a text-carrying `\x16`, or a Windows `\x16` chip, does not arise from Loom's UI. Raw input sources (a non-Loom attach, a scripted `writeStdin`) can still miscount: over-hold when a counted key produces no chip, early release when a real chip's key is not the one counted for this OS.

**Backspace attribution (pre-existing, not a regression).** Backspace deletes text before a chip in `nextRawDraftState`, so for "abc" + chip + Backspace the captured `lastRawSubmit` / `pendingRawOwnerSubmit` text can be wrong. The `composerLen` total stays correct.

**Chunk-boundary split (pre-existing).** `writeStdin` keeps no ESC state across calls, so ESC and `v` arriving in separate chunks are not matched as the key. Unlikely: xterm sends Alt+V as one `onData` string.

## Out of scope (named, not fixed)

- The general Alt+&lt;key&gt; two-byte skip: any ESC followed by a printable byte other than `[` / `O` is dropped as two bytes (ESC b, ESC f, ...). Only the image key is special-cased here.
- Codex: `writeStdinCodex` has NO composer tracking at all, so a codex session has this hazard for every typed draft, not just images. The structural invariant: `writeStdin` returns into `writeStdinCodex` at `pty/host.ts` ~:15116, before any composerLen / draft tracking runs, so nothing here touches codex. Card c1e218e7 owns the gap; no test pins it (a pin would go red when that card fixes it).
