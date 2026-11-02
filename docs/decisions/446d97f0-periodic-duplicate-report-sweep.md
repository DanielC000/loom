# 446d97f0 — the periodic likely-duplicate-notes report is a daemon-internal, zero-LLM watcher, never the Scheduler

## Narrative

Owner-approved follow-up to card b1f34988 (the write-time near-duplicate advisory): a periodic pass over a
project's whole memory corpus that pairs likely near-duplicate notes and files a REPORT for a human/lead to
review — never auto-merging, deleting, or rewriting a note.

**Measured pairing cost (investigate-first checkpoint, hermetic benchmark against the real compiled
`db.ts`/`mcp/memory.ts`, synthetic corpus shaped to this project's own measured density per b1f34988's
record):** a full O(N) sweep (one `findNearDuplicateProjectMemory` call per note, `excludeKey` self-excluded)
costs ~6.2s at today's real corpus size (760 notes, ~600 chars/note) and 10.7-21.7s at the `MEMORY_CONFIG_MAX`
ceiling (1000 notes), depending on note length. `better-sqlite3` is fully synchronous, so running this as one
tight loop would block the daemon's single JS thread — every live session's WS/HTTP/PTY drain — for the
whole duration. `findDuplicateReportCandidates` (`sessions/project-memory-dedup-report.ts`) yields via
`setImmediate` whenever the current chunk's ELAPSED TIME crosses `CHUNK_BUDGET_MS` (30ms) — bounded by time,
not a fixed item count, so a denser/larger corpus (slower per-item query) can never make one chunk run long;
it just yields more often. `isStopped` is checked before every item, not just at chunk boundaries, so a
daemon shutdown mid-sweep bails within one query's latency.

**Trigger: a new daemon-internal watcher (`orchestration/memory-dedup-watcher.ts`), never the Scheduler
(Pillar B).** The Scheduler boots a real interactive manager session (`index.ts`'s `scheduler.start()` doc:
"Boots a manager... on each due schedule's tick") — any such boot spends real subscription tokens even to
decide there is nothing to do, which would violate this card's own "zero metered tokens" requirement (card
2fd9abf9's own DoD-5: "Retrieval + injection spend ZERO metered API / subscription tokens"). The Scheduler is
also OFF by default (`LOOM_SCHEDULER_ENABLED`), which would make this feature silently inert for any project
that hasn't opted into agent-boot autonomy — a risk this feature has nothing to do with. `MemoryDedupWatcher`
never spawns an agent at all, so it is zero-token by construction, same shape as `DbBackupWatcher`/
`ResumeDocWatcher` (periodic `setInterval` tick, no scheduling lib, best-effort, never throws).

**Config: `memory.duplicateReportIntervalHours`** (`packages/shared/src/config.ts`), default 24h, `<= 0`
disables the sweep for that project, ceiling 720h (30 days) in `MEMORY_CONFIG_MAX`. Same trust tier as its
three siblings (`budgetTokens`/`topK`/`maxNotes`) — a benign tuning number with no host-launch/exfil
capability — so it is agent-settable via the SAME `memoryOverride` zod schema (`mcp/platform.ts`) every other
memory knob already rides, reused by every agent-facing project-config surface (`mcp/orchestration.ts`,
`mcp/setup.ts`) through the one shared `validateAgentProjectConfigOverride` chokepoint. No per-project
single-flight gap across restarts is needed: the in-memory `inFlight` guard only needs to prevent the SAME
daemon process from overlapping a project's own sweep with itself; a sweep cut short by shutdown never
stamps `lastSweep`, so the next boot's tick re-runs it cleanly from scratch rather than publishing a report
built from an incomplete scan.

**No on-demand MCP tool in v1** (manager decision) — saves a surface change and its own lint/doctrine churn;
a deliberate, explicit follow-up card if ever wanted, not a gap to quietly fill in later.

**`expiresAt` (card 57a91801, landed on main after this card's first round) gates REPORTING, never the
signal — manager decision.** 57a91801's own record is explicit that `findNearDuplicateProjectMemory`'s
corpus must never be filtered by expiry (an expired note's content is still a legitimate near-duplicate
candidate), so `findDuplicateReportCandidates` keeps querying every note, expired or not, exactly as
before. What changes is which pairs this sweep is willing to put in front of a human: a pair is never
added to the reportable set when EITHER note is currently expired (`isProjectMemoryExpired`, the one
shared predicate 57a91801 mandates reusing) — mirroring that same card's "gates kickoff DELIVERY, not
existence" shape one layer up: a periodic report is itself a delivery surface, just not a kickoff. An
expired note stays fully discoverable via `memory_read`/`memory_list`/the write-time advisory; it simply
never drives a human to review a merge involving it on this REPORT.

**Output: ONE board card per project, found by a stored id, never a fuzzy title match.** `app_meta`
(`memory-dedup-report-card:<projectId>` → the task id) is the existing daemon-global key/value store used
elsewhere for exactly this "robust marker, no new table" need (e.g. the mainline-watermark/boot-reconcile
markers). Filed directly via the raw `createProjectTask` helper (`mcp/tasks.ts`) — the SAME non-agent
boarding path setup/seed.ts already uses — never the agent-facing `createProjectTaskChecked` (card 5b221bf2
reserves that for the two genuinely agent-facing create tools only). The card is updated IN PLACE
(`db.updateTask`, blind/no-CAS, same posture as `finalizeMerge`'s own direct writes) whenever it is still
open; a closed (terminal-column) card is never reopened or deleted — a FRESH card is filed instead, only
when there is new/un-reviewed content to report, re-pointing the `app_meta` marker.

**Dedup of reports: the card's own lifecycle, plus a per-pair `version` check, no new table.** Every report
body carries a `<!-- memory-dedup-pairs: {...} -->` JSON marker naming each listed pair's identity (sorted
key tuple) and the two notes' `ProjectMemoryEntry.version` at the time that body was written. A pair found
on a LATER sweep is excluded only when: (1) the tracked card is in the TERMINAL column (a human/lead moved
it there — "reviewed"), AND (2) that pair's identity appears in the closed card's own JSON marker with BOTH
versions still matching current. Either note's version advancing since re-surfaces the pair. An OPEN
(non-terminal) card never excludes anything — nothing has been reviewed yet while it's still open, so every
sweep against an open card simply re-lists the current full candidate set (updated in place), including the
"zero candidates currently outstanding" case (the card's body says so; it is never deleted).

## Do not

- Do not filter `findDuplicateReportCandidates`'s own `db.findNearDuplicateProjectMemory` querying by
  expiry — only the REPORTABLE set is filtered (via `isProjectMemoryExpired`, never a second hand-rolled
  date comparison), never the underlying corpus/signal; that distinction is 57a91801's own mandate, one
  layer up.
- Do not re-derive the near-duplicate score/coverage threshold comparison inline anywhere in this feature —
  `findDuplicateReportCandidates` calls `isNearDuplicateCandidate` (`project-memory-dedup.ts`) exactly as
  b1f34988 left it; a second, drifted copy of that gate is exactly what b1f34988's own decision record
  warns against.
- Do not run the O(N) pairing pass as one unbroken synchronous loop — see the measured 6-22s cost above; it
  must stay chunked via `CHUNK_BUDGET_MS`-bounded `setImmediate` yields.
- Do not bound a chunk by a fixed item count instead of elapsed time — a denser/larger corpus's per-item
  query cost is NOT constant (measured 8ms → 22ms per query as corpus size/note length grew), so a
  fixed-count chunk would grow proportionally long on exactly the corpus shapes this sweep most needs to
  stay off the event loop for.
- Do not wire this feature to the Scheduler (Pillar B) or gate it behind `LOOM_SCHEDULER_ENABLED` — that
  mechanism boots a real metered agent session on every tick, which this feature's own zero-metered-tokens
  requirement forbids, and it is off by default for an unrelated autonomy reason.
- Do not stamp `lastSweep` (or publish a report) from a sweep that `isStopped` cut short — a partial scan's
  candidate set is not a valid report, and stamping it would skip a real due sweep on the next boot.
- Do not reopen or delete a closed (terminal-column) report card automatically — file a fresh one instead
  when there is new/un-reviewed content; the closed card stays as untouched history.
- Do not find the tracked report card by title text — titles are human-editable and not unique; use the
  stored `app_meta` id.
- Do not add an on-demand MCP tool for this without a fresh card/decision — v1 deliberately ships without
  one.

## Source

`packages/daemon/src/sessions/project-memory-dedup-report.ts` (pairing pass, card formatting/parsing, the
sweep entry point), `packages/daemon/src/orchestration/memory-dedup-watcher.ts` (the periodic trigger),
`packages/shared/src/config.ts` (`MemoryConfig.duplicateReportIntervalHours`, `MEMORY_CONFIG_MAX`), and
`packages/daemon/src/mcp/platform.ts` (`memoryOverride` zod schema) — introduced by card `446d97f0`,
building on card `b1f34988`'s shared signal.
