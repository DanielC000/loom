# e98877b1 — On an agent-row-missing resume, still apply the role-keyed permission-mode pin

## Narrative

Re-resolve the agent's spawn so a resumed session keeps its profile's LAYERED allowlist (allowDelta), not the bare config.permission — a profile-pinned worker/manager loses its allow entries on every resume otherwise. The role is the row's locked role (NOT the profile's, so an explicit-role session resumes byte-identically). Model is DELIBERATELY omitted on resume — `--resume` inherits the transcript's model. Agent-missing (deleted) ⇒ fall back to bare config.permission — but STILL apply the role-keyed startupModeCycles pin (card e98877b1) via `withRolePermissionModeCyclesPin`, keyed off `session.role` (the row's PINNED value, which survives the agent row's deletion) rather than re-deriving it from the (now-absent) agent. A profile's layered allowDelta is genuinely lost on this fallback (there's no profile to re-read), but the pin itself is role-derived, not profile-derived, so it has no such dependency and shouldn't be dropped with it.

## Do not

- Do not derive the resume-time permission for a session whose agent row has been deleted from bare `config.permission` alone — always re-apply the role-keyed `startupModeCycles` pin via `withRolePermissionModeCyclesPin(config.permission, session.role)`, keyed off the session row's own pinned role, so the pin survives the agent's deletion.

## Source

Originally an inline comment in `packages/daemon/src/sessions/service.ts` (`resume()`), lines 3902-3911 as of commit `9818aa2627c6f58c26aaaec6fc33d70c468c3943`. Relocated by card `3c50eae9` under the `docs/adr/92cfc09e` comment-taxonomy convention. No wording changed; wrapped source lines were joined into a flowing paragraph and the `//` comment markers stripped. See also `docs/decisions/760cd01d-pin-worker-and-assistant-boot-mode-to-auto.md`, the sibling worker/assistant pin this fix restored on the fresh-spawn path.
