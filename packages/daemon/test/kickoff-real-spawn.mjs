import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0050a17e DoD #3/#4/#5 — REAL-SPAWN validation of the kickoff-delivery mechanism across roles, AT
// REALISTIC AND LARGE SIZE, AND under a LATE-booting real child. A mocked exec cannot exercise this
// (memory `real-spawn-smoke-for-subprocess-features`): it never proves bytes genuinely cross a real OS
// pty boundary into a real child process. This file drives the REAL (unsubclassed) `PtyHost.createPty()`
// — real node-pty, a real child process substituted for `claude` via `LOOM_CLAUDE_BIN` (the same
// substitution technique test/spawn-command-line-preflight.mjs already established) — and proves, for
// each role, that:
//   1. the real OS process receives NO positional startup-prompt argv entry (buildSpawnArgs' contract);
//   2. `live.lastPrompt` is seeded synchronously at spawn(), BEFORE the fixture ever signals readiness —
//      the crash-before-first-submit window (regression risk 1) stays closed at the real-spawn layer too;
//   3. once `ready` (SessionStart, simulated here since this fixture has no real mode-cycle footer),
//      the kickoff arrives on the real child's real stdin, byte-for-byte, EXACTLY ONCE — at ordinary
//      role-realistic size (the per-role sweep below), at 10KB/40KB (the large-payload section), AND when
//      the real child's own readiness signal arrives LATE (the late-ready section, `FIXTURE_READY_DELAY_MS`
//      — a Code Review MAJOR finding: that seam was documented in the fixture but never actually driven by
//      any test).
//
// The fixture (test/fixtures/fake-claude-cli.mjs) is a real, standalone Node process — not a mock of
// PtyHost or of node-pty. On Windows it's invoked through a tiny generated `.cmd` wrapper (node-pty's
// Windows agent CAN spawn `.cmd` files directly; `resolveExecutable` passes an absolute path through
// unchanged) since LOOM_CLAUDE_BIN takes a single executable, not an interpreter+script pair.
//
// WINDOWS-ONLY: the `.cmd`-wrapper mechanism above is Windows-specific. A POSIX equivalent (a
// shebang-executable fixture script, chmod +x, LOOM_CLAUDE_BIN pointed at it directly) was NOT built or
// verified here — this file SKIPS on non-win32 rather than silently passing 0 checks.
//
// CODE REVIEW CATCH (this card): an earlier version of this file verified delivery by having the fixture
// echo the received bytes BACK over the pty's own OUTPUT stream as base64, then reading that echo back
// through this harness's `subscribe()`. That produced a DETERMINISTIC "corruption" starting at a fixed
// absolute byte offset (~3296-3304) that looked like an INPUT-side ConPTY defect but was actually this
// harness's OWN verification method breaking: a real terminal's bounded screen buffer (rows × cols — 40 ×
// 120 here) silently drops/scrolls away echoed content past a few KB, and 37 usable rows × 120 cols ≈
// 4440 base64 chars ≈ 3330 decoded bytes, minus the leading escape sequence — predicts the observed
// ~3296-3304 offset to within 1%. Fixed: the fixture now writes the received bytes to a PLAIN FILE
// (`FIXTURE_OUTPUT_FILE`) — zero pty output for the payload itself — and this harness reads that file
// directly with `fs.readFileSync`. Only a short, stable summary line (`FIXTURE_RECEIVED len=… sha256=…`,
// ~100 chars, well within one terminal row) still rides the pty, for a quick visual sanity check.
//
// Run: 1) build (turbo builds shared first), 2) node test/kickoff-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  kickoff-real-spawn.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-kickoff-real-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// A .cmd wrapper so node-pty (which spawns `bin` directly with an args ARRAY, no shell/interpreter
// indirection) can launch `node fake-claude-cli.mjs` as the substitute "claude" binary.
const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;
process.env.FIXTURE_DEBOUNCE_MS = "250"; // generous quiet-period so a paced writeChunked chain fully lands first

const { PtyHost, buildSpawnArgs, MODE_LOG_POLL_MS, MODE_LOG_MAX_ATTEMPTS, READY_FALLBACK_MS } = await import("../dist/pty/host.js");
const { ensureDirs, WORKTREES_DIR } = await import("../dist/paths.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR);

// ============ Timeout budgets (card 27c36293) ============
// Card 0050a17e made kickoff delivery GATE on logLandedMode's footer-read poll settling first (see that
// function's own doc in pty/host.ts): up to MODE_LOG_MAX_ATTEMPTS polls of MODE_LOG_POLL_MS each, since
// THIS fixture never presents a real mode-cycle footer (no HEALABLE_MODES read is ever possible), so the
// poll always exhausts its full budget before onSettled fires — this is a DETERMINISTIC worst case, not a
// guess. kickoff-real-spawn's original 15s post-SessionStart delivery budget was calibrated BEFORE
// 0050a17e existed (delivery used to fire on the very next tick after markReady), so it never accounted
// for this floor. Deriving it from the SAME exported production constants host.ts itself computes (rather
// than hardcoding a second copy of "8" and "500") means this budget can never silently drift out of sync
// with a future change to either constant — and honors env overrides transparently: LOOM_MODE_LOG_POLL_MS
// inflates BOTH the real floor kickoff delivery waits on AND this derived budget together, which is what
// let this fix be positive-controlled (a scratch run that inflated LOOM_MODE_LOG_POLL_MS to 3000 proved
// the OLD fixed-15000ms formula times out at exactly that inflated floor while this derived formula
// survives it — see this card's worker_report for the numbers; not embedded here as a test since it
// depends on env mutation this file doesn't otherwise perform).
const KICKOFF_PRE_DELIVERY_FLOOR_MS = MODE_LOG_MAX_ATTEMPTS * MODE_LOG_POLL_MS;
// The FIXTURE_READY wait (real child process boot, BEFORE SessionStart/markReady ever runs) is NOT
// touched by 0050a17e's floor at all — nothing about logLandedMode runs before the child has even booted.
// It has no analogous code-level floor to derive from, so widening it "because it might be more
// load-exposed" would be exactly the reflexive-widening move memory `engine-confirmation-can-lag...`
// forbids. Instead: production ITSELF already budgets a real `claude` process up to READY_FALLBACK_MS to
// reach SessionStart from a cold spawn before giving up and marking ready anyway (see that constant's own
// doc) — this fixture's readiness line is a far cheaper signal than a real engine's full boot, so giving
// it at least as much room as production's own readiness fallback is a documented, derived floor, not an
// arbitrary pick.
const FIXTURE_READY_TIMEOUT_MS = Math.max(15000, READY_FALLBACK_MS);

const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
const workerSkill = fs.readFileSync(path.join(REPO_ROOT, ".claude", "skills", "worker", "SKILL.md"), "utf8");
console.log(`[measured] real CLAUDE.md=${claudeMd.length} chars, real worker SKILL.md=${workerSkill.length} chars`);

// Realistic per-role kickoff text — real prose, embedded quotes/backticks included, so escaping through
// the real bracketed-paste writeChunked path genuinely runs (not synthetic padding). Distinct per role so
// a cross-role mixup would be caught by the includes() check below. `targetSize` (optional) pads with
// real repeated prose (NOT synthetic "X" filler) up to roughly that many characters, for the large-payload
// section below — reusing real CLAUDE.md/SKILL.md text repeated, not padding characters, so escaping
// keeps genuinely running at scale.
function realisticKickoff(role, targetSize) {
  const base = `[role:${role}] ${claudeMd.slice(0, 4000)}\n\n---\n\n${workerSkill.slice(0, 3000)}\n\n` +
    `Do the "${role}" task now — quote test: says "hi" and uses \`backticks\` and a lone backslash \\ here.`;
  if (!targetSize || base.length >= targetSize) return base;
  const filler = `${claudeMd}\n\n${workerSkill}\n\n`;
  let out = base;
  while (out.length < targetSize) out += filler.slice(0, targetSize - out.length);
  return out;
}

class RealFixtureHarness {
  constructor(host) { this.host = host; this.buffers = new Map(); }
  attach(sessionId) {
    let buf = "";
    const unsub = this.host.subscribe(sessionId, {
      onData: (chunk) => { buf += chunk.toString("utf8"); },
      onControl: () => {},
    });
    this.buffers.set(sessionId, () => buf);
    return unsub;
  }
  text(sessionId) { return this.buffers.get(sessionId)?.() ?? ""; }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new PtyHost(events);
const harness = new RealFixtureHarness(host);
// Calling host.stop() TWICE on the same already-dead session was found, during this card's own
// development, to trigger a real node-pty/ConPTY internal crash that hangs the whole process past its
// own success banner (an uncaught async exception from node-pty's console-list-agent helper) — every
// session must be stopped EXACTLY once. Tracked here so the outer `finally` never re-stops one
// `verifyRealDelivery` already stopped at its own end.
const stoppedSessions = new Set();

/**
 * Spawn `sessionId` as `role`, deliver `kickoff` through the REAL pipeline, and verify it arrived intact
 * exactly once — via the fixture's OUTPUT FILE (never the pty's own output stream; see this file's
 * header). Returns nothing; records PASS/FAIL via `check()`. `label` prefixes every check so multiple
 * calls (per-role sweep, large-payload section) stay distinguishable in the log.
 */
async function verifyRealDelivery(label, sessionId, role, kickoff) {
  const outputFile = path.join(tmpHome, `received-${sessionId}`);
  process.env.FIXTURE_OUTPUT_FILE = outputFile;
  const opts = {
    sessionId, cwd: tmpHome, startupPrompt: kickoff, role,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  };

  // Real argv proof: reproduce (independently) the SAME buildSpawnArgs call createPty makes and assert
  // no positional prompt entry — the direct regression proof at the pure layer, paired below with the
  // fixture's OWN real-process assertion (FIXTURE_FAIL on an extra argv entry) for the real layer too.
  const reproArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: {}, startupPrompt: kickoff });
  check(`${label} buildSpawnArgs never emits the kickoff into argv`, !reproArgs.includes(kickoff) && !reproArgs.includes("--"));

  // subscribe() AFTER spawn(): it attaches to an existing `live` entry (replaying its ring + streaming
  // live) and is a silent no-op if no such entry exists yet — subscribing first would attach to nothing.
  const spawnStartedAt = performance.now(); // MEASUREMENT only, per manager guidance: report timing as a
  // number, never as a pass/fail bound — a real-OS wall-clock assertion on this box would be exactly the
  // timing-sensitive-test pattern a sibling card (1addef27) is closing. performance.now(), never Date.now().
  host.spawn(opts);
  harness.attach(sessionId);

  // Regression risk 1, at the real-spawn layer: lastPrompt must be seeded SYNCHRONOUSLY at spawn() —
  // checked here BEFORE the fixture has even had a chance to print FIXTURE_READY, i.e. before ANY
  // ready/submit machinery has run. A crash of the real child in this exact window must still leave
  // something to resubmit (§19c-b) — this is what proves the window is closed, not just the end state.
  check(`${label} live.lastPrompt seeded synchronously at spawn(), before ready/submit ever ran`,
    host.live.get(sessionId)?.lastPrompt === kickoff);

  // Wait for the REAL child process to boot and announce readiness over the REAL pty's data stream.
  // Elapsed time is printed on EVERY run (pass or fail — the `finally` runs even if waitUntil throws on
  // timeout) so a gate rejection carries a real measured number instead of just a bare timeout message.
  const readyWaitStartedAt = performance.now();
  try {
    await waitUntil(() => /FIXTURE_READY/.test(harness.text(sessionId)), { label: `${label} real fixture process signals FIXTURE_READY`, timeoutMs: FIXTURE_READY_TIMEOUT_MS });
  } finally {
    console.log(`   [measured ${label}] spawn()→FIXTURE_READY: ${Math.round(performance.now() - readyWaitStartedAt)}ms (budget ${FIXTURE_READY_TIMEOUT_MS}ms)`);
  }
  check(`${label} the real child process never reported an extra positional argv entry`, !/FIXTURE_FAIL/.test(harness.text(sessionId)));

  // Simulate SessionStart (this fixture has no real mode-cycle footer to converge on) — this is what
  // triggers markReady → the real kickoff delivery over the real pty.
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });

  // Wait for the REAL child's short summary line (stable size regardless of kickoff size — see header),
  // scaling the timeout with payload size since writeChunked paces large payloads over more real ticks,
  // PLUS the documented pre-delivery floor (see KICKOFF_PRE_DELIVERY_FLOOR_MS above) that 0050a17e added
  // between SessionStart and the kickoff's actual pty write.
  const deliveryTimeoutMs = KICKOFF_PRE_DELIVERY_FLOOR_MS + Math.max(15000, kickoff.length * 2);
  const deliveryWaitStartedAt = performance.now();
  try {
    await waitUntil(() => /FIXTURE_RECEIVED/.test(harness.text(sessionId)), { label: `${label} real fixture reports FIXTURE_RECEIVED`, timeoutMs: deliveryTimeoutMs });
  } finally {
    console.log(`   [measured ${label}] SessionStart→FIXTURE_RECEIVED: ${Math.round(performance.now() - deliveryWaitStartedAt)}ms (budget ${deliveryTimeoutMs}ms = ${KICKOFF_PRE_DELIVERY_FLOOR_MS}ms floor + ${Math.max(15000, kickoff.length * 2)}ms pacing, kickoff ${kickoff.length} chars)`);
  }
  console.log(`   [measured ${label}] spawn()→kickoff-landed (total): ${Math.round(performance.now() - spawnStartedAt)}ms (kickoff ${kickoff.length} chars)`);

  const receivedCount = (harness.text(sessionId).match(/FIXTURE_RECEIVED/g) || []).length;
  check(`${label} the kickoff was received exactly once (no duplicate delivery)`, receivedCount === 1);

  // The DECISIVE check: read the fixture's OUTPUT FILE directly — zero pty output involved, so no
  // terminal-geometry/screen-buffer ceiling on the payload size (see this file's header).
  const receivedPath = `${outputFile}.1`;
  const fileExists = fs.existsSync(receivedPath);
  check(`${label} the fixture's output file was written`, fileExists);
  const receivedRaw = fileExists ? fs.readFileSync(receivedPath, "utf8") : "";
  const rawMatch = receivedRaw.includes(kickoff);
  if (!rawMatch) {
    let i = 0; while (i < Math.min(kickoff.length, receivedRaw.length) && kickoff[i] === receivedRaw[i]) i++;
    console.log(`   [debug ${label}] sent.length=${kickoff.length} received.length=${receivedRaw.length}`);
    console.log(`   [debug ${label}] first diff at index ${i}: sent=${JSON.stringify(kickoff.slice(Math.max(0, i - 20), i + 20))} received=${JSON.stringify(receivedRaw.slice(Math.max(0, i - 20), i + 20))}`);
  }
  check(`${label} the kickoff text arrived on the real child's real stdin, byte-for-byte intact (file compare)`, rawMatch);

  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ }
  stoppedSessions.add(sessionId);
}

const ROLES = process.env.KICKOFF_TEST_ROLES ? process.env.KICKOFF_TEST_ROLES.split(",") : ["worker", "manager", "platform", "setup", "assistant", "auditor"];

try {
  // ===================== Per-role sweep, realistic size (~7KB) =====================
  for (const role of ROLES) {
    const sessionId = `real-${role}`;
    await verifyRealDelivery(`[${role}]`, sessionId, role, realisticKickoff(role));
  }

  // ===================== Large-payload section — 10KB and 40KB, DoD #3/#4 scale =====================
  // The per-role sweep above proves role coverage at realistic size; THIS proves the mechanism doesn't
  // silently degrade at the actual scale this card's fix exists for (the diagnosed incident's composed
  // prompt was ~41KB). One role (worker) is enough here — role-to-role differences are in disallowedTools/
  // mcpServers, already proven independent of payload size by the sweep above.
  for (const targetSize of [10_000, 40_000]) {
    const sessionId = `real-large-${targetSize}`;
    const kickoff = realisticKickoff("worker", targetSize);
    check(`[large ${targetSize}] fixture is actually built to the target scale`, kickoff.length >= targetSize);
    await verifyRealDelivery(`[large ${targetSize}]`, sessionId, "worker", kickoff);
  }

  // ===================== DoD #5 (Code Review MAJOR finding) — a LATE-booting real child ==================
  // The fixture documents FIXTURE_READY_DELAY_MS (simulate SessionStart arriving late — the real claude
  // process takes a while to boot before its TUI is up) but no test ever set it, leaving that documented
  // seam completely unused. This drives it for real: the real child delays its own FIXTURE_READY line by
  // 2s, so this harness's own `waitUntil(FIXTURE_READY)` genuinely waits — proving delivery still lands
  // correctly (once, intact) when readiness itself is slow, not just when it's near-instant like every
  // other scenario in this file.
  {
    process.env.FIXTURE_READY_DELAY_MS = "2000";
    try {
      await verifyRealDelivery("[late-ready]", "real-late-ready", "worker", realisticKickoff("worker"));
    } finally {
      delete process.env.FIXTURE_READY_DELAY_MS; // reset — every other scenario in this file expects instant readiness
    }
  }
} finally {
  // Only a SAFETY NET for a session that never reached its own stop() inside verifyRealDelivery (an
  // exception mid-run) — see stoppedSessions' own doc for why a double-stop must never happen.
  const allSessionIds = [...ROLES.map((role) => `real-${role}`), ...[10_000, 40_000].map((n) => `real-large-${n}`), "real-late-ready"];
  for (const sessionId of allSessionIds) {
    if (stoppedSessions.has(sessionId)) continue;
    try { host.stop(sessionId, "hard"); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — across every checked role (${ROLES.join(", ")}), at large scale (10KB, 40KB), AND when the real child's own readiness signal arrives 2s late, a REAL child process substituted for claude (real node-pty, real OS process, real bidirectional pty I/O) receives NO positional startup-prompt argv entry, has its Live.lastPrompt seeded synchronously at spawn() (closing the crash-before-first-submit window before the fixture even boots), and receives the kickoff text — embedded quotes/backticks and all — byte-for-byte intact over its real stdin (verified via a plain file the fixture writes, never via pty output), exactly once, after signaling readiness.`
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
