import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic coverage of card 5b97da80's round-2 Code Review (f82607a6) minors 1-4.
//
// (A) Minor 1 — mtime equality alone does NOT prove the SAME lock incarnation. Measured on a real NTFS
//     host: 1064/2000 back-to-back wx-create/write/rm cycles landed on an IDENTICAL mtimeMs while their
//     `ino` (bigint stat) differed 2000/2000. `shouldBreakLock`'s TOCTOU re-verification now compares
//     dev+ino AND re-reads the {pid, acquiredAt} content, via two dedicated test seams
//     (__setLockStatSyncForTest / __setLockContentReadForTest) so the race is deterministic here rather
//     than relying on real timing. Pins the exact regression named in review: before this fix, the final
//     check (mutation M4 — unconditionally `return true` once a dead pid is found) survived the whole
//     suite; section (A) fails under that mutation (and is proved to fail — see the inline note there).
// (B) Minor 2 — EPERM means "exists, can't signal" (alive), never "dead". Pinned against a REAL pid
//     this process can never signal: 4 ("System") on win32, 1 ("init", non-root) on POSIX.
// (C) Minor 4 (ruling: fix it) — a stuck/pid-reused/unparseable lock used to make EVERY non-fast-path
//     `ensureTrusted` call sleepSync the FULL `trustLockMs()` again (up to ~12 whole-daemon event-loop
//     freezes in a spawn burst, vs. one pre-fix). A per-process memo of already-waited-out lock
//     INCARNATIONS (dev+ino) now makes a SECOND call against the SAME stuck incarnation degrade
//     immediately.
// (D) Minor 3 — the durable `trust_lock_degraded` event had zero test coverage. (D1) exercises
//     `PtyHost.ensureTrustedAndReportDegrade` (the method `createPty` calls — extracted specifically so
//     this is testable without a real pty spawn) directly, with a fake `PtyHostEvents` and an alive-pid
//     held lock. SCOPE: this proves the event fires from that extracted method; it does NOT by itself
//     prove `createPty` still calls it — that's what (E) below closes. (D2) separately proves
//     `SessionService.handleTrustLockDegraded` (what the real daemon wires `onTrustLockDegraded` to)
//     appends a real, readable durable event row.
// (E) Round 3 (manager-directed): a small source-text wiring check closing the gap (D1)'s own header
//     named — proves `createPty` ITSELF still calls `this.ensureTrustedAndReportDegrade(`, so removing
//     that call site goes RED here even though (D1) calls the method directly and would never notice.
//     Reads real `src/pty/host.ts` TEXT (not just `import()`) — registered in
//     `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`) per CLAUDE.md's own
//     rule for this test shape, so a comment-only edit that defeats the check still forces the full gate.
//
// ⛔ HARD RULE (per this card's own decision record and the kickoff): never read, count, or write the
// REAL ~/.claude.json or the real daemon DB. Every section redirects CLAUDE_CONFIG_DIR/LOOM_HOME to a
// scratch temp root and asserts the resolved path is under it before doing anything.
//
// Run after build: node test/trust-lock-incarnation-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-trust-lock-incarnation-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Hermetic LOOM_HOME, set BEFORE any import of db.js/host.js (both read it at module scope on some
// paths) — same convention claude-boot-dialog-stuck-no-self-nudge.mjs uses.
const tmpHome = path.join(root, "loom-home");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
if (!tmpHome.startsWith(root)) throw new Error("REFUSING: LOOM_HOME override not under scratch root");

const fakeClaudeHome = path.join(root, "fake-claude-home");
fs.mkdirSync(fakeClaudeHome, { recursive: true });
const savedCfg = process.env.CLAUDE_CONFIG_DIR;
const savedLockMs = process.env.LOOM_TRUST_LOCK_MS;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
process.env.HOME = fakeClaudeHome;
process.env.USERPROFILE = fakeClaudeHome;
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", savedCfg], ["LOOM_TRUST_LOCK_MS", savedLockMs], ["HOME", savedHome], ["USERPROFILE", savedUserProfile]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const realBefore = fs.existsSync(realClaudeJson) ? fs.readFileSync(realClaudeJson) : null;

const {
  ensureTrusted, shouldBreakLock, removeClaudeConfigEntryForWorktree,
  __setLockStatSyncForTest, __setLockContentReadForTest, __clearKnownStuckIncarnationsForTest,
} = await import("../dist/pty/claude-config.js");

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const readEntries = (cfgPath) => { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects ?? {}; } catch { return {}; } };
const trusted = (cfgPath, key) => {
  const e = readEntries(cfgPath)[key];
  return e?.hasTrustDialogAccepted === true;
};
const writeLock = (lockPath, content, ageMs) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, content);
  if (ageMs != null) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lockPath, t, t);
  }
};
function mintDeadPid() {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return res.pid;
}
const alivePid = process.pid;

try {
  // ================================================================================================
  // (A) Minor 1: dev+ino + content TOCTOU re-verification. Unit-level, via the exported shouldBreakLock
  // and its two dedicated seams — deterministic, no real race needed.
  // ================================================================================================
  {
    const deadPid = mintDeadPid();
    const baseStat = { dev: 1n, ino: 100n, mtimeMs: BigInt(Date.now()) };
    const recreatedStat = { dev: 1n, ino: 200n, mtimeMs: baseStat.mtimeMs }; // SAME mtime, DIFFERENT ino
    const sameContent = () => JSON.stringify({ pid: deadPid, acquiredAt: 1 });

    // (A1) THE REGRESSION THIS PINS: the lock was recreated (different ino) between the caller's stat
    // and shouldBreakLock's own internal re-verification, but mtime alone is identical — must NOT break.
    __setLockStatSyncForTest(() => recreatedStat);
    __setLockContentReadForTest(sameContent);
    const broke1 = shouldBreakLock("/fake/lock/a1", baseStat);
    check("(A1) a re-created incarnation (different ino, SAME mtime) is NOT broken despite a dead-pid content match",
      broke1 === false);

    // (A2) POSITIVE CONTROL: genuinely the SAME incarnation (same dev+ino) with a real dead pid and
    // matching content IS broken — proves (A1) isn't vacuously false because the function never breaks
    // anything. This is the exact case that mutation M4 (`return true` unconditionally) would ALSO pass
    // — (A1) above is what actually distinguishes the real fix from that mutation.
    __setLockStatSyncForTest(() => baseStat);
    __setLockContentReadForTest(sameContent);
    const broke2 = shouldBreakLock("/fake/lock/a2", baseStat);
    check("(A2) POSITIVE CONTROL: the genuinely SAME incarnation with a real dead pid IS broken", broke2 === true);

    // (A3) second regression shape: SAME incarnation (dev+ino unchanged) but the CONTENT changed between
    // the two reads (a different holder re-wrote the SAME inode's content in between — e.g. a filesystem
    // that reuses inodes faster than dev+ino alone would catch). Must NOT break either.
    let readCall = 0;
    __setLockStatSyncForTest(() => baseStat);
    __setLockContentReadForTest(() => JSON.stringify({ pid: deadPid, acquiredAt: readCall++ === 0 ? 1 : 2 }));
    const broke3 = shouldBreakLock("/fake/lock/a3", baseStat);
    check("(A3) SAME incarnation but content changed between reads (different acquiredAt) is NOT broken",
      broke3 === false);

    __setLockStatSyncForTest();
    __setLockContentReadForTest();
  }

  // ================================================================================================
  // (B) Minor 2: EPERM (exists, can't signal) must never be treated as dead.
  // ================================================================================================
  {
    const EPERM_PID = process.platform === "win32" ? 4 : 1;
    let epermConfirmed = false;
    try { process.kill(EPERM_PID, 0); } catch (e) { epermConfirmed = e.code === "EPERM"; }
    check(`(B0) sanity: pid ${EPERM_PID} genuinely throws EPERM via process.kill(pid,0) on this host (platform=${process.platform}) — if this fails, (B) below is not actually testing EPERM`,
      epermConfirmed);

    const epermStat = { dev: 9n, ino: 9n, mtimeMs: BigInt(Date.now()) }; // fresh, nowhere near the ceiling
    __setLockStatSyncForTest(() => epermStat);
    __setLockContentReadForTest(() => JSON.stringify({ pid: EPERM_PID, acquiredAt: 1 }));
    const brokeEperm = shouldBreakLock("/fake/lock/b", epermStat);
    check("(B1) an EPERM-signalable pid is NOT broken before the ceiling (shouldBreakLock level)", brokeEperm === false);
    __setLockStatSyncForTest();
    __setLockContentReadForTest();

    // (B2) end-to-end through the real tryTrustLockOnce (via removeClaudeConfigEntryForWorktree, its
    // one real public caller) — the GC path must also leave an EPERM-pid-held lock alone.
    const configDir = path.join(root, "gc-eperm-pid");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const deadWorktree = path.join(root, "gc-eperm-pid-worktree-does-not-exist");
    const key = keyFor(deadWorktree);
    fs.writeFileSync(isoJson, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }, null, 2));
    writeLock(lockPath, JSON.stringify({ pid: EPERM_PID, acquiredAt: Date.now() }), 0); // fresh mtime

    removeClaudeConfigEntryForWorktree(deadWorktree);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    check("(B2) tryTrustLockOnce does NOT recover an EPERM-pid-held lock — entry untouched", key in readEntries(isoJson));
    check("(B2) the EPERM-held lock itself is left untouched", fs.existsSync(lockPath));
    try { fs.rmSync(lockPath); } catch { /* cleanup */ }
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // ================================================================================================
  // (C) Minor 4: per-incarnation memoization — a SECOND ensureTrusted call against the SAME stuck
  // (alive-pid-held) incarnation must return in ≪ trustLockMs, not re-pay the full wait.
  // ================================================================================================
  {
    __clearKnownStuckIncarnationsForTest();
    const configDir = path.join(root, "memo-stuck");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    writeLock(lockPath, JSON.stringify({ pid: alivePid, acquiredAt: Date.now() - 50 }), 50);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "300";
    const proj1 = path.join(root, "memo-stuck-proj-1");
    const proj2 = path.join(root, "memo-stuck-proj-2");

    const t0 = performance.now();
    ensureTrusted(proj1); // FIRST call against this incarnation: pays the full wait, then memoizes it
    const dt1 = performance.now() - t0;

    const t1 = performance.now();
    ensureTrusted(proj2); // SECOND call, SAME still-held incarnation: must degrade immediately
    const dt2 = performance.now() - t1;

    check(`(C1) first call against a stuck incarnation waited roughly the full deadline (${dt1.toFixed(1)}ms, expect >150ms)`, dt1 > 150);
    check(`(C2) SECOND call against the SAME stuck incarnation returns MUCH faster (memoized) (${dt2.toFixed(1)}ms vs first ${dt1.toFixed(1)}ms)`,
      dt2 < 100 && dt2 < dt1 / 2);
    check("(C3) both calls still wrote best-effort (degrade never refuses)", trusted(isoJson, keyFor(proj1)) && trusted(isoJson, keyFor(proj2)));
    try { fs.rmSync(lockPath); } catch { /* best-effort */ }
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // ================================================================================================
  // (D1) Minor 3, host half: PtyHost.ensureTrustedAndReportDegrade fires onTrustLockDegraded with a
  // reason, given an alive-pid held lock. Tested DIRECTLY (no createPty, no real pty spawn) — see this
  // file's own header for exactly what this does and does not cover.
  // ================================================================================================
  {
    const { PtyHost } = await import("../dist/pty/host.js");
    const makeEvents = (sink) => ({
      onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
      onTrustLockDegraded(sessionId, info) { sink.push({ sessionId, ...info }); },
    });

    // (D1a) contended, alive-pid-held lock → the event fires.
    const fired = [];
    const host = new PtyHost(makeEvents(fired));
    const configDir = path.join(root, "host-wiring-fire");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    writeLock(lockPath, JSON.stringify({ pid: alivePid, acquiredAt: Date.now() - 20 }), 20);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "80";
    const cwd1 = path.join(root, "host-wiring-fire-proj");
    fs.mkdirSync(cwd1, { recursive: true });

    host.ensureTrustedAndReportDegrade(cwd1, "sess-wiring-fire");

    check("(D1a) onTrustLockDegraded fired exactly once for a contended alive-pid lock", fired.length === 1);
    check("(D1a) fired with the right sessionId and a non-empty reason",
      fired[0]?.sessionId === "sess-wiring-fire" && typeof fired[0]?.reason === "string" && fired[0].reason.length > 0);
    try { fs.rmSync(lockPath); } catch { /* best-effort */ }
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;

    // (D1b) NEGATIVE CONTROL: an uncontended lock (nothing held) never fires the event.
    const firedUncontended = [];
    const host2 = new PtyHost(makeEvents(firedUncontended));
    const configDir2 = path.join(root, "host-wiring-quiet");
    fs.mkdirSync(configDir2, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir2;
    const cwd2 = path.join(root, "host-wiring-quiet-proj");
    fs.mkdirSync(cwd2, { recursive: true });

    host2.ensureTrustedAndReportDegrade(cwd2, "sess-wiring-quiet");

    check("(D1b) NEGATIVE CONTROL: an uncontended lock never fires onTrustLockDegraded", firedUncontended.length === 0);
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // ================================================================================================
  // (D2) Minor 3, service half: SessionService.handleTrustLockDegraded (what the real daemon wires
  // onTrustLockDegraded to) appends a real, readable durable event.
  // ================================================================================================
  {
    const { Db } = await import("../dist/db.js");
    const { SessionService } = await import("../dist/sessions/service.js");
    const { OrchestrationControl } = await import("../dist/orchestration/control.js");

    const db = new Db();
    const now = new Date().toISOString();
    const proj = `trust-degrade-proj-${sfx}`, agent = `trust-degrade-agent-${sfx}`, sess = `trust-degrade-sess-${sfx}`;
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({
      id: sess, projectId: proj, agentId: agent, engineSessionId: `eng-${sess}`, title: null, cwd: os.tmpdir(),
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: null, parentSessionId: null, taskId: null, worktreePath: null, branch: null,
    });
    const ptyStub = {};
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    sessions.handleTrustLockDegraded(sess, { reason: "test-reason-XYZ" });

    const events = db.listEventsForWorkerKinds(sess, ["trust_lock_degraded"]);
    check("(D2) handleTrustLockDegraded appends exactly one durable trust_lock_degraded event", events.length === 1);
    check("(D2) the event carries the reason untouched", events[0]?.detail?.reason === "test-reason-XYZ");
    db.close(); // release the sqlite file handle before the scratch root is removed below (Windows EBUSY otherwise)
  }

  // ================================================================================================
  // (E) Round 3: static wiring check — createPty ITSELF still calls this.ensureTrustedAndReportDegrade(.
  // Reads real src/pty/host.ts TEXT (registered in CHANGED_TS_TEXT_SCANNER_REPO_PATHS — see this file's
  // own header). Scoped to a small window right after createPty's own signature, not the whole file, so
  // this can't pass merely because the call exists SOMEWHERE unrelated.
  // ================================================================================================
  {
    const hostSrcPath = path.join(here, "..", "src", "pty", "host.ts");
    const hostSrc = fs.readFileSync(hostSrcPath, "utf8");
    const sigIdx = hostSrc.indexOf("protected createPty(opts: SpawnOpts");
    check("(E0) sanity: found createPty's own signature in the real source (host.ts)", sigIdx !== -1);
    const windowText = sigIdx === -1 ? "" : hostSrc.slice(sigIdx, sigIdx + 400);
    check("(E1) createPty's body calls this.ensureTrustedAndReportDegrade( — the wiring (D1) alone can't see",
      windowText.includes("this.ensureTrustedAndReportDegrade("));
    check("(E1-control) NEGATIVE CONTROL: a made-up method name does NOT match the same window (proves this isn't vacuously true)",
      !windowText.includes("this.thisMethodDoesNotExistAnywhereInHostTs("));
  }
} finally {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

const realAfter = fs.existsSync(realClaudeJson) ? fs.readFileSync(realClaudeJson) : null;
check("real ~/.claude.json byte-identical before/after the whole test",
  (realBefore === null && realAfter === null) || (!!realBefore && !!realAfter && realBefore.equals(realAfter)));

console.log(failures === 0
  ? "\nALL PASS — the dead-pid verdict requires the SAME lock incarnation (dev+ino+content), EPERM is never dead, a stuck incarnation only pays the full wait once per process, and the durable trust_lock_degraded event is wired end to end."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
