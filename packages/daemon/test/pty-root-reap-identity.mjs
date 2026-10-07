import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2897acc4 — hermetic unit coverage of `PtyHost.verifyRootDeadOrForceKill` and
// `commandLineMatchesSession`, the fix for two real incidents on an isolated throwaway daemon:
//   (S1) node-pty's own `onExit` fired `intended=false` for a pid whose real claude.exe was still alive —
//        the existing descendant-only reap (`reapOrphanedDescendants`) had nothing that checked the root
//        itself.
//   (S2) `stop(sessionId, "hard")` called `live.pty.kill()` and returned — fire-and-forget, with nothing
//        verifying the kill actually took effect; a recycled worker's process kept running for 3+ minutes.
//
// This file does NOT spawn any real process — it drives `verifyRootDeadOrForceKill` directly via two
// injectable seams (`probeRootSurvival`/`killRoot`, overridden per scenario) to simulate what a REAL OS
// enumeration would report, so every branch is deterministic and instant. Each scenario pairs a POSITIVE
// assertion with a NEGATIVE CONTROL proving the opposite input produces the opposite outcome — never just
// a single-direction check (worker doctrine's own standing verification posture).
//
// Separately (bottom of file): pure unit coverage of `commandLineMatchesSession` itself — the identity
// gate card `3216b7f9`'s pid-reuse hazard is folded into, per docs/decisions/2897acc4-*.md.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-root-reap-identity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-root-reap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const {
  PtyHost, commandLineMatchesSession,
  parsePsLstartTimestamp, parsePsPidLstartCommandLine, parseProcStatStarttimeTicks, parseProcUptimeSeconds,
  linuxStartTicksConsistent, computeOrphanSweepPlan, parseWin32SweepTicks, parseOrphanSweepLine,
  CREATION_TIME_SLACK_MS, ROOT_CREATION_MATCH_TOLERANCE_MS, ROOT_CREATION_CAPTURE_SLACK_MS,
  resolveVerifiedRootCreationTime, isHelperPidCollision,
} = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// A controllable PtyHost subclass: `probeRootSurvival`/`killRoot` are overridden per scenario below
// (never the real OS enumerator — see PtyHost's own doc on why that matters for a hermetic test), and
// `killRoot` calls are recorded so a scenario can assert whether a kill was actually ISSUED, not just
// what the method returned.
class ControllableHost extends PtyHost {
  nextChecks = []; // queue of RootSurvivalCheck-shaped results, consumed one per probeRootSurvival call
  killedPids = [];
  // CR round 5 (item 1a) — the critical, pre-fix finding: `verifyRootDeadOrForceKill` (round 4, item 4)
  // calls `this.sweepOrphanedDescendants(rootPid)` directly once it confirms a force-killed root is dead
  // — a DIFFERENT seam than `reapExitedDescendants` (no-op'd below), reached WITHOUT ever going through
  // it. Before this override, every scenario below that reaches `dead:true` after a kill (2, 7, 9) ran
  // the REAL OS-wide SIGKILL sweep against its own fabricated pid on every run of this file. Recording
  // (never no-op-and-forget) lets scenarios assert the wiring fired, not just that nothing crashed.
  sweptPids = [];
  // Round 6 (item 2) — the second argument (`rootCreationTime`) was dropped by this override entirely;
  // nothing pinned that `verifyRootDeadOrForceKill` actually threads the FIRST probe's own `creationTime`
  // through to the sweep call. Recorded in parallel with `sweptPids` (same index), default-parameter-
  // shaped like the real `sweepOrphanedDescendants(rootPid, rootCreationTime = null)` so a caller that
  // drops the argument reads back as `null` here too, not `undefined`.
  sweptCreationTimes = [];
  // CR round 3 (M8): queue exhaustion used to THROW ("test bug: ..."), aborting every LATER scenario in
  // this file the instant one implementation bug called probeRootSurvival more times than a scenario
  // queued for — a generic uncaught error, not the scenario's own NAMED assertion. Now it degrades to a
  // CLASSIFIED (fails-closed, never "confirmed dead") sentinel result instead, so execution continues and
  // the scenario's own named checks are what actually fail; `unexpectedProbeCalls` lets a scenario that
  // expects NO extra probe assert that directly, by name, rather than relying on an implicit throw.
  unexpectedProbeCalls = 0;
  // CR round 5 (item 2) — forces `verifyRootDeadOrForceKill`'s own platform-dependent guard-2 branch via
  // the real `resolveRootReapPlatform` seam, so this file's Linux-ticks scenarios run (and actually
  // exercise that branch's real code) on THIS host too, whatever `process.platform` really is — the
  // Windows gate has no Linux runner, so this is the only way to prove that branch at all here.
  platformOverride = null;
  createPty() { throw new Error("not used by this file"); }
  reapExitedDescendants() {} // unused here; this file calls verifyRootDeadOrForceKill directly
  sweepOrphanedDescendants(rootPid, rootCreationTime = null) { this.sweptPids.push(rootPid); this.sweptCreationTimes.push(rootCreationTime); }
  resolveRootReapPlatform() { return this.platformOverride ?? super.resolveRootReapPlatform(); }
  async probeRootSurvival(_rootPid, _sessionId) {
    if (this.nextChecks.length === 0) {
      this.unexpectedProbeCalls++;
      return { foundAlive: false, identityConfirmed: false, enumerationFailed: true, creationTime: null };
    }
    return this.nextChecks.shift();
  }
  async captureRootCreationRow(_pid) { return null; }
  killRoot(pid) { this.killedPids.push(pid); }
}

const survivedEvents = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {},
  onExit() {},
  onProcessSurvivedKill(sessionId, info) { survivedEvents.push({ sessionId, ...info }); },
};

try {
  // ===================================================================================================
  // Scenario 1: root already gone on the first check — the ORDINARY, expected case. No kill, no event.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    host.nextChecks = [{ foundAlive: false, identityConfirmed: false, enumerationFailed: false }];
    const result = await host.verifyRootDeadOrForceKill("sess-gone", 11111, "exit-reap");
    check("(1) root already gone: dead=true", result.dead === true);
    check("(1) root already gone: no kill issued", host.killedPids.length === 0);
    check("(1) root already gone: no process_survived_kill event fired (the happy path is silent)", survivedEvents.length === 0);
    check("(1) no unexpected extra probe call", host.unexpectedProbeCalls === 0);
  }

  // ===================================================================================================
  // Scenario 2 (the S1 fix): root found ALIVE and command-line IDENTITY CONFIRMED — kill, re-verify,
  // confirm dead. Paired with its own negative control (Scenario 3) proving identity mismatch suppresses
  // the kill entirely, not just "sometimes".
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    // Round 6 (item 2): the first probe's own creationTime is now a REAL, non-null sentinel (was absent
    // entirely before this round) so the sweep-wiring assertion below is non-vacuous — if a regression
    // ever drops the second argument, the default-parameterized override records `null` here instead,
    // which would NOT equal this sentinel.
    const FIRST_PROBE_CREATION_TIME = 918_273_645;
    host.nextChecks = [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: FIRST_PROBE_CREATION_TIME }, // first probe: alive, ours
      { foundAlive: false, identityConfirmed: false, enumerationFailed: false }, // re-check after kill: gone
    ];
    const result = await host.verifyRootDeadOrForceKill("sess-survivor", 22222, "exit-reap");
    check("(2) confirmed survivor: killRoot WAS called, with the exact pid", host.killedPids.length === 1 && host.killedPids[0] === 22222);
    check("(2) confirmed survivor: result reports forceKilled + dead after re-verify", result.forceKilled === true && result.dead === true);
    check("(2) confirmed survivor: a process_survived_kill event fired with reason 'force-killed'",
      survivedEvents.length === 1 && survivedEvents[0].sessionId === "sess-survivor" && survivedEvents[0].pid === 22222 &&
      survivedEvents[0].identityConfirmed === true && survivedEvents[0].reason === "force-killed" && survivedEvents[0].dead === true);
    // Round 5 (item 1a) — the post-kill sweepOrphanedDescendants seam (round 4, item 4) fired exactly
    // once, for THIS root pid, through the overridden (recording, never real) seam — never the real
    // OS-wide sweep this file's own ControllableHost exists to keep out.
    check("(2) sweepOrphanedDescendants was called exactly once, with the confirmed-dead root's pid", host.sweptPids.length === 1 && host.sweptPids[0] === 22222);
    // Round 6 (item 2) — nothing previously pinned the WIRING of the second argument itself: that
    // `verifyRootDeadOrForceKill` passes the FIRST probe's own `creationTime` through to the sweep call,
    // not merely that a sweep happened at all.
    check("(2) sweepOrphanedDescendants received the FIRST probe's own creationTime as its second argument", host.sweptCreationTimes[0] === FIRST_PROBE_CREATION_TIME);
  }

  // ===================================================================================================
  // Scenario 3 (negative control for 2, and the card 3216b7f9 pid-reuse hazard folded in): root found
  // ALIVE but identity NOT confirmed — a pid the OS has reused onto an unrelated process. MUST NOT kill.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    host.nextChecks = [{ foundAlive: true, identityConfirmed: false, enumerationFailed: false }];
    const result = await host.verifyRootDeadOrForceKill("sess-impostor", 33333, "hard-stop");
    check("(3, negative control) identity mismatch: killRoot was NEVER called", host.killedPids.length === 0);
    check("(3, negative control) identity mismatch: result is NOT dead, NOT forceKilled", result.dead === false && result.forceKilled === false);
    check("(3, negative control) identity mismatch: the event names the real reason, never silently dropped",
      survivedEvents.at(-1).sessionId === "sess-impostor" && survivedEvents.at(-1).identityConfirmed === false &&
      survivedEvents.at(-1).reason === "identity-unconfirmed" && survivedEvents.at(-1).forceKilled === false);
    // Only ONE probe was queued (no re-check expected) — a wrongly-reached re-verify would consume an
    // UNQUEUED probe, now classified and counted (round 3, M8) rather than aborting the file via a throw.
    check("(3) no unexpected extra probe call (would mean it wrongly tried to kill + re-verify)", host.unexpectedProbeCalls === 0);
    check("(3, negative control) identity mismatch: sweepOrphanedDescendants was NEVER called (never killed, so nothing to sweep)", host.sweptPids.length === 0);
  }

  // ===================================================================================================
  // Scenario 4 (the S2 fix, exact shape): root found alive + identity CONFIRMED, kill issued, but the
  // re-verify STILL finds it alive — the kill did not take effect. Must be reported as unconfirmed, not
  // silently swallowed as if it had worked.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    host.nextChecks = [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false },
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false }, // STILL alive after kill
    ];
    const result = await host.verifyRootDeadOrForceKill("sess-unkillable", 44444, "hard-stop");
    check("(4) kill issued but didn't take: killRoot WAS still called (we tried)", host.killedPids.length === 1);
    check("(4) kill issued but didn't take: result reports forceKilled=true but dead=false — never silently 'fixed'",
      result.forceKilled === true && result.dead === false);
    check("(4) kill issued but didn't take: event reason is 'force-kill-unconfirmed', dead:false",
      survivedEvents.at(-1).reason === "force-kill-unconfirmed" && survivedEvents.at(-1).dead === false);
    check("(4, negative control) kill didn't take: sweepOrphanedDescendants was NOT called — only a CONFIRMED dead root sweeps", host.sweptPids.length === 0);
  }

  // ===================================================================================================
  // Scenario 5 (negative control: a check that itself FAILS must never be read as "confirmed dead", and
  // must never trigger a kill either — fail closed in BOTH directions).
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    host.nextChecks = [{ foundAlive: false, identityConfirmed: false, enumerationFailed: true }];
    const result = await host.verifyRootDeadOrForceKill("sess-check-failed", 55555, "recycle-predecessor");
    check("(5, negative control) a failed check is NOT read as dead", result.dead === false);
    check("(5, negative control) a failed check NEVER triggers a kill", host.killedPids.length === 0);
    check("(5, negative control) result carries checkFailed:true so a caller can tell this apart from an identity mismatch",
      result.checkFailed === true);
    check("(5) the event still fires (observable, not silent) with reason 'check-failed'",
      survivedEvents.at(-1).reason === "check-failed" && survivedEvents.at(-1).identityConfirmed === false);
    check("(5) no unexpected extra probe call", host.unexpectedProbeCalls === 0);
  }

  // ===================================================================================================
  // Scenario 6 (CR round 2, MAJOR/LEAD RULING finding 3) — a RESPAWN that reuses the SAME pid Windows
  // just freed produces an IDENTICAL command-line match (same session id -> same settings/mcp-config
  // path), so identity confirmation alone is not enough: killing it would kill the new, legitimate
  // process. The live-entry-identity guard must refuse whenever the pid is CURRENTLY owned by a
  // DIFFERENT Live/CodexLive object than the one captured at the original kill instant.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    const SID = "sess-respawn";
    const PID = 66666;
    const originalOwner = { pid: PID, startedAt: Date.now() - 10_000 }; // captured at the ORIGINAL kill instant
    const respawnedOwner = { pid: PID, startedAt: Date.now(), alive: true }; // a DIFFERENT, ALIVE object — the resumed session
    host.live.set(SID, respawnedOwner); // the CURRENT live map entry for this session is the NEW object
    host.nextChecks = [{ foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null }];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", originalOwner);
    check("(6) a respawn reusing the same pid is NOT killed", host.killedPids.length === 0);
    check("(6) result reports identityConfirmed:true but dead:false, forceKilled:false", result.identityConfirmed === true && result.dead === false && result.forceKilled === false);
    check("(6) result's caller-facing identity is 'mismatch', never 'confirmed' (round 3, M5 — our TRACKED predecessor is gone even though the pid is alive)", result.identity === "mismatch");
    check("(6) event reason is 'pid-now-live-session'", survivedEvents.at(-1).reason === "pid-now-live-session");
    check("(6) no unexpected extra probe call (guard 1 must refuse before any re-check)", host.unexpectedProbeCalls === 0);
  }

  // ===================================================================================================
  // Scenario 7 (negative control for 6) — the SAME setup, but `expectedOwner` IS the object currently
  // owning the pid (no respawn happened) — the kill must proceed normally, proving the guard above
  // discriminates on OBJECT IDENTITY, not merely on "is there a live entry for this pid at all".
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    const SID = "sess-no-respawn";
    const PID = 66667;
    // Round 5 (item 2): `startTicksLinux`/`creationTicks` below are ALSO populated, consistently, so
    // this scenario passes identically whichever real `process.platform` the gate happens to run it on
    // — before this round, a real Linux runner would see owner.startTicksLinux===undefined and
    // check.creationTicks===undefined, both `== null`, and the Linux branch would wrongly refuse
    // ("unreadable") instead of proceeding to kill.
    const owner = { pid: PID, startedAt: Date.now() - 10_000, alive: true, startTicksLinux: 500_000 };
    host.live.set(SID, owner); // the SAME object is both the current owner and the expectedOwner
    host.nextChecks = [
      // creationTime deliberately NON-null (round 3, M3: a null here on win32 now refuses as
      // "creation-time-missing" — set it to owner.startedAt so this negative control still proceeds).
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: owner.startedAt, creationTicks: 500_000 },
      { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null },
    ];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(7, negative control) no respawn (same object): killRoot WAS called", host.killedPids.length === 1 && host.killedPids[0] === PID);
    check("(7, negative control) no respawn: result reports forceKilled + dead", result.forceKilled === true && result.dead === true);
    check("(7, negative control) result's caller-facing identity is 'confirmed'", result.identity === "confirmed");
    check("(7) sweepOrphanedDescendants was called exactly once, with the confirmed-dead root's pid", host.sweptPids.length === 1 && host.sweptPids[0] === PID);
    // Round 6 (item 2) — same wiring pin as scenario 2: the sweep's second argument must be the FIRST
    // probe's own creationTime (owner.startedAt here), not dropped/undefined.
    check("(7) sweepOrphanedDescendants received the FIRST probe's own creationTime as its second argument", host.sweptCreationTimes[0] === owner.startedAt);
  }

  // ===================================================================================================
  // Scenario 8 (CR round 2, finding 3's second signal) — the creation-time guard: no live-entry conflict
  // (findLiveEntryByPid finds nothing for this pid at all — e.g. the respawn hasn't even reached the live
  // map yet, or it's an unrelated process), but the OS reports this pid was created well AFTER our own
  // recorded spawn time. Must refuse, same as the live-entry guard.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    const SID = "sess-creation-time-mismatch";
    const PID = 66668;
    // Round 5 (item 2): `startTicksLinux`/`creationTicks` below mirror the ms-based mismatch (1000 vs
    // 50000 is `linuxStartTicksConsistent`'s own documented mismatch case) so this scenario is ALSO a
    // mismatch on a real Linux runner, not just win32/POSIX-ms — see scenario 7's own note.
    const owner = { pid: PID, startedAt: Date.now() - 100_000, startTicksLinux: 1000 }; // we spawned this pid 100s ago
    // no host.live.set(...) at all — findLiveEntryByPid finds nothing, so only the creation-time guard
    // can catch this.
    host.nextChecks = [{ foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: Date.now(), creationTicks: 50_000 }]; // "created" just now — long after our spawn
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(8) a pid created long after our own spawn is NOT killed", host.killedPids.length === 0);
    check("(8) event reason is 'creation-time-mismatch'", survivedEvents.at(-1).reason === "creation-time-mismatch");
    check("(8) result's caller-facing identity is 'mismatch', never 'confirmed' (round 3, M5)", result.identity === "mismatch");
    check("(8) no unexpected extra probe call", host.unexpectedProbeCalls === 0);
    check("(8, negative control) never killed: sweepOrphanedDescendants was NOT called", host.sweptPids.length === 0);
  }

  // ===================================================================================================
  // Scenario 9 (negative control for 8) — creationTime WITHIN slack of our own recorded spawn time, no
  // live-entry conflict: the kill must proceed normally.
  // ===================================================================================================
  {
    const host = new ControllableHost(events);
    const SID = "sess-creation-time-ok";
    const PID = 66669;
    // Round 5 (item 2): `startTicksLinux`/`creationTicks` below mirror the ms-based "within slack" case
    // (identical ticks — `linuxStartTicksConsistent`'s own documented consistent case) — see scenario
    // 7's own note on why both signals are populated.
    const spawnedAt = Date.now() - 100_000;
    const owner = { pid: PID, startedAt: spawnedAt, startTicksLinux: 1000 };
    host.nextChecks = [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: spawnedAt + 50, creationTicks: 1000 }, // well within slack
      { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null },
    ];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(9, negative control) creationTime within slack: killRoot WAS called", host.killedPids.length === 1 && host.killedPids[0] === PID);
    check("(9, negative control) creationTime within slack: result reports forceKilled + dead", result.forceKilled === true && result.dead === true);
    check("(9) sweepOrphanedDescendants was called exactly once, with the confirmed-dead root's pid", host.sweptPids.length === 1 && host.sweptPids[0] === PID);
    // Round 6 (item 2) — same wiring pin: the FIRST probe's own creationTime (spawnedAt + 50 here).
    check("(9) sweepOrphanedDescendants received the FIRST probe's own creationTime as its second argument", host.sweptCreationTimes[0] === spawnedAt + 50);
  }

  // ===================================================================================================
  // Scenario 10 (CR round 3, M3) — on win32, a CONFIRMED-identity row with NO creation time at all (an
  // enumeration anomaly — parseWin32CimDate only ever returns null on malformed/absent data) must refuse,
  // never silently skip straight to killing just because guard 2 had nothing to compare. This process is
  // win32 (see this file's own `process.platform` check below), so the real branch is exercised directly
  // — no platform-override seam needed.
  // ===================================================================================================
  if (process.platform === "win32") {
    const host = new ControllableHost(events);
    const SID = "sess-creation-time-missing-win32";
    const PID = 66670;
    const owner = { pid: PID, startedAt: Date.now() - 100_000 };
    // no host.live.set(...) — guard 1 finds nothing, so only the new M3 check can catch this.
    host.nextChecks = [{ foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null }];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(10) win32, identity confirmed, NO creation time: NOT killed", host.killedPids.length === 0);
    check("(10) result's caller-facing identity is 'unreadable' (unknown, not confirmed, not a mismatch)", result.identity === "unreadable");
    check("(10) event reason is 'creation-time-missing'", survivedEvents.at(-1).reason === "creation-time-missing");
    check("(10) no unexpected extra probe call", host.unexpectedProbeCalls === 0);
  } else {
    console.log("SKIP  (10) win32-only scenario (creation-time-missing fail-closed) — this host is not win32");
  }

  // ===================================================================================================
  // Scenarios 11-13 (CR round 5, item 2) — the Linux branch of guard 2, FORCED via `platformOverride`
  // regardless of this host's real `process.platform` (the Windows gate has no Linux runner, so this is
  // the only way these ever actually run here): ticks consistent -> kill, inconsistent -> mismatch,
  // missing -> unreadable. Mirrors scenarios 7/8/(new) rather than reusing their pids/sessionIds.
  // ===================================================================================================
  {
    // (11) ticks consistent -> kill proceeds, same shape as scenario 7/9's "within slack" but on the
    // FORCED Linux branch specifically (never falls through to the ms-based `else` arithmetic).
    const host = new ControllableHost(events);
    host.platformOverride = "linux";
    const SID = "sess-linux-ticks-ok";
    const PID = 66671;
    const owner = { pid: PID, startedAt: Date.now() - 100_000, startTicksLinux: 1000 };
    // Round 6 follow-up — the first probe's own creationTime is now a REAL, non-null sentinel (was `null`
    // before this fix) so the sweep-wiring assertion below is non-vacuous: the Linux branch's OWN identity
    // check reads `creationTicks`, never `creationTime`, so a `null` here was indistinguishable from a
    // regression that drops the sweep's second argument entirely (both read back as `null`). This sentinel
    // is threaded through to `sweepOrphanedDescendants` regardless of which signal guard 2 itself consulted.
    const LINUX_FIRST_PROBE_CREATION_TIME = 555_444_333;
    host.nextChecks = [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: LINUX_FIRST_PROBE_CREATION_TIME, creationTicks: 1000 },
      { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null },
    ];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(11) Linux branch, ticks consistent: killRoot WAS called", host.killedPids.length === 1 && host.killedPids[0] === PID);
    check("(11) Linux branch, ticks consistent: result reports forceKilled + dead, identity 'confirmed'", result.forceKilled === true && result.dead === true && result.identity === "confirmed");
    check("(11) sweepOrphanedDescendants was called exactly once, with the confirmed-dead root's pid", host.sweptPids.length === 1 && host.sweptPids[0] === PID);
    // Round 6 follow-up — same wiring pin as scenarios 2/7/9: the FIRST probe's own creationTime, pinned
    // to a non-null sentinel above so a dropped second argument (which defaults to `null`) turns this RED.
    check("(11) sweepOrphanedDescendants received the FIRST probe's own creationTime as its second argument", host.sweptCreationTimes[0] === LINUX_FIRST_PROBE_CREATION_TIME);
  }
  {
    // (12, negative control for 11) ticks INCONSISTENT (a genuine respawn, per linuxStartTicksConsistent's
    // own mismatch case) -> refused, identity 'mismatch', never killed.
    const host = new ControllableHost(events);
    host.platformOverride = "linux";
    const SID = "sess-linux-ticks-mismatch";
    const PID = 66672;
    const owner = { pid: PID, startedAt: Date.now() - 100_000, startTicksLinux: 1000 };
    host.nextChecks = [{ foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null, creationTicks: 50_000 }];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(12, negative control) Linux branch, ticks inconsistent: NOT killed", host.killedPids.length === 0);
    check("(12, negative control) Linux branch, ticks inconsistent: identity 'mismatch'", result.identity === "mismatch" && result.dead === false);
    check("(12, negative control) event reason is 'creation-time-mismatch'", survivedEvents.at(-1).reason === "creation-time-mismatch");
    check("(12, negative control) sweepOrphanedDescendants was NOT called", host.sweptPids.length === 0);
  }
  {
    // (13, negative control for 11/12) ticks MISSING on either side -> refused, identity 'unreadable'
    // (never falls through to the retired ms arithmetic, and never reads as a confirmed mismatch).
    const host = new ControllableHost(events);
    host.platformOverride = "linux";
    const SID = "sess-linux-ticks-missing";
    const PID = 66673;
    const owner = { pid: PID, startedAt: Date.now() - 100_000, startTicksLinux: null };
    host.nextChecks = [{ foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null, creationTicks: null }];
    const result = await host.verifyRootDeadOrForceKill(SID, PID, "hard-stop", owner);
    check("(13, negative control) Linux branch, ticks missing: NOT killed", host.killedPids.length === 0);
    check("(13, negative control) Linux branch, ticks missing: identity 'unreadable', never 'mismatch'", result.identity === "unreadable" && result.dead === false);
    check("(13, negative control) event reason is 'creation-time-missing'", survivedEvents.at(-1).reason === "creation-time-missing");
    check("(13, negative control) sweepOrphanedDescendants was NOT called", host.sweptPids.length === 0);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// =======================================================================================================
// Card 2897acc4 (CR round 2, MAJOR finding 1) — `checkRootSurvival` itself, driven through its real
// `enumerate` seam with a FAKE process list, never through a mocked `probeRootSurvival`/`RootSurvivalCheck`
// return (round 1's tests above mock the OUTCOME of the identity check; these drive the REAL
// `commandLineMatchesSession` call inside `checkRootSurvival` against a scripted process list, so a
// regression in the actual lookup/matching logic — not just in how a caller reacts to its result — would
// be caught here). Each of the five required shapes gets its own scenario; several are explicit negative
// controls proving the SAME fake list produces the OPPOSITE outcome for a different sessionId/pid.
// =======================================================================================================
{
  const { checkRootSurvival } = await import("../dist/pty/host.js");
  const { sessionSettingsPath } = await import("../dist/pty/claude-settings.js");
  const SID_OURS = "checkrootsurvival-ours";
  const SID_OTHER = "checkrootsurvival-other-session";
  const ROOT_PID = 77777;
  const CREATED_AT = 1700000000000;

  // Round 3 (M1): uses the REAL `sessionSettingsPath` — not a hand-guessed path shape — so this fixture
  // stays faithful to what a real `--settings <path>` argument actually looks like on this host.
  const fakeEnumerateFixed = async (_timeoutMs) => [
    { pid: ROOT_PID, exePath: null, cwd: null, commandLine: `claude.exe --settings "${sessionSettingsPath(SID_OURS)}"`, creationTime: CREATED_AT },
    { pid: 11111, exePath: null, cwd: null, commandLine: "some-unrelated-process.exe", creationTime: null },
  ];

  // (1a) the root row carries THIS session's own id -> identityConfirmed true, creationTime threaded through.
  {
    const result = await checkRootSurvival(ROOT_PID, SID_OURS, 1000, fakeEnumerateFixed);
    check("[checkRootSurvival] (1a) root row with OUR session id: foundAlive=true, identityConfirmed=true",
      result.foundAlive === true && result.identityConfirmed === true);
    check("[checkRootSurvival] (1a) the row's own creationTime is threaded through unchanged",
      result.creationTime === CREATED_AT);
  }

  // (1b, negative control for 1a) the SAME fake list, but asking about a DIFFERENT session's id -> the
  // root row's command line does NOT mention it, so identityConfirmed must flip to false.
  {
    const result = await checkRootSurvival(ROOT_PID, SID_OTHER, 1000, fakeEnumerateFixed);
    check("[checkRootSurvival] (1b, negative control) same row, ANOTHER session's id: foundAlive=true but identityConfirmed=false",
      result.foundAlive === true && result.identityConfirmed === false);
  }

  // (2) the root row's command line is explicitly null (unreadable) -> identityConfirmed false, never
  // treated as a match by default.
  {
    const fakeEnumerateNullCmd = async () => [{ pid: ROOT_PID, exePath: null, cwd: null, commandLine: null, creationTime: null }];
    const result = await checkRootSurvival(ROOT_PID, SID_OURS, 1000, fakeEnumerateNullCmd);
    check("[checkRootSurvival] (2) null command line: foundAlive=true, identityConfirmed=false (fails closed)",
      result.foundAlive === true && result.identityConfirmed === false);
  }

  // (3) no row at all for ROOT_PID in the fake list -> foundAlive false, identityConfirmed false,
  // enumerationFailed false (a clean, successful enumeration that simply didn't find it).
  {
    const fakeEnumerateNoRow = async () => [{ pid: 22222, exePath: null, cwd: null, commandLine: "something-else.exe", creationTime: null }];
    const result = await checkRootSurvival(ROOT_PID, SID_OURS, 1000, fakeEnumerateNoRow);
    check("[checkRootSurvival] (3) no matching row: foundAlive=false, identityConfirmed=false, enumerationFailed=false",
      result.foundAlive === false && result.identityConfirmed === false && result.enumerationFailed === false);
  }

  // (4, negative control for 3) the enumerator itself REJECTS -> enumerationFailed true, and this must
  // NEVER collapse to the same shape as (3)'s clean "not found" — a broken check is not a clean absence.
  {
    const fakeEnumerateRejects = async () => { throw new Error("[test] simulated enumeration failure"); };
    const result = await checkRootSurvival(ROOT_PID, SID_OURS, 1000, fakeEnumerateRejects);
    check("[checkRootSurvival] (4, negative control) enumerator rejects: enumerationFailed=true",
      result.enumerationFailed === true);
    check("[checkRootSurvival] (4) a failed check is NOT the same shape as a clean 'not found' — foundAlive is false either way, but enumerationFailed distinguishes them",
      result.foundAlive === false && result.enumerationFailed === true);
  }
}

// =======================================================================================================
// Pure unit coverage of commandLineMatchesSession itself — no PtyHost involved.
//
// Round 3 (M1, CR dd39877b): a BARE sessionId substring also matches every hook-relay CHILD process
// claude spawns for every lifecycle hook (`node hook-relay.mjs <sessionId> <port> <hookToken>`) — not a
// rare edge case, every real session's every hook invocation. The fix matches the session's own
// `--settings <path>` argument (claude) or `/mcp/<sessionId>`/`/mcp-run/<sessionId>` config-url argument
// (codex) instead — both root-only markers a hook-relay child, or an agent's own shell command, never
// carries. The old "matches a bare substring occurrence too" positive assertion is RETIRED (that was
// exactly the hazard) and replaced below with the hook-relay negative control that proves it closed.
// =======================================================================================================
{
  const { sessionSettingsPath } = await import("../dist/pty/claude-settings.js");
  const SID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  check("[commandLineMatchesSession] matches the session's own --settings <path> argument (claude root)",
    commandLineMatchesSession(`"C:\\claude.exe" --settings "${sessionSettingsPath(SID)}" --mcp-config "C:\\loom\\${SID}.mcp-config.json"`, SID) === true);
  check("[commandLineMatchesSession] matches the codex-style /mcp/<sessionId> config-url argument (codex root)",
    commandLineMatchesSession(`"C:\\codex.exe" -c mcp_servers.loom-tasks.url=http://127.0.0.1:4317/mcp/${SID}`, SID) === true);
  check("[commandLineMatchesSession] matches the codex-style /mcp-run/<sessionId> config-url argument (a 'run'-role codex root)",
    commandLineMatchesSession(`"C:\\codex.exe" -c mcp_servers.loom-run.url=http://127.0.0.1:4317/mcp-run/${SID}`, SID) === true);
  check("[commandLineMatchesSession, negative control, round 3 M1] a hook-relay CHILD's command line — the bare sessionId with NO --settings/--mcp-config/url marker — does NOT match",
    commandLineMatchesSession(`"C:\\node.exe" "C:\\loom\\hook-relay.mjs" ${SID} 4317 sometoken`, SID) === false);
  check("[commandLineMatchesSession, negative control] a DIFFERENT session's settings path does NOT match",
    commandLineMatchesSession(`"C:\\claude.exe" --settings "${sessionSettingsPath("00000000-0000-0000-0000-000000000000")}"`, SID) === false);
  check("[commandLineMatchesSession, negative control] a null command line (unreadable) fails CLOSED, never confirms",
    commandLineMatchesSession(null, SID) === false);
  check("[commandLineMatchesSession, negative control] an empty command line fails closed",
    commandLineMatchesSession("", SID) === false);
}

// =======================================================================================================
// Round 3 (M1) — pure unit coverage of the four new POSIX creationTime parsers. None of this needs a
// real Linux/macOS host: every function is pure text-in, value-out, exported exactly so this file can
// drive them with a scripted fixture instead of needing a real /proc or ps on this (Windows) dev host.
// =======================================================================================================
{
  // parseProcStatStarttimeTicks: a realistic /proc/<pid>/stat line. `comm` deliberately contains its OWN
  // parens ("my)proc(name") to prove the LAST ")" (not the first) is what's used to find the real
  // boundary — the standard /proc/stat defensive idiom. 20 fields after `comm)` (state..starttime);
  // starttime (field 22 overall, index 19 here) is 555555.
  const STAT_LINE = "9999 (my)proc(name) S 1 9999 9999 0 -1 4194304 55 0 0 0 1 2 0 0 20 0 1 0 555555 212992 1234 18446744073709551615 94823813889024";
  check("[parseProcStatStarttimeTicks] realistic line with a parenthesized, paren-containing comm: starttime=555555",
    parseProcStatStarttimeTicks(STAT_LINE) === 555555);
  check("[parseProcStatStarttimeTicks, negative control] no closing paren at all: null",
    parseProcStatStarttimeTicks("not a stat line") === null);
  check("[parseProcStatStarttimeTicks, negative control] closing paren present but too few fields after it: null",
    parseProcStatStarttimeTicks("1234 (sh) S 1") === null);

  // parseProcUptimeSeconds: /proc/uptime is "<uptime> <idletime>".
  check("[parseProcUptimeSeconds] realistic /proc/uptime content", parseProcUptimeSeconds("12345.67 54321.00\n") === 12345.67);
  check("[parseProcUptimeSeconds, negative control] malformed content: null", parseProcUptimeSeconds("not-a-number") === null);

  // parsePsLstartTimestamp: BSD/GNU `ps`'s ctime-style lstart string.
  const lstartMs = parsePsLstartTimestamp("Wed Oct  7 05:25:48 2026");
  check("[parsePsLstartTimestamp] a real lstart-shaped string parses to a finite epoch-ms", Number.isFinite(lstartMs) && lstartMs > 0);
  check("[parsePsLstartTimestamp, negative control] garbage text: null", parsePsLstartTimestamp("not a date at all") === null);
  check("[parsePsLstartTimestamp, negative control] empty string: null", parsePsLstartTimestamp("") === null);

  // parsePsPidLstartCommandLine: the full `ps -axwwo pid=,lstart=,command=` line shape.
  {
    const r = parsePsPidLstartCommandLine("  1234 Wed Oct  7 05:25:48 2026 /usr/bin/node /path/to/hook-relay.mjs abc 1234 tok");
    check("[parsePsPidLstartCommandLine] pid parsed", r?.pid === 1234);
    check("[parsePsPidLstartCommandLine] creationTime parsed from the lstart sub-field", Number.isFinite(r?.creationTime) && r.creationTime > 0);
    check("[parsePsPidLstartCommandLine] commandLine is everything AFTER the lstart sub-field, not before",
      r?.commandLine === "/usr/bin/node /path/to/hook-relay.mjs abc 1234 tok");
  }
  // (negative control, round 3's own fail-open discipline) an lstart sub-field that doesn't parse must
  // NEVER drop the row — it degrades to creationTime:null with the WHOLE remainder folded into commandLine.
  {
    const r = parsePsPidLstartCommandLine("5678 not-a-valid-lstart-format /bin/bash -c something");
    check("[parsePsPidLstartCommandLine, negative control] an unparseable lstart sub-field does NOT drop the row", r !== null && r?.pid === 5678);
    check("[parsePsPidLstartCommandLine, negative control] creationTime degrades to null (never dropped, never guessed)", r?.creationTime === null);
    check("[parsePsPidLstartCommandLine, negative control] the WHOLE remainder (incl. the unparsed lstart text) survives as commandLine",
      r?.commandLine === "not-a-valid-lstart-format /bin/bash -c something");
  }
  check("[parsePsPidLstartCommandLine, negative control] a line with no leading pid at all: null",
    parsePsPidLstartCommandLine("not a ps line") === null);
}

// =======================================================================================================
// Round 4 (item 2) — pure unit coverage of linuxStartTicksConsistent, the ticks-domain comparison that
// replaced guard 2's ms-epoch arithmetic on Linux. Pure text-free, number-in/bool-out, so this needs no
// real Linux host either. The whole POINT of this function is immunity to a wall-clock step — these
// cases exercise the comparison's own boundary, not any Date.now()-derived value.
// =======================================================================================================
{
  check("[linuxStartTicksConsistent] identical ticks (genuinely the same process) are consistent",
    linuxStartTicksConsistent(1000, 1000) === true);
  check("[linuxStartTicksConsistent] checkTicks EARLIER than spawnTicks (clock/enumeration jitter, not a respawn) is consistent",
    linuxStartTicksConsistent(1000, 900) === true);
  check("[linuxStartTicksConsistent] checkTicks exactly AT the slack boundary is still consistent",
    linuxStartTicksConsistent(1000, 1000 + Math.round((5_000 / 1000) * 100)) === true);
  check("[linuxStartTicksConsistent, negative control] checkTicks ONE tick past the slack boundary is a mismatch",
    linuxStartTicksConsistent(1000, 1000 + Math.round((5_000 / 1000) * 100) + 1) === false);
  check("[linuxStartTicksConsistent, negative control] checkTicks far past spawnTicks (a genuine respawn) is a mismatch",
    linuxStartTicksConsistent(1000, 50_000) === false);
  check("[linuxStartTicksConsistent] a custom, explicit slackTicks is honored over the default",
    linuxStartTicksConsistent(1000, 1050, 100) === true && linuxStartTicksConsistent(1000, 1050, 10) === false);
}

// =======================================================================================================
// Round 5 (item 3) — hermetic coverage of `computeOrphanSweepPlan`'s stale-pid guard (never a real
// process spawn: `reapOrphanedDescendants` itself isn't driven here, only the pure planner it delegates
// to, plus the two pure text parsers that feed it rows). The hazard this closes: the post-kill sweep is
// rooted at a pid Windows has JUST freed, but Windows never updates a surviving process's own reported
// parent pid — so an UNRELATED process whose stale parent-pid happens to equal that freed number must
// never be read as a genuine descendant and killed. A genuine child can never predate its own parent.
// =======================================================================================================
{
  // (a) THE FIX ITSELF: a stale-PPID child whose own creationTime predates rootCreationTime is dropped —
  // never killed, and never walked into (its own, genuinely unrelated child must not be swept either,
  // proving the walk doesn't descend through a rejected link).
  {
    const rows = [
      { pid: 100, ppid: 1, creationTime: 5_000 }, // the stale-PPID collision: created BEFORE the root
      { pid: 101, ppid: 100, creationTime: 6_000 }, // a genuine child of the UNRELATED pid 100, not of our root
    ];
    const { toKill, skippedStale } = computeOrphanSweepPlan(rows, /* rootPid */ 1, /* rootCreationTime */ 10_000);
    check("(a) a stale-PPID child predating the root is NOT in the kill list", !toKill.includes(100));
    check("(a) the stale child's own (genuinely unrelated) descendant is ALSO not walked/killed", !toKill.includes(101));
    check("(a) toKill is empty — nothing legitimate was found", toKill.length === 0);
    check("(a) skippedStale counts the one rejected row", skippedStale === 1);
  }

  // (b, negative control for a) the SAME shape, but the child's creationTime POSTDATES the root's own —
  // a genuine descendant — must be killed and walked into normally.
  {
    const rows = [
      { pid: 100, ppid: 1, creationTime: 15_000 }, // created AFTER the root — a real child
      { pid: 101, ppid: 100, creationTime: 16_000 }, // a real grandchild
    ];
    const { toKill, skippedStale } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(b, negative control) a genuine child (postdates the root) IS killed", toKill.includes(100));
    check("(b, negative control) its real grandchild is ALSO killed (the walk descends normally)", toKill.includes(101));
    check("(b, negative control) skippedStale is 0 — nothing was rejected", skippedStale === 0);
  }

  // (c) rootCreationTime UNKNOWN (null) — e.g. the pre-existing onExit-triggered sweep, which has no
  // probe result to draw one from — must NOT filter anything, preserving today's unconditional walk
  // exactly, even for a row whose own creationTime would otherwise look stale.
  {
    const rows = [{ pid: 100, ppid: 1, creationTime: 5_000 }];
    const { toKill, skippedStale } = computeOrphanSweepPlan(rows, 1, null);
    check("(c) rootCreationTime unknown: the child IS still killed (unchanged, today's behavior)", toKill.includes(100));
    check("(c) rootCreationTime unknown: nothing is counted as skipped-stale", skippedStale === 0);
  }

  // (d, negative control for a/c) the CHILD's own creationTime is unknown (null) — e.g. every POSIX row,
  // by design (see reapOrphanedDescendants's own doc) — even with rootCreationTime known, must NOT be
  // filtered: there is nothing to positively disprove its parentage with.
  {
    const rows = [{ pid: 100, ppid: 1, creationTime: null }];
    const { toKill, skippedStale } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(d, negative control) child creationTime unknown: still killed (unchanged)", toKill.includes(100));
    check("(d, negative control) nothing counted as skipped-stale", skippedStale === 0);
  }

  // (e) the pre-existing self-referential row guard (pid === ppid) survives the refactor into the pure
  // planner — a malformed row must never be treated as its own descendant/ancestor.
  {
    const rows = [{ pid: 1, ppid: 1, creationTime: null }, { pid: 100, ppid: 1, creationTime: 20_000 }];
    const { toKill } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(e) a self-referential row (pid===ppid) is ignored, not an infinite loop or a false kill", !toKill.includes(1) && toKill.includes(100));
  }

  // (f) Round 6 (item 3) — THE FIX ITSELF: a LIVE, non-self-referential row AT rootPid itself (the OS
  // has handed the just-freed root pid to an unrelated process) aborts the WHOLE walk — even a row that
  // would otherwise look like a perfectly genuine child is NOT killed, because the walk's own premise
  // (rootPid is dead) no longer holds.
  {
    const rows = [
      { pid: 1, ppid: 999, creationTime: 50_000 }, // rootPid itself, now LIVE and unrelated (pid reuse)
      { pid: 100, ppid: 1, creationTime: 60_000 }, // would otherwise look like a genuine child (postdates root)
    ];
    const { toKill, abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(f) a live row at the root pid itself is reported as an abort", abortedRootPidLive === true);
    check("(f) nothing is killed when aborted, even a row that would otherwise look genuine", toKill.length === 0);
  }

  // (g, negative control for f) no row at rootPid at all (the ordinary case — the root really is gone
  // from this fresh enumeration) — proceeds normally, never aborts.
  {
    const rows = [{ pid: 100, ppid: 1, creationTime: 60_000 }];
    const { toKill, abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(g, negative control) no live row at the root pid: not aborted", abortedRootPidLive === false);
    check("(g, negative control) the genuine child is still killed normally", toKill.includes(100));
  }

  // (h, negative control for f) a SELF-REFERENTIAL row at rootPid (pid === ppid — the pre-existing
  // malformed-row guard's own shape, test (e) above) must NOT trip the new abort — it is a data artifact,
  // never a genuine live process, and the walk must proceed exactly as test (e) already proves.
  {
    const rows = [{ pid: 1, ppid: 1, creationTime: null }, { pid: 100, ppid: 1, creationTime: 20_000 }];
    const { toKill, abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(h, negative control) a self-referential row at rootPid does NOT trigger the abort", abortedRootPidLive === false);
    check("(h, negative control) the genuine child is still killed", toKill.includes(100));
  }

  // ===================================================================================================
  // Card 87691385 — THE FAIL-SAFE FLIP: the round-6 abort used to fire on ANY live occupant of rootPid,
  // which misfires on 2897acc4's own headline case (node-pty's onExit fires false while the real root is
  // still alive) FAR more often than it catches genuine pid reuse. The fix makes the abort require
  // POSITIVE evidence the occupant IS our own surviving root (both creation times known and agreeing
  // EXACTLY, within `ROOT_CREATION_MATCH_TOLERANCE_MS` — CR 376c51de round 2, MAJOR: both sides come from
  // the SAME CIM query + conversion, so genuine agreement is exact, never the old 5s cross-source slack)
  // before it proceeds to walk; every other case — including "unknown" — still aborts, same as round 6
  // did unconditionally. So round 6's own tests (f/g/h above) must keep passing unchanged (verified: they
  // do), and only the "matching" case newly proceeds.
  // ===================================================================================================

  // (i) THE FIX ITSELF: a live row at rootPid whose own creationTime AGREES EXACTLY with rootCreationTime
  // is proven to be our own still-alive root — the walk proceeds and reaps its real children, exactly the
  // case round 6's unconditional abort used to wrongly suppress.
  {
    const rows = [
      { pid: 1, ppid: 999, creationTime: 10_000 }, // rootPid itself, still alive — OUR OWN root
      { pid: 100, ppid: 1, creationTime: 20_000 }, // a genuine child
    ];
    const { toKill, abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(i) a live root with a MATCHING creationTime is NOT aborted", abortedRootPidLive === false);
    check("(i) its genuine child IS killed (walks and reaps its own children)", toKill.includes(100));
  }

  // (i, at the tolerance boundary) exactly ROOT_CREATION_MATCH_TOLERANCE_MS apart — still within bounds
  // (inclusive `<=`), proving the rounding-only tolerance isn't itself off-by-one.
  {
    const rows = [{ pid: 1, ppid: 999, creationTime: 10_000 + ROOT_CREATION_MATCH_TOLERANCE_MS }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(i, tolerance boundary) exactly at the tolerance: NOT aborted", abortedRootPidLive === false);
  }

  // (i, negative control) one ms PAST the tolerance boundary — proves (i) isn't vacuously "always proceeds
  // now", and that the tolerance is genuinely tight (not the old 5s slack).
  {
    const rows = [{ pid: 1, ppid: 999, creationTime: 10_000 + ROOT_CREATION_MATCH_TOLERANCE_MS + 1 }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(i, negative control) one ms past the tolerance boundary: aborted", abortedRootPidLive === true);
  }

  // (j) a LATER occupant (postdates root + slack — genuine reuse) still aborts — unchanged from (f), pinned
  // again here under the new discriminating implementation so the two shapes aren't conflated.
  {
    const rows = [{ pid: 1, ppid: 999, creationTime: 50_000 }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(j) a later occupant (genuine reuse) still aborts", abortedRootPidLive === true);
  }

  // (j, CR 376c51de round 2) an occupant a FULL SECOND later — well within the OLD CREATION_TIME_SLACK_MS
  // (still used elsewhere, e.g. verifyRootDeadOrForceKill's own guard 2), which would have wrongly accepted
  // it as "ours" — must still abort under the new, tight ROOT_CREATION_MATCH_TOLERANCE_MS. This is the test
  // the manager's own round-2 ruling explicitly asked for.
  {
    const DELTA_MS = 1000;
    check("(j, root+1000ms) setup: 1000ms is well within the OLD cross-source slack (would have wrongly passed)", DELTA_MS < CREATION_TIME_SLACK_MS);
    const rows = [{ pid: 1, ppid: 999, creationTime: 10_000 + DELTA_MS }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, 10_000);
    check("(j, root+1000ms) an occupant 1000ms later aborts under the new tight tolerance", abortedRootPidLive === true);
  }

  // (k) rootCreationTime UNKNOWN (null) — e.g. a canned/shell entry, or a win32 arm that never resolved —
  // with the occupant's own creationTime known: cannot prove it's ours, so it ABORTS (the flip from round
  // 6, which aborted here too, but unconditionally rather than for a stated reason).
  {
    const rows = [{ pid: 1, ppid: 999, creationTime: 10_000 }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, null);
    check("(k) rootCreationTime unknown, occupant known: aborts (fail safe)", abortedRootPidLive === true);
  }

  // (l) POSIX SHAPE — neither side ever carries a creationTime at all (reapOrphanedDescendants's own
  // POSIX enumeration is `ps -eo pid,ppid`, no time column, by construction) — must still abort, so POSIX
  // keeps round 6's reuse protection with NO regression back to the pre-round-6 unconditional walk.
  {
    const rows = [{ pid: 1, ppid: 999, creationTime: null }];
    const { abortedRootPidLive } = computeOrphanSweepPlan(rows, 1, null);
    check("(l) POSIX shape (no creationTime data on either side): aborts (fail safe)", abortedRootPidLive === true);
  }
}

// =======================================================================================================
// Card 87691385 (CR 376c51de round 2, CRITICAL) — `resolveVerifiedRootCreationTime`: the positive-identity
// predicate that must pass before any captured row is trusted as the root's own creation time. Closes the
// capture-race: node-pty's conpty.cc frees the root's pid BEFORE JS observes the exit (windowsPtyAgent
// itself delays the exit event by >=1s), so an unverified capture running in that window could silently
// record a REUSED process's creation time instead — and the onExit sweep would then treat that reused
// process's own real children as "ours" and walk/kill them. Empirically verified first (this session, a
// real conpty spawn via node-pty): a genuine root's CIM-reported ppid IS the daemon's own process.pid, not
// an intermediary (conhost.exe/OpenConsole.exe) — the anchor this predicate's first check relies on.
// =======================================================================================================
{
  const EXPECTED_PPID = 4242; // this test's own fictional "daemon pid" anchor — never a real spawn here
  const STARTED_AT = 100_000;

  // (m) THE GENUINE ROOT — correct ppid, creationTime at/before startedAt (+ slack) — returns the value.
  {
    const row = { pid: 1, ppid: EXPECTED_PPID, creationTime: STARTED_AT - 10 };
    const result = resolveVerifiedRootCreationTime(row, EXPECTED_PPID, STARTED_AT);
    check("(m) the genuine root (correct ppid, creationTime before startedAt): returns the value", result === STARTED_AT - 10);
  }

  // (n) WRONG PPID — same creationTime as (m), but the row's ppid is NOT the expected daemon pid (the
  // capture race's own headline shape: the pid got reused by some other, unrelated process tree) — null.
  {
    const row = { pid: 1, ppid: EXPECTED_PPID + 1, creationTime: STARTED_AT - 10 };
    const result = resolveVerifiedRootCreationTime(row, EXPECTED_PPID, STARTED_AT);
    check("(n) wrong ppid (not the daemon's own pid): returns null", result === null);
  }

  // (o) A REUSED ROW — correct ppid is irrelevant here; a LATER creationTime (postdates startedAt by more
  // than slack) means whatever this row is, it cannot be the root we spawned BEFORE stamping startedAt — null.
  {
    const row = { pid: 1, ppid: EXPECTED_PPID, creationTime: STARTED_AT + ROOT_CREATION_CAPTURE_SLACK_MS + 1 };
    const result = resolveVerifiedRootCreationTime(row, EXPECTED_PPID, STARTED_AT);
    check("(o) a reused row (later creationTime, past slack): returns null", result === null);
  }

  // (o, boundary) exactly AT the capture slack boundary — still accepted (inclusive `<=`).
  {
    const row = { pid: 1, ppid: EXPECTED_PPID, creationTime: STARTED_AT + ROOT_CREATION_CAPTURE_SLACK_MS };
    const result = resolveVerifiedRootCreationTime(row, EXPECTED_PPID, STARTED_AT);
    check("(o, boundary) exactly at the capture slack boundary: still accepted", result === STARTED_AT + ROOT_CREATION_CAPTURE_SLACK_MS);
  }

  // (p, negative control) no row at all (enumeration found nothing, e.g. already dead) — null, never throws.
  check("(p, negative control) a null row: returns null", resolveVerifiedRootCreationTime(null, EXPECTED_PPID, STARTED_AT) === null);

  // (q, negative control) a row with unknown creationTime (e.g. a CIM read anomaly) — null, never a guess.
  {
    const row = { pid: 1, ppid: EXPECTED_PPID, creationTime: null };
    check("(q, negative control) row.creationTime unknown: returns null", resolveVerifiedRootCreationTime(row, EXPECTED_PPID, STARTED_AT) === null);
  }
}

// =======================================================================================================
// Card 87691385 (CR f89d9552 round 3, MINOR 3a) — `isHelperPidCollision`: the OS freed the target pid and
// handed it straight to OUR OWN diagnostic helper (the most reachable reuse shape — our own powershell.exe
// taking the just-freed pid) — a real collision can't be forced deterministically (we don't control what
// pid the OS assigns our helper), so this is tested as the pure predicate directly.
// =======================================================================================================
{
  check("[isHelperPidCollision] the helper WAS assigned the exact pid being queried: true", isHelperPidCollision(4242, 4242) === true);
  check("[isHelperPidCollision, negative control] a different helper pid: false", isHelperPidCollision(4243, 4242) === false);
}

// =======================================================================================================
// Card 87691385 — the onExit WIRING pin: `PtyHost.reapExitedDescendants` must thread `liveRef.creationTime`
// through to `sweepOrphanedDescendants`'s second argument, never drop it (which would silently widen every
// onExit sweep back to "rootCreationTime always unknown" — exactly the defect this card fixes). Drives the
// REAL `reapExitedDescendants` directly (not no-op'd, unlike `ControllableHost` above, which exists
// precisely so OTHER scenarios never reach it) — `probeRootSurvival` is overridden to resolve instantly, so
// the method's own fire-and-forget `verifyRootDeadOrForceKill` tail does no real OS work.
// =======================================================================================================
{
  class WiringHost extends PtyHost {
    sweptPids = [];
    sweptCreationTimes = [];
    createPty() { throw new Error("not used by this file"); }
    // pty-subclass-reap-seam-guard.mjs requires every bare `extends PtyHost` class to declare this seam —
    // a deliberate pass-through (not a no-op): sweepOrphanedDescendants/probeRootSurvival/killRoot below
    // are ALL overridden to safe stubs, so this still runs the REAL reapExitedDescendants body (the thing
    // under test) with no real OS enumeration/kill ever reachable from it.
    // This pass-through is safe ONLY because sweepOrphanedDescendants + probeRootSurvival (below) are stubbed.
    reapExitedDescendants(rootPid, sessionId, liveRef) { return super.reapExitedDescendants(rootPid, sessionId, liveRef); }
    sweepOrphanedDescendants(rootPid, rootCreationTime = null) { this.sweptPids.push(rootPid); this.sweptCreationTimes.push(rootCreationTime); }
    async probeRootSurvival() { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null }; }
    async captureRootCreationRow(_pid) { return null; }
    killRoot() { throw new Error("not used by this scenario"); }
  }
  const host = new WiringHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onProcessSurvivedKill() {} });
  const SENTINEL_CREATION_TIME = 777_666_555; // non-null, so a dropped argument (reads back null) is visibly wrong
  host.reapExitedDescendants(33333, "sess-wiring-pin", { creationTime: SENTINEL_CREATION_TIME, startedAt: Date.now() });
  check("(onExit wiring) sweepOrphanedDescendants was called exactly once, with the root's pid", host.sweptPids.length === 1 && host.sweptPids[0] === 33333);
  check("(onExit wiring) sweepOrphanedDescendants received liveRef.creationTime as its second argument", host.sweptCreationTimes[0] === SENTINEL_CREATION_TIME);
}

// =======================================================================================================
// Card 87691385 (CR f89d9552 round 3, MAJOR; CR f8d7c90a round 4) — `armWin32RootCreationTime`'s OWN
// wiring, through the REAL `spawn()`/`spawnCodex()` paths (not a direct unit call, unlike every scenario
// above) — the gap CR f89d9552 found: a mutation that bypasses `resolveVerifiedRootCreationTime` entirely
// (`live.creationTime = row?.creationTime ?? null`) left every PRIOR test in this file green, since none
// of them actually drove `spawn()` far enough to reach this code. (r)/(s)/(t) cover the CLAUDE path; (u)
// covers the CODEX dispatch (`spawn({harness:"codex"})`) — CR f8d7c90a's own round-4 finding: removing
// `this.armWin32RootCreationTime(live)` at the codex spawn call site left (r)/(s)/(t) alone green, since
// none of them ever drive that path. Win32-only (the whole mechanism is gated on `process.platform ===
// "win32"` and never reaches `captureRootCreationRow` elsewhere); a non-win32 host gets a WARN SKIP,
// matching `pty-root-reap-win32-ticks-real-spawn.mjs`'s own convention for this file's win32-only coverage.
// =======================================================================================================
if (process.platform === "win32") {
  class CaptureRowHost extends createSeamHost(PtyHost) {
    capturedPids = [];
    nextRow = null; // set BEFORE spawn() for each scenario — captureRootCreationRow runs synchronously during spawn()
    captureRootCreationRow(pid) {
      this.capturedPids.push(pid);
      // Store the SAME promise the real method awaits: external code that awaits this identical promise
      // object resolves strictly AFTER armWin32RootCreationTime's own .then() (attached first, during
      // spawn()) has already run — same promise, FIFO subscriber order — so the test never races the arm.
      this.lastCapturePromise = Promise.resolve(this.nextRow);
      return this.lastCapturePromise;
    }
    // (u) below needs spawn()'s codex dispatch to reach the REAL createCodexPty-adjacent spawnCodex path —
    // createSeamHost(PtyHost) only stubs the claude createPty seam, never codex's own. Mirrors
    // pty-root-reap-call-site-wiring.mjs's own makeFakeCodexPty shape (fixed pid range, onExit callback
    // actually tracked — onexit-discard-guard.mjs requires it, not just inert no-op dispose).
    createCodexPty(opts) {
      let onExitCb = null;
      const fake = {
        pid: 60000 + Math.floor(Math.random() * 10000),
        write() {}, onData() { return { dispose() {} }; },
        onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
        kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
        resize() {},
      };
      (this.codexFakes ??= new Map()).set(opts.sessionId, fake);
      return fake;
    }
  }
  const mkEvents = () => ({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onCodexBootStuck() {} });
  const spawnOpts = (sessionId) => ({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });

  // (r) a seam returning a WRONG-PPID row -> live.creationTime === null (rejected, never partially trusted).
  {
    const host = new CaptureRowHost(mkEvents());
    host.nextRow = { pid: 4242, ppid: process.pid + 1, creationTime: Date.now() - 60_000 };
    host.spawn(spawnOpts("sess-capture-wrong-ppid"));
    await host.lastCapturePromise;
    check("(r) through the real spawn path: a wrong-ppid row -> live.creationTime === null",
      host.captureLiveRef("sess-capture-wrong-ppid")?.creationTime === null);
  }

  // (s) a seam returning a row LATER than startedAt+slack -> live.creationTime === null.
  {
    const host = new CaptureRowHost(mkEvents());
    host.nextRow = { pid: 4242, ppid: process.pid, creationTime: Date.now() + 60_000 };
    host.spawn(spawnOpts("sess-capture-too-late"));
    await host.lastCapturePromise;
    check("(s) through the real spawn path: a row later than startedAt+slack -> live.creationTime === null",
      host.captureLiveRef("sess-capture-too-late")?.creationTime === null);
  }

  // (t) a GENUINE row (correct ppid, safely-in-the-past creationTime) -> stored, not discarded.
  {
    const host = new CaptureRowHost(mkEvents());
    const genuineCreationTime = Date.now() - 60_000;
    host.nextRow = { pid: 4242, ppid: process.pid, creationTime: genuineCreationTime };
    host.spawn(spawnOpts("sess-capture-genuine"));
    await host.lastCapturePromise;
    check("(t) through the real spawn path: a genuine row -> stored",
      host.captureLiveRef("sess-capture-genuine")?.creationTime === genuineCreationTime);
    check("(t) captureRootCreationRow was called with the real spawned pid (the fixture's own, 4242)",
      host.capturedPids.length === 1 && host.capturedPids[0] === 4242);
  }

  // (u) THE CODEX PATH — the SAME wiring, through `spawn()`'s codex dispatch (`harness: "codex"`), never
  // just the claude path (r)/(s)/(t) exercise. A genuine row -> stored. CR f8d7c90a's own round-4 finding:
  // `this.armWin32RootCreationTime(live)` was removed at the codex spawn call site and every test here
  // stayed green until this scenario was added.
  {
    const host = new CaptureRowHost(mkEvents());
    const genuineCreationTime = Date.now() - 60_000;
    host.nextRow = { pid: 4242, ppid: process.pid, creationTime: genuineCreationTime };
    host.spawn({ ...spawnOpts("sess-capture-codex-genuine"), role: "worker", harness: "codex", startupPrompt: undefined });
    const codexFake = host.codexFakes.get("sess-capture-codex-genuine");
    await host.lastCapturePromise;
    check("(u) through the real spawnCodex() path: a genuine row -> stored",
      host.captureLiveRef("sess-capture-codex-genuine")?.creationTime === genuineCreationTime);
    check("(u) captureRootCreationRow was called with the real codex-spawned pid", host.capturedPids.includes(codexFake.pid));
  }
} else {
  console.log("WARN  SKIP  armWin32RootCreationTime real-spawn-path wiring tests — win32-only; process.platform !== 'win32' here.");
}

// =======================================================================================================
// Round 5 (item 3) — the two pure text parsers `reapOrphanedDescendants`'s own row parsing delegates to.
// =======================================================================================================
{
  check("[parseWin32SweepTicks] the sentinel \"0\" (unreadable CreationDate) maps to null, never epoch-0 (1970)",
    parseWin32SweepTicks("0") === null);
  check("[parseWin32SweepTicks, negative control] a non-numeric string maps to null",
    parseWin32SweepTicks("not-a-number") === null);
  check("[parseWin32SweepTicks, negative control] a negative value maps to null",
    parseWin32SweepTicks("-5") === null);
  {
    // Round-trip: a known epoch-ms instant, converted to .NET ticks the SAME way the REAL PowerShell
    // one-liner reports them POST round-6-fix (`$_.CreationDate.ToUniversalTime().Ticks` —
    // WIN32_SWEEP_PS_COMMAND), parses back to the SAME epoch-ms.
    //
    // Round 6 (item 1), CORRECTION: this comment used to claim the SAME equivalence while the real
    // one-liner still read bare `.Ticks` (LOCAL-kind ticks) — true only on a UTC-offset-0 host. A
    // `[DateTime]` LOCAL-kind value's `.Ticks` and its `.ToUniversalTime().Ticks` differ by exactly the
    // host's UTC offset; `Date.UTC(...)` below is inherently a UTC instant, so this round-trip was only
    // ever faithful to the one-liner's form on a UTC host. Now that the production command itself calls
    // `.ToUniversalTime()` BEFORE reading `.Ticks`, this round-trip genuinely matches the real one-liner's
    // reported value on every host, not just a UTC-offset-0 one — see the win32-only real-spawn
    // equivalence test (pty-root-reap-win32-ticks-real-spawn.mjs) for the live cross-check this hermetic
    // round-trip can't itself provide (no real PowerShell here).
    const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000;
    const knownEpochMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const ticksStr = String(knownEpochMs * 10_000 + DOTNET_UNIX_EPOCH_TICKS);
    check("[parseWin32SweepTicks] round-trips a known .NET Ticks value back to the SAME epoch-ms",
      parseWin32SweepTicks(ticksStr) === knownEpochMs);
  }

  check("[parseOrphanSweepLine] a 2-column POSIX-shaped row (pid,ppid): creationTime null",
    (() => { const r = parseOrphanSweepLine("1234 1"); return r?.pid === 1234 && r?.ppid === 1 && r?.creationTime === null; })());
  check("[parseOrphanSweepLine] a comma-separated 2-column row (the win32-shaped separator) parses the same way",
    (() => { const r = parseOrphanSweepLine("1234,1"); return r?.pid === 1234 && r?.ppid === 1; })());
  check("[parseOrphanSweepLine] a 3-column win32-shaped row (pid,ppid,ticks): creationTime populated via parseWin32SweepTicks",
    (() => { const r = parseOrphanSweepLine("1234,1,0"); return r?.pid === 1234 && r?.ppid === 1 && r?.creationTime === null; })());
  check("[parseOrphanSweepLine, negative control] a non-matching line (no leading pid) is null",
    parseOrphanSweepLine("not a sweep line") === null);
  check("[parseOrphanSweepLine, negative control] an empty line is null",
    parseOrphanSweepLine("") === null);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — verifyRootDeadOrForceKill kills only an identity-confirmed survivor, never a bare pid match; a failed check or an identity mismatch never kills; commandLineMatchesSession fails closed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
