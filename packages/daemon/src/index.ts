import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { resolveConfig } from "@loom/shared";
import { ensureDirs, PORT, LOOM_HOME, LOGS_DIR } from "./paths.js";
import { installCrashHandlers } from "./crashlog.js";
import { Db } from "./db.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { snapshotTranscript } from "./sessions/transcript.js";
import { snapshotAndArchiveRecovered } from "./sessions/boot-backstop.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { seedDefaultProfiles, seedProfileBaseSnapshots } from "./profiles/seed.js";
import { seedPlatformHome, migratePlatformPrompts } from "./platform/seed.js";
import { seedSetupHome, seedSetupProjectRename, seedSetupAgentRename, seedSetupAuditorAgent, seedCompanionAgent } from "./setup/seed.js";
import { maybeAutoLaunchSetup } from "./setup/first-run.js";
import { backfillColumnRoles } from "./tasks/columns.js";
import { prewarmMarkitdownForProfilesAtBoot } from "./python/prewarm.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { UsageSampler } from "./sessions/usage-sampler.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { PlatformMcpRouter } from "./mcp/platform.js";
import { AuditMcpRouter } from "./mcp/audit.js";
import { WorkspaceAuditMcpRouter } from "./mcp/user-audit.js";
import { SetupMcpRouter } from "./mcp/setup.js";
import { RunMcpRouter } from "./mcp/run.js";
import { OrchestrationControl } from "./orchestration/control.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { RateLimitWatcher } from "./orchestration/rate-limit-watcher.js";
import { UsageStatusPoller } from "./orchestration/usage-status.js";
import { WakeService } from "./orchestration/wake.js";
import { ContextWatcher } from "./orchestration/context-watcher.js";
import { IdleWatcher } from "./orchestration/idle-watcher.js";
import { BusyWorkerWatcher } from "./orchestration/busy-worker-watcher.js";
import { CrashRecoveryWatcher, recordUnexpectedExit } from "./orchestration/crash-recovery-watcher.js";
import { DbBackupWatcher, resolveBackupConfig, takeBackup } from "./orchestration/db-backup.js";
import { AlertWebhookEmitter } from "./orchestration/alert-webhook.js";
import { recordClaudeRateLimit } from "./orchestration/usage-awareness.js";
import { rateLimitDeadline, rateLimitedUntil } from "./orchestration/usage-limit.js";
import { readRestartIntent, clearRestartIntent, protectedIdsFromIntent } from "./orchestration/restart.js";
import { startVaultVersioners, type VaultVersioner } from "./vault/versioner.js";
import { buildServer } from "./gateway/server.js";
import { resolveCompanionConfig } from "./companion/store.js";
import { CompanionController, type CompanionReplyHooks } from "./companion/controller.js";
import { InAppChannel } from "./companion/in-app.js";
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
  // the periodic ticker).
  const backupCfg = resolveBackupConfig();
  if (backupCfg.enabled) await takeBackup({ reason: "boot", keep: backupCfg.keep });
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
    // reporting (stranded-worker guard; no-op for non-workers). `sessions` is assigned below but
    // this closure only runs at runtime — same forward-reference pattern as onExit→orchMcp.
    onBusy: (sessionId, busy) => { db.setBusy(sessionId, busy); if (!busy) sessions.notifyManagerOfIdleWorker(sessionId); },
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
      const until = rateLimitedUntil(detail.resetsAtSeconds, new Date(), rl);
      db.setRateLimitedUntil(sessionId, until, `usage limit — resumes ${until}`);
      db.armRateLimitDeadline(sessionId, rateLimitDeadline(detail.resetsAtSeconds, new Date(), rl));
      recordClaudeRateLimit(detail.resetsAtSeconds);
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
      if (exited && exited.role !== "run") db.archiveSession(sessionId);
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
      mcp.dispose(sessionId); orchMcp.dispose(sessionId); platformMcp.dispose(sessionId); userAuditMcp.dispose(sessionId); setupMcp.dispose(sessionId); runMcp.dispose(sessionId);
    },
  }, { busyStaleMs: timeouts.busyStaleMs }); // BOOT-BOUND: stuck-busy self-heal threshold from resolved platform config

  const control = new OrchestrationControl(); // §17a safety rails (pause/kill); in-memory by design
  // BOOT-BOUND: thread the resolved git-op / provision timeouts into the bounded-git + provision seams
  // at SessionService's call-sites (worktree create/remove/branch-delete/merge-detect during boot-reconcile).
  const sessions = new SessionService(db, pty, control, { gitOpMs: timeouts.gitOpMs, provisionMs: timeouts.provisionMs, runTimeoutMs: timeouts.runMs });
  // Self-host restart recovery: a manager's `daemon_restart` left an intent naming the sessions to
  // bring back. Read it BEFORE the reconcile so the WHOLE fleet's worktrees are PROTECTED from pass-B GC
  // (recoverStaleSessions just marked every prior-run session 'exited', which would otherwise prune a
  // worktree we need to resume into). protectedIdsFromIntent spans the entire captured fleet across all
  // projects (P1 17df54c5) and tolerates an OLD-format intent (degrades to the requester + its workers).
  // The actual resume happens after the server is listening (its ptys need the MCP endpoints up). null
  // on a normal boot.
  const restartIntent = readRestartIntent();
  const protectedSessionIds = restartIntent ? protectedIdsFromIntent(restartIntent) : new Set<string>();
  // Boot-time orchestration reconcile (#22 run-2 + audit M4): finish any merge whose bookkeeping was
  // interrupted (branch merged but task/worktree not reconciled) and GC orphaned worktrees from
  // crashed workers. Runs AFTER recoverStaleSessions (no live pty holds a worktree) — pure git + db.
  // Best-effort cleanup: it must NEVER gate startup, so any unexpected failure is warned and swallowed
  // (a deterministic throw here would otherwise crash-loop the boot, since merging self-restarts the
  // dev daemon — and that would also block usage-limit auto-resume).
  try {
    const reconciled = await sessions.reconcileOrchestrationOnBoot(protectedSessionIds);
    if (reconciled.mergesFinished || reconciled.mergesFailed || reconciled.staleMergesResolved || reconciled.worktreesPruned || reconciled.worktreesKept) {
      console.log(`[boot] orchestration reconcile: finished ${reconciled.mergesFinished} orphaned merge(s), ${reconciled.mergesFailed} failed (retry next boot), resolved ${reconciled.staleMergesResolved} branch-gone dangling merge(s), pruned ${reconciled.worktreesPruned} orphaned worktree(s), kept ${reconciled.worktreesKept} holding unmerged/uncommitted work`);
    }
  } catch (err) {
    console.warn(`[boot] orchestration reconcile failed (continuing boot): ${(err as Error).message}`);
  }
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
  // Loom Companion (Phase 1): a chat-native companion whose brain is a live `claude` PTY session, served
  // by the ChatGateway subsystem (registry of channel adapters + inbound routing + outbound deliverReply).
  // OFF by default — the gateway is only constructed when LOOM_COMPANION_BOT_TOKEN (+ the allowlisted chat
  // id + the bound session id) is set, so a normal daemon is byte-identical. Built here (so orchMcp can
  // route the agent's chat_reply through deliverReply); the long-poll adapters are started after `listen`
  // below. INBOUND submits a turn via the EXISTING pty.enqueueStdin primitive (busy-gating / composer-defer
  // / FIFO coalesce / rate-limit park all reused) as a 'system' source.
  // The effective CompanionConfig is now built from the DURABLE companion_config DB row (token decrypted
  // via the envelope helper), with LOOM_COMPANION_* env as the BOOTSTRAP/override: env, when set, seeds/
  // overrides the DB row (token encrypted) AND lays the app_meta home target if unset, BEFORE this resolve
  // returns — so env wins, a REST-configured companion with no env still boots, and no env + no enabled
  // row ⇒ null ⇒ every path below is byte-identical to an unconfigured daemon (default-OFF).
  const companionCfg = resolveCompanionConfig(db, process.env);
  // The mutable chat_reply gate the OrchestrationMcpRouter reads per MCP request. companionSessionId is
  // SEEDED from the boot config (so a configured companion's bound session gets chat_reply immediately) and
  // then FLIPPED live by the controller as the companion starts/stops (a REST enable/disable takes effect
  // with no restart). deliverReply routes THROUGH the controller so it always targets the CURRENT gateway
  // (stable across a token-change adapter rebuild — never a stale closure).
  const companionHooks: CompanionReplyHooks = {
    companionSessionId: companionCfg?.sessionId ?? null,
    deliverReply: (sid, text) => companionController.deliverReply(sid, text),
  };
  // The IN-APP channel (default companion transport): a STABLE transport hub, constructed ALWAYS (even when
  // the companion is OFF at boot) so the /ws/companion route + every built gateway share ONE client registry
  // that survives a gateway rebuild. Default-OFF byte-identical: with no in-app binding + no attached web
  // client it is inert (its adapter is registered but never hit; the WS route accepts but delivers nothing).
  const inAppChannel = new InAppChannel();
  // The hot-lifecycle controller (Companion Phase 3 backend): owns the live ChatGateway (Telegram long-poll)
  // + the proactive heartbeat, and drives BOTH from the human-only REST config writes with NO daemon
  // restart. Constructed ALWAYS — even when the companion is OFF at boot — so a REST enable can start it
  // live. Default-OFF stays byte-identical: with companionCfg null it builds no gateway, arms no heartbeat,
  // and leaves companionSessionId null (chat_reply never registers) — every path below is unchanged.
  const companionController = new CompanionController({
    db,
    submitTurn: (sid, text) => pty.enqueueStdin(sid, text, "system"),
    pty,
    hooks: companionHooks,
    env: process.env,
    inApp: inAppChannel,
  });

  // OrchestrationMcpRouter needs SessionService (worker_spawn/worker_stop), so it comes after. The
  // companion hooks gate chat_reply to the single bound session (additive; every other spawn unchanged).
  const orchMcp = new OrchestrationMcpRouter(db, sessions, companionHooks);
  // Platform MCP (Pillar C / P2) needs the registry (project/agent/profile/schedule + config) AND
  // SessionService (the cross-project session_spawn/session_stop lifecycle ops). P3 also threads the
  // BOOT-BOUND git-write timeouts so the Lead's elevated git tools (git_checkout/commit/push) bound a
  // git op EXACTLY like the human REST git routes (gateway/server.ts resolves the same numbers).
  const platformMcp = new PlatformMcpRouter(db, sessions, { gitLocalMs: timeouts.gitLocalMs, gitPushMs: timeouts.gitPushMs });
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
  // Run MCP (Agent Runs R2) — the ephemeral run's restricted submit_result surface. Needs the registry
  // (resolve session→run) AND SessionService (validate + record + teardown). Gets NO git/vault timeouts.
  const runMcp = new RunMcpRouter(db, sessions);

  // Account-wide Claude plan-usage poller — one shared cached fetch of the OAuth usage endpoint, served
  // read-only to Mission Control via GET /api/usage/limits. Created here so the gateway can read its
  // cache; started below (after listen). BOOT-BOUND cadence from the resolved platform config
  // (LOOM_USAGE_POLL_INTERVAL_MS env read + floor-clamped inside resolveConfig; default 60s).
  const usageStatus = new UsageStatusPoller({ intervalMs: watchers.usagePollMs });

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
  const updateCheck = new UpdateCheckWatcher({
    loomHome: LOOM_HOME,
    intervalMs: Number(process.env.LOOM_UPDATE_CHECK_INTERVAL_MS) || undefined,
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

  const app = await buildServer({ db, pty, sessions, mcp, orchMcp, platformMcp, auditMcp, userAuditMcp, setupMcp, runMcp, control, usageStatus, companion: companionController, inApp: inAppChannel, requestShutdown: () => gracefulShutdown?.("POST /internal/shutdown"), updateStatus: () => updateCheck.current(), beginSelfUpdate });
  await app.listen({ port: PORT, host: "127.0.0.1" }); // local-first: loopback only
  // eslint-disable-next-line no-console
  console.log(`Loom daemon v${loomVersion()} listening on http://127.0.0.1:${PORT}`);

  // Loom Companion: start the initial companion now that the server is up (chat_reply routes back through
  // this process). The controller builds+starts the Telegram long-poll, arms the proactive heartbeat if a
  // positive cadence is set, and flips the chat_reply gate on — a no-op when the companion is OFF at boot
  // (companionCfg null). From here a human-only REST config write reconciles this SAME live state with no
  // daemon restart (start/re-arm/restart/teardown), so this is the ONLY boot-time companion start.
  await companionController.startInitial(companionCfg);
  if (companionCfg) {
    // Boot-time warn: inbound is role-agnostic, but chat_reply only registers for manager|worker|assistant.
    // A binding to any OTHER role could "hear but not reply" — surface it rather than fail silently.
    const boundRole = db.getSession(companionCfg.sessionId)?.role ?? null;
    if (boundRole && boundRole !== "manager" && boundRole !== "worker" && boundRole !== "assistant") {
      console.warn(
        `[companion] WARNING: bound session ${companionCfg.sessionId.slice(0, 8)} has role '${boundRole}' — ` +
          "inbound will be delivered but chat_reply is NOT registered for this role (companion can HEAR but " +
          "not REPLY). Bind an assistant/manager/worker session.",
      );
    }
    console.log(`[boot] Loom Companion on (bound session ${companionCfg.sessionId.slice(0, 8)}, allowlisted chat ${companionCfg.allowedChatId})`);
    if (companionCfg.heartbeatIntervalMinutes > 0) {
      console.log(`[boot] Companion heartbeat on (every ${companionCfg.heartbeatIntervalMinutes}m, session ${companionCfg.sessionId.slice(0, 8)})`);
    } else {
      console.log("[boot] Companion heartbeat off (set LOOM_COMPANION_HEARTBEAT_INTERVAL_MINUTES to a positive value)");
    }
  } else {
    console.log("[boot] Loom Companion off (set LOOM_COMPANION_BOT_TOKEN + LOOM_COMPANION_CHAT_ID + LOOM_COMPANION_SESSION_ID)");
  }

  // Pillar B: the cron trigger layer. Boots a manager (interactive pty, never headless) on each
  // due schedule's tick. OPT-IN (autonomy earned gate-by-gate): only start when enabled via the
  // platform config OR the LOOM_SCHEDULER_ENABLED=1 env override. LOOM_SCHEDULER_INTERVAL_MS tunes
  // the tick cadence (default 60s) — tests use a short interval to avoid a 60s wait.
  const schedulerEnabled =
    process.env.LOOM_SCHEDULER_ENABLED === "1" || resolved.orchestration.schedulerEnabled;
  // BOOT-BOUND cadence from the resolved platform config (LOOM_SCHEDULER_INTERVAL_MS env read +
  // floor-clamped inside resolveConfig; default 60s).
  const intervalMs = watchers.schedulerMs;
  const maxConcurrentManagers = resolved.orchestration.maxConcurrentManagers;
  const scheduler = new Scheduler({ db, control, startManager: (agentId) => sessions.startManager(agentId), startAuditor: (agentId) => sessions.startAuditor(agentId), startWorkspaceAuditor: (agentId) => sessions.startWorkspaceAuditor(agentId), intervalMs, maxConcurrentManagers });
  if (schedulerEnabled) {
    scheduler.start();
    console.log(`[boot] scheduler enabled (tick ${intervalMs}ms)`);
  } else {
    console.log("[boot] scheduler disabled (set orchestration.schedulerEnabled or LOOM_SCHEDULER_ENABLED=1)");
  }

  // §19c-b usage-limit RESUME watcher — ALWAYS ON (recovery ≠ autonomy; a manually-started session
  // can hit the cap too), so it runs regardless of schedulerEnabled. LOOM_RATE_LIMIT_WATCH_INTERVAL_MS
  // tunes the tick for tests (default 60s).
  const watchIntervalMs = watchers.rateLimitWatchMs;
  const rateLimitWatcher = new RateLimitWatcher({ db, pty, intervalMs: watchIntervalMs });
  rateLimitWatcher.start();
  console.log(`[boot] usage-limit resume watcher on (tick ${watchIntervalMs}ms)`);

  // Account-wide plan-usage poller — start it now that the server is up (skips itself if there's no
  // credentials file). Read-only god-eye data for Mission Control; failures degrade to unavailable.
  usageStatus.start();
  console.log("[boot] plan-usage poller on (GET /api/usage/limits)");

  // Update-availability watcher — periodic, best-effort npm dist-tags check (packaged installs only;
  // a source daemon short-circuits with no network). Read-only via GET /api/update-status.
  updateCheck.start();
  console.log(`[boot] update-check watcher on (packaged=${isPackagedInstall()}, GET /api/update-status)`);

  // The self-scheduled wake-up ticker (always on; reconciles past-due wakes fire-once on start()).
  wakes.start();
  console.log(`[boot] wake-up ticker on (tick ${wakeIntervalMs}ms)`);

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
  // to a fresh successor (run /session-end → recycle_me). Ratio scales with the model. 0 disables.
  const recycleRatio = Number(process.env.LOOM_RECYCLE_CONTEXT_RATIO) || resolved.orchestration.recycleAtContextRatio;
  const ctxWatchMs = watchers.contextWatchMs;
  const contextWatcher = new ContextWatcher({ db, pty, ratio: recycleRatio, intervalMs: ctxWatchMs });
  contextWatcher.start();
  console.log(`[boot] context-recycle watcher on (ratio ${recycleRatio}, tick ${ctxWatchMs}ms)`);

  // Asleep-at-the-Wheel watcher — nudges a LIVE manager that has silently dropped its orchestration
  // loop (idle, no live workers, backlog open) to report why and resume. Per-project leash via
  // resolveConfig (idleNudgeMinutes; 0 disables); recycle takes precedence (shares recycleRatio).
  const idleWatchMs = watchers.idleWatchMs;
  const idleWatcher = new IdleWatcher({ db, pty, control, recycleRatio, intervalMs: idleWatchMs });
  idleWatcher.start();
  console.log(`[boot] idle-manager watcher on (tick ${idleWatchMs}ms)`);

  // Busy-worker stuck watchdog — the inverse of the idle-manager watcher: surfaces a LIVE worker stuck
  // `busy` past the per-project `stuckWorkerMinutes` window (no turn boundary → stale lastActivity) to
  // its OWNING MANAGER as a `worker_stuck` event + a nudge it can act on (re-nudge / recycle). Never a
  // hard kill. Shares the idle-watch cadence (sibling watchdog); 0 disables per project.
  const busyWorkerWatcher = new BusyWorkerWatcher({ db, pty, control, intervalMs: idleWatchMs });
  busyWorkerWatcher.start();
  console.log(`[boot] busy-worker stuck watchdog on (tick ${idleWatchMs}ms)`);

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
  const dbBackupWatcher = new DbBackupWatcher({
    enabled: backupCfg.enabled,
    intervalMinutes: backupCfg.intervalMinutes,
    keep: backupCfg.keep,
    intervalMs: Number(process.env.LOOM_BACKUP_INTERVAL_MS) || undefined,
  });
  dbBackupWatcher.start();
  console.log(
    backupCfg.enabled && backupCfg.intervalMinutes > 0
      ? `[boot] db-backup ticker on (every ${backupCfg.intervalMinutes}m, keep ${backupCfg.keep})`
      : `[boot] db-backup ticker off (${backupCfg.enabled ? "interval 0" : "disabled"})`,
  );

  // Vault auto-committer — start ONE VaultVersioner per UNIQUE governing repo root so agent doc rewrites
  // (the mandated rewrite-in-place doc-hygiene flow, done with the plain Write/Edit tool) accrue git
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
  } catch (err) {
    console.warn(`[boot] first-run setup auto-launch failed (continuing boot): ${(err as Error).message}`);
  }

  // The one graceful-teardown path — invoked by a SIGINT/SIGTERM signal AND by the loopback
  // POST /internal/shutdown control hook (the cross-platform `loom stop`, since Windows has no SIGTERM).
  gracefulShutdown = (reason: string) => {
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
    scheduler.stop(); rateLimitWatcher.stop(); usageStatus.stop(); updateCheck.stop(); wakes.stop(); clearInterval(reconcileTimer); clearInterval(snapshotTimer); contextWatcher.stop(); idleWatcher.stop(); busyWorkerWatcher.stop(); usageSampler.stop(); crashRecoveryWatcher.stop(); dbBackupWatcher.stop();
    console.log(`[shutdown] graceful stop (${reason})`);
    process.exit(0); // clean stop — NOT exit 75 (the supervisor's restart sentinel)
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => gracefulShutdown!(sig));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
