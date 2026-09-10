// Card 353f6dc4 (multi-harness epic df1f94b0, Phase 1) — LEAD RULING #2, item #4. The first version of
// this file checked `codex mcp list`/`codex mcp get --json` after a transient `-c mcp_servers.<id>.url=`
// override — and that was a REAL MISTAKE, caught by the lead's own re-check: both commands report only
// the CONFIGURED transport (Status: enabled, Auth: Unsupported — IDENTICAL whether the endpoint is
// listening or not, confirmed by re-running the same command against a deliberately unreachable port).
// Neither is a connectivity check. This version drives a REAL pty boot instead and reads the DAEMON'S OWN
// inbound-MCP-request log — not codex's self-report — to prove an actual connect + protocol handshake +
// tool-enumeration round-trip, mirroring the prior probe card (a7d74718)'s own real-pty methodology.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI (a sandboxed CODEX_HOME breaks auth —
// empirically confirmed, see pty/codex-doctrine.ts's own header) — there is no fixture-CLI substitute for
// a real MCP client's actual wire behavior. SKIPS gracefully (exit 0) if codex isn't installed/authed on
// this host, so it never fails CI on a runner without it; it is real coverage only on a dev box that has
// it, same posture as this project's browserTesting-dependent Playwright tests.
//
// Safety: runs against the REAL ~/.codex (no CODEX_HOME override — see the file header referenced above
// for why), so it applies the SAME md5-before/diff-after/disclose discipline the original probe used,
// automated rather than manual. Zero model turns spent — this only drives the pty through session-boot
// MCP startup (never submits a prompt), then exits via the confirmed double-Ctrl+C.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-mcp-reachability-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pty from "node-pty";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: this test needs a REAL, authenticated codex install; no fixture can stand in for a
// real MCP client's wire behavior. ------------------------------------------------------------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  // Card 5978735a: MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's own WARN_LINE_RE) —
  // a bare `SKIP  ` line is discarded entirely once this file reports a pass, leaving zero trace on CI
  // (ubuntu-latest, no codex CLI) that this file's real coverage never ran.
  console.log(`WARN  SKIP  codex-mcp-reachability-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute (see its own header); it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-mcp-reach-");
process.env.LOOM_HOME = TMP;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: "codex-reach-probe", projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});

const inboundLog = [];
const stub = {};
const app = await buildServer({
  db, pty: { markMcpSeen: () => {}, recordToolCallArgsHash: () => {} }, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
// Capture the daemon's own [mcp] inbound-request log lines — the decisive evidence (not codex's self
// report) that a real handshake reached the real router.
const origLog = console.log;
console.log = (...args) => { const line = args.join(" "); if (line.startsWith("[mcp] codex-reach-probe")) inboundLog.push(line); origLog(...args); };

await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address();
// The EXACT URL shape pty/host.ts#buildMcpServers already builds for claude's --mcp-config (loom-tasks).
const url = `http://127.0.0.1:${port}/mcp/codex-reach-probe`;

// --- md5-before (real ~/.codex/config.toml — see file header for why this must be the REAL home) -----
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const configBefore = (() => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } })();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

// Card 14e6cf5f: serialize against any sibling real-codex-spawn test file (currently
// codex-stateful-runtime-real-spawn.mjs) — see _codex-real-spawn-lock.mjs's own header for the measured
// concurrent-scheduling failure this closes. Held until the config.toml diff/cleanup below is done, since
// that also touches the same shared file.
const releaseCodexLock = await acquireCodexRealSpawnLock();

const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-mcp-reach-cwd-"));
// Card 4084fadb: this file deliberately drives a REAL pty boot INDEPENDENTLY of PtyHost/createCodexPty
// (see this file's own header) — so it does NOT inherit createCodexPty's update-check-suppression fix and
// must carry the SAME override itself, or it wedges on codex's own "Update available!" dialog whenever a
// newer release is genuinely published, exactly as it did pre-fix (see codex-host.ts's
// CODEX_UPDATE_CHECK_OVERRIDE_ARGS for the measured evidence this key/value pair suppresses it).
const p = pty.spawn(
  codexBin,
  ["-a", "never", "-s", "workspace-write", "--no-alt-screen", "-c", "check_for_update_on_startup=false", "-c", `mcp_servers.loom_reach_probe.url="${url}"`],
  { name: "xterm-256color", cols: 120, rows: 40, cwd: scratchCwd, env: process.env },
);

let buf = "";
let trustAnswered = false;
p.onData((chunk) => {
  buf += chunk;
  if (!trustAnswered && buf.includes("Do you trust the contents of this directory?")) {
    trustAnswered = true;
    setTimeout(() => p.write("1\r"), 200);
  }
});

const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  if (inboundLog.some((l) => l.includes("method=tools/list")) || buf.includes("context left")) break;
  await new Promise((r) => setTimeout(r, 250));
}

console.log = origLog;
p.write("\x03");
await new Promise((r) => setTimeout(r, 800));
p.write("\x03");
await new Promise((r) => setTimeout(r, 2500));
try { p.kill(); } catch { /* already exited */ }

await app.close();
db.close();

check("trust dialog was reached and answered", trustAnswered || buf.length === 0 /* already-trusted from a prior run is also fine */);
check("daemon's own inbound-MCP log recorded a real 'initialize' request", inboundLog.some((l) => l.includes("method=initialize")));
check("daemon's own inbound-MCP log recorded 'notifications/initialized' (handshake completed)", inboundLog.some((l) => l.includes("method=notifications/initialized")));
check("daemon's own inbound-MCP log recorded a real 'tools/list' request (tool enumeration attempted)", inboundLog.some((l) => l.includes("method=tools/list")));

// --- md5-diff-disclose (structural, mirrors the probe's own manual remediation) ------------------------
const configAfter = (() => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } })();
const hashAfter = configAfter ? md5(configAfter) : "ENOENT";
if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const removable = configAfter.match(blockRe) ?? [];
  if (removable.length) {
    const restored = configAfter.split(removable[0]).join("");
    if (md5(restored) === hashBefore) {
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] removed the expected [projects.'${scratchCwd}'] block this run added — config.toml restored to its exact pre-run hash.`);
    } else {
      console.log(`[cleanup] ⚠️ found an expected-shaped block but removing it did not restore the exact pre-run hash — leaving config.toml untouched. Removable text found:\n${removable[0]}`);
    }
  } else {
    console.log(`[cleanup] ⚠️ config.toml changed but no [projects.'${scratchCwd}'] block was found — residual delta not auto-classified. This run's own scratch cwd: ${scratchCwd}`);
  }
} else {
  console.log("[cleanup] config.toml unchanged (this cwd was likely already trusted from a prior run).");
}

releaseCodexLock();

console.log(failures === 0
  ? "\n✅ ALL PASS — a real codex pty boot connected to a real live Loom MCP endpoint, completed the MCP handshake, and requested tool enumeration, per the daemon's own inbound-request log (not codex's self-report)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
