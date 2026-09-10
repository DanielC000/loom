# dbba993f — auto-respawn so `chat_reply` is discoverable when enabling on an already-live session

## The bug (stateless-MCP tool discovery)

Adding/removing a session in `hooks.companionSessionIds` (un)registers `chat_reply` at the router for THAT session, but an ALREADY-CONNECTED companion `claude` session won't re-list tools until its next MCP (re)connect — the running companion PROCESS fetched `tools/list` only once, at ITS OWN startup, before this session ever entered `companionSessionIds`, and has no way to discover a tool it never asked for. So a LIVE enable used to be able to leave `chat_reply` silently undiscoverable on an already-running session until its next reconnect/resume — that companion could never reply, silently, for the rest of that process's life. The identical mechanism was already fixed for per-capability grants (see `gateway/server.ts`'s ADD/upgrade route comment and [[d88163b7-hold-drain-surface-and-bounded-busy-wait]]'s conversation-preserving respawn); card `dbba993f` extends the same fix to the CORE chat_reply gate itself — arming a companion at all, not a per-capability grant.

## The fix

`CompanionController.startOne` (`packages/daemon/src/companion/controller.ts`) now detects exactly that transition and auto-triggers the SAME conversation-preserving respawn `POST /api/companion/:sessionId/upgrade` exposes — reusing the existing primitive rather than inventing a second one — so the gap no longer needs a human to notice and retrigger it by hand. It calls the injected `upgradeCompanionSession` DIRECTLY rather than through `upgrade()`, to avoid re-entering `upgrade()`'s own chain serialization from inside an already-running chain op (`startOne` itself runs on that chain) — `upgrade()` itself stays exactly what it says: the human/REST path, never auto-fired.

A lingering `chat_reply` call on a running session AFTER its teardown still routes through `deliverReply` and no-ops with `"companion-off"` (its map entry is cleared) — never a cross-wire or a throw.

## Detecting "was it already live"

`engineSessionId` is captured on SessionStart and is therefore ALREADY SET, at the point `startOne` runs, for exactly the sessions that were live before now — a session spawned fresh as part of THIS same provisioning call has not yet reached its own first SessionStart when `startOne` runs (config is written and reconciled synchronously, well before the newly-spawned `claude` process finishes booting), so it reads `null` here and is correctly left alone: its own first `tools/list` still has `chat_reply` in it. The "was it already live" read goes through the injected `deps.wasSessionAlreadyLive` rather than a direct `deps.db.getSession(...)` call — deliberately a narrow injected predicate: the first cut of this fix called `db.getSession` directly and broke four test fixtures whose `db` mock never implemented it (a partial mock satisfies TypeScript via the interface cast, so the compiler couldn't catch it). This shape keeps `startOne` free of any NEW required capability on `deps.db`, mirroring every other narrow optional signal on `CompanionControllerDeps` (`originResolver`, `closeTrustWindow`, `upgradeCompanionSession` itself). Optional: absent ⇒ `startOne` never auto-respawns, byte-identical to before this card — every existing test fixture that doesn't wire it is completely unaffected, not merely degraded.

## Cost and failure handling

Real, honest cost, paid ONLY on this previously-silently-broken path: worst case ~13s (see [[5a9ad7fd-conversation-preserving-respawn-consequences]] for `upgrade()`'s own global-chain blocking trade-off, which this auto-trigger also incurs). Best-effort: a failed auto-respawn is logged, not thrown; the session stays enabled either way (the owner can retry via the same REST upgrade route), matching `reconcile`'s own best-effort contract.

## Do not

- Do not call `upgrade()` from `startOne` to auto-trigger this — it would re-enter `upgrade()`'s own chain serialization from inside an already-running chain op.
- Do not read "was it already live" via a direct `deps.db.getSession(...)` call — use the injected `wasSessionAlreadyLive` predicate so `startOne` gains no new required `deps.db` capability.
- Do not auto-trigger this for a per-capability-grant path — that stays a deliberate human/REST-only opt-in (see `gateway/server.ts`'s ADD/upgrade route comment).

## Source

`packages/daemon/src/companion/controller.ts`: `deliverReply`'s `NOTE (stateless-MCP tool discovery)` paragraph and `startOne`'s full top-of-function doc, as of tranche 1 on this file (card `488cedea`). No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
