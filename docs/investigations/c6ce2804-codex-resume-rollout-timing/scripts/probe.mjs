// Card c6ce2804 — RELOCATED here from packages/daemon/test/codex-resume-real-spawn.mjs (removed from
// CODEX_REAL_SPAWN_BASENAMES the same commit that moved it). It was written as a real-spawn REGRESSION
// test proving `createCodexPty`'s new `resume <uuid>` wiring genuinely continues a prior conversation
// (via engine-session-id continuity — see findings.md, sibling of this script, for the full method and
// the discriminator-design reasoning). Run TWICE against a real, authenticated codex install (once with
// no MCP gateway, once with a real in-process one) and BOTH times it went red the same way: a codex
// session that reaches ready state and exits cleanly with ZERO turns run writes NO rollout file at all —
// confirmed directly on disk (~/.codex/sessions/), not inferred — so there is never an engine-session id
// to resume with, and the actual resume claim (spawn B's exit id matching spawn A's) could never be
// reached.
//
// WHY IT DOES NOT BELONG IN THE CERTIFIED CORPUS: a test that CANNOT currently pass must not sit in
// CODEX_REAL_SPAWN_BASENAMES — left there it would spend THREE real codex spawns on every full gate,
// forever, and return no signal: a permanent cost masquerading as coverage (card 605f002d already made
// exactly this argument about a different real-codex probe). This is a genuine, disclosed, currently-
// UNRESOLVED gap in end-to-end verification, not a test-authoring defect — see findings.md for what is
// established vs. merely inferred, and docs/design/multi-harness-parity-matrix.md's DoD-4 entry for the
// residual gap stated where a future reader will actually see it.
//
// DELIBERATELY NOT placed under packages/daemon/test/ and NOT wired into scripts/test-daemon.mjs or
// CODEX_REAL_SPAWN_BASENAMES — mirrors fedef6a0-codex-spurious-retry-forced-probe's own posture exactly
// (see that probe's own header for the same reasoning, restated here because it's the load-bearing
// property of this file's location). Run manually, under the shared real-codex lock, only when explicitly
// granted a window — the SAME lock every certified real-codex-spawn test in packages/daemon/test/ uses,
// imported by absolute path below since this script no longer lives alongside it.
//
// ZERO MODEL TURNS SPENT, BY DESIGN — and that is exactly what this probe's own result could not get past:
// this file never calls enqueueStdin/submitCodex. Whether a real turn actually produces a rollout file
// (the disclosed hedge in captureCodexEngineSessionId's own doc, "created lazily, around first-turn time,
// not at boot") remains UNVERIFIED — nobody has spent that turn. Do not read this file's own history as
// having established that; it only established the negative (zero turns ⇒ zero rollout file, twice).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

// Resolve paths dynamically off this file's own location rather than a hand-counted relative literal —
// self-verifying (fails loudly below if any of these don't exist, instead of a confusing MODULE_NOT_FOUND
// several directories away from the real mistake).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TEST_DIR = path.join(REPO_ROOT, "packages/daemon/test");
const DIST_DIR = path.join(REPO_ROOT, "packages/daemon/dist");
const DIST_PTY_DIR = path.join(DIST_DIR, "pty");
for (const p of [TEST_DIR, DIST_DIR, DIST_PTY_DIR]) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: expected path does not exist: ${p} (REPO_ROOT resolved to ${REPO_ROOT} — is this script still at docs/investigations/<card>/scripts/probe.mjs?)`);
    process.exit(2);
  }
}
const importFrom = (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

const { mkdtempManaged, finishAndExit } = await importFrom(TEST_DIR, "_tmp-fixture.mjs");
await importFrom(TEST_DIR, "_guard.mjs"); // arms LOOM_TEST=1 + the Db prod-guard backstop — see that file's own header
const { waitUntil } = await importFrom(TEST_DIR, "_wait.mjs");
const { acquireCodexRealSpawnLock } = await importFrom(TEST_DIR, "_codex-real-spawn-lock.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await importFrom(DIST_PTY_DIR, "resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. -----------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  c6ce2804 codex-resume probe — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}).`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-resume-probe-");
process.env.LOOM_HOME = TMP;

// --- Stand up a REAL, in-process gateway (mirrors codex-mcp-reachability-real-spawn.mjs) so codex's own
// MCP handshake genuinely completes instead of hanging — zero model turns, this is HTTP wiring only. This
// is the SECOND of the two conditions this probe was run under (see findings.md); it did not change the
// outcome, but is left wired in so a future re-run starts from the stronger condition, not the weaker one.
const { Db } = await importFrom(DIST_DIR, "db.js");
const { buildServer } = await importFrom(path.join(DIST_DIR, "gateway"), "server.js");
const { TaskMcpRouter } = await importFrom(path.join(DIST_DIR, "mcp"), "server.js");

const SESSION_IDS = ["codex-resume-a", "codex-resume-b", "codex-resume-c"];
const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
for (const id of SESSION_IDS) {
  db.insertSession({
    id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
}

// A cheap "reply fast, never hang" stub for every router besides loom-tasks — this probe only cares that
// codex's OTHER mounted server (loom-orchestration, for a worker role) never blocks the boot waiting on a
// connect attempt; it does not need to actually work, and codex counting it as unconnected is fine.
const stubHandle = async (_reqRaw, replyRaw) => {
  try {
    replyRaw.statusCode = 501;
    replyRaw.setHeader("content-type", "application/json");
    replyRaw.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "not implemented in this probe" } }));
  } catch { /* response already ended — ignore */ }
};
const stubRouter = { handle: stubHandle, closeCompanionTrustWindow: () => {} };

const app = await buildServer({
  db, pty: { markMcpSeen: () => {}, recordToolCallArgsHash: () => {} }, sessions: {},
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stubRouter, platformMcp: stubRouter, auditMcp: stubRouter, userAuditMcp: stubRouter,
  setupMcp: stubRouter, operatorMcp: stubRouter, runMcp: stubRouter,
  control: {}, usageStatus: {}, requestShutdown: () => {},
});
await app.listen({ port: 0, host: "127.0.0.1" });
const { port: gatewayPort } = app.server.address();
// PtyHost's own module-level PORT constant (paths.ts) is resolved ONCE, at first import, from
// process.env.LOOM_PORT — so this MUST be set before dist/pty/host.js is ever imported in this process
// (the import below is that first import). This is what makes buildMcpServers() point codex's real MCP
// args at THIS in-process gateway instead of the (nonexistent, in this probe) default daemon port.
process.env.LOOM_PORT = String(gatewayPort);

const { PtyHost } = await importFrom(DIST_PTY_DIR, "host.js");

// --- md5-before (real ~/.codex/config.toml) -----------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

// Serialize against any sibling real-codex-spawn test file — see _codex-real-spawn-lock.mjs's own header.
const releaseCodexLock = await acquireCodexRealSpawnLock();

// Matches either exit-hint form the probe (a7d74718, findings.md State 6) observed: a no-turn session
// prints "Session ID: <uuid>"; a session with an actual turn in flight prints "To continue this session,
// run: codex resume <uuid>".
const EXIT_ID_RE = /(?:Session ID:\s*|codex resume\s+)([0-9a-fA-F-]{36})/;

/** Spawn a codex session (fresh, or resuming `resumeId`), wait for real readiness, capture its
 *  engine-session id (via events.onEngineSessionId), then gracefully stop it and capture the uuid codex
 *  prints on its own exit screen. Returns { capturedEngineId, exitPrintedId, exitCode }. Zero model turns. */
async function runOneCodexLifecycle(sessionId, cwd, resumeId) {
  let capturedEngineId = null;
  const exitedSessions = new Map();
  const events = {
    onEngineSessionId(_sid, engineId) { capturedEngineId = engineId; },
    onContextStats() {}, onRateLimited() {}, onBusy() {},
    onExit(sid, code, info) { exitedSessions.set(sid, { code, intended: info.intended }); },
  };
  const host = new PtyHost(events);

  let buf = "";
  host.spawn({
    sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
    ...(resumeId ? { resumeId } : {}),
  });
  const unsubscribe = host.subscribe(sessionId, { onData: (chunk) => { buf += chunk.toString("utf-8"); }, onControl: () => {} });

  await waitUntil(() => buf.includes("Ask Codex to do anything"), {
    label: `${sessionId} real codex TUI reaches its ready state (resumeId=${resumeId ?? "none"})`,
    timeoutMs: 20000,
  });

  await waitUntil(() => capturedEngineId !== null, {
    label: `${sessionId} engine-session-id discovery (captureCodexEngineSessionId) finds an id`,
    timeoutMs: 15000,
  }).catch((err) => {
    console.log(`[info] ${sessionId} engine-session-id discovery did not complete within budget: ${err.message}`);
  });

  host.stop(sessionId, "graceful");
  await waitUntil(() => exitedSessions.has(sessionId), { label: `${sessionId} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(sessionId);
  unsubscribe();

  const exitMatch = EXIT_ID_RE.exec(buf);
  return { capturedEngineId, exitPrintedId: exitMatch ? exitMatch[1] : null, exitCode: exit.code, buf };
}

// --- Spawn A: fresh. Establishes a real conversation + attempts to capture its engine-session id. -------
const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-resume-probe-cwd-a-"));
const a = await runOneCodexLifecycle("codex-resume-a", cwdA, undefined);
check("spawn A (fresh) exited cleanly (code 0)", a.exitCode === 0);
check("spawn A's engine-session id was discovered by this project's own capture mechanism", typeof a.capturedEngineId === "string" && a.capturedEngineId.length > 0);
check("spawn A's own exit screen printed an id", typeof a.exitPrintedId === "string");
if (a.capturedEngineId && a.exitPrintedId) {
  check("spawn A: this project's OWN discovery mechanism agrees with codex's own self-reported exit id", a.capturedEngineId === a.exitPrintedId);
}

// --- Spawn B: resume A's id, into the SAME cwd. Never reached in either recorded run — see findings.md. --
let b = { exitCode: null, exitPrintedId: null };
if (a.capturedEngineId) {
  b = await runOneCodexLifecycle("codex-resume-b", cwdA, a.capturedEngineId);
  check("spawn B (resume) exited cleanly (code 0)", b.exitCode === 0);
  check("spawn B's own exit screen printed an id", typeof b.exitPrintedId === "string");
  if (b.exitPrintedId) {
    check(
      "*** THE ACTUAL CLAIM *** spawn B's exit-printed id equals the id it was asked to resume (id continuity ONLY — with zero model turns this cannot observe whether conversational context/state actually came back)",
      b.exitPrintedId === a.capturedEngineId,
    );
  }
} else {
  console.log("SKIP  spawn B (resume) — spawn A's engine-session id was never discovered, nothing to resume with");
  failures++;
}

// --- Spawn C: fresh again, negative control. -------------------------------------------------------------
const cwdC = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-resume-probe-cwd-c-"));
const c = await runOneCodexLifecycle("codex-resume-c", cwdC, undefined);
check("spawn C (fresh, unrelated) exited cleanly (code 0)", c.exitCode === 0);
if (a.capturedEngineId && c.exitPrintedId) {
  check("NEGATIVE CONTROL: spawn C got its OWN distinct id, different from spawn A's", c.exitPrintedId !== a.capturedEngineId);
}

releaseCodexLock();
await app.close();
db.close();

// --- md5-diff-disclose ------------------------------------------------------------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const cur = readConfig();
  const h = cur ? md5(cur) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'(?:${escapeRegex(cwdA.toLowerCase())}|${escapeRegex(cwdC.toLowerCase())})'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("removeAddedTrustBlocks already stripped this probe's own scratch-cwd trust block(s)", !stillPresent);
  if (stillPresent) {
    const removable = remaining.match(blockRe) ?? [];
    let restored = remaining;
    for (const block of removable) restored = restored.split(block).join("");
    if (removable.length) {
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed ${removable.length} block(s)`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged.");
}

console.log(failures === 0
  ? "\n✅ ALL PASS (see findings.md for whether this run actually occurred this way — as of relocation, it never has)."
  : `\n❌ ${failures} FAILURE(S) — see sibling findings.md for the recorded, expected-red history of this probe.`);
await finishAndExit(failures === 0 ? 0 : 1);
