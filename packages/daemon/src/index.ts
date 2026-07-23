import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveConfig, resolveCodescapeIntegrationPath } from "@loom/shared";
import { ensureDirs, PORT, LOOM_HOME, LOGS_DIR, isUsagePollerSuppressed } from "./paths.js";
import { installCrashHandlers } from "./crashlog.js";
import { writeShutdownMarker, readAndClearShutdownMarker } from "./shutdown-marker.js";
import { Db } from "./db.js";
import { canOpenRemoteListener, isTrustTierHookActive, tlsRequirementSatisfied, isAllInterfacesBindHost } from "./gateway/trust-tier.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { snapshotTranscript } from "./sessions/transcript.js";
import { snapshotAndArchiveRecovered } from "./sessions/boot-backstop.js";
import { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers } from "./orchestration/crash-orphaned-workers.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { seedDefaultProfiles, seedProfileBaseSnapshots } from "./profiles/seed.js";
import { seedDefaultCapabilities, migrateGithubCapabilityToBinary } from "./capabilities/seed.js";
import { seedPlatformHome, migratePlatformPrompts } from "./platform/seed.js";
import { seedSetupHome, seedSetupProjectRename, seedSetupAgentRename, seedSetupAuditorAgent, seedCompanionAgent, seedOperatorAgent } from "./setup/seed.js";
import { maybeAutoLaunchSetup } from "./setup/first-run.js";
import { backfillColumnRoles, migrateHumanHoldToHeld } from "./tasks/columns.js";
import { prewarmMarkitdownForProfilesAtBoot, resolvePrewarmInterpreterPath, shouldPrewarmCompanionVoice } from "./python/prewarm.js";
import { createFasterWhisperTranscriber, prewarmStt } from "./companion/stt.js";
import { createKokoroSynthesizer, prewarmTts } from "./companion/tts.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { CodescapeSupervisor, codescapeBootRepoPaths } from "./codescape/supervisor.js";
import { UsageSampler } from "./sessions/usage-sampler.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { PlatformMcpRouter } from "./mcp/platform.js";
import { AuditMcpRouter } from "./mcp/audit.js";
import { WorkspaceAuditMcpRouter } from "./mcp/user-audit.js";
import { SetupMcpRouter } from "./mcp/setup.js";
import { OperatorMcpRouter } from "./mcp/operator.js";
import { RunMcpRouter } from "./mcp/run.js";
import { OrchestrationControl } from "./orchestration/control.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { RateLimitWatcher } from "./orchestration/rate-limit-watcher.js";
import { UsageStatusPoller, prewarmClaudeVersionAsync } from "./orchestration/usage-status.js";
import { WakeService } from "./orchestration/wake.js";
import { PollService } from "./orchestration/poll.js";
import { EventTriggerService } from "./orchestration/event-triggers.js";
import { performAuthenticatedRequest } from "./connections/request.js";
import { resolveScopedConnectionSecret } from "./connections/store.js";
import { ContextWatcher } from "./orchestration/context-watcher.js";
import { IdleWatcher } from "./orchestration/idle-watcher.js";
import { BusyWorkerWatcher } from "./orchestration/busy-worker-watcher.js";
import { ResumeDocWatcher } from "./orchestration/resume-doc-watcher.js";
import { CrashRecoveryWatcher, recordUnexpectedExit } from "./orchestration/crash-recovery-watcher.js";
import { DbBackupWatcher, resolveBackupConfig, takeBackup } from "./orchestration/db-backup.js";
import { AlertWebhookEmitter } from "./orchestration/alert-webhook.js";
import { recordClaudeRateLimit } from "./orchestration/usage-awareness.js";
import { rateLimitDeadline, rateLimitedUntil, resumeResetFromUsageStatus } from "./orchestration/usage-limit.js";
import { readRestartIntent, clearRestartIntent, protectedIdsFromIntent } from "./orchestration/restart.js";
import { startVaultVersioners, logVaultPushStatus, VaultPushStatusWatcher, type VaultVersioner } from "./vault/versioner.js";
import { buildServer } from "./gateway/server.js";
import { resolveAllCompanionConfigs } from "./companion/store.js";
import { CompanionController, type CompanionReplyHooks } from "./companion/controller.js";
import { InAppChannel, IN_APP_CHANNEL } from "./companion/in-app.js";
import { reviveCompanionSessionAtBoot, withCompanionSelfHeal } from "./companion/revive.js";
import { loomVersion, umbrellaRootDir, isPackagedInstall } from "./version.js";
import { UpdateCheckWatcher, readUpdateChannel } from "./update/check.js";

async function main(): Promise<void> {
  // Top-level fatal-exit crash handler FIRST — so an uncaught exception / unhandled rejection / stray
  // non-zero exit at any point past here leaves a diagnosable crashlog under .loom (a real crash once
  // left no log signature at all). Idempotent + fail-safe; never throws.
  installCrashHandlers();
  ensureDirs();
  const seeded = seedGlobalSkills();
  if (seeded.length) console.log(`[boot] seeded global skill(s): ${seeded.join(", ")}`);
  // Pre-migration safety snapshot: back up the EXISTING DB before we open it (migrations run in the Db
  // constructor) and before boot-reconcile, so a bad migration/reconcile is recoverable to the pre-boot
  // state. Best-effort — takeBackup never throws and skips a fresh install (no DB yet); awaited so the
  // snapshot completes before the migrating connection opens. Gated on `enabled` (interval-0 only mutes
  // the periodic ticker). NO platform override here by construction: `Db` (which stores it) isn't open
  // yet — env-or-default only (see resolveBackupConfig's doc). The periodic ticker below, constructed
  // AFTER `db`/`platformOverride` are available, uses the fully-resolved `resolved.backup` instead.
  const bootBackupCfg = resolveBackupConfig();
  if (bootBackupCfg.enabled) await takeBackup({ reason: "boot", keep: bootBackupCfg.keep });
  const db = new Db();
  // Seed Loom's bundled Profiles (platform-level rig) into the profiles table, seed-if-absent
  // like the skills seed — additive, idempotent, preserves user edits. The two Platform-layer profiles
  // (Platform-lead/Platform-audit) seed only under LOOM_DEV; the core profiles always seed.
  const seededProfiles = seedDefaultProfiles(db);
  if (seededProfiles.length) console.log(`[boot] seeded default profile(s): ${seededProfiles.join(", ")}`);
  // Backfill the per-bundled-profile `base` snapshot (seed-if-absent, AFTER seedDefaultProfiles so freshly
  // seeded rows are covered) so the profile list/get can derive precise customized / updateAvailable state
  // and the field-level adopt-update merge has a common ancestor — the profiles analog of seedBaseSnapshots.
  const seededBases = seedProfileBaseSnapshots(db);
  if (seededBases.length) console.log(`[boot] seeded profile base snapshot(s): ${seededBases.join(", ")}`);
  // Agent-tooling P4 follow-on (3b0c4aef): seed Loom's bundled registry-capability catalog rows
  // (currently just "github", the first real credential-tied capability) into `capability_defs`,
  // seed-if-absent by slug — additive, idempotent, CORE product (ungated). Best-effort: a throw here
  // (e.g. an unexpected DB error) must never gate boot — the catalog just stays without it this boot.
  try {
    const seededCapabilities = seedDefaultCapabilities(db);
    if (seededCapabilities.length) console.log(`[boot] seeded capability catalog row(s): ${seededCapabilities.join(", ")}`);
  } catch (err) {
    console.warn(`[boot] capability catalog seed failed (continuing boot): ${(err as Error).message}`);
  }
  // Agent-tooling P4 follow-on: rewrite an EXISTING install's "github" capability row off the archived
  // npx/@modelcontextprotocol/server-github shape onto the new Loom-managed github-binary provisioning
  // (a fresh install's seed above already lands the new shape directly — this only touches a pre-migration
  // row, and it's a no-op once migrated). Narrow + idempotent (see migrateGithubCapabilityToBinary's doc).
  // Best-effort: a throw here must never gate boot — the row just stays on its old (still-working) shape.
  try {
    if (migrateGithubCapabilityToBinary(db)) console.log("[boot] migrated the 'github' capability off the archived npx package to the Loom-managed github-mcp-server binary");
  } catch (err) {
    console.warn(`[boot] github capability provisioning migration failed (continuing boot): ${(err as Error).message}`);
  }
  // "Getting Started" → "Platform" home rename backfill — rename an EXISTING install's reserved setup-home
  // ROW before seedSetupHome runs. seedSetupHome is seed-if-absent keyed on the NEW name, so if it ran first
  // on a pre-rename install it would mint a SECOND, empty "Platform" home beside the old "Getting Started"
  // one (orphaning the user's home + boards); renaming the existing row in place first avoids that. Guarded +
  // idempotent (name-scoped, reserved-only, collision-refusing); no-op on fresh installs / user-renamed
  // homes. Best-effort: a throw in this one-shot migration must NEVER gate boot.
  try {
    const renamedSetupHome = seedSetupProjectRename(db);
    if (renamedSetupHome) console.log(`[boot] rename: renamed legacy setup home → ${renamedSetupHome}`);
  } catch (err) {
    console.warn(`[boot] setup-home rename failed (continuing boot): ${(err as Error).message}`);
  }
  // Setup Assistant E1: seed the reserved "Platform" onboarding home + its Setup Assistant agent,
  // seed-if-absent by name (idempotent; runs AFTER seedDefaultProfiles so the bundled Setup Assistant
  // profile exists to assign, and AFTER the rename above so an existing home is renamed not duplicated).
  // UNGATED — unlike the platform home below, this ships to EVERY loomctl user (no LOOM_DEV gate). Hidden
  // from the project picker; surfaced via the always-available Setup page.
  const seededSetup = seedSetupHome(db);
  if (seededSetup.length) console.log(`[boot] seeded setup home: ${seededSetup.join(", ")}`);
  // A2 rebrand backfill: seedSetupHome no-ops once the home exists, so installs seeded BEFORE the
  // Setup Assistant → "Platform" rebrand keep the old operator agent name while first-run now resolves the
  // new one. Run the guarded one-shot rename AFTER the seed — it renames ONLY the single reserved-home
  // operator agent (exact old literal + setup-role profile), idempotent by name-match, never a user-renamed
  // or non-reserved agent. No-ops on fresh installs (the seed already created "Platform").
  const renamedSetupAgent = seedSetupAgentRename(db);
  if (renamedSetupAgent) console.log(`[boot] rebrand: renamed legacy setup agent → ${renamedSetupAgent}`);
  // End-User Platform tier B4: seed the bundled Workspace Auditor agent into the SAME reserved "Platform"
  // setup home as the operator (one home, two agents). A SEPARATE boot-time backfill — NOT folded into
  // seedSetupHome, which no-ops the whole seed once the home exists (gotcha #2) and so would never give an
  // EXISTING install the auditor. seed-if-absent BY AGENT-NAME within the reserved home: backfills upgrades
  // AND covers fresh installs (operator from seedSetupHome above + auditor here, same boot), idempotent,
  // never clobbers a user-renamed agent. The operator still resolves by SETUP_AGENT_NAME (distinct name).
  const seededAuditor = seedSetupAuditorAgent(db);
  if (seededAuditor) console.log(`[boot] seeded workspace auditor agent: ${seededAuditor}`);
  // Loom Companion: seed the bundled Companion RIG (the assistant-role Companion profile + a Companion agent
  // bound to it) into the SAME reserved "Platform" setup home — the default spawn TARGET for the
  // human-triggered "New companion" flow. Its OWN seed-if-absent-by-name backfill (like the auditor above),
  // so it covers both existing installs (seedSetupHome already no-ops) and fresh ones. TEMPLATE ONLY — it
  // spawns NO session and writes NO companion_config; the rig stays invisible until a human provisions it.
  const seededCompanion = seedCompanionAgent(db);
  if (seededCompanion) console.log(`[boot] seeded companion agent: ${seededCompanion}`);
  // Bucket 2b "Bounded Elevated Operator": seed the bundled Elevated Operator agent into the SAME
  // reserved "Platform" setup home — FLAG-GATED (isOperatorEnabled, read LIVE), so a fresh install with
  // platform.operatorEnabled off never grows this agent row. seed-if-absent BY AGENT-NAME within the
  // reserved home, mirroring the auditor/companion seeders above. NO first-run auto-launch — seeding the
  // agent is not spawning a session (that stays human-REST-only via startOperator).
  const seededOperatorAgent = seedOperatorAgent(db);
  if (seededOperatorAgent) console.log(`[boot] seeded elevated operator agent: ${seededOperatorAgent}`);
  // Platform Manager P1: seed the reserved "Loom Platform" home + its Platform Lead / Platform Auditor
  // agents, seed-if-absent (idempotent; runs AFTER seedDefaultProfiles so the bundled platform profiles
  // exist to assign). Hidden from the project picker (db.listProjects), still Mission-Control visible.
  // The Lead is NOT spawned here (human REST action) and the Auditor is NOT scheduled here (P5).
  // DEV-ONLY: the whole Platform layer is gated behind LOOM_DEV — this no-ops for regular loomctl users.
  const seededPlatform = seedPlatformHome(db);
  if (seededPlatform.length) console.log(`[boot] seeded platform home: ${seededPlatform.join(", ")}`);
  // One-time migration: refresh an ALREADY-seeded platform agent's stored startupPrompt to the new clean
  // text when it is byte-identical to the prior (phase-NOTE-bearing) seeded text — the seeder is
  // seed-if-absent, so editing the prompt constants alone never updates a live row. Marker-guarded one-shot,
  // never clobbers a user edit. Best-effort: a throw must NEVER gate boot (the marker stamps only on success).
  try {
    const promptMig = migratePlatformPrompts(db);
    if (promptMig.migrated) console.log(`[boot] refreshed ${promptMig.migrated} platform agent prompt(s) (stripped phase-gated NOTE)`);
  } catch (err) {
    console.warn(`[boot] platform-prompt migration failed (continuing boot): ${(err as Error).message}`);
  }
  // Task B: one-time backfill of `role` onto legacy stored project configs (pre-role boards). Triple-
  // guarded one-shot (app_meta marker + explicit-columns-only + assign-if-absent), so it fires exactly
  // once per LOOM_HOME and moves NO cards — an override-less project already inherits role-annotated
  // defaults. Runs AFTER the home seeds so reserved homes with custom boards are covered too.
  // Best-effort: a throw in this one-shot migration must NEVER gate boot. The app_meta marker is only
  // stamped on success inside backfillColumnRoles, so a pre-stamp throw simply retries next boot.
  try {
    const columnRoles = backfillColumnRoles(db);
    if (columnRoles.migrated) console.log(`[boot] backfilled column roles on ${columnRoles.migrated} project config(s)`);
  } catch (err) {
    console.warn(`[boot] column-role backfill failed (continuing boot): ${(err as Error).message}`);
  }
  // Board Hold Model redesign: the `blocked` column / `humanHold` role is retired — `held` is now the SOLE
  // human brake (checked in ANY column by spawnWorker/idle-watcher/hasPendingBoardWork below). One-shot,
  // MUST run in the same deploy as that engine brake flip (a migrated card must never sit in an actionable
  // lane while dispatch still ignored `held`). Runs AFTER backfillColumnRoles (above) so a legacy override's
  // `blocked` key already carries role:"humanHold" by the time this reads it. Best-effort: never gate boot.
  try {
    const humanHoldMig = migrateHumanHoldToHeld(db);
    if (humanHoldMig.projectsMigrated) {
      console.log(`[boot] migrated humanHold → held on ${humanHoldMig.projectsMigrated} project(s) (${humanHoldMig.cardsMigrated} card(s) promoted)`);
    }
  } catch (err) {
    console.warn(`[boot] humanHold→held migration failed (continuing boot): ${(err as Error).message}`);
  }
  // Resolve the daemon-global platform tuning ONCE at boot (SQLite singleton override ?? LOOM_* env ??
  // defaults). Every BOOT-BOUND consumer below — PtyHost busy-stale, SessionService git timeouts, the
  // watcher cadences — reads from this. A PATCH to platform.watchers/timeouts therefore takes effect on
  // the NEXT daemon restart (the resolve-live values — gate/webhook/rate-limit — re-resolve per call).
  const platformOverride = db.getPlatformConfig();
  const resolved = resolveConfig(undefined, platformOverride);
  const { watchers, timeouts } = resolved.platform;
  // Pre-warm the shared markitdown venv if any profile opts into documentConversion, so the FIRST such
  // session usually finds the MCP already warm instead of hitting the provision-on-first-spawn cold-skip
  // window. Best-effort + fully off the event loop (delegates to the async background kick) — must NEVER
  // gate boot, so it's wrapped like the other one-shot boot side-effects above.
  try {
    if (prewarmMarkitdownForProfilesAtBoot(db)) console.log("[boot] pre-warming the markitdown venv (a profile opts into documentConversion)");
  } catch (err) {
    console.warn(`[boot] markitdown pre-warm kick failed (continuing boot): ${(err as Error).message}`);
  }
  // One-time backfill: sessions that EXITED before auto-archive-on-exit (card b37750a4) shipped never got
  // archived_at stamped, so they're invisible in BOTH the live rail (exited) and the Archive tab (filters
  // NOT NULL). Stamp archived_at = COALESCE(last_activity, created_at) on every such legacy row so the
  // manager→worker trees appear in Archive. One-shot (app_meta marker); idempotent. Placed BEFORE
  // recoverStaleSessions so it only ever touches already-'exited' rows — a crashed session about to be
  // recovered+resumed is still 'live'/'starting' here, so it's not matched; and resumeFleetOnBoot's
  // restoreSession un-archives anything it resumes regardless. Best-effort: never gate boot.
  try {
    const backfilled = db.backfillArchivedAtOnce();
    if (backfilled > 0) console.log(`[boot] backfilled archived_at on ${backfilled} pre-feature exited session(s)`);
  } catch (err) {
    console.warn(`[boot] archived_at backfill failed (continuing boot): ${(err as Error).message}`);
  }
  // One-time backfill: before the structured Task.held flag (card 788274a9), the idle watchdog discounted
  // owner-gated cards by matching uppercase HOLD/CONFIRM in the title — a brittle path now removed. Seed
  // `held` on every card that heuristic WOULD have discounted so intentionally-parked cards keep their
  // discount instead of suddenly nagging the manager. One-shot (app_meta marker); idempotent. Best-effort.
  try {
    const heldBackfilled = db.backfillHeldFromTitlesOnce();
    if (heldBackfilled > 0) console.log(`[boot] backfilled held=true on ${heldBackfilled} legacy HOLD/CONFIRM-titled card(s)`);
  } catch (err) {
    console.warn(`[boot] held backfill failed (continuing boot): ${(err as Error).message}`);
  }
  const recovered = db.recoverStaleSessions();
  if (recovered.length > 0) console.log(`[boot] reconciled ${recovered.length} stale session(s) -> exited`);
  // Crash-orphaned-worker recovery (card 9fc41af5): derive candidates from `recovered` NOW, BEFORE the
  // archive pass below stamps archived_at on every one of them — deriveCrashOrphanedWorkers's own
  // "wasn't archived pre-crash" guard would otherwise always fail. Pure DB read; the actual resume runs
  // later (after `listen`, alongside the restart-intent resume block) and ONLY when no RestartIntent was
  // captured this boot (the exit-75 path already recovers its own fleet, incl. these same workers).
  const crashOrphanedWorkers = deriveCrashOrphanedWorkers(db, recovered);
  // A manager/platform session whose ENTIRE worker set is legitimately excluded (all landed, all
  // recycled, all archived pre-crash) has no entry above at all — without this it would never get an
  // independent resume attempt, even though it was just as much a live/starting victim of THIS crash as
  // any manager that happens to still have a worker (see crash-orphaned-workers.ts's DIAGNOSIS).
  const crashOrphanedManagers = deriveCrashOrphanedManagers(db, recovered, crashOrphanedWorkers);
  // Crash-path backstop (card b37750a4): a daemon crash fires no onExit, so snapshot the transcript +
  // auto-archive each recovered session HERE, while the JSONL still exists (before sweepDeadSessions can
  // mark it dead / Claude can prune it). The ONLY snapshot+archive point on the crash path. See module.
  snapshotAndArchiveRecovered(db, recovered);
  const dead = sweepDeadSessions(db);
  if (dead > 0) console.log(`[boot] marked ${dead} session(s) dead (engine transcript gone)`);
  // Keep dead-ID state fresh as Claude's transcripts come and go.
  watchClaudeProjects(db, (n) => console.log(`[watch] marked ${n} session(s) dead`));

  // PtyHost callbacks persist runtime state into the registry (engine id on receipt; exit).
  // onExit references orchMcp (declared below) — only invoked at runtime, after init.
  const pty = new PtyHost({
    onEngineSessionId: (sessionId, engineId) => db.setEngineSessionId(sessionId, engineId),
    // Persist busy, and on the falling edge nudge the manager if a worker went idle without
    // reporting (stranded-worker guard; no-op for non-workers). On the RISING edge, purge any
    // still-queued idle-worker nudge for this worker from its manager's FIFO — it re-engaged, so a
    // nudge computed back when it was idle would otherwise drain stale into a later manager turn
    // (auditor finding 2e3a8e6f). `sessions` is assigned below but this closure only runs at
    // runtime — same forward-reference pattern as onExit→orchMcp.
    onBusy: (sessionId, busy) => {
      db.setBusy(sessionId, busy);
      if (!busy) sessions.notifyManagerOfIdleWorker(sessionId);
      else sessions.purgeStaleIdleNudgeForReengagedWorker(sessionId);
    },
    onContextStats: (sessionId, s) => db.setContextCounters(sessionId, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns, model: s.model }),
    // §19c: persist the per-session park (resume-at + human lastError), arm the episode give-up
    // deadline (first cap sets it; re-caps keep it via COALESCE), AND record GLOBAL awareness (so
    // the Scheduler / worker_spawn won't fire into a known-limited account).
    onRateLimited: (sessionId, _until, detail) => {
      // RESOLVE-LIVE: re-derive the authoritative park (resume-at) + episode give-up deadline from the
      // daemon-global rate-limit knobs HERE, where db is in scope — so a PATCH to platform.rateLimit
      // takes effect with no restart. PtyHost is db-unaware by design (layering boundary); the `_until`
      // it passes is a module-default fallback we deliberately re-derive with the resolved config.
      const rl = resolveConfig(undefined, db.getPlatformConfig()).platform.rateLimit;
      const now = new Date();
      // The interactive StopFailure hook usually carries NO resetsAtSeconds — the common case. Rather
      // than fall straight to the flat default backoff (which can resume BACK INTO a still-active
      // weekly cap and re-loop), fall back to the ALREADY-POLLED plan-usage status: if a window is
      // known-exhausted with a future reset, resume at THAT reset instead of guessing. Unavailable /
      // nothing-exhausted status ⇒ undefined ⇒ byte-identical to today's default-backoff behavior.
      const resetsAtSeconds = detail.resetsAtSeconds ?? resumeResetFromUsageStatus(usageStatus.getStatus(), now, rl);
      const until = rateLimitedUntil(resetsAtSeconds, now, rl);
      const deadline = rateLimitDeadline(resetsAtSeconds, now, rl);
      db.setRateLimitedUntil(sessionId, until, `usage limit — resumes ${until}`);
      db.armRateLimitDeadline(sessionId, deadline);
      // Event-emit twin (attention-push signal source, Lead fork 2b) — additive, no existing consumer
      // (alert-webhook's events[] allowlist, web attention) lists this new kind, so this is inert for them.
      db.appendEvent({
        id: randomUUID(), ts: now.toISOString(), managerSessionId: sessionId,
        kind: "session_rate_limited", detail: { until, deadline },
      });
      // Feed the SAME derived reset into GLOBAL awareness (not just this session's park) — otherwise
      // the Scheduler/worker_spawn gate (isLikelyNearClaudeUsageLimit) falls back to its own ~6h
      // recency heuristic and can fire fresh work into a still-capped account hours before a real
      // (e.g. weekly) reset actually clears (card 2110726d, a fleet-level follow-up to 6df15380's
      // per-session fix). Guarded so the derived reset can only EXTEND the awareness hold, never
      // shorten it below what the recency heuristic alone would already give.
      const recencyFloorSeconds = now.getTime() / 1000 + rl.recencyWindowMs / 1000;
      const globalResetsAtSeconds =
        typeof resetsAtSeconds === "number" && resetsAtSeconds >= recencyFloorSeconds ? resetsAtSeconds : undefined;
      recordClaudeRateLimit(globalResetsAtSeconds);
    },
    // A hard stop fires no Stop hook, so clear busy on exit too — an exited pty is never busy.
    onExit: (sessionId, _code, info) => {
      db.setProcessState(sessionId, "exited");
      db.setBusy(sessionId, false);
      // Read the exited row ONCE (null for non-DB shell terminals) — reused by the auto-archive
      // decision AND the transcript snapshot below. Best-effort: never disturb the exit path.
      let exited;
      try { exited = db.getSession(sessionId); } catch { /* never disturb the exit path */ }
      // Auto-archive on exit (card b37750a4): every STOPPED session leaves the live rail and surfaces
      // in Archive automatically — reuses the existing archived_at field (stamp = now); resume() clears
      // it to bring the session back. Per-session, no cascade (each worker auto-archives as it exits).
      // Recycled predecessors archive too: nothing requires a predecessor on the live rail (lineage
      // renders from the successor's gen; resume(allowSuperseded) / reparentWakes / Run-Replay all use
      // UNFILTERED getSession; crash-recovery + message-routing gate on hasSuccessor, not rail membership)
      // — so archiving them is consistent with "ALL stopped sessions in Archive". EXCEPTION: role==='run'
      // — Agent Run sessions are ephemeral (finalized + GC'd via onRunSessionExit) and must never clutter
      // the project Archive tab; a null row (non-DB shell terminal) is skipped too.
      // ORPHANED-FLEET GUARD (card 6cd3ce9e): routed through SessionService.archiveOnExit rather than a
      // bare db.archiveSession — a manager/platform that still owns ≥1 LIVE worker/child session at exit
      // is NOT archived (it would silently strand that fleet off every rail/god's-eye list); every other
      // case archives exactly as before. See that method's doc for the full reasoning.
      if (exited && exited.role !== "run") sessions.archiveOnExit(exited);
      // AUTO-DRAIN the cap-queue (card 81b7e346): the DEFAULT slot-free trigger — covers manual
      // worker_stop, confirmWorkerMerge's own hard-stop of the merged worker, and a crash/kill. The
      // no-commit auto-retire, sibling-retirement, and finalizeMerge paths retire a worker's DB row
      // SYNCHRONOUSLY ahead of their own (possibly deferred) pty.stop, so they each call
      // maybeDrainCapQueue directly rather than waiting for this hook; a redundant second call from here
      // once their pty actually exits is harmless (idempotent — the queue is either already drained or
      // still genuinely has room). Suppressed automatically while a recycleWorker is mid-swap on this
      // worker's manager (see recycleDrainSuppressed's doc) — recycleWorker calls it itself once settled.
      // Best-effort + never blocks the exit path: fire-and-forget.
      if (exited && exited.role === "worker" && exited.parentSessionId) void sessions.maybeDrainCapQueue(exited.parentSessionId);
      // Disarm a leaked companion heartbeat/reminder timer on exit (fix 9227335b): an enabled companion's
      // config row survives the pty death (see companion/revive.ts), so a plain reconcile() would no-op —
      // onSessionExit bypasses that diff and tears down THIS session's live gateway/heartbeat/reminders
      // directly, same as index.ts→orchMcp's forward-reference pattern below (companionController is
      // constructed later in this function, but only ever invoked here at runtime). A no-op for any
      // non-companion session (nothing live to tear down). Best-effort: never disturb the exit path.
      try { void companionController.onSessionExit(sessionId); } catch { /* never disturb the exit path */ }
      // Clear any rate-limit park on EXIT: an exited session can never auto-resume, so a lingering
      // rate_limited_until (whose timestamp is still in the future) would keep showing RATE-LIMITED in
      // the Attention queue for hours after the session is gone. Clears ONLY the two park columns
      // (lastError is preserved — a crash-loop banner etc. must survive). Idempotent + cheap.
      db.clearRateLimit(sessionId);
      // Crash-recovery trigger: record a durable `session_died` event IFF this was an UNEXPECTED death
      // (`intended === false` — no pty.stop() was issued) of a resumable coordination/work session, so the
      // CrashRecoveryWatcher can bounded-auto-resume it. An intended stop records nothing (untouched); a
      // whole-daemon restart/crash never reaches here at all. Best-effort: never disturb the exit path.
      try { recordUnexpectedExit(db, sessionId, info.intended); } catch { /* never disturb the exit path */ }
      // Auto-snapshot the engine transcript on exit, while the JSONL still exists — so an archived
      // session keeps a readable transcript even after Claude later prunes the original (a session
      // goes 'dead' BECAUSE its JSONL was deleted). Best-effort: snapshotTranscript never throws.
      try {
        if (exited?.engineSessionId) snapshotTranscript(exited.cwd, exited.engineSessionId, exited.projectId, exited.id);
      } catch { /* never disturb the exit path */ }
      // Agent Runs R2: finalize the run row + GC its disposable snapshot cwd (the pty is now gone, so
      // its handles are released). Runs the SAME teardown whether the run completed via submit_result or
      // the session died first (→ failed). Best-effort: a throw here must not disturb the exit path.
      try { if (exited?.role === "run") sessions.onRunSessionExit(sessionId); } catch { /* never disturb the exit path */ }
      // Exited-without-report guard (board card 84151b99): a worker that UNEXPECTEDLY exited (intended
      // === false) before ever calling worker_report leaves its task in_progress with no signal up — the
      // idle nudge only fires on a busy→false edge, which a fast exit can outrun. Surface a DISTINCT
      // worker_exited_without_report event + nudge to the manager so it isn't left with a silent idle.
      // Best-effort: never disturb the exit path.
      try { if (exited?.role === "worker") sessions.notifyManagerOfExitedWorker(sessionId, info.intended); } catch { /* never disturb the exit path */ }
      // Session usage telemetry (epic c9924bcd, card B): take a FINAL delta sample on exit so the tail of
      // this session's billed usage isn't lost (the periodic tick may have missed the last segment). The
      // sampler skips run / no-transcript sessions itself. Best-effort: never disturb the exit path.
      try { if (exited) void usageSampler.onSessionExit(exited).catch(() => { /* async best-effort */ }); } catch { /* never disturb the exit path */ }
      mcp.dispose(sessionId); orchMcp.dispose(sessionId); platformMcp.dispose(sessionId); userAuditMcp.dispose(sessionId); setupMcp.dispose(sessionId); operatorMcp.dispose(sessionId); runMcp.dispose(sessionId);
    },
  }, {
    busyStaleMs: timeouts.busyStaleMs, coalesceAgentMessages: resolved.platform.coalesceAgentMessages, // BOOT-BOUND: from resolved platform config
    // Agent-tooling P4: give PtyHost READ access to the owner-added capability catalog + the P1 secret
    // store WITHOUT handing it a live db reference (layering boundary — PtyHost stays db-unaware, like
    // the rate-limit callback above). A failed decrypt (corrupt/wrong key) degrades to "no secret" rather
    // than throwing into the spawn hot path — the capability just spawns without its credential.
    getCapabilityCatalog: () => db.listCapabilityDefs(),
    // Card f2abce7e: fail-closed project scope check BEFORE decrypting — a project-scoped connection
    // resolves ONLY when this spawn's own projectId matches (null on the connection = global, unchanged
    // from today). A cross-project grant (a reused Profile, an owner misconfiguration) silently gets no
    // secret, exactly like an unresolvable/revoked connection. Card 34ea225d: the composition itself is
    // `connections/store.ts`'s `resolveScopedConnectionSecret` — a single tested owner shared with the test.
    resolveConnectionSecret: (connectionId: string, projectId?: string) => resolveScopedConnectionSecret(db, connectionId, projectId),
    // Card 8dc5ebb9: DB-first host-tool integration paths — read LIVE per-spawn (like the capability
    // catalog above), never boot-bound, so a Settings change reaches the very next new session.
    getIntegrationPaths: () => ({ codescape: resolveCodescapeIntegrationPath(db.getPlatformConfig()) }),
    // Card 088afc94 (P4 wiring): read access to the codescape supervisor's live port + its bound
    // resolveProjectId (cache-then-manifest), for buildMcpServers to resolve a per-session
    // streamable-HTTP MCP mount. `codescapeSupervisor` is declared BELOW this constructor call — safe
    // because this closure only runs at spawn time (well after boot has finished assigning it), the SAME
    // forward-reference pattern `onExit`/`orchMcp` already use just above. Defaults (no opt) to
    // `{port:null, resolveProjectId:()=>null}` — every existing hermetic PtyHost test that doesn't wire
    // this stays byte-identical (a null port clean-skips the mount).
    getCodescapeSupervisorState: () => ({ port: codescapeSupervisor.getPort(), resolveProjectId: (repoPath: string) => codescapeSupervisor.resolveProjectId(repoPath) }),
  });

  const control = new OrchestrationControl(); // §17a safety rails (pause/kill); in-memory by design
  // Codescape fleet-daemon wiring (epic `369dde3c`), card C1 — FOUNDATION. Constructed unconditionally
  // (byte-identical-when-disabled: the constructor spawns nothing) so SessionService always has a handle
  // to inject for C2/C3; `.start()` below is the only call that actually does anything, and it no-ops
  // under isCodescapeSupervisorEnabled() === false (the default for every loomctl user).
  const codescapeSupervisor = new CodescapeSupervisor();
  // BOOT-BOUND: thread the resolved git-op / provision timeouts into the bounded-git + provision seams
  // at SessionService's call-sites (worktree create/remove/branch-delete/merge-detect during boot-reconcile).
  const sessions = new SessionService(db, pty, control, { gitOpMs: timeouts.gitOpMs, provisionMs: timeouts.provisionMs, runTimeoutMs: timeouts.runMs, codescape: codescapeSupervisor });
  // Self-host restart recovery: a manager's `daemon_restart` left an intent naming the sessions to
  // bring back. Read it BEFORE the reconcile so the WHOLE fleet's worktrees are PROTECTED from pass-B GC
  // (recoverStaleSessions just marked every prior-run session 'exited', which would otherwise prune a
  // worktree we need to resume into). protectedIdsFromIntent spans the entire captured fleet across all
  // projects (P1 17df54c5) and tolerates an OLD-format intent (degrades to the requester + its workers).
  // The actual resume happens after the server is listening (its ptys need the MCP endpoints up). null
  // on a normal boot.
  const restartIntent = readRestartIntent();
  // Consume-on-read, ONCE per boot, unconditionally (card be79aea2) — regardless of which branch below
  // ends up using it, so a clean-stop marker can never survive past the boot it was written for and get
  // misread as "clean" by a LATER, genuine crash that happens to leave no marker of its own.
  const shutdownMarker = readAndClearShutdownMarker();
  const protectedSessionIds = restartIntent ? protectedIdsFromIntent(restartIntent) : new Set<string>();
  // Crash-orphaned-worker recovery (card 9fc41af5): fold the derived candidates' worker + manager ids
  // into the SAME protected set, for the SAME reason (pass-B GC must not reclaim a worktree we're about
  // to resume into). Harmless no-op overlap on the exit-75 path (those ids are already covered by
  // protectedIdsFromIntent above); the only NEW behavior is on a genuine crash, where restartIntent is
  // null and this is the ONLY protection these workers get.
  for (const c of crashOrphanedWorkers) { protectedSessionIds.add(c.workerSessionId); protectedSessionIds.add(c.managerSessionId); }
  // Agent Runs R2: fail any run interrupted by a crash/restart (runs are ephemeral and do NOT resume) and
  // sweep orphaned run-snapshot dirs. Pure DB + fs, best-effort — never gate boot. recoverStaleSessions
  // already marked each interrupted run's `run` session exited, so this only finalizes the run rows.
  try {
    const runs = sessions.reconcileRunsOnBoot();
    if (runs.failed > 0) console.log(`[boot] failed ${runs.failed} interrupted run(s) (ephemeral — no resume) + swept run snapshots`);
  } catch (err) {
    console.warn(`[boot] run reconcile failed (continuing boot): ${(err as Error).message}`);
  }
  // WakeService (the `wake_me` primitive) needs SessionService.resume (auto-resume on fire), so it
  // comes after sessions. Always on — recovery/continuation, not autonomy-gated (like the rate-limit
  // watcher). BOOT-BOUND cadence from the resolved platform config (LOOM_WAKE_INTERVAL_MS env is read,
  // floor-clamped, inside resolveConfig; default 60s).
  const wakeIntervalMs = watchers.wakeMs;
  const wakes = new WakeService({ db, pty, resume: (id) => sessions.resume(id), intervalMs: wakeIntervalMs });
  // The task MCP hosts the universal wake tools, so it takes the WakeService.
  const mcp = new TaskMcpRouter(db, wakes);
  // PollService (local poll-job triggers, agent-tooling epic P3) — ALWAYS ON like WakeService: with zero
  // poll_jobs rows every tick is a no-op, so this is byte-identical to today until a human creates one
  // over the (human-only) REST surface. `request` calls the EXISTING P2 authenticated_request path
  // directly (server-side, never through the MCP layer — there is no agent turn here); the guard is the
  // SAME resolved connections config the MCP tool itself reads. `spawn` reuses `startNew`'s existing
  // profile-resolution — the poll job's target agent's OWN profile decides its role, nothing hardcoded.
  const pollIntervalMs = watchers.pollMs;
  const polls = new PollService({
    db, pty, control,
    request: (job) => performAuthenticatedRequest(
      { db },
      [job.connectionId],
      resolveConfig(undefined, db.getPlatformConfig()).platform.connections,
      { connection: job.connectionId, path: job.path, method: job.method },
    ),
    resume: (id) => sessions.resume(id),
    spawn: (agentId, kickoffPrompt) => sessions.startNew(agentId, { kickoffPrompt }),
    intervalMs: pollIntervalMs,
  });
  // EventTriggerService (local event triggers, Loom Event Triggers subsystem T2) — ALWAYS ON like
  // PollService: with zero event_triggers rows every tick is a no-op, byte-identical to today until a
  // human creates one over the (human-only) REST surface. Reacts to the INTERNAL orchestration_events bus
  // (never an outbound fetch) via each trigger's own watermark cursor; `spawn` reuses the SAME
  // startNew-based profile resolution as PollService's spawn path.
  const eventTriggers = new EventTriggerService({
    db, pty, control,
    resume: (id) => sessions.resume(id),
    spawn: (agentId, kickoffPrompt) => sessions.startNew(agentId, { kickoffPrompt }),
  });
  // Loom Companion (multi-companion runtime): ONE OR MORE chat-native companions, each a live `claude` PTY
  // session, served by the ChatGateway subsystem (registry of channel adapters + inbound routing + outbound
  // deliverReply) — one gateway per enabled companion config. OFF by default — no gateway is constructed
  // unless at least one companion config is enabled (LOOM_COMPANION_BOT_TOKEN + the allowlisted chat id +
  // the bound session id, or a REST-provisioned row), so a normal daemon is byte-identical. Built here (so
  // orchMcp can route each companion's chat_reply through deliverReply); the long-poll adapters are started
  // after `listen` below. INBOUND submits a turn via the EXISTING pty.enqueueStdin primitive (busy-gating /
  // composer-defer / FIFO coalesce / rate-limit park all reused) as a 'system' source.
  // The FULL enabled-config SET is built from the DURABLE companion_config DB rows (token decrypted via the
  // envelope helper), with LOOM_COMPANION_* env as the BOOTSTRAP/override: env, when set, seeds/overrides
  // its DB row (token encrypted) AND lays the app_meta home target if unset, BEFORE this resolve returns —
  // so env wins for its own session, a REST-configured companion with no env still boots, and no env + no
  // enabled row ⇒ [] ⇒ every path below is byte-identical to an unconfigured daemon (default-OFF).
  const companionCfgs = resolveAllCompanionConfigs(db, process.env);
  // The mutable chat_reply gate the OrchestrationMcpRouter reads per MCP request. companionSessionIds is
  // SEEDED from the boot set (so every configured companion's bound session gets chat_reply immediately) and
  // then kept in sync live by the controller as each companion starts/stops (a REST enable/disable takes
  // effect with no restart, and never touches any OTHER companion's membership). deliverReply routes THROUGH
  // the controller so it always dispatches to THAT session's own CURRENT gateway (stable across a
  // token-change adapter rebuild — never a stale closure, never cross-wired to a different companion).
  const companionHooks: CompanionReplyHooks = {
    companionSessionIds: new Set(companionCfgs.map((c) => c.sessionId)),
    deliverReply: (sid, text, voice) => companionController.deliverReply(sid, text, voice),
    deliverMedia: (sid, filePath) => companionController.deliverMedia(sid, filePath),
    // reminder_create's route capture (mirrors wake_me's schedule-time getActiveTurnOrigin read).
    getActiveTurnOrigin: (sid) => pty.getActiveTurnOrigin(sid),
    // ARM-ON-CREATE: reminder_create/cancel drive a reconcile SCOPED to the reminder's own bound session, so
    // a reminder CRUD write's rearmReminders (controller.ts) picks up the new/removed row with no restart —
    // and without perturbing any OTHER live companion's reminder watcher.
    rearmReminders: (sid) => companionController.reconcile(sid),
  };
  // The IN-APP channel (default companion transport): a STABLE transport hub, constructed ALWAYS (even when
  // the companion is OFF at boot) so the /ws/companion route + every built gateway share ONE client registry
  // that survives a gateway rebuild. Default-OFF byte-identical: with no in-app binding + no attached web
  // client it is inert (its adapter is registered but never hit; the WS route accepts but delivers nothing).
  // The injected recorder (bug 0f01f234) persists every OUTBOUND in-app reply to the durable chat-history
  // store, symmetric with the inbound record in companion/controller.ts's handleInAppInbound.
  const inAppChannel = new InAppChannel({
    record: (sessionId, author, text, proactive, viaVoice) => {
      db.insertCompanionMessage({
        id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author, text,
        createdAt: new Date().toISOString(), proactive, viaVoice,
      });
    },
  });
  // Local STT transcriber (Companion Voice epic, VOICE-P2) — built ALWAYS (even when the companion is OFF
  // at boot), stable across a gateway rebuild, exactly like inAppChannel/originResolver below. Constructing
  // it does NO provisioning work itself (lazy, memoized — see companion/stt.ts); pre-warm it now IFF the
  // companion is configured at boot, so a real deployment's first voice note usually finds the venv warm.
  const sttInterpreterPath = resolvePrewarmInterpreterPath(db.listAllProjects());
  // Opt-in gate (owner-directed 2026-07-06, default OFF): companion voice provisioning (faster-whisper +
  // kokoro-onnx, ~700MB combined) no longer fires automatically just because a companion is configured —
  // the owner flips `platform.companionVoiceEnabled` on in Settings. Read ONCE here off the ALREADY-resolved
  // boot config (line ~171 above), like `coalesceAgentMessages` — a toggle takes effect on the next restart.
  const companionVoiceEnabled = resolved.platform.companionVoiceEnabled;
  const sttTranscriber = createFasterWhisperTranscriber(sttInterpreterPath, companionVoiceEnabled);
  // Local TTS synthesizer (Companion Voice epic, VOICE-P3) — same shape as sttTranscriber above: built
  // ALWAYS, stable across a gateway rebuild, no provisioning work at construction time (lazy, memoized —
  // see companion/tts.ts). The shared venv is ONE per machine, so the SAME interpreter path applies.
  const ttsSynthesizer = createKokoroSynthesizer(sttInterpreterPath, companionVoiceEnabled);
  if (shouldPrewarmCompanionVoice(companionCfgs.length > 0, companionVoiceEnabled)) {
    console.log("[boot] pre-warming the faster-whisper venv (the companion is configured + voice is enabled)");
    prewarmStt(sttInterpreterPath);
    console.log("[boot] pre-warming the kokoro-onnx venv (the companion is configured + voice is enabled)");
    prewarmTts(sttInterpreterPath);
  }
  // The hot-lifecycle controller (multi-companion runtime): owns ONE live ChatGateway (Telegram long-poll) +
  // ONE proactive heartbeat + ONE reminder watcher PER ENABLED companion config, and drives ALL of them from
  // the human-only REST config writes with NO daemon restart. Constructed ALWAYS — even when no companion is
  // enabled at boot — so a REST enable can start one live. Default-OFF stays byte-identical: with
  // companionCfgs empty it builds no gateway, arms no heartbeat, and leaves companionSessionIds empty
  // (chat_reply never registers for anyone) — every path below is unchanged.
  const companionController = new CompanionController({
    db,
    // INBOUND submit carries the originating {channel, chatId} route as the pty turn's route (5th arg), so
    // the agent's chat_reply resolves back to that exact chat (multi-channel reply routing). kind:"agent" —
    // a companion inbound is a human's own chat message; it must land as its own turn.
    // Wrapped with the self-heal in companion/revive.ts (bug 4cc7826d): one auto-resume-then-retry when the
    // bound session died AFTER boot, strictly after chat-gateway's allowlist + sender-authz gates run.
    submitTurn: withCompanionSelfHeal(
      (sid, text, route, ownerText, senderId) => pty.enqueueStdin(sid, text, "system", undefined, route, "agent", undefined, ownerText, undefined, senderId),
      { resume: (sid) => { sessions.resume(sid); } },
    ),
    pty,
    hooks: companionHooks,
    env: process.env,
    inApp: inAppChannel,
    // Per-turn ORIGIN resolver: chat_reply delivers to the in-flight turn's originating route (pinned in the
    // pty when the turn was formed). The SOLE reply-target source — no binding/home guessing, no cross-wire.
    originResolver: (sid) => pty.getActiveTurnOrigin(sid),
    // Per-turn PROACTIVE resolver (proactive event-line producer): whether the in-flight turn was a
    // daemon-driven heartbeat/reminder/attention-push submit — mirrors originResolver exactly. deliverReply
    // reads this to tag the outbound frame + persisted history row for the web chat's amber event line.
    proactiveResolver: (sid) => pty.getActiveTurnIsProactive(sid),
    // Companion Trust Window close hook (Framework Card 0): a re-pair (dm-bind / group-sender) or "/lock"
    // revokes every window the session holds. orchMcp is constructed below this block, so this closes over
    // the `let` it's assigned to — safe: neither fires until a real inbound/command lands, well after boot.
    closeTrustWindow: (sid) => orchMcp.closeCompanionTrustWindow(sid),
    transcribe: sttTranscriber,
    synthesize: ttsSynthesizer,
    // PERSONA reinject (companion-persona-after-clear card, generalized by the standalone "/refresh" command
    // to a live, non-destructive upgrade path): composes THIS session's fresh-spawn-equivalent startup prompt
    // (base brief + name + memory recall — re-read from the agent's CURRENT row, so an edited persona/prompt
    // is picked up) and enqueues it via a RAW pty.enqueueStdin — deliberately bypassing submitTurn/
    // handleInbound so it is never recorded to chat history and never pushed to a live web viewer
    // (source:"system", kind defaults "warning" — mirrors the resume-half memory-recall reinject at
    // sessions/service.ts). No prompt (session gone / no longer assistant) ⇒ no enqueue. Returns whether a
    // prompt was actually composed+enqueued, so "/new" and "/refresh" can both report an accurate outcome.
    reinjectPersona: (sid) => {
      const prompt = sessions.composeCompanionReinjectPrompt(sid);
      // Card 78a16dc5: `kind` defaults "warning", and enqueueStdin's shape guard now requires a
      // "warning"-kind entry to start with its own `[loom:*]` tag — the composed prompt itself starts
      // with the persona brief text, not a tag, so it must be prefixed here or the guard would drop
      // every real reinject as malformed.
      if (prompt) pty.enqueueStdin(sid, `[loom:persona-reinject] ${prompt}`, "system");
      return !!prompt;
    },
    // CONVERSATION-PRESERVING respawn (Companion Capability & Permission-Lever Framework §6): re-resolve +
    // re-pin the companion's CURRENT profile-driven capability surface, then stop+`--resume` the OS process
    // so a newly-granted tool-bearing lever reaches an already-running companion without losing its
    // conversation thread. Human/REST-triggered only (POST /api/companion/:sessionId/upgrade) — see
    // sessions/service.ts's upgradeCompanionCapabilities for the full mechanism.
    upgradeCompanionSession: (sid) => sessions.upgradeCompanionCapabilities(sid),
  });

  // OrchestrationMcpRouter needs SessionService (worker_spawn/worker_stop), so it comes after. The
  // companion hooks gate chat_reply to the single bound session (additive; every other spawn unchanged).
  // `pty` is threaded directly (not via SessionService) so worker_list/worker_status can read the live
  // in-memory `lastOutputAt` intra-turn liveness signal (pty/host.ts) without adding a passthrough to
  // SessionService. It's the constructor's optional trailing param (added after companion) so every
  // other (non-index.ts) call site stays byte-identical. `gitWriteTimeouts` (card a3c3ade8, the
  // companion `git-push` lever) mirrors `platformMcp`'s own trailing git-write-timeouts param just below —
  // the SAME boot-resolved numbers, so a companion's git_commit/git_push bound exactly like the human
  // REST git routes and the Platform Lead's own git tools.
  const orchMcp = new OrchestrationMcpRouter(db, sessions, companionHooks, pty, { gitLocalMs: timeouts.gitLocalMs, gitPushMs: timeouts.gitPushMs });
  // Platform MCP (Pillar C / P2) needs the registry (project/agent/profile/schedule + config) AND
  // SessionService (the cross-project session_spawn/session_stop lifecycle ops). P3 also threads the
  // BOOT-BOUND git-write timeouts so the Lead's elevated git tools (git_checkout/commit/push) bound a
  // git op EXACTLY like the human REST git routes (gateway/server.ts resolves the same numbers). `pty`
  // (added for `question_resolve`, card feat(mcp): let an owner chat reply resolve a pending Request as
  // answered) mirrors OrchestrationMcpRouter's own trailing-optional pty param just above.
  const platformMcp = new PlatformMcpRouter(db, sessions, { gitLocalMs: timeouts.gitLocalMs, gitPushMs: timeouts.gitPushMs }, pty);
  // Audit MCP (P5) — the Platform Auditor's RESTRICTED read-and-file-only surface. Needs the registry
  // (transcript reads + session list) AND SessionService (audit_file_finding → reserved Platform board).
  // Deliberately gets NO git-write timeouts: it has no git/vault/config/spawn tools, by design.
  const auditMcp = new AuditMcpRouter(db, sessions);
  // Workspace-audit MCP (End-User Platform tier B3) — the END-USER Auditor's de-privileged read-and-
  // suggest-only surface. Needs the registry (shared transcript reads + preset suggestions) AND
  // SessionService (audit_suggest_improvement → the user's reserved "Platform" setup home). Like the dev
  // Auditor it gets NO git-write timeouts: it has no git/vault/config/spawn tools, by design.
  const userAuditMcp = new WorkspaceAuditMcpRouter(db, sessions);
  // Setup MCP (Setup Assistant E1-3) — the ungated, user-facing onboarding assistant's CURATED,
  // fail-closed surface (project/agent/profile create+configure + manager|plain spawn). Needs the
  // registry (structural/profile/read ops) AND SessionService (session_spawn). Deliberately gets NO
  // git-write timeouts: it has no git/vault/config-elevation/schedule/message tool, by design.
  const setupMcp = new SetupMcpRouter(db, sessions);
  // Operator MCP (Bucket 2b "Bounded Elevated Operator") — the per-install, opt-in, own-workspace-
  // confined surface (own-project git writers + vault_write, NO projectId argument — the target is
  // always resolved server-side from the caller's own session). Threads the SAME boot-bound git-write
  // timeouts as the Lead's P3 tools (platformMcp above), so an operator git op is bounded identically to
  // both the human REST path and the Lead's elevated tools.
  const operatorMcp = new OperatorMcpRouter(db, sessions, { gitLocalMs: timeouts.gitLocalMs, gitPushMs: timeouts.gitPushMs });
  // Run MCP (Agent Runs R2) — the ephemeral run's restricted submit_result surface. Needs the registry
  // (resolve session→run) AND SessionService (validate + record + teardown). Gets NO git/vault timeouts.
  const runMcp = new RunMcpRouter(db, sessions);

  // Account-wide Claude plan-usage poller — one shared cached fetch of the OAuth usage endpoint, served
  // read-only to Mission Control via GET /api/usage/limits. Created here so the gateway can read its
  // cache; started below (after listen). BOOT-BOUND cadence from the resolved platform config
  // (LOOM_USAGE_POLL_INTERVAL_MS env read + floor-clamped inside resolveConfig; default 60s).
  const usageStatus = new UsageStatusPoller({ intervalMs: watchers.usagePollMs });
  // Session-naming version gate (pty/session-name.ts): warm the cached `claude --version` read NOW, off
  // the spawn hot path, so createPty's gate almost never sees a cold cache. ASYNC + best-effort — never
  // blocks boot; a spawn that races ahead of this just omits `-n` for that one session (see
  // prewarmClaudeVersionAsync's doc). Independent of the usage poller/credentials below (the version
  // probe needs neither).
  prewarmClaudeVersionAsync();

  // The graceful-shutdown path, shared by the SIGINT/SIGTERM handlers and the loopback
  // POST /internal/shutdown control hook (`loom stop`). Assigned BELOW, after the watchers it closes
  // over exist; the endpoint only fires at request time (long after boot), so this ref is always
  // populated by then. The buildServer thunk delegates to it.
  let gracefulShutdown: ((reason: string) => void) | null = null;

  // Epic 2c-2 (UI half) — periodic npm-registry "update available" check + the self-update trigger.
  // The watcher polls dist-tags for `loomctl` on the persisted channel (PACKAGED installs only; a
  // from-source daemon reports packaged:false and never hits the network); the gateway serves its cached
  // status read-only via GET /api/update-status. beginSelfUpdate is the loopback POST /internal/update
  // target: it spawns the DETACHED `loom update` (E2c-1) which runs the end-user stop→install→start cycle.
  // Sweep G6: `resolved.updateCheckIntervalMs` already folds in the platform override ??
  // LOOM_UPDATE_CHECK_INTERVAL_MS env ?? the hardcoded 6h default (config.ts), so it's always a defined
  // number here — no `|| undefined` fallback needed at this call site anymore.
  const updateCheck = new UpdateCheckWatcher({
    loomHome: LOOM_HOME,
    intervalMs: resolved.updateCheckIntervalMs,
  });
  // Spawn the detached updater. Packaged-gated by the route, double-checked here (a sensitive op): resolve
  // the CLI bin via the umbrella package walk-up (works in the packaged form), spawn it fully detached with
  // its own log file under LOGS_DIR, and unref so this daemon can exit cleanly when `loom update` stops it.
  // A bare `loom update` reuses the persisted channel (E2c-1), so no channel arg is needed.
  const beginSelfUpdate = (): void => {
    if (!isPackagedInstall()) { console.warn("[self-update] refused: not a packaged install"); return; }
    const root = umbrellaRootDir();
    if (!root) { console.warn("[self-update] refused: could not resolve the loomctl package root"); return; }
    const bin = path.join(root, "bin", "loom.mjs");
    const channel = readUpdateChannel(LOOM_HOME);
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const logFd = fs.openSync(path.join(LOGS_DIR, "self-update.log"), "a");
      const child = spawn(process.execPath, [bin, "update"], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
      });
      child.unref();
      console.log(`[self-update] spawned 'loom update' (channel ${channel}, pid ${child.pid}) — daemon will stop, reinstall, restart`);
    } catch (err) {
      console.error(`[self-update] failed to spawn the updater: ${(err as Error).message}`);
    }
  };

  // Access-story Phase C (card 6bc02f50 CR): captured SYNCHRONOUSLY by buildServer's onHttpsResolved
  // callback (fires before the `await` below even suspends — see that option's doc) — whether TLS material
  // was ACTUALLY read and applied to the Fastify https option. This is the ONLY signal the boot-time bind
  // decision below consults for "is TLS really live"; it deliberately does NOT re-derive an independent
  // `fs.existsSync` check (a prior version of this code did, and a CR caught the resulting two-path
  // asymmetry: existsSync passing does not imply readFileSync-then-TLS-construction inside buildServer
  // actually succeeded — a present-but-unreadable key, a cert path that's a directory, or invalid PEM
  // content would ALL pass existsSync yet leave the real server on plain HTTP, so gating the bind on
  // existsSync could open a PUBLIC interface as PLAIN HTTP while believing it was HTTPS).
  let httpsActive = false;
  // Pillar B cron Scheduler gate: OPT-IN, decided ONCE at boot (LOOM_SCHEDULER_ENABLED=1 env override OR
  // the resolved platform config). Consumed both here (surfaced on /api/orchestration/status so the
  // Schedules UI is honest about whether schedules will fire) and below, where the ticker starts — the
  // SAME const, so the reported state can never drift from the ticker's real state.
  const schedulerEnabled =
    process.env.LOOM_SCHEDULER_ENABLED === "1" || resolved.orchestration.schedulerEnabled;
  const app = await buildServer({
    db, pty, sessions, mcp, orchMcp, platformMcp, auditMcp, userAuditMcp, setupMcp, operatorMcp, runMcp, control, usageStatus,
    schedulerEnabled,
    companion: companionController, inApp: inAppChannel, requestShutdown: () => gracefulShutdown?.("POST /internal/shutdown"),
    updateStatus: () => updateCheck.current(), beginSelfUpdate,
    // Access-story Phase B (card 56ffe50a): verify a presented gateway token against the real
    // gateway_tokens store — fail-closed (any non-"ok" reason, incl. malformed/unknown/bad-secret/
    // paused/revoked, is a plain false; the trust-tier hook never distinguishes why).
    verifyGatewayToken: (token) => db.authenticateGatewayToken(token).ok,
    onHttpsResolved: (active) => { httpsActive = active; },
  });
  // Access-story fail-closed boot check (Phase A card 766f8b50, extended by Phase C card 6bc02f50): a
  // non-loopback bind is only ever actually opened when a gateway token exists AND the TLS mandate is
  // satisfied by the REAL `httpsActive` signal above (never "bind, then warn"). `gatewayTokenExists` is
  // Phase B: ANY minted row counts (a paused/revoked token still means the mechanism is provisioned — the
  // human just needs to mint/rotate one that's live). The invariant this preserves: a non-loopback bind
  // NEVER opens in the intended-TLS-but-actually-plain-HTTP state — a tailnet bindHost bypasses the TLS
  // mandate entirely (already-encrypted transport; see tlsRequirementSatisfied), everything else needs
  // httpsActive:true or the bind stays loopback.
  const remoteAccessConfig = resolveConfig(undefined, db.getPlatformConfig()).remoteAccess;
  const gatewayTokenExists = (): boolean => db.listGatewayTokens().length > 0;
  const remoteListenerOk = canOpenRemoteListener(remoteAccessConfig, gatewayTokenExists(), httpsActive);
  if (isTrustTierHookActive(remoteAccessConfig) && !remoteListenerOk) {
    const reasons: string[] = [];
    if (!gatewayTokenExists()) reasons.push("no gateway token exists yet");
    if (!tlsRequirementSatisfied(remoteAccessConfig, httpsActive)) {
      reasons.push(remoteAccessConfig.tls
        ? "the configured TLS cert/key did not load (see the earlier [gateway] warning for why)"
        : "TLS is required for a non-tailnet remote bind but remoteAccess.tls is not configured");
    }
    console.warn(`[gateway] remoteAccess.enabled with bindHost=${remoteAccessConfig.bindHost} but ${reasons.join("; ")} — refusing to open a remote listener; staying on loopback (127.0.0.1).`);
  }
  // local-first default: loopback ONLY, unless the fail-closed boot check above cleared a real remote bind.
  const boundAddress = await app.listen({ port: PORT, host: remoteListenerOk ? remoteAccessConfig.bindHost : "127.0.0.1" });
  // eslint-disable-next-line no-console
  console.log(`Loom daemon v${loomVersion()} listening on ${boundAddress}`); // boundAddress reflects the OS-assigned port when PORT is 0
  // P5b hardening follow-up (card 80e2093f, item 2): 0.0.0.0/:: is an explicit, owner-decided supported
  // LAN-in-scope bind mode (still gated by the token+TLS wall above) — but binding every interface should
  // never be SILENT. Log it plainly the one time it's actually opened, distinct from the routine listen line.
  if (remoteListenerOk && isAllInterfacesBindHost(remoteAccessConfig.bindHost)) {
    console.warn(`[gateway] Loom gateway bound to all interfaces (${remoteAccessConfig.bindHost}) — reachable from your local network (still gated by the access token + TLS).`);
  }

  // Boot-time orchestration reconcile (#22 run-2 + audit M4): finish any merge whose bookkeeping was
  // interrupted (branch merged but task/worktree not reconciled) and GC orphaned worktrees from
  // crashed workers. Runs AFTER recoverStaleSessions (no live pty holds a worktree) — pure git + db.
  // Best-effort cleanup: it must NEVER gate startup, so any unexpected failure is warned and swallowed
  // (a deterministic throw here would otherwise crash-loop the boot, since merging self-restarts the
  // dev daemon — and that would also block usage-limit auto-resume).
  // Kicked here, AFTER listen and NOT awaited (perf card 460d3178): the fs-heavy worktree removals
  // (Pass A finalizeMerge->removeWorktree, Pass B removeWorktree) run in serial `await`ed loops, and each
  // stuck Windows dir handle blocks the full GIT_OP_TIMEOUT_MS (15s) before its withTimeout swallows and
  // moves on — N danglers serialize to N*15s. Awaiting this before listen left port PORT unbound for the
  // whole span. Nothing between the old await site and listen reads its result, so backgrounding it is
  // pure ordering — the reconcile logic (guards, serial removal, summary log) is unchanged; it just runs
  // fire-and-forget instead of gating the port bind. A merge briefly showing un-finalized on the board
  // for the run's duration is a self-healing cosmetic cost, not a correctness one.
  // worktreesPruned counts only an ACTUAL removal (task 8e5a7a5e) — a boot pass whose only activity is
  // retrying an already-wedged worktree (still held, not yet actually removed) would otherwise leave
  // every one of these counters at 0 and silently skip this summary line, so worktreesStillWedged is
  // included in the gate (it's reported separately below, not folded into the "pruned" wording, which
  // means something narrower now: an ACTUAL removal, not merely a retried attempt).
  // NOTE (multi-repo epic 49136451 phase 2): `worktreesStaleRepoKey` is DELIBERATELY left OUT of this
  // condensed summary line/gate — reconcileOrchestrationOnBoot already emits its OWN dedicated warn for
  // it, mirroring worktreesNeedsHuman/stillWedged (also not folded into this line's wording). Keep new
  // counters as SEPARATE surfaced signals rather than appending to this line — readability, not a test
  // constraint: boot-listen-not-blocked.mjs (card fdf93d3a) now asserts this chain via the real AST
  // (src/index.ts), so growing this line or adding comments near the call site below is safe.
  void sessions.reconcileOrchestrationOnBoot(protectedSessionIds).then((reconciled) => {
    if (reconciled.mergesFinished || reconciled.mergesFailed || reconciled.staleMergesResolved || reconciled.worktreesPruned || reconciled.worktreesKept || reconciled.worktreesNeedsHuman || reconciled.worktreesStillWedged) {
      console.log(`[boot] orchestration reconcile: finished ${reconciled.mergesFinished} orphaned merge(s), ${reconciled.mergesFailed} failed (retry next boot), resolved ${reconciled.staleMergesResolved} branch-gone dangling merge(s), pruned ${reconciled.worktreesPruned} orphaned worktree(s), ${reconciled.worktreesStillWedged} still wedged (retried, not skipped, until it clears), kept ${reconciled.worktreesKept} holding unmerged/uncommitted work, gave up on ${reconciled.worktreesNeedsHuman} worktree(s) wedged too long (needs a human)`);
    }
  }).catch((err) => {
    console.warn(`[boot] orchestration reconcile failed (continuing boot): ${(err as Error).message}`);
  });

  // Boot-revive (bug 4cc7826d, companion/revive.ts): revive each bound session BEFORE the controller wires
  // its gateway around it — see revive.ts for the full why (no human viewer to click "Resume" like a
  // manager/worker has). Best-effort per session; never gates boot.
  for (const cfg of companionCfgs) {
    reviveCompanionSessionAtBoot(cfg, { isAlive: (sid) => pty.isAlive(sid), resume: (sid) => { sessions.resume(sid); } });
  }
  // Loom Companion: start every enabled companion now that the server is up (chat_reply routes back through
  // this process). The controller builds+starts each one's Telegram long-poll, arms its proactive heartbeat
  // if a positive cadence is set, and adds it to the chat_reply gate — a no-op when NO companion is enabled
  // at boot (companionCfgs empty). From here a human-only REST config write reconciles this SAME live set
  // with no daemon restart (start/update/stop per session), so this is the ONLY boot-time companion start.
  await companionController.startInitial(companionCfgs);
  if (companionCfgs.length > 0) {
    for (const cfg of companionCfgs) {
      // Boot-time warn: inbound is role-agnostic, but chat_reply only registers for manager|worker|assistant.
      // A binding to any OTHER role could "hear but not reply" — surface it rather than fail silently.
      const boundRole = db.getSession(cfg.sessionId)?.role ?? null;
      if (boundRole && boundRole !== "manager" && boundRole !== "worker" && boundRole !== "assistant") {
        console.warn(
          `[companion] WARNING: bound session ${cfg.sessionId.slice(0, 8)} has role '${boundRole}' — ` +
            "inbound will be delivered but chat_reply is NOT registered for this role (companion can HEAR but " +
            "not REPLY). Bind an assistant/manager/worker session.",
        );
      }
      console.log(`[boot] Loom Companion on (bound session ${cfg.sessionId.slice(0, 8)}, allowlisted chat ${cfg.allowedChatId})`);
      if (cfg.heartbeatIntervalMinutes > 0) {
        console.log(`[boot] Companion heartbeat on (every ${cfg.heartbeatIntervalMinutes}m, session ${cfg.sessionId.slice(0, 8)})`);
      } else {
        console.log("[boot] Companion heartbeat off (set LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES to a positive value)");
      }
      // Recurring reminders (Companion Memory & Reminders Design, Surface 2 s3): armed by the SAME
      // startInitial → controller.applyDesired call above (rearmReminders), not a separate boot path — this
      // is purely an observability log, mirroring the heartbeat one. Zero rows (the common case today; s4
      // ships the reminder_* MCP tools) ⇒ this always reads 0, byte-identical to no watcher having existed.
      const reminderCount = db.listEnabledCompanionReminders(cfg.sessionId).length;
      if (reminderCount > 0) {
        console.log(`[boot] Companion reminders on (${reminderCount} enabled, session ${cfg.sessionId.slice(0, 8)})`);
      }
    }
  } else {
    console.log("[boot] Loom Companion off (set LOOM_COMPANION_BOT_TOKEN + LOOM_COMPANION_CHAT_ID + LOOM_COMPANION_SESSION_ID)");
  }

  // Pillar B: the cron trigger layer. Boots a manager (interactive pty, never headless) on each
  // due schedule's tick. OPT-IN (autonomy earned gate-by-gate): only start when enabled via the
  // platform config OR the LOOM_SCHEDULER_ENABLED=1 env override. LOOM_SCHEDULER_INTERVAL_MS tunes
  // the tick cadence (default 60s) — tests use a short interval to avoid a 60s wait.
  // schedulerEnabled is computed once up-front (before buildServer) and shared: the gateway reports it
  // on GET /api/orchestration/status so the UI is honest about whether schedules will fire.
  // BOOT-BOUND cadence from the resolved platform config (LOOM_SCHEDULER_INTERVAL_MS env read +
  // floor-clamped inside resolveConfig; default 60s).
  const intervalMs = watchers.schedulerMs;
  // card 52ab5d45: sourced from the daemon-global PlatformConfigOverride (`platformOverride`), not a
  // per-project override — the Scheduler is one daemon-wide service. `resolved.orchestration.
  // maxConcurrentManagers` already folds `platformOverride?.maxConcurrentManagers` in via resolveConfig's
  // merge (config.ts); the explicit `platformOverride?.maxConcurrentManagers ??` here is belt-and-suspenders
  // at the actual construction site, matching how `maxConcurrentManagers` is read at every other call site.
  const maxConcurrentManagers = platformOverride?.maxConcurrentManagers ?? resolved.orchestration.maxConcurrentManagers;
  // Sweep G2 (mirrors maxConcurrentManagers immediately above): SEPARATE daemon-global auditor budget,
  // same belt-and-suspenders construction-site read.
  const maxConcurrentAuditors = platformOverride?.maxConcurrentAuditors ?? resolved.orchestration.maxConcurrentAuditors;
  // card 53edd8d5: `{scheduled:true}` is what pins Session.scheduledSpawn on the spawned row, so ONLY
  // the Scheduler's own manager spawns count against `maxConcurrentManagers` (Db.countLiveScheduledManagers)
  // — every other startManager caller (REST, generic dispatch) omits it and stays unaffected.
  const scheduler = new Scheduler({ db, control, startManager: (agentId, prompt) => sessions.startManager(agentId, prompt, { scheduled: true }), startAuditor: (agentId, prompt) => sessions.startAuditor(agentId, prompt), startWorkspaceAuditor: (agentId, prompt) => sessions.startWorkspaceAuditor(agentId, prompt), intervalMs, maxConcurrentManagers, maxConcurrentAuditors });
  if (schedulerEnabled) {
    scheduler.start();
    console.log(`[boot] scheduler enabled (tick ${intervalMs}ms)`);
  } else {
    console.log("[boot] scheduler disabled (enable it under Settings → Global / Daemon, or set LOOM_SCHEDULER_ENABLED=1)");
  }

  // Codescape fleet-daemon (C1): fire-and-forget, like the reconcile kick above — ingest-then-serve can
  // take a while (a real repo's initial graph build), and nothing here should delay listen() or later
  // boot steps. `.start()` itself logs its own "off"/"starting" state and NEVER throws past this .catch.
  // v1 bootstrap: feed every codescape-enabled project's repoPath so `start()` ingests each one BEFORE
  // `serve` boots — serve loads its project index from `.codescape/projects/index.json` at BOOT ONLY (the
  // CWD CONTRACT doc in codescape/supervisor.ts), so a project enabled here is the only way it's ever seen.
  // v1 has NO runtime registration: a project whose `codescape.enabled` flips ON after this boot is not
  // picked up until the NEXT daemon restart (see the log at the config-PATCH site in gateway/server.ts) —
  // a real gap, not silently papered over, and intentionally NOT solved here (that's a deferred v2 feature).
  void codescapeSupervisor.start(codescapeBootRepoPaths(db.listProjects())).catch((err) => {
    console.warn(`[boot] codescape supervisor failed to start (continuing boot): ${(err as Error).message}`);
  });

  // §19c-b usage-limit RESUME watcher — ALWAYS ON (recovery ≠ autonomy; a manually-started session
  // can hit the cap too), so it runs regardless of schedulerEnabled. LOOM_RATE_LIMIT_WATCH_INTERVAL_MS
  // tunes the tick for tests (default 60s).
  const watchIntervalMs = watchers.rateLimitWatchMs;
  const rateLimitWatcher = new RateLimitWatcher({ db, pty, capQueue: sessions, intervalMs: watchIntervalMs });
  rateLimitWatcher.start();
  console.log(`[boot] usage-limit resume watcher on (tick ${watchIntervalMs}ms)`);

  // Account-wide plan-usage poller — start it now that the server is up (skips itself if there's no
  // credentials file). Read-only god-eye data for Mission Control; failures degrade to unavailable.
  // LOOM_SUPPRESS_USAGE_POLLER=1 (paths.ts isUsagePollerSuppressed) skips start() entirely for a
  // throwaway/e2e/demo daemon — start() is the ONLY caller of pollOnce() anywhere in the daemon, so
  // skipping it leaves the poller's cache at its constructor default (available:false), which
  // GET /api/usage/limits already serves unmodified. No real Claude credentials are ever read.
  if (isUsagePollerSuppressed()) {
    console.log("[boot] plan-usage poller suppressed (LOOM_SUPPRESS_USAGE_POLLER=1)");
  } else {
    usageStatus.start();
    console.log("[boot] plan-usage poller on (GET /api/usage/limits)");
  }

  // Update-availability watcher — periodic, best-effort npm dist-tags check (packaged installs only;
  // a source daemon short-circuits with no network). Read-only via GET /api/update-status.
  updateCheck.start();
  console.log(`[boot] update-check watcher on (packaged=${isPackagedInstall()}, GET /api/update-status)`);

  // The self-scheduled wake-up ticker (always on; reconciles past-due wakes fire-once on start()).
  wakes.start();
  console.log(`[boot] wake-up ticker on (tick ${wakeIntervalMs}ms)`);

  // The local poll-job trigger ticker (always on; zero rows ⇒ a no-op tick).
  polls.start();
  console.log(`[boot] poll ticker on (tick ${pollIntervalMs}ms)`);

  // The local event-trigger dispatcher (always on; zero rows ⇒ a no-op tick).
  eventTriggers.start();
  console.log("[boot] event-trigger dispatcher on");

  // Input-queue reconcile: self-heal stuck-busy sessions and drain any message held while the session
  // was busy / the human was typing — so a worker report never strands behind a phantom 'busy' or an
  // unfinished compose. The Stop hook is the fast path; this is the safety net (10s).
  const reconcileMs = watchers.reconcileMs;
  const reconcileTimer = setInterval(() => pty.reconcile(), reconcileMs);
  console.log(`[boot] input-queue reconcile on (tick ${reconcileMs}ms)`);

  // Periodic transcript-snapshot backstop — closes the hard-crash-no-signal gap the graceful
  // SIGINT/SIGTERM hook (5f838ef) can't cover: a kill-9 / power-loss fires NO signal, and a long-lived
  // session has no snapshot until it exits. A low-frequency timer snapshots every LIVE session's engine
  // transcript; snapshotTranscript is mtime-guarded → a cheap no-op when a session's JSONL is unchanged.
  // Best-effort: snapshotAllLive swallows per-session failures and never throws; the try guards the rest.
  // BOOT-BOUND cadence from the resolved platform config (LOOM_SNAPSHOT_INTERVAL_MS env, default ~7m).
  const snapshotMs = watchers.snapshotMs;
  const snapshotTimer = setInterval(() => {
    try { sessions.snapshotAllLive(); } catch { /* never let the periodic ticker throw */ }
  }, snapshotMs);
  console.log(`[boot] periodic transcript-snapshot on (tick ${snapshotMs}ms)`);

  // Manager context-recycle watcher — nudges a manager nearing its model's context window to hand off
  // to a fresh successor (run /loom-session-end → recycle_me). Ratio scales with the model. 0 disables.
  // LOOM_RECYCLE_CONTEXT_RATIO, if set, is a GLOBAL FORCE that overrides every project's own ratio —
  // it is NOT baked together with the platform default here; ContextWatcher/IdleWatcher instead resolve
  // each manager's threshold from ITS OWN project's config (resolveConfig folds the platform default
  // under any project override) so a per-project recycleAtContextRatio (e.g. 0.5) is actually honored.
  const recycleRatio = Number(process.env.LOOM_RECYCLE_CONTEXT_RATIO) || 0;
  const ctxWatchMs = watchers.contextWatchMs;
  const contextWatcher = new ContextWatcher({ db, pty, ratio: recycleRatio, intervalMs: ctxWatchMs });
  contextWatcher.start();
  console.log(`[boot] context-recycle watcher on (${recycleRatio > 0 ? `env-forced ratio ${recycleRatio}` : `per-project ratio, platform default ${resolved.orchestration.recycleAtContextRatio}`}, tick ${ctxWatchMs}ms)`);

  // Asleep-at-the-Wheel watcher — nudges a LIVE manager that has silently dropped its orchestration
  // loop (idle, no live workers, backlog open) to report why and resume. Per-project leash via
  // resolveConfig (idleNudgeMinutes; 0 disables); recycle takes precedence (shares recycleRatio).
  const idleWatchMs = watchers.idleWatchMs;
  const idleWatcher = new IdleWatcher({
    db, pty, control, recycleRatio, intervalMs: idleWatchMs,
    // Idle-WORKER coverage (board card b9d479b0): re-fire the SAME reconciled edge nudge periodically —
    // never a second, drifted reconciliation (board card 99efaab3 requirement).
    notifyIdleWorker: (workerSessionId) => sessions.notifyManagerOfIdleWorker(workerSessionId),
    // Single-sources the SAME reconciliation for the manager loop's own idle message (CR blocker #2).
    isWorkerStranded: (workerSessionId) => sessions.isWorkerGenuinelyStranded(workerSessionId),
  });
  idleWatcher.start();
  console.log(`[boot] idle-manager watcher on (tick ${idleWatchMs}ms)`);

  // Busy-worker stuck watchdog — the inverse of the idle-manager watcher: surfaces a LIVE worker stuck
  // `busy` past the per-project `stuckWorkerMinutes` window (no turn boundary → stale lastActivity) to
  // its OWNING MANAGER as a `worker_stuck` event + a nudge it can act on (re-nudge / recycle). Never a
  // hard kill. Shares the idle-watch cadence (sibling watchdog); 0 disables per project.
  const busyWorkerWatcher = new BusyWorkerWatcher({ db, pty, control, intervalMs: idleWatchMs });
  busyWorkerWatcher.start();
  console.log(`[boot] busy-worker stuck watchdog on (tick ${idleWatchMs}ms)`);

  // Resume-doc-size watcher (card 809cc4b5) — the mid-session proactive half of the resume-doc
  // size-budget nudge: `composeManagerStartupPrompt` only warns at spawn/recycle time, which is too
  // late for a manager that stays live and keeps growing its doc without ever recycling. Shares the
  // idle-watch cadence (sibling watchdog); no dedicated config knob.
  const resumeDocWatcher = new ResumeDocWatcher({ db, pty, intervalMs: idleWatchMs });
  resumeDocWatcher.start();
  console.log(`[boot] resume-doc-size watcher on (tick ${idleWatchMs}ms)`);

  // Session usage telemetry sampler (epic c9924bcd, card B) — a background ticker that reads each LIVE
  // session's engine transcript, computes the per-interval billed-usage DELTA (reset-aware), and appends a
  // session_usage_samples row. 100% daemon-side + token-FREE (pure file IO; never invokes an agent / makes
  // a model call). A one-time boot backfill (app_meta marker) seeds coarse history from transcripts still
  // on disk so the page isn't empty on day one; the teardown sample (onExit, above) catches each tail.
  // Cadence + retention are DAEMON-GLOBAL (resolved platform default; HUMAN-only). Declared here, referenced
  // by the pty onExit closure (forward ref, runtime-only — same pattern as `sessions`/`orchMcp`).
  const usageSampler = new UsageSampler({ db, intervalMs: resolved.usageSampleIntervalMs, retentionDays: resolved.usageSampleRetentionDays });
  try {
    // One-shot corrective reset (must precede the backfill): the boot that first ships the restart-double-
    // count fix scrubs the inflated samples + re-arms the backfill so the corrected accounting repopulates
    // clean. A no-op on every later boot (app_meta marker). See UsageSampler.correctiveResetOnce.
    const cleared = usageSampler.correctiveResetOnce();
    if (cleared > 0) console.log(`[boot] usage-sampler corrective reset: cleared ${cleared} inflated sample(s); rebuilding from transcripts`);
    const seeded = usageSampler.backfillOnce();
    if (seeded > 0) console.log(`[boot] usage-sampler backfill: seeded ${seeded} historical session usage sample(s)`);
  } catch (err) {
    console.warn(`[boot] usage-sampler backfill failed (continuing boot): ${(err as Error).message}`);
  }
  usageSampler.start();
  console.log(`[boot] session usage sampler on (tick ${resolved.usageSampleIntervalMs}ms, retain ${resolved.usageSampleRetentionDays}d)`);

  // Crash-recovery watchdog — the complement of resumeFleetOnBoot (which owns daemon-RESTART recovery):
  // bounded auto-resume of an ISOLATED session whose pty died UNEXPECTEDLY while the daemon stayed healthy
  // (the `session_died` trigger recorded in onExit). Caps attempts per project (crashRecoveryMaxAttempts;
  // 0 = off) via a persisted counter and ESCALATES on Mission Control after the cap instead of looping —
  // crash-loop safety is the load-bearing property. Resume re-spawns through the same hardened path.
  const crashRecoveryMs = watchers.crashRecoveryWatchMs;
  const crashRecoveryWatcher = new CrashRecoveryWatcher({
    db, control, pty, intervalMs: crashRecoveryMs,
    resume: (id) => { sessions.resume(id); return true; },
  });
  crashRecoveryWatcher.start();
  console.log(`[boot] crash-recovery watchdog on (tick ${crashRecoveryMs}ms)`);

  // Automatic DB-backup ticker — periodic online snapshots of loom.db into ~/.loom/backups/auto/,
  // rotated to the newest `keep`. Best-effort; never blocks/crashes. Disabled when backups are off or
  // the interval is 0. LOOM_BACKUP_INTERVAL_MS overrides the tick cadence for tests (otherwise minutes).
  // Sweep G4: unlike the pre-migration `bootBackupCfg` above, `resolved.backup` here DOES consult the
  // platform override — `db` (and so `platformOverride`) is already open/loaded by this point in boot.
  const dbBackupWatcher = new DbBackupWatcher({
    enabled: resolved.backup.enabled,
    intervalMinutes: resolved.backup.intervalMinutes,
    keep: resolved.backup.keep,
    intervalMs: Number(process.env.LOOM_BACKUP_INTERVAL_MS) || undefined,
  });
  dbBackupWatcher.start();
  console.log(
    resolved.backup.enabled && resolved.backup.intervalMinutes > 0
      ? `[boot] db-backup ticker on (every ${resolved.backup.intervalMinutes}m, keep ${resolved.backup.keep})`
      : `[boot] db-backup ticker off (${resolved.backup.enabled ? "interval 0" : "disabled"})`,
  );

  // Vault auto-committer — start ONE VaultVersioner per UNIQUE governing repo root so agent doc rewrites
  // (the mandated rewrite-in-place loom-doc-hygiene flow, done with the plain Write/Edit tool) accrue git
  // history and a destructive overwrite has a recovery path. Without this the class was dead code: only
  // commitVault (the UI-write path) ever ran. Deduped by the resolved repo ROOT — the owner's real layout
  // is ONE repo at the vault root with each project's vaultPath a SUBFOLDER, so sibling subfolders collapse
  // to a single root watcher that commits the whole repo. An Obsidian-Git-managed repo is skipped (a real
  // external auto-committer owns its history); a bare vault folder with no repo is git-inited. Best-effort.
  let vaultVersioners: VaultVersioner[] = [];
  try {
    vaultVersioners = await startVaultVersioners(db);
    console.log(`[boot] vault auto-committer on (${vaultVersioners.length} unique vault(s))`);
  } catch (err) {
    console.warn(`[boot] vault auto-committer start failed (continuing boot): ${(err as Error).message}`);
  }

  // Vault push-status visibility (task f48ee77d): the auto-committer above is commit-only BY DESIGN —
  // pushing is a human-only trust-boundary action (git/writer.ts GitWriter.push()), never something this
  // unattended, filesystem-triggered watcher should do itself. For a vault whose governing repo DOES have
  // a configured upstream, that means its unpushed backlog would otherwise grow silently — so this makes
  // it VISIBLE instead: one read-only check at boot, then a periodic re-check, both via `logVaultPushStatus`
  // (git status reads only; no writes, no push). A vault with no upstream (the common local-only case)
  // is skipped with zero noise. Twin of the db-backup ticker just above in shape (boot check + interval).
  try {
    await logVaultPushStatus(vaultVersioners.map((v) => v.commitRoot));
  } catch (err) {
    console.warn(`[boot] vault-push-status check failed (continuing boot): ${(err as Error).message}`);
  }
  const vaultPushStatusWatcher = new VaultPushStatusWatcher({
    getCommitPaths: () => vaultVersioners.map((v) => v.commitRoot),
    intervalMs: Number(process.env.LOOM_VAULT_PUSH_CHECK_INTERVAL_MS) || undefined,
  });
  vaultPushStatusWatcher.start();

  // Outbound alert-webhook (external delivery): a passive listener on the orchestration event
  // chokepoint that POSTs to a HUMAN-configured `orchestration.alertWebhook` URL on matching event
  // kinds — best-effort + bounded, never blocks/breaks the event path. Registered AFTER the boot
  // reconcile so a restart's recovery events don't fire stale alerts. No external delivery happens
  // unless a human has configured a webhook for the project (default OFF).
  const alertWebhook = new AlertWebhookEmitter({ db });
  db.setEventListener((evt) => { void alertWebhook.onEvent(evt); });
  console.log("[boot] alert-webhook emitter registered (external delivery on configured projects)");

  // Self-host restart recovery (consume the intent read above): a manager deliberately restarted the
  // daemon (daemon_restart) to make merged code live. The daemon is ONE process for ALL projects, so the
  // restart tore down the WHOLE cross-project fleet — re-resume ALL of it (every manager, worker, plain
  // session), not just the requester (P1 17df54c5). resumeFleetOnBoot re-spawns each with its role +
  // linkage, injects nothing into the resume, gives the requester its "code is live" re-prompt and the
  // rest a continuation nudge, and honors a parked session's usage hold. Best-effort + runs once.
  if (restartIntent) {
    clearRestartIntent();
    const { resumed, skippedParked, failed } = sessions.resumeFleetOnBoot(restartIntent);
    console.log(
      `[boot] self-host restart: resumed ${resumed.length} session(s) across the fleet` +
      (skippedParked.length ? `, ${skippedParked.length} resumed-but-parked (usage hold honored)` : "") +
      (failed.length ? `, ${failed.length} unresumable (skipped)` : "") +
      ` (requester ${restartIntent.managerSessionId.slice(0, 8)})`,
    );
  } else if (crashOrphanedWorkers.length > 0 || crashOrphanedManagers.length > 0) {
    // Crash-orphaned recovery (card 9fc41af5): no restart-intent means this was a genuine crash (or an
    // OS-service restart), not a deliberate daemon_restart — resumeFleetOnBoot never ran, so this is the
    // ONLY path that brings these workers' managers (and any solo manager with no surviving worker) back.
    // Best-effort + runs once.
    const { resumed, skippedParked, failed, managersFailed } =
      sessions.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers, shutdownMarker });
    console.log(
      `[boot] crash recovery: re-parented ${resumed.length} in-flight worker(s) to their resumed manager(s)` +
      (skippedParked.length ? `, ${skippedParked.length} resumed-but-parked (usage hold honored)` : "") +
      (failed.length ? `, ${failed.length} unresumable (skipped)` : "") +
      (managersFailed.length ? `, ${managersFailed.length} manager(s) themselves unresumable (check [crash-recovery] logs above for why)` : "") +
      (shutdownMarker ? ` (clean ${shutdownMarker.reason} stop marker found — nudges classified as a restart, not a crash)` : ""),
    );
  }
  // Durable queued-message recovery (card 2ca18433): re-drive any session_message/message_worker that was
  // HELD in a busy recipient's FIFO and never delivered before this process died — a sender death (API 529)
  // or a daemon restart used to drop it silently (it lost a P1 cross-project dispatch twice). Runs on EVERY
  // boot, AFTER the fleet resume above (so resumed recipients are live to re-enqueue onto) and unconditional
  // of a restart intent (covers crash / OS-service restart too). The single re-enqueue owner — the intent
  // snapshot now excludes these (getPersistablePending), so no double on a normal restart. Best-effort:
  // never gate boot.
  try {
    const m = sessions.recoverUndeliveredMessagesOnBoot();
    if (m.reEnqueued || m.retired || m.senderNudges) {
      console.log(`[boot] queued-message recovery: re-enqueued ${m.reEnqueued} undelivered message(s), retired ${m.retired} (recipient gone), surfaced ${m.senderNudges} to live sender(s)`);
    }
  } catch (err) {
    console.warn(`[boot] queued-message recovery failed (continuing boot): ${(err as Error).message}`);
  }

  // Dead-owner merge-op sweep (card 27ea069e): the in-memory PendingOpRegistry is reset by an actual
  // process restart, so this is usually a no-op the moment it runs — it exists as belt-and-suspenders
  // for any orphaned-owner shape that survives to this point (e.g. a harness/host that doesn't fully
  // reconstruct SessionService across a "restart"). Runs AFTER the fleet-resume passes above so a
  // manager that was successfully re-resumed reads back as live, not dead, and its own in-flight merge is
  // left untouched. Never gates boot.
  try {
    const cleared = sessions.reconcileDeadOwnerMergeOps();
    if (cleared > 0) console.log(`[boot] dead-owner merge-op sweep: cleared ${cleared} orphaned merge op(s)`);
  } catch (err) {
    console.warn(`[boot] dead-owner merge-op sweep failed (continuing boot): ${(err as Error).message}`);
  }

  // Orphaned gate/merge-op sweep (card edc1ec12, Platform-Audit finding 7afa6ea9): the DURABLE complement
  // to the in-memory sweep just above — reads the `pending_gate_ops` table, which is exactly what
  // survives a real process death that wipes the in-memory PendingOpRegistry (the case the sweep above
  // admits it can't cover). A surviving row means some worker/manager was told "pending" and is waiting on
  // an async [loom:gate-*]/[loom:merge-*] nudge that can now never arrive via the normal settle path — this
  // resurfaces a synthetic terminal nudge for each one and clears the row. Runs AFTER the fleet-resume
  // passes above (same ordering reason as the sweep above: a resumed owning session must be live to
  // receive the push). Never gates boot.
  try {
    const cleared = sessions.reconcileOrphanedGateOps();
    if (cleared > 0) console.log(`[boot] orphaned gate/merge-op sweep: resurfaced ${cleared} restart-killed op(s) to their owning session(s)`);
  } catch (err) {
    console.warn(`[boot] orphaned gate/merge-op sweep failed (continuing boot): ${(err as Error).message}`);
  }

  // Setup Assistant E1-6: FIRST-RUN auto-launch. On a brand-new/empty install (no ordinary projects + the
  // one-time app_meta marker unset) greet the user by auto-spawning the Setup Assistant ONCE; the marker
  // is stamped at launch so it never re-fires — not after a daemon_restart, not after the user later
  // deletes all their projects. Runs AFTER the server is listening (the spawned setup pty needs the MCP
  // endpoints up, exactly like the restart-intent resume above) and AFTER that resume (a restart is never
  // a fresh install — the marker is already set / ordinary projects exist — so this naturally no-ops then).
  // Best-effort: a fault here must never gate boot.
  try {
    const firstRun = maybeAutoLaunchSetup(db, sessions);
    if (firstRun.launched) console.log(`[boot] first-run: auto-launched Setup Assistant (session ${firstRun.sessionId.slice(0, 8)})`);
    else if (firstRun.reason === "suppressed") console.log("[boot] first-run: auto-launch suppressed (LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1)");
  } catch (err) {
    console.warn(`[boot] first-run setup auto-launch failed (continuing boot): ${(err as Error).message}`);
  }

  // The one graceful-teardown path — invoked by a SIGINT/SIGTERM/SIGHUP signal AND by the loopback
  // POST /internal/shutdown control hook (the cross-platform `loom stop`, since Windows has no SIGTERM).
  gracefulShutdown = (reason: string) => {
    // Shutdown-reason marker (card 42cf3944): a signal-driven stop used to leave NO trace — crash.log
    // only fires on a fatal, and a signal exits 0 (clean, by design), so it was indistinguishable from a
    // hard crash after the fact (a real incident cost a whole session chasing a phantom crash that was
    // really the machine sleeping). Write it FIRST, before any other teardown step that could stall/throw,
    // and classify: a raw signal name (SIGINT/SIGTERM/SIGHUP — see HANDLED_SIGNALS below, referenced here
    // as a closure over a `const` initialized further down but always assigned before this function can
    // actually run) is an unexpected OS signal; anything else reaching this path (today: only "POST
    // /internal/shutdown") is the owner's own intentional stop — recorded as such, not masqueraded as a
    // signal. `daemon_restart` never calls this path at all (see the exit-75 branch below `main`), so its
    // own restart-intent.json remains the sole marker for that flow — untouched here.
    const isSignal = (HANDLED_SIGNALS as readonly string[]).includes(reason);
    writeShutdownMarker({ kind: isSignal ? "signal" : "intentional", reason, signal: isSignal ? reason : null });
    // Crash/shutdown transcript backstop: snapshot every LIVE session's engine transcript BEFORE we
    // exit. The pty onExit hook (the per-session snapshot trigger) never fires on a signal-kill, so
    // without this a long-lived session loses its transcript when Claude later prunes the JSONL.
    // Best-effort + never-throws (snapshotAllLive swallows per-session failures); must not block exit.
    try { const n = sessions.snapshotAllLive(); if (n > 0) console.log(`[shutdown] snapshotted ${n} live transcript(s)`); } catch { /* never block the exit */ }
    // Vault auto-commit final flush: this path is SYNCHRONOUS and exits immediately, so the versioners'
    // async debounced commit would be dropped (a doc edit inside the 5s debounce window never reaching
    // git). flushSync synchronously stages+commits each pending vault (externally-managed backoff honored,
    // no-op when nothing's staged). Best-effort + never-throws; must not block exit (mirrors the snapshot above).
    try {
      let flushed = 0;
      for (const v of vaultVersioners) { if (v.flushSync()) flushed++; }
      if (flushed > 0) console.log(`[shutdown] flushed ${flushed} pending vault commit(s)`);
    } catch { /* never block the exit */ }
    // Best-effort courtesy stop of the companion (long-poll + heartbeat, no-op when off); it dies with the
    // process anyway. The controller owns BOTH now, so stop() disarms the heartbeat too (no separate stop).
    void companionController.stop().catch(() => { /* never block the exit */ });
    scheduler.stop(); rateLimitWatcher.stop(); usageStatus.stop(); updateCheck.stop(); wakes.stop(); polls.stop(); eventTriggers.stop(); clearInterval(reconcileTimer); clearInterval(snapshotTimer); contextWatcher.stop(); idleWatcher.stop(); busyWorkerWatcher.stop(); resumeDocWatcher.stop(); usageSampler.stop(); crashRecoveryWatcher.stop(); dbBackupWatcher.stop(); vaultPushStatusWatcher.stop();
    console.log(`[shutdown] graceful stop (${reason})`);
    process.exit(0); // clean stop — NOT exit 75 (the supervisor's restart sentinel)
  };
  // SIGINT/SIGTERM plus SIGHUP — Node also emits SIGHUP for the Windows console-close case (closing the
  // terminal window) as well as the POSIX hangup case, so listing it here covers that win32 path too,
  // with no extra plumbing. Declared here (used by gracefulShutdown's classification above via closure,
  // and by the registration loop below) so both stay in sync off ONE list.
  const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of HANDLED_SIGNALS) {
    process.on(sig, () => gracefulShutdown!(sig));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
