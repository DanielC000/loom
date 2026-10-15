import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1731ab5b (epic f437d4e9 C2) — `resolveLiveLeadHome` (packages/daemon/src/projects/live-lead-home.ts)
// routes `platformEscalate`, the stuck-manager Lead-notify helper, and every `PlatformMcpRouter`/
// orchestration-router tool description/error string through whichever platform-tier home is actually
// LIVE for this install, instead of hardcoding the dev "Loom Platform" home. Pre-fix, `platformEscalate`
// THREW "no reserved Loom Platform project exists — cannot escalate" on EVERY non-dev install, since
// `seedPlatformHome` never seeds that home without LOOM_DEV.
//
// Code Review round 2 (MAJOR): round 1 shipped `resolveLivePlatformHome(db) ?? resolveLiveSetupHome(db)`
// — a cross-fallback. Nothing archives the dev "Loom Platform" home when LOOM_DEV flips 1 → 0 (e.g. the
// owner's own `LOOM_DEV=0 pnpm daemon:stable` path), so an install that ever booted with LOOM_DEV=1 keeps
// that row forever, and the `??` would keep routing a later non-dev boot's escalations/nudges to the
// STALE dev row instead of the end-user Lead's own home. RULING: STRICT mutual exclusion on `isLoomDev()`
// — never a cross-fallback either way.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService (+ a REAL PlatformMcpRouter for
// the DoD-3 rendered-text scan) driven directly; escalation-status.mjs / platform-messaging.mjs already
// cover the ordinary dev-home tool-surface wiring — this file is scoped to the home-RESOLUTION fix itself.
//
// Proves:
//   (DoD-1) on a NON-DEV install (LOOM_DEV unset, only the end-user "Platform" home exists — never the
//       dev "Loom Platform" home) platform_escalate does NOT throw: it lands on the end-user Lead's OWN
//       home board, and escalation_status reads it back correctly.
//   (finding-1a/1b) STRICT mutual exclusion, same fixture (BOTH homes exist side by side): (a) LOOM_DEV
//       unset ⇒ resolveLiveLeadHome/platform_escalate resolve the SETUP home; (b) LOOM_DEV=1 ⇒ they
//       resolve the DEV home. The flag alone decides — never which row happens to still be present.
//   (finding-1c) a DEV install (LOOM_DEV=1) with NO dev home seeded, even though the end-user setup home
//       DOES exist: platform_escalate still THROWS (never falls back to the setup home just because the
//       "right" home for this install type is absent), and the stuck-manager notify helper
//       (exercised via the real `handleClaudeBootDialogStuck` entry point) returns leadNotified:false
//       with NO task filed anywhere — not even on the setup home that's sitting right there.
//   (negative control) with NEITHER home seeded at all, platform_escalate still throws — and the thrown
//       text names no install-specific home title.
//   (DoD-3, raw source) a source-text scan of mcp/platform.ts's registered tool descriptions/error
//       strings finds ZERO hardcoded "Loom Platform"/"Getting Started" references AND zero reintroduced
//       `PLATFORM_PROJECT_NAME` interpolations (Code Review finding 4: the pre-fix shape for two of the
//       five sites was an INTERPOLATION, not a literal substring — a bare name-literal scan can't catch a
//       re-added reference to that constant) — positive-controlled against the real pre-fix source shape.
//   (DoD-3, rendered — PREFERRED per Code Review finding 4) a REAL PlatformMcpRouter is built and its
//       REGISTERED tool descriptions are read back over a real MCP client (`tools/list`) — this scan is
//       interpolation-proof BY CONSTRUCTION: whatever ends up in a rendered description, literal or
//       interpolated, must appear as plain text once rendered, so it can never miss a future reintroduced
//       interpolation the way a raw-source literal scan could.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-end-user-lead-home.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

const tmpHome = path.join(os.tmpdir(), `loom-esc-euh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveLiveLeadHome } = await import("../dist/projects/live-lead-home.js");

// No live Lead in any of these scenarios — enqueueStdin should never be reached (there is no role
// "platform" / processState "live" session anywhere in these fixtures).
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
}
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {},
  onExit() {},
};

// Each scenario below gets its OWN sqlite file (never the shared default `DB_PATH`) — `new Db()` with no
// arg always reopens the SAME file under this test's one LOOM_HOME, so bare `new Db()` calls across
// scenarios would silently share state (a leftover reserved project from an EARLIER block resolving in a
// LATER one that means to test a different home-existence shape). A fresh, uniquely-named file per block
// is genuine isolation. (The finding-1a/1b block below deliberately reuses ONE db across its two halves —
// that sharing is the POINT there: it proves the SAME underlying rows resolve differently purely because
// the flag changed.)
let dbSeq = 0;
const freshDb = () => new Db(path.join(tmpHome, `euh-${++dbSeq}.sqlite`));

const now = new Date().toISOString();
const mkMgr = (db, id, projectId, agentId) => {
  db.insertAgent({ id: agentId, projectId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
};

// ===================== (DoD-1) NON-DEV install: only the end-user "Platform" home exists ================
{
  delete process.env.LOOM_DEV;
  const db = freshDb();
  const setupHomeId = "euh-setup-home-1";
  db.insertProject({ id: setupHomeId, name: "Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "euh-ord-1", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  mkMgr(db, "EUH1_MGR", "euh-ord-1", "euh1-agent");

  check("(DoD-1 resolver) resolveLiveLeadHome resolves the end-user setup home (no dev home exists)",
    resolveLiveLeadHome(db)?.id === setupHomeId);

  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());

  let thrown = null;
  let esc;
  try {
    esc = svc.platformEscalate("EUH1_MGR", { title: "DoD-1: non-dev install escalation", detail: "evidence line", severity: "high" });
  } catch (err) {
    thrown = err;
  }
  check("(DoD-1) platform_escalate does NOT throw on a non-dev install", thrown === null);
  check("(DoD-1) platform_escalate lands on the end-user Platform home, never a hardcoded dev home", esc?.projectId === setupHomeId);
  const task = esc ? db.getTask(esc.taskId) : undefined;
  check("(DoD-1) the filed task genuinely lives on that home's own board", task?.projectId === setupHomeId);

  const status = await svc.escalationStatus("EUH1_MGR", {});
  check("(DoD-1) escalation_status reads the escalation back", status.found === true);
  check("(DoD-1) the read-back row names the same task, status pending",
    status.found === true && "escalations" in status && status.escalations.some((e) => e.taskId === esc.taskId && e.status === "pending"));
}

// ===================== (finding-1a / finding-1b) STRICT mutual exclusion on ONE shared fixture: BOTH =====
// =====================     homes exist side by side — the LOOM_DEV flag ALONE decides which resolves, ===
// =====================     never which row happens to still be present (the round-1 `??` bug this ========
// =====================     round-2 ruling replaces). =========================================================
{
  const db = freshDb();
  const devHomeId = "euh-dev-home-ab";
  const setupHomeId = "euh-setup-home-ab";
  db.insertProject({ id: devHomeId, name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: setupHomeId, name: "Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "euh-ord-ab", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  mkMgr(db, "EUH_AB_MGR_A", "euh-ord-ab", "euh-ab-agent-a");
  mkMgr(db, "EUH_AB_MGR_B", "euh-ord-ab", "euh-ab-agent-b");

  // (a) LOOM_DEV unset ⇒ the SETUP home, even though the dev home ALSO exists right there.
  delete process.env.LOOM_DEV;
  check("(finding-1a resolver) BOTH homes exist, LOOM_DEV unset ⇒ resolveLiveLeadHome resolves the SETUP home",
    resolveLiveLeadHome(db)?.id === setupHomeId);
  const svcA = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  const escA = svcA.platformEscalate("EUH_AB_MGR_A", { title: "finding-1a: LOOM_DEV unset", detail: "evidence", severity: "high" });
  check("(finding-1a) platform_escalate lands on the SETUP home when LOOM_DEV is unset, even with the dev home present",
    escA.projectId === setupHomeId);

  // (b) LOOM_DEV=1 ⇒ the DEV home, even though the setup home ALSO still exists right there.
  process.env.LOOM_DEV = "1";
  check("(finding-1b resolver) the SAME two rows, LOOM_DEV=1 ⇒ resolveLiveLeadHome now resolves the DEV home",
    resolveLiveLeadHome(db)?.id === devHomeId);
  const svcB = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  const escB = svcB.platformEscalate("EUH_AB_MGR_B", { title: "finding-1b: LOOM_DEV=1", detail: "evidence", severity: "high" });
  check("(finding-1b) platform_escalate lands on the DEV home when LOOM_DEV=1, even with the setup home present",
    escB.projectId === devHomeId);
  delete process.env.LOOM_DEV;
}

// ===================== (finding-1c) DEV install (LOOM_DEV=1), NO dev home seeded, but the end-user setup =
// =====================     home DOES exist: platform_escalate still THROWS — it must never fall back to ==
// =====================     the "wrong" home just because the "right" one for this install type is absent.
{
  process.env.LOOM_DEV = "1";
  const db = freshDb();
  const setupHomeId = "euh-setup-home-1c";
  db.insertProject({ id: setupHomeId, name: "Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "euh-ord-1c", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  mkMgr(db, "EUH1C_MGR", "euh-ord-1c", "euh1c-agent");

  check("(finding-1c resolver) LOOM_DEV=1 with no dev home ⇒ resolveLiveLeadHome resolves nothing, even though the setup home exists",
    resolveLiveLeadHome(db) === undefined);

  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  let errMsg = null;
  try { svc.platformEscalate("EUH1C_MGR", { title: "finding-1c: dev install, no dev home", detail: "evidence" }); }
  catch (err) { errMsg = err.message; }
  check("(finding-1c) platform_escalate STILL throws — never silently falls back to the setup home", typeof errMsg === "string");
  check("(finding-1c) zero tasks were filed on the setup home by platform_escalate", db.listTasks(setupHomeId).length === 0);

  // The stuck-manager Lead-notify helper, exercised through its real public entry point.
  svc.handleClaudeBootDialogStuck("EUH1C_MGR", { timeoutMs: 150_000, signatureName: "workspace-trust", role: "manager" });
  const stuckEvents = db.listEventsForWorker("EUH1C_MGR").filter((e) => e.kind === "claude_boot_dialog_stuck");
  check("(finding-1c) the stuck-manager durable event still fires (event-only, never a crash)", stuckEvents.length === 1);
  check("(finding-1c) leadNotified:false — no dev home to notify through, even though the setup home exists",
    stuckEvents[0]?.detail?.leadNotified === false);
  check("(finding-1c) no leadBoardTaskId was filed", stuckEvents[0]?.detail?.leadBoardTaskId === undefined);
  check("(finding-1c) zero tasks were filed on the setup home by the stuck-manager path either", db.listTasks(setupHomeId).length === 0);
  delete process.env.LOOM_DEV;
}

// ===================== (negative control) NEITHER home seeded: still throws, names no install-specific =
// =====================                    home title. =====================================================
{
  delete process.env.LOOM_DEV;
  const db = freshDb();
  db.insertProject({ id: "euh-ord-3", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  mkMgr(db, "EUH3_MGR", "euh-ord-3", "euh3-agent");

  check("(negative control, resolver) resolveLiveLeadHome resolves nothing when no platform-tier home exists",
    resolveLiveLeadHome(db) === undefined);

  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  let errMsg = null;
  try { svc.platformEscalate("EUH3_MGR", { title: "no home at all", detail: "x" }); }
  catch (err) { errMsg = err.message; }
  check("(negative control) with no platform-tier home at all, platform_escalate still throws", typeof errMsg === "string");
  check("(negative control) the thrown error names no install-specific home title",
    typeof errMsg === "string" && !errMsg.includes("Loom Platform") && !errMsg.includes("Getting Started"));
}

// ===================== (DoD-3, raw source) mcp/platform.ts's tool text must never hardcode either reserved
// =====================                    home's display name, OR reference PLATFORM_PROJECT_NAME (Code ==
// =====================                    Review finding 4 — an interpolation is invisible to a bare ======
// =====================                    literal-name scan). Positive-controlled first. =====================
{
  const platformTsPath = path.join(SRC_DIR, "mcp", "platform.ts");
  const src = fs.readFileSync(platformTsPath, "utf8");
  const BAD_NAME_RE = /Loom Platform|Getting Started|PLATFORM_PROJECT_NAME/;

  // Positive control, using the EXACT pre-fix string/source shapes this card removed (read directly off
  // git HEAD before the fix, never reconstructed from memory) — proves the pattern can fire before
  // trusting its zero below. Two are literal substrings; the third is the REAL interpolation shape
  // (card Code Review finding 4) — the raw TS source for those two sites never literally contained "Loom
  // Platform" at all, only the `PLATFORM_PROJECT_NAME` identifier, which is exactly what a bare
  // literal-name scan would have missed.
  const PRE_FIX_SNIPPETS = [
    'cannot rename a reserved/system project (the Loom Platform home) — renaming stays human-REST-only',
    'cannot archive a reserved/system project (the Loom Platform home)',
    'no reserved Loom Platform project exists — cannot resolve resolvesEscalation',
    String.raw`"\"" + PLATFORM_PROJECT_NAME + "\" board — never a task on the destination board) to STRUCTURALLY " +`,
  ];
  for (const snippet of PRE_FIX_SNIPPETS) {
    check(`(DoD-3 raw positive control) the scan pattern fires against the real pre-fix text: ${JSON.stringify(snippet.slice(0, 50))}…`, BAD_NAME_RE.test(snippet));
  }
  check("(DoD-3 raw) mcp/platform.ts source carries ZERO hardcoded \"Loom Platform\"/\"Getting Started\" references or PLATFORM_PROJECT_NAME tokens",
    !BAD_NAME_RE.test(src));
}

// ===================== (DoD-3, rendered — PREFERRED) connect a REAL PlatformMcpRouter and read back its ==
// =====================                    ACTUAL registered tool descriptions over a real MCP client. =====
// =====================                    Interpolation-proof by construction: whatever text a tool's ====
// =====================                    description renders to, literal or interpolated, must appear ===
// =====================                    as plain text here. =================================================
{
  const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const BAD_NAME_RE = /Loom Platform|Getting Started/;
  check("(DoD-3 rendered positive control) the rendered-text scan pattern CAN fire (sanity check against a synthetic bad description)",
    BAD_NAME_RE.test('resolved on YOUR OWN "Loom Platform" board — never a task on the destination board'));

  const scanDb = freshDb();
  const scanSvc = new SessionService(scanDb, new SeamHost(events), new OrchestrationControl());
  const router = new PlatformMcpRouter(scanDb, scanSvc); // 2-arg: GitWriter falls back to its bounded module-const defaults

  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "dod3-rendered-scan", version: "0" });
  await client.connect(clientT);
  const tools = (await client.listTools()).tools;
  check("(DoD-3 rendered) the router actually registered a non-trivial tool surface (sanity: scan isn't vacuous)", tools.length > 10);
  const offenders = tools.filter((t) => BAD_NAME_RE.test(t.description ?? ""));
  check(`(DoD-3 rendered) EVERY registered PlatformMcpRouter tool's RENDERED description is free of "Loom Platform"/"Getting Started" (offenders: ${offenders.map((t) => t.name).join(", ") || "none"})`,
    offenders.length === 0);
  await client.close();
  await server.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveLiveLeadHome is a STRICT mutual-exclusion resolver (LOOM_DEV alone decides, never a cross-fallback): platform_escalate/the stuck-manager notify helper land on the end-user Platform home on a non-dev install and on the dev Loom Platform home on a dev install, even when BOTH homes coexist on the same fixture (the round-1 `??` bug this ruling replaces); a dev install with no dev home never falls back to an available setup home; neither home existing still throws cleanly with no install-specific name; and mcp/platform.ts's own tool text — scanned both as raw source (incl. a reintroduced PLATFORM_PROJECT_NAME interpolation) and as REAL rendered tools/list descriptions over a live MCP client — never hardcodes either reserved home's display name."
  : `\n🛑 ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
