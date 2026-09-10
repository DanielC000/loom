# 3e9e1d9f — `worker_spawn`'s `taskId` accepts an unambiguous 8-char id-prefix, mirroring `agentId`

## Narrative

Card 3e9e1d9f: `worker_spawn`'s `taskId` accepts EITHER a full id or an unambiguous 8-char id-PREFIX
(`resolveIdPrefix`) — the same UX the `agentId` path in the same function already has. An exact match
still wins first (the common case avoids materializing the project's whole task list); a miss falls back
to prefix-scanning THIS manager's OWN project's tasks (`db.listTasks(manager.projectId)`), so a
cross-project id can never match. An ambiguous prefix names the candidate ids and spawns nothing,
mirroring the `agentId` ambiguity error.

## Do not

- Do not prefix-scan across projects — fall back only to `db.listTasks(manager.projectId)`, the
  manager's own project, so a cross-project id prefix can never resolve.
- Do not silently pick one candidate on an ambiguous prefix match — name the candidates and spawn
  nothing, matching the `agentId` path's own ambiguity handling.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s taskId resolution): lines
5880-5884, as of commit `9040c317a8ac756dd7908d9293fb5186ef18e2dc` (`fix(orchestration): resolve
worker_spawn's taskId by 8-char prefix (mirror the agentId resolveIdPrefix)`). Relocated by card
`61632c05` (tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph and
the `//` comment markers stripped.
