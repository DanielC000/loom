# 32fd6f4c — `/internal/test/seed`: test-only direct DB writes for e2e specs that can't drive the real path

## Narrative

Card `32fd6f4c` added `/internal/test/seed`: test-only data seeding for daemon-only writes an isolated e2e spec cannot otherwise reach — `session_usage_samples` (written ONLY by the internal usage sampler) and `runs` (filled ONLY by the real-spawn-triggering `POST /api/runs`, forbidden in the e2e fixture). It inserts rows directly via `deps.db` (`insertUsageSample`/`insertRun`), bypassing `SessionService.startRun`/PTY entirely — no agent ever spawns.

Extended over time by three follow-up cards, each adding a new seedable kind for a spec that hit the same underlying gap:
- Card `0954ed9c`, for the Companion Manage e2e spec.
- Card `d01311b6`, for the unified terminal / sessions e2e spec — the `liveSessions` + `wakes` kinds seed a live-but-NO-PTY session row + a pending wake so the unified `<TerminalCard>` chrome + the `SessionWakes` sub-panel render with no real claude.
- Card `a53e6bc9`, which adds `ptyGeometry`/`ptyBytes` to `liveSessions[]` so a WS attach can ALSO replay a pinned geometry + canned bytes via `deps.pty.seedCanned` (no real spawn, no in-browser monkeypatching) — plus a companion's config/session/memory/reminders (writable in prod ONLY via `/api/companion/provision` — spawns a real assistant session — or `/api/companion/config` — calls `reconcile()` and ARMS the runtime — both forbidden in the e2e fixture's no-spawn-guard world), inserted via `insertSession`/`upsertCompanionConfig`/`insertCompanionReminder` + the memory FILE store (`authorCompanionMemory`), bypassing companion `reconcile()` entirely — no runtime ever arms.

Gated on BOTH `inTestMode()` (`LOOM_TEST=1`, which the e2e fixture already sets) AND loopback, so this NEVER mounts against — and is unreachable even by IP against — a real daemon; zero prod surface, same posture as the other `/internal/*` routes with an extra fail-closed layer. This is THE pattern for seeding daemon-only data from an e2e spec (see `Projects/Loom/Design/E2E Test Suite Design.md`, vault).

## Do not

- Do not mount `/internal/test/seed` (or add a new seed kind to it) without both the `inTestMode()` AND loopback gates — it must be structurally unreachable on a real daemon.
- Do not route a new seed kind through `SessionService.startRun`/PTY or the companion `reconcile()` runtime — the whole point is a direct DB/file write with no real spawn and no runtime arming.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`POST /internal/test/seed`, lines 2841-2859 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
