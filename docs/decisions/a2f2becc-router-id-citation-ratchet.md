# a2f2becc — router id-citation ratchet: discovery, scope, and ownership

## Do not

- Do not read a clean run of `platform-end-user-no-dogfood.mjs`'s section (e) id-citation ratchet alone
  as proof every OTHER `DENY_PATTERNS` hit is gone from these routers — that ratchet scans ONLY the
  "decision/card id citation" pattern. Card `0018c8ab` added a SEPARATE, independent ratchet
  (`ROUTER_NON_ID_HIT_ALLOWLIST`, see Round 5 below) for every other pattern — both must be green.
- Do not lower `ROUTER_ID_CITATION_ALLOWLIST`'s `expectedCount` for a surface/tool without a real landed
  cleanup backing it — the ratchet fails loud on BOTH an increase and a decrease (the stale-entry check),
  so a lowered number with no real strip just moves the failure to the next run.

## Discovery

Card `a2f2becc` found that `PlatformMcpRouter` (surface (d) in `platform-end-user-no-dogfood.mjs`) was
the ONLY router that file scanned for Loom-dogfood/card-id content. The manager/worker/companion router
(`mcp/orchestration.ts`) and the task router (`mcp/server.ts`) also ship to, and are reachable by, every
non-dev end-user install, and carry real "decision/card id citation" hits an end user's agent can't
resolve (e.g. `worker_list` alone carries dozens).

## Measurement provenance

Measured directly off local `main` (investigate-first pass, 2026-11-03) via the exact technique
`SHIPPED_END_USER_MCP_SURFACES.render()` in the test file uses, including the `isSupervised()`
ambient-env correction (`LOOM_SUPERVISED` must be unset for a true non-dev reading). Round 2 (Code
Review `3445c589`) re-measured after widening the id-citation pattern to also catch bare `decision <id>`/
`record <id>` forms, and after rendering each CONFIG-GATED tool's MAXIMAL surface (`deploy` on the
manager — needs a resolved `orchestration.deployCommand`; `peer_message`/`peer_list`/
`peer_message_status` on the manager — need a `project_links` row; `vault_write` on the task router —
needs a `vaultWrite` session) rather than leaving them unregistered and unscanned.

## Other denylist hits found, then fixed by card 0018c8ab

The same investigation surfaced OTHER real denylist hits on several of these routers, outside this
card's approved id-only scope — filed as card `0018c8ab` and fixed there (see Round 5 below for the
full disposition of each):
- a literal `packages/` path on `worker_merge`/`merge_batch`/`gate_status`/`gate_queue`/`served_status`/
  `memory_write` — rewritten generically.
- a literal `daemon_restart` mention on `worker_list`/`worker_spawn`/`worker_stop`/`served_status` (the
  last one found by 0018c8ab's own fuller sweep, beyond what this card's investigation named) —
  reworded to conditional phrasing, a small reasoned residual tracked in `ROUTER_NON_ID_HIT_ALLOWLIST`.
- a "Loom's own home directory" hit on Operator's AND the core task router's `vault_write` — left AS-IS
  (it's correct, per-install-generic text, not a leak); the `DENY_PATTERNS` pattern itself was narrowed
  instead.
- an `@loom/` hit on UserAudit's `list_sessions`/`transcript_read` — dropped (also lowering each tool's
  id-citation baseline by one, since the dropped sentence carried one of those citations too).

## Follow-up ownership

Two follow-up cards own shrinking the ratcheted surfaces toward zero, deleting their own entries in
`ROUTER_ID_CITATION_ALLOWLIST` as they go:
- card `6927a53f` — strip `OrchestrationMcpRouter`'s (manager/worker/assistant) id citations, including
  the `deploy` tool's two citations (card `720bb7ad`, card `bed91595`) baselined by round 2
- card `03249f1e` — strip `TaskMcpRouter`'s (`mcp/server.ts`) id citations; also owns
  `WorkspaceAuditMcpRouter`'s (`user-audit.ts`) id citations (folded in per the manager's own call), and
  any `operator.ts`/`run.ts` hits (none measured today — both are zero-tolerance, not ratcheted)

## Zero-tolerance surfaces

`SetupMcpRouter`, `OperatorMcpRouter`, `RunMcpRouter` and `PlatformMcpRouter` carry NO entries in
`ROUTER_ID_CITATION_ALLOWLIST` — all four are fully clean (Setup's hits were stripped inline by this same
card's round 1; Platform's were stripped by `f437d4e9` C6; round 2 additionally stripped a `record
509176c8` bare citation found on both Setup's and Platform's `profile_update`/`profile_create` once the
id-citation pattern widened to catch that shape; Operator/Run measured zero on investigation).

## Round 3 — structural coverage, replacing a hand-maintained render list

Round 2's Code Review returned ANOTHER-ROUND on coverage for the second time, each prior round having
patched a hole found by hand. Round 3 makes the coverage STRUCTURAL instead of hand-maintained:
`expectedToolNamesFromSource()` regex-scans every literal `.registerTool("<name>"` call out of each
shipped router's own source file(s) — `ROUTER_SOURCE_FILE_GROUPS` in the test names which file(s) back
each surface label, including `companion/capabilities.ts` for `OrchestrationMcpRouter`'s companion levers
and `decisions.ts`/`transcript-read.ts`/`repo-read.ts` for the routers that import shared registration
helpers from them. After the render loop, the union of every surface's render in a file group is asserted
to cover every one of those literal names, minus a reasoned `ROUTER_COVERAGE_EXCLUSIONS` entry
(`daemon_restart`: `isSupervised()`-gated, never on this test's non-supervised end-user premise).

Two render gaps this scan immediately surfaced, now closed: the `OrchestrationMcpRouter(assistant)`
surface sets `companionSessionIds` (the `chat_reply`/`skill_*`/`memory_*`/`reminder_*` gate) AND
`companionLeadMode:true` on the session row — the latter synthesizes a full act-mode
`ResolvedGrantScope` for every `companion/capabilities.ts` lever at once
(`synthesizeLeadModeScope`, gated only on `db.listAllProjects()` being non-empty), which is far simpler
than hand-granting each of the nine `COMPANION_CAPABILITY_SLUGS` individually and renders every companion
lever tool (`sessions_status`, `decisions_list`/`decision_resolve`, `board_*`, `authored_content_grant`,
`vault_lookup`, `send_media`, `session_message`/`session_steer`/`session_stop`/`session_resume`,
`transcript_read`, `session_spawn`, `git_commit`/`git_push`) in one shot. The `TaskMcpRouter(manager)`
surface also pins a `connections` entry so `authenticated_request` (config-gated on a non-empty
`session.connections`, `mcp/server.ts`) registers too. Neither set of newly-rendered tools carries any id
citation — all pass the ratchet's implicit zero-tolerance default, no new allowlist entries needed.

`assertAllowlistEntriesSeen()` closes a separate gap: the live loop only ever iterated the tools that DID
render, so a baselined `(surface, tool)` entry whose gating config silently stopped rendering (renamed,
removed, or its config line dropped) was never checked at all rather than failing. It now asserts every
`ROUTER_ID_CITATION_ALLOWLIST` entry was actually present in its surface's own render.

`scanSurfaceRatchet()` is now the ONE function the live loop and every positive control route through —
previously the live loop and the controls both called `ratchetVerdict` independently, so a mutant
corrupting a wrapper only the live loop used could silently stop catching regressions while the controls,
computing their own verdict separately, kept passing.

Proved RED (temporary in-file edits, reverted before committing): m3 (hardcode `ok:true` inside
`scanSurfaceRatchet` — all three positive controls go red, not just the live loop); m6 (drop the
`deployCommand` config line from the manager render — `deploy` fails both the allowlist-seen check and
structural coverage); m7 (drop `vaultWrite:true` from both `TaskMcpRouter` renders — `vault_write` fails
structural coverage); an unrendered-tool mutant (drop the `RunMcpRouter` render scenario entirely —
`submit_result` is reported missing from `RunMcpRouter`'s structural coverage).

### Do not (round 3)

- Do not read a clean structural-coverage pass as proof every tool's id-citation COUNT is correct — it
  only proves every literal `registerTool()` name in a file group was rendered by SOME surface in that
  group at least once; the per-tool citation count is still the separate `ROUTER_ID_CITATION_ALLOWLIST`
  ratchet.
- Do not add a new render scenario to `SHIPPED_END_USER_MCP_SURFACES` without checking
  `fileGroupForSurfaceLabel()` resolves its label — an unmapped label throws rather than silently
  skipping coverage for it, which is deliberate, but extend `ROUTER_SOURCE_FILE_GROUPS` rather than work
  around the throw.

## Round 4 — PlatformMcpRouter joins structural coverage; the group list itself is now meta-checked

Round 3's own Code Review found the hole it left: `PlatformMcpRouter` (end-user-shipped, `mcp/platform.ts`)
was in NO `ROUTER_SOURCE_FILE_GROUPS` entry, and the group list itself was hand-maintained with nothing
checking whether every `.registerTool(`-carrying file in the repo was actually named somewhere in it. The
reviewer proved the escape directly: a config-gated `registerTool("zz_probe", {description:"probe card
00000000"})` added to `platform.ts`, gated behind a condition that never holds in this test, rendered
nothing and left the whole file green.

Fixed two ways:
- `ROUTER_SOURCE_FILE_GROUPS.PlatformMcpRouter = ["mcp/platform.ts"]`, fed by section (d)'s EXISTING
  non-dev render (the one `assertClean`'s full-denylist scan already uses) — not a new render scenario;
  `PlatformMcpRouter` is not, and does not need to be, added to `SHIPPED_END_USER_MCP_SURFACES`. Paired
  with a `ROUTER_COVERAGE_EXCLUSIONS` entry for `daemon_restart` (`isLoomDev()`-gated — the Lead-surface
  twin of the manager's own `isSupervised()`-gated exclusion).
- A META-CHECK: a plain source-text walk of every `packages/daemon/src/**/*.ts` file asserts that any file
  containing a literal `.registerTool(` call is named in SOME `ROUTER_SOURCE_FILE_GROUPS` entry, or carries
  a reasoned `FILE_LEVEL_COVERAGE_EXCLUSIONS` entry. Today that exclusion list is exactly `mcp/audit.ts`
  (`AuditMcpRouter`, the `LOOM_DEV`-only Platform Auditor seed, structurally unreachable on a real
  end-user install — same posture as the header's existing note on why `audit.ts` is absent from
  `SHIPPED_END_USER_MCP_SURFACES`). This is what actually closes the round-3 hole going forward: a BRAND
  NEW router/helper file nobody adds to a group now fails loud instead of silently escaping both this
  check and the structural-coverage scan above it.

Also closed (task d of this round): `gate_cancel` is registered via TWO separate literal
`registerTool("gate_cancel"...)` call sites in `mcp/orchestration.ts` (manager and worker) — these
collapse to ONE name in the cross-surface union the structural-coverage check uses, so "covered by the
union" alone doesn't prove both call sites render. Added an explicit check that both the manager AND
worker surfaces independently rendered `gate_cancel`. Also added a one-line comment on the
`WorkspaceAuditMcpRouter` group noting that `repo-read.ts` mixes in its `LOOM_DEV`-only dev variant's
registrations under the SAME three literal tool names (`repo_read_file`/`repo_grep`/`repo_glob`) as the
end-user variant — the structural-coverage scan can't tell the two call sites apart by name, so a reader
should not assume "covered" here means "the end-user variant specifically was what rendered it."

Proved RED (temporary edits, reverted before committing; `src` and `dist` both rebuilt back to
cmp-identical, confirmed via `git status --porcelain` showing no diff):
- a gated (`if (false)`) `zz_probe` added to `mcp/platform.ts` — RED: "(coverage) PlatformMcpRouter ...
  missing: zz_probe" — reproducing the exact round-3 Code Review finding, now caught.
- a brand-new, never-imported helper file (`mcp/_temp-mutant-unlisted.ts`) carrying a literal
  `.registerTool(` call — RED: "(meta-check) ... unaccounted: mcp/_temp-mutant-unlisted.ts".
- temporarily emptying `ROUTER_SOURCE_FILE_GROUPS.PlatformMcpRouter` to `[]` (a test-file-only edit, no
  rebuild needed) — RED: "(meta-check) ... unaccounted: mcp/platform.ts" (plus the expected downstream
  stale-exclusion sanity failure on the now-empty expected set).

### Do not (round 4)

- Do not add a duplicate `PlatformMcpRouter` render scenario to `SHIPPED_END_USER_MCP_SURFACES` — its
  structural coverage deliberately rides on section (d)'s existing non-dev render; a second render would
  just re-exercise the same code path for no new coverage.
- Do not add a new router/helper file under `packages/daemon/src/**` that calls `.registerTool(` without
  either naming it in a `ROUTER_SOURCE_FILE_GROUPS` entry or adding a reasoned
  `FILE_LEVEL_COVERAGE_EXCLUSIONS` entry — the meta-check fails loud on either omission, by design; don't
  "fix" a failure here by widening the exclusion list for a tool that SHOULD actually be covered by a
  real render.

## Round 5 (card 0018c8ab) — the non-id denylist hits this card's own investigation found, fixed

Owner-approved disposition, per surface/tool/pattern (the full per-hit classification lives in the
card's own `worker_report` history, not restated here):

- **Illustrative examples hardcoding this repo's own path/package/command** (`worker_merge`'s
  `pathLiteral`/`pathGlob` doc example, `merge_batch`'s scope-example, `memory_write`'s `triggerGlob`
  example, `deploy`'s gate-command example) — rewritten to a generic placeholder; zero behavior lost,
  the field/shape documentation is unchanged.
- **Mechanism disclosure for a feature hardcoded to this repo's own package layout** (`gate_status`'s
  `emitCompareReduced`/`retriedFile` docs, `merge_batch`'s own reduction-scope statement, `served_status`'s
  backend/shared/web source-tree distinctions) — the DISCLOSED FACT survives (an end-user still learns
  why a field reads `undefined`/stays inert for them); only the literal internal package-path tokens were
  replaced with structural phrasing ("this daemon's own backend/shared-contract source", "the served web
  UI bundle", etc).
- **Actively wrong/inapplicable advice for an end-user install** — `gate_queue`'s recommendation to run
  two `packages/daemon/scripts/*.mjs` dev-tree scripts (never shipped to an npm install) was replaced
  with generic "a whole-box CPU check / a worktree-scoped attribution check, if your install has one";
  `served_status`'s "`pnpm daemon:stable` relaunch" (a dev-only self-hosting command) became "a human
  relaunch of the daemon".
- **`daemon_restart` naming a tool the reader may not have** (`worker_list`/`worker_spawn`/`worker_stop`,
  plus `served_status` — found by this card's own fuller, full-`DENY_PATTERNS` sweep, which the a2f2becc
  investigation's narrower id-only pass never ran) — reworded to the SAME conditional phrasing
  `SKILL_SURFACE_ALLOWLIST`'s `orchestrate/SKILL.md` entry above already uses and a Code Review already
  approved: "via `daemon_restart` where your surface has it, or a human relaunch otherwise". The literal
  token still appears (by design — a REAL, reasoned residual, not backlog) and is tracked, with its
  one-line reason, in the new `ROUTER_NON_ID_HIT_ALLOWLIST` ratchet.
- **Internal source-file pointers with no reader value outside this repo's dev workflow**
  (`worker_list`/`worker_recycle`/`worker_merge_confirm`'s `git/worktrees.ts` citations,
  `list_sessions`/`transcript_read`'s `@loom/shared` pointer) — dropped outright; none of these described
  output shape or behavior, only an implementation location.
- **`vault_write`'s "Loom's own [operational] home directory" text — a FALSE POSITIVE, left as-is.**
  Verified against the real implementation (`companion/capabilities.ts`, `gateway/server.ts`) that this
  means the per-install `LOOM_HOME` every install has (dev or end-user alike), never the reserved
  dev-home PROJECT the sibling "dev reserved-home name in context" pattern already covers — accurate,
  useful, generic text. Fixed the DENYLIST instead: removed "home" from the `"Loom's own" repo/dev-
  process artifact` pattern's alternation (it had zero real-corpus backing, unlike every sibling noun,
  which the self-check quotes verbatim from `CLAUDE.md`). Negative control: the real `vault_write` text
  (both wordings) no longer trips the narrowed pattern. Positive control: the SEPARATE dev-reserved-home-
  PROJECT pattern (`devHomeRe`, unaffected by this narrowing) still trips on a bare "Loom Platform"
  (no role suffix).

**The new `ROUTER_NON_ID_HIT_ALLOWLIST` ratchet** (same file) mirrors `ROUTER_ID_CITATION_ALLOWLIST`'s
own posture — exact-count per (surface, tool, pattern), fails loud on increase AND decrease — but ADDS a
REQUIRED one-line `reason` per entry (the id-citation ratchet has no such requirement, since every one of
its entries is backlog by definition; every entry here is instead a deliberate, reasoned choice). Seeded
at today's real post-fix counts: `worker_list`/`served_status` at 2 each, `worker_spawn` at 2,
`worker_stop` at 1 — all four `daemon_restart tool name`, all four the SAME conditional-phrasing reason.
Every other (surface, tool, pattern) combination is implicitly `expectedCount:0`.

Proved RED (temporary in-file edits to the BUILT `dist/mcp/orchestration.js`, reverted before
committing, `git status --porcelain` confirmed clean after): reverting `worker_list`'s conditional
phrasing back to a bare `daemon_restart` mention with a DIFFERENT surrounding sentence (so the COUNT
stays 2 but the specific match context changes) still passes (count-only ratchet, correct); dropping
the baselined entry's `expectedCount` to 0 while the real text still carries 2 mentions goes RED on the
live non-id ratchet check for `worker_list`; separately, restoring the pre-narrowing `DENY_PATTERNS`
(re-adding `|home` to the alternation) makes the new negative-control self-check for `vault_write`'s
real text go RED, confirming that self-check can actually fail.

### Do not (round 5)

- Do not fold `ROUTER_NON_ID_HIT_ALLOWLIST` into `ROUTER_ID_CITATION_ALLOWLIST` — they track different
  kinds of drift and a merged table would lose the required-`reason` discipline the non-id one enforces.
- Do not add a new `daemon_restart`-naming (or any other non-id DENY_PATTERNS) hit to a tool's
  description without either rewriting it generically/conditionally or adding a REASONED entry here —
  an unreasoned entry defeats the whole point of this ratchet being "small and deliberate", not backlog.
- Do not re-add "home" to the `"Loom's own"` pattern's alternation without re-deriving a REAL corpus
  example backing it first (same discipline every sibling noun in that alternation already has) — it was
  removed for having none, and silently re-adding it reopens the exact false positive this round closed.
