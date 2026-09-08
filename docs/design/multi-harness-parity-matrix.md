# Multi-harness parity matrix — Codex CLI (Phase 1)

Multi-harness epic `df1f94b0`. Lineage: `049e4a7b` (documented-only probe) → `a7d74718` (empirical pty
probe, GO-WITH-NAMED-DEGRADATIONS, `docs/investigations/049e4a7b-codex-cli-capability-probe/findings.md`)
→ `353f6dc4` (this card — the adapter build). This doc tracks what is actually SHIPPED for the `codex`
harness against `HarnessAdapter` (`packages/daemon/src/pty/adapter.ts`), per-capability, with every
degradation named — not what the probe found possible, which `findings.md` already owns.

## Status at the end of card `353f6dc4`'s third pass

**Shipped:** the harness-selection field (`Profile.harness`/`Session.harness`, pinned, human-only), the
read-only half of `HarnessAdapter` for `codex` (transcript parsing, version cache, liveness watch), the
**`sessions/service.ts` wiring** (resolveProfile/resolveAgentSpawn resolve `harness` and every fresh-spawn/
resume/fork/recycle/worker_spawn call site pins/carries it onto the Session row and into `SpawnOpts`,
mirroring the `browserTesting` precedent exactly), `pty/codex-host.ts`'s **pure, tested decision logic**
(trust-dialog detect/answer, busy/idle detection, MCP-url→codex-argv translation, the in-process
trust-dialog lock), and — after lead ruling #5 superseded ruling #3's "share `this.live`" shape (see §2
below) — **the actual codex STATEFUL RUNTIME is now built and wired**: a separate `liveCodex` registry +
`findAnyLive` resolver, `spawnCodexProcess`/`createCodexPty` (a real node-pty spawn), and the
submit/drain/stop/interrupt methods (`enqueueStdinCodex`/`submitCodex`/`drainCodexPending`/`stopCodex`/
`interruptForRedirectCodex`). **A real-spawn test drove this actual implementation against a real,
installed codex CLI and found (and this pass fixed) two genuine bugs a mocked exec could never have
caught** — see "Real-spawn findings" below. DoD-1 (adapter built behind the `HarnessAdapter` seam) is now
essentially complete for the worker role; DoD-2 (a full real end-to-end board card, with a live manager +
project) remains OUTSTANDING and is the dispatching lead's to provision, per this card's own ruling.

## Per-capability parity

| Capability | Claude | Codex | Degradation / note |
|---|---|---|---|
| `resolveBinary` | ✅ | ✅ | Both resolve via `resolve-bin.ts#resolveExecutable`. |
| `locateTranscript`/`transcriptExists`/`readTranscript` | ✅ | ✅ (partial) | Codex's rollout-JSONL format is real and parsed (`pty/codex-transcript.ts`, built on THREE real rollout files inspected structurally on this host) — but every real sample available was a trivial one-word exchange. `role:"assistant"` on a `response_item`, any `item_completed.item.type` other than `"UserMessage"`, and a real tool-call shape are **UNCONFIRMED** — see that file's own header. The parser falls back to `task_complete.last_agent_message` for assistant text, which is a documented-by-naming field but likewise unobserved populated on this host. Re-verify once a real substantive Codex worker session exists (do NOT re-spend subscription turns solely to firm this up). |
| `snapshotTranscript` | ✅ | ✅ | Codex mirrors claude's archive-copy logic, reusing the harness-agnostic `sessions/transcript.ts#archivedTranscriptPath`. |
| `readContextStats` (contextTelemetry) | ✅ | ❌ **honest gap, not a real absence** | The probe confirmed a live "N% context left" TUI footer AND a `token_count` rollout-record type exists — but every real sample's `token_count.info` payload was `{}` (empty). The field names for a POPULATED usage record are unconfirmed. Declaring `false` rather than guessing field names that would silently misreport on every real session (this project has shipped a silently-wrong implementation once before — see the card's own DoD-5 note). Recycle fallback per Phase 0: turn-count based, not context-token-based, for `codex` sessions until this is confirmed. |
| `readCumulativeUsage` (usageTelemetry) | ✅ | ❌ same gap | Same reasoning as `readContextStats`. |
| `readRateLimitStatus` (rateLimitStatus) | ❌ (no live poller instance) | ❌ | Same as `claudeAdapter` — no account-wide usage poller wired for either harness's static adapter object. |
| `watchLiveness` (livenessWatch) | ✅ | ✅ | Codex mirrors claude's chokidar-watch-with-swallowed-errors pattern, watching `~/.codex/sessions` (via `realCodexHome()`, see below) instead of `~/.claude/projects`. |
| `doctrineInjection` | `"directory"` (`.claude/skills`) | `"none"` | **NOT YET BUILT.** Codex's convention is `AGENTS.md` (a single file, not a directory of skill files) — mapping Loom's `/worker`-equivalent doctrine + skill content into that shape is real, un-started design/build work, named in the card's own scope. This pass prioritized the stateful-runtime build (spawn/submit/stop — DoD-1's blocking piece) over this; still open for a future pass. |
| `vendorProcessSlashCommand` (builtinReset) | ✅ (`/clear`) | ❌ | No documented in-band reset command found for Codex in the `--help` sweep or the probe. Real absence, not a declared-honest gap — Codex simply doesn't appear to have one. |
| `readCachedVersion` (versionGating) | ✅ | ✅ | Mirrors `usage-status.ts`'s async-prewarm/non-blocking-read pattern exactly (`codex-doctrine.ts`). **A real-spawn test caught a genuine bug here**: an npm-global Windows install of `codex` resolves to a `.cmd` shim, and plain `child_process.execFile` (unlike `execSync`/node-pty's Windows agent) refuses to run a `.cmd` directly without `shell:true` — the version cache silently never populated until fixed. This is exactly the failure class DoD-5's real-spawn requirement exists to catch; a mocked exec would never have caught it. |
| `buildSpawnArgs`/`submit`/`isBusy`/`handleHookEvent` (the stateful runtime) | ✅ (`pty/host.ts`, ~5,800 lines) | ✅ **built this pass** — `spawnCodexProcess`/`createCodexPty`/`enqueueStdinCodex`/`submitCodex`/`drainCodexPending`/`stopCodex`/`interruptForRedirectCodex` (own registry, `liveCodex`, never `Live`/`this.live` — see §2). Real-spawn-tested; two genuine bugs found and fixed (see "Real-spawn findings" below). No give-up ladder, no verify-and-retry, no fairness reordering/coalescing on the pending queue — busy/idle regex detection is the only turn-confirmation signal, a named Phase-1 simplification versus claude's hook-confirmed ladder. | |

## Open architecture questions (reported up, not decided unilaterally)

### 1. `sessions/service.ts` wiring — ✅ DONE this pass
Card `e98877b1` (the sibling reserving this file) merged to main (`0724d2f5`) before this pass started, so
the file was mergeable. `resolveProfile` (`packages/shared/src/config.ts`) now resolves `Profile.harness`
into `ResolvedProfile.harness` (backstop `null` ⇒ "claude", mirroring `model`'s null-backstop shape rather
than a boolean-flag backstop like `browserTesting`), `resolveAgentSpawn` threads it through, and every one
of the ~15 real call sites — `startNew`/`startManager`/`startPlatformLead`/`startAuditor`/
`startWorkspaceAuditor`/`startSetup`/`startOperator` (fresh spawn), `resume`, `forkSession`, `spawnWorker`
(worker_spawn), and `recycleWorker`/`recycleManager`/`recyclePlatformLead` — pins/carries `harness` onto
the `Session` row and into the `pty.spawn`/`pty.resume` `SpawnOpts`, exactly mirroring `browserTesting`'s
own carry-forward pattern (`old.harness ?? undefined` on recycle/fork, `session.harness ?? undefined` on
resume — never re-resolved from a possibly-changed profile). Deliberately EXCLUDED, matching `model`'s own
exclusion for the same reasons: the ephemeral `run`-role session (`startRun`, always the engine default)
and `upgradeCompanionCapabilities` (re-resolves the capability *surface* only, never the spawn binary —
mirrors that function's own existing `model` exclusion). Verified: `pnpm --filter @loom/daemon build`
clean, `node test/browser-testing-spawn.mjs` (the exact e2e mirror this pattern reuses) still green
end-to-end, `node test/entity-row-fields-guard.mjs` and both `harness-adapter-*.mjs` conformance tests
green. **Still purely additive** — nothing in `pty/host.ts` reads `SpawnOpts.harness` yet (see §2), so
every resolved value stays byte-identical to `undefined` ("claude") for every project that hasn't set the
field, and `harness` has no observable effect until §2 ships.

### 2. The stateful runtime's integration shape into `PtyHost` — ruling #3 superseded by ✅ lead ruling #5

Ruling #3's original approved shape shared `this.live` with claude (a `kind:"codex"` widening of `Live`
itself). This pass read the `Live` interface (`pty/host.ts:2804` onward) field-by-field to actually build
that object literal, rather than assuming the count/shape from the earlier inventory pass, and found the
real cost was materially different from what ruling #3 assumed — reported up as an escalation (the box
below, kept for the record) rather than built unilaterally. **Ruling #5 accepted the escalation and
changed the shape: `this.live` stays PURELY claude/shell/canned; a codex session lives in its own,
separate private map (`liveCodex`), with its own minimal `CodexLive` interface carrying ONLY the fields a
codex session genuinely has.** The one condition ruling #3 got right and ruling #5 kept: a SINGLE resolver
(`findAnyLive`) is the only place any harness-agnostic method looks up session state, so TypeScript itself
forces narrowing anywhere a claude-only field would be touched — compile-time fail-loud, not a review
convention. See `pty/codex-host.ts` / `pty/host.ts`'s own `CodexLive`/`findAnyLive` doc comments for the
full reasoning; not restated here to avoid a second copy that can drift.

**The three ruling-#3 conditions, resolved under ruling #5's shape:**
1. **Fail loud, never silently misbehave.** ✅ Satisfied structurally, not by convention: `CodexLive` has
   no claude-only field to touch AT ALL — a bug that tries reaches a genuine TypeScript compile error via
   the `findAnyLive` union return type, not a runtime `undefined` guess.
2. **The "zero extra code for agnostic methods" claim must be tested, not asserted from inspection.** ✅
   Done — `test/pty-codex-agnostic-methods.mjs` registers a real `CodexLive` directly into `liveCodex` and
   drives all 28 migrated AGNOSTIC methods through it, both the positive cases AND a negative control
   (every accessor reads genuinely ABSENT for an unregistered sessionId — see that test's own header).
3. **This inventory belongs in this doc, not just a report.** ✅ See the full classification below — every
   stateful method on `PtyHost`, one line each; unchanged by the ruling-#5 shape change (the classification
   itself didn't need to change, only WHERE a migrated AGNOSTIC method's `Live` lookup now resolves from).

### ⚠️ Escalation record (superseded by lead ruling #5 — kept for why the shape changed, not as live guidance)

Ruling #3's condition 1 framed the shared-`this.live` shape as cheap: *"the codex `Live` is built WITHOUT
the ~40 claude-only fields, so a missed guard throws a TypeScript/runtime error the first time it's hit,
rather than silently reading undefined."* Reading `Live` field-by-field found the real cost was materially
different:

- **The real field count is closer to ~60 than ~40**, and the great majority are NOT simple scalars —
  they are `Map`/`Set`/array-of-structured-record fields backing the give-up ladder, the composer-drift
  detector, and FOUR separate mismatch-detection sub-systems, each with real, non-obvious invariants
  documented in-line across roughly 800 lines of comments — not inert bookkeeping a sentinel can safely
  paper over without reading and understanding each one.
- **Making these fields optional** (the literal reading of "built WITHOUT" the claude-only fields) would
  have turned every one of the MANY existing internal call sites that read them via bare `live.field` (not
  `live.field?.`) into a `possibly undefined` compile error — not a bounded, enumerable list the way
  `browserTesting`'s ~15 call sites in `sessions/service.ts` were, but scattered across the give-up/
  mismatch machinery this same file's own doctrine describes as ~5,800 lines of dense, load-bearing TUI
  automation.
- **Populating the fields with sentinel values instead** (keeping them required) would have avoided the
  type-level ripple, but a populated-but-empty `Map`/`Set` reads as "measured, nothing there" — precisely
  the absent-vs-zero hazard ruling #4 exists to prevent, and the lead's own re-derivation named this the
  DECIDING reason to reject it (see ruling #5's own text): it could have let a mismatch-detection subsystem
  quietly *act* on a codex session.

**Lead ruling #5 re-derived, rather than repeated, ruling #3's own rejection of a separate registry**: that
rejection assumed a split would *"force dispatch into every external caller (`sessions/service.ts`,
`index.ts`)"* — checked at source and found FALSE (`this.live` is `private`, zero external files touch it
directly). The objection evaporated once checked, which is why the shape changed rather than the report
simply being accepted as a dead end. The pure decision logic (`codex-host.ts`) and the classification
inventory (below) both carried over unchanged into the final shape — neither was wasted work.

## Real-spawn findings — two genuine bugs a mocked exec could never have caught

`test/codex-stateful-runtime-real-spawn.mjs` drives the ACTUAL `spawnCodexProcess`/`createCodexPty`
implementation (not a hand-rolled duplicate) against a real, installed, authenticated codex CLI. Two real
bugs surfaced and were fixed in the same pass, both load-bearing for DoD-1:

1. **`screenScan` encoding.** The codex onData handler accumulated `buf.toString("utf-8")`, where `buf` is
   a `Buffer` built via `Buffer.from(d, "utf-8")` from node-pty's raw `d` string. That round-trip is NOT
   lossless for a Windows ConPTY string carrying byte values outside valid UTF-8 sequences (box-drawing/
   OEM-codepage bytes) — it corrupted the trust-dialog marker text in a real run, and `isTrustDialogPrompt`
   never fired. **Fix:** accumulate the raw `d` string directly, exactly matching claude's own
   `bootScan`/`resumeGateScan` convention in this same file (claude's onData handler already does this
   correctly; codex's own scan buffer had simply used the wrong source).
2. **The trust-dialog answer write.** A single combined `pty.write("1\r")` never registered against a
   real codex TUI — confirmed directly: the process sat at "Press enter to continue" with ZERO further
   output for 30+ real seconds, and `config.toml` never changed. Splitting into TWO separate writes ("1",
   then `CODEX_SUBMIT_ENTER_DELAY_MS` later "\r") — mirroring `submitCodex`'s own independently-OBSERVED
   two-write recipe for regular text submission — resolved it immediately and reproducibly (confirmed
   twice in a row): codex advanced past the dialog to its own ready state both times.

**A related, deliberately-NOT-"fixed" finding, disclosed rather than chased further:** without a real
gateway/MCP router listening, codex's own MCP-server-startup episode fails to connect, and its title-bar
busy-spinner marker (`BUSY_TITLE_SPINNER_RE`) gets stuck indefinitely (`isCodexBusy` reads permanently
`true`) — a REAL, plausible-in-production degenerate state if a worker's MCP servers ever fail to connect
(network hiccup, gateway not yet listening), not exercised or fixed by this pass. MCP reachability against
a REAL gateway is already covered by `test/codex-mcp-reachability-real-spawn.mjs` (which re-confirms clean
on this same host); a real end-to-end worker under full production conditions (live manager, real project,
real gate) is DoD-2, explicitly the dispatching lead's to provision.

## The two landmines (probe-established, carry forward into the eventual stateful build)

1. **The undocumented first-use-per-directory trust dialog** (`TRUST_DIALOG_MARKER` in
   `pty/codex-doctrine.ts`) fires on every fresh Loom worktree, before any real prompt can be written. A
   `CODEX_HOME` override to isolate it (the obvious fix) is **empirically ruled out** — see below.
2. **The idle placeholder is a false-positive trap.** `Ask Codex to do anything` is static UI chrome
   present during busy too; idle must key off `BUSY_STATUS_MARKER`'s (or `BUSY_TITLE_SPINNER_RE`'s)
   ABSENCE, never the placeholder's presence.

## `CODEX_HOME` — empirically ruled out, every Codex worker shares the REAL profile

Card `353f6dc4`'s lead ruling asked whether an overridden `CODEX_HOME` could isolate a worker's Codex
profile the way `browserTesting`'s Playwright or a claude worktree's own `.claude` settings are isolated.
**Measured, not inferred:** `codex login status` against the real profile reports "Logged in using
ChatGPT" (positive control); the SAME command with `CODEX_HOME` pointed at a fresh temp dir reports "Not
logged in" and creates no auth material there, plus a separate warning that Codex refuses to create
helper binaries under a temp-dir `CODEX_HOME` at all. Copying/reading `auth.json` to work around this is
explicitly forbidden by the card. **Conclusion: every Codex worker on a host spawns against the ONE real,
shared `~/.codex/config.toml` + `sessions/` tree** — a genuine, disclosed limitation, not an oversight.
Concurrent Codex workers on the same host racing the trust-dialog's config write is a known risk —
**addressed**: an in-process lock now serializes the first-use trust-dialog window (see "The stateful
runtime" below), bounded in-process only (no cross-process/daemon-restart durability, no lockfile
protocol — a daemon restart mid-window is not covered).

## MCP wiring — no proxy needed, and this is now a MEASURED result, not an inferred one

**Lead ruling #2 correctly challenged the first pass here**: the original transient `-c
mcp_servers.<id>.url=` check pointed at a deliberately unreachable port (`127.0.0.1:1`) and proved only
that codex ACCEPTS a URL-typed config entry — configurability, not reachability, and the card's own named
risk ("MCP tools actually reachable from inside a Codex session") was still open. `codex mcp list`/`codex
mcp get --json` were checked next and **do not help**: both report only the CONFIGURED transport
(`Status: enabled, Auth: Unsupported`) — identical output whether the endpoint is listening or not,
confirmed by re-running the same command against the same unreachable port.

**Settled by driving a real pty boot against a real, live Loom MCP endpoint** — `buildServer()` +
`app.listen()` + a real `TaskMcpRouter`, the exact harness `test/repeated-tool-call-mcp.mjs` already
establishes, with `codex` pointed at it via `-c mcp_servers.<id>.url=http://127.0.0.1:<port>/mcp/<sessionId>`
(the identical URL shape `pty/host.ts#buildMcpServers` already builds for claude's `--mcp-config`, per
that function's own `:2114`-`:2117`). **Loom's own server-side `[mcp]` inbound-request log — not codex's
self-report — recorded a real MCP handshake completing:**
```
[mcp] codex-reach-probe router=task method=initialize tool=- rpcId=0 seq=1
[mcp] codex-reach-probe router=task method=notifications/initialized tool=- rpcId=- seq=2
[mcp] codex-reach-probe router=task method=tools/list tool=- rpcId=1 seq=3
```
No error at any point (the TUI's own `Starting MCP servers (N/4): ...` status line settled to idle with
no error banner), zero model turns spent (the probe never submitted a prompt — it drove the pty only up
through session-boot MCP startup, then exited cleanly via the confirmed double-Ctrl+C). This is genuine
connect + handshake + tool-enumeration evidence, not a config-acceptance inference. **No proxy component
is needed** — codex can point straight at Loom's existing HTTP MCP endpoints.

## Original (superseded) reasoning, kept for the record

The original architecture proposal assumed Codex's `-c mcp_servers.<id>.*` override was stdio-only and
planned a custom stdio↔HTTP proxy asset (mirroring `hook-relay.mjs`). **Refuted by direct measurement**:
`codex mcp add --help` documents `--url <URL>` for "a streamable HTTP MCP server", and `-c
mcp_servers.<id>.url=...` was verified transient (present in one `codex mcp list -c ...` call, gone on
the next, `config.toml` md5 unchanged) — the exact same per-invocation-only shape the probe already
verified for the stdio form. **Codex can point straight at Loom's existing `http://127.0.0.1:{port}/mcp-orch/:sessionId`
endpoints**, the same shape claude's `--mcp-config` already uses. No new bundled asset needed for this.

## `PtyHost` full method inventory — AGNOSTIC / GUARDED / CLAUDE-ONLY (lead ruling #3, condition 3)

Every stateful/public method on the `PtyHost` class (`pty/host.ts`), classified for what a codex session
needs from it. **Written when no codex Live/registry existed yet; the classification held up under the
actual build** (a codex session now lives in a separate `liveCodex` map, not a `kind:"codex"` `Live` —
ruling #5 superseded ruling #3's shared-map shape, see §2 above — but which methods are AGNOSTIC/GUARDED/
CLAUDE-ONLY didn't change, only where an AGNOSTIC method's lookup resolves from: `findAnyLive`, not
`this.live` directly). **Confidence is stated per row, honestly** — `[read]` means the
method body was read directly and the classification is verified; `[grep]` means classified by searching
the whole file for Claude-only field names (`composerDirtyLen`, `giveUpOrigin`, `pendingMismatch*`,
`rateLimited`, `modeLogged`, `humanSubmitHeld*`, `lastMismatch*`, `readyFallbackTimer`, `composerLen`,
`rawDraftText`) and mapping hits to method line-ranges — a systematic but not line-by-line-traced check.
**AGNOSTIC** = touches only kind-independent `Live` fields (`pid`/`cwd`/`alive`/`killed`/`busy`/`ring`/
`subscribers`/`pending`/`activeTurn*`/`recentOwnerTurns`) or class-level maps keyed by sessionId (not
`Live` at all) — works for `codex` with zero changes once a codex `Live` populates those same fields.
**GUARDED** = already excludes non-`"claude"` kinds via an explicit `live.kind` check, or needs one added
before a `codex` `Live` can safely reach it. **CLAUDE-ONLY** = reads/writes fields that only make sense for
Claude's Ink-TUI automation (composer-dirty tracking, give-up ladders, mismatch detection, mode-cycling) —
meaningless for codex, safe to never populate on a codex `Live` (an accessor returns `undefined`/`false`
gracefully; a mutator must be guarded per condition 1 above if reachable from a codex code path at all).

| Method | Class | Confidence | Reason |
|---|---|---|---|
| `spawn` | GUARDED — ✅ DONE | `[read]` | Constructs the `Live` literal with `kind:"claude"` hardcoded — THE integration point. An early `harness==="codex"` branch now dispatches to `spawnCodexProcess` before any of this runs. |
| `spawnShell` | N/A (shell, unrelated) | `[read]` | Human-terminal tiles; orthogonal to AI harnesses per `pty/adapter.ts`'s own doc. |
| `seedCanned` | N/A (canned, test-only) | `[read]` | Test replay fixture; unrelated. |
| `dropCanned` | GUARDED (pre-existing) | `[grep]` | `if (!live \|\| live.kind !== "canned") return;` — already kind-gated, codex naturally excluded. |
| `resize` | AGNOSTIC | `[grep]` | Shell-only geometry resize; claude/codex are pinned-geometry (never resized) either way. |
| `listShells` | N/A (shell, unrelated) | `[grep]` | Filters `kind==="shell"` for the terminal-tiles list. |
| `verifyHookToken` | GUARDED (pre-existing) | `[read]` | `if (!live \|\| live.kind !== "claude") return false;` — already excludes codex; codex has no hook relay at all. |
| `deliverHook` | GUARDED (pre-existing) | `[read]` | `if (live.kind !== "claude") return;` — already excludes codex; codex's MCP tool calls arrive via HTTP, never a hook POST. |
| `enqueueStdin` (both overloads) | GUARDED — ✅ DONE | `[read]` | The queue PUSH is generic (`live.pending.push`), but the drain-trigger logic it calls is Claude-specific (composer/give-up checks). Now dispatches to `enqueueStdinCodex` (own, simpler push+drain-on-idle path — plain FIFO, no fairness reordering/coalescing/give-up-hold). |
| `consumeToolAttribution` | AGNOSTIC (but never fires for codex) | `[read]` | Touches `this.toolAttribution`/`this.subagentDrift` class maps, not `Live` — structurally safe, but nothing populates it for codex since `deliverHook` (the only producer) already excludes codex. |
| `recordToolCallArgsHash` | AGNOSTIC, useful for codex | `[read]` | Touches `this.repeatedCalls`, not `Live` — called from gateway/server.ts on every MCP tool call regardless of harness; directly useful for codex too. |
| `markMcpSeen` | AGNOSTIC, useful for codex | `[read]` | Touches `live.alive`/`live.mcpSeen`/`live.mcpSeenWaiters` — generic fields; this is literally the mechanism the MCP-reachability smoke test's daemon-side log rode. |
| `waitForMcpSeen` | AGNOSTIC, useful for codex | `[read]` | Same as above. |
| `getPending` | AGNOSTIC | `[read]` | Reads `live.pending` (generic array). |
| `getActiveTurnOrigin` | AGNOSTIC | `[read]` | Reads `live.activeTurnRoute`, set at submit()/enqueueStdin — generic Companion-routing metadata. |
| `getActiveTurnIsProactive` | AGNOSTIC | `[read]` | Reads `live.activeTurnProactive` — same family as above. |
| `getActiveTurnOwnerText` | AGNOSTIC | `[read]` | Reads `live.activeTurnOwnerText` — same family. |
| `getRecentOwnerTurns` | AGNOSTIC | `[read]` | Reads `live.recentOwnerTurns` — same family. |
| `getActiveTurnSenderId` | AGNOSTIC | `[read]` | Reads `live.activeTurnSenderId` — same family. |
| `getPersistablePendingSnapshot` | AGNOSTIC | `[grep]` | Operates on `live.pending`, no Claude-only scalar fields referenced. |
| `getPendingEntries` | AGNOSTIC | `[grep]` | Same — `live.pending` array projection. |
| `pendingAgentCount` | AGNOSTIC | `[grep]` | Same. |
| `consumePending` | AGNOSTIC | `[grep]` | Same. |
| `flushPending` | AGNOSTIC | `[grep]` | Same. |
| `purgeQueuedByQuestionIds` | AGNOSTIC | `[grep]` | Same. |
| `purgeQueuedByReportEventIds` | AGNOSTIC | `[grep]` | Same. |
| `purgeQueuedWorkerReportNudgesForWorker` | AGNOSTIC | `[grep]` | Same. |
| `purgeQueuedWorkerIdleNudges` | AGNOSTIC | `[grep]` | Same. |
| `deleteQueued` | AGNOSTIC | `[grep]` | Same. |
| `editQueued` | AGNOSTIC | `[grep]` | Same. |
| `reorderQueued` | AGNOSTIC | `[grep]` | Same. |
| `isComposerDirty` | CLAUDE-ONLY | `[grep]` | `return live.composerLen > 0` — Ink-TUI composer concept, no codex equivalent. |
| `reconcile` | GUARDED (pre-existing) | `[read]` | `if (!live.alive \|\| live.kind !== "claude") continue;` inside its per-session loop — already excludes codex from ALL healing logic (give-up detection, mode-cycle repair). Codex sessions get no automatic healing under this design — acceptable for a Phase-1 pilot, named here as a real gap. |
| `flushComposer` | CLAUDE-ONLY | `[grep]` | Heavy `composerDirtyLen`/`giveUpOrigin` usage throughout. |
| `hasAmbiguousMatch` | CLAUDE-ONLY | `[grep]` | Adjacent to `giveUpConfirmQueue` handling. |
| `resumeAfterRateLimit` | CLAUDE-ONLY | `[grep]` | Reads `live.rateLimited`/`live.lastPrompt` — Claude's OWN usage-cap detector; codex would need its own separate concept if this becomes relevant. |
| `subscribe` | AGNOSTIC | `[grep]` | Touches `live.subscribers`/`live.ring` only. |
| `writeStdin` | MISCLASSIFIED — ✅ FIXED this pass (Code Review M4) | `[read]` | ⚠️ **CORRECTION**: this row was WRONG. `writeStdin`/its private `writeChunked` read ONLY `this.live.get`, so a codex session (never in that map) had every raw human keystroke into its terminal tile silently discarded — the opposite of "raw pty write passthrough." `pty-agnostic-methods-findanylive-guard.mjs`'s own header already excluded this method from its pinned list and promised "see the parity matrix's own correction" — this row IS that correction, written when the code was actually fixed rather than left as a dangling promise. Fixed via a SEPARATE `writeStdinCodex` (own simpler path, mirrors `stopCodex`/`interruptForRedirectCodex`'s own precedent) dispatched from `writeStdin`'s top — NOT migrated to `findAnyLive` (the rest of `writeStdin`'s body is genuinely claude-Ink-TUI-specific machinery with no codex equivalent, so a shared-resolver migration would be the wrong shape here, unlike the genuinely AGNOSTIC methods above). |
| `repaint` | N/A (shell-only) | `[grep]` | `if (!live?.alive \|\| live.kind !== "shell") return;` |
| `stop` | AGNOSTIC entry point — ✅ DONE | `[grep]` | Generic entry point, but the ACTUAL stop mechanism (Ctrl-C ×2 for claude) differs per harness. Now dispatches to `stopCodex` (probe's own confirmed sequence: 1× Ctrl+C interrupts, a 2nd `CODEX_STOP_GAP_MS` later exits cleanly; a bounded hard-kill backstop mirrors `escalateGracefulStop`'s own shape). |
| `interruptForRedirect` | Same as `stop` — ✅ DONE | `[grep]` | Now dispatches to `interruptForRedirectCodex` — simpler than claude's own (no settle-timer/busySince-snapshot dance needed: codex's regex-based busy detection naturally observes the busy->idle transition and the existing onData-driven drain picks up the queued redirect for free). |
| `setPermissionMode` | CLAUDE-ONLY | `[grep]` | Mode-cycling via footer-text parsing — Ink-TUI-specific; codex has no equivalent permission-mode cycling UI. |
| `isAlive` | AGNOSTIC | `[read]` | `return live.alive ?? false`. |
| `isBusy` | AGNOSTIC | `[read]` | `return live.busy ?? false` — **the single most important proof point**: a codex-specific `onData` handler that sets `live.busy` correctly (per the probe's confirmed busy/idle signals) makes this work with ZERO changes to `isBusy` itself. |
| `holdDrain` | AGNOSTIC | `[grep]` | Touches `live.drainHeld` — generic flag. |
| `releaseDrain` | AGNOSTIC | `[grep]` | Same. |
| `liveStartedAt` | AGNOSTIC | `[grep]` | Reads `live.startedAt`. |
| `getPid` | AGNOSTIC | `[grep]` | Reads `live.pid`. |
| `getLastOutputAt` | AGNOSTIC | `[grep]` | Reads `live.lastOutputAt`, set on every pty data chunk regardless of harness. |
| `getComposerDirtyLen` | CLAUDE-ONLY | `[read]` | Accessor for a Claude-only field; safe no-op (`undefined`) on a codex `Live` that never sets it. |
| `getComposerDirtyLenBelieved` | CLAUDE-ONLY | `[read]` | Same family. |
| `getPendingConfirmMs` | CLAUDE-ONLY | `[grep]` | Adjacent to `humanSubmitHeldUntil` handling. |
| `getLastMismatchReplay` | CLAUDE-ONLY | `[read]` | Accessor for a Claude-only optional field; safe no-op. |
| `getLastFlushAttribution` | CLAUDE-ONLY | `[read]` | Same family. |
| `getLastMismatchFusion` | CLAUDE-ONLY | `[read]` | Same family. |
| `getLastMismatchUnmatched` | CLAUDE-ONLY | `[read]` | Same family. |
| `getLastMismatchNoticeSuppressed` | CLAUDE-ONLY | `[read]` | Same family. |
| `getLastPasteTripwireGiveUp` | CLAUDE-ONLY | `[read]` | Same family. |
| `hasFirstTurnStarted` | AGNOSTIC — fixed by card `361a5520` | `[read]` | Was `this.live.get(id)?.firstTurnStarted` — a bare `this.live.get` on a method the parity matrix itself had flagged "unverified" and this card's own review found reading structurally, permanently `false` for every codex session (indistinguishable from "never started"). Now routes through `findAnyLive`; `CodexLive` carries its own `firstTurnStarted` field, latched at its own chokepoint (`armCodexBusyStaleTimer`'s CASE 2 — codex has no start-confirming hook, so it flips on first CONFIRMED completion rather than start; see that field's own doc in `pty/host.ts`). Same card also wired `onTurnCompleted` into that same CASE-2 edge, so `turnSeq`/`db.incrementTurnSeq` — previously structurally `0` forever for codex and reported to managers as an OBSERVED fact — is now real for codex too. **Round 2 (Code Reviewer's blocking Critical, reproduced empirically):** round 1's wiring fired from CASE 2 unconditionally, which also lands on codex's own pre-submit MCP-startup busy episode (its own `enterWrittenAt` is still `0`, its init value, so CASE 2's `lastBusyMarkerAt >= enterWrittenAt` check is trivially satisfied with NO turn ever submitted) — a real false-positive completion, reproduced hermetically and fixed by gating the completion signal (never the drain itself) on a new `CodexLive.submitOutstanding` latch, set in `submitCodex` and cleared at CASE 2 — see that field's own doc. |

**Net**: of ~59 real `PtyHost` methods, roughly half are AGNOSTIC — of those, the 28 actually reachable for
a worker-role codex session were migrated to `findAnyLive` this pass and proven both ways
(`test/pty-codex-agnostic-methods.mjs`); ~6 are ALREADY kind-gated in a way that safely excludes codex
today (verifyHookToken/deliverHook/dropCanned/repaint/listShells/reconcile); ~15 are genuinely CLAUDE-ONLY
(safe no-ops as accessors — they simply never fire for a codex sessionId, since it's never in `this.live`
at all; no mutator among them is reachable from a codex code path); and the small handful that needed
real, new codex-specific logic rather than either a skip or a free ride — `spawn`, `enqueueStdin`, `stop`,
`interruptForRedirect` — are now built (`spawnCodexProcess`, `enqueueStdinCodex`, `stopCodex`,
`interruptForRedirectCodex`).

## Code Review fixes (lead ruling #6 — 2 Criticals + 5 Majors, all fixed this pass except M6 partial)

Reviewer `c9654317` read the whole branch and found the stateful runtime's ARCHITECTURE sound but its
WIRING incomplete — a codex worker as built would have spawned, sat forever with no task, and even once
dispatched some other way would have dropped messages under an in-flight race and had no queue-recovery
path. Fixed:

- **C1 (kickoff never delivered)**: `spawnCodexProcess` never referenced `opts.startupPrompt` at all.
  Fixed — delivered once codex has rendered its ready placeholder at least once (a safe one-time use,
  distinct from landmine #2's ban on using it for ONGOING idle detection) and the trust dialog, if any, is
  no longer mid-answer, routed through the public `enqueueStdin` so it queues behind a still-busy
  MCP-startup episode rather than racing it.
- **C2 (busy race) / M3 (unbounded staleness)**: busy used to be recomputed from every chunk and the
  marker's mere absence from one snapshot meant "done" — wrong in both directions (a stale accumulated
  match could latch busy forever; a chunk landing in `submitCodex`'s own ~300ms text->\r gap could flip
  busy back to false and let a second message land in a composer still holding the first). Replaced with a
  freshness read (`CODEX_BUSY_STALE_MS`, `armCodexBusyStaleTimer`): only a bounded period with NO fresh
  marker sighting ever declares idle.
- **M9 (no reconcile backstop)**: `reconcile()` never iterated `liveCodex` at all. Now also drains an idle
  codex session's stranded pending queue, mirroring the safety net claude's own `reconcile` provides.
- **M4 (`writeStdin` silently discarded codex keystrokes)**: fixed via `writeStdinCodex` — see that row's
  own correction in the method inventory table above.
- **M7 (`diffConfigAfterSpawn`'s inverted residual disclosure)**: fixed — the residual verdict is now
  driven by whether the post-removal text still differs from `before`, not by whether the expected block
  was found at all.
- **M10 (dead `Live.kind` `"codex"` member)**: removed — nothing has constructed a `Live` with that kind
  since ruling #5's registry split, and it broke exhaustive narrowing in the other direction.
- **M8 / M6 (partial)**: see "Known gaps" below.

New test: `test/codex-queue-state-machine.mjs` — a scripted fake-pty test driving the REAL onData handler
(the queue/turn state machine had zero coverage before this). Confirmed RED against the pre-fix handler
first (temporarily reverted, rebuilt, re-run) before trusting the green.

## Known gaps (disclosed, not silently skipped)

- **M6 — CLOSED (card `2ec60d9c`), and independently proven against a REAL codex spawn**
  (`test/codex-transcript-real-spawn.mjs`: a real `PtyHost.spawn({harness:"codex"})`, one real completed
  turn, `readTranscript(cwd, engineSessionId, "codex")` — the exact seam `worker_transcript` calls —
  returning the real conversation). Both compounding defects are fixed: (1) `CodexLive.engineSessionId` is
  now discovered (not reported — codex still has no SessionStart-hook equivalent) by
  `pty/host.ts#captureCodexEngineSessionId`, which scans for the rollout file codex writes at
  first-real-turn time (`pty/codex-transcript.ts#findConversationIdForSpawn`, matched by cwd+recency) and
  fires it through the SAME `onEngineSessionId` event claude's hook branch uses — the real-spawn test
  ALSO caught and fixed a genuine timing defect in the first cut of this: the rollout file is created
  LAZILY, around when the first turn actually begins, not at process boot, so the original one-shot ~2s
  retry was too narrow (observed landing ~13s after the ready marker on a host whose personal
  `~/.codex/config.toml` carries extra plugin/marketplace MCP servers); retries now extend to
  `CODEX_ENGINE_ID_MAX_ATTEMPTS` (default 40, ~2 minutes total). (2) `sessions/transcript.ts`'s
  `readTranscript`/`resolveTranscriptFile`/`engineTranscriptExists`/`snapshotTranscript`/
  `readArchivedTranscript` now take an optional `harness` param and dispatch through `transcriptOpsFor`,
  ONE resolution site, reusing `pty/codex-transcript.ts`'s already-built parser rather than a second copy.
  The real call-site count/file-list this bullet originally estimated (~20 sites, 8 files) was RE-DERIVED,
  not inherited: all 8 originally-named files needed the change as stated, PLUS two more the original
  estimate missed — `sessions/liveness.ts` (`sweepDeadSessions`'s own dead-transcript check) and `index.ts`
  (the on-exit snapshot call) — 10 consumer files in total. Hermetic coverage: `test/
  transcript-harness-dispatch.mjs` (harness dispatch, fixture-only) and `test/
  codex-engine-session-id-capture.mjs` (a scripted fake-pty proving the discovery+bounded-retry+negative-
  control shape) — both confirmed RED against their respective pre-fix behavior before going GREEN.
- **M5 / M11 / T2** — carded separately per lead ruling #6, not attempted here (p2, off this branch for
  scope).
- **M8's own consumer**: `codexAdapter.readCachedVersion()` is now prewarmable (`prewarmCodexVersionAsync`
  wired in `index.ts`), but nothing calls `codexAdapter.readCachedVersion()` yet either — a separate,
  still-open gap of the same SHAPE M6 used to be (nothing routes this ONE adapter method through the real
  serving code yet), not the same root cause any more now that M6 itself is closed.

## DoD status (card `353f6dc4`)

1. ~~Adapter built behind the existing `HarnessAdapter` seam.~~ **DONE for the worker role** — the
   read-only facet, `sessions/service.ts`'s end-to-end `harness` resolution/pinning, and the stateful
   runtime (spawn/submit/drain/stop/interrupt, `liveCodex` + `findAnyLive`) all ship this pass.
2. **OUTSTANDING** — a real end-to-end Codex worker completing a real board card. ⚠️ **CORRECTED (lead
   ruling #6): this is NOT "blocked ONLY on provisioning."** That claim was checked at source by a Code
   Reviewer and found FALSE before the dispatching lead acted on it — a codex worker never received its
   kickoff prompt at all (C1, now fixed — see "Real-spawn findings" and the queue/turn-state-machine fix
   commit), its transcript was permanently unreadable (M6, now CLOSED and independently proven against a
   real codex spawn per card `2ec60d9c` — see "Known gaps" above), and five more correctness bugs
   (C2/M3/M4/M7/M9) would have made an actual worker unreliable even once dispatched.
   **DoD-2 provisioning stays held until this whole set is fixed AND independently verified at source** —
   see the card's own lead-ruling history for the full accounting.
3. This document.
4. **WIRED (card `c6ce2804`), but END-TO-END CONTINUITY IS UNOBSERVED — do not read this as "confirmed."**
   `createCodexPty`'s argv now leads with `resume <uuid>` when `opts.resumeId` is set and the spawn is not
   a fork (`codex-host.ts#buildCodexResumeArgs`, hermetically tested — `test/codex-host-decisions.mjs`) —
   `resume()`, `session_resume`, and boot-fleet-resume (`resumeFleetOnBoot`) all route through it
   transparently, verified by reading each call site. **`recycle`/`recycleManagerNearLimit`/
   `recyclePlatformLead` do NOT route through this at all, for ANY harness** — all three deliberately spawn
   fresh with a written handoff prompt instead (`recycleWorker`'s own comment: "NOT --resume, which would
   defeat the recycle"), so this wiring changes nothing about recycle behavior; that was a pre-existing
   card-framing error, now corrected. `forkSession()` still falls through to a fresh spawn for codex,
   deliberately: no `--fork-session`/`--session-id`-shaped equivalent was ever found for codex, and reusing
   `resume <uuid>` for a fork would risk two ptys racing writes into one rollout file — a safety choice,
   not a parity gap (loud `console.warn` on that path).
   ⚠️ **Corrected framing (was previously misstated here as "5/5 real runs" of the mechanism itself):** the
   probe's 5/5 figure (State 6) is about codex PRINTING the `codex resume <uuid>` HINT TEXT, unprompted, on
   clean exit — nobody has ever actually invoked `codex resume <uuid>` and observed it continue anything.
   A real-spawn regression test attempting exactly that (spawn → capture engine id → resume → assert the
   resumed process's own self-reported exit id matches) was written and run TWICE against a real,
   authenticated install (once with no MCP gateway, once with a real in-process one) — **both times it
   could not even get an id to resume with**: a codex session that reaches ready state and exits cleanly
   with ZERO turns run writes NO rollout file at all, confirmed directly on disk both times, regardless of
   MCP-gateway state. Relocated (de-registered from the certified real-spawn corpus, which must not carry
   a test that cannot currently pass) to
   `docs/investigations/c6ce2804-codex-resume-rollout-timing/` — see that dir's `findings.md` for the full
   method, what's established vs. merely inferred, and a related claude/codex asymmetry it surfaced
   (carded separately: a codex worker that dies before its first turn has no engine id to resume with at
   all, unlike claude's SessionStart-hook capture — fails SAFE via the pre-existing `engineTranscriptExists`
   guard, not a crash risk). **Net: the resume PATH is wired and its argv-construction is deterministically
   tested; whether it actually restores conversational state has never been observed, and observing it
   would cost a real model turn nobody has spent.**
5. **Real-spawn coverage now spans the full stateful surface** — `test/codex-version-real-spawn.mjs`
   (version-cache, caught the `.cmd`-shim `shell:true` bug), `test/codex-mcp-reachability-real-spawn.mjs`
   (MCP handshake against a real gateway), and the new `test/codex-stateful-runtime-real-spawn.mjs`
   (spawn → trust-dialog → stop/exit against THIS PROJECT'S OWN implementation, not a hand-rolled
   duplicate) — the last of these caught and led to fixing the two real bugs in "Real-spawn findings"
   above. Submit's own busy/idle/interrupt PROTOCOL was empirically validated against the real binary in
   the probe card (`a7d74718`) and is not independently re-validated with a real model turn here (the
   card's own "don't re-spend the owner's subscription" constraint) — `submitCodex`'s code is a direct,
   reviewable transcription of that observed recipe, not a guess.
