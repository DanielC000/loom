# ea5fb00a — reject ESC/C0/C1 control bytes at the project-memory STORE boundary, not just at submit()

Card 49b382d9 strips ESC/C0/C1 control bytes once, inside `submit()`/`submitCodex()` (`pty/host.ts`) — the
real-time terminal-write chokepoint. That closes the bracketed-paste-terminator breakout for everything
written to a live pty. But project memory (`memory_write`) stores whatever bytes it's given, and that
stored text is injected into EVERY future kickoff (`retrieveProjectMemoryForKickoff`/
`appendMemoryRecallToStartupPrompt`) — which then flows through `submit()` and gets stripped there too.
So 49b382d9 alone is already sufficient to prevent the terminal breakout from a poisoned memory note. This
card adds a SECOND, independent layer: reject the bytes at WRITE time, at the store itself, so a poisoned
note can never exist in the store at all — not because the first layer is insufficient, but because a
store that can hold live-prompt-injected content should not silently accept bytes with no legitimate
purpose in a note, and because a future reader of raw project-memory rows (a REST/UI surface, a different
injection path than kickoff) should not have to independently rediscover 49b382d9's own reasoning.

## Where the check lives, and why

Two real writers reach `project_memory`'s `title`/`text`/`tags`/`trigger_glob` columns:

1. **`memory_write` (the MCP tool)** — `mcp/server.ts` → `mcp/memory.ts`'s `writeProjectMemory` →
   `db.ts`'s `upsertProjectMemoryChecked` (the optimistic-concurrency-guarded path, card a5f98bb4).
2. **`/internal/test/seed`'s `projectMemory` field** (`gateway/server.ts`, card 32fd6f4c) — an e2e-only,
   `inTestMode()` + loopback-gated route that calls `db.ts`'s raw `upsertProjectMemory` DIRECTLY, bypassing
   `mcp/memory.ts` entirely (no `KEY_RE` check, no `MAX_TEXT_BYTES` cap — it exists only so a hermetic e2e
   spec can seed `/memory` page data with no real MCP round-trip).

Both funnel into `Db.upsertProjectMemory` (`db.ts`) — the ONE function that actually performs the INSERT.
The rejection check lives THERE, not in either caller, so neither today's callers nor a future one can
skip it by calling the low-level function directly.

A third `memory_write` tool exists (`mcp/orchestration.ts`'s `registerCompanionMemoryTools`) but is
UNRELATED: it authors a companion's own private `MEMORY.md` file via `companion-memory-store.ts`, a
completely different storage backend. ⚠️ **Correction (Code Review `9f02dee5`):** this record originally
claimed, from that tool's own (stale) doc comment, that companion memory "is not currently injected into
any prompt." That is FALSE — `companion/memory-recall.ts`'s `buildFramedMemoryRecall` reads it, and
`sessions/service.ts` calls that function at several points (a resume/reconnect reinjection and at least
two other call sites) to build a framed recall block delivered into the companion's own live session. It
is genuinely injected. Still out of scope for THIS card — different tool, different writer, different
store, different trust boundary (a companion's own PRIVATE memory vs. a PROJECT-shared store any session
can read) — filed as its own follow-up by the reviewing lead; do not treat this card as having closed it.

## Strip vs reject: REJECT, matching this file's own existing philosophy

`mcp/memory.ts` already rejects out-of-bounds input rather than silently coercing it — `MAX_TEXT_BYTES`'s
own doc comment states the reasoning directly: "rejected with a clear error rather than silently
truncated (silent truncation would corrupt the note's meaning)". The same reasoning applies here: `submit()`
strips because it MUST proceed (a live keystroke stream can't fail), but `memory_write` is a discrete,
retriable API call — rejecting gives the caller a clear, actionable, retriable error instead of silently
mutating what they asked to store. A caller that doesn't know its note was silently altered can't reason
about what's actually persisted.

The rejection error names the byte class (`ESC`/`C0`/`C1`) and a 0-based CHARACTER index into the
offending field — never the surrounding content or the byte itself (`findControlCharViolation`,
`security/control-chars.ts`). This mirrors 49b382d9's own logging posture (byte-class counts only, never
a content excerpt) for the same reason: a security-motivated check that echoes the very content it's
policing partially defeats its own point, and (for a REJECTION specifically) risks reflecting attacker-
controlled bytes back into a log or an error surface.

## Shared classification, not a second copy

`pty/host.ts` used to define its own private `ESC_C0_C1_RE` + `stripEscapeAndControlChars` (49b382d9's
own text). Both now live in `security/control-chars.ts` — `stripEscapeAndControlChars` (used by host.ts,
unchanged behavior/return shape) and `findControlCharViolation` (used by the memory store boundary, to
REJECT instead of strip) share the ONE classification regex and byte-class logic. `host.ts` imports the
function instead of keeping its own copy.

## Fields checked, including `requestIds` — a corrected premise

`Db.upsertProjectMemory`'s `findProjectMemoryControlCharRejection` checks, in this fixed order: `key`,
`title`, `text`, each `tags[]` entry, `triggerGlob`, each `requestIds[]` entry. `key` is checked even
though the agent-facing `memory_write` path already restricts it to `KEY_RE`
(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`, which structurally cannot contain a control byte) — the raw
`/internal/test/seed` route binds a caller-supplied `key` with NO such check, so this is the one path that
actually needs it.

⚠️ **Correction (Code Review `9f02dee5`, reproduced live):** this record originally claimed `requestIds`
should be EXCLUDED because those ids are "opaque, resolved against the live requests store, never
rendered as free text themselves." **That premise is FALSE.**
`annotateRequestLink` (`sessions/project-memory-request-links.ts`) interpolates a linked id's RAW string
DIRECTLY into its rendered annotation line on the "not found" branch —
`` `[linked request ${requestId}: request not found — may be deleted]` `` — and that branch is not an edge
case: a control-byte-bearing id can NEVER resolve to a real `Question` row, so it deterministically takes
this exact branch every time. That annotation line is what `annotateNote` (`sessions/
project-memory-annotations.ts`) folds into the kickoff digest (`project-memory-recall.ts`'s
`retrieveProjectMemoryForKickoff`) and what `mcp/memory.ts`'s `withLinks` returns from `memory_read`/
`memory_list` — the exact same injection surface every other checked field here guards. Reproduced
directly: `writeProjectMemory({..., requestIds: ["req\x1b[2Jx\x07"]})` persisted the id and
`annotateNote` returned a line containing the raw ESC byte, before this correction.

`requestIds` is now checked at the store boundary exactly like the other free-text fields (see
`findProjectMemoryControlCharRejection`'s own doc comment in db.ts for detail).

## A SECOND, independent layer for this one field: render-time sanitization

Because a `requestIds` entry can reach the row through a path this store-boundary check cannot see — a
row written before this correction existed, or a future writer that bypasses `Db.upsertProjectMemory`
entirely (e.g. a direct SQL migration/import) — the store-time reject alone leaves a real gap: an
already-corrupted row would keep rendering its raw control byte on every future read forever, with no way
to re-validate it after the fact short of a data migration. `annotateRequestLink` therefore ALSO strips
ESC/C0/C1 from `requestId` before interpolating it into ANY of its three template branches (found,
wrong-project, not-found) — a RENDER-time backstop, independent of the write-time reject. Strip, not
reject, at this site specifically: a render function must always produce something for a row that reached
it, mirroring `pty/host.ts`'s own submit()-time strip posture for a must-always-proceed path, unlike the
store boundary above where a discrete, retriable write call can afford to refuse instead.

## Return shape: a new discriminated outcome, not an exception

`Db.upsertProjectMemory` returns `ProjectMemoryEntry | ProjectMemoryControlCharRejection` (`{rejected:true,
field, byteClass, index, error}`) rather than throwing — consistent with this codebase's general
"discriminated result object over exception" style for input-validation-shaped failures (see
`MemoryWriteConflict`/`MemoryWriteTooLong` in `mcp/memory.ts`). `upsertProjectMemoryChecked` propagates it
as a THIRD outcome shape, `{ok:false, rejected:true, ...}`, distinguished from the pre-existing version-
conflict outcome (`{ok:false, current}`) by the `rejected` discriminant — a caller must check `"rejected"
in result`, never assume `!ok` means a conflict.

## Existing-row impact: read-only, zero rows affected

A one-time read-only scan of a copy of the live production `project_memory` table (1286 rows, 2026-09-30)
found ZERO rows containing an ESC/C0/C1 byte in `key`/`title`/`text`/`tags`/`triggerGlob` — positive-
controlled (the same scan, against a copy with one byte deliberately injected into one row's `text`,
correctly detected it). A SEPARATE follow-up scan (same date, same live-db copy technique), added once
`requestIds` was recognized as a checked field, covered the 22 rows carrying a non-null `request_ids`
(26 individual linked ids total) and likewise found ZERO violations — also positive-controlled (one
injected id, correctly detected). This check is therefore pure defense-in-depth against FUTURE writes and
future legacy-row exposure; no existing row needed migration, cleanup, or triggered the render-time strip.

## Do not

- Do not add the control-char check to `mcp/memory.ts`'s `writeProjectMemory` (or to the
  `/internal/test/seed` route handler) INSTEAD of `db.ts`'s `upsertProjectMemory` — either caller alone
  can be bypassed by the OTHER writer; the check must live in the one function both of them call.
- Do not widen the checked byte range beyond ESC/C0(excl. `\t\n\r`)/C1 or reuse a `\t`/`\n`/`\r`-stripping
  regex here — see 49b382d9's own "Do not" section; the same reasoning applies to this shared regex.
- Do not echo the offending bytes, or the surrounding text, in the rejection error — byte class + a
  character index only, mirroring 49b382d9's own no-content-excerpt logging posture.
- ⛔ Do NOT skip checking `requestIds` for control chars, and do not re-adopt the retracted "opaque id,
  never rendered as free text" argument above — `annotateRequestLink`'s "not found" branch interpolates
  the raw id directly, and a control-byte id ALWAYS takes that branch. Both the store-time reject AND the
  render-time strip (`annotateRequestLink`) must stay in place; neither alone is sufficient (see above).
- Do not conflate the companion's own `memory_write` tool (`mcp/orchestration.ts`,
  `registerCompanionMemoryTools`) with project memory — different tool registration, different storage
  backend (`companion-memory-store.ts`'s per-companion `MEMORY.md`), out of scope for this card. Do NOT,
  however, cite that tool's own doc comment as proof companion memory is unused in prompts — it IS
  injected (`companion/memory-recall.ts`'s `buildFramedMemoryRecall`, wired from `sessions/service.ts`);
  see the correction above. A separate follow-up card covers that surface, not this one.
- Do not strip (rather than reject) `requestIds` at the STORE boundary — the store-time check for this
  field follows the same reject posture as every other checked field; only the RENDER site
  (`annotateRequestLink`) strips, for the different reason given above (a render must always proceed).
- Do not treat `upsertProjectMemoryChecked`'s `{ok:false}` as a single shape — check `"rejected" in
  result` before assuming a `{ok:false}` result is a version conflict with a `.current` field.
- Do not rewrite existing `project_memory` rows on the strength of the one-time scan above — it found
  zero violations and this check is deliberately write-path-only; there is no backfill/migration step.
