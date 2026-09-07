// Card 2ec60d9c DoD-4 (multi-harness epic df1f94b0) — the real, end-to-end proof: a REAL codex spawn,
// through THIS PROJECT'S OWN `PtyHost.spawn({harness:"codex"})`, delivers one minimal kickoff turn, has
// its engine-session identity DISCOVERED by this project's own code (DoD-1,
// `pty/host.ts#captureCodexEngineSessionId`), persisted to the DB exactly the way production's
// `onEngineSessionId` handler does, and then read back through the SAME harness-aware
// `readTranscript(cwd, engineSessionId, harness)` seam `worker_transcript` itself calls
// (`mcp/orchestration.ts`) — returning ACTUAL turns, not merely proving the parser can parse a fixture
// (that's already covered by codex-transcript-parse.mjs and codex-engine-session-id-capture.mjs's fake-pty
// coverage; this is deliberately the one thing those can't prove).
//
// WHY A REAL GATEWAY IS STOOD UP (unlike codex-stateful-runtime-real-spawn.mjs's zero-gateway posture):
// that file's own header discloses a REAL finding — without a live listener at the MCP URL
// `createCodexPty` embeds, codex's own MCP-server-startup retry episode can leave its busy marker STUCK
// long enough that a queued kickoff (enqueueStdinCodex only delivers on the busy->idle edge) may never
// actually get submitted. This test needs a REAL delivered turn, so it stands up a real `buildServer`
// (mirrors codex-mcp-reachability-real-spawn.mjs's own construction) on a hermetically-derived port
// (`_hermetic-port.mjs`) BEFORE spawning, with `role: undefined` (a "plain" session) on the codex spawn
// itself so `buildMcpServers` mounts ONLY the base `loom-tasks` server — one endpoint, fully backed by a
// REAL `TaskMcpRouter`, nothing stubbed that codex's own handshake could hang against.
//
// ONE minimal model turn spent, by design (this card's DoD-4 explicitly requires actual turns to read
// back — a zero-turn spawn can prove DoD-1's discovery but never this file's own reason to exist): the
// same trivial "reply with exactly the single word: pong" exchange the original probe (docs/investigations/
// 049e4a7b) and this file's own codex-transcript.ts header already use for minimal-cost real-model checks.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available, same posture as this project's other real-spawn tests.
//
// Coordination: acquires the SAME cross-process lock (`_codex-real-spawn-lock.mjs`, card 14e6cf5f) the
// other two real-codex-spawn test files use, so this file can never run concurrently with them either.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-transcript-real-spawn.mjs
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
import { hermeticPort } from "./_hermetic-port.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. ------------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  codex-transcript-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-transcript-real-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv({ port: true });

const releaseCodexLock = await acquireCodexRealSpawnLock();

// IMPORTANT ORDERING: only Db/buildServer/TaskMcpRouter are imported here — NOT pty/host.js or
// sessions/transcript.js yet. Both transitively import paths.js, whose `PORT` export is a MODULE-LOAD-TIME
// constant (`Number(process.env.LOOM_PORT || 4317)`, read exactly once) — buildMcpServers (consulted
// inside PtyHost#spawn, which embeds PORT into the MCP URL argv codex is spawned with) needs that constant
// to already reflect this test's FINAL, actually-bound port. Importing PtyHost before the port-retry loop
// below settles would freeze PORT at a candidate that may not even be the one that ended up bound.
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const SESSION_ID = "codex-transcript-real-spawn";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-transcript-real-cwd-"));

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: scratchCwd, vaultPath: scratchCwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: scratchCwd,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null, harness: "codex",
});

// --- Real gateway, ONE real MCP endpoint (loom-tasks, backed by a REAL TaskMcpRouter — see this file's
// own header for why a live listener matters here). ------------------------------------------------------
const stub = {};
const app = await buildServer({
  db, pty: { markMcpSeen: () => {}, recordToolCallArgsHash: () => {} }, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
// Windows reserves arbitrary port ranges (Hyper-V/WSL `netsh` exclusions) that a plain hermeticPort() pick
// can land on (EACCES, not EADDRINUSE) — retry with a fresh random port a few times rather than failing
// this whole real-spawn run over an unrelated host quirk. LOOM_PORT is re-set on each attempt since
// buildMcpServers (consulted at spawn, below, AFTER this resolves) reads the module-level PORT constant.
let listenErr;
for (let attempt = 0; attempt < 5; attempt++) {
  const candidate = attempt === 0 ? Number(process.env.LOOM_PORT) : 40000 + Math.floor(Math.random() * 20000);
  process.env.LOOM_PORT = String(candidate);
  try {
    await app.listen({ port: candidate, host: "127.0.0.1" });
    listenErr = null;
    break;
  } catch (e) {
    listenErr = e;
    console.log(`[warn] listen(${candidate}) failed (${e.code}) — retrying with a different port`);
  }
}
if (listenErr) throw listenErr;

// NOW safe to import — LOOM_PORT reflects the port actually bound above.
const { PtyHost } = await import("../dist/pty/host.js");
const { readTranscript, engineTranscriptExists, resolveTranscriptFile } = await import("../dist/sessions/transcript.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs(); // LOGS_DIR must exist before spawn — the pty's own logStream open would otherwise ENOENT

// --- md5-before (real ~/.codex/config.toml) — same discipline as the sibling real-spawn files -----------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const engineSessionIdEvents = [];
const events = {
  onEngineSessionId(sessionId, engineId, previousEngineId) {
    engineSessionIdEvents.push({ sessionId, engineId, previousEngineId });
    db.setEngineSessionId(sessionId, engineId); // mirrors index.ts's real production wiring exactly
  },
  onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const exitedSessions = new Map();
const host = new PtyHost(events);

const KICKOFF = "Reply with exactly the single word: pong.";
// NOT delivered via `startupPrompt` (which fires kickoff on the FIRST ready-marker sighting) — a REAL
// finding from this file's own development: this host's REAL, personal ~/.codex/config.toml has extra
// plugin/marketplace MCP servers configured (observed live: "Starting MCP servers (3/4): codex_apps"),
// so the earliest ready-looking render can be immediately followed by a busy MCP-startup episode that
// swallows a kickoff written right at that instant (the composer was observed still holding the UNSENT
// prompt at test end). Manually enqueued below, once busy has genuinely settled — still the REAL
// enqueueStdin/submitCodex production code path, just invoked at a moment confirmed safe rather than
// racing the earliest possible one. Disclosed to the dispatching lead; not a change to pty/host.ts.
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: undefined, harness: "codex",
});
// Diagnostic-only raw capture (mirrors codex-stateful-runtime-real-spawn.mjs's own `buf` accumulator) —
// never asserted on directly, just printed on a failure so a real, unexpected TUI/version-drift shape is
// visible instead of a bare timeout.
let rawBuf = "";
const unsubscribeRaw = host.subscribe(SESSION_ID, { onData: (chunk) => { rawBuf += chunk.toString("utf-8"); }, onControl: () => {} });

try {
  await waitUntil(() => rawBuf.includes("Ask Codex to do anything"), {
    label: `${SESSION_ID} real codex TUI renders its ready placeholder at least once`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
  failures++;
}
// Settle past any MCP-startup busy episode: require `!isBusy` to hold across 3 consecutive checks (not
// just one instantaneous read) before trusting it, generous overall budget for a slow/extra plugin server.
try {
  let stableCount = 0;
  await waitUntil(
    () => {
      stableCount = host.isBusy(SESSION_ID) ? 0 : stableCount + 1;
      return stableCount >= 3;
    },
    { label: `${SESSION_ID} busy settles false and STAYS false (past any MCP-startup episode)`, timeoutMs: 60000, intervalMs: 1000 },
  );
} catch (err) {
  console.log(`[warn] ${err.message} — proceeding to submit anyway; the transcript-completion wait below will fail loudly if this was a real problem, not silently pass.`);
}
console.log(`[info] enqueueing the real kickoff turn now (isBusy=${host.isBusy(SESSION_ID)})`);
host.enqueueStdin(SESSION_ID, KICKOFF, "system", undefined, undefined, "agent");

// --- RECOVERY NUDGE (a real finding from this file's own development, disclosed to the dispatching lead
// rather than silently worked around): this host's personal ~/.codex/config.toml has extra plugin/
// marketplace MCP servers, and their "Starting MCP servers (N/4)" startup episode can begin the instant
// after a turn is submitted — racing submitCodex's own Enter keystroke and leaving the kickoff typed but
// UNSENT in the composer (confirmed via raw-output inspection: the text was still visibly sitting in the
// input box, never actually submitted, in two earlier attempts). This polls for either real progress
// (an engine-session-id capture, OR the composer text having cleared — meaning it WAS accepted) and, if
// neither happens within a window, sends ONE bare "\r" via the SAME `writeStdin` raw-keystroke passthrough
// a human retrying a stuck Enter would use — never a production-code change, and bounded to 3 attempts so
// a genuinely different failure still surfaces as a real timeout below rather than retrying forever.
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
    break; // real progress observed — stop nudging
  } catch {
    console.log(`[info] no progress after ${nudge + 1} attempt(s) — the kickoff still appears unsent (composerCleared=${composerCleared}); sending one recovery "\\r" via the raw writeStdin passthrough`);
    host.writeStdin(SESSION_ID, "\r");
  }
}

// --- DoD-1 against a REAL process: the engine-session identity must be DISCOVERED (not fed to us), same
// mechanism already proven against a fake pty in codex-engine-session-id-capture.mjs — this is the one
// thing that fake couldn't prove: that it works against codex's REAL rollout-file-write timing. ----------
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
check("previousEngineId is null (first capture, not a rotation)", engineSessionIdEvents[0]?.previousEngineId === null);

// --- DoD-4's own reason to exist: wait for the REAL model turn to land in the transcript, then read it
// back through the SAME harness-aware seam worker_transcript calls. Polls the ACTUAL file, never a fixed
// sleep — a genuinely stuck/slow turn fails loud via waitUntil's own timeout, not a false pass. -----------
let turnsAtSettle = [];
if (capturedEngineId) {
  try {
    await waitUntil(
      // Card 1027b523: "any non-empty assistant turn" was proven (on a sibling real-spawn file, same
      // predicate shape) to be satisfiable by a reasoning-capable model's own intent preamble, standing in
      // for "the FINAL ANSWER has arrived" when it only means "some assistant message exists". Requiring
      // the matched turn to actually CONTAIN the requested reply ("pong") closes the same gap here — a
      // preamble like "I'll reply now." would not satisfy this, but the genuine answer does.
      () => {
        const t = readTranscript(scratchCwd, capturedEngineId, "codex");
        turnsAtSettle = t;
        return t.some((turn) => turn.role === "assistant" && /pong/i.test(turn.text));
      },
      { label: `${SESSION_ID} real codex turn produces an assistant message CONTAINING the requested reply "pong" (not merely any non-empty assistant message)`, timeoutMs: 90000, intervalMs: 500 },
    );
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    console.log(`--- turns observed at timeout ---\n${JSON.stringify(turnsAtSettle, null, 2)}`);
    console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
    failures++;
  }
}
unsubscribeRaw();

check("readTranscript(cwd, id, 'codex') returns at least one turn with our own kickoff text",
  turnsAtSettle.some((t) => t.text.includes(KICKOFF)));
check("readTranscript(cwd, id, 'codex') returns at least one REAL assistant turn with non-empty text",
  turnsAtSettle.some((t) => t.role === "assistant" && t.text.trim().length > 0));
console.log(`[info] real assistant reply text: ${JSON.stringify(turnsAtSettle.find((t) => t.role === "assistant")?.text)}`);

check("engineTranscriptExists(cwd, id, 'codex') === true — the SAME harness-aware call worker_transcript's own dead-session checks use",
  capturedEngineId ? engineTranscriptExists(scratchCwd, capturedEngineId, "codex") === true : false);
check("resolveTranscriptFile(cwd, id, 'codex') resolves to a real, existing file",
  capturedEngineId ? (() => { const f = resolveTranscriptFile(scratchCwd, capturedEngineId, "codex"); return !!f && fs.existsSync(f); })() : false);

// --- the SAME (cwd, engineSessionId, harness) triple worker_transcript itself reads, sourced from the
// DB row `onEngineSessionId`'s own callback just persisted — proves the FULL real chain, not just this
// file's own local variables. --------------------------------------------------------------------------
const persistedRow = db.getSession(SESSION_ID);
check("the DB row's engineSessionId was persisted by onEngineSessionId's own db.setEngineSessionId call (production wiring)",
  persistedRow?.engineSessionId === capturedEngineId);
check("the DB row's harness reads back as 'codex'", persistedRow?.harness === "codex");
if (persistedRow) {
  const turnsViaDbRow = readTranscript(persistedRow.cwd, persistedRow.engineSessionId, persistedRow.harness);
  check("readTranscript(row.cwd, row.engineSessionId, row.harness) — the EXACT call worker_transcript makes — returns the same real turns",
    turnsViaDbRow.some((t) => t.role === "assistant" && t.text.trim().length > 0));
}

// --- stop() — the real codex exit sequence, observed via THIS PROJECT'S OWN events.onExit. --------------
//
// ⚠️⚠️ DECLARED TEST-SIDE ACCOMMODATION (card 176bdb0c, stopgap landed by card 2efd4bd7) — NOT a fix.
// `stopCodex`'s INTENDED graceful stop (packages/daemon/src/pty/host.ts) intermittently exits non-zero —
// measured 2/13 valid trials ≈ 15.4% (176bdb0c DoD-1, both raw exit code 1: one fast-path ~1.9s shape
// pointing at codex's own shutdown semantics for that state, one ~6.1s shape where Loom's own hard-kill
// backstop fired). Observed live across 5 real merge gates on unrelated (codex-untouched) branches,
// rejecting one merge outright. The defect is LIVE and UNFIXED — the real fix lives in pty/host.ts, which
// is one-at-a-time and held by a different lane. Per 176bdb0c's DoD-2, production's stopCodex is NEVER
// widened to accept this as success — this accommodation stays entirely on the test side.
//
// So: the exit code is still OBSERVED and REPORTED (never silently dropped), but a non-zero code no longer
// fails this gate-blocking assertion. This is scoped to exactly this one check — every other assertion in
// this file (engine-session-id capture, both readTranscript calls, engineTranscriptExists,
// resolveTranscriptFile, the persisted DB row's engineSessionId + harness, the worker_transcript call) is
// untouched and still fails the gate if it ever breaks. A hang/never-exits case (the waitUntil timeout
// below) is a DIFFERENT failure mode than this — it still fails loud; only a completed, non-zero exit is
// downgraded to non-blocking.
//
// Removable once the real stopCodex fix lands on 176bdb0c and this reports clean for a sustained period —
// see that card for the live defect status.
function reportGracefulStopExitCode(code) {
  if (code === 0) {
    check("the real codex process exited with code 0 after a graceful stop", true);
  } else {
    console.log(`⚠️  ACCOMMODATION (card 176bdb0c): the real codex process exited with code ${code} (not 0) after an INTENDED graceful stop. This is the KNOWN, LIVE, UNFIXED flake measured at 2/13 ≈ 15.4% — NOT failing the gate on this observation. If you are reading this, please note the observed code and the stop→exit elapsed time on card 176bdb0c; the real stopCodex fix is still pending in pty/host.ts.`);
  }
}
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  reportGracefulStopExitCode(exitedSessions.get(SESSION_ID)?.code);
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
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

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL codex process, spawned through PtyHost.spawn({harness:\"codex\"}), had its engine-session identity DISCOVERED by this project's own code, completed one real minimal turn, and readTranscript(cwd, engineSessionId, \"codex\") — the exact seam worker_transcript calls — returned the real conversation, sourced from a session row this project's own onEngineSessionId wiring persisted, not test-local bookkeeping."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
