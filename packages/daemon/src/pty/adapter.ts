import type { ContextStats, RunUsageStats } from "../sessions/context.js";

/**
 * The harness-AGNOSTIC transcript-turn shape every adapter's `readTranscript` returns (Code Review
 * MAJOR-2, card 2b099e48: DEFINED here, in the interface's own module, rather than inside adapter #1's
 * implementation module — `pty/claude-transcript.ts` re-exports it unchanged for its own callers). The
 * three-way `role` union is Claude Code's OWN JSONL role-encoding quirk (a tool_result physically arrives
 * as `type:"user"` and gets reclassified — see `claude-transcript.ts#classifyRole`'s own doc), not a
 * neutral turn taxonomy; a future adapter with a differently-shaped native turn set (e.g. distinct
 * reasoning/system/error turns) must collapse into these three (see card `100c523f`).
 */
export interface TranscriptTurn {
  role: "user" | "assistant" | "tool_result";
  text: string;
}

/**
 * HarnessAdapter — the seam extracted in card 2b099e48 (Phase 0 of the multi-harness epic `df1f94b0`).
 * Claude Code is refactored to be adapter #1 behind this interface with ZERO behavior change; a second
 * CLI harness (Phase 1+) implements the same shape instead of forking the daemon.
 *
 * ## Coupling audit → method mapping (Scope-1's deliverable)
 * The card's coupling audit enumerated every non-`pty/` file that reads a claude-specific path/format —
 * measured at 18 files by a positive-controlled `\.claude\b|engineSessionId` regex, POSITIVE-CONTROLLED
 * against `pty/claude-config.ts` (20 known hits) so a zero elsewhere means genuine absence, not a broken
 * pattern. ⚠️ **That regex is NOT the whole coupling surface** — widening it by hand (case-insensitive
 * bare `claude`) surfaced a 19th file the narrower pattern is structurally blind to:
 * `companion/chat-gateway.ts:491`, `this.submitTurn(sessionId, "/clear")` — Claude Code's own built-in
 * slash-command literal matches neither `\.claude\b` nor `engineSessionId`. Any future re-derivation of
 * "the coupling surface" from this same regex will silently reproduce that gap; this note is the fix.
 * The final scope is 19 files, not 18 and not the 31 a blanket case-insensitive widen would suggest (3 of
 * the 4 extra "widened" files were comment-only mentions of the external `claude` CLI process with no
 * code coupling to extract — verified by direct read, not assumed from the widened count).
 *
 * | File (call site) | What it needed | Method below |
 * |---|---|---|
 * | `sessions/transcript.ts` | the JSONL path/parse mechanism itself | `locateTranscript`/`readTranscript`/`transcriptExists`/`snapshotTranscript` (this file now RE-EXPORTS `pty/claude-transcript.ts`, which owns the mechanism) |
 * | `sessions/context.ts` | transcript-tail token/context-window parse | `readContextStats` (delegates to the unchanged `sessions/context.ts#readContextStats` — see "Known allowlisted exceptions" below) |
 * | `sessions/usage-sampler.ts` | incremental cumulative-usage parse | `readCumulativeUsage` (delegates to `sessions/context.ts#readRunUsage`/`IncrementalRunUsageReader` — same allowlisted-exception reasoning) |
 * | `mcp/orchestration.ts`, `mcp/transcript-read.ts`, `mcp/platform.ts`, `companion/capabilities.ts` | read a session's transcript, walk-capped | `readTranscript` (unchanged call sites — they already import from `sessions/transcript.ts`'s re-export barrel) |
 * | `gateway/server.ts` | `--resume <id>` respawn (comment only) + transcript-route fallback | `readTranscript`/`transcriptExists` (unchanged call sites) |
 * | `index.ts`, `sessions/boot-backstop.ts` | boot/shutdown snapshot loops | `snapshotTranscript` (unchanged call sites) |
 * | `orchestration/crash-recovery-watcher.ts`, `orchestration/crash-orphaned-workers.ts` | resume-candidacy boolean checks | no method needed — these only check `engineSessionId`/`resumability`, a generic identity field, never a claude literal |
 * | `sessions/liveness.ts` | proactive dead-marking via a `~/.claude/projects` watch | `watchLiveness` (mechanism moved to `pty/claude-doctrine.ts#watchClaudeLiveness`; `sessions/liveness.ts` keeps its own generic `sweepDeadSessions` DB logic and just calls the watch) |
 * | `skills/inject.ts` | mirror skills into `<cwd>/.claude/skills/<name>` | NOT an interface method — `claudeSkillsDir`/`doctrineGitExcludeEntries` (`pty/claude-doctrine.ts`), sharing the `CLAUDE_DOCTRINE_DIR` constant with the row below; the injection/manifest/subset logic itself stays generic and unmoved (allowlisted exception, see below) |
 * | `git/worktrees.ts` | `.claude/` git-status noise filter | NOT an interface method — `isDoctrineArtifactPath`/`isDoctrineSkillsPath` (`pty/claude-doctrine.ts`), the SAME `CLAUDE_DOCTRINE_DIR` source of truth `skills/inject.ts` uses, closing a prior two-independent-lists drift risk. (Code Review B4, card 2b099e48: an earlier draft of this interface also carried a flat `doctrineArtifactPaths(): string[]` member — removed as dead weight: nothing called it, and a flat list can't express the STATUS asymmetry `uncommittedWorkFiles` actually needs — `.claude/` only when untracked, `.claude/skills/` at any status — so a future adapter implementing it faithfully still couldn't drive that filter. The predicates above are the real seam; a future adapter that needs this axis exposes its own predicate pair the same way, not a method on this interface.) |
 * | `db.ts` | the `engine_session_id` column | no method — a plain data column, not adapter behavior; NOT renamed in Phase 0 (unforced churn against the zero-behavior-change constraint) |
 * | `companion/chat-gateway.ts` | the `/clear` built-in reset primitive | `vendorProcessSlashCommand` |
 * | `orchestration/usage-status.ts` | OAuth credentials path + rate-limit/version polling | `readRateLimitStatus`/`readCachedVersion` — only the credentials-path LITERAL moved (`pty/claude-doctrine.ts#claudeCredentialsPath`); the poller class itself is an allowlisted exception (see below) |
 * | `pty/tool-attribution.ts` | Claude Code's `PreToolUse`/`SubagentStart`/`SubagentStop` hook payload shape | `handleHookEvent` — already inside `pty/`, folds in as adapter-native; its one external consumer (`gateway/server.ts#computeAttributions`) already calls the generic, optional-chained `consumeToolAttribution(sessionId, qualifiedTool)` and needed no change |
 *
 * ## Known allowlisted exceptions (DoD: "grep-clean for `~/.claude`/`'claude'` literals … allowlisted
 * exceptions documented")
 * `sessions/context.ts` and `sessions/usage-sampler.ts` construct NO `.claude` path literal in code
 * (they delegate path resolution to `resolveTranscriptFile`/`engineTranscriptPath`, now adapter-owned) —
 * so they already pass the literal grep-clean check without moving. Their PARSING logic (Claude's
 * specific `usage`/`cache_creation_input_tokens`/message-id-dedup JSONL shape) is genuinely
 * claude-format-specific in substance, and `readContextStats`/`readRunUsage` are exposed through this
 * interface's `readContextStats`/`readCumulativeUsage` methods — but their IMPLEMENTATION is deliberately
 * NOT physically relocated in Phase 0: `sessions/usage-sampler.ts` in particular is a live,
 * heavily-tested async incremental-byte-offset parser with real production traffic, and a physical move
 * adds real risk for zero required-DoD benefit. Likewise `orchestration/usage-status.ts`'s
 * `UsageStatusPoller` (endpoint polling + payload parsing) stays in place — only its ONE literal
 * (`DEFAULT_CREDENTIALS_PATH`) moved — because the class is already well-encapsulated and DI'd
 * (`credentialsPath` is an injectable constructor dep), so genuine harness-substitutability is a
 * Phase-1+ swap-the-constructed-class concern, not something Phase 0 needs to force by relocating files
 * with call sites this audit did not fully map (Mission Control's usage strip, boot prewarm, the
 * session-name version gate). Consistent with the standing caution below: an interface with exactly ONE
 * implementation is unfalsifiable as an abstraction until adapter #2 exists — over-fitting the physical
 * file layout to claude's incidental structure is a cost Phase 1+ would have to pay back.
 *
 * ## What deliberately does NOT appear here
 * The give-up/composer-trust retry ladder (`pty/host.ts`'s `submit`, most recently extended by
 * `7d820aef`'s `composerDirtyLenBelieved` check) is Ink-TUI/alt-screen/paste-chunking plumbing, not a
 * generic "send text to an agent" concern — it stays 100% opaque behind `PtyHost`'s own (already
 * pty/-internal) `submit`/`isBusy`/`deliverHook`/mode-cycle methods. A second harness needs DIFFERENT
 * internal state, not a parameterization of this one; generalizing its internals into this interface
 * would be designing for a hypothetical, not a named call site. `Live.kind: "claude"|"shell"|"canned"`
 * (`pty/host.ts`) is likewise UNTOUCHED and orthogonal — `"shell"`/`"canned"` are raw-terminal and replay
 * tiles, not alternate AI harnesses; renaming that discriminator would spray churn across 20+ gates in
 * the highest-risk file in the repo for a rename Phase 0 gets no benefit from. Both are deferred to
 * whichever future phase actually adds adapter #2, which is the only thing that can tell whether this
 * interface's shape (below) is right rather than merely plausible.
 */
export interface HarnessCapabilities {
  /** `readContextStats` is meaningful (a transcript-tail token/context-window read exists). */
  contextTelemetry: boolean;
  /** `readCumulativeUsage` is meaningful (a per-run billed-token accounting exists). */
  usageTelemetry: boolean;
  /** `readRateLimitStatus` is meaningful (an account-wide plan-usage/rate-limit poll exists). */
  rateLimitStatus: boolean;
  /** `watchLiveness` returns a real watcher rather than null (a proactively-watchable transcript store exists). */
  livenessWatch: boolean;
  /** How doctrine (skills/MCP config) reaches the CLI. "directory" = mirrored into a project-local dir
   *  (Claude's `.claude/skills` convention); "none" = no such mechanism. */
  doctrineInjection: "directory" | "none";
  /** `vendorProcessSlashCommand` returns a real in-band command for at least one `kind`. */
  builtinReset: boolean;
  /** `readCachedVersion` is meaningful (spawn-recipe gating reads an installed CLI version). */
  versionGating: boolean;
}

/**
 * The claude-JSONL-format-specific half — see `pty/claude-transcript.ts` (the concrete implementation)
 * and the "known allowlisted exceptions" note above for `readContextStats`/`readCumulativeUsage`.
 */
export interface HarnessAdapter {
  readonly id: string;
  readonly capabilities: HarnessCapabilities;

  /** Resolve the harness CLI's executable path (`pty/resolve-bin.ts#resolveExecutable`). */
  resolveBinary(name: string): string;

  /** Locate a conversation's transcript file on disk, or null if not found. */
  locateTranscript(cwd: string, conversationId: string): string | null;
  /** Whether a conversation's transcript still exists (the resumability check). */
  transcriptExists(cwd: string, conversationId: string): boolean;
  /** Render a conversation's transcript into ordered, harness-agnostic turns. */
  readTranscript(cwd: string, conversationId: string): TranscriptTurn[];
  /** Best-effort copy of a conversation's transcript into Loom's own archive store. Never throws. */
  snapshotTranscript(cwd: string, conversationId: string, projectId: string, sessionId: string): boolean;

  /** Tail-scan a conversation's transcript for its current context-window occupancy. Capability-gated
   *  by {@link HarnessCapabilities.contextTelemetry}; null when unsupported or nothing found. */
  readContextStats?(cwd: string, conversationId: string): ContextStats | null;
  /** Cumulative billed-token usage for a conversation. Capability-gated by
   *  {@link HarnessCapabilities.usageTelemetry}; null when unsupported or nothing found. */
  readCumulativeUsage?(cwd: string, conversationId: string): RunUsageStats | null;

  /** Start watching for a conversation's transcript disappearing, invoking `onRemoved` (debounced) so
   *  the caller can re-sweep its own dead-session bookkeeping. Capability-gated by
   *  {@link HarnessCapabilities.livenessWatch}; a harness without a watchable transcript store returns
   *  null and the caller degrades to reactive existence checks instead (already the case today — see
   *  `orchestration/crash-recovery-watcher.ts`'s "re-verified now rather than trusted outright"). */
  watchLiveness(onRemoved: () => void): { close(): void | Promise<void> } | null;

  /** A vendor-process built-in command Loom can inject as a side-channel turn primitive (never
   *  something a human typed) — e.g. Claude Code's `/clear`. Capability-gated by
   *  {@link HarnessCapabilities.builtinReset}; null when this harness has no in-band equivalent, in
   *  which case the caller skips that half (see `companion/chat-gateway.ts#resetConversation`). */
  vendorProcessSlashCommand(kind: "reset"): string | null;

  /** The installed CLI version already warmed into cache (never blocks — see
   *  `orchestration/usage-status.ts#getCachedClaudeVersion`'s own "no blocking work on the spawn hot
   *  path" invariant). Capability-gated by {@link HarnessCapabilities.versionGating}. */
  readCachedVersion?(): string | null;
  /** The account-wide plan-usage/rate-limit snapshot (never polls per-call — served from one shared
   *  cache). Capability-gated by {@link HarnessCapabilities.rateLimitStatus}. */
  readRateLimitStatus?(): unknown;

  /**
   * Assemble spawn argv + env for this session. Deliberately typed loosely (`unknown` in/out) rather
   * than importing `pty/host.ts`'s real `SpawnOpts`/`buildSpawnArgs` types here: `buildSpawnArgs`
   * stays exactly where it is (`pty/host.ts`, already pty/-internal, already exported, already covered
   * by `test/spawn-args.mjs`) — this member exists so the interface names the FULL target shape Scope-2
   * asked for, without forcing a real import-graph edge from this interface file back into the 11,000+
   * line host module for a method nothing outside `pty/` calls today.
   */
  buildSpawnArgs?(opts: unknown): unknown;

  /**
   * The stateful runtime subset (submit/busy-detection/hook-dispatch/permission-mode read+cycle) is
   * OPTIONAL on this interface, deliberately. `pty/host.ts`'s `PtyHost` class is today's de facto
   * implementation of this subset via its own public surface (`enqueueStdin`, `isBusy`, `deliverHook`,
   * the mode-cycle machinery) — see this file's own top-level doc for why that machinery stays
   * PtyHost-internal rather than being wrapped here. These members exist so the interface's DOCUMENTED
   * shape is complete (Scope-2: "submit/inject message, idle/busy detection, permission-mode
   * read+cycle, … exit/kill semantics"); a real second harness would populate them, at which point
   * `PtyHost` would be restructured to call through this seam instead of implementing the machinery
   * itself — that restructuring is explicitly OUT of Phase 0's zero-behavior-change scope.
   */
  submit?(sessionId: string, text: string, opts?: unknown): unknown;
  isBusy?(sessionId: string): boolean;
  handleHookEvent?(sessionId: string, event: unknown): void;
}
