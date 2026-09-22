import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EMITTED-BUILD STAMP test (card fde10c75). Proves TWO things:
//   (1) `advisoryBuildStamp` (deploy-staleness.ts), in isolation, against fixture DeployStalenessResult
//       shapes — unavailable/current/stale — never fabricating a verdict.
//   (2) the WIRING: a REAL `gate_status(opId)` MCP tool call, for a REAL settled worker-gate op, carries
//       an `emittedBuild` field derived from `currentDeployStaleness()` — mirrors
//       gate-status-timing-band.mjs's "a read path a manager will actually use" pattern — plus that the
//       field is genuinely ABSENT (never a fabricated "current") when the underlying signal itself is
//       unavailable (LOOM_REPO_ROOT pointed at a dir with no `.git`).
//
// RED-PROVEN per /worker doctrine: hand-verified to FAIL against the pre-card dist (no `emittedBuild`
// field existed on the return type or the handler at all, so `status.emittedBuild` read `undefined` even
// against a real, available deploy-staleness signal).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status-emitted-build.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gseb-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { advisoryBuildStamp } = await import("../dist/deploy-staleness.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── PART 1 — advisoryBuildStamp in isolation, fixture-driven, fully deterministic ──────────────────────
check(
  "(1a) unavailable signal ⇒ null, never a fabricated stamp",
  advisoryBuildStamp({ available: false, runningCodeBuiltAt: null, stale: false, commitsBehind: 0 }) === null,
);
check(
  "(1b) available but runningCodeBuiltAt somehow null ⇒ null (never fabricates a timestamp)",
  advisoryBuildStamp({ available: true, runningCodeBuiltAt: null, stale: false, commitsBehind: 0 }) === null,
);
const currentStamp = advisoryBuildStamp({ available: true, runningCodeBuiltAt: "2026-09-01T00:00:00.000Z", stale: false, commitsBehind: 0 });
check("(1c) current, not stale ⇒ starts with \"current\"", typeof currentStamp === "string" && currentStamp.startsWith("current"));
check("(1c) current stamp carries the running-code build timestamp", currentStamp.includes("2026-09-01T00:00:00.000Z"));
const staleStamp = advisoryBuildStamp({ available: true, runningCodeBuiltAt: "2026-09-01T00:00:00.000Z", stale: true, commitsBehind: 7 });
check("(1d) stale ⇒ starts with \"stale\"", typeof staleStamp === "string" && staleStamp.startsWith("stale"));
check("(1d) stale stamp names the real commitsBehind count (7), never a different number", staleStamp.includes("7 commit"));
check("(1d) stale stamp is DERIVED FROM runningCodeBuiltAt, not a distinct/absent clock", staleStamp.includes("2026-09-01T00:00:00.000Z"));
// RED PROOF: a stamp built from the raw distBuiltAt clock instead of runningCodeBuiltAt would read
// DIFFERENT text here — prove this fixture's two clocks actually differ, then prove the stamp used the
// right one (card 8ff7ccde's own prohibition: never the raw distBuiltAt clock).
const understatingStamp = advisoryBuildStamp({ available: true, runningCodeBuiltAt: "2026-09-01T00:00:00.000Z", distBuiltAt: "2026-09-10T00:00:00.000Z", stale: true, commitsBehind: 7 });
check(
  "(1e, RED PROOF) the stamp names runningCodeBuiltAt even when a LATER distBuiltAt is also present on the same object — never the flattering/understating clock",
  understatingStamp.includes("2026-09-01T00:00:00.000Z") && !understatingStamp.includes("2026-09-10T00:00:00.000Z"),
);

// ── PART 2 — the wiring, at the REAL gate_status MCP tool-call boundary ─────────────────────────────────
const GIT_ID = "-c user.email=gseb@loom -c user.name=gseb";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];
const savedRepoRoot = process.env.LOOM_REPO_ROOT;
try {
  const P = `gseb-${Date.now()}`;
  const repo = path.join(os.tmpdir(), `${P}-repo`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# gseb\n");
  execSync(`git init -q && git config user.email gseb@loom && git config user.name gseb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  dbs.push(db);
  db.insertProject({ id: P, name: "GSEB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
  const taskId = `${P}-task`, workerId = `${P}-wkr`;
  db.insertTask({ id: taskId, projectId: P, title: "GSEB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, P, taskId);
  worktrees.push(worktreePath);
  db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const fastGate = async () => ({ passed: true });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fastGate });

  const result = await sessions.runWorkerGate(workerId);
  check("(2, precondition) the gate settles INLINE and passes", result.settled === true && result.ok === true && result.value.passed === true);
  const opId = result.value.opId;

  const router = new OrchestrationMcpRouter(db, sessions);
  const server = router.buildServer(workerId, "worker");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "gate-status-emitted-build", version: "0" });
  await client.connect(clientT);
  const toolStatus = JSON.parse((await client.callTool({ name: "gate_status", arguments: { opId } })).content[0].text);

  check("(2) gate_status reports the same settled/passed verdict", toolStatus.state === "settled" && toolStatus.passed === true);
  // This process is a real Loom source checkout (this repo's own worktree — `loomRepoRoot()` resolves
  // there absent a LOOM_REPO_ROOT override), with a real built dist (this test runs post-`pnpm build`),
  // so the signal is genuinely AVAILABLE here — assert presence + shape, not an exact stale/current
  // verdict (that depends on this worktree's own live git/dist state, which this test doesn't control).
  check(
    "(2, THE FIX) emittedBuild is present at the actual tool-call boundary, and is one of the two real shapes advisoryBuildStamp produces",
    typeof toolStatus.emittedBuild === "string" && (toolStatus.emittedBuild.startsWith("current") || toolStatus.emittedBuild.startsWith("stale")),
  );

  // ── PART 3 — negative control: point LOOM_REPO_ROOT at a dir with no `.git` (not-applicable) and prove ──
  // emittedBuild goes genuinely ABSENT, never a fabricated "current", for a SECOND settled op — same
  // client/server, same live session, only the ambient repo-root signal changed.
  const noGitDir = path.join(os.tmpdir(), `gseb-nogit-${Date.now()}-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(noGitDir, { recursive: true });
  registerForCleanup(noGitDir);
  process.env.LOOM_REPO_ROOT = noGitDir;
  const result2 = await sessions.runWorkerGate(workerId);
  check("(3, precondition) a second gate op settles and passes", result2.settled === true && result2.ok === true && result2.value.passed === true);
  const opId2 = result2.value.opId;
  const toolStatus2 = JSON.parse((await client.callTool({ name: "gate_status", arguments: { opId: opId2 } })).content[0].text);
  check("(3) the second op also reports settled/passed", toolStatus2.state === "settled" && toolStatus2.passed === true);
  check(
    "(3, NEGATIVE CONTROL) emittedBuild is ABSENT, never a fabricated \"current\", when the underlying signal is unavailable (no .git at LOOM_REPO_ROOT)",
    toolStatus2.emittedBuild === undefined,
  );

  await client.close();
} finally {
  process.env.LOOM_REPO_ROOT = savedRepoRoot;
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card fde10c75: advisoryBuildStamp derives a one-token stamp from runningCodeBuiltAt (never the raw distBuiltAt clock), and gate_status(opId), at the real MCP tool-call boundary, carries an `emittedBuild` field for a settled op when the deploy-staleness signal is available."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
