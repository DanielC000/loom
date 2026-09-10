# 7d3899cb — the `[loom:daemon-restarted]` notice states an ORIGINATOR CLASS (agent vs unknown), never a project/session/agent identity

## Narrative

Surfaced 2026-08-26 by a real cross-project exchange: an owner-fired restart (the owner answered request `98de4a60` confirming a manual Ctrl-C + relaunch) gave a peer project's manager no way to tell whether an agent had fired it without announcing first — the cross-project announce-before-restart pact binds only the agent case, and the notice made an owner-fired restart indistinguishable from a silent breach of that pact. The Loom lead could resolve that one instance only by coincidentally holding the owner's unrelated answer; ordinarily the question is unanswerable from inside any session.

The obvious fix — naming the originating PROJECT — was rejected: it would leak which project is active to every other project's manager, the exact cross-project isolation boundary `5a9a963b` deliberately settled. The chosen fix distinguishes only the CLASS of originator: `RESTART_ORIGIN_AGENT` when a `daemon_restart` tool call captured a `RestartIntent` before exiting (`index.ts`'s boot branch is a strict, mutually exclusive if/else — `restartIntent ? resumeFleetOnBoot(...) : recoverCrashOrphanedWorkers(...)`; the supervisor's own exit-75 relaunch is not a third shape here, since `RESTART_EXIT_CODE=75` is written only by `requestDaemonRestart` (service.ts), which always calls `writeRestartIntent` first — so an exit-75 relaunch reads back its own intent and is agent-initiated **by construction**, not merely by inference), and `RESTART_ORIGIN_UNKNOWN` for the `recoverCrashOrphanedWorkers` `cleanStop` (shutdown-marker-found) branch — reused for a no-intent boot that is provably not a crash.

A three-way split (owner / agent / crash) was the card's original assumption; evidence arrived (a boot that was independently confirmed human-deliberate — same Ctrl-C answer — logged identically to a crash-recovery boot, no `restart-intent.json` either way) that a deliberate human Ctrl-C is indistinguishable from a genuine crash at boot. The card narrowed to the two-way split that ships: `cleanStop` genuinely cannot separate "a human stopped it" from "an as-yet-unexplained non-crash" — it only rules out an agent (which always writes an intent) and rules out a JS-level crash (which never leaves a fresh marker). Inventing a third `owner-initiated` label would be wrong on every genuine crash still routed to this branch by a stray/late marker, and an invented origin is worse than none because it would be believed.

## Do not

- Do not invent an `owner-initiated` origin label — a no-intent boot cannot be distinguished from a genuine crash, so the label would be wrong on every crash still routed to that branch.
- Do not fold this clause onto the sibling `[loom:crash-recovered]` tag (the no-marker-at-all branch) — that tag already states an unambiguous, non-agent cause in its own prose and was never the source of the peer's confusion.
- Do not widen the notice to name the originating project, session, or agent identity — only the CLASS is disclosed, to preserve the cross-project isolation boundary `5a9a963b` settled.

## Source

JSDoc comment above `RESTART_ORIGIN_AGENT`/`RESTART_ORIGIN_UNKNOWN` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 48-73 as of this tranche's HEAD (tranche 1). Card merged as commit `264eaaf`.
