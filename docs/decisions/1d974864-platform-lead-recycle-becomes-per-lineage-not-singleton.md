<!-- title: recyclePlatformLead's atomicity narrows from a global singleton to per-lineage -->

# recyclePlatformLead's atomicity narrows from a global singleton to per-lineage

Source: commit 1d974864, no board card.

## Decision

`recyclePlatformLead` (`packages/daemon/src/sessions/service.ts`) originally (commit b346f2c8 —
see [[b346f2c8-platform-lead-self-recycle-mechanics]]) enforced a **SINGLETON GUARD — never two
live Leads**: because the predecessor is itself a live platform session, the code retired it in
the DB *before* the successor was marked live, running retire → insert → flip-live
synchronously with no `await` between, so on Node's single-threaded loop no concurrent
`startPlatformLead` call or watcher tick could ever observe two live platform rows.

This commit **removed that constraint at the source** — `startPlatformLead` became
create-only, and the owner may now run several live Platform Leads at once, coordinating via the
shared Platform board. `recyclePlatformLead`'s own atomicity requirement did not go away; it
**narrowed from a global singleton to per-lineage**:

- **PER-LINEAGE REPLACEMENT (1 recycle → 1 successor, NOT a global singleton).** Multiple live
  Leads may coexist; a recycle replaces **only** the calling Lead's own lineage.
- The predecessor is still retired in the DB *before* the successor is marked live, and the
  retire → insert → flip-live sequence still runs synchronously with **no `await`** between —
  this keeps the transition atomic on Node's single-threaded loop, so the predecessor and its
  successor are never both live at once (no double-counted lineage, no zombie) — **even though
  other, unrelated Leads stay live throughout**.
- Because the successor carries `recycledFrom = old.id`, `hasSuccessor(old.id)` is true, so the
  crash-recovery watchdog never resurrects the retired predecessor (`recordUnexpectedExit` and
  its tick both skip a superseded session).
- The method is (still) one of two sanctioned paths that can spawn a platform session — the
  other is the human-REST `startPlatformLead` — not the *only* one; the wording was corrected
  here to say so plainly.

**Why this matters for anyone touching this code again:** a global "never two live Leads"
invariant genuinely did hold at commit b346f2c8, and no longer does. Code or comments elsewhere
that still assume a platform-session singleton are stale against this commit, not against a
misreading of the current source.
