import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 59e53710 — a Code Review of commit 4fabafd1 found `unsafeBranchNameReason` (git/writer.ts)
// was opt-in PER CALLER: only `project_checkout_branch` (the manager surface) ran it before this card, so
// the Platform Lead's own `git_checkout`/`git_create_branch` (mcp/platform.ts) handed a raw, unvalidated
// branch name straight to `GitWriter`. Fixed by moving the no-legitimate-use subset of that check
// (leading "-", "@{", a "refs/" prefix) INTO `GitWriter.checkout()`/`createBranch()` themselves, AND by
// closing a second, pre-existing pathspec-fallback data-loss path in `checkout()` (a name that resolves
// as neither a ref nor an option falls back to git's pathspec-restore mode, silently discarding dirty
// tracked files) — see docs/decisions/59e53710-branch-name-shape-check-into-gitwriter.md for the full
// detail and the round-2 Code Review corrections this test file reflects.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (modeled on platform-reserved-home-git-refusal.mjs). Own temp
// LOOM_HOME (useOwnLoomHome + requireHermeticEnv) — NEVER the real ~/.loom. Covers, per caller tool:
//   (a) git_checkout refuses "-", "@{-1}", "-bsneaky", "refs/heads/second" — from a state where a REAL previous branch exists
//       (so "-"/"@{-1}" genuinely resolve to it pre-fix, not merely fail for lack of one) — asserted via
//       the SYMBOLIC ref (`git symbolic-ref HEAD`), never a sha (a same-sha new branch would pass a
//       sha-only check); state reset to the baseline between every case;
//   (b) git_create_branch refuses the same three names — asserted via the exact branch-name SET, reset
//       between cases;
//   (c) PATHSPEC-FALLBACK: a dirty tracked file plus git_checkout(".") / git_checkout("a.txt") /
//       git_checkout("main^{}") — asserts the file is BYTE-UNCHANGED and HEAD's symbolic ref is
//       unchanged (never detached), reset between cases;
//   (d) NEGATIVE CONTROL: an ordinary name ("feature/x") still succeeds on both tools.
// Run: 1) build, 2) node test/platform-branch-name-shape-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-platform-nameshape-", { fresh: true }));

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
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}
const symbolicRef = (dir) => { try { return git(dir, "symbolic-ref", "HEAD").trim(); } catch { return null; } };
const branchSet = (dir) => git(dir, "branch", "--list").split("\n").map((l) => l.replace(/^[* ]+/, "").trim()).filter(Boolean).sort().join(",");
function resetToBaseline(dir) {
  try { git(dir, "checkout", "--", "."); } catch { /* nothing dirty */ }
  try { git(dir, "checkout", "main"); } catch { /* best-effort */ }
  for (const b of branchSet(dir).split(",").filter(Boolean)) {
    if (b !== "main" && b !== "second") { try { git(dir, "branch", "-D", b); } catch { /* ignore */ } }
  }
}

const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-platform-nameshape-fixtures-"));
const repo = path.join(fixturesRoot, "repo");
initRepo(repo);
git(repo, "checkout", "-b", "second");
git(repo, "checkout", "main");

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
db.insertProject({
  id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: "",
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
db.insertAgent({ id: "agentL", projectId: "pOrd", name: "Lead", startupPrompt: "L", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pOrd", agentId: "agentL", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
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

const UNSAFE_NAMES = ["-", "@{-1}", "-bsneaky", "refs/heads/second"];
const PATHSPEC_NAMES = [".", "a.txt", "main^{}"];

try {
  const server = router.buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-branch-name-shape-refusal-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ===== (a) git_checkout refuses each unsafe name — SYMBOLIC ref unchanged, reset between cases =====
  for (const name of UNSAFE_NAMES) {
    resetToBaseline(repo);
    const refBefore = symbolicRef(repo);
    const res = await call("git_checkout", { projectId: "pOrd", branch: name });
    check(`git_checkout(${JSON.stringify(name)}): {ok:false, error}`, res.ok === false && typeof res.error === "string");
    check(`git_checkout(${JSON.stringify(name)}): symbolic HEAD unchanged (not switched/detached)`, symbolicRef(repo) === refBefore);
  }

  // ===== (b) git_create_branch refuses each unsafe name — exact branch SET unchanged =====
  for (const name of UNSAFE_NAMES) {
    resetToBaseline(repo);
    const setBefore = branchSet(repo);
    const res = await call("git_create_branch", { projectId: "pOrd", name });
    check(`git_create_branch(${JSON.stringify(name)}): {ok:false, error}`, res.ok === false && typeof res.error === "string");
    check(`git_create_branch(${JSON.stringify(name)}): no new branch landed`, branchSet(repo) === setBefore);
  }

  // ===== (c) PATHSPEC-FALLBACK: dirty tracked file survives, HEAD never detaches =====
  for (const name of PATHSPEC_NAMES) {
    resetToBaseline(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "DIRTY EDIT\n");
    const refBefore = symbolicRef(repo);
    const res = await call("git_checkout", { projectId: "pOrd", branch: name });
    check(`git_checkout(${JSON.stringify(name)}) [pathspec-fallback]: {ok:false, error}`, res.ok === false && typeof res.error === "string");
    check(`git_checkout(${JSON.stringify(name)}): a.txt is byte-unchanged (dirty edit survived)`, fs.readFileSync(path.join(repo, "a.txt"), "utf8") === "DIRTY EDIT\n");
    check(`git_checkout(${JSON.stringify(name)}): symbolic HEAD unchanged (never detached)`, symbolicRef(repo) === refBefore);
  }

  // ===== (d) NEGATIVE CONTROL: an ordinary name still succeeds on both tools =====
  resetToBaseline(repo);
  const create = await call("git_create_branch", { projectId: "pOrd", name: "feature/x" });
  check("negative control: git_create_branch(\"feature/x\") succeeds", create.ok === true && create.branch === "feature/x");
  resetToBaseline(repo);
  const checkout = await call("git_checkout", { projectId: "pOrd", branch: "second" });
  check("negative control: git_checkout(\"second\") succeeds", checkout.ok === true && checkout.branch === "second");

  await client.close();
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead's git_checkout/git_create_branch refuse \"-\"/\"@{-1}\"/\"-bsneaky\" (via a real previous-branch state, checked by symbolic ref / exact branch set) AND git_checkout refuses the pathspec-fallback shapes \".\"/\"a.txt\"/\"main^{}\" (a dirty tracked file survives byte-unchanged, HEAD never detaches); an ordinary name is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
