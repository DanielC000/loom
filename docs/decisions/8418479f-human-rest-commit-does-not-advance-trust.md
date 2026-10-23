# 8418479f — a human REST `git_commit` does not advance mainline trust, and should not

Follow-up to Code Review `ead08b1c`'s review of `aa7677fa` (the landing-trust ledger, see
`2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md` rounds 19-23). Once `aa7677fa`
landed, the per-branch mainline trust record freezes on any mainline move not traceable through Loom's own
landed-commit ledger — including a commit made through the human-only REST git writer
(`GitWriter.commit`, `git/writer.ts`), which is itself a Loom-mediated, human-authenticated write, yet
freezes trust exactly like an out-of-band hand commit.

## The question

Should the human REST route specifically (never the agent-facing Platform Lead or operator `git_commit`
tools, which must keep freezing) write a ledger row — or otherwise advance trust — when its commit's
parent equals the current trust, so a human's own UI commit doesn't lock out `project_checkout_branch`?
Investigated as card `8418479f`; decision below is **NO**.

## The three callers of `GitWriter.commit`, and how they're distinguished server-side

`GitWriter.commit()` (`git/writer.ts:624`) itself carries no caller-identity parameter — all three callers
invoke it identically: `new GitWriter(repoPath, gitWriteTimeouts).commit(message, opts?)`. What
distinguishes them is which code path reaches that call, gated by two structurally non-overlapping,
server-derived authentication mechanisms — never anything the caller supplies in the request itself:

- **Human REST** — `gateway/server.ts:4897-4904`, `POST /api/projects/:id/git/commit`. Gated by the shared
  loopback-secret bearer guard (`gateway/server.ts:773-833`): `Authorization: Bearer <deps.loopbackSecret>`,
  a single daemon-wide secret file never handed to an agent session.
- **Platform Lead** — `mcp/platform.ts:3990-4013`, the `git_commit` tool on `/mcp-platform/:sessionId`.
  Gated by `resolveRole` (`role==="platform"`, a human-created-only session) plus a PER-SESSION `mcpToken`
  (`deps.pty.verifyMcpToken` + liveness) — a different credential from the loopback secret, scoped to one
  session.
- **Operator** — `mcp/operator.ts:137-149`, the `git_commit` tool on `/mcp-operator/:sessionId`. Gated by
  `role==="operator"` AND `platform.operatorEnabled`, plus the same per-session `mcpToken` mechanism as the
  Lead. Not named in the original question, but structurally in scope by the same reasoning: it is
  agent-facing, and is the *least*-guarded of the three (no pending-merge guard, no `repoKey`, no `paths`
  narrowing) — any special-case for the REST route must exclude this caller too, not only the Lead's.

So the call site is reliably distinguishable: two non-overlapping auth mechanisms gate two disjoint sets of
routes, and the human REST handler is one specific function in one specific file. Any special-casing has to
be an explicit, literal flag passed from that ONE function into `commit()`'s `opts`, never inferred from
headers, body, or anything else caller-supplied.

**Named residual, not a new gap:** this proves *which code path executed*, not *that a human, rather than
an agent with filesystem read access to `LOOM_HOME`, made the request* — an agent that can read the
loopback-secret file could forge this REST call directly. That is the same trust model every human-only
REST writer (vault, git, gateCommand) already relies on, and the same residual the operator router's own
"git\_push never passes --force, but the operator session also has native Bash" caveat already accepts. Not
introduced or widened by this decision.

## What happens today

`GitWriter.commit()` has no interaction with `git/mainline-watch.ts` at all — it is a plain `add -A` +
`commit`, with no ledger or trust write of its own. The move is only observed lazily, at the next
`checkMainlineMove` (a boot sweep, or the next real landing's pre-squash check). An ordinary human commit
has a genuine porcelain reflog message and no forged trailer, so `classifyMainlineMove` returns
`"explained"`: the watermark (bookkeeping only, per round 16) silently advances, but the per-branch trust
record does not. The *next* real `worker_merge_confirm`/`merge_batch` then sees
`trustedBefore !== checkedTip` and `advanceMainlineWatermark{,ForBatch}`'s round-19 gate freezes trust
permanently, filing exactly one HIGH `mainline_moved_outside_loom` event
(`detail.source:"landing-trust-freeze"`) plus one manager nudge, and leaving `project_checkout_branch`
refused until a human acts.

Exercised directly in `packages/daemon/test/mainline-watch.mjs`, scenario **(S1)** (lines 181-196): a real
`new GitWriter(P.repo).commit("docs: human REST writer commit")` followed by a real landing asserts exactly
this freeze — the test's own comment calls it "THE ACCEPTED COST".

**Recovery** already exists and needs no new code: `POST /api/projects/:id/mainline-watermark/reset`
(`gateway/server.ts:4913-4929` → `Db.resetMainlineWatermark`, `db.ts:3593-3606`). It deletes the watermark
and the alert marker that blocks `project_checkout_branch`, and — via its `adopt:{branch,sha}` param, which
the route already derives automatically from a live `readMainlineHead()` read (`gateway/server.ts:4918-4927`,
no caller input needed) — re-stamps that branch's own trust record through `setMainlineBranchTrust`. This
is exactly the mechanism round 7 (M2) of `2a6a292a` built to close this class of dead end, and it already
fully satisfies "doesn't lock out `project_checkout_branch`" with zero new trust-writer surface.

## Reasoning against round 9 and rounds 19-23

Round 9 of `2a6a292a` bans *classifying an arbitrary commit's content* (a trailer, a reflog message) as
proof of legitimacy — not Loom's own process trusting a write it just performed under its own lock. The
existing ledger (round 20) and `advanceMainlineWatermark`'s gate are already judged compatible with round 9
for exactly that reason: they add "a second, independent, Loom-AUTHORED fact ... never a new way to
re-derive trust from git content."

But to be safe, a REST-commit ledger/trust write would need the *identical* proof machinery the merge path
only reached after three further Code Review rounds:

1. Capture `preCommitHead` and the staged tree immediately adjacent to the commit call (card `c862f14c`'s
   adjacency rule — no git call between either capture and the commit).
2. Verify the resulting commit via `git cat-file -p <sha>`, never `git rev-list --parents` (round 23: it
   honors `info/grafts` and is bypassable) and never a `-q --verify` exit-code check (round 22: this
   codebase's `canonicalGit()`/simple-git stack treats a quiet non-zero exit as success) — parse the raw
   header block for exactly one `parent ` line, matching `preCommitHead`, and the matching tree.

Skipping either step reopens a bug this exact card family already found and fixed once on the sibling
(merge) path.

**The attack:** anyone with `.git` write access to the shared canonical repo (every worker worktree shares
it) races `refs/heads/<mainline>` in the window between `GitWriter`'s own `git commit` settling and whatever
verification read follows — forging a sibling commit (optionally hiding an extra parent via a graft entry)
that passes a naive parent/tip check, laundering a forged tip into the ledger/trust store through a route
the UI treats as implicitly safe. `withCanonicalIndexLock` (which `commit()` already holds) does not close
this: it only serializes Loom's own callers against each other, never an out-of-band `update-ref`/hook-based
racer — exactly how round 21's CRITICAL repro defeated the merge path despite that path holding the same
lock.

## Decision: NO

A fourth trust writer (per `CLAUDE.md`'s "written by exactly three things" enumeration) that must be kept
in lockstep with this card family's hardening forever is not worth buying back one manual step after an
already-rare human hotfix commit — especially given this record's own history (five-plus Code Review rounds,
each finding a new bypass). The cheaper alternative already exists and needs no new code: after a REST
`git_commit`, the human calls the existing mainline-watermark reset route (above), which clears the block and
auto-adopts the live checked-out head as "a byproduct of the human's own live git read" (round 7's own
phrasing for why `adopt` is safe) — no git-content classification, no new verification code, no new attack
surface. The only real gap is UX — the REST `git_commit` response, or the web UI, could proactively suggest
calling the reset route — tracked as a separate card, not a trust-boundary change.

## Do not

- Do not make `GitWriter.commit()`, or any of its three callers, a mainline trust or ledger writer without
  the full verify-own-commit machinery (`preCommitHead`/tree capture + `cat-file -p` parent+tree
  verification) described above — a bare post-commit `rev-parse HEAD` re-read proves nothing (round 21).
- Do not scope any future special-case to "not the Platform Lead" alone — it must also exclude the
  operator's `git_commit` (`mcp/operator.ts`), which is equally agent-facing and less guarded.
- Do not infer the caller's identity (human REST vs. agent MCP) from anything caller-supplied (a header, a
  body field, a claimed role) — the only safe signal is which function/route the call reached, set as a
  literal at that one call site.
- Do not read this record as closing the UX gap (a nudge to call the reset route after a REST commit) —
  that is deliberately a separate, non-trust-boundary card.
