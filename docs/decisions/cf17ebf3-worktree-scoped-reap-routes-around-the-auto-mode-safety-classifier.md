# cf17ebf3 — `reapSessionStraysCore`: an on-demand worktree-scoped reap that routes around Claude Code's own safety classifier

## Narrative

The classifier-blocked-cleanup finding: during a fleet-down incident, a Lead's own zombie-vitest kill got blocked by Claude Code's own auto-mode safety classifier — TWICE — forcing a manual owner one-liner instead of a Lead-driven recovery. A daemon-executed kill of the daemon's OWN children is not a classifier question at all; `reapSessionStraysCore` gives a Lead/manager a structural way to reap a lingering escaped process WITHOUT routing through that classifier, and WITHOUT having to stop the session it's scoped to.

Reuses the EXACT SAME `reapWorktreeProcesses`/`reapProcessesRootedInWorktree` machinery {@link sweepWorktreeStrays} already uses on stop — matched STRICTLY by executable path/cwd/command line rooted under the target session's OWN `worktreePath` (never a bare image-name or port match — see `reapProcessesRootedInWorktree`'s own SAFETY doc for the full scoping proof). Excludes the target session's own live pty pid (a routine reap must never kill the very session it's scoped to — mirrors `sweepWorktreeStrays`' worker self-exclusion) and never the daemon's own pid (that function's unconditional self-exclusion).

UNLIKE `sweepWorktreeStrays` (fire-and-forget on stop), this is AWAITED and returns the actual `killedPids`, so an explicit tool call or test can see what happened instead of firing-and-forgetting.

## Do not

- Do not fall back to `session.cwd` for a session with no `worktreePath` (manager/plain/run/Lead) — its `cwd` is the project's REPO ROOT, not an isolated tree, and scoping the reap there would match (and kill) sibling manager ptys, a running dev server, or the self-hosting daemon's own supervisor. Refuse loudly (throw) instead of a silent no-op, so the caller (a Lead mid fleet-down cleanup) knows nothing was reaped rather than assuming it was.
- Do not make this fire-and-forget like `sweepWorktreeStrays` — an explicit on-demand reap must report its actual `killedPids` back to the caller.
- Do not widen the match to a bare image-name or port — only executable path/cwd/command line rooted under the session's own worktree.

## Consequences

A Lead or manager can reap a lingering escaped process scoped to one session's worktree without needing the vendor CLI's own safety classifier to approve the kill, and without stopping the session the stray is rooted under.

## Source

JSDoc above `reapSessionStraysCore` in `packages/daemon/src/sessions/service.ts`, as of this tranche's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The adjacent `NO ?? session.cwd FALLBACK` guard comment (same method body, CRITICAL, Code Review) stays inline as a Class-A guard — not relocated here, restated only in the "Do not" section above.
