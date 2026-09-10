# a933613e — two unrelated decisions share this card id

`decision-records.mjs`'s `resolveRecord()` resolves an id to exactly one file, so a second
decision that happens to cite the same card id is appended here as its own section rather than
creating a second, permanently-shadowed record. See `docs/extraction-program.md` § "One record
file per id" for why.

## Decision A — RECOVERABLE_ROLE_MAP is a Record<SessionRole, boolean>, not a bare array

### Narrative

Card a933613e: `RECOVERABLE_ROLE_MAP` in `crash-recovery-watcher.ts` is expressed as a
`Record<SessionRole, boolean>`, not a bare `SessionRole[]` array, so that a FUTURE `SessionRole`
addition to `SESSION_ROLES` (`shared/src/types.ts`) fails to COMPILE here until this map picks a
disposition for it — `RECOVERABLE_ROLES` (the array the watcher actually iterates) is DERIVED from
the map, never hand-edited.

This is exactly what `operator` needed and didn't have: it was added to `SESSION_ROLES` a month
after this list was first authored, the old array type (`SessionRole[]`) permitted the now-stale
subset with zero diagnostics, and the comment above it read as exhaustive without ever being
re-verified — `operator` silently fell outside crash-recovery coverage for that whole month, with
nothing forcing anyone to notice.

### Do not

- Do not revert `RECOVERABLE_ROLE_MAP` to a bare `SessionRole[]` array — that reopens exactly the
  silent-omission gap that let `operator` go unrecovered for a month.
- Do not hand-edit `RECOVERABLE_ROLES` — it must stay DERIVED from `RECOVERABLE_ROLE_MAP`, or the
  compile-time exhaustiveness check this guard exists for is defeated.

### Source

JSDoc comment in `packages/daemon/src/orchestration/crash-recovery-watcher.ts`, above
`RECOVERABLE_ROLE_MAP`: lines 10-32, as of this tranche's HEAD (crash-recovery-watcher.ts,
tranche 1).

## Decision B — `operator`/`assistant` are absent from the setup profile allowlist, but not as elevated roles (unrelated decision, same card id, `mcp/setup.ts`)

### Narrative

`SetupMcpRouter`'s `setupRoleError` (`mcp/setup.ts`) restricts a profile minted/edited through the
ungated setup surface to `manager|worker|setup|null`. `platform`/`auditor`/`workspace-auditor` are
excluded because they're elevated. `operator` and `assistant` are ALSO excluded from that
allowlist, but for an unrelated reason: neither is elevated (`assistant`'s whole surface is
`my_context` + the companion-gated `chat_reply`; see `roleDisplay.tsx`) — their SESSION role is
instead always locked by an explicit human/internal caller role at their own `start*` path
(`startOperator` / the assistant spawn path), never by this profile field alone. This is the same
mechanism `PROFILE_SPAWNABLE_ROLES` documents in `sessions/service.ts`, so minting a profile with
one of these roles here would be inert (or misleading) rather than unsafe.

This is recorded so `setupRoleError`'s own "elevated roles only" framing doesn't read as the
complete story on its own, the way Decision A's own allowlist silently didn't for a month before
that note existed — the same silent-gap shape (a plausible-looking allowlist rationale that
quietly stops being exhaustive once a new role is added, with nothing forcing a re-check), which is
why this section cites the same card.

### Do not

- Do not read `setupRoleError`'s allowlist as "everything excluded is elevated" — `operator` and
  `assistant` are excluded for a structurally different reason (session role locked at spawn, not
  by this field), and a future edit that merges the two rationales risks silently widening the
  allowlist to a role that's locked-but-not-elevated for the wrong reason.
- Do not assume adding a role to `SETUP_ALLOWED_PROFILE_ROLES` is safe without checking whether its
  session role is ALSO locked at an explicit spawn path (`PROFILE_SPAWNABLE_ROLES`,
  `sessions/service.ts`) — minting a profile alone would be inert or misleading for such a role.

### Source

JSDoc comment above `SETUP_ALLOWED_PROFILE_ROLES` in `packages/daemon/src/mcp/setup.ts`, lines
31-50 as of this tranche's HEAD (`mcp/setup.ts`, tranche 1).
