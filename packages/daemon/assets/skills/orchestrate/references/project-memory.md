# Project memory — mechanics & discipline

Read this BEFORE your first `memory_*` call. The core doctrine (the loop, step 8) carries the WHEN —
write durable cross-session facts, query before deciding; this file carries the exact tool mechanics
and the provenance discipline.

`memory_write` (`mcp__loom-tasks__memory_write`) writes a project-scoped note SHARED across EVERY
agent/session and auto-injected into each kickoff. Its exact params are **`key`**, **`text`**, and
optional **`title`**, **`pinned`**, **`tags`**, **`requestIds`**, **`triggerGlob`**, and
**`baseVersion`** — these `memory_*` tools are DEFERRED, so ToolSearch-load them first and use those
names verbatim; a guessed param (`args`/`value`/`content`) is silently stripped and the call fails
validation for the missing required field. When you or a worker establishes a durable cross-session
fact any future agent should have — a verified invariant, a load-bearing gotcha, a settled decision +
why, a "this is already done/closed" fact — capture it as a compact titled note under a stable `key`
(same key UPDATES in place; ≤4000 bytes, curated, not task chatter — a pinned note also tagged
`"never-drop"`, see below, has a LOWER cap, ≤2000 bytes, since it rides every future kickoff
unconditionally). Pin only a rare always-relevant fact, and reach for the `"never-drop"` tag (via
`tags`) only on top of a pin, and only when even an ordinary pin's best-effort delivery isn't good
enough; leave the rest unpinned to surface by relevance, and `memory_forget` a note gone stale. The
recall/injection side is automatic — writing the nuggets is the half that makes it pay off. **Query it,
don't only write it** — `memory_read`(`key`)/`memory_list` (no args) pull a relevant note on demand, so
consult the store when a decision might already be settled in it. Read-first also gates an UPDATE: to
overwrite an existing key, read it and pass its current `version` as `baseVersion` — a stale or omitted
base is rejected with the current note returned so you reconcile. **Stamp a durable note with
provenance** — date it (`verified: <date> against <mainline>`), cite commit SUBJECTS / symbol names,
never a branch SHA or line number (a pre-squash branch SHA rots on merge; line numbers drift). **If a
note carries an expiry, write it as a runnable predicate** (a grep / commit-presence / card-state
check), not prose like "until X lands" — with the honest caveat that nothing runs it automatically
today, so it only helps when an agent thinks to check it.

**Linking a note to a Request (`requestIds`) — this is usually YOUR case.** A note touching an owner
gate — a pending approval, authorization, or spend — records the request id in `requestIds` (an array),
NOT just its id/state typed into `text` by hand. Every future read (kickoff injection, `memory_read`,
`memory_list`) re-resolves each linked id against the requests store's LIVE state and appends
`[linked request <id>: <STATE> as of <date>]` automatically — so the note self-corrects the moment the
owner answers it, instead of a hand-typed annotation going stale. You're the one who files an
owner-gated `question_ask` in the first place, so a note about it is usually yours to write: phrase the
body in asking voice ("PENDING request `<id>` asks the owner to authorize X") as the human-readable
fallback, and always pass `requestIds` too — skipping it is exactly the drift that leaves a worker (or
your own future self) trusting a stale "owner approved" note that nobody re-checked against the real
answer.

**Scoping a pinned note to relevant work (`triggerGlob`):** a pinned note otherwise rides EVERY
kickoff, full stop — set `triggerGlob` to a path glob (e.g. `"src/memory/**"`) to instead gate that
unconditional delivery to a kickoff whose text names a matching path; on any other kickoff it competes
for relevance via full-text search, same as an unpinned note. Only meaningful on a note that's pinned
and NOT also tagged `"never-drop"` — a never-drop floor note always bypasses its own trigger, by design.
