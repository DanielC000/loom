# fd799f0f — do not ASCII-fold human keystrokes in `writeStdinCodex`

## Narrative

`writeStdinCodex` is the codex counterpart of `writeStdin`'s raw-keystroke passthrough: a real human typing directly into a codex terminal tile. It is deliberately NO composer-dirty tracking, no human-submit hold, no busy gate — codex's Ink-free TUI has no Loom-observable "composer" concept to protect the way claude's does, and a real human must always be able to type regardless of turn state, mirroring `writeStdin`'s own unconditional-write invariant for claude.

Card `fd799f0f` (DELIBERATE, REVISITABLE — not an oversight): this write is deliberately NOT ASCII-folded, unlike `submitCodex`'s write of Loom-authored text (card `0e83c855`'s `codexAsciiFold`). `submitCodex` repairs Loom's OWN transport; this carries a HUMAN's own keystrokes, watched live — they can see and retype a corrupted paste within seconds, an agent turn cannot, and folding would silently alter what they actually typed (type `—`, see `--` appear) — worse than an honest visible drop for input a human, not Loom, authored.

Reachability of the same measured drop class here is INFERRED, not measured: the drop was shown to require a live codex/crossterm-style console-input reader on this conpty instance (`docs/design/multi-harness-parity-matrix.md:152-181` — a plain raw-mode-reading child gets the SAME bytes intact; only codex's own TUI composer corrupts them), and this write feeds that SAME live codex process untransformed — no real-spawn repro of THIS path exists.

fold-with-notice was costed and found NOT cheap before choosing this: no per-tile notice affordance exists in `Terminal.tsx` today, and the app's toast system is bound to the global fleet `AttentionItem` feed — the wrong shape for per-paste feedback; it would need a new WS control-frame plus a new frontend component.

## Do not

- Do not fold human keystrokes here without a fresh owner ask; a confirmed direction on the multi-harness epic (card `00a6cdd6`) is a legitimate trigger to revisit this, not a reason to silently change it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`writeStdinCodex`'s method doc): lines 6906-6932, as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
