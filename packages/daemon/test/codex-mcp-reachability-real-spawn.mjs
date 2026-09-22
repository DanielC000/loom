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
// Card 0564d43c (fix for b0066894): reuse the ALREADY-FIXED (card c0933e57), unit-tested detector rather
// than this file's own hand-rolled literal-space `.includes()` — codex sometimes renders the trust
// dialog's inter-word spaces as CSI cursor-forward (`ESC[<n>C`) instead of literal space bytes, which a
// raw literal match can never see. `isTrustDialogPrompt` normalizes (converts CSI cursor-forward to a
// real space, strips other CSI/OSC sequences) before matching — see codex-doctrine.ts#normalizeCodexScreenText
// for the general (not hardcoded-to-one-variant) normalization and codex-host-decisions.mjs for its own
// unit coverage against a real captured specimen.
const { isTrustDialogPrompt, trustDialogAnswer } = await import("../dist/pty/codex-host.js");

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
// Card e6eb2cb9 (TRAP 3): captured here, before spawn, so a failure-only diagnostic dump below can tell
// which codex session log (if any) was created DURING this run rather than left over from an earlier one.
const runStartedAt = Date.now();
const p = pty.spawn(
  codexBin,
  ["-a", "never", "-s", "workspace-write", "--no-alt-screen", "-c", "check_for_update_on_startup=false", "-c", `mcp_servers.loom_reach_probe.url="${url}"`],
  { name: "xterm-256color", cols: 120, rows: 40, cwd: scratchCwd, env: process.env },
);

let buf = "";
let trustAnswered = false;
p.onData((chunk) => {
  buf += chunk;
  if (!trustAnswered && isTrustDialogPrompt(buf)) {
    trustAnswered = true;
    setTimeout(() => p.write(trustDialogAnswer()), 200);
  }
});

// Card e6eb2cb9 (TRAP 3): find any codex session log (rollout-*.jsonl under the shared ~/.codex/sessions)
// created during this run's window — FAILURE-DIAGNOSTIC ONLY (see the usage site below). Card 0564d43c
// DoD-4 originally tried to use this as the POSITIVE-path "codex proceeded" signal, and that was WRONG:
// `pty/host.ts`'s own `@decision 2ec60d9c` (verified at source, docs/decisions/2ec60d9c-*.md) states
// plainly that codex creates this file lazily, "around when the FIRST real turn is actually submitted" —
// NOT at boot, NOT on trust-dialog-answer, NOT on MCP-ready. This file's own header says it spends "Zero
// model turns" by design (never submits a prompt) — so the file this function scans for structurally
// CANNOT exist here, confirmed empirically (polled up to 60s post-handshake against 3 real spawns, 0 hits
// every time) as well as at source. A check requiring it would fail on EVERY run, not just a broken one —
// see the real DoD-4 signal (the config.toml trust-grant diff) further down instead.
const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
function findFreshRolloutFiles() {
  const found = [];
  try {
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      let months = [];
      try { months = fs.readdirSync(yearDir); } catch { continue; }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days = [];
        try { days = fs.readdirSync(monthDir); } catch { continue; }
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files = [];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(dayDir, file);
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }
            if (stat.mtimeMs >= runStartedAt) found.push(filePath);
          }
        }
      }
    }
  } catch { /* sessions root missing or unreadable — nothing to scan */ }
  return found;
}

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

// --- md5-diff-disclose (structural, mirrors the probe's own manual remediation) ------------------------
// Card 0564d43c DoD-4: computed HERE (before the checks below, not just at cleanup time) so its result —
// whether codex actually persisted the trust grant to config.toml — can back a `check()`, not just a
// `[cleanup]` log line. This IS the real "codex proceeded past the dialog, not just detected it" signal
// (see the rollout-scan comment above for why a rollout-log-based version of this check was wrong).
const configAfter = (() => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } })();
const hashAfter = configAfter ? md5(configAfter) : "ENOENT";
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trustBlockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
const trustBlockRemovable = hashAfter !== hashBefore ? (configAfter.match(trustBlockRe) ?? []) : [];

// Card e6eb2cb9 (TRAP 1): "already-trusted from a prior run" is an ACCEPTED pass condition (buf.length ===
// 0), not just a caveat — so a FAILURE here means BOTH disjuncts failed: trustAnswered is false AND
// buf.length !== 0, i.e. codex emitted non-empty output that was NOT the trust prompt.
// Card 0564d43c DoD-3: the failure label used to ASSERT "boot error, not unanswered trust state" — a
// cause this check never actually established (it only knows buf wasn't empty and wasn't recognized as
// the trust prompt). State what was OBSERVED instead — trustAnswered, buf.length, and that buf's content
// was not inspected for a cause here (see the failure capture below, which does inspect it).
const trustPrecondition = trustAnswered || buf.length === 0;
check(
  trustPrecondition
    ? "trust dialog was reached and answered"
    : `trust dialog was reached and answered — FAILED: trustAnswered=false, buf.length=${buf.length} (!== 0) — buf's content was not inspected for a cause by this check; see the failure capture below`,
  trustPrecondition,
);
// Card e6eb2cb9 (TRAP 2): these are all downstream of codex completing boot (the precondition above) — an
// assertion downstream of a failed precondition is not independent evidence, so never size a fix from a
// raw failure count. SKIP (not FAIL) them when the precondition itself failed, so the failure count
// reflects the number of real signals.
if (trustPrecondition) {
  check("daemon's own inbound-MCP log recorded a real 'initialize' request", inboundLog.some((l) => l.includes("method=initialize")));
  check("daemon's own inbound-MCP log recorded 'notifications/initialized' (handshake completed)", inboundLog.some((l) => l.includes("method=notifications/initialized")));
  check("daemon's own inbound-MCP log recorded a real 'tools/list' request (tool enumeration attempted)", inboundLog.some((l) => l.includes("method=tools/list")));
  // Card 0564d43c DoD-4: matching the prompt is only half — a detector that matches but mis-sequences the
  // reply (wrong keystroke, wrong timing, wrong menu selection) would newly pass the checks above while
  // still being wrong. Confirm codex actually ACCEPTED the answer by checking it persisted a
  // `[projects.'<scratchCwd>']` trust grant to config.toml — the SAME mechanism `codex-doctrine.ts`'s own
  // `diffConfigAfterSpawn`/probe card `a7d74718` use to confirm a real trust-dialog answer landed, and
  // something that can ONLY happen as a direct consequence of codex accepting "1. Yes, continue" (unlike
  // the MCP-handshake checks above, which reach a router that may start independently of trust state).
  // Skipped, not failed, when trustAnswered is false (the buf.length===0 "already trusted" disjunct) —
  // there is nothing to persist when codex never had a fresh directory to grant trust to.
  if (trustAnswered) {
    check(
      trustBlockRemovable.length > 0
        ? "codex persisted the trust grant to config.toml (codex accepted the answer, not just rendered a menu)"
        : `codex persisted the trust grant to config.toml — FAILED: hashBefore=${hashBefore.slice(0, 12)} hashAfter=${hashAfter.slice(0, 12)} (changed=${hashAfter !== hashBefore}), no [projects.'${scratchCwd}'] block found`,
      trustBlockRemovable.length > 0,
    );
  } else {
    console.log("SKIP  (precondition) codex persisted the trust grant to config.toml — cwd was already trusted (buf.length===0 disjunct); nothing to persist");
  }
} else {
  console.log("SKIP  (precondition) daemon's own inbound-MCP log recorded a real 'initialize' request — trust-dialog precondition failed above; not independent evidence");
  console.log("SKIP  (precondition) daemon's own inbound-MCP log recorded 'notifications/initialized' (handshake completed) — trust-dialog precondition failed above; not independent evidence");
  console.log("SKIP  (precondition) daemon's own inbound-MCP log recorded a real 'tools/list' request (tool enumeration attempted) — trust-dialog precondition failed above; not independent evidence");
  console.log("SKIP  (precondition) codex persisted the trust grant to config.toml — trust-dialog precondition failed above; not independent evidence");
}

// Card e6eb2cb9 (TRAP 3, instrumentation only — not a repro hunt): on a FAILING run, capture what's
// actually available to diagnose it — this run's own accumulated pty output, plus any codex session log
// (rollout-*.jsonl under the shared ~/.codex/sessions) created during this run's window. Scoped to the
// failure path deliberately: a previous worker captured a PASSING standalone run's buf and it was
// necessarily uninformative (nothing to explain). Zero-cost on a pass; on a fail, this is what lets the
// next occurrence arrive with the evidence already attached instead of perishing with the process.
if (failures > 0) {
  console.log(`\n[diag] FAILURE CAPTURE — this run's raw accumulated pty output (${buf.length} chars):\n${buf}`);
  const freshRolloutFiles = findFreshRolloutFiles();
  if (freshRolloutFiles.length === 0) {
    console.log(`[diag] no codex session log (rollout-*.jsonl under ${sessionsRoot}) was created during this run's window (since ${new Date(runStartedAt).toISOString()}) — expected, since this test submits no turn (see the rollout-scan comment above); listed here only in case that assumption is ever wrong.`);
  } else {
    for (const filePath of freshRolloutFiles) {
      console.log(`[diag] codex session log created during this run: ${filePath}`);
      try {
        console.log(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        console.log(`[diag] could not read ${filePath}: ${e.message}`);
      }
    }
  }
}

// --- md5-diff-disclose cleanup (structural, mirrors the probe's own manual remediation) — reuses the
// SAME configAfter/hashAfter/trustBlockRemovable computed above rather than re-deriving them. ------------
if (hashAfter !== hashBefore) {
  if (trustBlockRemovable.length) {
    const restored = configAfter.split(trustBlockRemovable[0]).join("");
    if (md5(restored) === hashBefore) {
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] removed the expected [projects.'${scratchCwd}'] block this run added — config.toml restored to its exact pre-run hash.`);
    } else {
      console.log(`[cleanup] ⚠️ found an expected-shaped block but removing it did not restore the exact pre-run hash — leaving config.toml untouched. Removable text found:\n${trustBlockRemovable[0]}`);
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
