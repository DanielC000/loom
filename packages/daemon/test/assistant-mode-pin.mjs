import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ASSISTANT structural `auto` default (card 5603f40f, out of ac90ca8e's investigation).
//
// THE BUG: a companion ("assistant" role) session's boot-cycle target came ONLY from the shared
// `config.permission.startupModeCycles` project knob — the SAME knob a project sets for its manager's
// sake. A companion's "human" reaches it over a CHAT channel via `chat_reply`, so its stdin is never a
// live TUI human (the exact structural property `disallowedToolsForRole` already recognizes it shares
// with `worker`) — an approval prompt would block on input that never comes, and there was no single true
// answer to "what mode does a companion run in": it was whatever the knob happened to resolve to, movable
// by a manager-motivated change with no role guard.
//
// THE FIX: SessionService.resolveAgentSpawn (the ONE chokepoint every fresh/resume/fork/recycle spawn
// threads through) now pins BOTH `worker` and `assistant`'s boot-cycle target to `auto` via
// `cyclesToReachFromAcceptEdits("auto")` — INDEPENDENT of the shared `config.permission.startupModeCycles`
// knob. Every OTHER role (manager/platform/setup/auditor/plain) keeps using
// `config.permission.startupModeCycles` verbatim — byte-identical to before.
//
// THE DISCRIMINATING PAIR (doctrine: "vary the config knob and show the assertion tracks it — or
// correctly refuses to"): this test configures the PROJECT with `startupModeCycles: 0` (a project that
// deliberately disabled the boot-cycle dance, e.g. for manager-related stability) and asserts:
//   - an ASSISTANT session REFUSES to track it — it still targets `auto` regardless.
//   - a MANAGER session under the SAME config STILL TRACKS it — stays at the gate-free `acceptEdits`
//     boot mode (0 cycles). This is the control arm: without it, an assertion that merely checks
//     "assistant lands at auto" would pass just as well if the pin were a no-op and the project default
//     (cycles=2 → auto) were doing all the work — proving nothing about role-scoping. Forcing the knob to
//     a DIFFERENT value than what a pin would target, and showing ONE role tracks it while the OTHER
//     doesn't, is what makes this a real discriminator.
//
// Companions are spawned via a role="assistant" PROFILE on an ordinary agent (`PROFILE_SPAWNABLE_ROLES`
// includes "assistant" — see sessions/service.ts), through the generic `startNew` entry point — the same
// path a real companion provision uses (gateway/server.ts's provision endpoint), NOT a dedicated
// "spawnAssistant" method (none exists).
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like worker-mode-default.mjs / profile-spawn.mjs: isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty injected via
// PtyHost's createPty() seam. No real claude, no daemon, no network, no git repo needed (neither role
// creates a worktree).
//
// Run: 1) build (turbo builds shared first), 2) node test/assistant-mode-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist (paths.ts/os.homedir). ---
const tmpHome = path.join(os.tmpdir(), `loom-amp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveConfig } = await import("@loom/shared");
const { modeAfterCyclesFromAcceptEdits, cyclesToReachFromAcceptEdits } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// --- a plain (non-git) project dir — neither assistant nor manager creates a worktree ---
const repo = path.join(os.tmpdir(), `loom-amp-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({
  id: "pP", name: "P", repoPath: repo, vaultPath: repo,
  config: { permission: { startupModeCycles: 0 } }, // project deliberately disables cycling
  createdAt: now, archivedAt: null,
});
const resolved = resolveConfig({ permission: { startupModeCycles: 0 } });
check("(setup) the project's resolved config really carries startupModeCycles:0", resolved.permission.startupModeCycles === 0);

db.insertProfile({ id: "profAssistant", name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentAssistant", projectId: "pP", name: "A", startupPrompt: "ASSISTANT_PROMPT", position: 0, profileId: "profAssistant" });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "M", startupPrompt: "MGR_PROMPT", position: 1, profileId: null });

// Fake pty seam: capture every SpawnOpts.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return super.createPty(opts);
  }
  isAlive() { return false; } // no real OS pty here — resume()'s already-live short-circuit must not trip
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

try {
  // ===================== FRESH assistant spawn under startupModeCycles:0 → forced to auto (THE FIX) =====================
  const a = svc.startNew("agentAssistant");
  check("(setup) profile really conferred role=assistant", a.role === "assistant" && db.getSession(a.id).role === "assistant");
  const oAssistantFresh = optsFor(a.id);
  check("(assistant fresh) does NOT inherit the project's 0 — it is pinned to reach auto regardless",
    oAssistantFresh?.permission.startupModeCycles === cyclesToReachFromAcceptEdits("auto"));
  check("(assistant fresh) that pinned count actually lands on auto",
    modeAfterCyclesFromAcceptEdits(oAssistantFresh?.permission.startupModeCycles ?? 0) === "auto");
  check("(assistant fresh) boots at acceptEdits (the gate-free mode --permission-mode emits) before cycling",
    oAssistantFresh?.permission.mode === "acceptEdits");

  // ===================== FRESH manager spawn under the SAME startupModeCycles:0 → stays at acceptEdits (CONTROL ARM — UNCHANGED) =====================
  // This is the discriminator: a role that is NOT pinned must still track the config knob, or the
  // assistant assertions above would prove nothing (they'd pass identically if the pin were a no-op and
  // the project's own default happened to already be `auto`).
  const m = svc.startManager("agentMgr");
  const oMgrFresh = optsFor(m.id);
  check("(manager fresh, CONTROL) carries the PROJECT's startupModeCycles verbatim (0) — role gating untouched",
    oMgrFresh?.permission.startupModeCycles === 0);
  check("(manager fresh, CONTROL) 0 cycles ⇒ stays at the gate-free acceptEdits boot mode (no forced auto)",
    modeAfterCyclesFromAcceptEdits(oMgrFresh?.permission.startupModeCycles ?? 0) === "acceptEdits");

  // ===================== RESUME the assistant → resumeModeTarget=auto, consistent with the fresh spawn =====================
  const engId = "cccccccc-dddd-eeee-ffff-000000000000";
  db.setEngineSessionId(a.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setBusy(a.id, false);
  host.capture.length = 0;
  svc.resume(a.id);
  const oAssistantResume = optsFor(a.id);
  check("(assistant resume) resumeModeTarget=auto (matches the fresh assistant's forced target, not the project's 0)",
    oAssistantResume?.resumeModeTarget === "auto");
  check("(assistant resume) startupModeCycles still pinned to 0 (the blind branch stays inert on resume)",
    oAssistantResume?.permission.startupModeCycles === 0);

  // ===================== RESUME the manager under the SAME 0-config → stays at acceptEdits (CONTROL ARM — UNCHANGED) =====================
  const engIdMgr = "dddddddd-eeee-ffff-0000-111111111111";
  db.setEngineSessionId(m.id, engIdMgr);
  const tpathMgr = engineTranscriptPath(repo, engIdMgr);
  fs.mkdirSync(path.dirname(tpathMgr), { recursive: true });
  fs.writeFileSync(tpathMgr, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setBusy(m.id, false);
  host.capture.length = 0;
  svc.resume(m.id);
  const oMgrResume = optsFor(m.id);
  check("(manager resume, CONTROL) resumeModeTarget stays acceptEdits (the project's 0, untouched by the assistant pin)",
    oMgrResume?.resumeModeTarget === "acceptEdits");
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a spawned ASSISTANT (fresh + resume) is structurally pinned to the `auto` boot target regardless of the project's shared startupModeCycles knob, while a manager under the SAME project config still tracks the knob unchanged (the discriminating control arm) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
