# a5544837 — a non-Session terminal's status resolves via `title` override, not new `statusMode` branches

Source: commit a5544837a4, no board card

## Narrative

Stage 4 of the terminal-unification epic (`ShellTile` + `CompanionTerminal` adopting `<TerminalCard>`) had to resolve a deferred question: how does a card whose header isn't a live DB `Session` (a raw shell terminal, a read-only companion window) show its status? The two options were (a) implement the `statusMode` enum's "static"/"conn" branches inside `TerminalCard` itself, or (b) let each non-Session caller supply its own header node via the existing `title` prop. Stage 4 resolved it in favor of (b): a raw shell and a read-only companion window are not DB Sessions with a live busy signal, so each supplies its own header node (a "shell" / "read-only" `StatusPill`) via `title` instead of `TerminalCard` growing new status-resolution logic for them.

`statusMode` therefore stays typed (the enum keeps the call sites shaped) with only the "busy" path actually implemented; no consumer needs the others.

## Do not

- Do not implement the `statusMode` "static"/"conn" branches inside `TerminalCard` — a non-Session caller (shell, companion) supplies its own header node via `title` instead; adding those branches would duplicate a decision already made the other way.

## Source

Inline comment in `packages/web/src/components/TerminalCard.tsx` (the module's top-of-file banner doc, the "STAGE 4" paragraph), lines 32-36, as of commit `a5544837a42250de2607aee61c1c75722a3a339b` (`refactor(web): ShellTile + CompanionTerminal adopt the <TerminalCard> frame + maximize`). Extracted by card `7071275f`; wording condensed, no substantive detail dropped.
