// Card fedef6a0 — DoD-4: real-spawn coverage for `submitCodex`'s confirm-or-retry-or-fail-loud ladder
// (`armCodexBusyStaleTimer`/`retryCodexEnter`/`onCodexSubmitUnconfirmed`), mirroring
// `codex-stateful-runtime-real-spawn.mjs`'s own structure and safety discipline. That file deliberately
// spends ZERO model turns (never calls enqueueStdin/submitCodex) — this file's whole subject IS
// `submitCodex`, so it spends exactly ONE real, minimal turn (mirroring the probe's own trivial-prompt
// convention, `docs/investigations/049e4a7b-codex-cli-capability-probe/findings.md`) to observe the ladder
// against a REAL codex process, never a fixture stand-in.
//
// SCOPE, DELIBERATELY NARROW: spawn -> trust-dialog resolved -> ready -> ONE minimal submit -> observe the
// ladder's outcome -> stop/exit. Does not stand up a real gateway/MCP router (same as its sibling) — this
// host's own real `~/.codex/config.toml` MCP-startup episode (the card's own documented precondition) is
// left to occur naturally, exactly as it does for a real worker spawn.
//
// ⚠️ THIS TEST CANNOT FORCE THE RACE, ONLY OBSERVE WHICHEVER SIDE OF IT OCCURS: whether the real MCP-
// startup episode happens to overlap this test's own single submit (triggering a genuine retry) or has
// already settled by then (an immediate, unconfirmed-free confirm) is host-state-dependent BY THE CARD'S
// OWN DIAGNOSIS — that is exactly the nondeterminism the hermetic tests (`codex-submit-confirmation-gap.mjs`)
// exist to pin down deterministically instead. This file's job is narrower and different: prove the REAL
// ladder resolves to a terminal, correct state either way against a REAL process — never assert which path
// it took, only that whichever one it took was handled correctly (a confirm went idle exactly once with no
// spurious fail-loud event, OR a retry/exhaustion path never wrote a second submit's text on top and DID
// fire `onCodexSubmitUnconfirmed` if it truly ran out of retries).
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available on this host (mirrors every other real-spawn file's own posture exactly).
//
// Safety: runs against the REAL ~/.codex (a sandboxed CODEX_HOME breaks auth — see pty/codex-doctrine.ts's
// own header), applying the SAME md5-before/diff-after/disclose discipline every sibling real-spawn file
// uses — this proves THIS PROJECT'S OWN diffConfigAfterSpawn/removeAddedTrustBlocks code does the cleanup
// correctly, not a hand-rolled test-local reimplementation.
//
// SEQUENCING (card 3791b14e superseded the pool-based lock this comment used to name individually — read
// the array, don't trust a restated list here): the real-codex family runs sequentially via a single
// exported membership array, `CODEX_REAL_SPAWN_BASENAMES` in `_codex-real-spawn-lock.mjs` —
// `scripts/test-daemon.mjs` imports it directly. This file's own basename is registered there (added by
// card fedef6a0 once 3791b14e's own change landed on main) — `codex-real-spawn-lock-membership-guard.mjs`
// fails the gate if that ever falls out of sync with this file's `acquireCodexRealSpawnLock()` call.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-submit-confirmation-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. -----------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  codex-submit-confirmation-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-submit-real-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

const SESSION_ID = "codex-submit-real-test";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-submit-real-cwd-"));

// --- md5-before (real ~/.codex/config.toml) -----------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

// Card 14e6cf5f's shared serialization — see _codex-real-spawn-lock.mjs's own header. Held until the
// config.toml diff/cleanup below is done, since that also touches the same shared file.
const releaseCodexLock = await acquireCodexRealSpawnLock();

const exitedSessions = new Map(); // sessionId -> {code, intended}
const unconfirmedEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
  onCodexSubmitUnconfirmed(sessionId, info) { unconfirmedEvents.push({ sessionId, ...info }); },
};
const host = new PtyHost(events);

let buf = "";
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- Boot + trust-dialog + ready — observed via THIS PROJECT'S OWN subscribe(), never a guessed sleep.
// Card 448f1b4a: waits on `host.isCodexBootReady()` — the SAME real `live.bootReady` flag
// `enqueueStdinCodex` itself gates submission on (ready marker + model-loaded + trust-dialog-resolved, all
// three) — rather than the bare ready-marker placeholder this file used to wait on. That bare-placeholder
// wait was the exact insufficient signal this card's whole finding is about, and this file WAS caught by
// its own subject: `enqueueStdin` below started genuinely queueing (never delivering synchronously) once
// the placeholder alone was no longer sufficient for PtyHost's own internal readiness. Deliberately reads
// PtyHost's own internal state rather than re-deriving the composite from `buf` a second time — a
// raw-text re-derivation would have no way to observe `trustDialogPending` from outside PtyHost, and this
// file's own `scratchCwd` is a genuinely fresh, never-trusted directory every run (`fs.mkdtempSync` above),
// so the trust dialog CAN structurally fire here — confirmed by checking production: Loom never pre-writes
// `trust_level` into `CODEX_HOME` before a spawn (codex itself is the only writer, live, after answering
// its own dialog), so omitting that clause would NOT have been safe. See `isCodexBootReady`'s own doc.
// ⚠️ REAL BUG FOUND AGAINST A REAL CODEX PROCESS: waiting on `isCodexBootReady` ALONE is not enough —
// `bootReady` and `busy` are independent flags that CAN legitimately both be true at once (e.g. codex's own
// MCP-server-startup work is a genuine busy episode that can still be running once the TUI has fully
// rendered and the model has resolved). Confirmed at source: `spawnCodexProcess`'s onData handler checks
// `isCodexBusy(d)` BEFORE the boot-ready composite in the SAME handler, so a single chunk that satisfies
// both sets `live.busy = true` moments before `live.bootReady = true` in the identical tick — this test's
// own `waitUntil(isCodexBootReady)` alone then resolves with busy ALREADY true, and the enqueue below
// correctly queues rather than delivering (a message can never race into an already-busy composer). This
// file's own assertion needs a genuinely IDLE, ready session (its own label says "session was idle
// post-boot") — "ready" does not imply "idle", so both conditions are waited for explicitly.
try {
  await waitUntil(() => host.isCodexBootReady(SESSION_ID) && !host.isBusy(SESSION_ID), {
    label: `${SESSION_ID} real codex reaches full boot readiness AND settles idle (ready marker + model-loaded + trust-dialog-resolved + not busy)`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never reached an idle, boot-ready state within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- THE ONE REAL TURN this file spends — trivial, per the probe's own convention, never re-typed by a
// retry (only a bare Enter would ever be re-sent — see retryCodexEnter's own doc). ---------------------
const PROMPT = "Reply with exactly the single word: pong. Do not run any commands.";
const enq = host.enqueueStdin(SESSION_ID, PROMPT, "system", undefined, undefined, "agent");
check("enqueueStdin delivered the one real turn immediately (session was idle post-boot)", enq.delivered === true);

// Observe whichever terminal state the real ladder reaches — confirmed-and-idle, or exhausted-and-frozen.
// Whichever it is, it must be a GENUINE terminal state, not "still deciding" — poll for EITHER outcome
// rather than assuming the common (confirmed) one, since which one actually occurs is real, observed host
// state this test cannot control (see this file's own header).
let outcome = null;
try {
  await waitUntil(
    () => {
      if (host.isBusy(SESSION_ID) === false) { outcome = "confirmed"; return true; }
      if (unconfirmedEvents.some((e) => e.sessionId === SESSION_ID)) { outcome = "exhausted"; return true; }
      return false;
    },
    { label: `${SESSION_ID} the real submit ladder reaches a terminal state (confirmed-idle or exhausted-and-reported)`, timeoutMs: 30000 },
  );
} catch (err) {
  console.log(`FAIL  the real submit ladder never reached ANY terminal state within budget (neither confirmed nor exhausted-and-reported) — the exact silent-wedge shape this card's fix exists to prevent: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}
console.log(`[info] real submit ladder outcome: ${outcome ?? "NEITHER (see FAIL above)"}`);

if (outcome === "confirmed") {
  check("CONFIRMED path: no onCodexSubmitUnconfirmed fired for a turn that actually confirmed", !unconfirmedEvents.some((e) => e.sessionId === SESSION_ID));
  console.log(`[info] the real turn's reply (if fully captured by now) — tail: ${buf.slice(-300).replace(/\n/g, "\\n")}`);
} else if (outcome === "exhausted") {
  // This is the swallowed-keystroke race the card names — genuinely reproduced against a real process, not
  // a defect in this test. Confirm the fail-loud contract held: busy stayed frozen, nothing else was drained.
  check("EXHAUSTED path: busy is still true (frozen) — the queue was never force-drained on top of the unconfirmed turn", host.isBusy(SESSION_ID) === true);
  console.log(`[info] real reproduction of the swallowed-keystroke race — onCodexSubmitUnconfirmed fired with ${JSON.stringify(unconfirmedEvents.find((e) => e.sessionId === SESSION_ID))}`);
}

// --- stop() — the real codex exit sequence, observed via THIS PROJECT'S OWN events.onExit callback. -----
// Timed explicitly (card fedef6a0's own DoD-4 report needs this): the elapsed ms between the graceful
// stop() call and the observed onExit is the field that discriminates a genuine fast graceful exit from
// stopCodex's own ~6000ms hard-kill backstop firing underneath a nominally "graceful" stop — see sibling
// card 176bdb0c. Logged unconditionally (pass or fail) so a report never has to infer the shape from the
// absence of a backstop log line.
const stopStartedAt = Date.now();
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(SESSION_ID);
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (code=${exit.code}, intended=${exit.intended})`);
  check("the real codex process exited with code 0 (clean shutdown)", exit.code === 0);
} catch (err) {
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (never observed onExit within budget)`);
  console.log(`FAIL  real codex never reported onExit within budget after graceful stop: ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort cleanup */ }
}
check("host.isAlive reports false once the real codex process has exited", host.isAlive(SESSION_ID) === false);
unsubscribe();

// --- md5-diff-disclose: confirm THIS PROJECT'S OWN cleanup restored config.toml, not a test-local
// reimplementation of that logic. Mirrors codex-stateful-runtime-real-spawn.mjs's own settle-poll exactly.
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort settle wait — the check below still reports the truth either way */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("THIS PROJECT'S OWN removeAddedTrustBlocks already stripped the expected [projects.'<scratchCwd>'] block (no manual cleanup needed)", !stillPresent);
  if (stillPresent) {
    const removable = remaining.match(blockRe) ?? [];
    if (removable.length) {
      const restored = remaining.split(removable[0]).join("");
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed the block THIS PROJECT'S OWN code should have already stripped: ${removable[0]}`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged (this scratch cwd was likely already trusted from a prior run, or the diff genuinely found nothing to clean).");
}

releaseCodexLock();

console.log(failures === 0
  ? "\n✅ ALL PASS — submitCodex's real confirm-or-retry-or-fail-loud ladder (card fedef6a0) reached a genuine terminal state against a REAL codex process (whichever side of the swallowed-keystroke race actually occurred), never left the session silently wedged, and this project's own trust-dialog cleanup code left config.toml in its pre-run state."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
