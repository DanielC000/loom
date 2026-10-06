import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9360c84 — the Platform Lead's git_checkout/git_create_branch/git_commit/git_push (mcp/platform.ts,
// shared `resolveGitWriter`) resolved a project's repoPath via `resolveRepoByKey` and handed it straight
// to `GitWriter`, with NO check for an operational/daemon-home dir. Both reserved homes (Platform, Setup)
// bind `repoPath` to LOOM_HOME exactly (platform/seed.ts, setup/seed.ts). This is not hypothetical: a real
// host can already have a `.git` inside LOOM_HOME (left over from before card 68cc29db closed the
// WRITE-time hole) — this fixture reproduces exactly that shape, a REAL git repo living AT LOOM_HOME with
// real history, so the test proves the refusal is unconditional, never a lucky "no repo yet" short-circuit.
// See docs/decisions/f9360c84-refuse-operational-dirs-in-vault-git-target-and-reserved-home-git-writers.md.
//
// HERMETIC: own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv) — NEVER the real ~/.loom. Covers:
//   (a) all 4 Lead git tools refuse a reserved-home-shaped project ({ok:false, error} naming the
//       operational home dir) BEFORE touching git — no new commit/branch, HEAD + branch list unchanged;
//   (b) round 2 — a repoKey (multi-repo epic 49136451) whose `repos[]` entry resolves to LOOM_HOME is
//       ALSO refused, even though the project's own PRIMARY repoPath is an ordinary repo elsewhere —
//       proves the refusal is scoped to the RESOLVED path, not a project-level check;
//   (c) NEGATIVE CONTROL: the same 4 tools against an ORDINARY project (its own separate repo, outside
//       LOOM_HOME) are completely unaffected — still checkout/branch/commit/push normally.
// Run: 1) build, 2) node test/platform-reserved-home-git-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Card 8378984b: {fresh:true} — initRepo(loomHome) below unconditionally `git checkout -b main`s the
// home itself; under a reused LOOM_HOME that already carries a `main` branch from an earlier run of this
// same file, that throws outright instead of running this file's actual assertions.
const loomHome = fs.realpathSync(useOwnLoomHome("loom-platform-reservedhome-", { fresh: true }));

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
const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-platform-reservedhome-fixtures-"));
const ordinaryRepo = path.join(fixturesRoot, "ordinary-repo");
initRepo(ordinaryRepo);

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
// The reserved-home shape: repoPath === LOOM_HOME exactly (platform/seed.ts's PLATFORM_HOME_PATH /
// setup/seed.ts's SETUP_HOME_PATH both bind repoPath AND vaultPath to LOOM_HOME this way).
db.insertProject({
  id: "pReserved", name: "Platform", repoPath: loomHome, vaultPath: loomHome,
  config: {}, createdAt: now, archivedAt: null, reserved: true, vaultOnly: true,
});
db.insertProject({
  id: "pOrdinary", name: "Ordinary", repoPath: ordinaryRepo, vaultPath: "",
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
// Round 2, finding (b): an ORDINARY project whose primary repoPath is fine, but whose multi-repo
// `repos[]` registry carries a SECONDARY entry pointing at LOOM_HOME (epic 49136451's repoKey selector)
// — resolveRepoByKey resolves that key to LOOM_HOME exactly, so the refusal must fire on the
// REPOKEY-RESOLVED path too, not just a project's bare primary repoPath.
const ordinaryRepo2 = path.join(fixturesRoot, "ordinary-repo-2");
initRepo(ordinaryRepo2);
db.insertProject({
  id: "pMultiRepo", name: "MultiRepo", repoPath: ordinaryRepo2, vaultPath: "",
  config: {}, createdAt: now, archivedAt: null, reserved: false,
  repos: [{ key: "secondary", path: loomHome }],
});
db.insertAgent({ id: "agentL", projectId: "pReserved", name: "Lead", startupPrompt: "L", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pReserved", agentId: "agentL", engineSessionId: null, title: null,
  cwd: loomHome, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null,
});

class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = router.buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-reserved-home-git-refusal-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ===== (a) all 4 Lead git tools refuse the reserved-home-shaped project =====
  // Round 2 of card f9360c84 moved this refusal FROM `resolveGitWriter` (a pre-writer check) INTO
  // `GitWriter` itself — it now comes back shaped exactly like every OTHER git-write failure from this
  // same tool (dirty tree, no upstream, …): `{ok:false, error}`, never the bare `{error}` (no `ok` key at
  // all) a `resolveGitWriter`-level refusal produced. Assert `ok === false` (not `undefined`) accordingly.
  const checkout = await call("git_checkout", { projectId: "pReserved", branch: "main" });
  check("git_checkout against the reserved home: {ok:false, error}", checkout.ok === false && typeof checkout.error === "string");
  check("git_checkout: error names the operational home dir", /operational home directory/i.test(checkout.error));

  const createBranch = await call("git_create_branch", { projectId: "pReserved", name: "pwned-branch" });
  check("git_create_branch against the reserved home: {ok:false, error}", createBranch.ok === false && typeof createBranch.error === "string");
  check("git_create_branch: error names the operational home dir", /operational home directory/i.test(createBranch.error));
  check("git_create_branch: NO new branch was created (RED on old code: checkout -b would have landed one)",
    git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);

  fs.writeFileSync(path.join(loomHome, "pwned.txt"), "should never be committed\n");
  const commit = await call("git_commit", { projectId: "pReserved", message: "should never land" });
  check("git_commit against the reserved home: {ok:false, error}", commit.ok === false && typeof commit.error === "string");
  check("git_commit: error names the operational home dir", /operational home directory/i.test(commit.error));
  check("git_commit: HEAD is UNCHANGED (RED on old code: `add -A` + commit would have staged pwned.txt + loom.db-shaped state)",
    git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  check("git_commit: pwned.txt sits UNTRACKED, never staged (proves `add -A` never ran)",
    git(loomHome, "status", "--porcelain").includes("?? pwned.txt"));

  const push = await call("git_push", { projectId: "pReserved" });
  check("git_push against the reserved home: {ok:false, error}", push.ok === false && typeof push.error === "string");
  check("git_push: error names the operational home dir", /operational home directory/i.test(push.error));

  // ===== (b) a repoKey whose repos[] entry resolves to LOOM_HOME =====
  const repoKeyCommit = await call("git_commit", { projectId: "pMultiRepo", repoKey: "secondary", message: "should never land via repoKey" });
  check("git_commit via repoKey resolving to LOOM_HOME: {ok:false, error}", repoKeyCommit.ok === false && typeof repoKeyCommit.error === "string");
  check("git_commit via repoKey: error names the operational home dir", /operational home directory/i.test(repoKeyCommit.error));
  check("git_commit via repoKey: LOOM_HOME's own repo HEAD is still unchanged", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  // Negative control: the SAME project's PRIMARY repo (repoKey omitted) is unaffected by its secondary
  // entry pointing at LOOM_HOME — proves the refusal is scoped to the RESOLVED path, not the project.
  fs.writeFileSync(path.join(ordinaryRepo2, "ok.txt"), "fine\n");
  const primaryCommit = await call("git_commit", { projectId: "pMultiRepo", message: "an ordinary primary-repo commit" });
  check("negative control: the SAME project's primary repo (repoKey omitted) still commits fine", primaryCommit.ok === true && typeof primaryCommit.hash === "string");

  // ===== (c) NEGATIVE CONTROL: the same 4 tools against an ORDINARY project are unaffected =====
  const ordCreate = await call("git_create_branch", { projectId: "pOrdinary", name: "feature" });
  check("negative control: git_create_branch on an ordinary repo still succeeds", ordCreate.ok === true && ordCreate.branch === "feature");
  const ordCheckout = await call("git_checkout", { projectId: "pOrdinary", branch: "main" });
  check("negative control: git_checkout on an ordinary repo still succeeds", ordCheckout.ok === true && ordCheckout.branch === "main");
  fs.writeFileSync(path.join(ordinaryRepo, "ok.txt"), "fine\n");
  const ordCommit = await call("git_commit", { projectId: "pOrdinary", message: "an ordinary commit" });
  check("negative control: git_commit on an ordinary repo still succeeds", ordCommit.ok === true && typeof ordCommit.hash === "string");
  check("negative control: the commit really landed", git(ordinaryRepo, "log", "-1", "--pretty=%s").trim() === "an ordinary commit");

  await client.close();
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead's git_checkout/git_create_branch/git_commit/git_push all refuse (before touching git) against a reserved-home-shaped project whose repoPath resolves to LOOM_HOME, even with a real pre-existing .git there, AND against an ordinary project whose repoKey-selected repos[] entry resolves to LOOM_HOME (while that same project's primary repo is unaffected); an ordinary project's git tools are completely unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
