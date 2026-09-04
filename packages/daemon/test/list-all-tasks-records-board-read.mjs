import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e9750bc2 — the board-delta digest (card 9c8e256e / board-read.ts) never computed for a Platform
// Lead: `recordBoardRead`'s only call site was mcp/server.ts's `tasks_list` handler, which a Lead's own
// doctrine never calls — it reads the board through `list_all_tasks` (mcp/platform.ts) instead, whose
// handler had ZERO references to `recordBoardRead`. FIX: `list_all_tasks` now calls the new
// `recordBoardReadForProjects` for every project it scanned, on BOTH the row-returning path and the
// countsOnly path (the Lead's actual standing park-check convention).
//
// DELIBERATELY exercises ONLY `list_all_tasks` (never `tasks_list`) — per DoD-5, a test that only drives
// the tasks_list/manager path structurally cannot detect this bug, because that path already worked
// before this fix (see tasks-list-records-board-read.mjs for that sibling coverage).
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: mirrors list-all-tasks-ndjson-spill.mjs's harness — a REAL Db +
// SessionService against a FAKE pty (PtyHost createPty() seam), the REAL PlatformMcpRouter driven over
// in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves:
//   (A) POSITIVE CONTROL (DoD-5): before any list_all_tasks call, a Lead's delta for a project is NOT
//       COMPUTED; an unfiltered (aggregate) list_all_tasks call makes it COMPUTED for every project it
//       scanned, and a later delta shows a real, non-empty change made after that read.
//   (B) PER-PROJECT INDEPENDENCE (DoD-1's corollary): reading project A does not fabricate or corrupt a
//       snapshot for project B — B stays independently NOT COMPUTED until it is itself read (whether via
//       the aggregate or a projectId-narrowed call), and a LATER narrowed read of B alone does not disturb
//       A's already-recorded anchor.
//   (C) countsOnly ALSO anchors (DoD-2's decision): a countsOnly:true call on list_all_tasks records a
//       snapshot too — the Lead's cheapest, most-used park check must not leave the digest permanently
//       uncomputed.
//   (D) DoD-2's ACKNOWLEDGED HAZARD, demonstrated exactly: content read (T0) → a card changes → countsOnly
//       (T1, anchor moves without contents having been seen) → another card changes → digest (T2) reports
//       ONLY the T1→T2 change; the T0→T1 change is silently absorbed into "already seen" and never
//       separately surfaced. This is the trade-off platform.ts's own comment documents, not a bug.
//
// Run: 1) build (turbo builds shared first), 2) node test/list-all-tasks-records-board-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-latrbr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
registerForCleanup(tmpHome);
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { computeBoardDelta } = await import("../dist/orchestration/board-read.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-latrbr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
fs.writeFileSync(path.join(repo, "README.md"), "# list_all_tasks board-read test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=x@loom -c user.name=x");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});

db.insertTask({ id: "a-keep", projectId: "pA", title: "A keep", body: "", columnKey: "todo", position: 0, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: "b-keep", projectId: "pB", title: "B keep", body: "", columnKey: "todo", position: 0, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) { stop() {} }
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const platServer = new PlatformMcpRouter(db, svc).buildServer("PL");
const [pClientT, pServerT] = InMemoryTransport.createLinkedPair();
await platServer.connect(pServerT);
const platClient = new Client({ name: "latrbr-platform", version: "0" });
await platClient.connect(pClientT);
const callPlatform = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args })).content[0].text);
const nonTerminalOf = (projectId) => db.listTasks(projectId).filter((t) => t.columnKey !== "done");

try {
  // ===================== (A) POSITIVE CONTROL — not computed, then a real measured delta =====================
  check("(A) before any list_all_tasks call, pA's delta is NOT COMPUTED",
    computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA")).computed === false);
  check("(A) before any list_all_tasks call, pB's delta is NOT COMPUTED",
    computeBoardDelta(db, "PL", "pB", nonTerminalOf("pB")).computed === false);

  await callPlatform("list_all_tasks", {}); // unfiltered aggregate — scans EVERY live project, incl. home

  check("(A) after an unfiltered list_all_tasks call, pA's delta IS computed",
    computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA")).computed === true);
  check("(A) after an unfiltered list_all_tasks call, pB's delta IS computed",
    computeBoardDelta(db, "PL", "pB", nonTerminalOf("pB")).computed === true);
  check("(A) after an unfiltered list_all_tasks call, the HOME project's own delta IS computed too",
    computeBoardDelta(db, "PL", "pHome", nonTerminalOf("pHome")).computed === true);

  db.insertTask({ id: "a-new", projectId: "pA", title: "A new card", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const deltaA = computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA"));
  check("(A) a real change after the read shows up as a non-empty, real delta (structurally cannot pass against unmodified list_all_tasks)",
    deltaA.computed === true && deltaA.createdCount === 1 && deltaA.created[0].id === "a-new");

  // ===================== (B) per-project independence =====================
  // pB has had zero changes since the aggregate read above — its delta must stay a genuine measured ZERO,
  // never corrupted into a false "created" by pA's own snapshot/mutation above.
  const deltaBQuiet = computeBoardDelta(db, "PL", "pB", nonTerminalOf("pB"));
  check("(B) pB's delta is an untouched, genuine zero — pA's activity never leaks into pB's snapshot",
    deltaBQuiet.computed === true && deltaBQuiet.createdCount === 0 && deltaBQuiet.movedCount === 0);

  // Narrow a LATER read to pB alone — must NOT disturb pA's already-recorded anchor (still holding the
  // pre-"a-new" snapshot) or fold pA into "seen" without pA itself ever being re-read.
  db.insertTask({ id: "a-second", projectId: "pA", title: "A second new card", body: "", columnKey: "todo", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  await callPlatform("list_all_tasks", { projectId: "pB" });
  const deltaAStillPending = computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA"));
  check("(B) a projectId-narrowed read of pB does not touch pA's anchor — pA still shows BOTH unread changes",
    deltaAStillPending.computed === true && deltaAStillPending.createdCount === 2);

  // ===================== (C) countsOnly also anchors =====================
  const freshDb = "pB"; // reuse pB, now re-anchored fresh via countsOnly below
  db.insertTask({ id: "b-second", projectId: freshDb, title: "B second", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  await callPlatform("list_all_tasks", { projectId: "pB", countsOnly: true });
  const deltaBAfterCounts = computeBoardDelta(db, "PL", "pB", nonTerminalOf("pB"));
  check("(C) a countsOnly:true call re-anchors pB's snapshot to the CURRENT board (0 changes since, despite the just-added card)",
    deltaBAfterCounts.computed === true && deltaBAfterCounts.createdCount === 0);

  // ===================== (D) DoD-2's acknowledged hazard, demonstrated exactly =====================
  // T0: a genuine CONTENT read of pA (row-returning) — anchors pA to the board as it exists right now.
  await callPlatform("list_all_tasks", { projectId: "pA" });
  const t0Delta = computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA"));
  check("(D) sanity: T0's content read anchors pA to a clean zero", t0Delta.computed === true && t0Delta.createdCount === 0);

  // A card changes between T0 and T1 — the Lead has NOT seen this yet.
  db.insertTask({ id: "a-t0-t1", projectId: "pA", title: "changed between T0 and T1", body: "", columnKey: "todo", position: 3, priority: "p2", createdAt: now, updatedAt: now });

  // T1: countsOnly — the Lead's park check. It sees ONLY a count, never this card's contents, but the
  // anchor moves to T1 anyway (the documented trade-off).
  await callPlatform("list_all_tasks", { projectId: "pA", countsOnly: true });

  // Another card changes between T1 and T2 — the Lead has NOT seen this one either.
  db.insertTask({ id: "a-t1-t2", projectId: "pA", title: "changed between T1 and T2", body: "", columnKey: "todo", position: 4, priority: "p2", createdAt: now, updatedAt: now });

  // T2: the digest. It must report ONLY the T1→T2 change (a-t1-t2) — the T0→T1 change (a-t0-t1) is
  // silently folded into "already seen" by the countsOnly anchor move at T1 and is NEVER surfaced.
  const t2Delta = computeBoardDelta(db, "PL", "pA", nonTerminalOf("pA"));
  check("(D) HAZARD CONFIRMED: the digest at T2 reports exactly ONE created card (the T1→T2 change)",
    t2Delta.computed === true && t2Delta.createdCount === 1);
  check("(D) HAZARD CONFIRMED: the reported card is a-t1-t2 (seen only because it changed AFTER the countsOnly anchor)",
    t2Delta.created[0]?.id === "a-t1-t2");
  check("(D) HAZARD CONFIRMED: a-t0-t1 (the T0→T1 change, invisible to the countsOnly anchor) is NOT in the digest",
    !t2Delta.created.some((c) => c.id === "a-t0-t1"));
} finally {
  await platClient.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — list_all_tasks now records a per-(session,project) board-read anchor on both the row-returning and countsOnly paths, projects stay independently anchored, and the countsOnly anchor-moves-without-contents hazard is demonstrated exactly as documented."
  : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
