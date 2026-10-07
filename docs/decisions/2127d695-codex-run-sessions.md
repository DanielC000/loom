# 2127d695 — a codex "run" session is legitimate; the isolation-gap nudge stays a durable-row-only residual

## Background

Card `acd3c688` (round 2) found that `startRun` (`sessions/service.ts`) does NOT hardcode every
`AGENT_FORBIDDEN_PROFILE_KEYS` field the way the other five do — it threads the profile-resolved `harness`
for real, onto both the session row and the `pty.spawn()` opts (card `56e6c046`). Because `"run"` is not a
`TRANSCRIPT_ROOT_DENY_ROLES` member (`profiles/codex-compat.ts:39`), `resolveAgentSpawn`'s `roleForcesClaude`
(`sessions/service.ts`) never redirects it back to claude the way it does for manager/platform/auditor/
workspace-auditor/setup. `acd3c688` deferred the actual question — should it? — to "a separate card (the
lead's own follow-up)". This is that card.

## The ruling

**A codex "run" session is legitimate.** Do not add `"run"` to `TRANSCRIPT_ROOT_DENY_ROLES` (or any other
claude-force mechanism), and do not route it through `codexIncompatibilities()`.

**Why — the two things a codex run session might plausibly lose, both checked at source, neither holding:**

1. **The blanket cross-project transcript-root deny** (`withTranscriptRootDenyForSpawn`, `pty/host.ts`) —
   loses nothing, because a **claude** `"run"` session never had this protection either.
   `docs/decisions/ac90ca8e`'s own "Do not" section: "Do not add `run` to `TRANSCRIPT_ROOT_DENY_ROLES` —
   its exclusion is deliberate (`runs/prompt.ts` ingests untrusted input by design) and was never reopened
   by the later role-split card." Codex and claude are in exact parity here — zero new loss, because there
   was never anything to lose for this role in the first place. The roles that DO get force-redirected to
   claude (manager/platform/auditor/workspace-auditor/setup) are force-redirected *because* they hold this
   real, claude-only protection that codex cannot replicate; `"run"` never held it, so there is nothing for
   a force to preserve.
2. **The MCP tool-call approval question** (can a codex `"run"` session even call its own `loom-run` tool
   under codex's `-a never` blanket deny) — already settled favorably, by a different card, on its own
   argument: `CODEX_AUTO_APPROVE_MCP_SERVER_IDS` already includes `loom-run` (card `cea3cec6`, folded into
   `docs/decisions/90dc3c8c`), granted as **exact claude parity** — `loom-run`'s entire tool surface is the
   single, self-terminating `submit_result` tool, the narrowest surface of any role that record discusses.
   That record never discusses `TRANSCRIPT_ROOT_DENY_ROLES` or the isolation-gap nudge below — it answered
   a different, narrower question than this card does.

The harness choice itself is a human-only lever (`profile.harness` is set by a human via Profiles UI/REST,
never an agent MCP tool) — whoever pinned `"codex"` on a `"run"`-endpoint agent's profile chose it
deliberately, same trust tier as every other explicit-harness choice in this codebase.

## Two rejected options

**Rejected: add `"run"` to `TRANSCRIPT_ROOT_DENY_ROLES` / the claude-force set.**
- `docs/decisions/ac90ca8e` already explicitly ruled this out, by name, for a reason that still holds
  today (deliberate exclusion — `"run"` ingests untrusted input by design, and the owner's instinct there
  was never "give it MORE claude-only protection").
- `docs/decisions/acd3c688`'s own "Do not" section forbids widening that set's harness-conditional carve-out
  to a role it was never meant to swallow — `"run"` is one of exactly two roles (`"worker"`/`"operator"`
  being the other precedent) that record names as deliberately excluded from the force.
- The set's meaning is pinned, by four separate records (`ac90ca8e`/`3388be4d`/`31613c1e`/`d78f8217`), to
  ONE specific mechanism: the claude-only filesystem-level transcript-root deny. `"run"` never had that
  protection to begin with (see point 1 above). Reusing the same set to force claude for an *unrelated*
  reason (the nudge-delivery gap below) would conflate two independent mechanisms under one flag — exactly
  the drift `CLAUDE.md`'s "point at a source of truth, never restate" rule and `acd3c688`'s own "Do not"
  section both warn against.

**Rejected: route `"run"` through `codexIncompatibilities()`.**
- That function's fields (`restrictedTools`/`browserTesting`/`documentConversion`/`capabilities`/
  `permissionDeny`) are either hardcoded `false`/empty on every `"run"` session regardless of profile (no
  mismatch is possible — `startRun` never threads them), or already generically checked and disclosed
  (`permissionDeny`, via the `isolationGapItems` mechanism below) for ANY codex session, `"run"` included —
  there is nothing role-specific left for `codexIncompatibilities()` to additionally catch. The real defect
  (next section) is downstream, in nudge **delivery**, not in incompatibility **detection** — adding a
  `"run"`-specific entry here would duplicate a check that already fires correctly.

## The residual: the isolation-gap disclosure is durable-row-only for a `"run"` session

Every codex spawn — `"run"` included — unconditionally discloses `settingsDirReadDeny` (and, when the
project authors `permission.deny` rules, `permissionDeny` too) via `isolationGapItems` →
`onCodexIsolationGapDisclosed` → `SessionService.handleCodexIsolationGapDisclosed` (`pty/host.ts:5592-5623`,
`sessions/service.ts`). This is the SAME residual every codex session already accepts, per
`docs/decisions/7955458e` — not new in *what* is lost.

What IS new: `handleCodexIsolationGapDisclosed` only sends a recipient nudge when the affected session has
a `parentSessionId` — `nudged = !alreadyNudged && !!s?.parentSessionId`. The durable event still records
`nudged:false` either way (per `7955458e`'s own existing rule: "Do not record `detail.nudged:true` when
there was no recipient to send to"). `startRun`'s own session construction never sets `parentSessionId` —
a `"run"` session is parentless by design, with no manager above it. And no web UI surfaces the
`codex_isolation_gap_disclosed` (or `codex_unsupported_capability`) event kind at all — zero matches for
either across `packages/web/src`. `submitRunResult` and the run's own REST/webhook response carry only the
agent's own result value; no daemon-side warning rides along either channel.

So for a `"run"` session specifically, this disclosure's only trace is a durable `orchestration_events` row
with `nudged:false` that nothing points anyone at. Every other role the `7955458e` mechanism was designed
around either gets force-redirected to claude before reaching this code (manager/platform/auditor/
workspace-auditor/setup), or has a real parent to nudge (worker, whose manager is always its
`parentSessionId`). `"run"` is the first role that is simultaneously (a) actually reachable on codex and
(b) structurally parentless — so the generic "a parentless session has nowhere to send it" caveat
`7955458e` already anticipated in the abstract finally has a real, in-practice occupant instead of staying
a theoretical edge case.

**Accepted, not closed, by this card.** The owner's ruling: extend `7955458e`'s existing
"disclosed-not-enforced, durable-row-is-enough" philosophy to this first real parentless-and-reachable
case, deliberately, rather than build a `"run"`-scoped delivery fix here. A proper fix (surfacing
`codex_*` disclosure events in the UI) would benefit every parentless session, not just `"run"`, and is
tracked as its own separate card rather than built narrowly on this one. Adding a warning to the run
result's response shape was considered and declined for the same reason — it changes a response shape to
fix one role's instance of a problem that is really about the event's complete absence from the UI.

## Do not

- Do not add `"run"` to `TRANSCRIPT_ROOT_DENY_ROLES` (or any other claude-force mechanism) to fix the
  nudge-delivery gap above. That set's meaning is pinned to the transcript-root filesystem deny (a
  protection `"run"` never had, under either harness — see the ruling above); forcing claude for the
  unrelated reason of "nobody reads the isolation-gap row" would conflate two independent mechanisms under
  one flag, and would also be redundant with and contradict `ac90ca8e`'s existing, deliberate exclusion.
- Do not build a `"run"`-scoped recipient-delivery fix for `handleCodexIsolationGapDisclosed` on this card.
  The owner's ruling scoped the real fix (surfacing `codex_*` disclosure events in the UI, which benefits
  every parentless session, not just `"run"`) to its own future card.
- Do not add a warnings field to the Agent Run result/response shape as a workaround — that changes a
  response shape to patch one role's instance of a gap that is really "no UI surfaces this event kind at
  all", which is the actual thing worth fixing once, generically.
- Do not read `cea3cec6`'s `CODEX_AUTO_APPROVE_MCP_SERVER_IDS` widening (the MCP tool-call approval
  question) as having already answered this card's question — it is a different mechanism, decided on its
  own, narrower argument, and never discusses `TRANSCRIPT_ROOT_DENY_ROLES` or the isolation-gap nudge.
- Do not treat the "no new loss on the transcript-root-deny front" finding as implying a codex `"run"`
  session has no residual at all — the `settingsDirReadDeny`/`permissionDeny` disclosure gap is real and
  accepted, not absent; see the residual section above.

## Source

Investigation: this worker's `blocked` checkpoint report on this card (verified at source: `acd3c688`'s
record, `ac90ca8e`'s record, `90dc3c8c`'s record incl. its `cea3cec6` section, `codex-compat.ts:39`,
`sessions/service.ts`'s `roleForcesClaude` and `handleCodexIsolationGapDisclosed`, `pty/host.ts`'s
`withTranscriptRootDenyForSpawn`/`isolationGapItems`, and a `packages/web/src` grep for the event-kind
strings). Ruling: the project lead, same session.

Implementation: comment-only `@decision 2127d695` anchor at `sessions/service.ts`'s `startRun` (the
harness-threading site) and a short cross-link section added to `docs/decisions/7955458e`. No behaviour
change.

Tests: `packages/daemon/test/agent-runs-harness-thread.mjs` (extended) pins today's posture — a codex-pinned
`"run"` session is NOT forced to claude, and a simulated `codex_isolation_gap_disclosed` disclosure for
that session always carries `nudged:false`.
