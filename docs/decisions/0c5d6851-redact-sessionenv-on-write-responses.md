# 0c5d6851 — redact `config.sessionEnv` on the 4 project-returning WRITE responses

## Narrative

Card `a5ecb6fd` masked `config.sessionEnv` on `GET /api/projects` (via `redactSessionEnvForRead`), but four WRITE routes that also return a full `Project` — `POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/projects/:id/restore`, `PATCH /api/projects/:id/config` — kept returning it unredacted. `redactSessionEnvForRead`'s own doc comment deliberately paused widening it to other routes without first re-checking their consumers, because a write response feeds the UI's own post-save state: a consumer that reads `config.sessionEnv` back to refresh local state or seed an editor could feed masked filler into a subsequent write, overwriting a live secret (specimens: cards `af08f7e8`, `e4e854cc`).

Phase 1 (worker `9adfae08`) enumerated every `packages/web/src` consumer of all four routes at source (`grep` for `\.sessionEnv\b` in `packages/web/src`, plus every call site of `api.createProject`/`updateProject`/`restoreProject`/`updateProjectConfig`):

- `POST /api/projects` and `POST /api/projects/:id/restore`: no consumer reads `.config` off the response at all (only `.id`/`.name`, or nothing).
- `PATCH /api/projects/:id`: `Settings.tsx`'s `RepoPathEditor` writes the raw response straight into the shared `["projects"]` react-query cache (`qc.setQueryData`) — a second, previously-unnamed specimen of the exact cache-repopulation hazard the card flagged only for the config route.
- `PATCH /api/projects/:id/config`: `Settings.tsx`'s `ConfigEditor` DOES read `config.sessionEnv` back (`seedSessionEnvRows(updated.config.sessionEnv)`), and ALSO does the same `qc.setQueryData(["projects"], ...)` cache write (the card's cited "sharpest member").

The one real consumer (`ConfigEditor`'s `seedSessionEnvRows`, card `32b23f0f`'s write-only sessionEnv editor) was proven structurally incapable of re-emitting a masked value: it extracts only `value.length` into `storedLength`, always sets the row's own `value` to `""`, and the editor's own save payload (`buildOverride`) is built purely from local `sessionEnvRows` component state — the server response never re-enters the wire. `redactSessionEnvForRead`'s mask is same-length filler (`"•".repeat(String(value ?? "").length)`), so it preserves `.length` exactly, including for a value containing surrogate pairs (`•` is one UTF-16 code unit). So masking these four responses cannot break the one genuine consumer and closes the `["projects"]` cache-repopulation gap on both routes that write to it.

## Fix

All four routes now return `redactSessionEnvForRead(...)` instead of the raw `Project`/`Db.getProject(...)` result.

## Do not

- Do not add a consumer of any of these four routes' responses that reads `config.sessionEnv` for anything beyond `.length` without re-running the consumer analysis above — in particular, never let a client re-submit a value read from one of these responses as a literal `sessionEnv` write.
- Do not treat `seedSessionEnvRows`' write-only design (card `32b23f0f`) as incidental protection here — it is the reason redaction is safe on the config route, not a coincidence; if that editor is ever changed to display or round-trip a stored value, this redaction must be re-audited against the new consumer.

## Source

Card `0c5d6851`, split from `6bfc3bfb` by the lead (2026-09-18) on that card's own DoD-0. Consumer enumeration: worker `9adfae08` (session `01UWbZbtDWrJQCBWhTQvHfd5`), Phase 1, 2026-09-18.
