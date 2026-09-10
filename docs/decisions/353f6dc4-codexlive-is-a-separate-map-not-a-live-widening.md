# 353f6dc4 — a codex session's live state lives in its own map, never inside `Live`

## Narrative

Multi-harness epic (`df1f94b0`) Phase 1, card `353f6dc4` — LEAD RULING #5: a codex session's live state lives in its OWN map (`PtyHost.liveCodex`, private, separate from `live` above), never inside `Live` itself. Ruling #3's original approved shape (a `kind:"codex"` widening of `Live`, sharing `this.live`) was SUPERSEDED after this card's own field-by-field read of `Live` found ~60 required fields — the great majority backing four separate mismatch-detection subsystems plus the give-up ladder and composer-drift tracking, each with real, non-obvious invariants — not inert bookkeeping a sentinel value could safely paper over.

Sentinel-populating them (ruling #3's "cheapest form") would have made EXACTLY the absent-vs-zero mistake ruling #4 exists to prevent: a populated-but-empty `Map`/`Set` reads as "measured, nothing there," not "not applicable to this harness."

`CodexLive` therefore carries ONLY the fields a codex session genuinely has — a Claude-only field simply DOES NOT EXIST here, so an accessor reading it via `PtyHost.findAnyLive` on a codex entry gets a real TypeScript compile error (never a runtime `undefined` guess) if it isn't narrowed first, and any codex-side "is this set" question is answered by the field being absent from the object entirely — never a sentinel a reader has to reason about. Every field here shares its exact name AND type with the corresponding `Live` field it mirrors, so `findAnyLive`'s `Live | CodexLive` union return type lets TypeScript resolve a shared field with NO narrowing at all (structurally present on both members) while still hard-erroring on any Claude-only field access — this is what makes the "route through ONE resolver" mitigation a compile-time guarantee rather than a review convention.

## Why `codex-host.ts` itself holds no state

Multi-harness epic (`df1f94b0`) Phase 1, this same card `353f6dc4`: the original plan (ruling #3) was to wire the codex stateful runtime INTO `pty/host.ts` via a `spawnCodexProcess` method that built a minimal `Live`-shaped entry in the SAME `this.live` map ruling #5 later replaced. Building that entry turned out to require either (a) populating the ~60 required `Live` fields — composer-drift/give-up/mismatch-detection bookkeeping, Maps/Sets/arrays of structured records, each with real invariants read/written across ~8,000 lines — with sentinel values, or (b) making those fields optional on `Live`, which cascades into every internal call site that reads them without an `undefined` guard. Both exceeded the card's own cap ("`pty/host.ts` edits are capped at the minimum dispatch hunk; if that minimum grows beyond a small hunk, STOP and report") — reported up rather than built unilaterally, which is what produced ruling #5 above.

The shape that resulted: `PtyHost#spawnCodexProcess`/`submitCodex`/`enqueueStdinCodex`/`drainCodexPending`/`stopCodex`/`interruptForRedirectCodex` in `pty/host.ts` are the real, wired, real-spawn-tested stateful runtime. `packages/daemon/src/pty/codex-host.ts` ships ONLY the pure decision logic those methods delegate to — trust-dialog detect/answer, busy/idle detection, kickoff-ready detection, MCP-url→codex-argv translation — proven by direct unit tests (`test/codex-host-decisions.mjs`) plus the scripted fake-pty queue/turn-state-machine test (`test/codex-queue-state-machine.mjs`). It holds no state of its own and is never itself what a real session's `Live`/`CodexLive` entry points at.

## Do not

- Do not widen `Live` itself with a `kind:"codex"` variant to add codex support — ruling #3's original shape, superseded by this card because it forces sentinel values onto ~60 fields codex doesn't actually have.
- Do not give `CodexLive` a Claude-only field "just in case" — the whole point is that such a field's absence is a compile error, not a runtime check.
- Do not add state to `codex-host.ts` itself, or make it the thing a session's `Live`/`CodexLive` entry points at — that split (pure logic here, wiring in `pty/host.ts`) is what let this stay outside the ~8,000-line host file at all.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `export interface CodexLive`), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

A second site records the companion half of the same ruling: the module-level doc comment at the top of `packages/daemon/src/pty/codex-host.ts` (lines 3-24), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card e5ee79bb (tranche 1 on `pty/codex-host.ts`); no wording changed beyond joining wrapped source lines and stripping `*` markers.
