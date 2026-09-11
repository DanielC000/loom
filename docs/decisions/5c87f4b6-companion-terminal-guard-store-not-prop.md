# 5c87f4b6 — a rendered terminal's companion status is resolved from the session store, never a caller-supplied prop

## Narrative

WHY THE STORE RATHER THAN A PROP: the natural fix — "have the terminal read `session.role`" — fails OPEN. `TerminalCardSession` types `role` as OPTIONAL, so a caller can simply not pass it, and `undefined === "assistant"` is false ⇒ a fully writable Composer + stdin for a Companion. That would have swapped "a caller forgets `readOnly`" (the original defect) for "a caller omits `role`" — the same bug one layer down, in the very place it was put so it couldn't drift. A caller supplies only the id it must already have to attach a terminal at all, and there is no field it can omit its way past.

## The pending window is deliberate, and harmless

WHY THE WINDOW IS HARMLESS: the guard genuinely re-arms when the query lands — the derived `readOnly` is in TerminalPane's attach-effect dependency array, so the effect re-runs and xterm is reconstructed with `disableStdin`. And the daemon refuses a companion stdin write server-side regardless (`role !== "assistant"` on both /ws/term and POST /api/sessions/:id/input), so nothing can actually be written during the window. What remains is the original cosmetic silence, for milliseconds.

## Why pending-⇒-watch-only was rejected

["allSessions"] is a SINGLE shared query, so treating pending as companion would briefly disable stdin on EVERY worker, manager and shell terminal on a cold load, then tear down and re-attach each websocket when it flips. That is a visible regression to normal sessions, which this card's DoD explicitly forbids ("a NORMAL worker session ⇒ still fully writable, unchanged"). Trading a real regression for every session against a millisecond of cosmetic silence for one is the wrong direction.

## Do not

- Do not have the terminal read `session.role` directly instead of the resolved store value — `role` is optional on `TerminalCardSession`, so an omitted prop fails OPEN to a fully writable Composer + stdin for a Companion.
- Do not "fix" the pending window (the brief writable gap on a cold cache before `["allSessions"]` first resolves) — it is deliberate and the daemon-side guard already makes it harmless.
- Do not "harden" the pending case to `data ?? true` — that would briefly disable stdin on every worker, manager and shell terminal on a cold load, a visible regression this card's DoD explicitly forbids.

## Source

Inline comment in `packages/web/src/lib/companionGuard.ts` (the `useIsCompanionSession` hook's top-of-block doc), as of this tranche's HEAD. Relocated by this tranche (`docs(web): extract decision prose from web components and lib, tranche 2`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
