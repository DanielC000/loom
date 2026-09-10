# 86863348 — `appendToStartupPrompt` exists to close GAP 1: the read-modify-write round-trip a manager had to do via `curl`

## Narrative

Card `86863348` ("feat(orchestration): manager affordances the curl workarounds revealed (read agent prompt; verify served deploy)") records two tooling gaps the owner asked to have logged after a live session where the manager had to fall back to `curl` against the daemon's REST port for things the orchestration MCP surface didn't cover.

**GAP 1** (the one this anchor is about): `agent_list` returned `{id,name,role,profileId,position}` — no `startupPrompt` — and `agent_update` (`updateAgentPreset`) only supported a full-prompt REPLACE, no append. So a manager wanting to safely edit one agent's prompt (read → modify → write) had to `curl GET /api/projects/<pid>/agents` to read the current text, then reproduce it exactly as the `startupPrompt` argument to `agent_update` — a real transcription-risk round-trip on a long prompt, and one that required leaving the MCP surface entirely.

**GAP 2** (same card, different fix, not this anchor's concern): no manager tool to verify a `daemon_restart` deploy actually went live, forcing a `curl http://127.0.0.1:4317/` bundle-hash check and a `curl /api/companion/config` check. Fixed by a served-status read; not part of `updateAgentPreset`.

The commit that closed GAP 1, `c34f496097`, fixed it two complementary ways: an `agent_get` MCP tool exposing the full `startupPrompt` (the read side — no more `curl` needed to see the current text), and `appendToStartupPrompt` on `agent_update` (the write side — for the common case of a small addition, a manager never needs the full text at all, so there's no round-trip to get wrong). `appendToStartupPrompt` concatenates onto the agent's existing prompt, joined with a blank line, or used bare when the existing prompt is empty; passing both `startupPrompt` and `appendToStartupPrompt` in the same call is rejected as mutually exclusive.

## Do not

- Do not read "GAP 1" in the source comment as referring to GAP 2's deploy-verification concern (a different fix, same card) — they're numbered within the same card but solve unrelated gaps.
- Do not reintroduce a caller-side full-text round-trip for a small prompt addition — that's the exact hazard `appendToStartupPrompt` exists to avoid; use it (or `replaceInStartupPrompt`, card `6c411cdf`, for a mid-document edit) instead.

## Source

JSDoc comment above `updateAgentPreset` in `packages/daemon/src/sessions/service.ts`: originally lines 10772-10775 (the `appendToStartupPrompt`/"GAP 1" sentence), as of this tranche's HEAD. Introduced by commit `c34f496097` ("feat(orchestration): manager affordances the curl workarounds revealed"), which does not cite a board card id in its own message; resolved to card `86863348` via `tasks_list(titleContains: "curl workaround")` — that card's title, body ("GAP 1 — read an agent's startupPrompt from the manager surface... FIX: ... give agent_update an append mode"), and `merged.sha`/`merged.date` all match this commit exactly (sha `c34f496`, date `2026-07-03T05:18:12+02:00`).
