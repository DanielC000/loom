# f4d04609 — scope-denial message names the missing capability

## Narrative

`scopeDenialMessage` (`packages/daemon/src/companion/capabilities.ts`) exists to distinguish a project
that's totally ungranted from one that's granted for a *different* capability but not the one the caller
just tried to use. Every belt-and-suspenders per-project scope denial in the file (Framework §2) routes
through this helper so the error names WHICH capability is missing, instead of a collapsed "not in your
granted scope" that reads identically whether the project has no access at all or just lacks this one
lever.

This was a Platform Auditor finding (session `5db71873`): `sessions_status` on a project succeeded while
`board_list` on the SAME project returned the plain message, with nothing surfacing that the two levers
are independently scoped — a partial grant is easy to mistake for full access.

`label` names the project reference in the message (defaults to `project "<id>"`; a caller that resolved
the project from a task/question/session id instead of a bare `project` param passes its own label, e.g.
"this task's project"). The helper reads the session's WHOLE grant set (every capability, every project)
purely descriptively — it never widens or itself decides scope.

## Fallback behavior

Falls back to the plain message (byte-identical to before this fix) when the store can't list grants, or
when the project genuinely has no OTHER capability grant either — a fully-ungranted project's error is
unchanged.

## Source

Introduced by commit `f4d04609` ("fix(companion): name the missing capability when a partial project
grant denies a read", 2026-07-17). No board card — the introducing commit's own message and session
`5db71873` are the only provenance; this is why the anchor is keyed on the commit sha rather than a card
id (see CLAUDE.md's `sha:` decision-anchor sigil).
