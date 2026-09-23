import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c77dda7d — the Platform Lead's pending-merge guard (mcp/platform.ts). HERMETIC, CLAUDE-FREE, NETWORK-FREE:
// a REAL Db + SessionService over a FAKE pty, the REAL PlatformMcpRouter over an in-process MCP transport, and a
// REAL temp git repo. Proves:
//   (a) with NO pending same-repo merge op, skill_edit (bundled asset) and git_commit are byte-for-byte unwarned;
//   (b) with a pending merge op (a live `pending_gate_ops` row), skill_edit on a bundled skill carries a `warning`
//       + `pendingMergeOps` naming the op id/kind/age (the write itself still lands), and git_commit REFUSES with
//       nothing staged/committed unless acknowledgePendingMerge:true;
//   (c) the op sources: a live GateSemaphore entry yields the real batch branch count; a `pending` row whose owner
//       session is dead, a `settled` row, and an op on a DIFFERENT project's repo all yield NO warning;
//   (d) a USER-skill edit never warns; git_commit `paths` commits ONLY those paths (an unrelated untracked file is
//       left alone) and rejects an escaping/option-shaped path;
//   (e) the Platform surface has a read-only gate_queue that sees a cross-project entry UNREDACTED, while
//       gateQueueForManager for the same caller without the opt-in still redacts it (redaction unchanged).
// Run: 1) build, 2) node test/platform-pending-merge-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pmw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// The project repo, with the bundled-asset skills dir INSIDE it (so a skill write "lands in" that repo).
const repo = path.join(tmpHome, "repo");
const assetSkillsDir = path.join(repo, "packages", "daemon", "assets", "skills");
fs.mkdirSync(path.join(assetSkillsDir, "core-doctrine"), { recursive: true });
const BUNDLED_MD = "---\nname: core-doctrine\ndescription: a shipped Loom skill\n---\n\n# core-doctrine\n\nStep one.\nStep two: TODO.\nStep three.\n";
fs.writeFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), BUNDLED_MD);
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing dist — store.ts reads it at load
const otherRepo = path.join(tmpHome, "other-repo");
fs.mkdirSync(otherRepo, { recursive: true });

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

for (const dir of [repo, otherRepo]) {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email pmw@loom && git config user.name pmw", { cwd: dir });
}
fs.writeFileSync(path.join(repo, "README.md"), "# pending-merge warning test repo\n");
fs.writeFileSync(path.join(otherRepo, "README.md"), "# other repo\n");
commitAll(repo, "init");
commitAll(otherRepo, "init");
const head = (dir) => execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const storeSkillMd = (name) => path.join(tmpHome, "skills", name, "SKILL.md");
const writeStoreFile = (name, content) => { fs.mkdirSync(path.dirname(storeSkillMd(name)), { recursive: true }); fs.writeFileSync(storeSkillMd(name), content); };

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pLoom", name: "LoomLike", repoPath: repo, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other", repoPath: otherRepo, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pPlat", name: "PlatformHome", repoPath: path.join(tmpHome, "plat-repo"), vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentM", projectId: "pLoom", name: "Mgr", startupPrompt: "M", position: 0, profileId: null });
db.insertAgent({ id: "agentL", projectId: "pPlat", name: "Lead", startupPrompt: "L", position: 0, profileId: null });
const seedSession = (id, projectId, agentId, role, processState) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo, processState, resumability: "unknown",
  busy: false, createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
});
seedSession("PL", "pPlat", "agentL", "platform", "live");
seedSession("MLIVE", "pLoom", "agentM", "manager", "live");
seedSession("MDEAD", "pLoom", "agentM", "manager", "exited");

class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

const mintRow = (opId, { key, owner, projectId, minutesAgo = 20, taskId = null, branch = null }) => db.insertPendingGateOp({
  opId, kind: "merge", key, ownerSessionId: owner, projectId, taskId, branch,
  startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), state: "pending", surfacedPending: false,
});

try {
  const server = router.buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "pmw-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("(0) platform surface registers gate_queue", tools.includes("gate_queue"));

  writeStoreFile("core-doctrine", BUNDLED_MD);
  let doctrine = BUNDLED_MD;
  const editBundled = async (n) => {
    const next = doctrine.replace(/Step two: \w+\./, `Step two: v${n}.`);
    const r = await call("skill_edit", { name: "core-doctrine", oldString: doctrine.match(/Step two: \w+\./)[0], newString: `Step two: v${n}.`, confirm: true });
    doctrine = next;
    return r;
  };

  // ===== (a) NO pending op ⇒ no warning anywhere =====
  const a1 = await editBundled(1);
  check("(a) skill_edit bundled with NO pending op: ok, target asset, NO warning / pendingMergeOps", a1.ok === true && a1.target === "asset" && a1.warning === undefined && a1.pendingMergeOps === undefined);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  const a2 = await call("git_commit", { projectId: "pLoom", message: "test: a" });
  check("(a) git_commit with NO pending op: commits, NO warning / refusal", a2.ok === true && typeof a2.hash === "string" && a2.warning === undefined && a2.refused === undefined);

  // ===== (b) a live pending BATCH row on this repo's project =====
  mintRow("op-batch-1111", { key: "merge-batch:MLIVE", owner: "MLIVE", projectId: "pLoom", minutesAgo: 20 });
  const b1 = await editBundled(2);
  check("(b) skill_edit bundled WITH a pending op: the write still LANDS (ok, asset)", b1.ok === true && b1.target === "asset" && fs.readFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), "utf8").includes("Step two: v2."));
  check("(b) …and carries a loud warning naming the op id (8-char), kind, and age",
    typeof b1.warning === "string" && b1.warning.includes("op-batch") && /batch merge/.test(b1.warning) && /20m old/.test(b1.warning) && /PENDING MERGE/.test(b1.warning));
  check("(b) …and structured pendingMergeOps [{opId,kind:'batch',phase:'pending',branchCount:null}]",
    Array.isArray(b1.pendingMergeOps) && b1.pendingMergeOps.length === 1 && b1.pendingMergeOps[0].opId === "op-batch-1111" && b1.pendingMergeOps[0].kind === "batch" && b1.pendingMergeOps[0].phase === "pending" && b1.pendingMergeOps[0].branchCount === null);
  const w1 = await call("skill_write", { name: "core-doctrine", content: doctrine, confirm: true });
  check("(b) skill_write bundled WITH a pending op warns too", w1.ok === true && typeof w1.warning === "string" && w1.pendingMergeOps?.length === 1);

  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  const headBefore = head(repo);
  const b2 = await call("git_commit", { projectId: "pLoom", message: "test: b" });
  check("(b) git_commit WITH a pending op REFUSES (ok:false, refused:true) naming the op", b2.ok === false && b2.refused === true && /op-batch/.test(b2.error) && b2.pendingMergeOps?.length === 1);
  check("(b) …and the refusal staged/committed NOTHING (HEAD unchanged, b.txt still untracked)",
    head(repo) === headBefore && execSync("git status --porcelain -- b.txt", { cwd: repo, encoding: "utf8" }).startsWith("??"));
  const b3 = await call("git_commit", { projectId: "pLoom", message: "test: b ack", acknowledgePendingMerge: true });
  check("(b) acknowledgePendingMerge:true commits AND still carries the warning + pendingMergeOps", b3.ok === true && typeof b3.hash === "string" && /PENDING MERGE/.test(b3.warning) && b3.pendingMergeOps?.length === 1);

  // ===== (c) which ops count =====
  db.settlePendingGateOp("op-batch-1111");
  const c1 = await editBundled(3);
  check("(c) a SETTLED row does not warn", c1.ok === true && c1.warning === undefined);
  mintRow("op-dead-2222", { key: "merge-batch:MDEAD", owner: "MDEAD", projectId: "pLoom" });
  const c2 = await editBundled(4);
  check("(c) a `pending` row whose owner session is NOT live (crash-orphaned tombstone) does not warn", c2.ok === true && c2.warning === undefined);
  db.settlePendingGateOp("op-dead-2222");
  mintRow("op-other-3333", { key: "merge-batch:MLIVE", owner: "MLIVE", projectId: "pOther" });
  const c3 = await editBundled(5);
  check("(c) a pending op on a DIFFERENT project's repo does not warn", c3.ok === true && c3.warning === undefined);
  db.settlePendingGateOp("op-other-3333");

  // Live semaphore entry (queued behind a held slot) — supplies the REAL batch branch count.
  let releaseGate;
  const gateHeld = new Promise((r) => { releaseGate = r; });
  const running = svc.gateSemaphore.runExclusive(2, {
    gateType: "merge", projectId: "pLoom", sessionId: "MLIVE", taskId: "task-x", branch: "loom/x", opId: "op-live-4444",
    batchBranches: ["loom/a", "loom/b", "loom/c"], batchLandedCount: 2, repoPath: repo,
  }, async () => { await gateHeld; return { passed: true }; }, "high");
  // Poll (no fixed sleep) until the run is observably registered before snapshotting.
  for (let i = 0; i < 200 && svc.gateSemaphore.snapshot().entries.length === 0; i++) await new Promise((r) => setImmediate(r));
  check("(c) precondition: the semaphore entry is registered", svc.gateSemaphore.snapshot().entries.length === 1);
  const d1 = await editBundled(6);
  check("(c) a LIVE semaphore batch entry warns with the post-assembly branch count (2, not the 3 requested)",
    d1.ok === true && d1.pendingMergeOps?.length === 1 && d1.pendingMergeOps[0].opId === "op-live-4444" && d1.pendingMergeOps[0].kind === "batch" && d1.pendingMergeOps[0].branchCount === 2 && /2 branches/.test(d1.warning));

  // ===== (e) gate_queue: read-only, cross-project UNREDACTED for the Lead; manager view still redacted =====
  const q = await call("gate_queue", {});
  const entry = q.running?.find((e) => e.opId === "op-live-4444") ?? q.queued?.find((e) => e.opId === "op-live-4444");
  check("(e) platform gate_queue returns the snapshot shape (cap + arrays)", typeof q.cap === "number" && Array.isArray(q.running) && Array.isArray(q.queued) && Array.isArray(q.squashing));
  check("(e) the Lead (project pPlat) sees pLoom's entry UNREDACTED: branch/taskId present, no `redacted` flag", !!entry && entry.branch === "loom/x" && entry.taskId === "task-x" && entry.redacted === undefined);
  const managerView = svc.gateQueueForManager("pPlat");
  const mEntry = [...managerView.running, ...managerView.queued].find((e) => e.opId === "op-live-4444");
  check("(e) NEGATIVE CONTROL — gateQueueForManager for the same caller WITHOUT the opt-in still redacts it (branch/taskId absent, redacted:true)", !!mEntry && mEntry.redacted === true && mEntry.branch === undefined && mEntry.taskId === undefined);
  releaseGate();
  await running;

  // ===== (d) user skills never warn; git_commit `paths` =====
  mintRow("op-batch-5555", { key: "merge-batch:MLIVE", owner: "MLIVE", projectId: "pLoom" });
  writeStoreFile("my-skill", "---\nname: my-skill\ndescription: mine\n---\n\n# my-skill\n\nOld.\n");
  const u1 = await call("skill_edit", { name: "my-skill", oldString: "Old.", newString: "New.", confirm: true });
  check("(d) a USER-skill edit (store only) never warns even with a pending op", u1.ok === true && u1.bundled === false && u1.warning === undefined);
  const e1 = await call("skill_edit", { name: "core-doctrine", oldString: "nonexistent text", newString: "x", confirm: true });
  check("(d) an ERROR result (no write) never carries the warning", typeof e1.error === "string" && e1.warning === undefined);

  fs.writeFileSync(path.join(repo, "wanted.txt"), "wanted\n");
  fs.writeFileSync(path.join(repo, "unrelated-untracked.yml"), "unrelated\n");
  const p1 = await call("git_commit", { projectId: "pLoom", message: "test: paths", paths: ["wanted.txt"], acknowledgePendingMerge: true });
  check("(d) git_commit with paths commits", p1.ok === true && typeof p1.hash === "string");
  const files = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf8" }).trim().split(/\r?\n/);
  check("(d) …ONLY the named path landed in the commit", files.length === 1 && files[0] === "wanted.txt");
  check("(d) …and the unrelated untracked file is still untracked", execSync("git status --porcelain -- unrelated-untracked.yml", { cwd: repo, encoding: "utf8" }).startsWith("??"));
  for (const bad of ["../escape.txt", "-A", "C:\\abs.txt", "/abs.txt", ""]) {
    const pb = await call("git_commit", { projectId: "pLoom", message: "test: bad", paths: [bad], acknowledgePendingMerge: true });
    check(`(d) git_commit rejects path ${JSON.stringify(bad)}`, pb.ok === false && /invalid path/.test(pb.error ?? ""));
  }
  const pe = await call("git_commit", { projectId: "pLoom", message: "test: empty", paths: [], acknowledgePendingMerge: true });
  check("(d) git_commit rejects an empty paths array", pe.ok === false && /non-empty/.test(pe.error ?? ""));
  db.settlePendingGateOp("op-batch-5555");
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
