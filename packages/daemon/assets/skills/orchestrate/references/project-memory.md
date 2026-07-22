# Project memory — mechanics & discipline

Read this BEFORE your first `memory_*` call. The core doctrine (the loop, step 8) carries the WHEN —
write durable cross-session facts, query before deciding; this file carries the exact tool mechanics
and the provenance discipline.

`memory_write` (`mcp__loom-tasks__memory_write`) writes a project-scoped note SHARED across EVERY
agent/session and auto-injected into each kickoff. Its exact params are **`key`**, **`text`**, and
optional **`title`** — these `memory_*` tools are DEFERRED, so ToolSearch-load them first and use
those names verbatim; a guessed param (`args`/`value`/`content`) is silently stripped and the call
fails validation for the missing required field. When you or a worker establishes a durable
cross-session fact any future agent should have — a verified invariant, a load-bearing gotcha, a
settled decision + why, a "this is already done/closed" fact — capture it as a compact titled note
under a stable `key` (same key UPDATES in place; ≤4000 bytes, curated, not task chatter). Pin only a
rare always-relevant fact; leave the rest unpinned to surface by relevance, and `memory_forget` a note
gone stale. The recall/injection side is automatic — writing the nuggets is the half that makes it pay
off. **Query it, don't only write it** — `memory_read`(`key`)/`memory_list` (no args) pull a relevant
note on demand, so consult the store when a decision might already be settled in it. Read-first also
gates an UPDATE: to overwrite an existing key, read it and pass its current `version` as `baseVersion`
— a stale or omitted base is rejected with the current note returned so you reconcile. **Stamp a
durable note with provenance** — date it (`verified: <date> against <mainline>`), cite commit SUBJECTS
/ symbol names, never a branch SHA or line number (a pre-squash branch SHA rots on merge; line numbers
drift). **If a note carries an expiry, write it as a runnable predicate** (a grep / commit-presence /
card-state check), not prose like "until X lands" — with the honest caveat that nothing runs it
automatically today, so it only helps when an agent thinks to check it.
