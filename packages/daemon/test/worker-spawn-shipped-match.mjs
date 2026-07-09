import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn WASTED-DISPATCH ADVISORY (Platform card 7b5944fc). DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like worker-spawn-task-gate.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL
// Db + SessionService driven against a FAKE pty (createPty() seam), a real temp git repo backing
// spawnWorker's createWorktree AND the shipped-match log read.
//
// THE GAP THIS CLOSES: a card whose fix already shipped (its title landed as a squash-merge commit
// subject on the mainline) can stay open on the board, so a manager dispatches a fresh worker against
// already-done work. FIX: a TASKED worker_spawn now checks whether the card's title — normalized the
// SAME way the squash-merge path coerces a card title into a commit subject (toConventionalSubject) —
// already appears verbatim as a commit subject within the project's recent mainline history. A match is
// surfaced as an ADVISORY `shippedMatch` field on the spawn result (naming the commit sha/subject/
// mainBranch) — it never blocks the spawn (the worker still starts) and never touches the card.
//
// Proves:
//   (1) a card whose (normalized) title already shipped as a mainline commit ⇒ the spawn result carries
//       `shippedMatch` naming the exact matching commit sha/subject/mainBranch — even though the card's
//       OWN title is bare prose (unconventional) and only matches once BOTH sides are normalized via the
//       same toConventionalSubject helper the merge path uses.
//   (2) a card whose title never shipped ⇒ `shippedMatch` is null — no false positive.
//   (3) a taskless spawn (no card at all) ⇒ `shippedMatch` is null regardless of mainline content — there
//       is no title to check, so the taskless path is entirely unaffected.
//   (4) the worker still SPAWNS (starts live, worktree on disk) in the matching case — advisory only,
//       never blocking.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-shipped-match.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wssm-${Date.now()}-${process.pid}`);
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
const { toConventionalSubject } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wssm@loom -c user.name=wssm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

// --- a real temp git repo so spawnWorker's createWorktree AND the shipped-match log read have real history ---
const repo = path.join(os.tmpdir(), `loom-wssm-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-shipped-match test\n");
execSync(`git init -q && git config user.email wssm@loom && git config user.name wssm && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

// A card title that is BARE PROSE (unconventional) — the merge path would coerce it to `chore: <title>`
// (toConventionalSubject's bare-prose fallback). Land a commit with EXACTLY that coerced subject, so a
// match only surfaces once both sides pass through the SAME normalization.
const shippedTitle = "Tidy up the frobnicator";
const shippedSubject = toConventionalSubject(shippedTitle);
check("(setup) sanity: bare-prose title coerces to a chore: subject", shippedSubject === `chore: ${shippedTitle}`);
fs.writeFileSync(path.join(repo, "frobnicator.txt"), "tidied\n");
execSync(`git add . && git ${GIT_ID} commit -q -m "${shippedSubject}"`, { cwd: repo });
const shippedSha = git(repo, "rev-parse HEAD");
const mainBranch = git(repo, "rev-parse --abbrev-ref HEAD");

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 6 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// A card whose title already shipped (bare prose, matches shippedSubject only once normalized).
const taskShipped = randomUUID();
db.insertTask({ id: taskShipped, projectId: "pP", title: shippedTitle, body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
// A card whose title never shipped.
const taskFresh = randomUUID();
db.insertTask({ id: taskFresh, projectId: "pP", title: "Something that never shipped and never will", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

const worktrees = [];
try {
  // ===================== (1)/(4) a shipped card's title matches ⇒ shippedMatch, AND the worker still spawns =====================
  const wShipped = await svc.spawnWorker("mgr1", { taskId: taskShipped, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wShipped.worktreePath);
  check("(1) a card whose normalized title already shipped: spawn result carries shippedMatch", !!wShipped.shippedMatch);
  check("(1) shippedMatch names the EXACT matching commit sha", wShipped.shippedMatch?.sha === shippedSha);
  check("(1) shippedMatch names the coerced (normalized) subject, not the bare card title", wShipped.shippedMatch?.subject === shippedSubject);
  check("(1) shippedMatch names the project's actual mainline branch (not a hardcoded 'main')", wShipped.shippedMatch?.mainBranch === mainBranch);
  check("(4) the worker still spawned live despite the advisory match (non-blocking)",
    wShipped.role === "worker" && wShipped.taskId === taskShipped && db.getSession(wShipped.id).processState === "live");
  check("(4) the worker's worktree exists on disk (spawn proceeded normally)", !!wShipped.worktreePath && fs.existsSync(wShipped.worktreePath));

  // ===================== (2) a fresh (never-shipped) card's title ⇒ no shippedMatch =====================
  const wFresh = await svc.spawnWorker("mgr1", { taskId: taskFresh, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wFresh.worktreePath);
  check("(2) a card whose title never shipped: shippedMatch is null (no false positive)", wFresh.shippedMatch === null);
  check("(2) the worker still spawned normally", wFresh.role === "worker" && wFresh.taskId === taskFresh);

  // ===================== (3) a taskless spawn is entirely unaffected =====================
  const wTaskless = await svc.spawnWorker("mgr1", { agentId: "agentDev", kickoffPrompt: "an ad-hoc spike, no card" });
  worktrees.push(wTaskless.worktreePath);
  check("(3) a taskless spawn (no card) has shippedMatch null regardless of mainline content", wTaskless.shippedMatch === null);
  check("(3) taskless spawn is otherwise unaffected (own worktree, taskId null)", wTaskless.taskId === null && !!wTaskless.worktreePath);
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
  ? "\n✅ ALL PASS — worker_spawn flags a wasted dispatch: a tasked spawn whose card title (once normalized via the SAME toConventionalSubject the squash-merge path uses) already matches a mainline commit subject surfaces an ADVISORY shippedMatch{sha,subject,mainBranch} without blocking the spawn; a non-matching or taskless spawn is unaffected — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
