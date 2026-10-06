import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9360c84 round 2, finding (MAJOR) — mcp/operator.ts's bounded Elevated Operator surface
// (git_checkout/git_create_branch/git_commit/git_push) handed the caller's OWN project's `repoPath`
// straight to `GitWriter` with NO operational-dir check of its own at all (unlike the human REST writer
// and the Platform Lead, which at least had a per-caller check before round 2 moved the guard into
// GitWriter itself). This fixture proves the Operator surface is now covered too — for free, since the
// refusal lives INSIDE GitWriter, which every write surface (including this one) goes through.
// See docs/decisions/f9360c84-refuse-operational-dirs-in-vault-git-target-and-reserved-home-git-writers.md.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (modeled on operator-surface.mjs / platform-reserved-home-git-
// refusal.mjs). Own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv) — NEVER the real ~/.loom. Covers:
//   (a) all 4 operator git tools refuse when the caller's OWN project's repoPath is a reserved-home-shaped
//       dir (repoPath === LOOM_HOME, with a REAL pre-existing .git there) — {ok:false, error} naming the
//       operational home dir, BEFORE touching git — no new commit/branch, HEAD + branch list unchanged;
//   (b) NEGATIVE CONTROL: the same 4 tools against an operator bound to an ORDINARY project (its own
//       separate repo, outside LOOM_HOME) are completely unaffected.
// Run: 1) build, 2) node test/operator-reserved-home-git-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Card 8378984b: {fresh:true} — initRepo(loomHome) below unconditionally `git checkout -b main`s the
// home itself; under a reused LOOM_HOME that already carries a `main` branch from an earlier run of this
// same file, that throws outright instead of running this file's actual assertions.
const loomHome = fs.realpathSync(useOwnLoomHome("loom-operator-reservedhome-", { fresh: true }));

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
const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-operator-reservedhome-fixtures-"));
const ordinaryRepo = path.join(fixturesRoot, "ordinary-repo");
initRepo(ordinaryRepo);

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OperatorMcpRouter } = await import("../dist/mcp/operator.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.setPlatformConfig({ operatorEnabled: true });
// The reserved-home shape: repoPath === LOOM_HOME exactly (platform/seed.ts's PLATFORM_HOME_PATH /
// setup/seed.ts's SETUP_HOME_PATH both bind repoPath AND vaultPath to LOOM_HOME this way) — an operator
// could be spawned onto an agent bound to such a project (round 2's MAJOR finding).
db.insertProject({
  id: "pReserved", name: "Platform", repoPath: loomHome, vaultPath: loomHome,
  config: {}, createdAt: now, archivedAt: null, reserved: true, vaultOnly: true,
});
db.insertProject({
  id: "pOrdinary", name: "Ordinary", repoPath: ordinaryRepo, vaultPath: "",
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
db.insertAgent({ id: "agentReserved", projectId: "pReserved", name: "Operator (reserved)", startupPrompt: "O", position: 0, profileId: null });
db.insertAgent({ id: "agentOrdinary", projectId: "pOrdinary", name: "Operator (ordinary)", startupPrompt: "O2", position: 1, profileId: null });
db.insertSession({
  id: "opReserved", projectId: "pReserved", agentId: "agentReserved", engineSessionId: null, title: null,
  cwd: loomHome, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "operator", parentSessionId: null,
});
db.insertSession({
  id: "opOrdinary", projectId: "pOrdinary", agentId: "agentOrdinary", engineSessionId: null, title: null,
  cwd: ordinaryRepo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "operator", parentSessionId: null,
});

class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new OperatorMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

const connect = async (sessionId) => {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `operator-reserved-home-git-refusal-${sessionId}`, version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
};

try {
  // ===== (a) all 4 operator git tools refuse when the caller's OWN project IS the reserved home =====
  const { client: clientReserved, call: callReserved } = await connect("opReserved");

  const checkout = await callReserved("git_checkout", { branch: "main" });
  check("git_checkout (operator, reserved-home project): {ok:false, error}", checkout.ok === false && typeof checkout.error === "string");
  check("git_checkout: error names the operational home dir", /operational home directory/i.test(checkout.error));

  const createBranch = await callReserved("git_create_branch", { name: "pwned-branch" });
  check("git_create_branch (operator, reserved-home project): {ok:false, error}", createBranch.ok === false && typeof createBranch.error === "string");
  check("git_create_branch: error names the operational home dir", /operational home directory/i.test(createBranch.error));
  check("git_create_branch: NO new branch was created (RED on old code: checkout -b would have landed one)",
    git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);

  fs.writeFileSync(path.join(loomHome, "pwned.txt"), "should never be committed\n");
  const commit = await callReserved("git_commit", { message: "should never land" });
  check("git_commit (operator, reserved-home project): {ok:false, error}", commit.ok === false && typeof commit.error === "string");
  check("git_commit: error names the operational home dir", /operational home directory/i.test(commit.error));
  check("git_commit: HEAD is UNCHANGED (RED on old code: NO check at all — add -A + commit would have staged pwned.txt)",
    git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  check("git_commit: pwned.txt sits UNTRACKED, never staged (proves `add -A` never ran)",
    git(loomHome, "status", "--porcelain").includes("?? pwned.txt"));

  const push = await callReserved("git_push", {});
  check("git_push (operator, reserved-home project): {ok:false, error}", push.ok === false && typeof push.error === "string");
  check("git_push: error names the operational home dir", /operational home directory/i.test(push.error));

  await clientReserved.close();

  // ===== (b) NEGATIVE CONTROL: the same 4 tools against an operator bound to an ORDINARY project =====
  const { client: clientOrdinary, call: callOrdinary } = await connect("opOrdinary");

  const ordBranch = await callOrdinary("git_create_branch", { name: "feature" });
  check("negative control: git_create_branch on an ordinary repo still succeeds", ordBranch.ok === true && ordBranch.branch === "feature");
  const ordCheckout = await callOrdinary("git_checkout", { branch: "main" });
  check("negative control: git_checkout on an ordinary repo still succeeds", ordCheckout.ok === true && ordCheckout.branch === "main");
  fs.writeFileSync(path.join(ordinaryRepo, "ok.txt"), "fine\n");
  const ordCommit = await callOrdinary("git_commit", { message: "an ordinary commit" });
  check("negative control: git_commit on an ordinary repo still succeeds", ordCommit.ok === true && typeof ordCommit.hash === "string");
  check("negative control: the commit really landed", git(ordinaryRepo, "log", "-1", "--pretty=%s").trim() === "an ordinary commit");

  await clientOrdinary.close();
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the bounded Elevated Operator's git_checkout/git_create_branch/git_commit/git_push all refuse (before touching git) when the caller's OWN project resolves to LOOM_HOME, even with a real pre-existing .git there, with the existing {ok:false,error} convention — a surface that had NO operational-dir check of its own before round 2 moved the guard into GitWriter; an operator bound to an ordinary project is completely unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
