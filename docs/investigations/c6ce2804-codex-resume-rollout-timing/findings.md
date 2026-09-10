Card c6ce2804 — codex-resume rollout-file-timing findings

Method: scripts/probe.mjs. See that file's own header for the full mechanism (real `PtyHost.spawn({harness:"codex"})`, three lifecycles — fresh / resume / fresh-negative-control — the exit-screen-id discriminator, and why "skips the trust dialog" is deliberately NOT used as the resume signal). Originally written as a permanent real-spawn regression test under packages/daemon/test/codex-resume-real-spawn.mjs, registered in CODEX_REAL_SPAWN_BASENAMES; relocated here (and de-registered) once both runs below went red the same way — a test that cannot currently pass must not sit in the certified corpus (it would spend three real codex spawns on every full gate, forever, for no signal).

Run 1 — no real MCP gateway (mirrors codex-stateful-runtime-real-spawn.mjs's own scope):

- Spawn A (fresh): reached real ready state, exited cleanly (code 0). Engine-session-id discovery (captureCodexEngineSessionId) timed out after the full budget (15s + waitUntil's own grace extension to 75s).
- Spawn B (resume): SKIPPED — no id to resume with. Counted as a failure per the test's own "a skip must not read as a pass" design.
- Spawn C (fresh, unrelated negative control): same as A — reached ready, exited cleanly, engine-session-id discovery timed out.
- Direct on-disk check (~/.codex/sessions/, not inferred): the newest rollout-*.jsonl file present was from 11:47 that morning — several hours before this run (~23:0x). No new file appeared during either spawn's ~75s+ live boot window.
- Result: 2 FAILURE(S).

Run 2 — real in-process gateway added (mirrors codex-mcp-reachability-real-spawn.mjs: `buildServer` + `TaskMcpRouter`, `LOOM_PORT` set to the listening port before dist/pty/host.js's first import so `buildMcpServers()` points codex's real MCP args at it; every non-loom-tasks router given a fast-reply stub `.handle` so a worker role's OTHER mounted server, loom-orchestration, cannot hang the boot). Zero model turns spent either way — this only lets codex's MCP handshake genuinely complete instead of hanging/retrying.

- Identical result to Run 1: spawn A and spawn C both reached ready and exited cleanly (code 0); engine-session-id discovery timed out on both (75s total, same shape); spawn B skipped again.
- Direct on-disk re-check, same method: still zero new rollout files after this run. Newest file on disk was STILL the same 11:47 file from that morning, now hours before both attempts.
- Result: 2 FAILURE(S) — same signature as Run 1.

What is ESTABLISHED (twice, directly on disk, not inferred):

A real codex session that reaches ready state and exits cleanly with ZERO turns run writes NO rollout file at all — with AND without a real, listening MCP gateway. The gateway attempt did not change the observable outcome.

What is INFERRED, NOT verified — do not read this file as having established it:

That a rollout file appears once a real turn runs. This probe never spent one (by design — "don't re-spend the owner's subscription" is a standing constraint on this project, and a probe that had to spend a turn to observe its own claim would be exactly the "permanent per-gate tax" reason this file isn't in the certified corpus). `captureCodexEngineSessionId`'s own doc comment (pty/host.ts, card 2ec60d9c) hedges this same way ("the rollout file is created lazily, around first-turn time, not at boot") — this probe's result is CONSISTENT with that hedge, not independent confirmation of it.

What is BOUNDED, not proven either way:

Run 2's gateway attempt shows a listening gateway did not change the outcome. It does NOT prove codex's MCP handshake to that gateway actually succeeded — this probe did not capture the daemon's own [mcp] inbound-request log (unlike codex-mcp-reachability-real-spawn.mjs, which does exactly that to prove a real handshake completed). The identical failure timing/shape across both runs is what makes "boot alone is insufficient regardless of MCP state" the best-supported reading, not a direct proof that the handshake itself completed.

Separately, answered by reading source only (no spawn, no model turn) — what happens if `codex resume <uuid>` were ever handed a nonexistent id:

It never reaches that state via any production caller. `sessions/service.ts`'s `resume()` calls `engineTranscriptExists(session.cwd, session.engineSessionId, session.harness)` BEFORE ever calling `pty.spawn()`; for harness "codex" this dispatches (`sessions/transcript.ts`'s `transcriptOpsFor`) to `codex-transcript.ts`'s `transcriptExists`, which does the same bounded YYYY/MM/DD scan for a rollout filename containing the id. If no such file exists, `resume()` throws "session is no longer resumable (engine transcript missing)", calls `db.setResumability(id, "dead")`, and never touches `createCodexPty`'s new resume-argv branch at all. `resumeFleetOnBoot`'s default `resumeOne` wraps this in try/catch and records it in `failed`/`failedDetail` (role/projectId/taskId — the diagnostic surface built for exactly this, card 5a9a963b) — never a crash, never a silent zombie. `forkSession()` has the identical pre-check for its own source id. This is IDENTICAL to how a claude session with a missing transcript is already handled; nothing new is introduced by the resume-argv wiring here, since the guard sits entirely upstream of it.

Corollary this probe's own two runs surface (filed separately by the manager — see the card this findings doc's own commit references): a codex session whose rollout file never gets written at all — exactly what both runs above observed, twice — has `engineSessionId` stay NULL in the DB forever (`captureCodexEngineSessionId` never succeeds), so it would fail even earlier, at `resume()`'s very first check ("session has no engine id to resume"). Same graceful, non-crashing failure path, one check sooner. This implies a real claude/codex asymmetry: a claude session captures its engine id at boot (SessionStart hook); a codex session that dies before completing a first turn may never get one at all, making it unrecoverable by boot-reconcile where an equivalent claude session is recoverable. It fails SAFE (verified above) — this is a scope/limits finding, not a crash risk.

Bound on this whole investigation: n=2 runs, one host, one codex build, zero real turns spent (by design). This does not rule out a different codex version or a real first turn producing different behavior — it directly answers the one question this card's DoD-3 posed (does `codex resume <uuid>` observably continue the same conversation) with: unobserved, and currently unobservable at zero model-turn cost against this build. The original card's "confirmed 5/5 runs" framing (probe a7d74718, State 6) was about the `codex resume <uuid>` HINT TEXT being printed on exit, never about the command having actually been invoked and observed to continue anything — this probe is what actually attempted that, and it could not get far enough to observe it.

## The argv design (DoD-1): why `resume` leads, and why fork always forces fresh

`buildCodexResumeArgs` decides the resume-related PREFIX of a codex spawn's argv — kept as a pure function (asserted directly in `codex-resume-argv.mjs`, no real spawn required) mirroring why `mcpServersToCodexArgs` lives in `codex-host.ts` rather than inline in `createCodexPty`.

`codex resume <uuid>` is a genuine top-level subcommand (probe findings.md State 6 / point 2: codex itself prints this exact command, unprompted, on the clean exit of a session with in-flight state), so a resume spawn's argv must LEAD with `["resume", <uuid>]` — a clap subcommand token, not a flag; it cannot appear after `-a`/`-s`/`--no-alt-screen` the way `createCodexPty` builds the rest of the argv.

The function deliberately returns `[]` (a fresh spawn) when `fork` is true, EVEN IF `resumeId` is also set: unlike claude, codex has no discovered `--fork-session`/`--session-id`-shaped equivalent (checked against both probe passes' fetched docs and `--help` output). Reusing `resume <uuid>` for a fork would attach a SECOND live pty to the SAME engine-session id the source may still be running under — a real correctness risk (two processes racing writes into one rollout file), not a cosmetic parity gap. `createCodexPty` discloses this via a `console.warn` when it hits this case.

Do not: reuse `resume <uuid>` for a codex fork, even as a stopgap — it risks two ptys racing writes into one rollout file, not merely a parity gap. Do not place `resume`/`<uuid>` after the other flags in the built argv — `resume` is a clap subcommand and must lead.
