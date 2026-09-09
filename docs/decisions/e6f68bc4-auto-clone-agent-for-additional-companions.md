# e6f68bc4 — a 2nd+ companion auto-clones the default agent, deferred until pre-spawn guards pass

## Narrative

Multi-companion runtime: the single-companion pre-spawn 409 that used to live here is gone — the controller now arms every enabled config concurrently (`resolveAllEnabledConfigs`), so a 2nd (or Nth) companion provisioned while another is enabled gets its OWN gateway/session/heartbeat, not an inert/unrouted one.

Card `e6f68bc4` (owner-chosen option A): resolve the rig as an explicit `agentId`, else the bundled "Companion" agent in the reserved setup home — AUTO-CLONING a fresh agent when that default is already running a live enabled companion. "+ New companion" still "just works" with no picker, but a 2nd+ companion gets bound to its OWN distinct agent/persona instead of racing a duplicate session onto the SAME agent as the first. The FIRST companion (default not yet occupied) still binds the bundled agent directly — existing single-companion users are unaffected.

The clone itself is DEFERRED — minted only right before the spawn — rather than performed at rig-resolution time: minting it that early would insert an Agent row before the remaining pre-spawn guards (chatId, token collision, assistant-role) run, and none of their reject paths delete it, leaking a ghost agent on every rejected 2nd-companion attempt. `agentId` stays null while a clone is pending; `cloneSource` carries what to clone from once every guard has passed.

## Do not

- Do not mint the auto-clone agent before the pre-spawn guards (chatId, token collision, assistant-role) run — an early mint leaks a ghost Agent row on every rejected attempt, since none of those reject paths delete it.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (companion provision route, agent-resolution section, lines 1642-1658 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
