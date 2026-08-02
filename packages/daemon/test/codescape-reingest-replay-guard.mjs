import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card daaf7fc9 — boot-reconcile Pass A's own early-out (`if (alreadyFinalized && !worktreeOnDisk)
// continue`) is a CONJUNCTION: a worker that already has a recorded `merge_done` event but whose worktree
// is STILL ON DISK does NOT skip — it falls through to squash detection, finds the (genuinely, previously
// landed) sha via the `Loom-Worker-Branch` trailer, and calls `finalizeMerge` again. `finalizeMerge` used
// to fire `fireCodescapeReingest` UNCONDITIONALLY on every call, so this REPLAY refired a full-repo
// codescape reingest with ZERO new commits behind it — observed as a burst of near-simultaneous
// reingest-main calls on a real boot log. The fix guards the reingest call on `!hadPriorMergeDone`
// (computed inside finalizeMerge from the SAME worker's own event history), leaving the merge_done
// append itself untouched (card daaf7fc9's own LEAD, deliberately unaudited — see sessions/service.ts).
//
// REAL git on a temp repo (a real `Loom-Worker-Branch` squash trailer, exactly like production), a spy
// CodescapeSupervisor duck-type (network-free, mirrors codescape-lifecycle-hooks.mjs), NO claude and NO
// live daemon — drives `reconcileOrchestrationOnBoot()` directly. Proves:
//   (POSITIVE CONTROL) a worker landed via squash but NEVER YET finalized by Loom (no merge_done at all —
//       the crash-before-finalize shape boot-reconcile-batch-lookup.mjs's scenario (B) also covers) is
//       discovered for the FIRST time by Pass A and fires EXACTLY ONE reingest — proves the instrument
//       (fake.calls.reingest.length) can actually observe a reingest firing, so the replay case's zero
//       below isn't a vacuously-passing check.
//   (REPLAY — THE FIX) a worker that ALREADY has a recorded merge_done AND whose worktree is STILL ON
//       DISK (both conjuncts of the `:` fall-through, per the card's DoD) is reconciled again by Pass A —
//       finalizeMerge runs a second time (proven: the worktree is actually removed + branch actually
//       deleted on THIS call, so the fall-through branch was genuinely taken, not skipped) — but fires
//       ZERO additional reingests.
//   (IDEMPOTENT) a third reconcile over the now-fully-reconciled worker fires zero more reingests either
//       (the ordinary `alreadyFinalized && !worktreeOnDisk` early-out, unaffected by this card).
// Run: 1) build daemon, 2) node test/codescape-reingest-replay-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const tmpHome = path.join(os.tmpdir(), `loom-crrg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_DEV = "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LOOM_CODESCAPE_BIN = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=crrg@loom -c user.name=crrg";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git config user.email crrg@loom && git config user.name crrg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// ADDITIVE (both fixtures below share ONE homeDir/manifest, mirroring a real codescape install that has
// ingested more than one project) — a naive overwrite would silently drop an earlier call's entry.
function seedManifest(homeDir, repo, codescapeId) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : { version: 1, projects: [] };
  existing.projects.push({ id: codescapeId, name: "t", path: repo, lastIngested: now, graphPath: "/x/graph.json" });
  fs.writeFileSync(p, JSON.stringify(existing));
}

// A spy CodescapeSupervisor duck-type — only reingestMain is exercised by this test's paths (Pass A never
// registers/drops a worktree), but the other two are stubbed so the duck-type stays complete.
function makeFakeCodescape(homeDir) {
  const calls = { register: [], reingest: [], drop: [] };
  return {
    calls,
    getHomeDir: () => homeDir,
    resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir),
    async registerWorktree(projectId, info) { calls.register.push({ projectId, ...info }); return { ok: true }; },
    async reingestMain(projectId) { calls.reingest.push({ projectId }); return { ok: true }; },
    async dropWorktree(projectId, worktreeId) { calls.drop.push({ projectId, worktreeId }); return { ok: true }; },
  };
}

function seedProjectAndTask(db, p) {
  db.insertProject({ id: p.projId, name: "CRRG", repoPath: p.repo, vaultPath: p.repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "CRRG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

function seedWorker(db, p) {
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Lands a REAL squash commit carrying the deterministic `Loom-Worker-Branch:` trailer — the exact marker
// Pass A's findLandedSquashCommit(ViaMap) key on — without ever routing through Loom's own mergeBranch/
// finalizeMerge (mirrors boot-reconcile-batch-lookup.mjs's scenario (B): this is what "landed but Loom
// hasn't finalized it yet" looks like on disk).
async function landSquashWithoutFinalizing(p) {
  initRepo(p.repo, "# crrg\n");
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "CRRG-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: p.repo });
  p.worktreePath = worktreePath;
  p.branch = branch;
}

const homeDir = path.join(tmpHome, `crrg-home-${sfx}`);
const codescapeId = `crrg-codescape-${sfx}`;
const fake = makeFakeCodescape(homeDir);
const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl(), { codescape: fake });

const F = { projId: `crrg-fresh-proj-${sfx}`, agentId: `crrg-fresh-top-${sfx}`, taskId: `crrg-fresh-task-${sfx}`, mgrId: `crrg-fresh-mgr-${sfx}`, workerId: `crrg-fresh-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-crrg-fresh-${sfx}`) };
const R = { projId: `crrg-replay-proj-${sfx}`, agentId: `crrg-replay-top-${sfx}`, taskId: `crrg-replay-task-${sfx}`, mgrId: `crrg-replay-mgr-${sfx}`, workerId: `crrg-replay-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-crrg-replay-${sfx}`) };

try {
  seedManifest(homeDir, F.repo, `${codescapeId}-fresh`);
  seedManifest(homeDir, R.repo, `${codescapeId}-replay`);

  // ===================== POSITIVE CONTROL: a genuinely never-finalized landed worker fires ONE reingest =====================
  await landSquashWithoutFinalizing(F);
  seedProjectAndTask(db, F);
  seedWorker(db, F);
  check("(fresh-pre) landed HEAD carries the Loom-Worker-Branch trailer", git(F.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${F.branch}`));
  check("(fresh-pre) worktree present", fs.existsSync(F.worktreePath));
  check("(fresh-pre) no merge_done recorded yet", db.listEventsForWorker(F.workerId).filter((e) => e.kind === "merge_done").length === 0);

  const rFresh = await sessions.reconcileOrchestrationOnBoot();
  check("(fresh) Pass A finalized the never-before-seen landed worker", rFresh.mergesFinished === 1);
  check("(fresh) POSITIVE CONTROL: exactly ONE reingest fired for genuinely new work", fake.calls.reingest.length === 1);
  check("(fresh) merge_done recorded exactly once", db.listEventsForWorker(F.workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(fresh) worktree removed", !fs.existsSync(F.worktreePath));
  check("(fresh) branch deleted", git(F.repo, `branch --list ${F.branch}`) === "");

  // ===================== REPLAY: already-finalized (merge_done recorded) + worktree STILL ON DISK =====================
  // Both conjuncts of the card's own DoD line: `alreadyFinalized` true AND worktree on disk — the ONE
  // combination that does NOT hit Pass A's `alreadyFinalized && !worktreeOnDisk` early-out `continue`, so
  // it falls through to squash detection and re-invokes finalizeMerge.
  await landSquashWithoutFinalizing(R);
  seedProjectAndTask(db, R);
  seedWorker(db, R);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: R.mgrId, workerSessionId: R.workerId, taskId: R.taskId, kind: "merge_done", detail: { branch: R.branch } });
  check("(replay-pre) landed HEAD carries the Loom-Worker-Branch trailer", git(R.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${R.branch}`));
  check("(replay-pre) worktree STILL ON DISK (retained, not yet GC'd)", fs.existsSync(R.worktreePath));
  check("(replay-pre) merge_done ALREADY recorded (alreadyFinalized true)", db.listEventsForWorker(R.workerId).filter((e) => e.kind === "merge_done").length === 1);
  const reingestCountBeforeReplay = fake.calls.reingest.length;

  const rReplay = await sessions.reconcileOrchestrationOnBoot();
  check("(replay) Pass A took the fall-through branch, NOT the early-out (finalizeMerge genuinely ran again: worktree now removed)", !fs.existsSync(R.worktreePath));
  check("(replay) branch genuinely deleted this time (proves finalizeMerge really executed, not skipped)", git(R.repo, `branch --list ${R.branch}`) === "");
  check("(replay) Pass A counted this as a finished merge (the replay call, not a skip)", rReplay.mergesFinished === 1);
  check("(replay) THE FIX: ZERO additional reingests fired for a replay with zero new commits behind it", fake.calls.reingest.length === reingestCountBeforeReplay);
  // Card daaf7fc9's own LEAD (deliberately NOT fixed here, see sessions/service.ts's comment above the
  // appendEvent call): the merge_done append itself stays UNCONDITIONAL, so a replay DOES append a second
  // one — the `alreadyFinalized`/`hadPriorMergeDone` guards use `.some()`, so column-move/ship-state/
  // reingest all stay correct regardless. Asserting 2 here (not 1) is what keeps this test honest about
  // what the fix does and does NOT cover.
  check("(replay) merge_done IS duplicated by the replay (2 total) — the card's own documented LEAD, left unaudited on purpose",
    db.listEventsForWorker(R.workerId).filter((e) => e.kind === "merge_done").length === 2);

  // ===================== IDEMPOTENT: a third reconcile (now fully reconciled) fires zero more either =====================
  const reingestCountBeforeThird = fake.calls.reingest.length;
  const rThird = await sessions.reconcileOrchestrationOnBoot();
  check("(idempotent) third reconcile finishes 0 merges (ordinary alreadyFinalized && !worktreeOnDisk early-out)", rThird.mergesFinished === 0);
  check("(idempotent) zero further reingests", fake.calls.reingest.length === reingestCountBeforeThird);
} finally {
  db.close();
  for (const p of [F, R]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_BIN;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card daaf7fc9: boot-reconcile Pass A's `alreadyFinalized && !worktreeOnDisk` early-out is a conjunction, so an already-finalized merge whose worktree is still on disk falls through to squash detection and re-invokes finalizeMerge; a POSITIVE CONTROL proves the reingest-counting instrument can observe a real fire (exactly one, for genuinely new work), then the REPLAY case proves finalizeMerge genuinely re-ran (worktree/branch actually cleaned up on this call) while firing ZERO additional codescape reingests, and a third reconcile stays at zero (ordinary idempotent early-out, unaffected)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
