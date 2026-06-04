// REAL-CLAUDE STANDALONE PROBE (board card f05e4897) — observe what permission mode a REAL
// `claude --resume` actually lands in, and map the Shift+Tab cycle order, by reading the live TUI
// footer off the pty stream. NOT a hermetic CI test (needs real `claude` + auth) — a manual check.
//
// ════════ EMPIRICAL FINDINGS (claude 2.1.163, 2026-06-05; reproduced 3×, stable) ════════
//  • FRESH boot with `--permission-mode acceptEdits` (no cycles) → "accept edits on".
//  • Shift+Tab cycle order from acceptEdits (period 4):
//        acceptEdits →(+1) plan →(+2) auto →(+3) default/normal (no "X on" label) →(+4) acceptEdits.
//    ⇒ the prod config's startupModeCycles:2 (fresh) lands a manager in AUTO (matches "acceptEdits/auto").
//  • A session PERSISTED IN PLAN, resumed with `--resume` + `--permission-mode acceptEdits` lands in
//    "accept edits on", NOT plan: `claude --resume` HONORS `--permission-mode acceptEdits` and boots at
//    acceptEdits — the SAME gate-free mode a fresh spawn boots in (it does NOT restore the persisted mode).
//  • THE FIX (card f05e4897): a daemon-resumed manager must land in AUTO (where a fresh manager lands),
//    but with Fix A's blind startupModeCycles:0 a resume stops at acceptEdits — ONE short. So the resume
//    path now feedback-cycles the footer to auto (host.ts cycleResumeToMode, driven by resumeModeTarget).
//
// ════════ WHAT THIS PROBE NOW VALIDATES (the DoD evidence) ════════
//   PHASE 1: FRESH spawn with the prod startupModeCycles:2 → ASSERT footer reaches "auto mode on".
//   PHASE 3: persist the session in PLAN (a NON-auto mode), seed a turn, capture the engine id.
//   PHASE 4 (BEFORE): RESUME with NO resumeModeTarget (Fix A's blind-0) → observe it lands at acceptEdits.
//   PHASE 5 (AFTER/THE FIX): RESUME with resumeModeTarget:"auto" → the host auto-feedback-cycles →
//            ASSERT footer reaches "auto mode on". The BEFORE/AFTER footers are the before/after evidence.
//
// ISOLATION (HARD RULES): temp LOOM_HOME, port 4319 (NOT prod 4317), a throwaway temp git repo.
// The relay POSTs hooks to OUR minimal server on 4319 — the prod daemon never sees these sessions.
// We do NOT sandbox HOME: real `claude` needs its real auth to boot. It writes the temp repo's
// transcript under ~/.claude/projects/<temp> — cleaned in finally. KILLS all probe claude in finally.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-resume-mode.mjs` from packages/daemon.
//      Override the binary with LOOM_CLAUDE_BIN; default is PATH-resolved "claude".
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4319;
const tmpHome = path.join(os.tmpdir(), `loom-probe-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);
// host.ts resolves LOOM_CLAUDE_BIN || "claude" via PATH (resolve-bin.ts) — leave it to that default
// unless the caller overrides, so this probe is portable (no hardcoded host path).

const { PtyHost } = await import("../dist/pty/host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ANSI-only strip (keeps whitespace) for readable tail dumps.
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");
// Strip ANSI AND collapse ALL whitespace — the steady-state footer is laid out with cursor-position
// escapes, so after stripping ANSI the words run together ("accepteditson"). Same shape as host.ts collapseBoot.
const collapse = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "").replace(/\s+/g, "");

// Classify by the LAST occurrence of any mode phrase in the collapsed text (footer is repainted, so
// the last occurrence is the current mode). More robust than anchoring on "(shift+tab to cycle)",
// which sometimes drops a char across a line-wrap.
const MODE_PHRASES = [
  { mode: "plan", token: "planmodeon" },
  { mode: "acceptEdits", token: "accepteditson" },
  { mode: "auto", token: "automodeon" },
  { mode: "bypassPermissions", token: "bypasspermissionson" },
];
function detectMode(collapsed) {
  const low = collapsed.toLowerCase();
  let best = null;
  for (const { mode, token } of MODE_PHRASES) {
    const idx = low.lastIndexOf(token);
    if (idx >= 0 && (best === null || idx > best.idx)) best = { mode, idx, token };
  }
  return best ? { mode: best.mode, token: best.token } : { mode: "UNPARSEABLE", token: "-" };
}

// Per-session rolling capture of the engine output. `clear()` lets a cycle-step read ONLY the fresh
// repaint after a keystroke (no residue from prior paints muddying the classification).
const captures = new Map(); // sessionId -> { raw: string }
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const clearCap = (id) => { cap(id).raw = ""; };
const footer = (id) => detectMode(collapse((cap(id).raw || "").slice(-8000)));

const engineIds = new Map(); // loom sessionId -> engine id (from SessionStart)
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[probe] engineSessionId ${id} -> ${eng}`); },
  onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(id, code) { console.log(`[probe] onExit ${id} code=${code}`); },
};
const host = new PtyHost(events);

// Minimal /internal/hook receiver (replicates gateway/server.ts) so SessionStart captures the engine id.
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body);
        if (b?.sessionId && b.hook) {
          const ev = b.hook.hook_event_name;
          if (ev === "Stop" || ev === "StopFailure") stoppedTurns.set(b.sessionId, (stoppedTurns.get(b.sessionId) || 0) + 1);
          host.deliverHook(b.sessionId, b.hook);
        }
      } catch { /* ignore */ }
      res.end('{"ok":true}');
    });
    return;
  }
  res.statusCode = 404; res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[probe] hook server on 127.0.0.1:${PORT}`);

// Throwaway temp git repo as the project cwd.
const repo = path.join(os.tmpdir(), `loom-probe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const SHIFT_TAB = "\x1b[Z";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1",
};
const permission = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 0 };

const spawned = [];
function spawn(id, extra) {
  spawned.push(id);
  host.spawn({ sessionId: id, cwd: repo, permission, geometry, sessionEnv, ...extra });
  const sub = host.subscribe(id, { onData: (b) => { cap(id).raw += b.toString("utf8"); }, onControl() {} });
  return sub;
}

async function reportFooter(id, label) {
  const f = footer(id);
  console.log(`[probe] ${label}: mode=${f.mode}  token=${f.token}`);
  return f;
}

// Cleanly read the mode after a Shift+Tab: clear the buffer, press, wait for the repaint, classify.
async function cycleAndRead(id, label) {
  clearCap(id);
  host.writeStdin(id, SHIFT_TAB);
  await sleep(2500);
  return reportFooter(id, label);
}

// Track Stop hooks so we can wait for a real turn to complete (→ a resumable transcript).
const stoppedTurns = new Map(); // sessionId -> count
async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
}

const results = []; // { label, pass } — printed as the final verdict
const assert = (label, cond) => { results.push({ label, pass: !!cond }); console.log(`[probe] ${cond ? "PASS" : "FAIL"}  ${label}`); };
const dumpTail = (id, label, n = 10) => {
  const lines = stripAnsi(cap(id).raw).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  console.log(`[probe] ${label} footer tail:\n` + lines.slice(-n).join("\n"));
};

try {
  // ===== PHASE 1: FRESH spawn with the PROD startupModeCycles:2 → must reach AUTO (host blind-cycles) =====
  const A = "probe-fresh";
  spawn(A, { permission: { ...permission, startupModeCycles: 2 } });
  console.log("[probe] fresh spawned (startupModeCycles:2 — the prod fresh path); waiting for boot + cycle…");
  await sleep(12000);
  const ff = await reportFooter(A, "FRESH boot (startupModeCycles:2, --permission-mode acceptEdits)");
  dumpTail(A, "FRESH");
  assert("FRESH spawn (startupModeCycles:2) reaches AUTO — the host's blind cycle still works", ff.mode === "auto");

  // ===== PHASE 3: cycle to PLAN deliberately, then seed a turn so PLAN is the PERSISTED mode =====
  // Persist a NON-auto mode so the resume's BEFORE/AFTER is decisive (the persisted mode is plan, the
  // boot mode is acceptEdits, the FIX must drive it to auto).
  console.log("[probe] --- cycling FRESH → PLAN (bounded, feedback-driven) to seed a non-auto persisted mode ---");
  let cur = footer(A).mode;
  for (let i = 0; i < 6 && cur !== "plan"; i++) cur = (await cycleAndRead(A, `→plan step ${i + 1}`)).mode;
  console.log(`[probe] mode before seed = ${cur} (want plan)`);

  console.log("[probe] seeding a real turn so the conversation is resumable (in PLAN)…");
  const before = stoppedTurns.get(A) || 0;
  host.enqueueStdin(A, "Reply with exactly the word READY and nothing else.");
  const completed = await waitForStop(A, before, 60000);
  console.log(`[probe] seed turn completed=${completed}; persisted mode = ${footer(A).mode}`);
  await sleep(1500);

  // ===== capture engine id, stop gracefully (mimics the daemon process dying) =====
  const eng = engineIds.get(A);
  console.log(`[probe] captured engine id = ${eng}`);
  host.stop(A, "graceful");
  await sleep(5000);

  if (!eng) { assert("captured an engine id to resume (resume phases ran)", false); }
  else {
    // ===== PHASE 4 (BEFORE): RESUME with Fix A's blind-0 + NO resumeModeTarget → lands at acceptEdits =====
    // This is the BEFORE state the fix corrects: --resume honours --permission-mode → boots acceptEdits,
    // and with no cycling it stays there (one short of auto).
    const B = "probe-resume-before";
    captures.set(B, { raw: "" });
    spawn(B, { resumeId: eng, permission: { ...permission, startupModeCycles: 0 } });
    console.log("[probe] resumed WITHOUT the fix (startupModeCycles:0, no resumeModeTarget); waiting for boot…");
    await sleep(12000);
    const rb = await reportFooter(B, "RESUME BEFORE (no fix): persisted=plan, --permission-mode acceptEdits, cycles:0");
    dumpTail(B, "RESUME BEFORE");
    assert("BEFORE: a resume with no convergence lands at acceptEdits (one short of auto — the bug)", rb.mode === "acceptEdits");
    host.stop(B, "graceful");
    await sleep(5000);

    // ===== PHASE 5 (AFTER / THE FIX): RESUME with resumeModeTarget:"auto" → host auto-cycles → AUTO =====
    const C = "probe-resume-after";
    captures.set(C, { raw: "" });
    // resumeModeTarget drives host.ts cycleResumeToMode automatically after SessionStart — the probe does
    // NOT press any keys here; it only reads the settled footer. This is the prod resume path under test.
    spawn(C, { resumeId: eng, permission: { ...permission, startupModeCycles: 0 }, resumeModeTarget: "auto" });
    console.log("[probe] resumed WITH the fix (resumeModeTarget:auto — host auto-feedback-cycles); waiting for boot + convergence…");
    await sleep(20000); // boot (~11s) + the bounded feedback cycle (well under READY_FALLBACK_MS)
    const ra = await reportFooter(C, "RESUME AFTER (fix): persisted=plan, resumeModeTarget=auto");
    dumpTail(C, "RESUME AFTER");
    assert("AFTER: the fix drives the resumed session to AUTO with NO probe keystrokes (host feedback-cycled)", ra.mode === "auto");
    console.log(`[probe] *** BEFORE=${rb.mode}  →  AFTER=${ra.mode}  (target auto) ***`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[probe] ${passed}/${results.length} assertions passed.`);
  if (passed !== results.length) console.log("[probe] ❌ FAILURES:\n" + results.filter((r) => !r.pass).map((r) => "  - " + r.label).join("\n"));
  else console.log("[probe] ✅ ALL PASS — FRESH→auto and RESUME→auto (the fix), with a decisive acceptEdits BEFORE.");
} finally {
  console.log("[probe] cleanup — killing all probe claude…");
  for (const id of spawned) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  await sleep(1500);
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  // clean the temp repo's transcript dir under the REAL ~/.claude/projects (claude encodes cwd path)
  try {
    const enc = path.resolve(repo).replace(/[^a-zA-Z0-9]/g, "-"); // matches claude's encodeProjectDir
    const projDir = path.join(os.homedir(), ".claude", "projects", enc);
    fs.rmSync(projDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log("[probe] done.");
  setTimeout(() => process.exit(0), 500);
}
