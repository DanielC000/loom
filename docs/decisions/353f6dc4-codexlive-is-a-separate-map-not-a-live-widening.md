# 353f6dc4 — a codex session's live state lives in its own map, never inside `Live`

## Narrative

Multi-harness epic (`df1f94b0`) Phase 1, card `353f6dc4` — LEAD RULING #5: a codex session's live state lives in its OWN map (`PtyHost.liveCodex`, private, separate from `live` above), never inside `Live` itself. Ruling #3's original approved shape (a `kind:"codex"` widening of `Live`, sharing `this.live`) was SUPERSEDED after this card's own field-by-field read of `Live` found ~60 required fields — the great majority backing four separate mismatch-detection subsystems plus the give-up ladder and composer-drift tracking, each with real, non-obvious invariants — not inert bookkeeping a sentinel value could safely paper over.

Sentinel-populating them (ruling #3's "cheapest form") would have made EXACTLY the absent-vs-zero mistake ruling #4 exists to prevent: a populated-but-empty `Map`/`Set` reads as "measured, nothing there," not "not applicable to this harness."

`CodexLive` therefore carries ONLY the fields a codex session genuinely has — a Claude-only field simply DOES NOT EXIST here, so an accessor reading it via `PtyHost.findAnyLive` on a codex entry gets a real TypeScript compile error (never a runtime `undefined` guess) if it isn't narrowed first, and any codex-side "is this set" question is answered by the field being absent from the object entirely — never a sentinel a reader has to reason about. Every field here shares its exact name AND type with the corresponding `Live` field it mirrors, so `findAnyLive`'s `Live | CodexLive` union return type lets TypeScript resolve a shared field with NO narrowing at all (structurally present on both members) while still hard-erroring on any Claude-only field access — this is what makes the "route through ONE resolver" mitigation a compile-time guarantee rather than a review convention.

## Do not

- Do not widen `Live` itself with a `kind:"codex"` variant to add codex support — ruling #3's original shape, superseded by this card because it forces sentinel values onto ~60 fields codex doesn't actually have.
- Do not give `CodexLive` a Claude-only field "just in case" — the whole point is that such a field's absence is a compile error, not a runtime check.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `export interface CodexLive`), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
