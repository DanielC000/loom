import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge files/pathGlob filter + oversized-patch spill test (task 59ed7c7d, auditor finding
// 8a942a95). REAL git on temp repos, NO daemon and NO claude — drives SessionService.reviewWorkerMerge()
// directly (mirrors merge-stranded-backstop.mjs / merge-review-diffstat.mjs's style).
//
// THE BUG IT GUARDS: `worker_merge fullDiff:true` on a big change overflowed the MCP tool-result cap
// ("74,658 characters across 1 line exceeds maximum"); the CLIENT'S OWN overflow-spill then wrote the
// escaped JSON text verbatim to a .txt — ONE giant line, so `Read` couldn't page it by offset/limit, and
// the manager's python-fallback slice crashed on Windows cp1252 vs the UTF-8 diff's box-drawing/Unicode
// chars. FIX: (1) Loom itself spills an oversized patch to a scratch file with REAL line breaks + explicit
// UTF-8 BEFORE that ever happens, and (2) an optional files/pathGlob filter lets a manager scope the diff
// to one file at a time instead of pulling the whole patch.
//
// Proves:
//   (A) NO FILTER, small patch  — response shape UNCHANGED from before this task (inline `patch`, no
//       patchFile/patchChars/filter noise) — the additive contract.
//   (B) files FILTER            — diffstat + patch scoped to the named file(s) only.
//   (C) pathGlob FILTER         — diffstat + patch scoped to files matching the glob only.
//   (D) OVERSIZED patch, no filter — spilled to a scratch file: real line breaks, UTF-8-readable
//       (including non-ASCII content), Read-pageable (many discrete lines), `patch` field ABSENT.
// Run: 1) build daemon (pnpm build), 2) node test/merge-diff-filter-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdfs-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { sessionScratchDir } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mdfs@loom -c user.name=mdfs";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mdfs\n");
  execSync(`git init -q && git config user.email mdfs@loom && git config user.name mdfs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function seed(db, p) {
  db.insertProject({ id: p.projId, name: "MDFS", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MDFS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// ── SMALL: a single small-file change — proves the no-filter path is byte-shape UNCHANGED. ─────────
const SMALL = {
  projId: `mdfs-s-proj-${sfx}`, agentId: `mdfs-s-agent-${sfx}`, taskId: `mdfs-s-task-${sfx}`,
  mgrId: `mdfs-s-mgr-${sfx}`, workerId: `mdfs-s-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mdfs-small-repo-${sfx}`),
};

// ── BIG: a multi-file change incl. one oversized file — proves filter + spill. ──────────────────────
const BIG = {
  projId: `mdfs-b-proj-${sfx}`, agentId: `mdfs-b-agent-${sfx}`, taskId: `mdfs-b-task-${sfx}`,
  mgrId: `mdfs-b-mgr-${sfx}`, workerId: `mdfs-b-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mdfs-big-repo-${sfx}`),
};

try {
  // --- SMALL setup ---
  initRepo(SMALL.repo);
  {
    const { worktreePath, branch } = await createWorktree(SMALL.repo, SMALL.projId, SMALL.taskId);
    fs.writeFileSync(path.join(worktreePath, "small.txt"), "small change\n");
    execSync(`git add . && git ${GIT_ID} commit -qm "small change"`, { cwd: worktreePath });
    SMALL.worktreePath = worktreePath; SMALL.branch = branch;
  }
  seed(db, SMALL);

  // --- BIG setup ---
  initRepo(BIG.repo);
  {
    const { worktreePath, branch } = await createWorktree(BIG.repo, BIG.projId, BIG.taskId);
    fs.writeFileSync(path.join(worktreePath, "small.txt"), "small change\n");
    // Non-ASCII/box-drawing content (mirrors the incident's UTF-8 diff chars) so the spill's UTF-8
    // encoding is genuinely exercised, not just ASCII padding.
    const NLINES = 3000;
    const bigBody = Array.from({ length: NLINES }, (_, n) => `line ${n} ⇒ padding ─── λ to make the patch large`).join("\n") + "\n";
    fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "src", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "mcp", "orchestration.ts"), bigBody);
    fs.mkdirSync(path.join(worktreePath, "packages", "web", "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "packages", "web", "src", "App.tsx"), "web change\n");
    execSync(`git add . && git ${GIT_ID} commit -qm "big + small + web change"`, { cwd: worktreePath });
    BIG.worktreePath = worktreePath; BIG.branch = branch;
  }
  seed(db, BIG);

  // ── (A) NO FILTER — response shape unchanged. ───────────────────────────────────────────────────
  const stat = await sessions.reviewWorkerMerge(SMALL.mgrId, SMALL.workerId, { includePatch: false });
  check("(A) no filter, no fullDiff: bounded diffstat, no patch field", stat.filesChanged === 1 && stat.patch === undefined && typeof stat.note === "string");
  check("(A) no filter: no filter-related fields leak in", stat.patchFile === undefined && stat.patchChars === undefined);

  const full = await sessions.reviewWorkerMerge(SMALL.mgrId, SMALL.workerId, { includePatch: true });
  check("(A) no filter, fullDiff: inline patch present (small enough to inline)", typeof full.patch === "string" && full.patch.includes("small change"));
  check("(A) no filter, fullDiff: no spill fields (well under the inline cap)", full.patchFile === undefined && full.patchChars === undefined && full.note === undefined);

  // ── (B) files FILTER — scopes diffstat + patch to the named file only. ──────────────────────────
  const byFiles = await sessions.reviewWorkerMerge(BIG.mgrId, BIG.workerId, { includePatch: true, files: ["App.tsx"] });
  check("(B) files filter: exactly one file matched", byFiles.filesChanged === 1 && byFiles.files.length === 1);
  check("(B) files filter: matched the right file", byFiles.files[0].file.endsWith("App.tsx"));
  check("(B) files filter: patch scoped to that file only", typeof byFiles.patch === "string" && byFiles.patch.includes("web change") && !byFiles.patch.includes("small change") && !byFiles.patch.includes("orchestration.ts"));

  // ── (C) pathGlob FILTER — scopes to a directory's files only. ───────────────────────────────────
  const byGlob = await sessions.reviewWorkerMerge(BIG.mgrId, BIG.workerId, { includePatch: true, pathGlob: "packages/web/**" });
  check("(C) pathGlob filter: exactly one file matched", byGlob.filesChanged === 1 && byGlob.files.length === 1);
  check("(C) pathGlob filter: matched the web file, not the big/small ones", byGlob.files[0].file.replace(/\\/g, "/").includes("packages/web/") && typeof byGlob.patch === "string" && byGlob.patch.includes("web change") && !byGlob.patch.includes("small change"));

  // A filter matching nothing returns an empty (not an error) result.
  const byNothing = await sessions.reviewWorkerMerge(BIG.mgrId, BIG.workerId, { includePatch: true, files: ["nonexistent-file.xyz"] });
  check("(filter, no match) filesChanged:0, no error", byNothing.filesChanged === 0 && byNothing.files.length === 0 && byNothing.patch === "");

  // ── (D) OVERSIZED patch, NO filter — spilled to a real, pageable, UTF-8 file. ───────────────────
  const bigFull = await sessions.reviewWorkerMerge(BIG.mgrId, BIG.workerId, { includePatch: true });
  check("(D) full diff: reports all 3 files", bigFull.filesChanged === 3 && bigFull.files.length === 3);
  check("(D) full diff: patch omitted (too large to inline)", bigFull.patch === undefined);
  check("(D) full diff: patchFile + patchChars + note present", typeof bigFull.patchFile === "string" && typeof bigFull.patchChars === "number" && bigFull.patchChars > 40_000 && typeof bigFull.note === "string");
  check("(D) full diff: patchFile lives under the MANAGER's session scratch dir", bigFull.patchFile.startsWith(sessionScratchDir(BIG.mgrId)));

  const spilled = fs.readFileSync(bigFull.patchFile, "utf8");
  check("(D) spill file: byte-identical (via UTF-8 decode) to the in-memory patch length", spilled.length === bigFull.patchChars);
  const lines = spilled.split("\n");
  check("(D) spill file: REAL line breaks — many discrete lines, not one giant line", lines.length > 100);
  check("(D) spill file: contains the big file's content", spilled.includes("orchestration.ts") && spilled.includes("line 2999"));
  check("(D) spill file: non-ASCII/box-drawing content survived the UTF-8 round-trip", spilled.includes("⇒") && spilled.includes("─") && spilled.includes("λ"));

  // Re-request the same (unfiltered) full diff — the spill path is deterministic (keyed by
  // workerSessionId), so it overwrites rather than accumulating a fresh file each call.
  const bigFull2 = await sessions.reviewWorkerMerge(BIG.mgrId, BIG.workerId, { includePatch: true });
  check("(D) repeat pull: same deterministic patchFile path (no garbage accumulation)", bigFull2.patchFile === bigFull.patchFile);
} finally {
  db.close();
  for (const p of [SMALL, BIG]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's files/pathGlob filter scopes the diffstat+patch to matching file(s) (no-filter path byte-shape unchanged), and an oversized patch is spilled to a UTF-8, real-newline, Read-pageable scratch file instead of an inline field that would overflow."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
