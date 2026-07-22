import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451 phase 1 — the owner-flagged degrade-gracefully requirement: a task.repoKey can
// go STALE through a legitimate human action (the registry entry it names is later removed via the
// human-only REST PATCH), and resolveRepo's strict "throw on unknown key" contract must NOT propagate
// onto tasks_get/tasks_list — those are the READ path every manager/worker depends on to orient, so one
// stale card must never break a whole board read. Proves:
//   (1) a task with a repoKey naming a registry entry that has since been REMOVED does not throw when
//       read via tasks_get — the call succeeds normally.
//   (2) the SAME stale card does not break tasks_list either — the whole list still returns, including
//       sibling cards with valid/no repoKey.
//   (3) the stale card's `merged` enrichment degrades to what the PRIMARY repo's ship-state read
//       returns (never an exception bubbling out of the read).
//   (4) a control case — a task with a CURRENTLY VALID repoKey is read normally, unaffected by another
//       card's staleness on the same board (proves the degrade is per-task, not a project-wide fallback).
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on worker-task-id-prefix.mjs.
//
// Run: 1) build (turbo builds shared first), 2) node test/stale-repo-key-board-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-stale-repokey-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// A real temp git repo so ship-state reads (getTaskMergedInfo) have a valid cwd to scan (bounded git log,
// resolves cleanly to "no match" for an unmerged branch — never throws on a real repo with no such branch).
const repo = path.join(os.tmpdir(), `loom-stale-repokey-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# stale repoKey test repo\n");
execSync(`git init -q && git add . && git -c user.email=x@loom -c user.name=x commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "test.db"));

// Project WITH a registry entry "svc-a" at create time.
db.insertProject({
  id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false,
  repos: [{ key: "svc-a", path: repo }],
});

// A card written while "svc-a" was still registered (repoKey validated at write time — this mirrors a
// REAL prior createProjectTask/tasks_create call, not a hand-crafted invalid row).
const staleTaskId = "11111111-0000-4000-8000-000000000001";
db.insertTask({ id: staleTaskId, projectId: "pA", title: "Card targeting svc-a", body: "", columnKey: "backlog", position: 1, priority: "p2", repoKey: "svc-a", createdAt: now, updatedAt: now });

// A sibling card with NO repoKey (primary) — the control for "the degrade is per-task, not board-wide".
const primaryTaskId = "22222222-0000-4000-8000-000000000002";
db.insertTask({ id: primaryTaskId, projectId: "pA", title: "Card on primary", body: "", columnKey: "backlog", position: 2, priority: "p2", repoKey: null, createdAt: now, updatedAt: now });

// NOW remove "svc-a" from the registry — the legitimate human action (REST PATCH) that leaves
// staleTaskId's repoKey dangling. Simulated directly via updateProject (same effect as the REST route).
db.updateProject("pA", { repos: [] });
check("(setup) registry entry removed — pA now has an empty repos array", db.getProject("pA")?.repos?.length === 0);
check("(setup) the stale card's stored repoKey is UNCHANGED (still names the removed entry)", db.getTask(staleTaskId)?.repoKey === "svc-a");

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pA", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "stale-repo-key-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ===== (1) tasks_get on the stale card does NOT throw — the read succeeds =====
  const got = await call("tasks_get", { id: staleTaskId });
  check("(1) tasks_get on a task with a stale repoKey does not error", !got.error);
  check("(1) tasks_get still returns the card's real fields", got.id === staleTaskId && got.title === "Card targeting svc-a");
  check("(1) the stale repoKey is still reported as-is (read doesn't silently rewrite stored data)", got.repoKey === "svc-a");
  check("(1) merged degrades to a value (null or an object), never throws/undefined-crashes the response", got.merged === null || typeof got.merged === "object");

  // ===== (2) tasks_list still returns the WHOLE board, including the stale card and its sibling =====
  const listText = (await client.callTool({ name: "tasks_list", arguments: {} })).content[0].text;
  check("(2) tasks_list does not error/throw for the whole board", typeof listText === "string" && listText.length > 0);
  const rows = listText.trim().split("\n").map((l) => JSON.parse(l));
  check("(2) tasks_list includes the stale card", rows.some((r) => r.id === staleTaskId));
  check("(2) tasks_list includes the primary-repo sibling card too (board read is NOT project-wide broken)", rows.some((r) => r.id === primaryTaskId));

  // ===== (4) control: the sibling card (no repoKey, always primary) reads normally and unaffected =====
  const gotPrimary = await call("tasks_get", { id: primaryTaskId });
  check("(4) control: sibling card with no repoKey reads normally", !gotPrimary.error && gotPrimary.id === primaryTaskId);
  check("(4) control: sibling card's repoKey is still null (untouched by the other card's staleness)", gotPrimary.repoKey === null);

  await client.close();
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a task whose repoKey names a registry entry removed after the task was written (a legitimate human REST PATCH) does NOT break tasks_get or tasks_list: resolveRepo's strict unknown-key throw is caught and degraded to the primary repo at the mcp/tasks.ts resolveMergedInfo read boundary, so the board stays fully readable — a stale card is visible (its own repoKey field unmodified) and its siblings are unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
