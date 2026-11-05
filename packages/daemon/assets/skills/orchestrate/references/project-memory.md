# Project memory — mechanics & discipline

Read this BEFORE your first `memory_*` call. The core doctrine (the loop, step 8) carries the WHEN —
write durable cross-session facts, query before deciding; this file carries the exact tool mechanics
and the provenance discipline.

`memory_write` (`mcp__loom-tasks__memory_write`) writes a project-scoped note SHARED across EVERY
agent/session and auto-injected into each kickoff. Exact params: **`key`**, **`text`**, and optional
**`title`**, **`pinned`**, **`tags`**, **`requestIds`**, **`triggerGlob`**, **`expiresAt`**,
**`baseVersion`**. The `memory_*` tools are DEFERRED: ToolSearch-load them and use these names
verbatim (a guessed param like `args`/`value`/`content` is silently stripped and the call fails on the
missing required field). Capture a durable cross-session fact (a verified invariant, a load-bearing
gotcha, a settled decision + why, a "this is already done/closed" fact; if it has a decision record, a
one-line pointer beats restating it) as a compact titled note under a stable `key` (same key UPDATES
in place; ≤4000 bytes, curated, not task chatter). Pin only a rare always-relevant fact; a pinned note
also tagged `"never-drop"` (only on top of a pin, only when an ordinary pin's best-effort delivery
isn't enough) has a LOWER cap, ≤2000 bytes, since it rides every kickoff unconditionally. Leave the
rest unpinned to surface by relevance, and `memory_forget` a note gone stale. Recall is automatic.
**Query it, don't only write it**: `memory_read`(`key`)/`memory_list` (no args). Read-first also gates
an UPDATE: pass the current `version` as `baseVersion`; a stale or omitted base is rejected with the
current note returned so you reconcile. **Stamp a durable note with provenance**: date it (`verified:
<date> against <mainline>`), cite commit SUBJECTS / symbol names, never a branch SHA (rots on merge)
or line number. **If a note's CONTENT can go stale, write the check as a runnable predicate** (grep /
commit-presence / card-state), not prose like "until X lands" (nothing runs it automatically, so it
helps only when an agent thinks to check). For time-boxed RELEVANCE use `expiresAt` (below).

**`memory_history`:** every UPDATE that changes `text` (not a metadata-only patch, not a first write)
appends a row to the key's append-only history. `memory_history`(`key`[, `limit`]) returns it
newest-first, each row `{oldText, newText, version, updatedAt}`. Use it before minting an "-evidence"
sibling note or re-typing an old claim just to explain why a fact changed. `memory_forget` also deletes
the key's history; a later write starts a fresh lineage.

**`requestIds` is usually YOUR case.** A note touching an owner gate (pending approval, authorization,
spend) records the request id in `requestIds` (an array), not just typed into `text`. Every read
re-resolves each id against the LIVE requests store and appends `[linked request <id>: <STATE> as of
<date>]`, so the note self-corrects when the owner answers. Phrase the body in asking voice ("PENDING
request `<id>` asks the owner to authorize X") as the human-readable fallback and always pass
`requestIds` too; skipping it leaves readers trusting a stale "owner approved" note.

**`triggerGlob`:** a pinned note otherwise rides EVERY kickoff. Set a path glob (e.g. `"src/memory/**"`)
to deliver it unconditionally only to kickoffs whose text names a matching path; on others it competes
by full-text relevance. Only meaningful on a pinned note NOT tagged `"never-drop"` (a never-drop note
bypasses its trigger).

**`expiresAt`:** for a note relevant only "while this stays true" (an investigation is live, a
migration in flight). Set an ISO date (e.g. `"2026-12-01"`); past it the note stops competing for ANY
kickoff tier but isn't deleted (`memory_read`/`memory_list` still return it, annotated `expired`).
Omit to leave a stored expiry unchanged, pass `""` to clear it, or a new date to move it.

**Near-duplicate advisory on a brand-new key.** A NEW key resembling an existing note still succeeds,
but the response carries `nearDuplicateStatus` ({message, key, score, coverage}) naming the existing
key (cheap local full-text check, never a block). Act on it by `memory_write`-ing the NAMED key instead
of accumulating a second note. It never fires on an UPDATE. A periodic zero-LLM background sweep also
files a board card of likely-duplicate pairs for review (never auto-merging, deleting, or rewriting,
and skipping expired notes); expect that card from time to time rather than dispatching anyone to hunt
duplicates.
