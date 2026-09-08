// Card 887e10b8 Item 1 (multi-harness epic df1f94b0 Phase 1) DoD-2's own hard requirement: "confirm a
// real codex spawn actually RECEIVES [the doctrine injection] — shipping the injection is not the same as
// the agent reading it." codex-doctrine-injection.mjs proves `injectCodexDoctrine` writes the right bytes;
// codex-doctrine-spawn-wiring.mjs proves the REAL spawnCodexProcess call site actually calls it. Neither
// can prove the one thing that actually matters: that a real codex MODEL reads AGENTS.md and can quote its
// content back. This file is that proof — the only one of the three that spends a real model turn.
//
// TECHNIQUE: `injectCodexDoctrine` is called DIRECTLY on the scratch cwd (not via `role: "worker"` on the
// spawn itself) — deliberately decoupling "does a real codex process read AGENTS.md" (this file's own
// reason to exist) from "does spawnCodexProcess's role gate wire the call correctly" (already proven at
// the fake-pty layer in codex-doctrine-spawn-wiring.mjs). This lets the spawn itself use `role: undefined`
// + a real gateway — the SAME proven-reliable recipe `codex-transcript-real-spawn.mjs` already uses to
// spend exactly one real model turn without tripping the MCP-connect-failure busy-stuck hazard a
// `role: "worker"` mount set risks (see that file's own header, and card `6bf0ee32`, for why). A disclosed,
// deliberate scope narrowing — not a claim that the full worker-role path is exercised end to end here.
//
// The kickoff asks codex to read its own AGENTS.md and reply with EXACTLY the LOOM-DOCTRINE-ID value
// embedded in it — a short, content-derived, unguessable-by-chance token (see codex-doctrine.ts's own
// `codexDoctrineBlock`) that a model could only produce by actually opening and reading the file, not by
// pattern-matching plausible doctrine prose. This is the "prove reception, not delivery" standard this
// project's own doctrine names explicitly.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available, same posture as this project's other real-spawn tests.
//
// Coordination: acquires the SAME cross-process lock (`_codex-real-spawn-lock.mjs`) every other
// real-codex-spawn test file uses, so this file can never run concurrently with them.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-real-spawn.mjs
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
  // Card 5978735a: MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's own WARN_LINE_RE) —
  // a bare `SKIP  ` line is discarded entirely once this file reports a pass, leaving zero trace on CI
  // (ubuntu-latest, no codex CLI) that this file's real coverage never ran.
  console.log(`WARN  SKIP  codex-doctrine-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-doctrine-real-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv({ port: true });

const releaseCodexLock = await acquireCodexRealSpawnLock();

// IMPORTANT ORDERING (mirrors codex-transcript-real-spawn.mjs's own note): only Db/buildServer/
// TaskMcpRouter here — NOT pty/host.js or pty/codex-doctrine.js yet, since paths.js's PORT constant is
// read once at module load and buildMcpServers needs it to already reflect the FINAL bound port.
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const SESSION_ID = "codex-doctrine-real-spawn";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-doctrine-real-cwd-"));

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: scratchCwd, vaultPath: scratchCwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: scratchCwd,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null, harness: "codex",
});

// --- Real gateway, ONE real MCP endpoint (loom-tasks) — same construction as codex-transcript-real-spawn.mjs.
const stub = {};
const app = await buildServer({
  db, pty: { markMcpSeen: () => {}, recordToolCallArgsHash: () => {} }, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
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
const { readTranscript } = await import("../dist/sessions/transcript.js");
const { injectCodexDoctrine } = await import("../dist/pty/codex-doctrine.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs();

// --- Deliver AGENTS.md directly (see this file's own header for why the spawn itself uses role:undefined
// rather than exercising the role gate here). Read back the embedded ID we expect codex to quote. --------
injectCodexDoctrine(scratchCwd, "worker");
const agentsContent = fs.readFileSync(path.join(scratchCwd, "AGENTS.md"), "utf8");
const expectedId = agentsContent.match(/LOOM-DOCTRINE-ID: ([0-9a-f]{8})/)?.[1] ?? null;
check("AGENTS.md was actually written to the scratch cwd before spawn, carrying a real 8-char ID", typeof expectedId === "string" && expectedId.length === 8);

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
    db.setEngineSessionId(sessionId, engineId);
  },
  onContextStats() {}, onRateLimited() {}, onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const exitedSessions = new Map();
const host = new PtyHost(events);

const KICKOFF = expectedId
  ? `Read the file AGENTS.md in your current working directory and reply with EXACTLY the 8-character value that appears after "LOOM-DOCTRINE-ID:" on its second line. Output only that value, nothing else — no punctuation, no explanation.`
  : "Reply with exactly the single word: pong."; // degrades gracefully if the doctrine write above somehow failed

// role:undefined + manual enqueue once busy genuinely settles — mirrors codex-transcript-real-spawn.mjs's
// own disclosed finding (a kickoff written right at the earliest ready-looking render can race an
// MCP-startup busy episode and end up unsent).
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: undefined, harness: "codex",
});
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
try {
  let stableCount = 0;
  await waitUntil(
    () => { stableCount = host.isBusy(SESSION_ID) ? 0 : stableCount + 1; return stableCount >= 3; },
    { label: `${SESSION_ID} busy settles false and STAYS false (past any MCP-startup episode)`, timeoutMs: 60000, intervalMs: 1000 },
  );
} catch (err) {
  console.log(`[warn] ${err.message} — proceeding to submit anyway; the transcript-completion wait below will fail loudly if this was a real problem, not silently pass.`);
}
console.log(`[info] enqueueing the real kickoff turn now (isBusy=${host.isBusy(SESSION_ID)})`);
host.enqueueStdin(SESSION_ID, KICKOFF, "system", undefined, undefined, "agent");

// --- Recovery nudge — same disclosed, test-only workaround codex-transcript-real-spawn.mjs uses for the
// same race, never a production code change. -------------------------------------------------------------
for (let nudge = 0; nudge < 3; nudge++) {
  let composerCleared = false;
  try {
    await waitUntil(
      () => {
        if (engineSessionIdEvents.length > 0) return true;
        composerCleared = !rawBuf.slice(-2000).includes(KICKOFF.slice(0, 40));
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
    label: `${SESSION_ID} real codex engine-session id discovered`,
    timeoutMs: 30000,
  });
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
  failures++;
}
const capturedEngineId = engineSessionIdEvents[0]?.engineId ?? null;

let turnsAtSettle = [];
let replyText = "";
if (capturedEngineId) {
  try {
    await waitUntil(
      // Card 1027b523: `t.find(non-empty assistant)` used to be satisfied by a reasoning-capable model's
      // OWN intent preamble ("I'll read AGENTS.md...") — that means "any assistant message exists", not
      // "the FINAL ANSWER has arrived", and a preamble is a real assistant message that legitimately
      // precedes the model actually invoking the read tool. Fixed by requiring the matched turn to
      // CONTAIN the expected id itself — a preamble structurally cannot satisfy this, so a genuine failure
      // now times out honestly instead of succeeding early on the wrong turn. `expectedId ? ... : true`
      // preserves the OLD "any non-empty text" signal only for the degraded fallback (AGENTS.md write
      // somehow failed, no id to check against) — see codex-doctrine-completion-predicate.mjs for the
      // hermetic RED/GREEN proof, built from the two real preamble strings this bug actually produced.
      () => {
        const t = readTranscript(scratchCwd, capturedEngineId, "codex");
        turnsAtSettle = t;
        const reply = t.find((turn) => {
          if (turn.role !== "assistant" || !turn.text.trim()) return false;
          return expectedId ? turn.text.includes(expectedId) : true;
        });
        replyText = reply?.text ?? "";
        return !!reply;
      },
      // 150s, not the sibling file's 90s: this file's own real-run development observed a genuine
      // overshoot (91.9s) on a host whose real ~/.codex carries several bundled plugin skills that inflate
      // the system prompt (visible in the transcript dump) — the turn DID complete correctly (the reply
      // landed, twice, by the time the 90s wait gave up), so this is a wait-window tuning fix, not a hang.
      // Card 1027b523: this window is UNCHANGED — the defect was never the timeout length (a previous
      // author already looked at this exact wait and correctly ruled that out); it was the predicate
      // returning early on the wrong condition, fixed above.
      { label: `${SESSION_ID} real codex turn produces an assistant message CONTAINING the expected LOOM-DOCTRINE-ID (not merely any non-empty assistant message — an intent preamble must not satisfy this)`, timeoutMs: 150000, intervalMs: 500 },
    );
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    console.log(`--- turns observed at timeout ---\n${JSON.stringify(turnsAtSettle, null, 2)}`);
    console.log(`--- raw captured pty output tail (diagnostic) ---\n${rawBuf.slice(-4000)}`);
    failures++;
  }
}
unsubscribeRaw();

console.log(`[info] real assistant reply text: ${JSON.stringify(replyText)}`);
console.log(`[info] expected LOOM-DOCTRINE-ID: ${expectedId}`);

// --- THE POINT OF THIS FILE: the model's own reply must contain the EXACT id it could only have gotten by
// actually opening and reading AGENTS.md — a plausible-sounding hallucinated doctrine summary would not
// happen to contain this specific 8-hex-char token. ---------------------------------------------------
check("the real codex reply contains the EXACT LOOM-DOCTRINE-ID from AGENTS.md — proves RECEPTION, not merely delivery",
  !!expectedId && replyText.includes(expectedId));
// Negative-control-shaped sanity: the id is genuinely present in the file (already checked above) AND
// genuinely absent from the KICKOFF prompt text itself, so a match in replyText cannot be the model just
// echoing back something WE typed — it can only have come from actually reading the file.
check("(instrument sanity) the expected id does NOT appear in the kickoff prompt itself — a match in the reply cannot be an echo of our own prompt text",
  !!expectedId && !KICKOFF.includes(expectedId));

// Teardown uses a HARD stop, deliberately — this test's own reason to exist is the reception proof above,
// not graceful-stop-after-a-tool-using-turn correctness (a DIFFERENT, un-investigated concern: two runs
// during this file's own development both observed a real, reproducible non-zero exit from `stopCodex`'s
// graceful double-Ctrl+C sequence specifically after a turn that used a tool (reading AGENTS.md), while
// the SAME graceful sequence exits 0 cleanly for a plain text-only "pong" turn — see
// `codex-transcript-real-spawn.mjs`, re-run back-to-back on this same host as a control and confirmed
// clean. Disclosed to the dispatching lead rather than silently asserted around; not investigated further
// here since it is orthogonal to card 887e10b8's own scope (doctrine injection, not stop-sequence
// reliability) and graceful-stop-after-plain-text is already covered elsewhere.
host.stop(SESSION_ID, "hard");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process exits after a hard stop`, timeoutMs: 8000 });
  check("the real codex process exited (any code — this test does not assert graceful-stop's exit code; see the comment above)", exitedSessions.has(SESSION_ID));
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failures++;
}

await app.close();
db.close();
releaseCodexLock();

// --- md5-diff-disclose --------------------------------------------------------------------------------
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
  ? "\n✅ ALL PASS — a REAL codex process was given a REAL, Loom-injected AGENTS.md and, asked to quote its embedded LOOM-DOCTRINE-ID, replied with the exact value — proving RECEPTION (the model actually reads AGENTS.md), not merely that Loom delivered the file."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
