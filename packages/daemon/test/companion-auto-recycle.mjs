import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1837a542 — opt-in AUTO-RECYCLE of an exhausted Companion. NO claude, NO network, NO daemon: ContextWatcher
// is driven with an injected pty slice, a recording `recycleCompanion` fake (which emulates what the real recycle
// does to the DB: clears the exhaustion mark, dismisses the exhaustion notice) and a recording
// `notifyCompanionOwner` fake; tick() is driven directly.
//
// Covers both polarities and the episode rules:
//   (1) flag OFF (the default)  -> NO recycle; the pre-existing notice + the ONE "exhausted" chat message only.
//   (2) flag ON                 -> exactly ONE recycle per episode (later ticks, a reboot add none), the owner gets
//                                  an UNREAD "automatically recycled" notice + ONE "auto-recycled" chat message,
//                                  and the episode's event is recorded.
//   (3) a SECOND episode        -> recycles again (second notice, second message).
//   (4) the recycle FAILS       -> one attempt, NO retry (resolved ok:false / rejected / thrown), the original
//                                  notice stays open, a SECOND unread notice says it failed, ONE "exhausted" message.
//   (5) unfinished composer draft -> DEFERRED with no bound (no claim, no recycle, no message); recycles once clean.
//   (6) no recycle hook wired / no config row / flag on a healthy Companion / a manager -> never a recycle.
//   (7) the DB flag: default false, preserved by an ordinary config upsert, absent row -> false, legacy-table
//       migration backfills 0 (booted against an OLD-shape companion_config table).
//   (8) the flag has NO agent write path: only db.ts + gateway/server.ts name setCompanionAutoRecycle, no tool on
//       the built orchestration surfaces mentions auto-recycle, and no src/mcp router source does either.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/companion-auto-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE before importing dist; never write a transcript fixture
// under the real homedir.
const sandboxHome = mkdtempManaged("loom-ctxw-autorecycle-home-");
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const {
  ContextWatcher, ASSISTANT_AUTO_RECYCLE_META_PREFIX, ASSISTANT_EXHAUSTION_TITLE_SUFFIX,
  ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX, ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX,
} = await import("../dist/orchestration/context-watcher.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const settle = () => new Promise((r) => setImmediate(r)); // let the hooks' promise continuations run (event-anchored, no timer)

const NOW = new Date("2026-11-06T10:00:00.000Z");
const RUN_SUFFIX = `${Date.now()}-${process.pid}`;
const AUTO_KIND = "assistant_auto_recycle";

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};

function makeEnv({ withRecycle = true } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctxw-autorecycle-${RUN_SUFFIX}-${Math.random().toString(36).slice(2, 8)}.db`);
  const e = {
    dbFile, transcriptFiles: [], alive: new Set(), recycleCalls: [], chatCalls: [], dirty: false,
    recycleImpl: null, chatImpl: async () => ({ outcome: "sent", channel: "telegram" }),
  };
  e.projId = `car-p-${RUN_SUFFIX}`;
  e.agentId = `car-a-${RUN_SUFFIX}`;
  // Emulates what SessionService.recycleCompanion does to the DB: clear the mark + busy, dismiss the exhaustion notice.
  e.okRecycle = async (sid) => {
    e.db.setContextExhausted(sid, null, null);
    e.db.setBusy(sid, false);
    const open = e.db.listQuestionsForSession(sid)
      .filter((q) => q.type === "notice" && q.dismissedAt == null && q.title.endsWith(ASSISTANT_EXHAUSTION_TITLE_SUFFIX)).map((q) => q.id);
    e.db.dismissNotices(open, new Date().toISOString());
    return { ok: true };
  };
  e.recycleImpl = e.okRecycle;
  e.open = () => {
    e.db = new Db(dbFile);
    e.pty = {
      isAlive: (id) => e.alive.has(id),
      enqueueStdin: () => ({ delivered: true, queued: false }),
      markContextExhausted: (id) => { if (!e.alive.has(id)) return false; e.db.setBusy(id, false); return true; },
      busySinceMs: () => null,
      isComposerDirty: () => e.dirty,
    };
    e.watcher = new ContextWatcher({
      db: e.db, pty: e.pty, ratio: 0,
      notifyCompanionOwner: (sid, kind) => { e.chatCalls.push({ sid, kind }); return e.chatImpl(sid, kind); },
      ...(withRecycle ? { recycleCompanion: (sid) => { e.recycleCalls.push(sid); return e.recycleImpl(sid); } } : {}),
    });
  };
  e.open();
  const now = NOW.toISOString();
  e.db.insertProject({ id: e.projId, name: "CtxAutoRecycle", repoPath: e.projId, vaultPath: e.projId, config: {}, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: e.agentId, projectId: e.projId, name: "Juno", startupPrompt: "chat", position: 0 });
  return e;
}

function seedSession(e, id, role, { autoRecycle = null, record = REAL_EXHAUSTION_RECORD } = {}) {
  const cwd = `${e.projId}-${id}`;
  const engineSessionId = `eng-${RUN_SUFFIX}-${id}`;
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  e.transcriptFiles.push(file);
  if (autoRecycle !== null) {
    e.db.upsertCompanionConfig({
      sessionId: id, botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
      heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
    });
    e.db.setCompanionAutoRecycle(id, autoRecycle);
  }
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  for (const file of e.transcriptFiles) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* ignore */ } }
}

const autoEvents = (e, id) => e.db.listEvents(id).filter((ev) => ev.kind === AUTO_KIND);
const openNotices = (e, id) => e.db.listOpenQuestions().filter((q) => q.sessionId === id && q.type === "notice");
const noticesWithSuffix = (e, id, suffix) => openNotices(e, id).filter((q) => q.title.endsWith(suffix));
const tickAt = async (e, ms) => { e.watcher.tick(new Date(NOW.getTime() + ms)); await settle(); };
const reExhaust = (e, id) => e.db.setBusy(id, true); // the transcript still ends in the exhaustion marker

// ===== (1) flag OFF (default): notice-only, NO recycle =====
{
  const e = makeEnv();
  seedSession(e, "c1", "assistant", { autoRecycle: false });
  await tickAt(e, 0);
  await tickAt(e, 60_000);
  check("(1) flag off: NO recycle, ever", e.recycleCalls.length === 0);
  check("(1) flag off: the exhaustion notice is open and says nothing about auto-recycle",
    noticesWithSuffix(e, "c1", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 1
    && !/auto-recycle/i.test(noticesWithSuffix(e, "c1", ASSISTANT_EXHAUSTION_TITLE_SUFFIX)[0].body));
  check("(1) flag off: the ONE chat message is the ordinary 'exhausted' kind", e.chatCalls.length === 1 && e.chatCalls[0].kind === "exhausted");
  check("(1) flag off: no auto-recycle event and no claim", autoEvents(e, "c1").length === 0 && e.db.getMeta(`${ASSISTANT_AUTO_RECYCLE_META_PREFIX}c1`) === undefined);
  check("(1) flag off: the session is still marked exhausted", e.db.getSession("c1").contextExhaustedAt != null);
  cleanup(e);
}

// ===== (2) flag ON: exactly ONE recycle per episode; the owner is told once =====
{
  const e = makeEnv();
  seedSession(e, "c2", "assistant", { autoRecycle: true });
  await tickAt(e, 0);
  check("(2) flag on: the recycle hook ran exactly once, for this Companion", e.recycleCalls.length === 1 && e.recycleCalls[0] === "c2");
  check("(2) the mark is cleared by the (fake) recycle", e.db.getSession("c2").contextExhaustedAt == null);
  const ev = autoEvents(e, "c2");
  check("(2) one auto-recycle event, outcome recycled", ev.length === 1 && ev[0].detail.outcome === "recycled" && ev[0].managerSessionId === "c2");
  const done = noticesWithSuffix(e, "c2", ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX);
  check("(2) an UNREAD 'automatically recycled' notice is filed (not dismissed, readAt unset)", done.length === 1 && done[0].dismissedAt == null && done[0].readAt == null);
  check("(2) the exhaustion notice was dismissed by the recycle, so only the auto-recycled notice is open",
    noticesWithSuffix(e, "c2", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 0 && openNotices(e, "c2").length === 1);
  check("(2) the ONE chat message says auto-recycled (not 'press Recycle')", e.chatCalls.length === 1 && e.chatCalls[0].kind === "auto-recycled");
  await tickAt(e, 60_000);
  await tickAt(e, 120_000);
  check("(2) later ticks add NO second recycle, notice or message", e.recycleCalls.length === 1 && e.chatCalls.length === 1 && autoEvents(e, "c2").length === 1);
  // simulated reboot: fresh Db handle on the same file + fresh watcher
  e.db.close();
  e.open();
  await tickAt(e, 180_000);
  check("(2) after a simulated reboot: still ONE recycle and ONE message in total (the call logs live on the env, across the reopen)", e.recycleCalls.length === 1 && e.chatCalls.length === 1);
  check("(2) events carry no transcript/message text", !/Prompt is too long|context is full|invalid_request/i.test(JSON.stringify(autoEvents(e, "c2"))));
  cleanup(e);
}

// ===== (3) a SECOND episode recycles again =====
{
  const e = makeEnv();
  seedSession(e, "c3", "assistant", { autoRecycle: true });
  await tickAt(e, 0);
  check("(3) episode 1 recycled", e.recycleCalls.length === 1);
  reExhaust(e, "c3");
  await tickAt(e, 120_000);
  check("(3) episode 2: recycled AGAIN (second call)", e.recycleCalls.length === 2);
  const ev = autoEvents(e, "c3");
  check("(3) two auto-recycle events, both recycled, on DIFFERENT notice ids", ev.length === 2 && ev.every((x) => x.detail.outcome === "recycled") && ev[0].detail.noticeId !== ev[1].detail.noticeId);
  check("(3) two auto-recycled notices and two auto-recycled messages",
    noticesWithSuffix(e, "c3", ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX).length === 2 && e.chatCalls.filter((c) => c.kind === "auto-recycled").length === 2);
  await tickAt(e, 180_000);
  check("(3) …and the second episode is not repeated either", e.recycleCalls.length === 2);
  cleanup(e);
}

// ===== (4) the recycle FAILS (three shapes): one attempt, no retry, owner told =====
for (const [label, impl] of [
  ["resolved ok:false", async () => ({ ok: false, error: "companion process did not stop in time" })],
  ["rejected", async () => { throw new TypeError("boom"); }],
  ["thrown synchronously", () => { throw new RangeError("boom-sync"); }],
]) {
  const e = makeEnv();
  e.recycleImpl = impl;
  seedSession(e, "c4", "assistant", { autoRecycle: true });
  const origLog = console.log; const origErr = console.error; console.log = () => {}; console.error = () => {};
  try {
    await tickAt(e, 0);
    await tickAt(e, 60_000);
    await tickAt(e, 120_000);
  } finally { console.log = origLog; console.error = origErr; }
  const ev = autoEvents(e, "c4");
  check(`(4) ${label}: exactly ONE attempt across three ticks (no retry loop)`, e.recycleCalls.length === 1);
  check(`(4) ${label}: one auto-recycle event, outcome failed`, ev.length === 1 && ev[0].detail.outcome === "failed");
  check(`(4) ${label}: the ORIGINAL exhaustion notice stays open (the manual path is still offered)`, noticesWithSuffix(e, "c4", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 1);
  const failed = noticesWithSuffix(e, "c4", ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX);
  check(`(4) ${label}: a SECOND, fresh unread notice says the automatic recycle failed`, failed.length === 1 && failed[0].readAt == null && failed[0].dismissedAt == null);
  check(`(4) ${label}: the owner gets ONE chat message and it is the ordinary 'exhausted' kind`, e.chatCalls.length === 1 && e.chatCalls[0].kind === "exhausted");
  check(`(4) ${label}: the session is still marked exhausted (nothing was half-done)`, e.db.getSession("c4").contextExhaustedAt != null);
  cleanup(e);
}

// ===== (5) an unfinished composer draft DEFERS the recycle, without bound, and never claims =====
{
  const e = makeEnv();
  e.dirty = true;
  seedSession(e, "c5", "assistant", { autoRecycle: true });
  for (let i = 0; i < 5; i++) await tickAt(e, i * 60_000);
  check("(5) draft present across five ticks: NO recycle", e.recycleCalls.length === 0);
  check("(5) …no claim taken and no chat message sent while deferred", e.db.getMeta(`${ASSISTANT_AUTO_RECYCLE_META_PREFIX}c5`) === undefined && e.chatCalls.length === 0);
  check("(5) …the exhaustion notice is open, and mentions that auto-recycle waits for the draft",
    noticesWithSuffix(e, "c5", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 1 && /unfinished draft/.test(noticesWithSuffix(e, "c5", ASSISTANT_EXHAUSTION_TITLE_SUFFIX)[0].body));
  e.dirty = false;
  await tickAt(e, 600_000);
  check("(5) draft cleared: the very next tick recycles exactly once", e.recycleCalls.length === 1 && e.chatCalls.length === 1 && e.chatCalls[0].kind === "auto-recycled");
  cleanup(e);
}

const ORDINARY_RECORD = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "all good" }] } };
const writeTail = (e, record) => fs.writeFileSync(e.transcriptFiles[e.transcriptFiles.length - 1], `${JSON.stringify(record)}\n`);
const quiet = async (fn) => { const l = console.log; const er = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = er; } };

// ===== (5b) the draft-defer + MANUAL-recycle race: the owner presses Recycle while auto-recycle is deferred =====
{
  const e = makeEnv();
  e.dirty = true;
  seedSession(e, "c5b", "assistant", { autoRecycle: true });
  await tickAt(e, 0);
  await tickAt(e, 60_000);
  await e.okRecycle("c5b"); // the owner's manual recycle lands meanwhile (clears the mark, dismisses the notice)
  e.dirty = false;
  await tickAt(e, 120_000);
  await tickAt(e, 180_000);
  check("(5b) manual recycle during the deferral: auto-recycle NEVER fires afterwards (0 calls)", e.recycleCalls.length === 0);
  check("(5b) …and no auto event, no chat message, no failed/auto-recycled notice", autoEvents(e, "c5b").length === 0 && e.chatCalls.length === 0 && openNotices(e, "c5b").length === 0);
  cleanup(e);
}

// ===== (5c) SUPERSEDED: the attempt is in flight, the owner recovers it by hand, the attempt then reports failure =====
{
  const e = makeEnv();
  e.recycleImpl = async (sid) => { await e.okRecycle(sid); return { ok: false, error: "this companion's context is not exhausted — nothing was changed" }; };
  seedSession(e, "c5c", "assistant", { autoRecycle: true });
  await quiet(() => tickAt(e, 0));
  const ev = autoEvents(e, "c5c");
  check("(5c) one attempt, recorded with outcome superseded (not failed)", e.recycleCalls.length === 1 && ev.length === 1 && ev[0].detail.outcome === "superseded");
  check("(5c) NO failed notice and NO chat message", noticesWithSuffix(e, "c5c", ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX).length === 0 && e.chatCalls.length === 0);
  check("(5c) …and nothing else is open (the manual recycle dismissed the exhaustion notice)", openNotices(e, "c5c").length === 0);
  cleanup(e);
}

// ===== (5g) NOT superseded: a busy rising edge (the owner sends a message mid-attempt) clears the mark TRANSIENTLY;
// the attempt then fails and the turn re-marks into the SAME open notice. The owner must be told. =====
{
  const e = makeEnv();
  e.recycleImpl = async (sid) => {
    e.db.clearContextExhaustedOnResume(sid); // handleBusyEdge: ANY turn's rising edge clears the mark
    e.db.setBusy(sid, true);                 // the owner's message started a turn
    return { ok: false, error: "companion process did not stop in time" };
  };
  seedSession(e, "c5g", "assistant", { autoRecycle: true });
  await quiet(() => tickAt(e, 0));
  check("(5g) the mark really is transiently null when the attempt fails (the premise of the old, wrong signal)", e.db.getSession("c5g").contextExhaustedAt == null);
  const ev = autoEvents(e, "c5g");
  check("(5g) classed FAILED, not superseded (the episode's notice is not dismissed)", ev.length === 1 && ev[0].detail.outcome === "failed");
  check("(5g) the owner IS told: a failed notice and the episode's one 'exhausted' chat message",
    noticesWithSuffix(e, "c5g", ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX).length === 1 && e.chatCalls.length === 1 && e.chatCalls[0].kind === "exhausted");
  // the owner's turn fails (the transcript still ends in the exhaustion marker): re-mark into the same open notice
  await quiet(() => tickAt(e, 60_000));
  check("(5g) the re-mark reuses the open exhaustion notice, makes no second attempt and sends no second message",
    e.db.getSession("c5g").contextExhaustedAt != null && noticesWithSuffix(e, "c5g", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 1 && e.recycleCalls.length === 1 && e.chatCalls.length === 1);
  cleanup(e);
}

// ===== (5d) the failed notice is RETIRED on recovery (and the success record is not) =====
{
  const e = makeEnv();
  e.recycleImpl = async () => ({ ok: false, error: "companion process did not stop in time" });
  seedSession(e, "c5d", "assistant", { autoRecycle: true });
  await quiet(() => tickAt(e, 0));
  check("(5d) setup: the failed notice and the original notice are both open", noticesWithSuffix(e, "c5d", ASSISTANT_AUTO_RECYCLE_FAILED_TITLE_SUFFIX).length === 1 && noticesWithSuffix(e, "c5d", ASSISTANT_EXHAUSTION_TITLE_SUFFIX).length === 1);
  e.db.clearContextExhaustedOnResume("c5d"); // the owner recovers it (manual recycle / compact): mark clear, idle, healthy tail
  e.db.setBusy("c5d", false);
  writeTail(e, ORDINARY_RECORD);
  await tickAt(e, 60_000);
  check("(5d) recovery retires BOTH the exhaustion notice and the failed-auto-recycle notice", openNotices(e, "c5d").length === 0);
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "c5e", "assistant", { autoRecycle: true });
  await tickAt(e, 0); // success: the auto-recycled record notice is filed
  writeTail(e, ORDINARY_RECORD); // the fresh engine answered
  await tickAt(e, 60_000);
  check("(5e) CONTROL: after the fresh session's first turn the 'automatically recycled' record is NOT swept away",
    noticesWithSuffix(e, "c5e", ASSISTANT_AUTO_RECYCLED_TITLE_SUFFIX).length === 1);
  cleanup(e);
}

// ===== (5f) the episode end clears the auto-recycle claim: a notice left open across recovery can't silence the next one =====
{
  const e = makeEnv();
  e.recycleImpl = async () => ({ ok: false, error: "companion process did not stop in time" });
  seedSession(e, "c5f", "assistant", { autoRecycle: true });
  await quiet(() => tickAt(e, 0));
  const n1 = noticesWithSuffix(e, "c5f", ASSISTANT_EXHAUSTION_TITLE_SUFFIX)[0].id;
  check("(5f) setup: episode 1 attempted once and holds the claim", e.recycleCalls.length === 1 && e.db.getMeta(`${ASSISTANT_AUTO_RECYCLE_META_PREFIX}c5f`) === n1);
  e.db.clearContextExhaustedOnResume("c5f");
  e.db.setBusy("c5f", false);
  writeTail(e, ORDINARY_RECORD);
  const realDismiss = e.db.dismissNotices.bind(e.db);
  e.db.dismissNotices = () => { throw new Error("simulated dismiss failure"); }; // the notice stays open across the recovery
  await quiet(() => tickAt(e, 60_000));
  e.db.dismissNotices = realDismiss;
  check("(5f) the recovery cleared the auto-recycle claim even though the dismiss failed", !e.db.getMeta(`${ASSISTANT_AUTO_RECYCLE_META_PREFIX}c5f`));
  check("(5f) …and the old notice is still open (so the next episode reuses its id)", noticesWithSuffix(e, "c5f", ASSISTANT_EXHAUSTION_TITLE_SUFFIX)[0]?.id === n1);
  e.recycleImpl = e.okRecycle;
  writeTail(e, REAL_EXHAUSTION_RECORD);
  reExhaust(e, "c5f");
  await tickAt(e, 120_000);
  check("(5f) episode 2 (same notice id) auto-recycles — NOT silenced by the stale claim", e.recycleCalls.length === 2);
  cleanup(e);
}

// ===== (6) CONTROLS: nothing recycles when it shouldn't =====
{
  const e = makeEnv({ withRecycle: false });
  seedSession(e, "c6a", "assistant", { autoRecycle: true });
  await tickAt(e, 0);
  check("(6a) flag on but no recycle hook wired: no recycle, and the ordinary 'exhausted' message goes out",
    e.recycleCalls.length === 0 && e.chatCalls.length === 1 && e.chatCalls[0].kind === "exhausted" && autoEvents(e, "c6a").length === 0);
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "c6b", "assistant"); // NO companion_config row at all
  await tickAt(e, 0);
  check("(6b) an exhausted Companion with no config row: no recycle, ordinary 'exhausted' message", e.recycleCalls.length === 0 && e.chatCalls.length === 1 && e.chatCalls[0].kind === "exhausted");
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "c6c", "assistant", { autoRecycle: true, record: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "all good" }] } } });
  seedSession(e, "c6m", "manager");
  await tickAt(e, 0);
  check("(6c) a HEALTHY auto-recycle Companion and an exhausted manager: never recycled", e.recycleCalls.length === 0 && e.chatCalls.length === 0);
  cleanup(e);
}

// ===== (7) the DB flag =====
{
  const e = makeEnv();
  seedSession(e, "c7", "assistant", { autoRecycle: null });
  const cfg = () => ({
    sessionId: "c7", botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
  });
  check("(7) a brand-new config row defaults autoRecycleOnExhaustion to false", e.db.upsertCompanionConfig(cfg()).autoRecycleOnExhaustion === false);
  check("(7) setCompanionAutoRecycle on an existing row returns true and persists", e.db.setCompanionAutoRecycle("c7", true) === true && e.db.getCompanionConfig("c7").autoRecycleOnExhaustion === true);
  check("(7) an ordinary config upsert PRESERVES the flag (the REST config writer cannot clear or set it)", e.db.upsertCompanionConfig({ ...cfg(), heartbeatIntervalMinutes: 30 }).autoRecycleOnExhaustion === true && e.db.getCompanionConfig("c7").autoRecycleOnExhaustion === true);
  check("(7) turning it back off persists", (e.db.setCompanionAutoRecycle("c7", false), e.db.getCompanionConfig("c7").autoRecycleOnExhaustion === false));
  check("(7) a session with no config row: setCompanionAutoRecycle returns false", e.db.setCompanionAutoRecycle("nobody", true) === false);
  cleanup(e);
}
{
  // The additive migration on an OLD-shape companion_config table (no auto_recycle_on_exhaustion column).
  const { default: BetterSqlite } = await import("better-sqlite3");
  const dbFile = path.join(os.tmpdir(), `loom-ctxw-autorecycle-mig-${RUN_SUFFIX}.db`);
  const raw = new BetterSqlite(dbFile);
  raw.exec(`CREATE TABLE companion_config (
    session_id TEXT PRIMARY KEY, bot_token_blob TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'telegram',
    allowed_chat_id TEXT NOT NULL, chat_scope TEXT NOT NULL DEFAULT 'dm', heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 0,
    heartbeat_prompt TEXT, enabled INTEGER NOT NULL DEFAULT 1, provisioned INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT);
    INSERT INTO companion_config (session_id, bot_token_blob, allowed_chat_id) VALUES ('legacy1', '', '1');`);
  const before = raw.prepare("PRAGMA table_info(companion_config)").all().map((c) => c.name);
  raw.close();
  check("(7m) the fixture table really is old-shape (control: the column is absent before boot)", !before.includes("auto_recycle_on_exhaustion"));
  const db = new Db(dbFile);
  const row = db.getCompanionConfig("legacy1");
  check("(7m) booting an old-shape table adds the column and the legacy row backfills to OFF", !!row && row.autoRecycleOnExhaustion === false);
  check("(7m) …and the flag can then be set on that legacy row", db.setCompanionAutoRecycle("legacy1", true) === true && db.getCompanionConfig("legacy1").autoRecycleOnExhaustion === true);
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== (8) NO agent write path =====
{
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const walk = (dir, out = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const files = walk(srcDir);
  check("(8) sanity: the scan really sees the daemon source (control: it finds db.ts and mcp/orchestration.ts)",
    files.some((f) => f.endsWith(`${path.sep}db.ts`)) && files.some((f) => f.endsWith(`mcp${path.sep}orchestration.ts`)));
  const callers = files.filter((f) => stripComments(fs.readFileSync(f, "utf8")).includes("setCompanionAutoRecycle(")).map((f) => path.relative(srcDir, f).split(path.sep).join("/")).sort();
  check(`(8) setCompanionAutoRecycle( is named ONLY in db.ts (definition) + gateway/server.ts (human REST) — saw: ${callers.join(", ")}`,
    callers.length === 2 && callers[0] === "db.ts" && callers[1] === "gateway/server.ts");
  const mcpHits = files.filter((f) => f.includes(`${path.sep}mcp${path.sep}`) && /auto.?recycle/i.test(stripComments(fs.readFileSync(f, "utf8"))));
  check(`(8) no src/mcp router source mentions auto-recycle (saw: ${mcpHits.map((f) => path.basename(f)).join(", ") || "none"})`, mcpHits.length === 0);
  // Negative control: the same regex DOES trip on text that has it.
  check("(8-control) POSITIVE: the sweep regex matches a tool named 'companion_auto_recycle_set'", /auto.?recycle/i.test("companion_auto_recycle_set"));

  // Dynamic: the REAL orchestration router, every role it can serve a Companion/manager/worker.
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const e = makeEnv();
  for (const [id, role] of [["s-asst", "assistant"], ["s-mgr", "manager"], ["s-wrk", "worker"]]) seedSession(e, id, role, { autoRecycle: role === "assistant" ? true : null });
  const orch = new OrchestrationMcpRouter(e.db, {});
  const all = [];
  for (const [id, role] of [["s-asst", "assistant"], ["s-mgr", "manager"], ["s-wrk", "worker"]]) {
    const server = orch.buildServer(id, role);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "companion-auto-recycle-test", version: "0" });
    await client.connect(clientT);
    all.push(...(await client.listTools()).tools.map((t) => t.name));
    await client.close();
  }
  check(`(8) the built orchestration surfaces (assistant/manager/worker; ${all.length} tools) are non-empty (sanity)`, all.length > 10);
  check("(8) …and no tool name on them mentions auto-recycle", !all.some((n) => /auto.?recycle/i.test(n)));
  cleanup(e);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
