import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 274ff336: `git log` on a commitless repo (straight out of `git init` — exactly the state
// `project_init` leaves a brand-new project in) must NOT 500. All three git-log routes share the
// SAME layer (`GitReader.log()` in git/reader.ts) — primary (`/api/projects/:id/git/log`), reference-repo
// (`/api/projects/:id/git/reference-repos/:index/log`), and registered-repo
// (`/api/projects/:id/git/repos/:index/log`) — so this proves the fix at that shared layer covers all
// three, not just one with its siblings left 500ing (the recurring one-path/sibling-path bug shape named
// in the card).
//
// Also proves the OTHER direction: a genuine git failure (a repo path that isn't a git repo at all, so
// `git log` fails for a reason that has NOTHING to do with "no commits yet") still surfaces as an error —
// the fix must distinguish the specific commitless-repo signature, not blanket-swallow every git error.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on reference-repos-git-log.mjs (Db + buildServer via
// app.inject) — drives a REAL `git init`'d fixture repo (not a mock: a mock can't reach the actual
// commitless git-error signature this bug is about).
//
// Run: 1) build (turbo builds shared first), 2) node test/git-log-commitless-repo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-gitlog-commitless-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45323";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// --- Real temp repos: a `git init`'d-but-EMPTY repo (zero commits — the exact state project_init leaves
// a brand-new project in), a repo WITH a commit (control, proves the fix doesn't blanket-empty everything),
// and a real directory that is NOT a git repo at all (proves a genuine git failure still errors). ---
const commitlessRepo = path.join(os.tmpdir(), `loom-gitlog-commitless-empty-${Date.now()}-${process.pid}`);
fs.mkdirSync(commitlessRepo, { recursive: true });
execSync("git init -q", { cwd: commitlessRepo });

const committedRepo = path.join(os.tmpdir(), `loom-gitlog-commitless-committed-${Date.now()}-${process.pid}`);
fs.mkdirSync(committedRepo, { recursive: true });
fs.writeFileSync(path.join(committedRepo, "README.md"), "# committed\n");
execSync('git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m "real commit"', { cwd: committedRepo });

const notARepo = path.join(os.tmpdir(), `loom-gitlog-commitless-notarepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(notARepo, { recursive: true });
fs.writeFileSync(path.join(notARepo, "file.txt"), "not a repo\n");

const now = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, "gitlog.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  try {
    // A project whose PRIMARY repo is commitless, with a commitless registered repo and a commitless
    // reference repo too, so all three routes are exercised against the exact same failure signature.
    db.insertProject({
      id: "pCommitless", name: "Commitless", repoPath: commitlessRepo, vaultPath: commitlessRepo,
      config: {}, createdAt: now, archivedAt: null, reserved: false,
      referenceRepos: [commitlessRepo],
      repos: [{ key: "svc-commitless", path: commitlessRepo }],
    });
    // A project whose primary/reference/registered repos are NOT git repos at all — a genuine git failure,
    // distinct from "no commits yet", which must still surface as an error on every route.
    db.insertProject({
      id: "pBroken", name: "Broken", repoPath: notARepo, vaultPath: notARepo,
      config: {}, createdAt: now, archivedAt: null, reserved: false,
      referenceRepos: [notARepo],
      repos: [{ key: "svc-broken", path: notARepo }],
    });
    // Control: a project with real commits, proving the fix doesn't blanket-empty a healthy log.
    db.insertProject({
      id: "pControl", name: "Control", repoPath: committedRepo, vaultPath: committedRepo,
      config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });

    // --- (1) Commitless repo — all three routes return a clean 200 + empty array, not a 500. ---
    const primaryLog = await app.inject({ method: "GET", url: "/api/projects/pCommitless/git/log" });
    check("(1) primary log on commitless repo → 200 (not 500)", primaryLog.statusCode === 200);
    check("(1) primary log on commitless repo → empty array", Array.isArray(primaryLog.json()) && primaryLog.json().length === 0);

    const refLog = await app.inject({ method: "GET", url: "/api/projects/pCommitless/git/reference-repos/0/log" });
    check("(1) reference-repo log on commitless repo → 200 (not 500)", refLog.statusCode === 200);
    check("(1) reference-repo log on commitless repo → empty array", Array.isArray(refLog.json()) && refLog.json().length === 0);

    const registryLog = await app.inject({ method: "GET", url: "/api/projects/pCommitless/git/repos/0/log" });
    check("(1) registered-repo log on commitless repo → 200 (not 500)", registryLog.statusCode === 200);
    check("(1) registered-repo log on commitless repo → empty array", Array.isArray(registryLog.json()) && registryLog.json().length === 0);

    // --- (2) A genuine git failure (not a git repo at all) STILL surfaces as an error on every route —
    // proving the fix distinguishes the commitless signature rather than swallowing every git error. ---
    const primaryBroken = await app.inject({ method: "GET", url: "/api/projects/pBroken/git/log" });
    check("(2) primary log on a non-repo dir → NOT 200 (genuine failure still errors)", primaryBroken.statusCode !== 200);

    const refBroken = await app.inject({ method: "GET", url: "/api/projects/pBroken/git/reference-repos/0/log" });
    check("(2) reference-repo log on a non-repo dir → NOT 200", refBroken.statusCode !== 200);

    const registryBroken = await app.inject({ method: "GET", url: "/api/projects/pBroken/git/repos/0/log" });
    check("(2) registered-repo log on a non-repo dir → NOT 200", registryBroken.statusCode !== 200);

    // --- (3) Control — a repo WITH a real commit still returns it (the fix doesn't blanket-empty a
    // healthy log). ---
    const controlLog = await app.inject({ method: "GET", url: "/api/projects/pControl/git/log" });
    check("(3) control repo (has a commit) → 200", controlLog.statusCode === 200);
    const controlCommits = controlLog.json();
    check("(3) control repo log returns the real commit", Array.isArray(controlCommits) && controlCommits.length === 1 && controlCommits[0].message === "real commit");

    // --- (4) Branches/status read surface sanity: `git branch` on a commitless repo does NOT throw
    // (unlike `git log`) — confirms this surface needed no fix, per the card's "check while you're there". ---
    const branches = await app.inject({ method: "GET", url: "/api/projects/pCommitless/git/branches" });
    check("(4) branches on commitless repo → 200 (was already safe)", branches.statusCode === 200);
    check("(4) branches on commitless repo → empty `all`", Array.isArray(branches.json().all) && branches.json().all.length === 0);
  } finally {
    db.close();
  }
} finally {
  for (const d of [tmpHome, commitlessRepo, committedRepo, notARepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a commitless repo (git init, zero commits — exactly what project_init leaves a brand-new project in) returns a clean empty log (200) on all three git-log routes (primary/reference-repo/registered-repo), sharing the fix at GitReader.log(); a genuine git failure (not a repo at all) still surfaces as an error on all three; a repo with real commits is unaffected; claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
