// REAL-CLAUDE STANDALONE PROBE (board card f05e4897) — observe what permission mode a REAL
// `claude --resume` actually lands in, and map the Shift+Tab cycle order, by reading the live TUI
// footer off the pty stream. NOT a hermetic CI test (needs real `claude` + auth) — a manual check.
//
// ════════ EMPIRICAL FINDINGS (claude 2.1.163, 2026-06-05; reproduced 3×, stable) ════════
//  • FRESH boot with `--permission-mode acceptEdits` (no cycles) → "accept edits on".
//  • Shift+Tab cycle order from acceptEdits (period 4):
//        acceptEdits →(+1) plan →(+2) auto →(+3) default/normal (no "X on" label) →(+4) acceptEdits.
//    ⇒ the prod config's startupModeCycles:2 (fresh) lands a manager in AUTO (matches "acceptEdits/auto").
//  • DECISIVE: a session PERSISTED IN PLAN, resumed with `--resume` + `--permission-mode acceptEdits`
//    + startupModeCycles:0 (Fix A's EXACT prod resume opts) → lands in "accept edits on", NOT plan.
//    So `claude --resume` HONORS `--permission-mode acceptEdits` and OVERRIDES the persisted mode —
//    the OPPOSITE of the card's premise ("--permission-mode still passed, still ignored on resume").
//  ⇒ The reported "resume lands in PLAN" bug does NOT reproduce on the installed claude; Fix A
//    (startupModeCycles:0 on resume) already yields a correct, non-plan resume. See the worker report.
//  • A bounded feedback-cycle on the resumed session DOES reach acceptEdits reliably (PHASE 5) — so a
//    feedback-driven absolute assertion IS viable IF the bug ever resurfaces (footer is parseable, cycle
//    deterministic). Not built here: the bug is unreproducible, so it would be an unverifiable change to
//    the load-bearing boot recipe (per the card's "don't ship brittle/unsafe code on this path").
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

try {
  // ===== PHASE 1: FRESH boot, no cycles → observe pure boot mode =====
  const A = "probe-fresh";
  spawn(A);
  console.log("[probe] fresh spawned; waiting for boot…");
  await sleep(9000);
  await reportFooter(A, "FRESH boot (startupModeCycles:0, --permission-mode acceptEdits)");
  // dump a slice of the footer region (last ANSI-stripped lines) for the exact-string record
  {
    const lines = stripAnsi(cap(A).raw).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    console.log("[probe] FRESH footer tail:\n" + lines.slice(-8).join("\n"));
  }

  // ===== PHASE 2: map the FULL Shift+Tab cycle order from acceptEdits (clean reads) =====
  console.log("[probe] --- mapping cycle order from acceptEdits (Shift+Tab x5, clean reads) ---");
  for (let i = 1; i <= 5; i++) await cycleAndRead(A, `FRESH after ${i} Shift+Tab`);

  // ===== PHASE 3: cycle to PLAN deliberately, then seed a turn so PLAN is the PERSISTED mode =====
  // This is the decisive setup: persist a NON-acceptEdits mode, then resume WITH --permission-mode
  // acceptEdits. If resume lands in plan → --resume restores PERSISTED + IGNORES the flag (the card's
  // claim, and the real prod bug = the manager was persisted in plan). If it lands in acceptEdits →
  // the flag IS honored on resume.
  console.log("[probe] --- cycling to PLAN (bounded, feedback-driven) ---");
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

  if (!eng) { console.log("[probe] NO ENGINE ID — cannot resume; aborting resume phases"); }
  else {
    // ===== PHASE 4: RESUME (prod's exact resume opts) → THE DECISIVE OBSERVATION =====
    const B = "probe-resume";
    captures.set(B, { raw: "" });
    spawn(B, { resumeId: eng });
    console.log("[probe] resumed; waiting for boot…");
    await sleep(11000);
    const rf = await reportFooter(B, "RESUME boot (persisted=plan, --permission-mode acceptEdits, cycles:0)");
    console.log(`[probe] *** DECISIVE: --resume of a PLAN-persisted session with --permission-mode acceptEdits → ${rf.mode} ***`);
    {
      const lines = stripAnsi(cap(B).raw).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
      console.log("[probe] RESUME footer tail:\n" + lines.slice(-10).join("\n"));
    }

    // ===== PHASE 5: feedback-cycle the RESUMED session to acceptEdits (validates the fix mechanism) =====
    console.log("[probe] --- feedback-cycling RESUME → acceptEdits (bounded ≤6) ---");
    let rcur = footer(B).mode;
    for (let i = 0; i < 6 && rcur !== "acceptEdits"; i++) rcur = (await cycleAndRead(B, `RESUME →acceptEdits step ${i + 1}`)).mode;
    console.log(`[probe] *** RESUME reached mode=${rcur} via feedback cycling (target acceptEdits) ***`);
  }
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
