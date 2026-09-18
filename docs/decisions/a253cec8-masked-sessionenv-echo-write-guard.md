# a253cec8 — reject a masked sessionEnv echo at the config write chokepoint

## Narrative

Every config-returning surface (REST, the Platform Lead's + Setup Assistant's `project_configure`/`project_update`, the manager's `project_update`) masks `sessionEnv` VALUES in its response via `maskSessionEnvRecord` (`@loom/shared`) — same-length bullet filler, card `b2f9ce3a`. That masked response is still a valid write INPUT: feed it straight back (a plain deep-merge or a `replace:true` payload built from "the config I just got back, change one key") and the bullet filler overwrites the real secret. This is worse than an ordinary footgun because it is invisible (the masker is idempotent, so the response is byte-identical before and after the destructive write) and unrecoverable (`Db.recordProjectConfigChange` masks both prior and next in config history too, so history can't hand the real value back either).

`setProjectConfigSafe` (`packages/daemon/src/tasks/columns.ts`) is the ONE chokepoint every config-PATCH writer shares — human REST, Platform Lead, Setup Assistant, and the manager's `project_update` all route through it — so the guard belongs here, below MCP, rather than duplicated per caller (and it then covers every future masked read surface for free, not just the ones known today).

The guard (`isMaskedSessionEnvEcho`, `@loom/shared`) detects the mask SHAPE, not a hardcoded bullet count: a `sessionEnv` value is rejected only when every character is the mask filler char AND its length exactly matches the CURRENTLY STORED value's length at that same key. A brand-new key (no prior value to compare against), a length mismatch, or a value that merely contains the filler character all pass through as legitimate — the predicate is deliberately narrow so a real rotation is never blocked.

The REST PATCH route (`gateway/server.ts`) calls the exact same `setProjectConfigSafe`, so it is covered by construction, not by a second, separately-maintained check.

## Do not

- Do not remove or weaken the reject-on-echo check in `setProjectConfigSafe` — masking a config-returning surface without this guard turns every way an agent (or a human) can read a config into a write hazard the instant that response is fed back.
- Do not duplicate this check at an individual MCP tool or REST handler instead of routing through `setProjectConfigSafe` — that reopens the multi-writer drift this chokepoint exists to prevent (same reasoning as `a0cafef2`).
- Do not widen the predicate to a loose "contains the filler character" check — that would reject a legitimate secret that happens to contain the filler character, which the card's own DoD explicitly requires to keep working.

## Source

Card `a253cec8`, filed by the lead from Code Reviewer `a62245d0`'s CRITICAL finding on card `5d6e0ace`'s branch (execution-confirmed destruction against real `dist`, both via plain deep-merge and `replace:true`). Inline anchor above `setProjectConfigSafe` in `packages/daemon/src/tasks/columns.ts`.
