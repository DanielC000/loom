# 5ced500b — an attention item's project is resolved without requiring its session to be unarchived

## Do not

- Do not resolve an attention item's project through the LIVE session feed alone. `api.allSessions` → `db.listAllSessions` is `WHERE s.archived_at IS NULL`, so any item whose session has been archived resolves to nothing and drops off the project Overview — the owner's PRIMARY board — while still showing on the global Mission Control queue. That is the defect this card fixed; a session-only lookup reintroduces it for every kind at once.
- Do not read a `resolveAttentionProjectId` of `undefined` as proof the item belongs to no project. Every `sessionProjectId` source behind it is a BOUNDED page (see "The disclosed bound" below).
- Do not let step 2 (the session lookup) override step 1 (`item.projectId`). A stated project id is the better authority, and a foreign one must REJECT the item outright rather than fall through to a session id that happens to resolve locally.
- Do not give the two readers separate resolution logic again. The Overview renders a LIST and Mission Control renders a COUNT of the same set; when they disagree, a count that says 3 beside a list showing 2 is worse than either being wrong alone.
- Do not add a per-item `api.archivedSessionById` fetch to close the residual. It was costed and rejected (below) — it is the only per-item request the design would have.
- Do not re-exclude RATE-LIMITED from the project Overview on the strength of the comment that used to be there. That exclusion was mechanical, not intentional (below).

## The defect

`Overview.tsx`'s `projAttention` and `MissionControl.tsx`'s `attnByProject` both resolved an item by looking `item.sessionId ?? item.workerSessionId` up in the live session feed. Sessions auto-archive on exit (`SessionService.archiveOnExit` archives every non-manager/platform exit unconditionally), so the lookup fails for any item that outlives its session.

That bites exactly the kinds designed to outlive their session — the ones with no liveness filter of their own, because they report a STANDING fact whose remedy outlives the session that disclosed it:

- **CODEX ISOLATION GAP** (card ed0858dc). A codex run is short-lived and parentless, so the item appeared and then dropped off the Overview almost immediately.
- **A pending owner REQUEST** (`DECISION`/`INPUT`/`PERMISSION`/`CREDENTIAL NEEDED`, and the `STALE`/`ORPHANED` variants). This was NOT on the card's list of known-affected kinds and is the most valuable case: a pending owner decision whose asking manager has since exited vanishes from the board the owner actually reads. The `ORPHANED` branch is definitionally unresolvable by session lookup — `sessionOrphaned` means that row is gone for good.
- **VAULT LOCK STUCK**, which carries no session id at all (it keys on `detail.repoPath`; no session owns a vault watcher). It therefore showed on NO project Overview, ever — a pre-existing instance of the same mechanism, not something ed0858dc introduced.

The ten other kinds were never affected, for two structural reasons worth stating so a future reader doesn't "fix" them too: `MERGE REQUEST` and `BOOT STUCK` carry their own liveness gates, the five manager-event kinds (`MANAGER ASLEEP`, `QUEUE DRAINED`, `CONTEXT OVERFLOW`, `GIVE-UP RECOVERY`, `QUIET BOARD`) are built only from LIVE managers' event streams, and `STUCK-BUSY`/`CRASH-LOOPED`/`ORPHANED FLEET` are derived by ITERATING the live feed — so if their session were archived the item would not exist at all.

## Why the project key comes from the source row, not a new REST field

Both missing project keys already existed in data the web was polling and simply weren't read:

- A Request is delivered as `QuestionInboxItem extends Question`, which carries `projectId`.
- `vault_index_lock_stale` has always been filed with `detail.projectId` alongside `repoPath` (`vault/versioner.ts`; its sole construction site passes `{ db, projectId: project.id }`).

So no REST route, response shape, or shared type changed, and none of `CLAUDE.md`'s response-field tests were in scope. `AttentionItem` gained two optional fields, but it is web-internal (`packages/web/src/lib/attention.ts`), never on the wire.

`codex_isolation_gap_disclosed` genuinely carries no project id. Adding one daemon-side was considered and rejected for the same reason card ed0858dc's own record rejected an additive `detail.parentless`: pre-existing rows would lack the key, forcing the web to carry two read paths forever. The AGENT is used instead — agents are project-scoped in Loom, and the agent's profile harness is the very thing the human must edit, so it is the natural key.

## The disclosed bound

Every `sessionProjectId` source is a bounded page: the Overview polls its project's newest 100 archived rows, Mission Control the newest 300 across all projects. So an item still resolves to `undefined` when its session archived beyond that page AND it carries neither a `projectId` nor a resolvable `agentId`.

The residual is narrow: it needs a codex-gap row whose `detail.agentId` was null (the daemon reads it off a session row that may already be gone) AND an archive page that has since rolled past that session. Closing it would take a per-unresolved-item `api.archivedSessionById` fetch — the only per-item request the whole design would contain, against a case this narrow. Ruled out deliberately.

This is a disclosed bound, not a cleared one. The whole fix otherwise costs **zero extra requests**: both fallback reads (`api.archivedSessions(projectId)` and `api.agents(projectId)` on the Overview; `api.allArchivedSessions({limit:300})` on Mission Control) were already being polled by those pages before this card.

## RATE-LIMITED, and why the old comment was wrong

`Overview.tsx` used to carry a comment calling RATE-LIMITED's absence from the project Overview deliberate: "rate-limit items carry neither and so surface globally, not here". But the stated reason was MECHANICAL — the item carries only `rateLimitSessionId`, never `sessionId`/`workerSessionId`, so the old resolver had nothing to look up. It was never a design decision that the owner shouldn't see a rate-limited session on their project board; it was a field that happened to be named differently.

Since the item is derived by iterating the live session feed, its `projectId` was in hand the whole time. It is now set, so the item resolves, and the stale comment was rewritten rather than left to assert an intent that never existed. A rate-limited session in this project is precisely what the owner wants on their primary board.
