import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9b47cd1 SERVICE-LEVEL regression test (code-review finding): siblingWorkerSessionNames used to
// list the manager's LIVE workers to detect a naming collision, but spawnWorker/recycleWorker both
// insert + flip their OWN fresh row `live` BEFORE computing that collision set (the M5 ordering) — so the
// fresh row always saw ITSELF as a "collision" and got a spurious 4-char suffix on every spawn, and a
// recycled worker's suffix changed every recycle (a fresh disambiguator id each time), breaking the
// documented "keeps its name for free" invariant. The pure composeWorkerSessionName unit test (session-
// name.mjs) already asserted "no collision → base unchanged" — this is the gap that let the SERVICE fail
// to actually produce that no-collision case: it never caught that the service was handing the composer a
// sibling set that (wrongly) included the very session being named.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like respawn-profile-attrs.mjs: isolated LOOM_HOME
// + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam). A
// real temp git repo backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// Proves:
//   (1) a LONE worker (no other live sibling) gets the CLEAN base name — no spurious suffix;
//   (2) a RECYCLED worker keeps the EXACT SAME name across recycle (same agent + task ⇒ same base, and
//       the fix must not still see itself/the fresh row as a collision);
//   (3) a GENUINE collision — two live workers, same agent + a task title that slugs identically, under
//       the SAME manager — gets a suffix on the SECOND spawn, while the FIRST stays clean.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-session-name-collision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wsnc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeWorkerSessionName } = await import("../dist/pty/session-name.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wsnc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-session-name-collision test\n");
execSync(`git init -q && git add . && git -c user.email=wsnc@loom -c user.name=wsnc commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Raise the concurrency cap — this test keeps several workers live at once across its three scenarios,
// orthogonal to what's under test (collision detection, not the cap).
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 10 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 0, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const tLone = randomUUID();
db.insertTask({ id: tLone, projectId: "pP", title: "Fix the thing", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const tCollideA = randomUUID(), tCollideB = randomUUID();
// Two DIFFERENT tasks whose titles slug IDENTICALLY (same agent "Dev" on both) — the genuine collision case.
db.insertTask({ id: tCollideA, projectId: "pP", title: "Polish the dashboard", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: tCollideB, projectId: "pP", title: "Polish the dashboard!!", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

// Fake pty seam: capture every SpawnOpts; `kill()` fires onExit so recycle's wait-for-dead loop resolves
// immediately (recycleWorker hard-stops the old pty then waits on isAlive before reusing the worktree).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242,
      write() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
      resize() {},
    };
  }
  isAlive() { return false; } // this seam drives no real OS pty — recycle's wait-for-dead resolves instantly
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

const worktrees = [];
try {
  // ===================== (1) a LONE worker gets the clean base name — no spurious suffix =====================
  const wLone = await svc.spawnWorker("mgr1", { taskId: tLone, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wLone.worktreePath);
  const expectedLoneBase = composeWorkerSessionName("P", "Dev", "Fix the thing", wLone.id);
  const loneName = optsFor(wLone.id)?.sessionName;
  check("(1) a lone worker's spawn opts carry a sessionName at all", typeof loneName === "string" && loneName.length > 0);
  check(`(1) a lone worker gets the CLEAN base name (no self-collision suffix): got "${loneName}"`, loneName === expectedLoneBase);
  check("(1) sanity: the clean base name has no trailing 4-char id suffix beyond the task slug", !/-[0-9a-f]{4}$/i.test(loneName ?? "") || loneName === expectedLoneBase);

  // ===================== (2) a RECYCLED worker keeps the EXACT SAME name across recycle =====================
  const recycled = await svc.recycleWorker("mgr1", wLone.id, "handoff: continue from here");
  worktrees.push(recycled.worktreePath);
  const recycledName = optsFor(recycled.id)?.sessionName;
  check("(2) the recycled worker's spawn opts carry a sessionName", typeof recycledName === "string" && recycledName.length > 0);
  check(`(2) recycle KEEPS the same name (same agent+task ⇒ same base, no self-collision): "${loneName}" === "${recycledName}"`, recycledName === loneName);
  check("(2) recycle's name also matches the pure composer's expectation directly", recycledName === expectedLoneBase);

  // ===================== (3) a GENUINE collision — two live workers, same agent, same-slugging titles =====================
  const wA = await svc.spawnWorker("mgr1", { taskId: tCollideA, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wA.worktreePath);
  const wB = await svc.spawnWorker("mgr1", { taskId: tCollideB, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wB.worktreePath);
  const nameA = optsFor(wA.id)?.sessionName;
  const nameB = optsFor(wB.id)?.sessionName;
  const expectedCollisionBase = composeWorkerSessionName("P", "Dev", "Polish the dashboard", wA.id);
  check(`(3) the FIRST of two colliding workers stays CLEAN (no suffix): got "${nameA}"`, nameA === expectedCollisionBase);
  check(`(3) the SECOND of two colliding workers gets a DISTINCT, SUFFIXED name: got "${nameB}"`, typeof nameB === "string" && nameB !== nameA && nameB.startsWith(expectedCollisionBase + "-"));
  check("(3) the second name's suffix is a 4-char lowercase disambiguator", /^-[0-9a-z]{1,4}$/.test((nameB ?? "").slice(expectedCollisionBase.length)));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a lone worker gets the clean base session name (no self-collision suffix), a recycled worker keeps the exact same name across recycle, and a genuine same-agent/same-slugging-title collision suffixes only the second spawn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
