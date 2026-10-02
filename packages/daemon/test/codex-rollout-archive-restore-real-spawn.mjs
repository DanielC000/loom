// Card 7306e109 item 1 — the ONE thing codex-rollout-archive.mjs (fixture-based unit coverage) and
// codex-resume-archive-restore-chokepoint.mjs (fixture-CLI wiring proof) cannot prove: that a REAL
// `codex resume <uuid>` subprocess, launched through THIS PROJECT'S OWN `PtyHost.createCodexPty`
// (`pty/host.ts`), actually SUCCEEDS once `restoreArchivedCodexRollout` (card 5172fe3a,
// `pty/codex-rollout-archive.ts`) has moved its rollout file back to the live tree. Before 5172fe3a, a
// real spawn against a relocated-but-intact rollout failed HARD: `thread/resume failed: no rollout found
// for thread id <uuid> (code -32600)` — that failure is already real-spawn-proven (see this file's own
// card body); nobody had yet watched the FIX succeed against a real process. This file is that proof.
//
// SAFETY (kickoff's own constraint — read before touching this file): drives a REAL `codex` CLI against
// the REAL, SHARED `~/.codex` (codex-doctrine.ts's own doc: no per-worker CODEX_HOME override is safe —
// it breaks auth). This file NEVER calls the production `archiveOldCodexRollouts()` sweep against that
// real tree (that sweeps the WHOLE live sessions/ corpus by age — running it here could archive a
// COMPLETELY UNRELATED real conversation older than 3 days). Instead it moves — by hand, with the exact
// same rename-then-EXDEV-fallback shape `moveFile` uses — ONLY the one rollout file this file's own spawn
// created, into a disposable per-test LOOM_HOME-scoped archive root (`codexRolloutArchiveRoot()` resolves
// against LOOM_HOME, which is this file's own scratch TMP — never the real ~/.loom). The `finally` block
// at the end is a belt-and-suspenders manual restore: if anything above it throws before the production
// restore path is confirmed to have moved the file back, the file is moved back by hand so a crash in
// THIS SCRIPT can never leave the real ~/.codex in an archived-and-stranded state.
//
// ONE real codex "session": a single conversation is created, given one minimal turn, stopped, archived
// (by hand, as above), then RESUMED (same conversation id, same Loom sessionId, same cwd) through the
// real `createCodexPty` resume path — never two independent conversations.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available, same posture as this project's other real-spawn tests.
//
// Coordination: acquires the SAME cross-process lock (`_codex-real-spawn-lock.mjs`) the other
// real-codex-spawn test files use (this file's own basename is in `CODEX_REAL_SPAWN_BASENAMES` there —
// kept, deliberately, even though the opt-in gate below means it never actually touches that lock in an
// ordinary gate run; `codex-real-spawn-lock-membership-guard.mjs` requires EVERY importer of
// `acquireCodexRealSpawnLock` to be registered there, and removing the entry would also break the
// `--codex-real-spawn` CLI preset, which refuses if a `CODEX_REAL_SPAWN_BASENAMES` member isn't in the
// discovered hermetic set — see `resolveSelectionForCliMode`'s own doc in `scripts/test-daemon.mjs`), so
// it can never run concurrently with them on the rare occasion someone opts it in.
//
// ⛔ OPT-IN ONLY (manager-requested 2026-10-02, after review): this file's job was a ONE-TIME proof, now
// recorded in `docs/decisions/5172fe3a-codex-rollout-archiver-cannot-race-a-restore.md`'s "Real-spawn
// confirmation" section — NOT a standing regression guard (that job belongs to the hermetic
// `codex-resume-archive-restore-chokepoint.mjs`, which runs on every gate for free). Left to run freely,
// this spends a real codex conversation (up to a 300s budget) on EVERY gate wherever codex is installed
// (e.g. the owner's own host), inside a suite already near its 60-minute ceiling, and joins the
// real-spawn family's own measured ~31% per-gate flake rate (card 427590d2) for zero NEW signal beyond
// what it already proved once. So: skipped by default (exit 0), and only actually runs with an explicit
// opt-in. No existing real-spawn test in this corpus had its own opt-in-env convention to reuse (checked:
// every sibling instead either self-skips only on a missing/unauthenticated codex/claude CLI, or is kept
// out of discovery entirely via `NOT_HERMETIC` with no runtime gate of its own) — this is the first, and
// the name below is a reasonable one to reuse if a future proof-once real-spawn file wants the same shape.
//
// Run (deliberately, e.g. after a codex CLI upgrade — never as part of an ordinary gate):
//   LOOM_RUN_CODEX_RESTORE_REAL_SPAWN=1 node packages/daemon/test/codex-rollout-archive-restore-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";
import { hermeticPort, listenHermetic } from "./_hermetic-port.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

if (process.env.LOOM_RUN_CODEX_RESTORE_REAL_SPAWN !== "1") {
  console.log("WARN  SKIP  codex-rollout-archive-restore-real-spawn.mjs — opt-in only (one-time real-spawn proof, already recorded in docs/decisions/5172fe3a-codex-rollout-archiver-cannot-race-a-restore.md); set LOOM_RUN_CODEX_RESTORE_REAL_SPAWN=1 to run it deliberately.");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diag) console.log(`      ${diag}`); }
};

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. ------------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`WARN  SKIP  codex-rollout-archive-restore-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-rollout-restore-real-");
// Deliberately NEVER set CODEX_HOME — codex-doctrine.ts's own doc: a per-worker CODEX_HOME override is
// empirically broken (auth lives under the real one). LOOM_HOME alone scopes codexRolloutArchiveRoot()
// to this file's own scratch tree; the LIVE sessions/ root stays the real ~/.codex, as it must for a
// resume of a real conversation to find anything at all.
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv({ port: true });

const releaseCodexLock = await acquireCodexRealSpawnLock();

// Same import-ordering discipline as codex-transcript-real-spawn.mjs: PtyHost/transcript modules import
// paths.js, whose PORT export is a module-load-time constant — import them only after the real port is
// actually bound below.
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const SESSION_ID = "codex-rollout-restore-real-spawn";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-rollout-restore-real-cwd-"));

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: scratchCwd, vaultPath: scratchCwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: scratchCwd,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null, harness: "codex",
});

const stub = {};
const app = await buildServer({
  db, pty: { markMcpSeen: () => {}, recordToolCallArgsHash: () => {} }, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await listenHermetic(app);

const { PtyHost } = await import("../dist/pty/host.js");
const { readTranscript } = await import("../dist/sessions/transcript.js");
const { realCodexHome } = await import("../dist/pty/codex-doctrine.js");
const { codexRolloutArchiveRoot } = await import("../dist/pty/codex-rollout-archive.js");
const { resolveTranscriptFile: resolveCodexRolloutFile } = await import("../dist/pty/codex-transcript.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs();

// --- md5-before (real ~/.codex/config.toml) — same discipline as the sibling real-spawn files -----------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const engineSessionIdEvents = [];
const exitedSessions = new Map();
const events = {
  onEngineSessionId(sessionId, engineId, previousEngineId) {
    engineSessionIdEvents.push({ sessionId, engineId, previousEngineId });
    db.setEngineSessionId(sessionId, engineId);
  },
  onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended, codexStopDiag: info.codexStopDiag }); },
};
const host = new PtyHost(events);

// Card 22d995ca-style declared accommodation (mirrors codex-transcript-real-spawn.mjs's own
// reportGracefulStopExitCode): the real stopCodex graceful-stop flake (card 176bdb0c, measured 2/13
// trials) is a KNOWN, UNFIXED, DISCLOSED defect — never this file's concern to fix or hide.
function reportGracefulStopExitCode(label, code, codexStopDiag) {
  if (code === 0) {
    check(`${label}: the real codex process exited with code 0 after a graceful stop`, true);
  } else {
    console.log(`WARN  ⚠️  ACCOMMODATION (card 176bdb0c): ${label} exited with code ${code} (not 0) after an INTENDED graceful stop — the KNOWN, LIVE, UNFIXED flake measured at 2/13 ≈ 15.4%. Not failing the gate on this observation. codexStopDiag: ${JSON.stringify(codexStopDiag)}`);
  }
}

// ═══ PHASE 1: create a real conversation, one tiny turn ═══════════════════════════════════════════════
const KICKOFF = "Reply with exactly the single word: pong.";
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: undefined, harness: "codex",
});
let rawBuf = "";
let unsubscribeRaw = host.subscribe(SESSION_ID, { onData: (chunk) => { rawBuf += chunk.toString("utf-8"); }, onControl: () => {} });

try {
  await waitUntil(() => rawBuf.includes("Ask Codex to do anything"), {
    label: `${SESSION_ID} real codex TUI renders its ready placeholder at least once (initial boot)`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
  failures++;
}
try {
  let stableCount = 0;
  await waitUntil(
    () => { stableCount = host.isBusy(SESSION_ID) ? 0 : stableCount + 1; return stableCount >= 3; },
    { label: `${SESSION_ID} busy settles false and STAYS false (past any MCP-startup episode)`, timeoutMs: 60000, intervalMs: 1000 },
  );
} catch (err) {
  console.log(`[warn] ${err.message} — proceeding to submit anyway; the completion wait below fails loudly if this was a real problem.`);
}
console.log(`[info] enqueueing the real kickoff turn now (isBusy=${host.isBusy(SESSION_ID)})`);
host.enqueueStdin(SESSION_ID, KICKOFF, "system", undefined, undefined, "agent");

// Known real-host hazard (disclosed, see codex-transcript-real-spawn.mjs's own header): extra
// plugin/marketplace MCP servers in this host's ~/.codex/config.toml can race submitCodex's own Enter
// keystroke and leave the kickoff typed-but-unsent. Same bounded raw-keystroke recovery nudge.
for (let nudge = 0; nudge < 3; nudge++) {
  let composerCleared = false;
  try {
    await waitUntil(
      () => {
        if (engineSessionIdEvents.length > 0) return true;
        composerCleared = !rawBuf.slice(-2000).includes(KICKOFF);
        return composerCleared;
      },
      { label: `${SESSION_ID} kickoff accepted (engine-id captured or composer text cleared) — attempt ${nudge + 1}/3`, timeoutMs: 10000, intervalMs: 500 },
    );
    break;
  } catch {
    console.log(`[info] no progress after ${nudge + 1} attempt(s) — sending one recovery "\\r" via the raw writeStdin passthrough`);
    host.writeStdin(SESSION_ID, "\r");
  }
}

try {
  await waitUntil(() => engineSessionIdEvents.length > 0, {
    label: `${SESSION_ID} real codex engine-session id discovered (pty/host.ts#captureCodexEngineSessionId against a REAL rollout file)`,
    timeoutMs: 30000,
  });
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
  failures++;
}
const capturedEngineId = engineSessionIdEvents[0]?.engineId ?? null;
check("exactly one onEngineSessionId event fired, with a non-empty real conversation id", engineSessionIdEvents.length === 1 && typeof capturedEngineId === "string" && capturedEngineId.length > 0);

let turnsAtSettle = [];
if (capturedEngineId) {
  try {
    await waitUntil(
      () => {
        const t = readTranscript(scratchCwd, capturedEngineId, "codex");
        turnsAtSettle = t;
        return t.some((turn) => turn.role === "assistant" && /pong/i.test(turn.text));
      },
      { label: `${SESSION_ID} real codex turn produces an assistant message CONTAINING the requested reply "pong"`, timeoutMs: 90000, intervalMs: 500 },
    );
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    console.log(`--- turns observed at timeout ---\n${JSON.stringify(turnsAtSettle, null, 2)}`);
    console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
    failures++;
  }
}
check("the real turn landed in the transcript (sanity before stopping and archiving)",
  turnsAtSettle.some((t) => t.role === "assistant" && t.text.trim().length > 0));
unsubscribeRaw();

if (!capturedEngineId) {
  console.log("\n❌ Could not capture a real engine-session id — cannot proceed to the archive/resume phase. See failures above.");
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
  await app.close();
  db.close();
  releaseCodexLock();
  await finishAndExit(1);
}

console.log(`[info] stopping the initial conversation (engine id ${capturedEngineId}) before archiving its rollout`);
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop (initial)`, timeoutMs: 8000 });
  reportGracefulStopExitCode("initial stop", exitedSessions.get(SESSION_ID)?.code, exitedSessions.get(SESSION_ID)?.codexStopDiag);
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
}
exitedSessions.delete(SESSION_ID); // so phase 2's own onExit check below cannot read this stale entry

// ═══ PHASE 2: archive the ONE rollout this spawn created (by hand — see this file's own header for why
// the production sweep is never called against the real tree), then resume it through the REAL
// PtyHost.spawn({resumeId}) → createCodexPty path. ═══════════════════════════════════════════════════
const liveFile = resolveCodexRolloutFile(scratchCwd, capturedEngineId);
check("RED CONTROL: before archiving, the real rollout file is found at its LIVE path", typeof liveFile === "string" && fs.existsSync(liveFile), `liveFile=${liveFile}`);

const sessionsRootReal = path.join(realCodexHome(), "sessions");
const rel = liveFile ? path.relative(sessionsRootReal, liveFile) : null;
check("the resolved live file genuinely sits under the real ~/.codex/sessions tree (never climbs out via ..)",
  typeof rel === "string" && !rel.startsWith("..") && !path.isAbsolute(rel), `rel=${rel}`);

const archiveDest = rel ? path.join(codexRolloutArchiveRoot(), rel) : null;
let archivedManually = false;

function moveFileByHand(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

try {
  if (liveFile && archiveDest) {
    moveFileByHand(liveFile, archiveDest);
    archivedManually = true;
  }
  check("the rollout now sits ONLY in the scratch archive root, not at its live path",
    !!archiveDest && fs.existsSync(archiveDest) && !fs.existsSync(liveFile), `archiveDest=${archiveDest} liveFile=${liveFile}`);

  // --- Resume through the REAL PtyHost path. restoreArchivedCodexRollout runs SYNCHRONOUSLY inside
  // createCodexPty, strictly before the real `codex resume <uuid>` child process is spawned (@decision
  // 5172fe3a, pty/host.ts) — so by the time this synchronous call returns, the restore has already
  // happened. Same Loom sessionId, same cwd — a genuine resume, not a fresh second conversation. -------
  console.log(`[info] resuming engine id ${capturedEngineId} through the real PtyHost.spawn({resumeId}) → createCodexPty path`);
  host.spawn({
    sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: undefined, harness: "codex", resumeId: capturedEngineId,
  });

  check("restoreArchivedCodexRollout moved the rollout back to its EXACT original live path BEFORE the resume subprocess observably ran (synchronous, inside the host.spawn() call above)",
    !!liveFile && fs.existsSync(liveFile));
  check("the scratch archive copy is gone (moved, not copied-and-left)",
    !!archiveDest && !fs.existsSync(archiveDest));

  let rawBuf2 = "";
  const unsubscribeRaw2 = host.subscribe(SESSION_ID, { onData: (chunk) => { rawBuf2 += chunk.toString("utf-8"); }, onControl: () => {} });
  let resumeReady = false;
  try {
    await waitUntil(
      () => {
        if (exitedSessions.has(SESSION_ID)) return true; // exited early — fail loud below, not a silent timeout
        if (rawBuf2.includes("Ask Codex to do anything")) { resumeReady = true; return true; }
        return false;
      },
      { label: `${SESSION_ID} real codex resume reaches the ready placeholder (or exits early)`, timeoutMs: 30000 },
    );
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
  }
  unsubscribeRaw2();

  check("the resumed codex process did NOT exit before reaching ready (no early crash)", !exitedSessions.has(SESSION_ID),
    exitedSessions.has(SESSION_ID) ? `exit info=${JSON.stringify(exitedSessions.get(SESSION_ID))}` : undefined);
  check("the resumed codex TUI reached its ready placeholder ('Ask Codex to do anything')", resumeReady,
    `--- raw captured pty output (resume) ---\n${rawBuf2.slice(-4000)}`);
  check("NO '-32600' (JSON-RPC error code) anywhere in the resume's captured output", !rawBuf2.includes("-32600"),
    `--- raw captured pty output (resume) ---\n${rawBuf2.slice(-4000)}`);
  check("NO 'no rollout found' text anywhere in the resume's captured output (the exact pre-fix failure string)", !/no rollout found/i.test(rawBuf2),
    `--- raw captured pty output (resume) ---\n${rawBuf2.slice(-4000)}`);

  console.log("[info] stopping the resumed conversation");
  host.stop(SESSION_ID, "graceful");
  try {
    await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop (resumed)`, timeoutMs: 8000 });
    reportGracefulStopExitCode("resumed-session stop", exitedSessions.get(SESSION_ID)?.code, exitedSessions.get(SESSION_ID)?.codexStopDiag);
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    failures++;
    try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
  }

  check("FINAL: the rollout is at its exact original live path — ~/.codex's own sessions tree is restored",
    !!liveFile && fs.existsSync(liveFile));
  check("FINAL: nothing is left in the scratch archive root for this conversation", !!archiveDest && !fs.existsSync(archiveDest));
} finally {
  // Belt-and-suspenders: if anything above threw before the production restore ran (or the archive was
  // never actually consumed), make sure the real ~/.codex ends this run with the file back at its
  // original live path regardless of pass/fail — "restore the real ~/.codex to exactly its prior state"
  // is unconditional, not contingent on the test having passed.
  if (archivedManually && archiveDest && fs.existsSync(archiveDest) && liveFile && !fs.existsSync(liveFile)) {
    console.log(`WARN  manual safety-net restore: the production restore path did not move the file back (or this script failed before confirming it) — moving ${archiveDest} back to ${liveFile} by hand so the real ~/.codex ends this run in its original state.`);
    try { moveFileByHand(archiveDest, liveFile); } catch (err) {
      console.log(`FAIL  safety-net restore itself failed: ${(err && err.message) || err} — the real ~/.codex may still have an archived rollout at ${archiveDest}. MANUAL INTERVENTION NEEDED.`);
      failures++;
    }
  }
}

await app.close();
db.close();
releaseCodexLock();

// --- md5-diff-disclose (same discipline as the sibling real-spawn files) --------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort settle wait */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("this project's own removeAddedTrustBlocks already stripped the expected [projects.'<scratchCwd>'] block", !stillPresent);
  if (stillPresent) {
    const removable = remaining.match(blockRe) ?? [];
    if (removable.length) {
      const restored = remaining.split(removable[0]).join("");
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed the block this project's own code should have already stripped: ${removable[0]}`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged (this scratch cwd was likely already trusted from a prior run, or the diff genuinely found nothing to clean).");
}
check("~/.codex/config.toml ends this run byte-identical to how it started (post-cleanup)", md5(readConfig()) === hashBefore);

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL codex conversation was created, given one real turn, stopped, had its rollout file archived (by hand, into a scratch root), and was then RESUMED through this project's own PtyHost.spawn({resumeId}) → createCodexPty path: restoreArchivedCodexRollout moved the rollout back to its exact original live path before the real `codex resume <uuid>` subprocess ran, and that resume reached ready with no '-32600'/'no rollout found' anywhere in its output — the real CLI fix (card 5172fe3a) is now watched succeeding against a real process, not just a fixture one."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
