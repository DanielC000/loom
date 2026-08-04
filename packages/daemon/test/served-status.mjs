import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GAP 2 (manager tooling): the loom-orchestration `served_status` read — a deploy/served-state check so
// post-daemon_restart verification doesn't need curl. HERMETIC + CLAUDE-FREE, same shape as
// agent-get-append.mjs: a REAL Db + SessionService against a fake pty, and the REAL OrchestrationMcpRouter
// (manager role) over an in-process MCP InMemoryTransport (no HTTP, no daemon boot).
//
// Proves:
//   (1) with LOOM_WEB_DIST pointed at a staged dist dir holding assets/index-<hash>.js, served_status
//       returns that EXACT filename as `webBundle`, plus a `version` string and numeric uptimeSeconds;
//   (2) `liveSessionCount` reflects live sessions ACROSS ALL projects (not just the caller's own) — a
//       LIVE session in a FOREIGN project still counts, an EXITED one does not;
//   (3) with no web dist built/found (LOOM_WEB_DIST pointed at an empty dir), `webBundle` is null (never
//       throws) — the tool degrades gracefully instead of erroring.
//   (4) card 5e30c4bd (build clock fixed by c1072385): served_status ALSO returns `deployStaleness`,
//       wired end-to-end through the REAL MCP tool (not just the unit-level computeDeployStaleness —
//       see test/deploy-staleness.mjs for that), against a LOOM_REPO_ROOT-pointed fixture repo: a
//       packages/daemon/src commit committed AFTER this checkout's REAL build clock (the newest mtime
//       across packages/daemon/dist, read via a live computeDeployStaleness() probe — NOT dist/index.js
//       alone, which an incremental build can leave stale) ⇒ stale:true; rewound to BEFORE it ⇒
//       stale:false — both directions, over the actual tool response, proving the wiring (not just the
//       underlying helper) works.
//
// Run: 1) build (turbo builds shared first), 2) node test/served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Card 19fbeede: computeDeployStaleness() degrades to {available:false, reason} on ANY failure (git
// timeout, no .git checkout, missing dist entry, ...) — a bare `available === true` check discards the
// one field that explains why it wasn't, so a gate-tail failure names only the symptom, never the cause.
// Appends " — reason: ..." to the label ONLY when `reason` is actually present (i.e. available was
// unexpectedly false) — on the healthy/green path (available:true, reason undefined) this is a no-op, so
// a passing run's output stays byte-unchanged (DoD #2).
const reasonSuffix = (result) => result?.reason ? ` — reason: ${JSON.stringify(result.reason)}` : "";

const tmpHome = path.join(os.tmpdir(), `loom-svst-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// Stage a fake web dist BEFORE importing dist (resolveWebDistDir reads LOOM_WEB_DIST at CALL time, but
// set it up front for clarity) — assets/index-<hash>.js is what Vite actually produces.
const fakeDist = path.join(tmpHome, "web-dist");
fs.mkdirSync(path.join(fakeDist, "assets"), { recursive: true });
fs.writeFileSync(path.join(fakeDist, "index.html"), "<html></html>");
fs.writeFileSync(path.join(fakeDist, "assets", "index-DEADBEEF.js"), "/* fake bundle */");
fs.writeFileSync(path.join(fakeDist, "assets", "index-DEADBEEF.css"), "/* fake styles */");
process.env.LOOM_WEB_DIST = fakeDist;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { computeDeployStaleness } = await import("../dist/deploy-staleness.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

db.insertProject({ id: "pMine", name: "Mine", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "aMine", projectId: "pMine", name: "Dev", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "aOther", projectId: "pOther", name: "OtherDev", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "aOther2", projectId: "pOther", name: "OtherDev2", startupPrompt: "", position: 1, profileId: null });

db.insertSession({
  id: "M", projectId: "pMine", agentId: "aMine", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});
// A LIVE session in a FOREIGN project — must still count (cross-project by design).
db.insertSession({
  id: "sForeignLive", projectId: "pOther", agentId: "aOther", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: null,
});
// An EXITED session — must NOT count.
db.insertSession({
  id: "sForeignExited", projectId: "pOther", agentId: "aOther2", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: null,
});

const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());
const router = new OrchestrationMcpRouter(db, svc);
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "served-status-test", version: "0" });
await client.connect(clientT);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text);

// ===================== (4) fixture: LOOM_REPO_ROOT-pointed repo for the deployStaleness end-to-end check.
// computeDeployStaleness() (called with NO overrides from served_status) always reads THIS checkout's
// REAL build clock — since card c1072385, that's the NEWEST mtime across every file recursively under
// packages/daemon/dist (an incremental `tsc` build means dist/index.js's OWN mtime is NOT this clock —
// see deploy-staleness.ts's module doc). Probe the REAL clock by calling computeDeployStaleness() with NO
// overrides at all (before LOOM_REPO_ROOT is pointed at the fixture repo below, so this reads the actual
// checkout) and anchor fixture commit dates relative to its real distBuiltAt, so the STALE/CLEAN split is
// deterministic either way without hardcoding an assumption about which single file is newest.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realBuildProbe = computeDeployStaleness();
check("(4-setup) real-tree probe: this checkout's own daemon dist is a real source checkout" + reasonSuffix(realBuildProbe), realBuildProbe.available === true);
const realDistMtimeMs = new Date(realBuildProbe.distBuiltAt).getTime();
// Card c241d54b — SECONDARY hardening (the production fix is in deploy-staleness.ts itself): refuse an
// implausible distBuiltAt LOUDLY here rather than silently deriving a pre-1970 GIT_AUTHOR_DATE below and
// letting git's own opaque "invalid date format" rejection be the first sign anything was wrong — that
// exact opaque failure is what let deploy-staleness.ts's `?? 0` epoch-coercion (now fixed) pass this suite
// undetected. This is a sanity check on THIS test's own fixture derivation, not a substitute for the fix.
if (!(realDistMtimeMs > Date.parse("2020-01-01T00:00:00Z"))) {
  throw new Error(`(4-setup) real-tree probe returned an implausible distBuiltAt (${realBuildProbe.distBuiltAt}) — refusing to derive GIT_AUTHOR_DATE fixture dates from it`);
}
// Positive control (DoD 2): dist/index.js's own mtime must NOT equal the directory-wide build clock on
// a real incremental build — if they coincide, this checkout's dist doesn't exhibit the class of bug this
// card fixes, and comparing a fixture to a fixture (the old test's blind spot) would be all we could prove.
const realIndexJsMtimeMs = fs.statSync(path.join(__dirname, "..", "dist", "index.js")).mtime.getTime();
if (realIndexJsMtimeMs === realDistMtimeMs) {
  console.log("SKIP  (4-setup) dist/index.js mtime coincides with the directory-wide build clock on this checkout (e.g. a fresh full build) — the real-tree positive control for the incremental-build class of bug is inconclusive here, not exercised. See test/deploy-staleness.mjs's own (rebuild-then-touch) real-tree assertion for the always-exercisable version of this control.");
} else {
  check("(4-setup) real-tree positive control: dist/index.js mtime genuinely DIFFERS from max(dist/**) on this checkout (proves the bug class is real, not just a fixture artifact)", true);
}
const beforeBuild = new Date(realDistMtimeMs - 60_000).toISOString();
const afterBuild = new Date(realDistMtimeMs + 60_000).toISOString();
const stalenessRepo = path.join(os.tmpdir(), `loom-svst-stalenessrepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(stalenessRepo, "packages", "daemon", "src"), { recursive: true });
const gitStale = (args, dateIso) => execSync(`git ${args}`, {
  cwd: stalenessRepo,
  env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
});
gitStale("init -q");
gitStale('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', beforeBuild);

try {
  // ===================== (1) + (2) staged dist + cross-project live count =====================
  const status = await call("served_status");
  check("(1) served_status returns the staged bundle filename", status.webBundle === "index-DEADBEEF.js");
  check("(1) served_status returns a version string", typeof status.version === "string" && status.version.length > 0);
  check("(1) served_status returns a numeric uptimeSeconds", typeof status.uptimeSeconds === "number" && status.uptimeSeconds >= 0);
  // "M" (live, pMine) + "sForeignLive" (live, pOther) count; "sForeignExited" (exited) does not.
  check("(2) liveSessionCount counts live sessions ACROSS projects, excluding non-live", status.liveSessionCount === 2);

  // ===================== (3) no dist found → webBundle null, no throw =====================
  const emptyDist = path.join(tmpHome, "empty-dist");
  fs.mkdirSync(emptyDist, { recursive: true });
  process.env.LOOM_WEB_DIST = emptyDist;
  const statusEmpty = await call("served_status");
  check("(3) an unbuilt/missing web dist → webBundle: null (no throw)", statusEmpty.webBundle === null);

  // ===================== (4) deployStaleness, wired end-to-end through the real MCP tool =====================
  process.env.LOOM_REPO_ROOT = stalenessRepo;
  const statusClean = await call("served_status");
  check("(4) no daemon/src commits after the real dist build ⇒ deployStaleness.available:true, stale:false" + reasonSuffix(statusClean.deployStaleness), statusClean.deployStaleness?.available === true && statusClean.deployStaleness?.stale === false);
  check("(4) clean: commitsBehind is 0", statusClean.deployStaleness?.commitsBehind === 0);
  check("(4) served_status does NOT rely on version/webBundle for this — both stay whatever they already were (DoD #8's own proof point)", typeof statusClean.version === "string" && "webBundle" in statusClean);

  fs.writeFileSync(path.join(stalenessRepo, "packages", "daemon", "src", "foo.ts"), "export const foo = 1;\n");
  gitStale("add packages/daemon/src/foo.ts");
  gitStale('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add foo"', afterBuild);
  const statusStale = await call("served_status");
  check("(4) a daemon/src commit AFTER the real dist build ⇒ deployStaleness.stale:true" + reasonSuffix(statusStale.deployStaleness), statusStale.deployStaleness?.available === true && statusStale.deployStaleness?.stale === true);
  check("(4) stale: commitsBehind counts the new commit", statusStale.deployStaleness?.commitsBehind === 1);
  check("(4) stale: mainlineHeadSha is a real 40-char sha", /^[0-9a-f]{40}$/.test(statusStale.deployStaleness?.mainlineHeadSha ?? ""));

  delete process.env.LOOM_REPO_ROOT;
  const statusNoRepoRoot = await call("served_status");
  check("(4) LOOM_REPO_ROOT unset ⇒ deployStaleness still present (falls back to the real monorepo root) and never throws", statusNoRepoRoot.deployStaleness !== undefined);
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
  try { fs.rmSync(stalenessRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status returns the served web bundle's index-<hash>.js filename (or null when the dist isn't built/found, never throwing), a version string, uptimeSeconds, and a cross-project liveSessionCount."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
