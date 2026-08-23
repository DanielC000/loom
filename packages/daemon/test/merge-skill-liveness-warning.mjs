import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SKILL-LIVENESS WARNING test (card 64a30c79) — a merge that lands a change under
// `packages/daemon/assets/skills/<name>/**` reaches ZERO agents at merge time: skills/inject.ts delivers
// a session's skills from the STORE (`<LOOM_HOME>/skills/<name>/SKILL.md`), never from `assets/` directly
// (see CLAUDE.md's "Caveat" section). It becomes live only at the next daemon restart (a pristine skill)
// or an explicit adopt (a customized skill, which a restart never advances). `confirmWorkerMerge` must
// surface that gap on its own return value (`skillWarning`) instead of silently reporting success.
//
// REAL git on temp repos, mirroring merge-gate-inert-diff.mjs's in-process style (SessionService driven
// directly, no live daemon, no claude). `LOOM_ASSET_SKILLS` (a store.ts test seam) points at a temp dir
// standing in for the daemon's own bundled `assets/skills/` — kept DELIBERATELY SEPARATE from the git
// repos under test, mirroring how a self-hosted daemon's `ASSET_SKILLS` is its own package dir, not the
// project repo it happens to be merging.
//
// Proves:
//   (A) NEGATIVE CONTROL — a merge that never touches assets/skills/** carries no `skillWarning` at all,
//       byte-identical to before this card (DoD-4).
//   (B) A skill name the live store has never seen (not yet seeded) reads PRISTINE — nothing to protect,
//       and it will be seeded fresh at the next restart either way.
//   (C) A PRISTINE bundled skill (store copy == shipped) — the warning must say "live at the next daemon
//       restart" (DoD-2), and must still be present (DoD-3: pristine is NEVER suppressed).
//   (D) A CUSTOMIZED bundled skill (store copy edited, diverges from its base) — the warning must say
//       "needs an explicit adopt" and that a restart will NOT advance it (DoD-2), read from the REAL
//       store `customized` flag, never guessed (this card exists partly because an earlier draft inferred
//       it instead).
//   (E) TWO skills touched by one merge — both must be named.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-skill-liveness-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mslw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// The store-side "bundled asset" stand-in — see file header. Must be set BEFORE skills/store.js is first
// imported (a module-load-time const), which happens transitively via sessions/service.js below.
const ASSET_SKILLS_DIR = path.join(os.tmpdir(), `loom-mslw-assets-${Date.now()}-${process.pid}`);
fs.mkdirSync(ASSET_SKILLS_DIR, { recursive: true });
process.env.LOOM_ASSET_SKILLS = ASSET_SKILLS_DIR;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mslw@loom -c user.name=mslw";
const now = new Date().toISOString();

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MSLW", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MSLW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mslw\n");
  execSync(`git init -q && git config user.email mslw@loom && git config user.name mslw && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `mslw-${label}-proj-${sfx}`, agentId: `mslw-${label}-agent-${sfx}`, taskId: `mslw-${label}-task-${sfx}`,
  mgrId: `mslw-${label}-mgr-${sfx}`, workerId: `mslw-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mslw-${label}-${sfx}`),
});

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

function writeSkillAssetFile(worktreePath, name, content) {
  const dir = path.join(worktreePath, "packages", "daemon", "assets", "skills", name);
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

const dbs = [];
const worktrees = [];
try {
  // ── (A) NEGATIVE CONTROL — a merge touching only src/ never sets skillWarning at all ────────────────
  {
    const A = mk("a");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "index.ts"), "export const x = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add index"`, { cwd: worktreePath });
    seed(db, A, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) merged:true", confirm.merged === true);
    check("(A) no skillWarning — this diff never touched assets/skills/**", confirm.skillWarning === undefined);
  }

  // ── (B) a skill name never seen by the store — reads PRISTINE (nothing to protect) ──────────────────
  {
    const B = mk("b");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    writeSkillAssetFile(worktreePath, "brand-new-skill", "# brand new\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add brand-new-skill"`, { cwd: worktreePath });
    seed(db, B, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) merged:true", confirm.merged === true);
    check("(B) skillWarning present, names the skill", typeof confirm.skillWarning === "string" && confirm.skillWarning.includes("brand-new-skill"));
    check("(B) not-yet-seeded reads pristine (next restart), not customized", /pristine/.test(confirm.skillWarning) && /restart/.test(confirm.skillWarning) && !/customized/.test(confirm.skillWarning));
  }

  // ── (C) a PRISTINE bundled skill (store copy == shipped) — "live at the next daemon restart" ────────
  {
    const C = mk("c");
    makeRepo(C);
    // Bundled asset side: the daemon's OWN shipped copy.
    mkdirp(path.join(ASSET_SKILLS_DIR, "pristine-skill"));
    fs.writeFileSync(path.join(ASSET_SKILLS_DIR, "pristine-skill", "SKILL.md"), "# pristine v1\n");
    // Store side: identical content — mine == shipped (no base file needed; store.ts treats a missing
    // base as == shipped, so mine == shipped == base ⇒ customized:false).
    mkdirp(path.join(process.env.LOOM_HOME, "skills", "pristine-skill"));
    fs.writeFileSync(path.join(process.env.LOOM_HOME, "skills", "pristine-skill", "SKILL.md"), "# pristine v1\n");

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    writeSkillAssetFile(worktreePath, "pristine-skill", "# pristine v2 (this merge's edit)\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: update pristine-skill"`, { cwd: worktreePath });
    seed(db, C, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) merged:true", confirm.merged === true);
    check("(C) skillWarning names pristine-skill", typeof confirm.skillWarning === "string" && confirm.skillWarning.includes("pristine-skill"));
    check("(C) reads pristine — live at the next daemon restart", /pristine-skill \(pristine — live at the next daemon restart\)/.test(confirm.skillWarning));
    check("(C) pristine is NEVER suppressed (DoD-3)", confirm.skillWarning !== undefined);
  }

  // ── (D) a CUSTOMIZED bundled skill (store copy diverges) — needs an explicit adopt ───────────────────
  {
    const D = mk("d");
    makeRepo(D);
    mkdirp(path.join(ASSET_SKILLS_DIR, "customized-skill"));
    fs.writeFileSync(path.join(ASSET_SKILLS_DIR, "customized-skill", "SKILL.md"), "# shipped v1\n");
    // Store side: the USER edited their copy — mine != shipped, no base recorded (base falls back to
    // shipped) ⇒ customized:true.
    mkdirp(path.join(process.env.LOOM_HOME, "skills", "customized-skill"));
    fs.writeFileSync(path.join(process.env.LOOM_HOME, "skills", "customized-skill", "SKILL.md"), "# shipped v1, plus a user edit\n");

    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    writeSkillAssetFile(worktreePath, "customized-skill", "# shipped v2 (this merge's edit)\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: update customized-skill"`, { cwd: worktreePath });
    seed(db, D, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) merged:true", confirm.merged === true);
    check("(D) skillWarning names customized-skill", typeof confirm.skillWarning === "string" && confirm.skillWarning.includes("customized-skill"));
    check("(D) reads customized — needs an explicit adopt, restart will NOT advance it", /customized-skill \(customized — needs an explicit adopt; a restart will NOT advance it\)/.test(confirm.skillWarning));
  }

  // ── (E) two skills touched by ONE merge — both must be named ─────────────────────────────────────────
  {
    const E = mk("e");
    makeRepo(E);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    writeSkillAssetFile(worktreePath, "skill-one", "# one\n");
    writeSkillAssetFile(worktreePath, "skill-two", "# two\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add two skills"`, { cwd: worktreePath });
    seed(db, E, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
    check("(E) merged:true", confirm.merged === true);
    check("(E) both skills named", confirm.skillWarning.includes("skill-one") && confirm.skillWarning.includes("skill-two"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(ASSET_SKILLS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge landing packages/daemon/assets/skills/<name>/** carries a skillWarning naming the skill(s) and the correct next step read from the live store's customized flag (pristine ⇒ next restart, customized ⇒ explicit adopt, never suppressed); a merge that never touches that prefix carries no skillWarning at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
