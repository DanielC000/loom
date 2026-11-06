import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1837a542 (review fix) — the auto-recycle's draft defer reads the OWNER's draft off a REAL PtyHost.
//
// The defer must key on `PtyHost.isComposerDirty(id)` (the raw-terminal draft, `composerLen > 0`, the same gate the
// drain defers on), NOT on `getComposerDirtyLen(id)` (characters Loom's own submit() may have stranded). The
// fake-accessor cases in companion-auto-recycle.mjs cannot catch a wrong accessor, so this drives the REAL host's
// `composerLen` through `writeStdin` (a human's keystrokes arriving over the raw websocket relay) and hands that
// host to a real ContextWatcher:
//   (1) a half-typed owner draft (composerLen > 0, getComposerDirtyLen === 0)  -> NO recycle, ever, while it stands;
//   (2) the owner presses Enter (draft gone)                                   -> the very next tick recycles ONCE;
//   (3) a stale non-zero getComposerDirtyLen with NO owner draft               -> does NOT hold the recycle off.
// NO claude, NO network: the pty is a seam host (createSeamHost), the recycle a recording fake.
// Run: 1) build, 2) node packages/daemon/test/companion-auto-recycle-draft.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("car-draft-"); // short, registry-cleaned temp LOOM_HOME (before any ../dist import)
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true }); // a spawned session opens a per-session log here
// @decision 668bc52c — sandbox HOME/USERPROFILE before importing dist; never write a transcript fixture under the real homedir.
const sandboxHome = mkdtempManaged("loom-car-draft-sbx-");
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const settle = () => new Promise((r) => setImmediate(r));

const NOW = new Date("2026-11-06T10:00:00.000Z");
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SID = `car-draft-${sfx}`;
const EXHAUSTION = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new (createSeamHost(PtyHost))(events);
const dbFile = path.join(os.tmpdir(), `loom-car-draft-${sfx}.db`);
const db = new Db(dbFile);
const now = NOW.toISOString();
db.insertProject({ id: `p-${sfx}`, name: "Draft", repoPath: `p-${sfx}`, vaultPath: `p-${sfx}`, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: `a-${sfx}`, projectId: `p-${sfx}`, name: "Juno", startupPrompt: "chat", position: 0 });
const cwd = os.tmpdir();
const engineSessionId = `eng-${sfx}`;
db.insertSession({
  id: SID, projectId: `p-${sfx}`, agentId: `a-${sfx}`, engineSessionId, title: null, cwd,
  processState: "live", resumability: "resumable", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  ctxInputTokens: null, ctxTurns: null, model: null,
});
db.upsertCompanionConfig({
  sessionId: SID, botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
  heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
});
db.setCompanionAutoRecycle(SID, true);
const transcript = engineTranscriptPath(cwd, engineSessionId);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.writeFileSync(transcript, `${JSON.stringify(EXHAUSTION)}\n`);

const recycleCalls = [];
const watcher = new ContextWatcher({
  db, pty: host, ratio: 0,
  recycleCompanion: async (sid) => { recycleCalls.push(sid); db.setContextExhausted(sid, null, null); db.setBusy(sid, false); return { ok: true }; },
});
const tickAt = async (ms) => { watcher.tick(new Date(NOW.getTime() + ms)); await settle(); };
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

try {
  host.spawn({ sessionId: SID, cwd, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  check("setup: the real host sees the session as live and the composer clean", host.isAlive(SID) && host.isComposerDirty(SID) === false);

  // The owner half-types a message into the raw terminal (Enter never pressed).
  host.writeStdin(SID, BRACKET_PASTE_START + "half a thought, not sent yet" + BRACKET_PASTE_END);
  check("(1) the owner's draft is real: isComposerDirty is true …", host.isComposerDirty(SID) === true);
  check("(1) … while getComposerDirtyLen is 0 — the OTHER signal does not see the owner's draft (why the accessor matters)", (host.getComposerDirtyLen(SID) ?? 0) === 0);

  await tickAt(0); // detect + mark
  check("(1) setup: the watcher marked the Companion exhausted", db.getSession(SID).contextExhaustedAt != null);
  for (let i = 1; i <= 4; i++) await tickAt(i * 60_000);
  check("(1) a half-typed owner draft across five ticks: NO recycle (the draft is never destroyed)", recycleCalls.length === 0);
  check("(1) …and no claim was taken while deferred", db.getMeta(`companion_auto_recycle_claim:${SID}`) === undefined);

  // The owner sends it (Enter) -> composer clean -> the next tick recycles exactly once.
  host.writeStdin(SID, "\r");
  check("(2) pressing Enter frees the composer", host.isComposerDirty(SID) === false);
  // The real host marks the session busy on the owner's Enter; on an exhausted engine that turn is rejected at once
  // and busy clears again (the watcher skips a busy, still-marked session until then). Emulate that clearing.
  db.setBusy(SID, false);
  await tickAt(600_000);
  await tickAt(660_000);
  check("(2) draft gone: the next tick recycles exactly ONCE", recycleCalls.length === 1 && recycleCalls[0] === SID);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

// (3) A stale non-zero getComposerDirtyLen with NO owner draft must NOT hold auto-recycle off.
{
  const SID2 = `${SID}-b`;
  db.insertAgent({ id: `a2-${sfx}`, projectId: `p-${sfx}`, name: "Juno2", startupPrompt: "chat", position: 1 });
  const engine2 = `eng2-${sfx}`;
  db.insertSession({
    id: SID2, projectId: `p-${sfx}`, agentId: `a2-${sfx}`, engineSessionId: engine2, title: null, cwd,
    processState: "live", resumability: "resumable", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  db.upsertCompanionConfig({
    sessionId: SID2, botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
  });
  db.setCompanionAutoRecycle(SID2, true);
  const t2 = engineTranscriptPath(cwd, engine2);
  fs.mkdirSync(path.dirname(t2), { recursive: true });
  fs.writeFileSync(t2, `${JSON.stringify(EXHAUSTION)}\n`);
  try {
    host.spawn({ sessionId: SID2, cwd, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(SID2, { hook_event_name: "SessionStart" });
    host.live.get(SID2).composerDirtyLen = 40; // Loom's own stranded-submit counter, stale; no owner draft
    check("(3) setup: stale getComposerDirtyLen > 0 with a clean composer", host.getComposerDirtyLen(SID2) === 40 && host.isComposerDirty(SID2) === false);
    const before = recycleCalls.length;
    await tickAt(700_000); // detect + mark + (no draft) recycle in the same tick
    await tickAt(760_000);
    check("(3) a stale composerDirtyLen does NOT hold the recycle off: SID2 recycled exactly once", recycleCalls.length === before + 1 && recycleCalls[recycleCalls.length - 1] === SID2);
  } finally {
    try { host.stop(SID2, "hard"); } catch { /* ignore */ }
  }
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
