# 262ecfbc — PL ruling: REST config writes drive the running gateway live

## Narrative

`CompanionController` (`packages/daemon/src/companion/controller.ts`) is the HOT LIFECYCLE controller for Loom Companion (Companion epic Phase 3 backend, later generalized to MULTI-companion by the multi-companion runtime card). It exists to close the "no .env, no restart" headline of the PL ruling: it makes the REST config writes (POST/PUT/DELETE at `/api/companion/config`) drive the RUNNING gateway(s) LIVE, instead of applying only on the next daemon boot.

## Source

Introduced by commit `262ecfbc` ("feat(gateway): hot companion lifecycle — start/stop/reconfigure from DB config without daemon restart", 2026-07-01). No board card cites the PL ruling anywhere in this repo (checked `packages/web/src/lib/companion.ts`, `packages/daemon/src/db.ts`, `packages/daemon/src/companion/store.ts`, and this file's own git history) — this is why the anchor is keyed on the commit sha rather than a card id (see CLAUDE.md's `sha:` decision-anchor sigil).
