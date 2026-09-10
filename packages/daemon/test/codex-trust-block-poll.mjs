import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card baa3435a — hermetic, fully-scripted-fake-pty coverage of the codex trust-dialog config.toml
// strip's TIMING fix.
//
// THE DEFECT THIS REPLACES (two real-spawn sightings, same signature — `codex-doctrine-real-spawn.mjs`,
// ops `ac8c10c4`/`c6bb870b`): after answering the trust dialog, `spawnCodexProcess`'s onData handler used
// to wait a FIXED 1500ms, then call `diffConfigAfterSpawn` exactly ONCE. Codex persists config.toml
// ASYNCHRONOUSLY with no confirming hook — if the real write landed after that ~1.8s mark (submit-enter
// delay + the fixed wait), the diff read `changed:false` and the trust block Loom itself added was left
// behind in the user's real `~/.codex/config.toml` forever, with no retry and no log line.
//
// TECHNIQUE (mirrors codex-queue-state-machine.mjs's own established pattern): a fake `createCodexPty()`
// override drives the REAL `spawnCodexProcess` onData/onExit handlers — including the actual
// `codexTrustDialogLock`-serialized poll/strip logic under test — against a SCRATCH `CODEX_HOME`
// (mirrors codex-host-decisions.mjs's own diffConfigAfterSpawn coverage), never a real codex process and
// never the real `~/.codex`. "Codex persisting config.toml late" is simulated the same way the real
// process actually does it — a plain `fs.appendFileSync` on the config file, independent of anything
// written to the pty — at a REAL, chosen wall-clock delay (not a mocked clock): late enough that the OLD
// fixed-1500ms-then-one-shot-diff code would already have taken its one and only look and missed it, but
// within the NEW poll's own (env-shrunk, but still real) deadline. `waitUntil` (poll for real state) is
// used for every "did it eventually happen" assertion — never a blind sleep guessed to outlast the poll.
//
// RED-BEFORE-GREEN: run via `pnpm --filter @loom/daemon negative-control --file src/pty/codex-doctrine.ts
// --file src/pty/host.ts --test test/codex-trust-block-poll.mjs` — see the worker report for the actual
// RED output this produced against the pre-fix code (the OLD fixed-1500ms path has no poll to shrink via
// env, so it takes its one look at ~1.5s-after-submit-enter-delay and never looks again).
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-trust-block-poll.mjs
//
// Timing knobs (all real time, env-overridable, read once at module load — set BEFORE the dynamic
// import): CODEX_SUBMIT_ENTER_DELAY_MS shrunk so the trust-dialog answer's own two-part write settles
// almost immediately; POLL_INTERVAL/POLL_DEADLINE sized so the fix's own poll can comfortably observe a
// persist landing well after the OLD code's ~1.5s single check point, while staying bounded. Chosen with
// real margin, not tight against anything — see each scenario's own comment for why its specific delay
// was picked.
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_CODEX_TRUST_DIFF_POLL_INTERVAL_MS = "100";
process.env.LOOM_CODEX_TRUST_DIFF_POLL_DEADLINE_MS = "3000";

import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const CODEX_HOME = mkdtempManaged("loom-codex-trust-poll-home-");
process.env.CODEX_HOME = CODEX_HOME;
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
fs.writeFileSync(CONFIG_PATH, "[some_other_section]\nfoo = 1\n");

const TMP = mkdtempManaged("loom-codex-trust-poll-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");
const { TRUST_DIALOG_MARKER } = await import("../dist/pty/codex-doctrine.js");
const { codexTrustDialogLock } = await import("../dist/pty/codex-host.js");

// Capture [codex-trust] console.warn lines without silencing anything else — restored at the end.
const warnLines = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnLines.push(args.join(" ")); originalWarn(...args); };

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5150,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
    writes,
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {},
  onCodexBootStuck() {}, onTurnCompleted() {}, onExit() {},
};
const host = new FakeCodexHost(events);

const addedBlock = (cwd) => `[projects.'${cwd}']\ntrust_level = "trusted"\n`;
const containsBlock = (cwd) => fs.readFileSync(CONFIG_PATH, "utf8").includes(addedBlock(cwd));

// --- SCENARIO A: a "late persist" landing well after the OLD code's one-shot check point, but inside
// the NEW poll's own deadline — the fix's core claim. -------------------------------------------------
{
  const SESSION_A = "codex-trust-poll-a";
  const CWD_A = "/fake/codex/trust-poll-a";
  host.spawn({
    sessionId: SESSION_A, cwd: CWD_A, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const ptyA = host.fakeCodexPtys.get(SESSION_A);
  check("(scenario A setup) config.toml carries no trust block for this cwd yet", containsBlock(CWD_A) === false);

  ptyA.push(`some boot chrome\n${TRUST_DIALOG_MARKER}\n1. Yes, continue\n2. No, quit`);
  check("trust dialog recognized and answered (latched synchronously)", host.liveCodex.get(SESSION_A).trustDialogAnswered === true);
  await waitUntil(() => host.liveCodex.get(SESSION_A).trustDialogPending === false, { label: "scenario A's two-part answer write has actually completed" });

  // Simulate codex's own ASYNCHRONOUS persist landing at 2200ms after the answer — comfortably PAST the
  // OLD code's fixed-1500ms-then-one-shot-diff check point (with CODEX_SUBMIT_ENTER_DELAY_MS shrunk to
  // 20ms above, the old code's one and only look happens at ~1520ms), and comfortably INSIDE the new
  // poll's 3000ms deadline (leaving room for at least one more 100ms poll tick before expiry).
  setTimeout(() => {
    fs.appendFileSync(CONFIG_PATH, `\n${addedBlock(CWD_A)}`);
  }, 2200);

  await waitUntil(() => containsBlock(CWD_A) === true, { timeoutMs: 2500, label: "scenario A: the simulated late write actually landed on disk (setup check, not the fix under test)" });
  let scenarioAStripped = false;
  try {
    await waitUntil(() => containsBlock(CWD_A) === false, { timeoutMs: 2500, label: "scenario A: the trust block gets stripped after the late persist" });
    scenarioAStripped = true;
  } catch (err) {
    console.error(String(err));
  }
  check("FIX PROOF (RED on main, per the worker report's negative-control run): the poll observes the late persist and strips it — the block is gone again", scenarioAStripped);
  check("scenario A: config.toml still carries the unrelated pre-existing section untouched", fs.readFileSync(CONFIG_PATH, "utf8").includes("[some_other_section]"));
}

// --- SCENARIO B: no persist ever arrives — the poll must give up at its own deadline, log ONCE (DoD-3),
// and never call removeAddedTrustBlocks (nothing to remove). ------------------------------------------
const SESSION_B = "codex-trust-poll-b";
const CWD_B = "/fake/codex/trust-poll-b";
{
  host.spawn({
    sessionId: SESSION_B, cwd: CWD_B, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const ptyB = host.fakeCodexPtys.get(SESSION_B);
  ptyB.push(`some boot chrome\n${TRUST_DIALOG_MARKER}\n1. Yes, continue\n2. No, quit`);
  await waitUntil(() => host.liveCodex.get(SESSION_B).trustDialogPending === false, { label: "scenario B's two-part answer write has actually completed" });

  await waitUntil(
    () => warnLines.some((l) => l.includes(`[codex-trust] ${SESSION_B}`) && l.includes("still unchanged after") && l.includes("polling")),
    { timeoutMs: 4000, label: "scenario B: the deadline-expiry warn line fires (DoD-3)" },
  );
  check("scenario B: no block was ever added for this cwd (nothing to strip)", containsBlock(CWD_B) === false);
  check(
    "scenario B: the deadline-expiry warn fired EXACTLY once, not once per poll tick",
    warnLines.filter((l) => l.includes(`[codex-trust] ${SESSION_B}`) && l.includes("still unchanged after")).length === 1,
  );
}

// --- SCENARIO C (same session as B, continued): a persist that lands AFTER the poll's own deadline has
// already expired — DoD-2's exit-time final attempt is the only thing left that can still catch it. ----
{
  fs.appendFileSync(CONFIG_PATH, `\n${addedBlock(CWD_B)}`);
  check("(scenario C setup) the late-late persist is on disk before the session exits", containsBlock(CWD_B) === true);
  const ptyB = host.fakeCodexPtys.get(SESSION_B);
  ptyB.kill(); // simulate an exit (crash-shaped: no graceful stop sequence) — the final check must fire on ANY exit, not just an intended one
  await waitUntil(() => host.liveCodex.get(SESSION_B).alive === false, { label: "scenario C: onExit fired" });
  let scenarioCStripped = false;
  try {
    await waitUntil(() => containsBlock(CWD_B) === false, { timeoutMs: 2000, label: "scenario C: the trust block gets stripped at exit" });
    scenarioCStripped = true;
  } catch (err) {
    console.error(String(err));
  }
  check("FIX PROOF (DoD-2): the exit-time final attempt catches a persist that landed after the poll's own deadline — the block is stripped", scenarioCStripped);
  check(
    "scenario C: the exit-time strip logged its own distinct line",
    warnLines.some((l) => l.includes(`[codex-trust] ${SESSION_B}`) && l.includes("stripped a late-persisted trust block at exit")),
  );
}

// --- SCENARIO D: idempotence — a SECOND exit-time check against a session whose block was already fully
// stripped (by the poll itself, scenario A's shape) must be a genuine no-op, never a double-strip attempt
// that corrupts the file or fires a spurious "stripped at exit" line. -----------------------------------
{
  const SESSION_D = "codex-trust-poll-d";
  const CWD_D = "/fake/codex/trust-poll-d";
  host.spawn({
    sessionId: SESSION_D, cwd: CWD_D, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const ptyD = host.fakeCodexPtys.get(SESSION_D);
  ptyD.push(`some boot chrome\n${TRUST_DIALOG_MARKER}\n1. Yes, continue\n2. No, quit`);
  await waitUntil(() => host.liveCodex.get(SESSION_D).trustDialogPending === false, { label: "scenario D's two-part answer write has actually completed" });
  // Persist EARLY (well inside the poll's first tick) so the poll itself strips it, same as prod's common case.
  setTimeout(() => { fs.appendFileSync(CONFIG_PATH, `\n${addedBlock(CWD_D)}`); }, 50);
  await waitUntil(() => containsBlock(CWD_D) === false, { timeoutMs: 2000, label: "scenario D: the poll's own (non-late) strip completes" });
  const warnCountBeforeExit = warnLines.filter((l) => l.includes(`[codex-trust] ${SESSION_D}`)).length;
  ptyD.kill();
  await waitUntil(() => host.liveCodex.get(SESSION_D).alive === false, { label: "scenario D: onExit fired" });
  // Observable anchor, not a blind sleep, for the "nothing further happened" assertions below:
  // `ptyD.kill()` synchronously triggers onExit, which (since trustDialogAnswered is true for this
  // session) synchronously ENQUEUES its own job on the shared `codexTrustDialogLock` before this line
  // can run. That lock is proven FIFO elsewhere (codex-host-decisions.mjs) — awaiting our own no-op job
  // on the SAME lock guarantees the exit-time check's own job has fully settled (run and returned, or
  // been skipped entirely) by the time we get here, not merely that "enough time" has passed.
  await codexTrustDialogLock.withLock(async () => {});
  check("scenario D: no double-strip — config.toml is untouched beyond the poll's own single removal (still carries the unrelated section, nothing corrupted)", fs.readFileSync(CONFIG_PATH, "utf8").includes("[some_other_section]"));
  check(
    "scenario D: the exit-time check is a genuine no-op once already stripped — no spurious 'stripped at exit' line",
    !warnLines.some((l) => l.includes(`[codex-trust] ${SESSION_D}`) && l.includes("stripped a late-persisted trust block at exit")),
  );
  check("scenario D: no new [codex-trust] lines at all fired for this session at exit (idempotent, silent no-op)", warnLines.filter((l) => l.includes(`[codex-trust] ${SESSION_D}`)).length === warnCountBeforeExit);
}

console.warn = originalWarn;

console.log(failures === 0
  ? "\n✅ ALL PASS — card baa3435a's bounded poll (pollConfigDiffAfterSpawn) observes a codex config.toml persist that lands well after the OLD fixed-1500ms-then-one-shot-diff code would already have given up, and still strips it (scenario A); the poll gives up cleanly and logs exactly once when no persist ever arrives inside its own deadline (scenario B, DoD-3); a persist landing even LATER than the poll's own deadline is still caught by the exit-time final attempt (scenario C, DoD-2), which is idempotent and never double-strips or spuriously logs against a session whose block the poll had already fully removed itself (scenario D)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
