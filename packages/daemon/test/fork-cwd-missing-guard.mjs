import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 9f70112f: forkSession must refuse when the source session's cwd no longer exists on disk —
// mirroring resume()'s existing ghost-resume guard (sessionCwdMissing, sessions/service.ts). Without
// this, forking a merged/GC'd worker (whose worktree is gone but whose engine transcript survives
// under ~/.claude, keyed by cwd) spawns a doomed pty that dies the instant it tries to start in the
// now-missing cwd.
// DETERMINISTIC + CLAUDE-FREE, hermetic like fork-allow-baseline.mjs: an isolated LOOM_HOME + a
// SANDBOXED HOME (so engineTranscriptExists reads under the temp dir, never the real ~/.claude), a
// REAL Db + SessionService driven against a FAKE pty injected via PtyHost's createPty() seam.
//
// PROVES:
//   (a) forkSession REFUSES (throws, names cwd/worktree missing) when the source's cwd directory has
//       been removed from disk, even though its engine transcript still exists.
//   (b) that refusal is a NO-OP on the DB/pty: no new session row is inserted, and no pty is spawned.
//   (c) forkSession still SUCCEEDS (unaffected) when the source's cwd exists — the positive control
//       proving the guard discriminates on cwd presence, not just failing closed on everything.
//
// Run: 1) build (turbo builds shared first), 2) node test/fork-cwd-missing-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so engineTranscriptExists reads under
// the temp dir, never the real ~/.claude. Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-forkcwd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// --- two real temp git repos: one survives (positive control), one gets removed (the GC'd worktree) ---
const repoGone = path.join(os.tmpdir(), `loom-forkcwd-repo-gone-${Date.now()}-${process.pid}`);
const repoLive = path.join(os.tmpdir(), `loom-forkcwd-repo-live-${Date.now()}-${process.pid}`);
for (const repo of [repoGone, repoLive]) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# fork-cwd-missing-guard test\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=fcg@loom -c user.name=fcg");
}

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pForkCwd", name: "ForkCwd", repoPath: repoLive, vaultPath: repoLive, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agForkCwd", projectId: "pForkCwd", name: "Plain", startupPrompt: "P", position: 0, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { ...super.createPty(opts), pid: 1 }; }
}
const events = { onEngineSessionId(id, e) { db.setEngineSessionId(id, e); }, onBusy(id, b) { db.setBusy(id, b); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// Helper: seed a forkable IDLE source session — needs an engineSessionId + an on-disk transcript
// (under the sandboxed HOME, keyed by cwd) so forkSession's engineTranscriptExists guard passes
// regardless of whether `cwd` itself still exists on disk.
function seedSource(id, cwd) {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({ id, projectId: "pForkCwd", agentId: "agForkCwd", engineSessionId: engId, title: null, cwd, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: undefined });
  const tpath = engineTranscriptPath(cwd, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
}

try {
  // (a)+(b) source whose cwd is REMOVED after seeding — simulates a merged/GC'd worker worktree.
  seedSource("srcGone", repoGone);
  fs.rmSync(repoGone, { recursive: true, force: true });
  check("setup: repoGone directory is actually gone from disk", !fs.existsSync(repoGone));

  const sessionsBefore = db.listAllSessions().length;
  let threw = null;
  try {
    svc.forkSession("srcGone");
  } catch (e) {
    threw = e;
  }
  check("(a) forkSession THROWS when the source's cwd no longer exists on disk", threw instanceof Error);
  check("(a) the error names the missing cwd/worktree (not a generic/unrelated message)",
    /cwd|worktree/i.test(threw?.message ?? ""));
  check("(b) no new session row was inserted for the refused fork",
    db.listAllSessions().length === sessionsBefore);
  check("(b) no pty was spawned for the refused fork",
    !host.capture.some((o) => o.resumeId === "srcGone-eng-0000-0000-000000000000"));

  // (c) POSITIVE CONTROL: same shape, but cwd genuinely exists — fork must succeed unaffected.
  seedSource("srcLive", repoLive);
  const fLive = svc.forkSession("srcLive");
  check("(c) forkSession SUCCEEDS when the source's cwd exists (positive control — guard discriminates on cwd, not everything)",
    !!fLive?.id && fLive.processState === "live");
  check("(c) a pty WAS spawned for the live-cwd fork",
    host.capture.some((o) => o.resumeId === "srcLive-eng-0000-0000-000000000000"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repoGone, { recursive: true, force: true }); } catch { /* best-effort, already gone */ }
  try { fs.rmSync(repoLive, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — forkSession refuses a source whose cwd/worktree is gone (mirroring resume()'s ghost-resume guard), as a no-op, while an intact-cwd fork is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
