// Card fedef6a0 — FORCED reproduction of armCodexBusyStaleTimer's CASE 3 (the spurious-retry path),
// per manager direction after 5 natural real-spawn trials (codex-submit-confirmation-real-spawn.mjs)
// all took CASE 2 ("confirmed") immediately and never exercised CASE 3 at all.
//
// THE OPEN QUESTION (named in armCodexBusyStaleTimer's own doc comment, host.ts): whether a stray bare
// "\r" retry into an already-emptied, mid-turn codex composer is harmless (a no-op on empty input, as
// most TUIs do) or does something unwanted, was never verified against a real process.
//
// DESIGN CONSTRAINT (the manager's own words — this is what makes the forced state a sound control):
//   SUPPRESS THE CONFIRMATION SIGNAL, NOT THE ENTER.
// In a genuine race the first Enter DID land — that is precisely why confirmation was a false negative —
// so the representative state is: message genuinely submitted -> confirmation artificially withheld ->
// retry fires -> bare extra Enter arrives at a composer whose message already went through. Suppressing
// the Enter itself would test a DIFFERENT state (an unsent composer) — the one the fix is SUPPOSED to
// act on — which would prove the fix works, not that a SPURIOUS retry is harmless. Those are different
// questions and only the second is open. See project memory
// a-control-inherits-the-equivalence-you-assumed-building-it: name the mechanism the forced state shares
// with the real one before trusting it as a control — here, the shared mechanism is "the real Enter
// genuinely reached the real pty and codex genuinely started processing it", proven below via a
// positive control on the UNFILTERED side channel, not assumed.
//
// MECHANISM: `PtyHost#createCodexPty` is the project's own documented test seam ("a test can subclass
// PtyHost and override this to return a fake pty with no real codex process. Production never overrides
// it." — host.ts). This probe uses that seam, but does NOT fake the pty — it wraps a REAL one:
//   - write() passes straight through untouched. The real Enter ALWAYS lands on the real process.
//   - onData(cb)'s callback — the SAME callback spawnCodexProcess registers to feed its own
//     isCodexBusy() classification — receives a copy of each chunk with the two production busy
//     markers (BUSY_STATUS_MARKER / BUSY_TITLE_SPINNER_RE, imported UNMODIFIED from
//     dist/pty/codex-doctrine.js — never a hand-guessed pattern) stripped out, but ONLY while
//     suppression is armed.
//   - Every real, UNFILTERED chunk is ALSO captured on a side channel + tested with the real,
//     unmodified isCodexBusy() — this is the positive control: it proves the marker genuinely appeared
//     in reality during the suppression window (i.e. the forced condition is genuine — codex really did
//     start processing — not a no-op because nothing would ever have confirmed anyway).
//
// SCOPE: this is NOT a permanent regression test. Per manager direction it is a ONE-SHOT, hand-reviewed
// investigation ("a mechanism question, not a rate question... ONE clean observation is enough"). It is
// deliberately NOT placed under packages/daemon/test/ and NOT wired into scripts/test-daemon.mjs or
// CODEX_REAL_SPAWN_BASENAMES — dropping it there would make it a REGULAR gate test that spawns real
// codex on every run, which is wrong for a manual, manager-gated probe. Run manually, under the shared
// real-codex lock, only when explicitly granted. Findings: ../findings.md (sibling of this script).
//
// Card 605f002d — the ORIGINAL fixed 6000ms post-lift observation window read host.isBusy() as still
// true at the 6s mark on a host where the original turn was genuinely still completing (slowed by the
// disclosed MCP-startup-incomplete condition below), leaving one pre-registered INERT criterion
// unevaluable as written — resolved, wrongly, by substituting a different observable after the fact.
// The window below is now EVENT-GATED, not duration-gated: it waits for the original turn's own
// completion to be POSITIVELY ESTABLISHED (the composer's idle placeholder reappears AND a real
// confirm-idle busy edge — armCodexBusyStaleTimer's CASE 2, "codex-marker-stale" — fires), then
// evaluates the post-retry state. This makes "did the extra Enter start anything?" answerable
// regardless of how long the original turn took on a given host, without trading one arbitrary
// constant for a larger one. If the completion event never fires within the wait budget, that is
// reported as an explicitly UNEVALUATED criterion — never silently treated as clean, and never
// resolved by falling back to a duration read instead.
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
const DIST_PTY_DIR = path.join(REPO_ROOT, "packages/daemon/dist/pty");
for (const p of [TEST_DIR, DIST_PTY_DIR]) {
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

try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  fedef6a0-codex-spurious-retry-forced-probe — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}).`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-forced-retry-probe-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await importFrom(DIST_PTY_DIR, "host.js");
const { BUSY_STATUS_MARKER, BUSY_TITLE_SPINNER_RE } = await importFrom(DIST_PTY_DIR, "codex-doctrine.js");
const { isCodexBusy } = await importFrom(DIST_PTY_DIR, "codex-host.js");

const SESSION_ID = "codex-forced-retry-probe";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-forced-retry-cwd-"));

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const releaseCodexLock = await acquireCodexRealSpawnLock();

// --- The forcing wrapper -------------------------------------------------------------------------------
// Global-flag CLONES of the exact production regexes (never hand-guessed patterns) — .source is reused
// verbatim so a future change to the real markers can never silently desync this probe from what
// production actually checks.
const busyStatusGlobal = new RegExp(BUSY_STATUS_MARKER.source, "g");
const busyTitleGlobal = new RegExp(BUSY_TITLE_SPINNER_RE.source, "g");

const suppress = { on: false };
const sideChannel = { raw: "" }; // UNFILTERED ground truth, for the positive control
let realMarkerSeenWhileSuppressed = false;
let strippedChunkCount = 0;

function wrapRealPtyForForcedRetry(real) {
  return {
    get pid() { return real.pid; },
    get cols() { return real.cols; },
    get rows() { return real.rows; },
    get process() { return real.process; },
    get handleFlowControl() { return real.handleFlowControl; },
    set handleFlowControl(v) { real.handleFlowControl = v; },
    onData(cb) {
      return real.onData((d) => {
        sideChannel.raw += d;
        if (suppress.on) {
          if (isCodexBusy(d)) realMarkerSeenWhileSuppressed = true; // positive control — checked against the REAL unfiltered chunk
          const stripped = d.replace(busyStatusGlobal, "").replace(busyTitleGlobal, "");
          if (stripped !== d) strippedChunkCount++;
          cb(stripped); // PtyHost's OWN onData handler — the thing under test — only ever sees this
        } else {
          cb(d); // suppression off: fully transparent passthrough, identical to the unwrapped pty
        }
      });
    },
    onExit(cb) { return real.onExit(cb); },
    resize(c, r) { return real.resize(c, r); },
    clear() { return real.clear(); },
    write(data) { return real.write(data); }, // ALWAYS passes straight through — the real Enter always lands
    kill(signal) { return real.kill(signal); },
    pause() { return real.pause(); },
    resume() { return real.resume(); },
  };
}

class ForcingPtyHost extends PtyHost {
  createCodexPty(opts) {
    const real = super.createCodexPty(opts);
    return wrapRealPtyForForcedRetry(real);
  }
}

const exitedSessions = new Map();
const unconfirmedEvents = [];
const busyEdges = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, isBusy, reason) { busyEdges.push({ t: Date.now(), isBusy, reason }); },
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
  onCodexSubmitUnconfirmed(sessionId, info) { unconfirmedEvents.push({ t: Date.now(), sessionId, ...info }); },
};
const host = new ForcingPtyHost(events);

let buf = "";
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- Boot + trust-dialog + ready, suppression OFF — identical to the sibling real-spawn test. ----------
try {
  await waitUntil(() => buf.includes("Ask Codex to do anything"), {
    label: `${SESSION_ID} real codex TUI advances past the trust dialog`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never advanced past the trust dialog within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- Arm suppression, THEN submit the one real turn. From this instant, PtyHost's own busy-marker
// classification is blind — but the real pty (and the real codex process behind it) is not. -------------
suppress.on = true;
const submitAt = Date.now();
// Snapshot the subscriber buffer's length right at submission — the idle placeholder ("Ask Codex to do
// anything") is already present in `buf` from the pre-submit trust-dialog wait above, so detecting its
// REAPPEARANCE after the turn completes must be scoped to content written after this point, not to mere
// presence anywhere in the whole buffer.
const bufLenAtSubmit = buf.length;
const PROMPT = "Reply with exactly the single word: pong. Do not run any commands.";
const enq = host.enqueueStdin(SESSION_ID, PROMPT, "system", undefined, undefined, "agent");
check("enqueueStdin delivered the one real turn immediately (session was idle post-boot)", enq.delivered === true);

// --- Wait for the FORCED retry to fire (submitConfirmAttempts >= 1) or for exhaustion. `host.liveCodex`
// is a plain runtime property (TS `private` is erased at compile time) — reading it here for diagnostic
// polling is a deliberate, disclosed use of an internal, not a production-code change. ------------------
let retryObservedAt = null;
try {
  await waitUntil(
    () => {
      const live = host.liveCodex.get(SESSION_ID);
      if (live && live.submitConfirmAttempts >= 1) { retryObservedAt = Date.now(); return true; }
      if (unconfirmedEvents.length > 0) { retryObservedAt = Date.now(); return true; }
      return false;
    },
    { label: `${SESSION_ID} the forced retry fires (submitConfirmAttempts >= 1) or exhausts`, timeoutMs: 8000 },
  );
} catch (err) {
  console.log(`FAIL  the forced retry never fired within budget — suppression did not force CASE 3: ${err.message}`);
  failures++;
}

const liveAtRetry = host.liveCodex.get(SESSION_ID);
console.log(`[info] submit->retry-observed elapsed: ${retryObservedAt ? retryObservedAt - submitAt : "N/A"}ms`);
console.log(`[info] submitConfirmAttempts at retry-observed instant: ${liveAtRetry?.submitConfirmAttempts ?? "N/A"}`);
console.log(`[info] POSITIVE CONTROL — real (unfiltered) busy marker seen during suppression: ${realMarkerSeenWhileSuppressed}`);
console.log(`[info] chunks where the marker was stripped from PtyHost's own view: ${strippedChunkCount}`);
console.log(`[info] raw (unfiltered) side-channel buffer at retry-observed instant — tail:\n${sideChannel.raw.slice(-800).replace(/\x1b/g, "\\x1b")}`);

check(
  "POSITIVE CONTROL: the real busy marker genuinely appeared in the unfiltered stream during suppression (proves this forced a REAL confirmation, not a no-op)",
  realMarkerSeenWhileSuppressed === true,
);
check("the forced retry actually fired (submitConfirmAttempts reached 1)", (liveAtRetry?.submitConfirmAttempts ?? 0) >= 1);

// --- Lift suppression. Observe what the extra bare Enter did to the REAL composer, with normal
// classification restored. EVENT-GATED, not duration-gated (card 605f002d — see this file's own header):
// wait for the ORIGINAL turn's own completion to be positively established — the composer's idle
// placeholder reappearing (the reply is rendered) AND a real confirm-idle busy edge firing
// (armCodexBusyStaleTimer's CASE 2) — THEN evaluate the post-retry state. Not a hard pass/fail on its
// own — this is what the manager asked to be OBSERVED and reported, not asserted against a guessed
// expectation; the gate only decides WHEN it is sound to look, not what the answer is. -------------------
suppress.on = false;
const preLiftUnconfirmedCount = unconfirmedEvents.length;
const preLiftBusyEdgeCount = busyEdges.length;
const TURN_COMPLETION_WAIT_MS = 30000; // a generous ceiling for a genuinely slow host, not a duration
  // this probe is expected to spend — the wait resolves the instant the event fires, same as every
  // other waitUntil() call in this file; see this file's header for why a LARGER fixed window would not
  // have actually fixed the original defect.
let turnCompletionEstablished = false;
try {
  await waitUntil(
    () => {
      const replyRenderedAgain = buf.slice(bufLenAtSubmit).includes("Ask Codex to do anything");
      const confirmIdleEdgeObserved = busyEdges.slice(preLiftBusyEdgeCount).some((e) => e.isBusy === false);
      if (replyRenderedAgain && confirmIdleEdgeObserved) { turnCompletionEstablished = true; return true; }
      return false;
    },
    {
      label: `${SESSION_ID} the original turn's own completion is positively established (idle placeholder reappeared + confirm-idle busy edge observed)`,
      timeoutMs: TURN_COMPLETION_WAIT_MS,
    },
  );
} catch (err) {
  console.log(`[info] turn completion was NOT positively established within the ${TURN_COMPLETION_WAIT_MS}ms budget: ${err.message}`);
}
console.log(`[info] --- post-retry evaluation, gated on turn completion (established: ${turnCompletionEstablished}) ---`);
console.log(`[info] host.isBusy at evaluation: ${host.isBusy(SESSION_ID)}`);
console.log(`[info] onCodexSubmitUnconfirmed fired again since lift: ${unconfirmedEvents.length > preLiftUnconfirmedCount}`);
console.log(`[info] busy edges observed since lift: ${JSON.stringify(busyEdges.slice(preLiftBusyEdgeCount))}`);
console.log(`[info] captured reply tail (subscriber buf, escaped) at evaluation:\n${buf.slice(-800).replace(/\x1b/g, "\\x1b")}`);

// --- stop() — mirrors the sibling real-spawn test exactly, timed the same way. ---------------------------
const stopStartedAt = Date.now();
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(SESSION_ID);
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (code=${exit.code}, intended=${exit.intended})`);
  check("the real codex process exited (graceful or backstop-killed either way is fine for THIS probe's purpose)", exitedSessions.has(SESSION_ID));
} catch (err) {
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (never observed onExit within budget)`);
  console.log(`FAIL  real codex never reported onExit within budget after graceful stop: ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort cleanup */ }
}
unsubscribe();

// --- md5-diff-disclose: same discipline as every sibling real-spawn file. --------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => {});

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("this project's own removeAddedTrustBlocks already stripped the expected trust block (no manual cleanup needed)", !stillPresent);
  if (stillPresent) {
    const removable = remaining.match(blockRe) ?? [];
    if (removable.length) {
      const restored = remaining.split(removable[0]).join("");
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed the block this project's own code should have already stripped: ${removable[0]}`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged.");
}

releaseCodexLock();

console.log(`\n[SUMMARY] retry forced: ${(liveAtRetry?.submitConfirmAttempts ?? 0) >= 1}; positive control (real marker seen while suppressed): ${realMarkerSeenWhileSuppressed}; turn completion positively established: ${turnCompletionEstablished}; second onCodexSubmitUnconfirmed after lift: ${unconfirmedEvents.length > preLiftUnconfirmedCount}; final busy state: ${host.isBusy(SESSION_ID)}`);
console.log(failures === 0 ? "\n✅ PROBE MECHANICS OK (see findings.md for the judgment call on harm/inert)." : `\n❌ ${failures} FAILURE(S) in probe mechanics itself.`);
await finishAndExit(failures === 0 ? 0 : 1);
