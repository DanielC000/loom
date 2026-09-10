# ccdb1e0c — authoredContent is an owner-accepted Tier-A residual risk (lever 4+6)

## Narrative

This record covers ONE facet of the Companion→Platform-Lead epic `ccdb1e0c` — the `authoredContent` per-project opt-in for `board_create`/`board_update` (Framework §4.5's Tier-A residual, epic levers 4+6). Other levers under the same epic (`transcript-read`, `session-spawn`) carry their own, unrelated guard content that stays inline at its own predicate — see `packages/daemon/src/companion/capabilities.ts` directly for those; this record is scoped to `authoredContentAllowed` only.

With `authoredContent` ON for a project, an injected/attacker turn on a WARM trust window could create/update a card with arbitrary authored text. This is the design's OWNER-ACCEPTED Tier-A residual (design §4.5): the safety floor there is grant-scoping + the verify-once trust window + Tier-X-on-catastrophic, NOT per-action verbatim content checking.

That residual risk is WHY this opt-in is fail-closed per-project (default OFF) and why the flag is human-REST-only — the grant-config validator (`gateway/server.ts`) accepts it only on the human grant-write path, so an agent can never set it on its own grant.

## Do not

- Do not make `authoredContent` settable via any agent-facing MCP tool — it must stay human-REST-only, matching the rest of the capability-grant trust boundary.
- Do not treat `authoredContent`'s residual risk as "fixed" — it is an owner-accepted trade-off, not a solved problem; any future hardening needs its own owner sign-off, not a silent tightening.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`authoredContentAllowed`'s top-of-function doc, the "SAFETY" paragraph): lines 954-959, as of this tranche's HEAD. No card id is cited in the comment itself; sourced via `git blame`'s introducing commit summary ("feat(companion): authored cross-project card text — board create/update, Tier A [epic ccdb1e0c, levers 4+6]"). Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
