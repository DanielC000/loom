# 6dedef21 — `[tui.model_availability_nux]` stays the leading, circumstantial, but UNTESTABLE suspect; the reachable-gateway hypothesis is refuted (n=1)

Worker investigation, continuing `760f2874` (itself continuing the Platform Lead's escalation `a51d9732`).
**Investigate-only — no `packages/daemon/src/**` code was touched.** `filesChanged` for this task is this
document only; no code fix was written (see "Why no fix was attempted" below).

## Recap of what this continues

`760f2874` established that the production symptom (4-of-4 manager payloads to codex workers going
unsubmitted on 2026-10-13) is `armCodexBusyStaleTimer`'s CASE 4 — `onCodexSubmitUnconfirmed`
(`CODEX_SUBMIT_MAX_RETRIES=2`, each gated by `CODEX_BUSY_STALE_MS=3000ms`, `packages/daemon/src/pty/host.ts`)
— and refuted the payload-shape hypothesis (multi-line text, backticks, Windows paths all submitted fine in
4 real trials). It named two untested suspects: (1) codex's `[tui.model_availability_nux]` first-use-per-
model popup, and (2) that repro's use of an unreachable MCP port rather than a real, reachable one.

## Suspect 2 (real reachable gateway) — REFUTED, n=1

Built a real-spawn repro (scratch script, not committed — same posture as `760f2874`'s own repro scripts,
see that record's "Source" section): a genuine, listening Loom gateway (`reserveHermeticPort()`, never
`pinUnreachableLoomPort()`) built with the REAL `PtyHost` instance as its `pty` dependency — so the
gateway's `/mcp*` auth hook (`gateway/server.ts`'s `onRequest` hook, `@decision 280b1e44`) validates against
the exact token `createCodexPty` minted for this spawn, no test-only auth stub needed — then
`host.spawn({..., harness: "codex", startupPrompt: <1.1KB multi-line markdown kickoff>})`: the TRUE
`worker_spawn` shape (kickoff threaded through `opts.startupPrompt`, delivered post-ready via the real
`submit()` path, racing boot exactly as production does — `@decision 0050a17e`).

Result: the daemon's own `[mcp]` inbound log recorded a REAL `initialize` → `notifications/initialized` →
`tools/list` handshake for BOTH the `loom-tasks` and `loom-orchestration` routers (not a refused or
blackholed connection — a real protocol round-trip reached the real router). The kickoff still submitted
successfully: one `[codex-submit] ... Enter attempt 1/2 ... retrying` (CASE 3) self-healed and the turn
confirmed with the expected reply. This is the same shape `760f2874`'s own trials saw (2 of 4 self-healed
through one CASE-3 retry) — a real, reachable MCP server racing the kickoff did not, in this one trial,
change the outcome.

Raw evidence (console output from the one run):

```
[info] reserved REAL, free port 62812 for a live gateway (never pinUnreachableLoomPort)
[pty] spawnCodex codex-reach-gw-repro bin=...codex.CMD cwd=...loom-codex-reach-gw-cwd-ECekfj resume=none mcpServers=loom-tasks,loom-orchestration
[mcp] codex-reach-gw-repro router=task method=initialize tool=- rpcId=0 seq=1
[mcp] codex-reach-gw-repro router=orchestration method=initialize tool=- rpcId=0 seq=2
[mcp] codex-reach-gw-repro router=task method=notifications/initialized tool=- rpcId=- seq=3
[busy] codex-reach-gw-repro -> true (codex-marker)
[mcp] codex-reach-gw-repro router=task method=tools/list tool=- rpcId=1 seq=4
[busy] codex-reach-gw-repro -> false (codex-marker-stale)
[busy] codex-reach-gw-repro -> true (submit)
[codex-submit] codex-reach-gw-repro Enter attempt 1/2 — no busy-marker sighting since the last Enter write after 3000ms; retrying
[codex-engine-id] codex-reach-gw-repro captured after 39397ms (attempt 14/40)
[busy] codex-reach-gw-repro -> false (codex-marker-stale)
[info] outcome: confirmed (elapsed 47576ms)
PASS  the real gateway recorded a genuine MCP handshake (initialize) for this session
PASS  the real gateway recorded tools/list (tool enumeration actually reached the router)
PASS  the kickoff reached a terminal state (not NEITHER)
PASS  CONFIRMED path: no onCodexSubmitUnconfirmed fired
```

Refuted as stated, with the same hedge `760f2874`'s own refutation carries: this is n=1 against today's
host state, not a proof for all timing/load conditions — a busier host, a slower MCP router, or concurrent
sibling codex spawns (as the production incident actually had) could still surface the race this repro
didn't.

## Suspect 1 (`model_availability_nux` popup) — genuinely untestable under this task's own constraints

Two independent, re-verified facts jointly make this suspect impossible to test live, not merely
inconvenient to test:

**1. Isolating `CODEX_HOME` breaks auth — re-verified fresh against codex-cli 0.153.4**, not just trusted
from `codex-doctrine.ts`'s existing header comment. Positive control first (the check CAN report
positive): `codex login status` against the real `~/.codex` → `Logged in using ChatGPT`. Then the test:
the identical command with `CODEX_HOME` pointed at a fresh scratch dir → `Not logged in`, plus a refusal to
create helper binaries under that path. Codex resolves `auth.json` under `CODEX_HOME`; copying or reading
that file was explicitly out of scope for this task (its kickoff: *"If auth can't be isolated without
copying the owner's credentials file, STOP and report rather than copying secrets around"*). So a genuinely
fresh, isolated, STILL-AUTHENTICATED codex home — the precondition for the NUX counter to read 0 for a
never-used model — does not exist as an option here.

**2. The real, shared `~/.codex/config.toml` already carries `[tui.model_availability_nux]` /
`gpt-6-astra = 4`** (read-only check, unchanged from `760f2874`'s own snapshot). Whatever threshold codex
checks against that counter, it is not re-triggering on this host for this model today — consistent with
(not proven by) the reachable-gateway trial above, which used this same real home and captured no
NUX-shaped screen text. Resetting that counter, or deliberately choosing a never-used model to provoke a
fresh first-use trigger, both require writing new persistent state into the real `~/.codex/config.toml` —
this task's kickoff explicitly forbids editing the owner's real `~/.codex`.

Both avenues this card's own kickoff offered for getting a fresh counter — isolate the home, or use the
shared real one — are closed by the task's own safety constraints, not by any further investigation that
could still be done today. This is reported as a structural inability to reproduce, not a decision to stop
looking.

`codex --help` was also checked for a documented alternate env var name (per this task's own instruction
to verify, not assume, which variable 0.153.4 actually honours) — `CODEX_HOME` is the only one referenced
(`-p/--profile`'s own help text: *"Layer $CODEX_HOME/<name>.config.toml on top of the base user config"*),
confirming there is no second, less-sensitive override to reach for instead.

## What static analysis of the real codex.exe (0.153.4, win32-x64) could and couldn't recover

Extracted printable strings from the installed native binary
(`@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`, resolved via Loom's own
`resolveExecutable`) to look for the popup's own rendered text without triggering it live. Confirmed
`model_availability_nux` is a real, persisted TUI config field — listed alongside plain UI-state fields
(`animations`, `show_tooltips`, `auto_recap`, `keymap`, `theme`, `terminal_resize_reflow_max_rows`),
structurally DISTINCT from the `Notice` struct's own boolean `hide_*` flags (`hide_rate_limit_model_nudge`,
`hide_gpt5_1_migration_prompt`, `hide_gpt-5.1-codex-max_migration_prompt`, `hide_full_access_warning`,
`hide_world_writable_warning`) — consistent with it being a per-model counter (`gpt-6-astra = 4` in the
real config), not a one-shot boolean flag.

As a positive control that the extraction method itself works: found the exact rendered text for the
NEIGHBORING `hide_rate_limit_model_nudge` dialog — `"Approaching rate limits\nSwitch to <model> for lower
credit usage?"`, with options `"Keep current model"` / `"Keep current model (never show again)"` /
`"Hide future rate limit reminders about switching models."` This proves the method CAN recover real TUI
dialog copy when it's present contiguously in the binary. But the SAME method could NOT find the
`model_availability_nux` popup's own rendered copy — its message likely assembles the model's display name
at runtime from non-contiguous string fragments (the catalog strings `gpt-6-astra`/`GPT-6-Astra`/etc. live
~1.3MB away in the binary from the `model_availability_nux` field-name occurrences), or its literal text is
constructed in a way this flat-string approach can't reach.

Also checked and ruled out as alternate read-only sources for the popup's text: `codex features list` (no
feature-flag entry matches `nux`/`availability` — ~150 flags enumerated, confirming this isn't a `features`
toggle at all) and `codex debug {models,prompt-input}` (neither subcommand surfaces TUI notice copy).

## Circumstantial correlation worth recording, not treating as confirmation

The real config's NUX counter reads exactly `4`. The production incident's own evidence (`760f2874`) names
exactly 4 failed `worker_spawn`/`worker_recycle` deliveries (plus 1 failed mid-session `worker_message`
inside one of those 4 sessions) in a single ~11-minute window — consistent with, though not proof of, each
of those 4 FRESH spawns triggering the popup once each, swallowing the confirm-Enter into the notice
instead of the composer, before the counter reached whatever threshold stops it firing again. This is
circumstantial, not measured: no screen text was ever captured showing the popup actually present during a
failure, in this investigation or `760f2874`'s.

## Why no fix was attempted

This task's kickoff names two outcomes depending on what's found: if a popup blocks submission, detect it
loudly or dismiss it safely, proven by a real-spawn RED/GREEN test; if nothing reproduces, write up what
was tried and report "not reproduced" rather than manufacture a fix. The suspect most likely to be the real
cause (the NUX popup) could not be observed live under this task's own safety constraints (no credential
copying, no editing the owner's real `~/.codex`), so there is no live screen capture to build a detector
from, and no RED case to prove a GREEN against. Writing detection/dismissal code against a popup whose
trigger condition and keystroke handling were never directly observed would be exactly the "manufacture a
fix" this task warns against — a guess dressed as a fix, with no way to verify it before shipping it.

## Bottom line

NOT REPRODUCED. The reachable-gateway suspect is refuted for n=1 (same caveat as every other real-spawn
trial in this family: host-state-dependent, not a proof for all conditions). The NUX-popup suspect remains
the single most plausible explanation, supported by a non-trivial count-correlation, but cannot be
confirmed or refuted live under this task's own safety constraints. No code was changed.

**Recommendation, not a decision:** if this needs to be resolved with certainty rather than left as a
strong-but-unconfirmed suspicion, the owner (who controls the real `~/.codex`) is the only party who can
unblock either closed avenue — either authorizing a deliberate, disclosed reset of the
`[tui.model_availability_nux]` counter on the real host for a controlled observation, or providing an
already-authenticated secondary codex profile that can be pointed at via `CODEX_HOME` without copying the
primary profile's credentials. Absent that, a future worker re-attempting this investigation will hit the
exact same two closed avenues this one did, and should not re-spend a real codex spawn trying to route
around them — this document is a complete account of what was tried.

## Source

Real-spawn repro script (reachable gateway + true `worker_spawn`-shaped kickoff) run once on 2026-10-14
against codex-cli 0.153.4 / Loom HEAD `6e2c910c`; not committed (same posture as `760f2874`'s own repro
scripts). `codex login status` isolation check (zero model turns) and binary-string extraction against the
real installed `@openai/codex-win32-x64` 0.153.4 native binary (read-only), plus a read-only check of the
real `~/.codex/config.toml`'s `[tui.model_availability_nux]` section. One real model turn spent total (the
reachable-gateway trial's own "Reply with exactly: PONG").
