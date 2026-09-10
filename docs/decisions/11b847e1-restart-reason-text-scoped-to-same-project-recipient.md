# 11b847e1 — a restart's free-text reason is redacted for a cross-project recipient (Platform Lead exempt)

## Narrative

Card 11b847e1 addressed a cross-project information leak in the boot-resume nudge. `intent.reason` is
FREE TEXT a manager types when calling `daemon_restart` — unlike `RESTART_ORIGIN_AGENT`/`UNKNOWN` (bounded,
identity-free by construction), a reason can accidentally name a project, a card, or a person (e.g.
"deploying the memory fix for the Codescape board"). That notice fans out to every OTHER manager/Lead
across the WHOLE fleet, in every OTHER project — so passing the raw text through unconditionally leaks
one project's internal detail to another project's manager.

Fix: `reasonClauseFor` scopes the raw reason text (and therefore any SHA extracted from it) to a
recipient in the SAME project as the session that actually requested the restart — read from
`intent.managerSessionId`'s own project, never the resuming recipient's own (which would trivially
"match" itself). Every other recipient gets nothing in its place; the separate `RESTART_ORIGIN_*`
classification already answers the only thing a cross-project recipient can act on ("did an agent I
don't know cause this"). This mirrors the same cross-project scoping precedent `worktreeNoteFor`
established (card `7d3899cb` DoD-5).

**Platform Lead carve-out** (manager-review follow-up to this card): the Lead is deliberately exempt from
this redaction. The isolation boundary the scoping protects is specifically "one project's MANAGER must
not learn what another project is doing" (card `5a9a963b`) — the Lead sits ABOVE all projects by design
and already holds cross-project reads elsewhere (`list_all_sessions` and similar), so withholding the
reason from it would be pure capability degradation for the one recipient whose job actually requires
cross-project visibility.

Because the SHA-delivered-dedup record (card `066d317c`) must follow the same condition as what text is
actually shown, a cross-project manager recipient that gets the redacted (reason-free) branch must NOT
have its SHA recorded either — recording it there would reintroduce exactly the bug `066d317c` fixed.

## Do not

- Do not pass `intent.reason` (or any SHA extracted from it) to a manager recipient outside the
  requesting session's own project — redact it via `reasonClauseFor`.
- Do not apply that redaction to the Platform Lead — it is exempt by design, not an oversight.
- Do not record a delivered SHA for a recipient that was given the redacted (reason-free) branch — see
  `066d317c`.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4410-4411,
as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `service.ts` lines
4601-4612 and 4744-4761, which implement/document the same scoping and carve-out.
