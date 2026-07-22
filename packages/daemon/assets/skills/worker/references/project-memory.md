# Project memory — mechanics & discipline

Read this BEFORE your first `memory_*` call. The core doctrine carries the WHEN — write durable
cross-session facts, query before deciding; this file carries the exact tool mechanics and the
provenance discipline.

Capture a durable fact with `memory_write` (`mcp__loom-tasks__memory_write`). Its exact params are
**`key`**, **`text`**, and optional **`title`** — these `memory_*` tools are DEFERRED, so
ToolSearch-load them first and use those names verbatim; a GUESSED param (`args`/`value`/`content`) is
silently stripped and the call fails validation for the missing required field. Pass a stable `key`
(re-writing the same key UPDATES in place — refine, don't mint near-duplicates), a short `title`, and
a compact `text` (≤4000 bytes, a curated fact — not a dumping ground). This store is SHARED across
every session on the project and its relevant notes auto-inject into each kickoff, so one small note
spares a successor or sibling from re-deriving what you learned. Leave `pinned` off for the normal
case (it surfaces by relevance); pin only a rare always-load-bearing fact. It's NOT task state (the
board) or a design doc (a vault note) — just the durable, reusable nugget. **The store is queryable,
not write-only** — `memory_read`(`key`)/`memory_list` (no args) pull a relevant note on demand, so
consult it when a decision or gotcha might already be captured; don't only append. Read-first also
gates an UPDATE: to overwrite an existing key, read it and pass its current `version` as `baseVersion`
— a stale or omitted base is rejected with the current note returned so you reconcile. **Stamp a
durable note with light provenance** (`verified: <date> against <mainline>`) and cite identifiers
that survive — commit SUBJECTS, symbol names — never ephemeral ones (a pre-squash branch SHA rots on
merge; line numbers drift). **If a note's validity has an expiry, write it as a runnable predicate**
(a grep / commit-presence / card-state check), not prose like "until X lands" — with the honest
caveat that nothing runs that predicate for you today, so it only pays off when an agent thinks to
check it.
