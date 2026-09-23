import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a1ad730a — hermetic coverage for the give-up diagnostic `PtyHost#captureCodexEngineSessionId` logs
// when engine-session-id discovery exhausts its retry ladder: it must say whether rollout files were
// "created but unmatched" (each candidate named with the matcher's own verdict) or "never created" (none
// present), and stay bounded. Drives the REAL host give-up path with a fake pty (same technique as
// codex-engine-session-id-capture.mjs) and captures the real console.warn line.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-engine-id-giveup-diagnostic.mjs
process.env.LOOM_CODEX_ENGINE_ID_RETRY_MS = "20";
process.env.LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS = "2";
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diag) console.log(`      ${diag}`); }
};

process.env.LOOM_HOME = mkdtempManaged("loom-codex-giveup-loomhome-");
const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs(); // LOOM_HOME logs dir, else every spawn logs a misleading log-stream ENOENT
const { findConversationIdForSpawn, ROLLOUT_DIAG_MAX_CANDIDATES, ROLLOUT_DIAG_MAX_CHARS, describeRolloutCandidatesForDiagnostic } =
  await import("../dist/pty/codex-transcript.js");

const READY = "> Ask Codex to do anything";
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5151,
    write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
  };
}
class FakeCodexHost extends PtyHost {
  constructor(events) { super(events); this.fakeCodexPtys = new Map(); }
  createCodexPty(opts) { const f = makeFakePty(); this.fakeCodexPtys.set(opts.sessionId, f); return f; }
}
const host = new FakeCodexHost({
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
});

function writeRollout(codexHome, id, cwd, mtimeMs, day = new Date().toISOString().slice(0, 10).split("-")) {
  const dayDir = path.join(codexHome, "sessions", ...day);
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-09-23T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { session_id: id, cwd } }) + "\n");
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

/** Spawn a codex session, push ready, wait for the real give-up, and return the captured diagnostic line. */
async function giveUp(sessionId, cwd) {
  const lines = [];
  const origWarn = console.warn;
  console.warn = (...a) => { lines.push(a.join(" ")); };
  try {
    host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
    host.fakeCodexPtys.get(sessionId).push(`codex TUI booted\n${READY}\n`);
    await waitUntil(() => host.liveCodex.get(sessionId)?.engineSessionIdCaptureEndReason === "exhausted", { label: `${sessionId} exhausts` });
    await waitUntil(() => lines.some((l) => l.includes("give-up rollout diagnostic")), { label: `${sessionId} diagnostic logged` });
  } finally { console.warn = origWarn; }
  return { diag: lines.find((l) => l.includes("give-up rollout diagnostic")), all: lines };
}

// --- (1) created-but-unmatched, end-to-end: a STALE rollout for the right cwd is named with its reason ---
{
  const home = mkdtempManaged("loom-codex-giveup-home1-");
  process.env.CODEX_HOME = home;
  const cwd = mkdtempManaged("loom-codex-giveup-cwd1-");
  writeRollout(home, "id-stale-right-cwd", cwd, Date.now() - 60 * 60 * 1000); // an hour before the spawn
  const { diag, all } = await giveUp("giveup-1", cwd);
  check("(1) the give-up line still logs the original 'never discovered' warning", all.some((l) => l.includes("never discovered after 2 attempts")));
  check("(1) diagnostic names the candidate file", !!diag && diag.includes("id-stale-right-cwd"), diag);
  check("(1) diagnostic gives the mismatch reason (stale-mtime)", !!diag && diag.includes("verdict=stale-mtime"), diag);
  check("(1) diagnostic names the rollout dir searched + spawn cwd", !!diag && diag.includes(path.join(home, "sessions")) && diag.includes("spawnCwd="), diag);
}

// --- (2) fresh file, wrong cwd: verdict cwd-mismatch names the cwd the matcher read from the file ---
{
  const home = mkdtempManaged("loom-codex-giveup-home2-");
  process.env.CODEX_HOME = home;
  const cwd = "/fake/codex/giveup-cwd-2";
  const startedAt = Date.now() - 1000;
  writeRollout(home, "id-fresh-wrong-cwd", "/fake/codex/SOMEWHERE-ELSE");
  const line = describeRolloutCandidatesForDiagnostic(cwd, startedAt);
  check("(2) fresh rollout with another cwd → verdict=cwd-mismatch + metaCwd", line.includes("verdict=cwd-mismatch") && line.includes("metaCwd="), line);
  check("(2) agrees with the matcher: findConversationIdForSpawn returns null for the same inputs", findConversationIdForSpawn(cwd, startedAt) === null);
  // AGREEMENT CONTROL: same corpus, spawn cwd that DOES match → both sides say match.
  const okCwd = "/fake/codex/SOMEWHERE-ELSE";
  check("(2) control: matching cwd → matcher finds the id AND diagnostic says verdict=match",
    findConversationIdForSpawn(okCwd, startedAt) === "id-fresh-wrong-cwd" &&
    describeRolloutCandidatesForDiagnostic(okCwd, startedAt).includes("verdict=match"));
}

// --- (3) never created: empty sessions dir → "none present" (end-to-end through the real give-up) ---
{
  const home = mkdtempManaged("loom-codex-giveup-home3-");
  process.env.CODEX_HOME = home;
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const { diag } = await giveUp("giveup-3", mkdtempManaged("loom-codex-giveup-cwd3-"));
  check("(3) empty rollout dir → diagnostic says 'none present'", !!diag && diag.includes("none present"), diag);
}

// --- (4) bounded: many candidates → at most ROLLOUT_DIAG_MAX_CANDIDATES named, total length capped ---
{
  const home = mkdtempManaged("loom-codex-giveup-home4-");
  process.env.CODEX_HOME = home;
  for (let i = 0; i < 40; i++) writeRollout(home, `id-many-${String(i).padStart(2, "0")}`, `/fake/codex/other-${i}`);
  const line = describeRolloutCandidatesForDiagnostic("/fake/codex/giveup-cwd-4", Date.now() - 1000);
  const named = (line.match(/id-many-\d\d/g) ?? []).length;
  check(`(4) only the newest ${ROLLOUT_DIAG_MAX_CANDIDATES} of 40 candidates are named (got ${named})`, named === ROLLOUT_DIAG_MAX_CANDIDATES, line);
  check("(4) the header reports the in-window total (40)", line.includes("rolloutsInWindow=40"), line);
  // Length cap: a pathologically long cwd must be truncated, not emitted whole.
  const long = describeRolloutCandidatesForDiagnostic("/x/" + "y".repeat(5000), Date.now() - 1000);
  check(`(4) line length is capped (${long.length} <= ${ROLLOUT_DIAG_MAX_CHARS + 20}) and marked truncated`,
    long.length <= ROLLOUT_DIAG_MAX_CHARS + 20 && long.includes("[truncated]"));
  check("(4) the line is a single line", !/[\r\n]/.test(line) && !/[\r\n]/.test(long));
}

// --- (6) window: a rollout in an OLD day dir (outside the matcher-relevant window) is NOT listed or walked ---
{
  const home = mkdtempManaged("loom-codex-giveup-home6-");
  process.env.CODEX_HOME = home;
  writeRollout(home, "id-old-day-outside-window", "/fake/codex/old", Date.now() - 400 * 24 * 3600 * 1000, ["2025", "08", "01"]);
  writeRollout(home, "id-today-inside-window", "/fake/codex/today");
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
  const line = describeRolloutCandidatesForDiagnostic("/fake/codex/giveup-cwd-6", Date.now() - 1000);
  check("(6) an old-day-dir rollout outside the window is NOT listed", !line.includes("id-old-day-outside-window"), line);
  check("(6) the in-window rollout IS listed", line.includes("id-today-inside-window"), line);
  check("(6) the line names the window searched (searchedDays=<today>) and counts only in-window files", line.includes(`searchedDays=${today}`) && line.includes("rolloutsInWindow=1"), line);
  const oldOnly = mkdtempManaged("loom-codex-giveup-home6b-");
  process.env.CODEX_HOME = oldOnly;
  writeRollout(oldOnly, "id-old-only", "/fake/codex/old", Date.now() - 400 * 24 * 3600 * 1000, ["2025", "08", "01"]);
  check("(6) only-old corpus reads as none present in window", describeRolloutCandidatesForDiagnostic("/x", Date.now() - 1000).includes("none present in window"));
}

// --- (5) never throws: sessions root missing entirely ---
{
  process.env.CODEX_HOME = path.join(mkdtempManaged("loom-codex-giveup-home5-"), "does-not-exist");
  let threw = false, line = "";
  try { line = describeRolloutCandidatesForDiagnostic("/x", Date.now()); } catch { threw = true; }
  check("(5) missing sessions root: does not throw, says none present", !threw && line.includes("none present"), line);
}

await finishAndExit(failures === 0 ? 0 : 1);
