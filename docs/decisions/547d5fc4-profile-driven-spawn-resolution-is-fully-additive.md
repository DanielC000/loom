# 547d5fc4 — profile-driven spawn resolution (`resolveAgentSpawn`) is fully additive

## Narrative

Phase-2 profile-driven spawn (Agents→Profiles P2): resolve an agent's OPTIONAL Profile into the effective spawn shape the "start a session in an agent" paths read — the role it confers, the startup prompt to inject, and the permission policy (config allow + the profile's allowDelta).

Fully additive — an agent with `profileId === null` (every agent before this feature) resolves to EXACTLY the pre-existing behavior: role straight from the caller, the agent's OWN prompt, and the config's permission object unchanged (same reference — no allow delta layered), so every existing spawn is byte-identical when no profile is involved.

Role composition (the load-bearing rule): an EXPLICIT caller role — `worker_spawn` → worker, REST/scheduler → manager/platform — ALWAYS wins; the profile supplies role ONLY when the caller didn't specify one (the plain "+New" path) AND the agent has a profile.

Phase-3 model wiring: the profile's `model` (when non-null) is threaded through to the spawn recipe as a `--model <id>` arg. When null/absent it is byte-identical (no `--model`). This applies to the FRESH-start paths only (`startNew`/`startManager`/`startPlatformLead`/`startAuditor`) — a `--resume`/`--fork-session` spawn deliberately omits `--model` and inherits the conversation's model from the engine transcript, keeping every resume/fork byte-identical.

Phase-3 skills wiring: the profile's `skills` subset is resolved here and PINNED on the session row at fresh spawn (like `browserTesting`), then read from the row on resume/fork/recycle/boot — NEVER re-resolved (the profile may have changed). `injectSkills` delivers only the pinned subset; null/empty means all skills (byte-identical to before). An empty subset is normalized to null at the pin sites.

`forcePlain` (P3 spawn override): bypass the profile entirely so role + allow resolve via `resolveProfile`'s backstop — i.e. spawn as if the agent had no profile (a vanilla "+New": role null, no allow delta; the injected prompt is the agent's own either way). The web "Spawn → force plain" menu uses this so a manager/platform-profile agent can still start a coherent plain session, not one carrying a manager role + allowlist it shouldn't have / can't use.

## Do not

- Do not let a profile silently override an EXPLICIT caller role (`worker_spawn`, REST/scheduler) — the caller's role always wins; the profile only supplies role when the caller omitted one.
- Do not thread `--model` on a `--resume`/`--fork-session` spawn — those deliberately inherit the conversation's model from the engine transcript.
- Do not re-resolve the profile's `skills` subset on resume/fork/recycle/boot — read the PINNED value off the session row so a later profile edit can't change what an already-spawned session sees.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveAgentSpawn`'s top-of-function doc): originally lines 2319-2350, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The role-pin `@decision` anchors inside the function body (`760cd01d`/`5603f40f`/`3388be4d`) are separate, already-anchored sites — untouched by this move.
