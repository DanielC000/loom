# 760f2874 — `worker_flush`'s `"session-dead"` for a live codex session was a wrong-map bug, not a liveness race

## Narrative

Card `760f2874` (Platform Lead escalation `a51d9732`) named two separate defects. This record covers
DoD-4 (the `worker_flush`/`worker_list` liveness contradiction), which turned out to be a clean,
deterministic bug, and also records what was and wasn't found for DoD-1/2/3 (the "codex never submits
multi-line payloads" claim), which did NOT reproduce.

### DoD-4 — the real mechanism

`PtyHost.flushComposer` (`pty/host.ts`, backs the `worker_flush` MCP tool) read ONLY `this.live.get(sessionId)`
— the CLAUDE-only map (decision `353f6dc4` is why a codex session's live state lives in a separate map,
`this.liveCodex`, never inside `Live`). For any codex session, `this.live.get(sessionId)` is always
`undefined`, so `!live?.alive` was always `true`, and `flushComposer` unconditionally reported
`{ok:false, reason:"session-dead"}` for every codex session — alive or not. Meanwhile `worker_list`/
`isAlive`/`isBusy` all resolve through `findAnyLive`, which DOES consult `liveCodex`, so the SAME session
correctly read `processState:"live", busy:true` there. Two readers of the same liveness fact disagreed
because one of them was reading the wrong map, not because of any real timing race.

The flush mechanism itself (a bracketed-paste reassert pair, the Enter-confirm ladder, `composerDirtyLen`/
`submitGeneration`) is claude-only and has no codex equivalent — codex never uses bracketed paste at all
(`submitCodex`'s own doc). So the fix is not to port the mechanism to codex; it is to stop claiming
`"session-dead"` for a session that demonstrably isn't. `flushComposer` now checks `this.liveCodex` as a
fallback when `this.live` has no entry, and reports the honest `{ok:false, reason:"not-applicable-codex"}`
for an alive codex session, reserving `"session-dead"` for when neither map has a live entry.

### DoD-1/2/3 — the "never submits multi-line payloads" claim did not reproduce

The escalation's own evidence already names the exact mechanism that fired in production:
`[loom:codex-submit-unconfirmed]` "after 2 Enter attempts" is `armCodexBusyStaleTimer`'s CASE 4
(`onCodexSubmitUnconfirmed`, card `fedef6a0`) — the confirm-or-retry-or-fail-loud ladder's exhaustion path,
after `CODEX_SUBMIT_MAX_RETRIES` (2) retries each gated by `CODEX_BUSY_STALE_MS` (3000ms) of silence. That
part is not a hypothesis; it is directly legible in the quoted evidence.

What is NOT confirmed is the Lead's own flagged-as-UNTESTED hypothesis that payload SHAPE (multi-line text,
backticks, a Windows path) is the discriminator. Real-spawn testing against the CURRENT host (codex-cli
0.153.4, Loom HEAD `3de60f6e`) across 4 separate real spawns/submissions — a single-line prompt, a short
multi-line prompt with backticks + a Windows path, a long (1.5KB, 34-line) realistic markdown kickoff with
headers/bullets/bold/a fenced code block, and the TRUE `worker_spawn`-shaped delivery (passing
`startupPrompt` directly to `host.spawn()`, racing the boot-busy episode exactly as production does,
instead of waiting for idle first) — all 4 submitted successfully, with the full, byte-intact text
recorded in the real codex rollout `.jsonl` transcript (verified by reading the rollout file directly, not
inferring from delivery status). Two of the four organically triggered ONE CASE-3 retry (a bare extra
`"\r"` written because no busy marker was seen within 3000ms of the real Enter write) and both
self-resolved correctly — directly exercising, and for these two trials resolving as harmless, the
previously-disclosed-but-unverified risk named in `armCodexBusyStaleTimer`'s own doc ("a stray Enter into
an already-emptied composer... was NOT verified against a real process").

So the payload-shape hypothesis is refuted as stated: multi-line text with backticks and Windows paths
submits correctly today. What was NOT tested, and remains open: the production incident's kickoffs raced
REAL, reachable `loom-tasks`/`loom-orchestration` MCP servers (this repro deliberately used
`pinUnreachableLoomPort()`, per the existing real-spawn test family's own established safety practice, to
keep connections failing fast and deterministic rather than hanging); and the real `~/.codex/config.toml`
on this host now carries a `[tui.model_availability_nux]` `gpt-6-astra = 4` counter that was NOT present
in the card's own 2026-09-22 snapshot — a brand-new, first-use-per-model nudge whose on-screen shape (if
any) was never captured, and whose counter having already reached what looks like a cap means it can no
longer be triggered on this host to observe directly without resetting state outside this task's
constraints (the kickoff forbids editing `~/.codex/config.toml`/owner codex settings). Neither of these
was ruled in or out; both are named as what the real-spawn family would need to add to close this
gap for real (standing up a genuinely reachable MCP server through `PtyHost`, as
`codex-mcp-reachability-real-spawn.mjs` does independently of `PtyHost` today).

## Do not

- Do not read `flushComposer`'s `"session-dead"` as proof of liveness for ANY session type without first
  checking which map actually holds it — `this.live` (claude) and `this.liveCodex` (codex) are genuinely
  separate (decision `353f6dc4`), and a reader that only consults one will disagree with `findAnyLive`-based
  readers (`worker_list`/`isAlive`/`isBusy`) on a codex session.
- Do not port the bracketed-paste reassert/Enter-confirm-ladder mechanism to codex to "fix" this — codex
  has no bracketed paste and no equivalent composer-drift/generation state; the correct fix is an honest
  `"not-applicable-codex"` reason, not a parity implementation.
- Do not treat the "payload shape" hypothesis as confirmed, or as refuted beyond what was tested — it was
  refuted for multi-line/backtick/Windows-path/long-markdown shapes under a DISCONNECTED (unreachable-port)
  MCP config; it was never tested against a reachable MCP server or against the specific
  `[tui.model_availability_nux]` host state present during the actual incident.
- Do not cite this record as proving CASE 3/CASE 4 of `armCodexBusyStaleTimer` is safe in general — it is
  evidence from 2 real trials that a stray retry Enter was harmless in those 2 trials, not a proof for all
  conditions.

## Source

`PtyHost.flushComposer`, `packages/daemon/src/pty/host.ts` (the `@decision 760f2874` anchor just above its
definition). Real-spawn repro scripts run against this host's real, authenticated `codex` CLI (0.153.4) on
2026-10-14; not committed as test files (see the card's own worker report for the targeted regression test
that WAS committed, `packages/daemon/test/worker-flush-codex-liveness.mjs`).
