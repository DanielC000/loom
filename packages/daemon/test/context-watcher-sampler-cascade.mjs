import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c5b234aa, Code Review rounds 2-4 — the EMERGENCY-INTERRUPT CASCADE regression, with BOTH real
// watchers running together (MidTurnContextSampler + ContextWatcher), not stubbed in isolation like
// context-watcher-emergency.mjs or mid-turn-context-sampler.mjs test separately. This is the actual
// production shape the bug occurred in: the sampler keeps a manager's ctxInputTokens/ctxUpdatedAt fresh
// WHILE it's busy, and ContextWatcher's emergency-interrupt de-dup must survive that churn — as of round
// 4, AT MOST ONE interrupt per SESSION, never once per turn or once per tick.
//
// Full round-by-round history (round 2's `lastActivity` key broken by the fire's own delivery mechanics;
// round 4 removing the re-arm key entirely) is in `docs/decisions/9f279c7b-contextwatcher-emergency-recycle-interrupt-trigger-a.md`'s
// own round-4 section — not restated here. The `emergencyInterrupt` stub below simulates the REAL
// `redirectManagerForEmergencyRecycle` side-effect sequence (not just a bare recorder), so this file
// reproduces the mechanism directly; part (b) asserts today's rule: a completed wind-down turn followed
// by a new turn still over the floor still does NOT re-fire, because this session already fired once.
//
// HERMETIC, CLAUDE-FREE: real file IO for the transcript (mirrors mid-turn-context-sampler.mjs's own
// sandboxed-HOME setup, since the sampler resolves paths via os.homedir()); a stub `pty`/`emergencyInterrupt`
// for ContextWatcher (mirrors context-watcher-emergency.mjs's own harness).
// Run: 1) build (turbo builds shared first), 2) node test/context-watcher-sampler-cascade.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ctx-cascade-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45406";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { MidTurnContextSampler } = await import("../dist/sessions/mid-turn-context-sampler.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const MODEL = "claude-opus-4-8"; // 1M window
const turnLine = (id, inputTokens) => JSON.stringify({
  type: "assistant",
  message: { id, model: MODEL, usage: { input_tokens: inputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

const dbFile = path.join(tmpHome, "cascade.db");
const db = new Db(dbFile);
const projId = "p-cascade";
const agentId = "a-cascade";
const now = new Date().toISOString();
db.insertProject({
  id: projId, name: "Cascade", repoPath: path.join(tmpHome, "repo"), vaultPath: path.join(tmpHome, "repo"),
  config: { orchestration: { emergencyRecycleAtContextRatio: 0.85, recycleAtContextRatio: 0 } }, createdAt: now, archivedAt: null,
});
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
const cwd = path.join(tmpHome, "repo");
const eng = "eng-mgr-cascade";
db.insertSession({
  id: "mgr", projectId: projId, agentId, engineSessionId: eng, title: null, cwd, processState: "live",
  resumability: "resumable", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

const alive = new Set(["mgr"]);
const pty = { isAlive: (id) => alive.has(id), enqueueStdin: () => ({ delivered: true }) };
const interrupts = [];
// Simulates the REAL production side effects of a HELD redirect (card c5b234aa, Code Review round 3):
// `interruptForRedirect` sends an Esc, then its settle timer runs `setBusy(false)` → `drainPending` →
// (the queued redirect becomes the next turn) `setBusy(true)`. `Db.setBusy` stamps `last_activity` on
// BOTH edges, and NEITHER edge ever calls `onTurnCompleted` — the Esc'd turn never emits a Stop — so this
// whole sequence leaves `turnSeq` untouched while pushing `lastActivity` past the fire's own event `ts`.
const emergencyInterrupt = (id, text) => {
  interrupts.push({ id, text });
  db.setBusy(id, false);
  db.setBusy(id, true);
  return { fired: true, delivered: false, interrupting: true };
};

const sampler = new MidTurnContextSampler({ db, intervalMs: 3_600_000 });
const watcher = new ContextWatcher({ db, pty, ratio: 0, emergencyInterrupt });

const emergencyEvents = () => db.listEvents("mgr").filter((ev) => ev.kind === "context_emergency_interrupt");
const f = engineTranscriptPath(cwd, eng);
fs.mkdirSync(path.dirname(f), { recursive: true });

try {
  // ============================ FIRE: one interrupt, with its OWN setBusy(false)/setBusy(true) dance ===
  // First reading already over the 0.85 floor (900_000 of 1M).
  fs.writeFileSync(f, turnLine("m0", 900_000) + "\n");
  await sampler.tick();
  check("setup: the sampler's own first tick measured the over-floor reading", db.getSession("mgr").ctxInputTokens === 900_000);

  watcher.tick();
  check("fire: ContextWatcher fires the emergency interrupt once", emergencyEvents().length === 1 && interrupts.length === 1);
  const mgrAfterFire = db.getSession("mgr");
  check("fire: the interrupt's own stub already ran the setBusy(false)->setBusy(true) dance (busy still true)", mgrAfterFire.busy === true);
  check("fire: turnSeq is untouched by that dance (no onTurnCompleted — the Esc'd turn never Stops)", (mgrAfterFire.turnSeq ?? 0) === 0);

  // ============================ (a) SEVERAL TICKS DURING THE WIND-DOWN TURN: NO second interrupt =======
  // The wind-down turn the fire itself produced is STILL busy (no real Stop happened) — the manager
  // keeps "working" (new transcript lines land, the sampler keeps re-stamping ctxUpdatedAt/lastActivity
  // churn from nothing), but turnSeq never advances. This is the exact round-3 regression: the round-2
  // `lastActivity` key read this as a NEW turn (lastActivity moved past the fire's own ts) and re-fired.
  for (let i = 1; i <= 4; i++) {
    fs.appendFileSync(f, turnLine(`m${i}`, 900_000 + i) + "\n");
    await sampler.tick();
    watcher.tick();
  }
  check("(a) wind-down turn, cycles 2-5: ctxUpdatedAt kept advancing (the sampler is genuinely still ticking)",
    db.getSession("mgr").ctxInputTokens === 900_004);
  check("(a) wind-down turn, cycles 2-5: STILL exactly ONE interrupt total (no self-triggered cascade)",
    emergencyEvents().length === 1 && interrupts.length === 1);

  // ============================ (b) THE WIND-DOWN TURN GENUINELY COMPLETES: STILL no second fire =======
  // A real Stop on the wind-down turn bumps turnSeq (pty/host.ts's onTurnCompleted, wired at
  // index.ts's `onTurnCompleted: (sessionId) => db.incrementTurnSeq(sessionId)`) — THIS is what the
  // Esc'd turn itself never produced. A genuinely new turn then starts, still over the floor. Round 3
  // read this as the completed-turn signal that re-arms the interrupt; round 4 has no re-arm key at all
  // — this session already fired once, so it must not fire again.
  db.incrementTurnSeq("mgr");
  db.setBusy("mgr", false); // the wind-down turn ends for real
  db.setBusy("mgr", true);  // a genuinely NEW turn starts — a fresh rising edge, AND turnSeq has advanced

  fs.appendFileSync(f, turnLine("m-new-turn-0", 950_000) + "\n"); // the new turn's own first reading, still over the floor
  await sampler.tick();
  watcher.tick();
  check("(b) wind-down turn completed, new turn still over the floor: STILL no second interrupt (once per session)",
    emergencyEvents().length === 1 && interrupts.length === 1);

  // And within THIS new turn, several more sampler ticks must still de-dup to exactly one total.
  for (let i = 1; i <= 3; i++) {
    fs.appendFileSync(f, turnLine(`m-new-turn-${i}`, 950_000 + i) + "\n");
    await sampler.tick();
    watcher.tick();
  }
  check("new turn, cycles 2-4: STILL exactly ONE interrupt total (once per session id, never once per turn or tick)",
    emergencyEvents().length === 1 && interrupts.length === 1);
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — MidTurnContextSampler + ContextWatcher running TOGETHER: the sampler bumping " +
    "ctxUpdatedAt on every tick within one turn does NOT re-trigger the emergency interrupt, and (round 4) " +
    "neither a Stop landing inside the settle window nor a genuinely completed wind-down turn followed by " +
    "a new one re-arms it either — this interrupt fires AT MOST ONCE PER SESSION ID, full stop."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
