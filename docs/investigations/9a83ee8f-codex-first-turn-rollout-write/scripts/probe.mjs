// Card 9a83ee8f — DoD-1: settle the ONE inferred half card c6ce2804's probe left open. That probe
// (docs/investigations/c6ce2804-codex-resume-rollout-timing) twice established, directly on disk, that a
// real codex session which reaches ready and exits with ZERO turns run writes NO rollout file at all — but
// it deliberately spent zero model turns, so whether a rollout file appears once a REAL turn actually runs
// was never observed, only inferred from `captureCodexEngineSessionId`'s own disclosed hedge ("the rollout
// file is created lazily, around first-turn time, not at boot", pty/host.ts, card 2ec60d9c).
//
// This probe spends EXACTLY ONE real codex turn (the manager's own explicit budget for this card — "SPEND
// EXACTLY ONE codex model turn. One. Not a loop, not a retry sweep") to observe, via a direct on-disk
// before/after delta, whether that turn is what actually produces the file.
//
// MECHANISM: mirrors packages/daemon/test/codex-submit-confirmation-real-spawn.mjs's own spawn/boot/submit
// shape exactly (real `PtyHost.spawn({harness:"codex"})`, no in-process MCP gateway stood up — MCP
// reachability is orthogonal to rollout-file timing and is already covered elsewhere), but adds THREE
// on-disk snapshots of `~/.codex/sessions/**` (via `realCodexHome()`, the project's own resolved path —
// never a second, independently-hardcoded `os.homedir()` call) instead of only the exit-screen-id
// discriminator the resume probe used:
//   1. BEFORE the spawn at all.
//   2. AFTER boot reaches ready+idle, BEFORE the one turn is submitted (checks whether boot alone writes
//      anything — the established finding says no, and this is now checked directly rather than assumed).
//   3. AFTER the one real turn reaches a terminal state (confirmed-idle or exhausted) — THE key
//      measurement.
// Every snapshot restricts to files with mtimeMs >= spawnStartTime, so "a new file appeared" means exactly
// that, not "some older file already existed" (the newest-file selector is scoped forward from spawn start,
// mirroring `findConversationIdForSpawn`'s own `sinceMs` filter in codex-transcript.ts — never re-deriving
// that filter's intent from scratch).
//
// POSITIVE + NEGATIVE CONTROL ON THE SCAN MECHANISM ITSELF, before it is trusted against the real host tree
// (card CLAUDE.md doctrine: "confirming something ABSENT needs a check shown capable of returning non-zero,
// not just a negative control" — an absence here IS the thing being measured, so the scanner's own ability
// to find a KNOWN-PRESENT file must be shown first): a synthetic temp `sessions/YYYY/MM/DD/rollout-*.jsonl`
// tree with two files of DELIBERATELY DIFFERENT mtimes is scanned first, confirming (a) the newer file wins
// and (b) an mtime-filtered scan correctly excludes the older one — before the same function is ever pointed
// at the real ~/.codex/sessions tree.
//
// SCOPE: per the card's explicit stop condition, this probe does NOT build any mitigation (that is DoD-3,
// explicitly out of scope here) and does NOT touch CODEX_REAL_SPAWN_BASENAMES (a permanent per-gate cost on
// the owner's subscription — the argument is already made on card 605f002d). It is a ONE-SHOT, hand-run
// investigation exactly like its sibling c6ce2804 probe — deliberately NOT placed under packages/daemon/test/
// and NOT wired into scripts/test-daemon.mjs. Run manually, under the shared real-codex lock, only when
// explicitly granted a window (this card's own kickoff: "You hold the real-codex-spawn window").
//
// Run: 1) build (turbo builds shared first), 2) node docs/investigations/9a83ee8f-codex-first-turn-rollout-write/scripts/probe.mjs
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
// several directories away from the real mistake). Mirrors c6ce2804's own probe.mjs exactly.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TEST_DIR = path.join(REPO_ROOT, "packages/daemon/test");
const DIST_DIR = path.join(REPO_ROOT, "packages/daemon/dist");
const DIST_PTY_DIR = path.join(DIST_DIR, "pty");
for (const p of [TEST_DIR, DIST_DIR, DIST_PTY_DIR]) {
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

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. -----------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  9a83ee8f codex-first-turn-rollout-write probe — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}).`);
  process.exit(0);
}

// --- newestRolloutUnder: the instrument this whole probe hinges on. Self-contained recursive scan (does
// NOT reuse codex-transcript.ts's internal helpers, which are day-scoped and not exported for this generic
// "newest across the whole tree" shape) — depth-bounded so a pathological symlink loop cannot hang it. -----
function newestRolloutUnder(root, sinceMs = 0, maxDepth = 6) {
  let best = null; // { file, mtimeMs }
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      let mtimeMs;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
      if (mtimeMs < sinceMs) continue;
      if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
    }
  }
  walk(root, 0);
  return best;
}

// --- Positive + negative control on newestRolloutUnder itself, BEFORE trusting it against the real host
// tree. A synthetic sessions/YYYY/MM/DD tree with two files of deliberately different, explicit mtimes. ---
{
  const synth = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rollout-scan-selftest-"));
  const dirOld = path.join(synth, "2024", "01", "01");
  const dirNew = path.join(synth, "2024", "06", "15");
  fs.mkdirSync(dirOld, { recursive: true });
  fs.mkdirSync(dirNew, { recursive: true });
  const fileOld = path.join(dirOld, "rollout-2024-01-01T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
  const fileNew = path.join(dirNew, "rollout-2024-06-15T00-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl");
  fs.writeFileSync(fileOld, "{}\n");
  fs.writeFileSync(fileNew, "{}\n");
  const tOld = new Date("2024-01-01T00:00:00Z");
  const tNew = new Date("2024-06-15T00:00:00Z");
  fs.utimesSync(fileOld, tOld, tOld);
  fs.utimesSync(fileNew, tNew, tNew);

  const unscopedResult = newestRolloutUnder(synth);
  check("SELF-TEST (positive control): unscoped scan of a synthetic 2-file tree finds a file at all", unscopedResult !== null);
  check("SELF-TEST: unscoped scan picks the NEWER of two known files by mtime", unscopedResult?.file === fileNew);

  const scopedResult = newestRolloutUnder(synth, tNew.getTime() - 1000);
  check("SELF-TEST: mtime-filtered scan (sinceMs just before the newer file) still finds the newer file", scopedResult?.file === fileNew);

  const scopedPastBoth = newestRolloutUnder(synth, tNew.getTime() + 1000);
  check("SELF-TEST (negative control): mtime-filtered scan (sinceMs after BOTH files) correctly finds nothing — proves a null result here is a real absence, not a broken scan", scopedPastBoth === null);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rollout-scan-selftest-empty-"));
  check("SELF-TEST (negative control): scan of a genuinely empty tree returns null", newestRolloutUnder(emptyDir) === null);

  fs.rmSync(synth, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
}
if (failures > 0) {
  console.log(`\n❌ ${failures} SELF-TEST FAILURE(S) in the scan instrument itself — refusing to spend the real codex turn against an unverified instrument.`);
  await finishAndExit(1);
}
console.log("[info] scan-instrument self-test: all PASS. Proceeding to the real spawn.\n");

const { realCodexHome } = await importFrom(DIST_PTY_DIR, "codex-doctrine.js");
const SESSIONS_ROOT = path.join(realCodexHome(), "sessions");

const TMP = mkdtempManaged("loom-codex-first-turn-probe-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await importFrom(DIST_PTY_DIR, "host.js");

const SESSION_ID = "codex-first-turn-probe";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-first-turn-cwd-"));

// --- md5-before (real ~/.codex/config.toml) — same discipline as every sibling real-spawn file. ----------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

// --- Snapshot 1: BEFORE the spawn at all. ------------------------------------------------------------------
const spawnStartTime = Date.now();
const snapPreSpawn = newestRolloutUnder(SESSIONS_ROOT);
console.log(`[snapshot] pre-spawn newest rollout (unscoped, whole tree): ${snapPreSpawn ? `${snapPreSpawn.file} (mtime ${new Date(snapPreSpawn.mtimeMs).toISOString()})` : "NONE FOUND"}`);

const releaseCodexLock = await acquireCodexRealSpawnLock();

const exitedSessions = new Map();
const unconfirmedEvents = [];
let capturedEngineId = null;
const events = {
  onEngineSessionId(_sid, engineId) { capturedEngineId = engineId; },
  onContextStats() {}, onRateLimited() {},
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

// --- Boot + trust-dialog + ready + idle — same wait as codex-submit-confirmation-real-spawn.mjs (waits on
// isCodexBootReady AND !isBusy, since that file's own real-bug finding is that the two are independent and
// a plain ready-marker wait can resolve while codex's own MCP-startup episode still holds busy=true). ------
try {
  await waitUntil(() => host.isCodexBootReady(SESSION_ID) && !host.isBusy(SESSION_ID), {
    label: `${SESSION_ID} real codex reaches full boot readiness AND settles idle`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never reached an idle, boot-ready state within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- Snapshot 2: AFTER boot ready+idle, BEFORE the one turn is submitted. Checks the established finding
// directly (boot alone should write nothing) rather than assuming it holds in this run too. ----------------
const snapPostBootPreTurn = newestRolloutUnder(SESSIONS_ROOT, spawnStartTime);
console.log(`[snapshot] post-boot, pre-turn newest rollout SINCE spawn start: ${snapPostBootPreTurn ? `${snapPostBootPreTurn.file} (mtime ${new Date(snapPostBootPreTurn.mtimeMs).toISOString()})` : "NONE — consistent with c6ce2804's established finding that boot alone writes nothing"}`);

// --- THE ONE REAL TURN this card's manager authorized — trivial, per the probe convention shared by every
// sibling real-spawn file (never re-typed by a retry — only a bare Enter would ever be re-sent). -----------
const PROMPT = "Reply with exactly the single word: pong. Do not run any commands.";
const turnSubmittedAt = Date.now();
const enq = host.enqueueStdin(SESSION_ID, PROMPT, "system", undefined, undefined, "agent");
check("enqueueStdin delivered the one real turn immediately (session was idle post-boot)", enq.delivered === true);

// --- Wait for the real submit ladder to reach a terminal state (confirmed-idle or exhausted-and-reported) —
// same as codex-submit-confirmation-real-spawn.mjs; this probe's own claim is orthogonal to which side of
// that ladder occurs, so both are accepted as "the one turn happened". -------------------------------------
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
  console.log(`FAIL  the real submit ladder never reached ANY terminal state within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}
console.log(`[info] real submit ladder outcome: ${outcome ?? "NEITHER (see FAIL above)"}`);

// --- Give the rollout file (and this project's own captureCodexEngineSessionId retry loop, which polls
// every CODEX_ENGINE_ID_RETRY_MS=3000ms) a bounded settle window to catch up with whatever codex's own CLI
// process does on disk after printing its reply — poll for EITHER the file appearing or the id being
// captured, whichever comes first, rather than a blind fixed sleep. -----------------------------------------
let snapPostTurn = null;
try {
  await waitUntil(
    () => {
      snapPostTurn = newestRolloutUnder(SESSIONS_ROOT, spawnStartTime);
      return snapPostTurn !== null || capturedEngineId !== null;
    },
    { label: "a rollout file appears since spawn start, OR captureCodexEngineSessionId fires, after the one real turn", timeoutMs: 20000 },
  );
} catch (err) {
  console.log(`[info] neither a new rollout file nor a captured engine id appeared within the 20s post-turn settle window: ${err.message}`);
}
snapPostTurn = newestRolloutUnder(SESSIONS_ROOT, spawnStartTime); // final, authoritative read regardless of which branch above resolved it

console.log(`\n=== THE MEASUREMENT ===`);
console.log(`spawnStartTime:    ${new Date(spawnStartTime).toISOString()}`);
console.log(`turnSubmittedAt:   ${new Date(turnSubmittedAt).toISOString()}`);
console.log(`snapPreSpawn (unscoped, whole tree): ${snapPreSpawn ? `${snapPreSpawn.file} @ ${new Date(snapPreSpawn.mtimeMs).toISOString()}` : "NONE FOUND"}`);
console.log(`snapPostBootPreTurn (>=spawnStart):  ${snapPostBootPreTurn ? `${snapPostBootPreTurn.file} @ ${new Date(snapPostBootPreTurn.mtimeMs).toISOString()}` : "NONE"}`);
console.log(`snapPostTurn (>=spawnStart):         ${snapPostTurn ? `${snapPostTurn.file} @ ${new Date(snapPostTurn.mtimeMs).toISOString()}` : "NONE"}`);
console.log(`captureCodexEngineSessionId result:  ${capturedEngineId ?? "not captured within this run's window"}`);

check("DoD-1: boot alone (before the turn) wrote NO rollout file since spawn start", snapPostBootPreTurn === null);
check("DoD-1: a rollout file DID appear since spawn start after the one real turn", snapPostTurn !== null);
if (snapPostTurn) {
  check("the new rollout file's mtime is AT OR AFTER the turn was submitted (not some earlier boot artifact)", snapPostTurn.mtimeMs >= turnSubmittedAt);
  console.log(`[info] turn-submit -> rollout-file-mtime delay: ${snapPostTurn.mtimeMs - turnSubmittedAt}ms`);
}
if (capturedEngineId && snapPostTurn) {
  check("this project's OWN captureCodexEngineSessionId id matches the new rollout filename (cross-check, two independent read paths)", snapPostTurn.file.includes(capturedEngineId));
}

// --- stop() — the real codex exit sequence, observed via THIS PROJECT'S OWN events.onExit callback. -------
const stopStartedAt = Date.now();
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(SESSION_ID);
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (code=${exit.code}, intended=${exit.intended})`);
  check("the real codex process exited cleanly (code 0)", exit.code === 0);
} catch (err) {
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (never observed onExit within budget)`);
  console.log(`FAIL  real codex never reported onExit within budget after graceful stop: ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort cleanup */ }
}
unsubscribe();

releaseCodexLock();

// --- md5-diff-disclose: same discipline as every sibling real-spawn file. ----------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("this project's own removeAddedTrustBlocks already stripped this probe's own scratch-cwd trust block (no manual cleanup needed)", !stillPresent);
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

console.log(failures === 0
  ? "\n✅ ALL PASS — see sibling findings.md for the recorded measurement and its stated strength (n=1, one host, one codex build)."
  : `\n❌ ${failures} FAILURE(S) — see console output above for which check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
