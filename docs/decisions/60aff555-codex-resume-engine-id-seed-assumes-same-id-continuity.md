# 60aff555 — seeding a codex resume's engine id from `opts.resumeId` rests on an UNVERIFIED continuity premise

## Narrative

`pty/host.ts`'s `spawnCodexProcess` used to seed `CodexLive.engineSessionId: null` UNCONDITIONALLY, even
for a genuine `codex resume <uuid>` spawn, relying on `captureCodexEngineSessionId`'s freshness-only
rediscovery scan (`findConversationIdForSpawn`) to fill it back in once the ready marker fired. That scan
runs with NO sibling exclusion on the resume path (`excludeEngineSessionIds` is `null` for a resume, by
design — a resume must be able to re-match its OWN pre-existing file, which the fresh-spawn snapshot
`snapshotExistingConversationIdsForSpawn` would otherwise wrongly exclude). So a SIBLING codex session's
rollout file, written into the SAME cwd with a fresher mtime during the resume's capture window, could be
wrongly adopted instead of the resume's own file — a distinct shape from card `184fd82e`'s tracked
fresh-vs-fresh concurrent race (that one covers two brand-new spawns racing; this one is a resume racing a
sibling).

The fix: seed `engineSessionId: isCodexResumeSpawn ? opts.resumeId! : null` directly at `CodexLive`
construction, mirroring the claude `Live`'s existing `opts.forkSessionId ?? opts.resumeId ?? null`. This
makes `captureCodexEngineSessionId`'s own `if (live.engineSessionId || !live.alive) return;` guard skip
the rediscovery scan ENTIRELY for a resume — closing the sibling-collision shape by construction, never
by consulting the filesystem at all for this path.

**That fix rests on one premise this project has NOT directly verified: that a resumed codex conversation
continues writing to the SAME rollout file under the SAME `session_meta.payload.session_id` — i.e. that
`opts.resumeId` stays correct for the entire lifetime of the resumed session, not just at the instant of
resume.** This premise was not introduced by this fix — the PRE-EXISTING design already assumed it (the
comment at `pty/host.ts` around the `snapshotExistingConversationIdsForSpawn` call site states "a resume
spawn legitimately needs to re-match its OWN pre-existing file"), and the removed rescan-with-no-exclusion
mechanism was built on the identical assumption, just reached via a filesystem scan instead of a direct
seed. This fix makes the assumption explicit and structural; it does not newly create it.

**What the evidence shows, and what it does not:**

- `docs/investigations/c6ce2804-codex-resume-rollout-timing/findings.md:37` directly answers the question
  "does `codex resume <uuid>` observably continue the same conversation" with: **"unobserved, and
  currently unobservable at zero model-turn cost against this build."** Both of that investigation's
  real-spawn runs never reached a resumable state at all (engine-id capture timed out before any rollout
  file existed), so the resume leg was skipped both times. No test anywhere in this repo has ever
  submitted a real second turn after a real codex resume and then checked whether the rollout file's
  `session_id` was unchanged.
- `packages/daemon/src/pty/codex-rollout-archive.ts`'s header (card `5172fe3a`, real-spawn-confirmed)
  records that moving a resumed id's rollout file out of its live path makes a real `codex resume <uuid>`
  fail HARD — `thread/resume failed: no rollout found for thread id <uuid> (code -32600)`, exit code 1 —
  "not a graceful fallback, not a silently-blank fresh conversation." This is real-spawn evidence that
  codex resume operates by locating the file matching the EXACT given id and refuses outright when it is
  missing, rather than silently minting a new id/file when the exact one can't be found — circumstantial
  support for same-id continuity, but not a direct observation of a live resumed session's id staying
  fixed across a real turn.
- Nothing in `docs/decisions/*`, `docs/adr/*`, source comments, real-spawn test headers, or project memory
  shows codex ever minting a NEW id on resume, or the old rescan ever catching a different id after a real
  resume.

**Owner decision (2026-10-03, this card): land the fix as-is on the structural argument above — no real
codex spend to directly verify it.** Rationale: the `-32600` hard-fail behavior fits same-id continuation;
the prior design already assumed it; codex is a pilot harness on this project, not yet load-bearing enough
to justify a real model-turn spend purely to firm up this one premise.

**Failure mode if this premise is ever wrong:** if a real codex build is ever found to mint a NEW
conversation id on resume, `CodexLive.engineSessionId` (and the DB row, via the normal `onEngineSessionId`
write path on a FUTURE capture — which this fix's seed now suppresses for every resume) would go
permanently stale for that session: Loom would keep tracking the OLD id, `worker_transcript`/liveness
reads would resolve the WRONG (now-abandoned) rollout file, and any FUTURE resume of that same Loom
session would pass the stale id to `codex resume <uuid>`, which (per the hard-fail evidence above) would
itself then fail with `-32600` once the real engine has moved past that id — a loud failure, not a silent
one, but a real loss of that session's resumability.

**Trigger to re-check this premise:** the first time a real codex resume is driven through a SECOND real
turn (in any test, probe, or production session) — compare the rollout file's own
`session_meta.payload.session_id` before and after that second turn. If it changed, this fix's seed is
wrong and must be reverted to (or replaced by) a mechanism that re-resolves the id post-resume; if it
stayed the same, this premise graduates from "unverified, structurally argued" to "directly confirmed" and
this record should be updated to say so.

## Do not

- Do not read the `-32600` hard-fail evidence as a direct observation of same-id continuity across a real
  turn — it is circumstantial support for the premise, not proof of it; no test in this repo has ever
  watched a resumed codex session's id survive a real second turn.
- Do not spend a real codex model turn to "just check" this premise speculatively — the owner's explicit
  decision was to land without that spend; only re-open it at the trigger named above (the first time a
  real second-turn-after-resume observation happens for ANY reason), not proactively.
- Do not revert the `engineSessionId` seed back to the old rescan-with-no-exclusion mechanism as a
  "safer" fallback if this premise is ever found wrong — that mechanism had the IDENTICAL unverified
  assumption AND the sibling-collision bug this card fixed; re-derive a real fix from the trigger's
  findings instead.

## Source

`packages/daemon/src/pty/host.ts`, `spawnCodexProcess`'s `CodexLive` construction (the `engineSessionId`
seed, card `60aff555`).
