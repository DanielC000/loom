# 2e84a250 — `supervisorScriptChangedSince` returns a three-state union, not a second boolean

## Narrative

Card 2e84a250 (done, filed by the Loom lead `gen 214`, split out of card `469b5e67`): `469b5e67` fixed `supervisorScriptChangedSince` so a failed check now `console.warn`s a "could NOT check … FAILED CHECK, not a confirmed negative" diagnostic naming the underlying error — correct and sufficient INSIDE `restart.ts`. But the return contract was still a bare boolean, so the distinction lived ONLY in the daemon log. A caller — and therefore a manager — still could not tell "CHECKED, unchanged" from "COULD NOT CHECK".

Why that matters: `CLAUDE.md`'s supervisor caveat is explicit that a merge editing `scripts/daemon-supervisor.mjs` needs a HUMAN Ctrl-C + re-run of `pnpm daemon:stable`, and that a manager must flag that action in its done-report. A manager reads the MCP response, not the daemon log — so a silently-failed check still reached the manager as an indistinguishable "supervisor unchanged", and the human still lost the manual-restart signal. `469b5e67` moved the failure from INVISIBLE to visible-in-a-place-nobody-reads; that's a real improvement but not the whole fix.

The fix: `SupervisorCheckResult` is a discriminated union — `{status:"changed"}` / `{status:"unchanged"}` / `{status:"could-not-check", reason:string}` — deliberately NOT a second boolean, since a second boolean just recreates the exact collapse this card exists to kill one layer up, and a caller that tries to fold it back into a bare true/false is a TYPE ERROR, not a silent possibility. `reason` on `"could-not-check"` carries the same message already logged by `supervisorScriptChangedSince`'s own `console.warn`, so an up-stack caller that wants to surface WHY doesn't need to re-derive it. `RestartIntent.supervisorCheckFailed` is the sibling on-disk field to `supervisorChanged`, mutually exclusive with it (both come from the SAME check, at most one is ever true) — kept as a separate field rather than a `supervisorChanged: boolean | "unknown"` union so an old on-disk intent (or any reader that only knows `supervisorChanged`) degrades exactly as before: absent/false, never a crash or a misread "unknown". `resumeFleetOnBoot`'s requester nudge surfaces this as `SUPERVISOR_CHECK_FAILED_WARNING` instead of the unconditional "now LIVE" claim.

Non-negotiable constraint carried from the DoD: this must never change the non-blocking contract — a failed check must still never throw and never block a restart; it must be REPORTED, not enforced. Turning it into a refusal would be worse than the gap it closes.

## Do not

- Do not fold `SupervisorCheckResult`'s three states back into a `boolean` or a `boolean | "unknown"` union anywhere up-stack — that recreates the exact "could-not-check reads as unchanged" collapse this card exists to kill.
- Do not make a failed supervisor-change check block or throw during a restart — it must stay advisory-only and always be REPORTED, never enforced.

## Related

Card `469b5e67` (the in-file fix inside `restart.ts` this card's up-stack propagation builds on; see also its own record `docs/decisions/54b839c5-bound-vault-git-plumbing-calls-and-unstageoversizedfiles-reset-semantics.md` for the `GIT_TERMINAL_PROMPT`/`GitPluginError` mechanism `defaultGitLogSince` used to trip on).

## Source

Inline JSDoc on `RestartIntent.supervisorCheckFailed`, `SupervisorCheckResult`, and `supervisorScriptChangedSince` in `packages/daemon/src/orchestration/restart.ts`, as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `*`-prefixed JSDoc lines joined into flowing paragraphs.
