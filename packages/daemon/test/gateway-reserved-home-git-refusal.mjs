import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9360c84 — the human REST git writer (`/api/projects/:id/git/{checkout,branch,commit,push}`,
// gateway/server.ts) resolved `p.repoPath` and handed it straight to `GitWriter`, with NO check for an
// operational/daemon-home dir. Both reserved homes (Platform, Setup) bind `repoPath` to LOOM_HOME exactly
// (platform/seed.ts, setup/seed.ts). This is not hypothetical: a real host can already have a `.git`
// inside LOOM_HOME (left over from before card 68cc29db closed the WRITE-time hole) — this fixture
// reproduces exactly that shape, a REAL git repo living AT LOOM_HOME with real history, so the test
// proves the refusal is unconditional, never a lucky "no repo yet" short-circuit.
// See docs/decisions/f9360c84-refuse-operational-dirs-in-vault-git-target-and-reserved-home-git-writers.md.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, modeled on
// git-read-error-surfaced.mjs / companion-grants-rest.mjs). Own temp LOOM_HOME (useOwnLoomHome +
// requireHermeticEnv) — NEVER the real ~/.loom. Covers:
//   (a) all 4 REST git-write routes refuse a reserved-home-shaped project — 200 { ok:false, error }
//       naming the operational home dir (the existing GitWriteResult convention, never a 500) — BEFORE
//       touching git — no new commit/branch, HEAD + branch list unchanged;
//   (b) NEGATIVE CONTROL: the same 4 routes against an ORDINARY project (its own separate repo, outside
//       LOOM_HOME) are completely unaffected.
// Run: 1) build, 2) node test/gateway-reserved-home-git-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-gateway-reservedhome-"));

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}

// Give LOOM_HOME itself a real .git — the exact "pre-fix commitVault already ran / hand-made repo" shape
// a real host can carry. If the refusal fired only because there was "no repo yet", this would hide it.
initRepo(loomHome);
const loomHomeHeadBefore = git(loomHome, "rev-parse", "HEAD").trim();
const loomHomeBranchesBefore = git(loomHome, "branch", "--list").trim();

// A separate, ordinary repo (negative control) — a plain sibling, nowhere near LOOM_HOME.
const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-gateway-reservedhome-fixtures-"));
const ordinaryRepo = path.join(fixturesRoot, "ordinary-repo");
initRepo(ordinaryRepo);

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({
  id: "pReserved", name: "Platform", repoPath: loomHome, vaultPath: loomHome,
  config: {}, createdAt: now, archivedAt: null, reserved: true, vaultOnly: true,
});
db.insertProject({
  id: "pOrdinary", name: "Ordinary", repoPath: ordinaryRepo, vaultPath: "",
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

try {
  // ===== (a) all 4 REST git-write routes refuse the reserved-home-shaped project =====
  const checkout = (await app.inject({ method: "POST", url: "/api/projects/pReserved/git/checkout", payload: { branch: "main" } })).json();
  check("POST .../git/checkout against the reserved home: {ok:false, error}", checkout.ok === false && typeof checkout.error === "string");
  check("…error names the operational home dir", /operational home directory/i.test(checkout.error));

  const branch = (await app.inject({ method: "POST", url: "/api/projects/pReserved/git/branch", payload: { name: "pwned-branch" } })).json();
  check("POST .../git/branch against the reserved home: {ok:false, error}", branch.ok === false && typeof branch.error === "string");
  check("…error names the operational home dir", /operational home directory/i.test(branch.error));
  check("…NO new branch was created (RED on old code: checkout -b would have landed one)",
    git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);

  fs.writeFileSync(path.join(loomHome, "pwned.txt"), "should never be committed\n");
  const commit = (await app.inject({ method: "POST", url: "/api/projects/pReserved/git/commit", payload: { message: "should never land" } })).json();
  check("POST .../git/commit against the reserved home: {ok:false, error}", commit.ok === false && typeof commit.error === "string");
  check("…error names the operational home dir", /operational home directory/i.test(commit.error));
  check("…HEAD is UNCHANGED (RED on old code: `add -A` + commit would have staged pwned.txt)",
    git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  check("…pwned.txt sits UNTRACKED, never staged (proves `add -A` never ran)",
    git(loomHome, "status", "--porcelain").includes("?? pwned.txt"));

  const push = (await app.inject({ method: "POST", url: "/api/projects/pReserved/git/push", payload: {} })).json();
  check("POST .../git/push against the reserved home: {ok:false, error}", push.ok === false && typeof push.error === "string");
  check("…error names the operational home dir", /operational home directory/i.test(push.error));

  // ===== (b) NEGATIVE CONTROL: the same 4 routes against an ORDINARY project are unaffected =====
  const ordBranch = (await app.inject({ method: "POST", url: "/api/projects/pOrdinary/git/branch", payload: { name: "feature" } })).json();
  check("negative control: POST .../git/branch on an ordinary repo still succeeds", ordBranch.ok === true && ordBranch.branch === "feature");
  const ordCheckout = (await app.inject({ method: "POST", url: "/api/projects/pOrdinary/git/checkout", payload: { branch: "main" } })).json();
  check("negative control: POST .../git/checkout on an ordinary repo still succeeds", ordCheckout.ok === true && ordCheckout.branch === "main");
  fs.writeFileSync(path.join(ordinaryRepo, "ok.txt"), "fine\n");
  const ordCommit = (await app.inject({ method: "POST", url: "/api/projects/pOrdinary/git/commit", payload: { message: "an ordinary commit" } })).json();
  check("negative control: POST .../git/commit on an ordinary repo still succeeds", ordCommit.ok === true && typeof ordCommit.hash === "string");
  check("negative control: the commit really landed", git(ordinaryRepo, "log", "-1", "--pretty=%s").trim() === "an ordinary commit");
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the human REST git writer's checkout/branch/commit/push routes all refuse (before touching git) against a reserved-home-shaped project whose repoPath resolves to LOOM_HOME, even with a real pre-existing .git there, with the existing {ok:false,error} 200 convention; an ordinary project's routes are completely unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
