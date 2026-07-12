import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge pathGlob `/`-boundary regression test (task 91d847db).
//
// THE BUG: `worker_merge({fullDiff:true, pathGlob:"*service.ts"})` returned `{filesChanged:0}` for a
// changeset that DID modify `packages/daemon/src/sessions/service.ts` — a bare glob `*` stays within
// one path segment, so `*service.ts` only ever matches a ROOT-level file and never a nested one. A
// zero-match result was silently indistinguishable from "nothing changed"; recurred >=3x in real
// orchestrator use (workaround: `files:["sessions/service.ts"]`, a substring match).
//
// FIX (git/worktrees.ts pathGlobToRegExp + diffBranch):
//   (a) a pathGlob matching 0 of N actually-changed files now returns a `hint` explaining the miss and
//       listing the changed files, instead of a silent empty result.
//   (b) a BARE leading `*` glob with no `/` anywhere (e.g. `*service.ts`) is auto-prefixed so it
//       crosses directory boundaries, matching nested paths too.
//   (c) a pathGlob that already contains `/` (or already starts with `**`) is left untouched.
//
// Proves, via SessionService.reviewWorkerMerge() directly (mirrors merge-diff-filter-spill.mjs style):
//   (A) BEFORE-shaped repro: `*service.ts` against a nested changed file now MATCHES (the fix).
//   (B) A pathGlob matching 0 of N changed files returns a `hint` naming the miss + the changed files.
//   (C) A pathGlob already containing `/` is unaffected — still scopes to that literal directory.
//   (D) A pathGlob already starting with `**` is unaffected — behavior unchanged.
//   (E) A `files` (non-pathGlob) 0-match is NOT given a `hint` (unambiguous substring miss; unchanged).
// Run: 1) build daemon (pnpm build), 2) node test/merge-path-glob-boundary.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mpgb-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mpgb@loom -c user.name=mpgb";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mpgb\n");
  execSync(`git init -q && git config user.email mpgb@loom && git config user.name mpgb && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function seed(db, p) {
  db.insertProject({ id: p.projId, name: "MPGB", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MPGB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const P = {
  projId: `mpgb-proj-${sfx}`, agentId: `mpgb-agent-${sfx}`, taskId: `mpgb-task-${sfx}`,
  mgrId: `mpgb-mgr-${sfx}`, workerId: `mpgb-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mpgb-repo-${sfx}`),
};

try {
  initRepo(P.repo);
  {
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    // A nested changed file matching the repro's real-world shape (packages/daemon/src/sessions/service.ts).
    fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "src", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "sessions", "service.ts"), "nested change\n");
    // An unrelated root-level file, so an already-`/`-scoped glob has something to correctly NOT match.
    fs.writeFileSync(path.join(worktreePath, "root.txt"), "root change\n");
    execSync(`git add . && git ${GIT_ID} commit -qm "nested + root change"`, { cwd: worktreePath });
    P.worktreePath = worktreePath; P.branch = branch;
  }
  seed(db, P);

  // ── (A) BEFORE-shaped repro: bare `*service.ts` now matches the NESTED file. ────────────────────
  const bare = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, pathGlob: "*service.ts" });
  check("(A) bare '*service.ts' matches the nested file (was 0 before the fix)", bare.filesChanged === 1 && bare.files.length === 1);
  check("(A) matched the right nested file", bare.files[0].file.replace(/\\/g, "/").endsWith("packages/daemon/src/sessions/service.ts"));
  check("(A) patch scoped to that file only", typeof bare.patch === "string" && bare.patch.includes("nested change") && !bare.patch.includes("root change"));
  check("(A) no hint on a real match", bare.hint === undefined);

  // ── (B) pathGlob matching 0 of N changed files returns a hint, not a silent empty result. ───────
  const miss = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, pathGlob: "*nonexistent-suffix-xyz.ts" });
  check("(B) 0-match pathGlob: filesChanged:0, no error", miss.filesChanged === 0 && miss.files.length === 0);
  check("(B) 0-match pathGlob: hint present and names the pattern", typeof miss.hint === "string" && miss.hint.includes("*nonexistent-suffix-xyz.ts"));
  check("(B) 0-match pathGlob: hint lists the actually-changed files", miss.hint.includes("service.ts") && miss.hint.includes("root.txt"));

  // ── (C) a pathGlob that already contains `/` is UNAFFECTED — scopes to that literal directory. ──
  const slashScoped = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, pathGlob: "packages/daemon/*.ts" });
  check("(C) '/'-containing glob without '**' does NOT cross into sessions/ (unchanged single-segment semantics)", slashScoped.filesChanged === 0);
  check("(C) '/'-containing 0-match still gets a hint", typeof slashScoped.hint === "string");

  const slashMatch = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, pathGlob: "packages/daemon/src/sessions/*.ts" });
  check("(C) '/'-containing glob matches when the directory is spelled out in full", slashMatch.filesChanged === 1 && slashMatch.files[0].file.replace(/\\/g, "/").endsWith("sessions/service.ts"));

  // ── (D) a pathGlob already starting with `**` is UNAFFECTED — behavior unchanged. ────────────────
  const doubleStar = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, pathGlob: "**/service.ts" });
  check("(D) '**/service.ts' matches the nested file (pre-existing behavior, unaffected by the fix)", doubleStar.filesChanged === 1 && doubleStar.files[0].file.replace(/\\/g, "/").endsWith("sessions/service.ts"));
  check("(D) no hint on a real match", doubleStar.hint === undefined);

  // ── (E) a `files` (substring) 0-match is NOT given a hint — unambiguous, unchanged behavior. ─────
  const filesMiss = await sessions.reviewWorkerMerge(P.mgrId, P.workerId, { includePatch: true, files: ["nonexistent-file.xyz"] });
  check("(E) files-filter 0-match: filesChanged:0, no error", filesMiss.filesChanged === 0 && filesMiss.files.length === 0 && filesMiss.patch === "");
  check("(E) files-filter 0-match: no hint (only pathGlob gets one)", filesMiss.hint === undefined);
} finally {
  db.close();
  try { if (P.worktreePath) fs.rmSync(P.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(P.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's pathGlob now crosses '/' for a bare leading '*' pattern, a 0-match " +
    "pathGlob surfaces a hint instead of a silent empty result, and already-'/'/'**' patterns are unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
