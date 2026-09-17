// Real-spawn proof for board card 7a624213 — a Loom worker cannot register the harness's own
// self-scheduling tools (ScheduleWakeup/CronCreate/CronDelete/CronList/RemoteTrigger). See
// disallow-harness-scheduling-tools.mjs for the pure argv-construction proof; THIS file proves a REAL,
// authenticated `claude` process actually honors that argv — the engine itself, not this repo's own
// code, is the thing under test here.
//
// ⛔⛔ MANUAL-ONLY — listed in `NOT_HERMETIC` (scripts/test-daemon.mjs), deliberately NEVER run as part of
// `pnpm --filter @loom/daemon test:daemon` or any merge/worker gate. WHY: on a host where `claude auth
// status` genuinely passes (e.g. the owner's own dev box), leaving this hermetic-discovered would spawn
// TWO real, authenticated `claude` processes and spend a real model turn on EACH, on EVERY merge gate —
// an unapproved recurring spend on the owner's own Anthropic account, plus a new flake surface (auth
// expiry, rate limits, network) inside a suite that already runs concurrent lanes. The codex-real-spawn
// family (CODEX_REAL_SPAWN_BASENAMES) is NOT a precedent for running this one automatically: THAT family
// is its own separately-scheduled, LOCKED gate phase (`_codex-real-spawn-lock.mjs`) — a deliberate,
// budgeted exception this file does not have and was never asked to have. This file's job was to PROVE
// the fix once, on a real engine, and capture that evidence in-tree (below) — ONGOING regression coverage
// for every future change belongs to the hermetic argv tests (`disallow-harness-scheduling-tools.mjs`,
// `disallow-prompt-tools.mjs`, `disallow-task-tools.mjs`), which run on every gate for free. Re-run THIS
// file by hand only when you specifically need to re-verify against a real engine (e.g. after an engine
// upgrade changes how `--disallowedTools`/`--tools` or the transcript's own `prompt_snapshot` shape
// behaves) — see this file's own `Run:` line below for the exact command. The shared-`~/.claude`-home concurrency question this file's own commit message
// raised (whether a second real-`claude`-spawn test file run concurrently with this one could contend the
// way the codex family measurably does against `~/.codex`) is MOOT under this manual-only posture — this
// file is never scheduled to run alongside anything else by the gate; it only matters again if a future
// author adds it (or a sibling) back to automatic discovery, at which point re-derive the question fresh
// rather than trusting this note's "moot" conclusion, which is scoped to the CURRENT manual-only posture.
//
// ✅ EVIDENCE — a real run, captured so it survives in-tree without needing to re-spend real API calls to
// re-prove the fix. Ran 2026-09-17 against the file content committed as `f18f646e` (this file's own
// functional code is byte-identical there — every commit since is comment-only: `git diff f18f646e HEAD
// -- <this file>` shows no non-comment line changed):
//   [measured] covered native tools (15): Agent, Artifact, Bash, Edit, Glob, Grep, ListAgents, PowerShell,
//     Read, ReportFindings, SendFeedback, Skill, ToolSearch, Workflow, Write
//   [measured] control native tools (17): Agent, Artifact, AskUserQuestion, Bash, Edit, Glob, Grep,
//     ListAgents, PowerShell, Read, ReportFindings, ScheduleWakeup, SendFeedback, Skill, ToolSearch,
//     Workflow, Write
//   PASS  [covered:worker] SessionStart captured a real engine session id
//   PASS  [covered:worker] the real transcript recorded a prompt_snapshot row with a native tool list
//   PASS  [control:plain] SessionStart captured a real engine session id
//   PASS  [control:plain] the real transcript recorded a prompt_snapshot row with a native tool list
//   PASS  [covered:worker] registered native tool list contains NONE of the harness-scheduling tools
//   PASS  [control:plain] registered native tool list DOES contain ScheduleWakeup (the check can fail)
//   PASS  [covered:worker] deferred tool surface DOES contain mcp__loom-tasks__wake_me (the replacement)
//   ✅ ALL PASS
// Also verified the skip path separately: `LOOM_CLAUDE_BIN=/nonexistent/claude-binary-xyz node
// test/disallow-harness-scheduling-tools-real-spawn.mjs` → a single `WARN  SKIP` line, exit 0, zero
// check() calls run (never a false pass).
//
// DETERMINISM (manager amendment on this card): "did the model choose to call ScheduleWakeup, then get
// refused" is NOT a valid check — a model that simply never tries looks identical to a real refusal, and
// nothing distinguishes the two. Instead this file reads the engine's OWN transcript JSONL — the exact
// record it writes of its own registered tool surface, independent of anything the model does or doesn't
// do that turn:
//   - `{type:"attachment", attachment:{type:"prompt_snapshot", tools:[{name,...}, ...]}}` — the session's
//     registered NATIVE tool list (what `--disallowedTools`/`--tools` actually produced). Verified by
//     hand against this worker's own live transcript (a `worker` session, pre-fix, i.e. WITHOUT this
//     card's disallow): `attachment.tools` was an array of 16 `{name,...}` objects, and
//     `.map(t=>t.name)` included `"ScheduleWakeup"` verbatim, confirming both the field name and shape.
//   - `{type:"attachment", attachment:{type:"deferred_tools_record", entries:[{name,...}, ...]}}` (and
//     the incremental `deferred_tools_delta.addedNames` form) — the session's DEFERRED (MCP-namespaced)
//     tool surface, which `--disallowedTools` (a NATIVE-tool mechanism) never touches. Verified the same
//     way: `entries[0].name` was `"mcp__loom-orchestration__gate_cancel"`, and the full name list
//     included `"mcp__loom-tasks__wake_me"` verbatim.
// So the PRIMARY assertions are: (1) a COVERED role's registered native tool list contains NONE of
// HARNESS_SCHEDULING_TOOLS; (2) a CONTROL role (NOT in the new deny list) DOES register at least
// `ScheduleWakeup` — required, or a missing tool proves nothing (the check must be able to fail); (3) the
// covered role's deferred tool surface DOES contain `mcp__loom-tasks__wake_me` (the MCP-namespaced
// replacement, untouched by this native-tool disallow, still reachable).
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `claude` CLI — no fixture can produce a real
// engine-authored transcript row. SKIPS gracefully (exit 0) via a deterministic `claude auth status`
// preflight (the exact analog of `codex login status` in the codex real-spawn family — see
// codex-doctrine-real-spawn.mjs's own header) if the binary is missing or not logged in. Never fails on a
// missing/unauthenticated CLI, and never reports a pass with zero real assertions executed: a login
// failure exits via the WARN SKIP path below, before any check() call runs.
//
// Runs against the REAL ~/.claude/projects transcript store (auth needs the real HOME — same disclosed
// non-sandboxed posture as codex-mcp-reachability-real-spawn.mjs's real ~/.codex) — NOT sandboxed. Cleans
// up its own two scratch cwds' transcript directories in `finally` (mirrors _probe-resume-mode.mjs's own
// cleanup). Costs two small real model turns (one per spawned role) — same accepted cost class as this
// project's other real-spawn files (see codex-doctrine-real-spawn.mjs's own header: "spends a real model
// turn").
//
// Run (MANUAL-ONLY — see above): 1) build (turbo builds shared first),
// 2) node test/disallow-harness-scheduling-tools-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const claudeBin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");

// --- Graceful skip: deterministic preflight (mirrors `codex login status`, NOT a model-driven guess) ---
try {
  const { stdout } = await execFileAsync(claudeBin, ["auth", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
  const parsed = JSON.parse(stdout);
  if (parsed.loggedIn !== true) throw new Error(`claude auth status reports loggedIn=${parsed.loggedIn}`);
} catch (e) {
  // Card 5978735a convention (this repo's codex real-spawn family): MUST be a `WARN  ` line — a bare
  // `SKIP  ` line is discarded once this file reports a pass, leaving zero trace on CI that this file's
  // real coverage never ran.
  console.log(`WARN  SKIP  disallow-harness-scheduling-tools-real-spawn.mjs — real, authenticated claude CLI not available on this host (${String(e.message ?? e).split("\n")[0]}). No fixture substitute; real coverage only on a host with claude installed + logged in (\`claude auth status\`).`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-harness-sched-real-");
fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
fs.mkdirSync(path.join(TMP, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv({ port: true });

// IMPORTANT ORDERING (mirrors codex-mcp-reachability-real-spawn.mjs's own note): Db/buildServer/
// TaskMcpRouter FIRST — NOT pty/host.js yet, since paths.js's PORT constant is read once at module load
// and buildMcpServers (called inside createPty) needs it to already reflect the FINAL bound port.
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });

const COVERED_ID = "harness-sched-worker";
const CONTROL_ID = "harness-sched-control";
db.insertSession({
  id: COVERED_ID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});
db.insertSession({
  id: CONTROL_ID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null,
});

// --- Real PtyHost, imported only now that LOOM_PORT is final (see ordering note above) -----------------
const { PtyHost } = await import("../dist/pty/host.js");
const engineIds = new Map(); // loom sessionId -> engine session id (captured on SessionStart)
const exited = new Set();
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); },
  onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(id) { exited.add(id); },
};
const host = new PtyHost(events);

// Real buildServer, with `pty: host` — the REAL host instance, not a stub — so `/internal/hook`'s
// `deps.pty.deliverHook`/`verifyHookToken` (see gateway/server.ts) actually reaches this same PtyHost and
// SessionStart genuinely fires `onEngineSessionId` above, exactly as production wiring does.
const stub = {};
const app = await buildServer({
  db, pty: host, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: Number(process.env.LOOM_PORT), host: "127.0.0.1" });

// --- Two throwaway real cwds (claude's own transcript store keys off the REAL, resolved cwd) -----------
function freshCwd(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerForCleanup(dir);
  return dir;
}
const coveredCwd = freshCwd("loom-harness-sched-cwd-covered-");
const controlCwd = freshCwd("loom-harness-sched-cwd-control-");

// claude's own project-dir encoding (verified against this project's real transcript store: every
// non-alphanumeric byte of the resolved cwd, including the drive-letter colon and every path separator,
// becomes a literal "-").
function encodeProjectDir(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
function transcriptDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd));
}
// Register the REAL transcript dirs for cleanup NOW (before any spawn creates them) — mirrors
// _probe-resume-mode.mjs's own finally-block cleanup, but registered so `finishAndExit` guarantees it
// even on an early throw.
registerForCleanup(transcriptDirFor(coveredCwd));
registerForCleanup(transcriptDirFor(controlCwd));

const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

const spawned = [];
function spawnReal(id, cwd, role) {
  spawned.push(id);
  host.spawn({ sessionId: id, cwd, permission, geometry, sessionEnv, role });
}

// --- JSONL helpers ---------------------------------------------------------------------------------
function readRows(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* last line may be mid-write; skip */ }
  }
  return rows;
}
function nativeToolNames(rows) {
  for (const r of rows) {
    if (r.type === "attachment" && r.attachment?.type === "prompt_snapshot" && Array.isArray(r.attachment.tools)) {
      return r.attachment.tools.map((t) => (typeof t === "string" ? t : t.name));
    }
  }
  return null;
}
function deferredToolNames(rows) {
  const names = new Set();
  for (const r of rows) {
    if (r.type !== "attachment") continue;
    if (r.attachment?.type === "deferred_tools_record" && Array.isArray(r.attachment.entries)) {
      for (const e of r.attachment.entries) names.add(typeof e === "string" ? e : e.name);
    }
    if (r.attachment?.type === "deferred_tools_delta" && Array.isArray(r.attachment.addedNames)) {
      for (const n of r.attachment.addedNames) names.add(n);
    }
  }
  return names;
}

/**
 * Spawn `id` as `role` against `cwd`, submit one minimal real turn, and poll the REAL transcript JSONL
 * (never the pty's own screen output) until it carries a `prompt_snapshot` row with a native tool list —
 * bounded, but generous: a real claude boot + one real API round trip, not a fixture. Returns
 * `{ nativeTools, deferredTools }`.
 */
async function verifyRegisteredTools(label, id, cwd, role) {
  spawnReal(id, cwd, role);

  const engineDeadline = Date.now() + 30000;
  // TIMING-GUARD-SAFE: this is a bounded POLL loop, not a blind sleep-then-assert — it re-checks the
  // real `engineIds` Map (populated by the REAL onEngineSessionId callback, fired only by a genuine
  // SessionStart hook POST) on every iteration and exits the instant the observable event lands. The
  // check() below reflects whichever state the loop actually reached (found, or exhausted the budget),
  // never a guess about how long boot takes — falsifiable in one trial either way.
  while (!engineIds.has(id) && Date.now() < engineDeadline) await sleep(250);
  const engineId = engineIds.get(id);
  check(`${label} SessionStart captured a real engine session id`, !!engineId);
  if (!engineId) return { nativeTools: null, deferredTools: new Set() };

  // Give the boot a moment to fully settle before submitting (mirrors _probe-resume-mode.mjs's own
  // post-SessionStart settle delay) — not gated on any Loom readiness event since this file bypasses
  // scheduleKickoffGuarantee entirely (no startupPrompt is ever set on these spawns).
  await sleep(3000);
  host.enqueueStdin(id, "Reply with exactly the single word DONE and call no tools.");

  const transcriptPath = path.join(transcriptDirFor(cwd), `${engineId}.jsonl`);
  const deadline = Date.now() + 90000;
  let nativeTools = null;
  let deferredTools = new Set();
  while (Date.now() < deadline) {
    const rows = readRows(transcriptPath);
    nativeTools = nativeToolNames(rows);
    deferredTools = deferredToolNames(rows);
    if (nativeTools) break;
    // TIMING-GUARD-SAFE: bounded POLL loop, not a blind sleep-then-assert — it re-reads the REAL
    // transcript file on disk every iteration (above) and exits the instant the observable
    // `prompt_snapshot` row actually appears. The check() below reflects whatever the file genuinely
    // contains at loop exit (found, or budget exhausted), never a guess about API latency.
    await sleep(1000);
  }
  check(`${label} the real transcript recorded a prompt_snapshot row with a native tool list`, !!nativeTools);
  return { nativeTools: nativeTools ?? [], deferredTools };
}

try {
  const covered = await verifyRegisteredTools("[covered:worker]", COVERED_ID, coveredCwd, "worker");
  const control = await verifyRegisteredTools("[control:plain]", CONTROL_ID, controlCwd, null);

  // --- PRIMARY assertions --------------------------------------------------------------------------
  const SCHED = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger"];
  check("[covered:worker] registered native tool list contains NONE of the harness-scheduling tools",
    covered.nativeTools.length > 0 && SCHED.every((t) => !covered.nativeTools.includes(t)));
  // Required control: proves this check CAN fail — a role NOT in the new deny list still registers
  // ScheduleWakeup for real. Without this, a missing tool proves nothing (see this file's own header).
  check("[control:plain] registered native tool list DOES contain ScheduleWakeup (the check can fail)",
    control.nativeTools.includes("ScheduleWakeup"));
  check("[covered:worker] deferred tool surface DOES contain mcp__loom-tasks__wake_me (the replacement)",
    covered.deferredTools.has("mcp__loom-tasks__wake_me"));

  console.log(`   [measured] covered native tools (${covered.nativeTools.length}): ${covered.nativeTools.join(", ")}`);
  console.log(`   [measured] control native tools (${control.nativeTools.length}): ${control.nativeTools.join(", ")}`);
} finally {
  console.log("[cleanup] killing all real claude processes spawned by this file…");
  for (const id of spawned) { try { host.stop(id, "hard"); } catch { /* best-effort */ } }
  await sleep(2000);
  try { await app.close(); } catch { /* best-effort */ }
  try { db.close(); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real, authenticated claude process spawned with the worker-role argv never registers ScheduleWakeup/CronCreate/CronDelete/CronList/RemoteTrigger (per its own transcript's prompt_snapshot row), a role NOT in the new deny list DOES register ScheduleWakeup (the check can fail), and the covered role's deferred tool surface still carries mcp__loom-tasks__wake_me."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
