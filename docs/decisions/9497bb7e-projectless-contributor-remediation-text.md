# 9497bb7e — name the real escape for a stranded projectless quarantine contributor, then build it

From CR3 of `6de79dc0` (session `d839b41f`), finding 2 plus its own follow-up, plus a dead-end text folded
in from `1872935d`'s CR (session `b100ff5a`), triage note 2026-10-27.

## The stranding

A union entry with a BROAD (`undefined`) `genuineContributorKeys` — a LEGACY entry predating the field, or
a post-`6de79dc0` entry demoted by the unreadable-at-boot reingest — refuses every REST clear route for
its primary `S` whenever a contributor `R` is still folded in (`selfClearRefusesForStaleKeyContributors`'s
broad fallback). `clear-by-path(R)` cannot reduce `S`'s membership of `R` either (`1872935d`'s "route
asymmetry": `clearMergeQuarantineByRecordedPath` matches only an entry's own STORED `repoPath`).

## Phase 1 (text/disclosure only, no refusal-decision change)

Two texts were inaccurate: `remediationTextFor`'s `noHonestClearByPathTarget` branch named the
project-resolved `/clear` route unconditionally, though it only works when a project IS registered at the
contributor's own path (`merge-quarantine.ts` has no project-registry visibility). `stillQuarantinedReason`'s
"ANOTHER repo's own, separate quarantine" branch unconditionally suggested clear-by-path on the HOST's own
path — a dead end once that self-clear already refuses (the 2026-10-27 triage note's exact shape). Both now
hedge/redirect honestly; `stillQuarantinedReason` checks `selfClearRefusesForStaleKeyContributors(after)`
and returns the SAME `remediationTextFor` text the real refusal gives.

## Phase 2 — `POST /internal/merge-quarantine/clear-broad-union` (manager-approved design)

The one supported, auditable escape, superseding the manual file delete as the PRIMARY route (demoted to
a LAST RESORT if this route is itself unavailable or also refuses). Loopback + the SAME
`isGuardedInternalWrite` bearer tier `/clear`/`/clear-by-path` use; registered ONLY in `gateway/server.ts`
— NO MCP tool anywhere, including the Platform Lead's elevated surface (confirmed: zero `mcp/*.ts` hits;
`agent-prompt-lint-surface-drift.mjs`/`surface-subset.mjs`/`platform-elevated-surface.mjs` all green).

`clearBroadUnion(repoPath, confirmPaths, dryRun)` (`git/merge-quarantine.ts`) owns every decision: matches
an ACTIVE entry via the SAME identity tier `clearMergeQuarantineByRecordedPath` uses, refusing unless
`selfClearRefusesForStaleKeyContributors` fires for it; then refuses on `provenanceUnknown`, on
`isUnreadablePlaceholderEntry(entry)`, and on any tied PENDING twin of the same identity (CR round 1 —
see findings). `computeBroadUnionVictimSet(entry)` — a SCOPED SUBSET of `clearMergeQuarantineByKey`'s own
real candidate set, never the full thing — feeds BOTH the `dryRun` preview and the real call's EXACT-match
`confirmPaths` check (never subset/superset; a membership change since a dry run makes the fresh set
differ and this refuses — the TOCTOU defense). On a match, deletion reuses `clearMergeQuarantineByKey`
UNCONDITIONALLY. `composeBroadUnionClearResult` passes through every disclosure field (mirroring
`/clear-by-path`, decisions `f5c42043`/`182c01cc`) PLUS a POST-CLEAR BACKSTOP: a lifted-but-unconfirmed
identity is never a bare `ok` — it carries `unconfirmedLifted` + a warning.

On success, files a NEW audit-only `OrchestrationEventKind`, `merge_quarantine_broad_union_cleared`
(`managerSessionId:""`, mirrors `mainline_moved_outside_loom`'s sentinel; `detail` is `{repoPath,
confirmPaths}` plus the WHOLE `clearBroadUnion` result via one `...rest` spread shared with the REST
response) — excluded from EVENT_TRIGGER_EVENT_KINDS/GATE_HISTORY_KINDS/ORCH_ACTIVITY_KINDS/
REPORT_RESOLVED_EVENT_KINDS, same reasoning as `codex_auto_commit`. `dryRun:true` writes no event.

**CR rounds 1 and 3 (BLOCKING, all fixed)** — full repro, probes, and fixes:
`docs/investigations/9497bb7e-projectless-contributor-remediation-text/findings.md`.

## Do not

- Do not name the project-resolved `/clear` route without the "IF one is registered there" hedge, or omit
  the Phase 2 route/manual-edit fallback.
- Do not suggest clear-by-path on a host's own `repoPath` from `stillQuarantinedReason` without checking
  `selfClearRefusesForStaleKeyContributors(after)` first.
- Do not expose `clearBroadUnion`/the route on any MCP surface, ever, including the Platform Lead's
  elevated one — a materially different risk than `git_checkout`/`vault_write`, which that surface carries.
- Do not accept a client-supplied victim set for the real clear — always recompute and require an EXACT
  match; never a subset or superset, and never relax either half (each is independently load-bearing).
- Do not widen `clearBroadUnion`'s match beyond what `selfClearRefusesForStaleKeyContributors` refuses for,
  and do not let it proceed on `provenanceUnknown`.
- Do not file the event on a `dryRun` call, or before the real delete has actually succeeded.
- Do not let `computeBroadUnionVictimSet` claim to be the FULL candidate computation — it is a scoped
  subset, safe only because the placeholder-reconcile and tied-pending-twin shapes are separately refused.
- Do not name `clear-broad-union` in ANY remediation text without computing
  `broadUnionTargetFor(repoPath).accepts` first — never guess or hedge as a substitute.
- Do not add the tied-pending-twin shape to `(text-d)`'s enumeration — `resolveQuarantineFor`'s own
  graduation resolves it away before any text-building call site runs; see `(text-e)` + findings instead.
  Graduation explains only this exclusion, not general agreement — that is BY CONSTRUCTION
  (`broadUnionTargetFor`), true for clear-by-id's ambiguous-latch refusal, which never graduates.
- Do not hand-pick fields forwarding `clearBroadUnion`'s result into the response/event — spread the whole
  result in both, or a future field silently reaches one but not the other.
