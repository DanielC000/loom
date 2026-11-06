# 298b826e — keep the `connections` freeze across recycle (Option B), make it discoverable

External bug report (GIP2 Test Automation project, forwarded by the owner): a Connection bound to a
manager profile after that manager's session had already started was not usable after `recycle_me`. The
owner's confirmed root cause: `recycleManager` (`sessions/service.ts`) and `recycleWorker` carry
`connections: old.connections ?? []` forward from the predecessor session row, never re-resolving the
live Profile — unlike `permission`/`model`, which recycle DOES re-resolve via `resolveAgentSpawn` (fixed
earlier by card `bbdf77507`, 2026-06-26). A genuinely fresh spawn (`startManager`/`spawnWorker`) always
resolves the live profile correctly; only `recycle_me`/`recycleWorker` freeze it.

**Correction (card `6745e4bc`): `skills` is NOT in that re-resolved set.** This paragraph originally
lumped `skills` in with `permission`/`model` above — verified against the live code (every recycle path's
`skills: old.skills ?? null`) that `skills` stays frozen across recycle, exactly like `connections`,
consistent with decision `547d5fc4`'s own explicit "Do not re-resolve the profile's `skills` subset on
resume/fork/recycle/boot." The ruling below (Option B, keep the freeze) is unaffected — `skills` was
already correctly treated as frozen in practice; only this paragraph's contrast was wrong.

The owner's ruling, verbatim in substance: **Option B — keep the freeze.** `connections` is pinned on a
session row at spawn and stays frozen across resume/fork/recycle by documented contract
(`packages/shared/src/types.ts`), the same posture `vaultWrite`/`skills`/`browserTesting` already have.
The only existing mechanism that re-pins a capability grant onto a *live* session without a fresh spawn
is `upgradeCompanionCapabilities` (`sessions/service.ts`, `@decision d88163b7`/`1a048349`) — deliberately
human-REST-only and scoped to `role==="assistant"` (companion) only. The owner explicitly declined to
widen an agent-triggerable path (`recycle_me`) to re-pin grants, and will board a separate card for a
possible human-triggered "re-pin grants on this session" action instead.

## Do not

- Do not change `recycleManager`/`recycleWorker` (or any future `recyclePlatformLead`) to re-resolve
  `connections` from the live Profile — that would silently widen what an agent-triggered `recycle_me`
  call can do, reversing this deliberate ruling. If this is ever revisited, it needs a fresh owner
  decision, not a "consistency" argument with `permission`/`model` (those ARE re-resolved for a different
  reason — see `bbdf77507` — and that precedent was already weighed and rejected here; `skills` is NOT
  re-resolved either, per the correction above, so it offers no such argument in the first place).
- Do not assume discoverability text (the credential ack, the grant REST response, the Profiles/Pending-
  bindings UI) makes the freeze retroactive — it only tells a human/agent that a fresh spawn is required;
  it does not change the underlying behavior.
- Do not delete or weaken `test/connections-recycle-freeze-contract.mjs` to make a future "fix" pass — if
  that test goes red, the fix is wrong per this ruling, not the test.

Full investigation, the hermetic repro, and the fixes shipped alongside this ruling are in the `298b826e`
board card and its `worker_report` history.

## Addendum — drift is now stated, the freeze is unchanged

A session whose pinned `connections` differ from its AGENT's current grants now says so (the `authenticated_request` / `ssh_exec` tool description, and a `grantDrift` field on every refused call). The text names the only two real fixes — a human re-pinning the session's grants (`POST /api/sessions/:id/repin-grants`) or a fresh session — and never suggests a recycle or resume, which keep the pinned list. The re-pin route already resolves exactly as a fresh spawn does (agent grants included, revocations dropped); `test/connections-grant-drift.mjs` pins that. Do not point the drift text at `recycle_me`.
