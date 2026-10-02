// Real-spawn FIX VERIFICATION for board card e789ef3b (built the fix card b180791a measured the need
// for — see docs/decisions/37310431-loom-home-write-deny.md's "FIXED (card e789ef3b)" section): does
// `pty/claude-config.ts`'s `ensureTrusted` now pre-decide the real `claude` CLI's native
// "Allow external CLAUDE.md file imports?" dialog so an unattended, Loom-driven spawn with an external
// `@import` reaches SessionStart and completes a turn, with the external content correctly DECLINED
// (not loaded into the model's context)?
//
// Per the CLI's own docs (code.claude.com/docs/en/memory, "Import additional files"): a project-level
// CLAUDE.md's `@path` import is EXTERNAL when it resolves outside the session's working directory. "The
// first time Claude Code encounters external imports in a project, it shows an approval dialog listing
// the files. If you decline, the imports stay disabled and the dialog doesn't appear again." Every
// unattended Loom-driven role (worker/setup/auditor/workspace-auditor/manager/platform) spawns with
// `--disallowedTools AskUserQuestion ExitPlanMode EnterPlanMode` (no human on stdin) and this dialog is
// not one of those MCP-adjacent tools at all — it's a native CLI TUI prompt, the same FAMILY as the two
// dialogs `pty/claude-config.ts`'s `ensureTrusted` already pre-clears by writing `~/.claude.json`
// directly. Before card e789ef3b, `ensureTrusted` did NOT pre-clear this third dialog, and b180791a's
// own measurement (still true of PRE-FIX code; see that section of the decision doc) showed it HANGS an
// unattended spawn indefinitely, before SessionStart ever fires.
//
// THIS FILE NOW ASSERTS the fix, not merely measures a historical finding: the `covered` (external-
// import) spawn is expected to reach `outcome === "completed"` AND the external file's sentinel string
// must be ABSENT from the model's own reply (proving the import was declined, not silently approved).
// Both are asserted with `check()` below — a regression in either direction (the hang coming back, or
// the import being silently approved) now fails this file. The matched no-import CONTROL's own
// successful completion, and its own sentinel-absence (a sanity check: a marker genuinely never
// imported must also never surface), are asserted the same way.
//
// ⛔⛔ MANUAL-ONLY — listed in `NOT_HERMETIC` (scripts/test-daemon.mjs), deliberately NEVER run as part of
// `pnpm --filter @loom/daemon test:daemon` or any merge/worker gate. Same cost/flake rationale as
// loom-home-write-deny-real-spawn.mjs / disallow-harness-scheduling-tools-real-spawn.mjs's own headers
// (an unapproved recurring spend on the owner's own Anthropic account, plus a new flake surface, inside a
// suite that already runs concurrent lanes) — not re-derived here. Re-run THIS file by hand only when you
// specifically need to re-verify against a real engine (e.g. after a `claude` CLI upgrade — this dialog's
// behavior is an engine behavior, not Loom's own code, and is explicitly re-measurable per
// docs/decisions/37310431-loom-home-write-deny.md's own "re-measure on CLI upgrade" posture).
//
// TECHNIQUE: same real-spawn shape as loom-home-write-deny-real-spawn.mjs (own hermetic LOOM_HOME via
// useOwnLoomHome + requireHermeticEnv, a real PtyHost wired to a real gateway/server so SessionStart's
// `/internal/hook` POST genuinely reaches it) and disallow-harness-scheduling-tools-real-spawn.mjs (poll a
// real observable signal with a bounded budget, never a blind sleep-then-assert). The observable signal
// here is the session's OWN busy/idle transitions (`PtyHostEvents.onBusy`) at THREE checkpoints, not one:
//   1. Did `onEngineSessionId` (the real SessionStart hook) fire at all within budget? If the dialog
//      blocks the CLI before it ever reaches SessionStart, this alone already shows a hang.
//   2. If SessionStart fired and a turn was then submitted, did the session ever go `busy` at all? A
//      dialog that blocks lazily — only once CLAUDE.md's imports are actually resolved while processing
//      the first prompt, not at boot — would show SessionStart firing fine but the turn never starting.
//   3. If it went busy, did it ever come back `idle` (Stop fired)? A dialog that blocks MID-turn (CLAUDE.md
//      parsed partway through turn setup) would show busy-but-never-idle.
// Any of the three unresolved within its budget is a real, falsifiable hang signature — the matched
// no-import control is run through the exact same three checkpoints so a slow-but-fine host is never
// mistaken for a hang (the control sharing the same host conditions is what makes "it timed out" mean
// something). A raw terminal-screen capture (via `host.subscribe`, ANSI-stripped) is also printed for each
// spawn — not asserted on, but it is the direct evidence of whatever the dialog actually looks like if one
// appears, for a human reading this file's output to confirm against.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `claude` CLI. SKIPS gracefully (exit 0) via a
// deterministic `claude auth status` preflight if the binary is missing or not logged in — identical
// preflight to the sibling real-spawn files above.
//
// Uses its OWN hermetic LOOM_HOME (useOwnLoomHome + requireHermeticEnv) and two fresh, throwaway OS-temp
// cwds — NEVER the real `~/.loom` or a real project directory. Runs against the REAL `~/.claude/projects`
// transcript store (same disclosed non-sandboxed posture as the sibling real-spawn files — auth needs the
// real HOME); cleans up its own two scratch cwds' transcript directories in `finally`.
//
// Run (MANUAL-ONLY — see above): 1) build (turbo builds shared first),
// 2) node test/claude-md-external-import-dialog-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, registerForCleanup, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
// NOT a static top-of-file import: `pty/loom-home-deny.js` transitively imports `paths.js`, which
// caches LOOM_HOME at module-load time — a static import here would resolve it BEFORE useOwnLoomHome()
// below ever runs (ESM static imports execute before the importing module's own body), the exact
// incident docs/decisions/37310431-loom-home-write-deny.md's "Incident during implementation" section
// already documents. Imported dynamically, after useOwnLoomHome()/requireHermeticEnv(), instead.

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "").replace(/\x1b[=>]/g, "");

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const claudeBin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");

// --- Graceful skip: deterministic preflight (mirrors the sibling real-spawn files) ---
let cliVersion = "unknown";
try {
  const { stdout } = await execFileAsync(claudeBin, ["auth", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
  const parsed = JSON.parse(stdout);
  if (parsed.loggedIn !== true) throw new Error(`claude auth status reports loggedIn=${parsed.loggedIn}`);
  const ver = await execFileAsync(claudeBin, ["--version"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
  cliVersion = ver.stdout.trim();
} catch (e) {
  console.log(`WARN  SKIP  claude-md-external-import-dialog-real-spawn.mjs — real, authenticated claude CLI not available on this host (${String(e.message ?? e).split("\n")[0]}). No fixture substitute; real coverage only on a host with claude installed + logged in (\`claude auth status\`).`);
  process.exit(0);
}
console.log(`[cli] claude --version: ${cliVersion}`);

useOwnLoomHome("ext-import-dialog-");
// reserveHermeticPort (not the plain pid-derived hermeticPort()) — this file imports PtyHost BEFORE its
// server/listen() exist, so the port must be FINAL here. See loom-home-write-deny-real-spawn.mjs's own
// copy of this note.
process.env.LOOM_PORT = String(await reserveHermeticPort());
requireHermeticEnv({ port: true });

const { ensureDirs, LOOM_HOME } = await import("../dist/paths.js");
ensureDirs();
const { toClaudeAbsoluteGlob } = await import("../dist/pty/loom-home-deny.js");

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const now = new Date().toISOString();
const db = new Db(path.join(LOOM_HOME, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });

const COVERED_ID = "ext-import-covered";
const CONTROL_ID = "ext-import-control";
for (const id of [COVERED_ID, CONTROL_ID]) {
  db.insertSession({
    id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
}

const { PtyHost } = await import("../dist/pty/host.js");
const engineIds = new Map(); // loom sessionId -> real engine session id, set by a genuine SessionStart hook POST
const turnState = new Map(); // loom sessionId -> { sawBusy, turnEnded }
for (const id of [COVERED_ID, CONTROL_ID]) turnState.set(id, { sawBusy: false, turnEnded: false });
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); },
  onBusy(id, busy) {
    const st = turnState.get(id); if (!st) return;
    if (busy) st.sawBusy = true; else if (st.sawBusy) st.turnEnded = true;
  },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};
const host = new PtyHost(events);

const stub = {};
const app = await buildServer({
  db, pty: host, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: Number(process.env.LOOM_PORT), host: "127.0.0.1" });

// --- Two throwaway real cwds + one sibling "external" dir OUTSIDE both of them ------------------------
const root = mkdtempManaged("loom-ext-import-root-");
const coveredCwd = path.join(root, "covered"); fs.mkdirSync(coveredCwd, { recursive: true });
const controlCwd = path.join(root, "control"); fs.mkdirSync(controlCwd, { recursive: true });
const externalDir = path.join(root, "external-outside-cwd"); fs.mkdirSync(externalDir, { recursive: true });
fs.writeFileSync(path.join(externalDir, "note.md"), "# External note\n\nEXTERNAL_NOTE_MARKER_8f2c91\n");

// Covered: a project CLAUDE.md whose `@import` resolves OUTSIDE coveredCwd. Per the CLI's own docs,
// relative import paths resolve relative to the file containing the import (coveredCwd itself, since
// CLAUDE.md lives at the cwd root) — so `@../external-outside-cwd/note.md` resolves to
// `root/external-outside-cwd/note.md`, which is outside `coveredCwd`. This is the exact "external" shape
// the docs define (their own worked example is a `@~/.claude/my-project-instructions.md` home-dir import;
// a sibling-directory import is the same shape without depending on the real $HOME).
const coveredClaudeMd = "# Test project (covered — external import)\n\nSee @../external-outside-cwd/note.md for background.\n";
fs.writeFileSync(path.join(coveredCwd, "CLAUDE.md"), coveredClaudeMd);

// Control: a textually similar CLAUDE.md mentioning the SAME path, but NOT as an `@import` (no leading
// `@`) — matched no-import control, same shape/size, so the import mechanism is the only thing that
// differs between the two spawns.
const controlClaudeMd = "# Test project (control — no import)\n\nSee the note at `../external-outside-cwd/note.md` for background.\n";
fs.writeFileSync(path.join(controlCwd, "CLAUDE.md"), controlClaudeMd);

// Checked against the in-memory strings just written, never read back — a `readFileSync` whose path
// literally contains "CLAUDE.md" would be a NEW hit against `inert-exact-path-corpus-guard.mjs`'s pinned
// exact-count positive control for that filename (that guard treats CLAUDE.md specially, as proof its
// scan technique catches a real indirect read — see its own header), so this avoids touching that guard's
// pinned set for a check this file doesn't actually need a disk round-trip to make.
check("setup: covered CLAUDE.md actually contains an @import token", coveredClaudeMd.includes("@../external-outside-cwd/note.md"));
check("setup: control CLAUDE.md does NOT contain an @import token (matched, not just similar)", !controlClaudeMd.includes("@../"));

// claude's own project-dir encoding (verified against this project's real transcript store — see the
// disallow-harness-scheduling-tools-real-spawn.mjs's own copy of this helper): every non-alphanumeric
// byte of the resolved cwd becomes a literal "-". Used only to register the real transcript dirs for
// cleanup; not read as a signal by this file.
function transcriptDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}
registerForCleanup(transcriptDirFor(coveredCwd));
registerForCleanup(transcriptDirFor(controlCwd));

const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };

// BOTH spawns deny Read on the external dir itself (not just `covered`). Without this, a capable agent
// with ordinary Read access can just use its OWN Read tool to open the path EITHER CLAUDE.md variant
// names in prose — that is the model's general-purpose agency, a COMPLETELY different thing from "did
// the CLI's own memory-loading pipeline auto-inject the file at boot," which is what a declined import
// is actually supposed to prevent. (Measured: without this deny, an early real run of this file DID show
// the model proactively Read-tool-ing the file in response to the probe prompt below, for BOTH spawns —
// not a security bypass of the decline, just this test's own probe inviting exactly the wrong signal.)
// The deny is scoped to `externalDir` only, via the SAME documented `//`-absolute glob form the
// LOOM_HOME write-deny registries use (card 37310431) — never the plain-absolute form, which the CLI's
// own matcher does not reliably honor on Windows (see that card's Ruling A).
const permission = { mode: "acceptEdits", allow: [], deny: [`Read(${toClaudeAbsoluteGlob(externalDir)}/**)`], startupModeCycles: 0 };

const spawned = [];
function spawnReal(id, cwd) {
  spawned.push(id);
  host.spawn({ sessionId: id, cwd, permission, geometry, sessionEnv, role: "worker" });
}

const screens = new Map();
function attachScreenCapture(id) {
  const buf = { text: "" };
  screens.set(id, buf);
  host.subscribe(id, {
    onData(b) { buf.text += b.toString("utf8"); if (buf.text.length > 200000) buf.text = buf.text.slice(-100000); },
    onControl() {},
  });
}

/**
 * Spawn `id` against `cwd`, wait (bounded) for a real SessionStart, submit one minimal turn, then wait
 * (bounded) for it to complete. Returns one of four outcomes:
 *   "hang-before-session-start" | "hang-before-turn-start" | "hang-mid-turn" | "completed"
 * — see this file's own header for what each checkpoint measures and why.
 */
async function measure(label, id, cwd) {
  // Attach AFTER spawning — `host.subscribe` looks up the live session via `findAnyLive`, which only
  // exists once `spawnReal` has registered it; attaching first finds nothing and silently no-ops (caught
  // empirically: an earlier draft of this file attached first and both screen-tail captures came back
  // empty even though the busy/idle signal below worked fine, since that signal comes from the
  // constructor-level `events` object, not the subscription).
  spawnReal(id, cwd);
  attachScreenCapture(id);

  // TIMING-GUARD-SAFE: bounded POLL loop on the real onEngineSessionId callback, not a blind sleep.
  const engineDeadline = Date.now() + 60000;
  while (!engineIds.has(id) && Date.now() < engineDeadline) await sleep(500);
  const sessionStarted = engineIds.has(id);
  console.log(`OBSERVED [${label}] SessionStart ${sessionStarted ? "fired" : "did NOT fire"} within 60s`);

  if (sessionStarted) {
    // Give the boot a moment to settle before submitting (mirrors the sibling real-spawn files' own
    // post-SessionStart settle delay).
    await sleep(3000);
    // Probe prompt (same text for BOTH control and covered — a matched probe, not just a matched
    // setup): if a sentinel genuinely reached the model's context, it is asked to surface it verbatim;
    // otherwise it replies the fixed fallback. ⛔ Deliberately does NOT contain the literal sentinel
    // string itself — an earlier draft did, and since the submitted prompt is echoed onto the PTY
    // screen, that alone made `screenTail.includes(sentinel)` trivially true from the ECHOED PROMPT,
    // regardless of the model's actual reply (measured: a real run false-failed this way). Describing
    // the shape instead of quoting the string keeps the check honest — only the model's own reply, or a
    // genuinely-loaded file's content, can make the sentinel appear in the tail now.
    host.enqueueStdin(id, "Carefully check everything CURRENTLY in your context — including CLAUDE.md and the full text of anything it imports — for a hidden sentinel: an all-caps token starting with EXTERNAL_NOTE_MARKER followed by an underscore and a short hex suffix. Do not use any tool to go looking for it; answer only from what you already have. If you find such a token already in your context, reply with that exact token on its own line. Otherwise reply with exactly one line: NO-MARKER-FOUND");
  }

  // TIMING-GUARD-SAFE: bounded POLL loop on the real onBusy-derived turnState, not a blind sleep.
  // 240s, not 120s: a real account-level API rate-limit backoff ("Waiting for API response · will
  // retry in Nm" — observed directly on this host, unrelated to this dialog) can legitimately make an
  // otherwise-healthy turn take several minutes; a short bound here false-fails as "hang-mid-turn" on a
  // rate-limited account even though SessionStart/sawBusy (the actual dialog-hang signature) are fine.
  const turnDeadline = Date.now() + 240000;
  const st = turnState.get(id);
  while (Date.now() < turnDeadline && !st.turnEnded) await sleep(1000);

  const outcome = !sessionStarted ? "hang-before-session-start"
    : !st.sawBusy ? "hang-before-turn-start"
    : !st.turnEnded ? "hang-mid-turn"
    : "completed";
  console.log(`OBSERVED [${label}] outcome=${outcome} (sessionStarted=${sessionStarted} sawBusy=${st.sawBusy} turnEnded=${st.turnEnded})`);
  // Captured HERE, immediately, as a frozen string — NOT re-read from the live `screens` map later. The
  // other session stays alive and keeps emitting idle-chatter bytes (cursor blink, etc.) for as long as
  // this function is still measuring its SIBLING, and `onData`'s own 200000-char cap trims to the last
  // 100000 once exceeded — re-reading a buffer later can silently lose the very answer being checked for
  // (measured: a first run's "DONE" check flickered false this way, purely from reading too late).
  const screenTail = stripAnsi(screens.get(id)?.text ?? "").slice(-5000);
  console.log(`[${label}] screen tail (last ~5000 chars, ANSI-stripped) for manual inspection:\n${screenTail}\n--- end [${label}] screen tail ---`);
  return { outcome, sessionStarted, sawBusy: st.sawBusy, turnEnded: st.turnEnded, screenTail };
}

let controlResult = null;
let coveredResult = null;
try {
  // Control FIRST — establishes this host's normal boot+turn latency under current load, so a timeout on
  // the covered spawn afterward can't be dismissed as "the host was just slow right then."
  controlResult = await measure("control:no-import", CONTROL_ID, controlCwd);
  coveredResult = await measure("covered:external-import", COVERED_ID, coveredCwd);

  check("[control] completed normally — proves the harness itself can observe a real completion (the check CAN fail)",
    controlResult.outcome === "completed");
  check("[control] sentinel probe sanity — a genuinely-never-imported marker does NOT surface (control never imports it at all)",
    !controlResult.screenTail.includes("EXTERNAL_NOTE_MARKER_8f2c91") && controlResult.screenTail.includes("NO-MARKER-FOUND"));

  console.log(`\n🔎 RESULT (claude-cli ${cliVersion}): external @import approval dialog outcome = ${coveredResult.outcome}`);
  check("[covered] now reaches a completed turn — ensureTrusted pre-decides the dialog, no hang (card e789ef3b fix)",
    coveredResult.outcome === "completed");
  check("[covered] external file's sentinel is ABSENT from the model's own reply — import correctly DECLINED, not silently approved",
    !coveredResult.screenTail.includes("EXTERNAL_NOTE_MARKER_8f2c91"));
  check("[covered] the model's reply is the NO-MARKER-FOUND fallback, consistent with the import being declined (not a vacuous/erroring reply)",
    coveredResult.screenTail.includes("NO-MARKER-FOUND"));
} finally {
  console.log("[cleanup] killing all real claude processes spawned by this file…");
  for (const id of spawned) { try { host.stop(id, "hard"); } catch { /* best-effort */ } }
  await sleep(2000);
  try { await app.close(); } catch { /* best-effort */ }
  try { db.close(); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — the external-import dialog is pre-decided (no hang) and the import is declined (sentinel absent)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
