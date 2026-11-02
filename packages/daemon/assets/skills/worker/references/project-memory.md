# Project memory — mechanics & discipline

Read this BEFORE your first `memory_*` call. The core doctrine carries the WHEN — write durable
cross-session facts, query before deciding; this file carries the exact tool mechanics and the
provenance discipline.

Capture a durable fact with `memory_write` (`mcp__loom-tasks__memory_write`). Its exact params are
**`key`**, **`text`**, and optional **`title`**, **`pinned`**, **`tags`**, **`requestIds`**,
**`triggerGlob`**, **`expiresAt`**, and **`baseVersion`** — these `memory_*` tools are DEFERRED, so ToolSearch-load them
first and use those names verbatim; a GUESSED param (`args`/`value`/`content`) is silently stripped and
the call fails validation for the missing required field. Pass a stable `key` (re-writing the same key
UPDATES in place — refine, don't mint near-duplicates), a short `title`, and a compact `text` (≤4000
bytes, a curated fact — not a dumping ground; a **pinned note also tagged `"never-drop"`**, see below,
has a LOWER cap — ≤2000 bytes — since it rides every future kickoff unconditionally). This store is
SHARED across every session on the project and its relevant notes auto-inject into each kickoff, so one
small note spares a successor or sibling from re-deriving what you learned. Leave `pinned` off for the
normal case (it surfaces by relevance); pin only a rare always-load-bearing fact, and only add the
`"never-drop"` tag (via `tags`) on top when even an ordinary pin's best-effort delivery isn't good
enough — an ordinary pin alone is still a rotating, best-effort slot, not a guarantee. It's NOT task
state (the board) or a design doc (a vault note) — just the durable, reusable nugget. **The store is
queryable, not write-only** — `memory_read`(`key`)/`memory_list` (no args) pull a relevant note on
demand, so consult it when a decision or gotcha might already be captured; don't only append. Read-first
also gates an UPDATE: to overwrite an existing key, read it and pass its current `version` as
`baseVersion` — a stale or omitted base is rejected with the current note returned so you reconcile.
**Stamp a durable note with light provenance** (`verified: <date> against <mainline>`) and cite
identifiers that survive — commit SUBJECTS, symbol names — never ephemeral ones (a pre-squash branch SHA
rots on merge; line numbers drift). **If a note's CONTENT can go stale, write the staleness check as a
runnable predicate** (a grep / commit-presence / card-state check), not prose like "until X lands" — with
the honest caveat that nothing runs that predicate for you today, so it only pays off when an agent
thinks to check it. That's a different concern from a note's RELEVANCE being time-boxed (e.g. "only
matters while this investigation is live") — for that, set `expiresAt` instead (see below): it's an
actual mechanism, not a prose reminder nobody automatically acts on.

**Seeing what a note used to say (`memory_history`):** every UPDATE that actually changes `text` (never
a metadata-only patch, and never a key's own first write) appends a row to that key's append-only
history. Read it back with `memory_history`(`key`[, `limit`]) — newest-first, each row
`{oldText, newText, version, updatedAt}`. Reach for it before minting a new "-evidence" sibling note or
re-typing an old claim into a decision record just to explain why a fact changed — the prior wording is
already there. `memory_forget` also deletes that key's history — forgetting means forgetting, so a later
write under the same key starts a fresh lineage, not a resumed one.

**Linking a note to a Request (`requestIds`):** a note touching an owner gate — a pending approval,
authorization, or spend — records the request id in `requestIds` (an array), NOT just its id/state
written into `text` by hand. Every future read (kickoff injection, `memory_read`, `memory_list`)
re-resolves each linked id against the requests store's LIVE state and appends
`[linked request <id>: <STATE> as of <date>]` automatically — so the note self-corrects the moment the
owner answers it, instead of the annotation you typed by hand going stale. Still write the note body
itself in asking voice ("PENDING request `<id>` asks the owner to authorize X") as the human-readable
fallback — `requestIds` makes the state-check automatic, it doesn't replace writing the ask clearly.

**Scoping a pinned note to relevant work (`triggerGlob`):** a pinned note otherwise rides EVERY
kickoff, full stop — set `triggerGlob` to a path glob (e.g. `"src/memory/**"`) to instead gate that
unconditional delivery to a kickoff whose text names a matching path; on any other kickoff it competes
for relevance via full-text search, same as an unpinned note. Only meaningful on a note that's pinned
and NOT also tagged `"never-drop"` — a never-drop floor note always bypasses its own trigger, by design.

**Retiring a time-boxed note from kickoffs (`expiresAt`):** a note relevant only "while this stays
true" (an investigation is live, a migration is in flight) otherwise either rides forever or has to be
remembered and `memory_forget`-ed later. Set `expiresAt` to an ISO date (e.g. `"2026-12-01"`) and, past
that date, the note stops competing for ANY kickoff tier — pinned or related — without being deleted:
`memory_read`/`memory_list` still return it in full, annotated `expired`. Omit to leave a stored expiry
unchanged, pass `""` explicitly to clear it back to "never expires," or pass a new date to move it.

**A near-duplicate advisory on a brand-new key.** When the note you're about to write under a NEW key
closely resembles an existing one, the write still succeeds but its response carries a
`nearDuplicateStatus` ({message, key, score, coverage}) naming the existing key it resembles — a cheap,
local full-text check, no LLM/embeddings, never a block. Treat it as a strong nudge to `memory_write` the
NAMED key instead (refining it, per the stable-key discipline above) rather than minting a second note on
the same topic — exactly the accumulation this check exists to catch. It never fires on an UPDATE to an
existing key, so fixing a flagged duplicate by updating the named key is itself silent, not a repeat
nag. The same signal also runs as a periodic, zero-LLM background sweep over the whole corpus, filing a
board card of likely-duplicate pairs for a human/lead to review (never auto-merging, deleting, or
rewriting a note, and never naming a pair where either note is currently expired) — nothing you need to
call, but expect the resulting card to show up on the board from time to time if this project's notes
drift toward overlap.
