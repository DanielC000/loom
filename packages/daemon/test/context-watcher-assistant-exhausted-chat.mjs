import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher -> the ONE Loom-authored owner chat message per Companion exhaustion episode (owner
// decision, request 2235c924). NO claude, NO network: the watcher takes an injected pty slice and an
// injected `notifyCompanionOwner` hook (a counting fake), and tick() is driven directly.
//
// Covers: two detections -> one send; no repeat on later ticks; no repeat after a simulated reboot (fresh
// Db handle on the SAME file + fresh watcher); a restart re-mark under a new stamp while the notice is still
// undismissed -> still one send; recovery + dismissal + a new exhaustion -> a NEW episode, a second send;
// no-binding and send-failed (resolved / rejected / thrown) are recorded as an event and NEVER retried;
// no hook wired -> inbox notice only; a healthy Companion and a manager send nothing (controls); events and
// the meta claim carry no message text.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-watcher-assistant-exhausted-chat.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE before importing dist; never write a transcript fixture
// under the real homedir.
const sandboxHome = mkdtempManaged("loom-ctxw-asstchat-home-");
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { ContextWatcher, ASSISTANT_EXHAUSTION_CHAT_META_PREFIX } = await import("../dist/orchestration/context-watcher.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const settle = () => new Promise((r) => setImmediate(r)); // let the hook's promise continuation run (event-anchored, no timer)

const NOW = new Date("2026-11-06T10:00:00.000Z");
const RUN_SUFFIX = `${Date.now()}-${process.pid}`;
const KIND = "assistant_exhaustion_chat_notice";

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};
const ORDINARY_RECORD = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "all good" }] } };

// `hookImpl` is swapped per scenario; `calls` records every hook invocation (session id only).
function makeEnv({ withHook = true } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctxw-asstchat-${RUN_SUFFIX}-${Math.random().toString(36).slice(2, 8)}.db`);
  const e = { dbFile, transcriptFiles: [], alive: new Set(), calls: [], hookImpl: async () => ({ outcome: "sent", channel: "telegram" }) };
  e.projId = `cwc-p-${RUN_SUFFIX}`;
  e.agentId = `cwc-a-${RUN_SUFFIX}`;
  e.open = () => {
    e.db = new Db(dbFile);
    e.pty = {
      isAlive: (id) => e.alive.has(id),
      enqueueStdin: () => ({ delivered: true, queued: false }),
      markContextExhausted: (id) => { if (!e.alive.has(id)) return false; e.db.setBusy(id, false); return true; },
      busySinceMs: () => null,
    };
    e.watcher = new ContextWatcher({
      db: e.db, pty: e.pty, ratio: 0,
      ...(withHook ? { notifyCompanionOwner: (sid) => { e.calls.push(sid); return e.hookImpl(sid); } } : {}),
    });
  };
  e.open();
  const now = NOW.toISOString();
  e.db.insertProject({ id: e.projId, name: "CtxAsstChat", repoPath: e.projId, vaultPath: e.projId, config: {}, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: e.agentId, projectId: e.projId, name: "Juno", startupPrompt: "chat", position: 0 });
  return e;
}

function seedSession(e, id, role, record) {
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
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  for (const file of e.transcriptFiles) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* ignore */ } }
}

const chatEvents = (e, id) => e.db.listEvents(id).filter((ev) => ev.kind === KIND);
const noticesFor = (e, id) => e.db.listOpenQuestions().filter((q) => q.sessionId === id && q.type === "notice");
const tickAt = async (e, ms) => { e.watcher.tick(new Date(NOW.getTime() + ms)); await settle(); };

// ===== (1) two detections -> ONE send; later ticks and a simulated reboot add none =====
{
  const e = makeEnv();
  seedSession(e, "a1", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  check("(1) first detection: the hook ran once for the Companion", e.calls.length === 1 && e.calls[0] === "a1");
  const evs = chatEvents(e, "a1");
  const noticeId = noticesFor(e, "a1")[0]?.id;
  check("(1) one chat-notice event, outcome sent, channel recorded, tied to the notice id",
    evs.length === 1 && evs[0].detail.outcome === "sent" && evs[0].detail.channel === "telegram" && evs[0].detail.noticeId === noticeId && evs[0].managerSessionId === "a1");
  check("(1) the claim in app_meta holds the notice id", e.db.getMeta(`${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}a1`) === noticeId);
  await tickAt(e, 60_000);
  await tickAt(e, 120_000);
  check("(1) the second detection (later ticks) sends nothing more", e.calls.length === 1 && chatEvents(e, "a1").length === 1);
  // simulated reboot: fresh Db handle on the same file + fresh watcher + fresh hook counter
  e.db.close();
  e.open();
  await tickAt(e, 180_000);
  check("(1) after a simulated reboot: still ONE send in total (durable dedup)", e.calls.length === 1 && chatEvents(e, "a1").length === 1);
  check("(1) events carry no message/transcript text", !/Prompt is too long|context is full|invalid_request/i.test(JSON.stringify(chatEvents(e, "a1"))));
  cleanup(e);
}

// ===== (2) heal: the claim missing but the notice present is NOT re-sent after a restart re-mark =====
{
  const e = makeEnv();
  seedSession(e, "a2", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  e.db.close();
  e.open(); // reboot
  e.db.clearContextExhaustedOnResume("a2"); // next delivery clears the DB mark, the turn fails again ...
  e.db.setBusy("a2", true);
  await tickAt(e, 600_000); // ... and the re-mark carries a NEW stamp for what is still one episode
  check("(2) restart re-mark under a new stamp, notice still undismissed: no second send", e.calls.length === 1 && chatEvents(e, "a2").length === 1);
  cleanup(e);
}

// ===== (3) a NEW episode after recovery + dismissal sends again; an undismissed re-exhaustion does not =====
{
  const e = makeEnv();
  seedSession(e, "a3", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  const firstId = noticesFor(e, "a3")[0].id;
  e.db.clearContextExhaustedOnResume("a3");
  e.db.setBusy("a3", true);
  await tickAt(e, 60_000);
  check("(3) re-exhaustion while the first notice is undismissed: same episode, still ONE send", e.calls.length === 1 && chatEvents(e, "a3").length === 1);
  e.db.dismissNotices([firstId], NOW.toISOString()); // recovery retires the notice
  e.db.clearContextExhaustedOnResume("a3");
  e.db.setBusy("a3", true);
  await tickAt(e, 120_000);
  const evs = chatEvents(e, "a3");
  check("(3) after recovery + dismissal, a new exhaustion is a NEW episode: a second send", e.calls.length === 2 && evs.length === 2);
  check("(3) …keyed to a different notice id than the first", evs.length === 2 && evs[0].detail.noticeId === firstId && evs[1].detail.noticeId !== firstId);
  cleanup(e);
}

// ===== (4) no binding: recorded, not retried =====
{
  const e = makeEnv();
  e.hookImpl = async () => ({ outcome: "no-binding" });
  seedSession(e, "a4", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  await tickAt(e, 60_000);
  await tickAt(e, 120_000);
  const evs = chatEvents(e, "a4");
  check("(4) no-binding: ONE event with outcome no-binding", evs.length === 1 && evs[0].detail.outcome === "no-binding");
  check("(4) no-binding: the hook was called once, never retried on later ticks", e.calls.length === 1);
  check("(4) the inbox notice is still filed (durable path)", noticesFor(e, "a4").length === 1);
  cleanup(e);
}

// ===== (5) send failure, three shapes (resolved send-failed / rejected / thrown synchronously): recorded, no retry =====
for (const [label, impl, wantReason] of [
  ["resolved send-failed", async () => ({ outcome: "send-failed", channel: "telegram", reason: "timeout" }), "timeout"],
  ["rejected", async () => { throw new TypeError("boom with secret text"); }, "TypeError"],
  ["thrown synchronously", () => { throw new RangeError("boom with secret text"); }, "RangeError"],
]) {
  const e = makeEnv();
  e.hookImpl = impl;
  seedSession(e, "a5", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  await tickAt(e, 60_000);
  const evs = chatEvents(e, "a5");
  check(`(5) ${label}: ONE send-failed event with reason ${wantReason}`, evs.length === 1 && evs[0].detail.outcome === "send-failed" && evs[0].detail.reason === wantReason);
  check(`(5) ${label}: not retried`, e.calls.length === 1);
  check(`(5) ${label}: the error message text is never recorded`, !/secret text/.test(JSON.stringify(evs)));
  check(`(5) ${label}: the exhaustion itself is still marked and the notice filed`, e.db.getSession("a5").contextExhaustedAt != null && noticesFor(e, "a5").length === 1);
  cleanup(e);
}

// ===== (6) no hook wired: inbox notice only, no chat event, no claim =====
{
  const e = makeEnv({ withHook: false });
  seedSession(e, "a6", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  check("(6) no hook: notice filed, no chat event, no meta claim",
    noticesFor(e, "a6").length === 1 && chatEvents(e, "a6").length === 0 && e.db.getMeta(`${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}a6`) === undefined);
  cleanup(e);
}

// ===== (7) CONTROLS: a healthy Companion and an exhausted manager send nothing =====
{
  const e = makeEnv();
  seedSession(e, "a7-ok", "assistant", ORDINARY_RECORD);
  seedSession(e, "m7", "manager", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  check("(7) healthy Companion + exhausted manager: the hook is never called", e.calls.length === 0);
  check("(7) …and no chat-notice event is filed for either", chatEvents(e, "a7-ok").length === 0 && chatEvents(e, "m7").length === 0);
  cleanup(e);
}

const writeTail = (e, id, record) => fs.writeFileSync(e.transcriptFiles[e.transcriptFiles.length - 1], `${JSON.stringify(record)}\n`);

// ===== (8) one message per EXHAUSTION however it ended: a heal WITHOUT a recycle (human-composer /compact)
// ends the episode, so the next exhaustion messages again =====
{
  const e = makeEnv();
  seedSession(e, "a8", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  const firstId = noticesFor(e, "a8")[0].id;
  check("(8) exhaust -> first message", e.calls.length === 1);
  // the heal: the composer turn's rising edge clears the mark; the compact succeeded (tail is ordinary), idle
  e.db.clearContextExhaustedOnResume("a8");
  e.db.setBusy("a8", false);
  writeTail(e, "a8", ORDINARY_RECORD);
  await tickAt(e, 60_000);
  check("(8) the recovery ended the episode: the old notice is dismissed and the claim cleared",
    noticesFor(e, "a8").length === 0 && !e.db.getMeta(`${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}a8`));
  check("(8) recovery itself sends nothing", e.calls.length === 1);
  // re-exhaust
  writeTail(e, "a8", REAL_EXHAUSTION_RECORD);
  e.db.setBusy("a8", true);
  await tickAt(e, 120_000);
  const evs = chatEvents(e, "a8");
  check("(8) heal -> re-exhaust: a SECOND message, paired with a NEW notice", e.calls.length === 2 && evs.length === 2 && evs[1].detail.noticeId !== firstId && noticesFor(e, "a8").length === 1);
  cleanup(e);
}

// ===== (8b) the same heal when the best-effort dismiss FAILS: the claim is already cleared, so the next episode still messages =====
{
  const e = makeEnv();
  seedSession(e, "a8b", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  const firstId = noticesFor(e, "a8b")[0].id;
  e.db.clearContextExhaustedOnResume("a8b");
  e.db.setBusy("a8b", false);
  writeTail(e, "a8b", ORDINARY_RECORD);
  const realDismiss = e.db.dismissNotices.bind(e.db);
  e.db.dismissNotices = () => { throw new Error("simulated dismiss failure"); };
  const origErr = console.error; console.error = () => {};
  await tickAt(e, 60_000);
  console.error = origErr;
  e.db.dismissNotices = realDismiss;
  check("(8b) dismiss failed: the old notice is still open", noticesFor(e, "a8b").length === 1 && noticesFor(e, "a8b")[0].id === firstId);
  writeTail(e, "a8b", REAL_EXHAUSTION_RECORD);
  e.db.setBusy("a8b", true);
  await tickAt(e, 120_000);
  check("(8b) …yet the next exhaustion (re-using that open notice) still sends a second message", e.calls.length === 2 && chatEvents(e, "a8b").length === 2);
  cleanup(e);
}

// ===== (8c) CONTROLS: a retry in flight (busy) or a tail still ending in the marker is NOT a recovery =====
{
  const e = makeEnv();
  seedSession(e, "a8c", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  e.db.clearContextExhaustedOnResume("a8c"); // a delivery's rising edge ...
  e.db.setBusy("a8c", true);                 // ... retry in flight, tail still the old marker
  writeTail(e, "a8c", ORDINARY_RECORD);      // even an ordinary-looking tail must not count while busy
  await tickAt(e, 60_000);
  check("(8c) busy retry: not treated as recovery (claim kept, notice kept)", !!e.db.getMeta(`${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}a8c`) && noticesFor(e, "a8c").length === 1);
  cleanup(e);
}
{
  const e = makeEnv();
  seedSession(e, "a8d", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  e.db.clearContextExhaustedOnResume("a8d");
  e.db.setBusy("a8d", false); // idle but the tail STILL ends in the marker
  await tickAt(e, 60_000);
  check("(8d) idle with the exhaustion marker still the tail: claim and notice are kept", !!e.db.getMeta(`${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}a8d`) && noticesFor(e, "a8d").length === 1);
  cleanup(e);
}

// ===== (9) the owner's spam boundary =====
{
  // (a) dismisses the inbox notice while STILL exhausted, no restart: no resend
  const e = makeEnv();
  seedSession(e, "a9", "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0);
  const n1 = noticesFor(e, "a9")[0].id;
  e.db.dismissNotices([n1], NOW.toISOString());
  await tickAt(e, 60_000);
  await tickAt(e, 120_000);
  check("(9a) dismissed while still exhausted, no restart: no resend and no new notice", e.calls.length === 1 && chatEvents(e, "a9").length === 1 && noticesFor(e, "a9").length === 0);
  // (b) dismissal then a restart re-stamp: at most ONE extra message, paired with the new notice
  e.db.close();
  e.open(); // reboot
  e.db.clearContextExhaustedOnResume("a9");
  e.db.setBusy("a9", true);
  await tickAt(e, 600_000);
  const evs = chatEvents(e, "a9");
  const n2 = noticesFor(e, "a9")[0]?.id;
  check("(9b) dismissal then a restart re-stamp: exactly ONE extra message, paired with the NEW notice", e.calls.length === 2 && evs.length === 2 && !!n2 && n2 !== n1 && evs[1].detail.noticeId === n2);
  // a further dismissal does not resend
  e.db.dismissNotices([n2], NOW.toISOString());
  await tickAt(e, 660_000);
  await tickAt(e, 720_000);
  check("(9b) a further dismissal does not resend", e.calls.length === 2 && chatEvents(e, "a9").length === 2);
  cleanup(e);
}

// ===== (10) the claim is ATOMIC: db.claimMeta changes the row once per distinct value =====
{
  const e = makeEnv();
  check("(10) first claim wins", e.db.claimMeta("k10", "v1") === true);
  check("(10) the same value again loses (no change)", e.db.claimMeta("k10", "v1") === false);
  check("(10) a different value wins and is stored", e.db.claimMeta("k10", "v2") === true && e.db.getMeta("k10") === "v2");
  check("(10) after a clear to empty, the old value can be claimed again", (e.db.setMeta("k10", ""), e.db.claimMeta("k10", "v2")) === true);
  cleanup(e);
}

// ===== (11) recovery needs POSITIVE evidence: claim set + mark clear + idle, varying only the transcript =====
const claimKey = (id) => `${ASSISTANT_EXHAUSTION_CHAT_META_PREFIX}${id}`;
async function healedEnv(id) {
  const e = makeEnv();
  seedSession(e, id, "assistant", REAL_EXHAUSTION_RECORD);
  await tickAt(e, 0); // exhaust -> claim + notice + message
  e.db.clearContextExhaustedOnResume(id);
  e.db.setBusy(id, false);
  return e;
}
const stillWatching = (e, id) => !!e.db.getMeta(claimKey(id)) && noticesFor(e, id).length === 1;
const ended = (e, id) => !e.db.getMeta(claimKey(id)) && noticesFor(e, id).length === 0;
const USER_SLASH_COMPACT = { type: "user", message: { role: "user", content: "/compact" } };
const OTHER_SYNTHETIC_ERROR = {
  type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: 529 overloaded" }] },
  error: "unknown", isApiErrorMessage: true,
};
{
  const e = await healedEnv("a11a");
  fs.rmSync(e.transcriptFiles[0], { force: true });
  await tickAt(e, 60_000);
  check("(11a) missing transcript file: episode NOT ended", stillWatching(e, "a11a"));
  cleanup(e);
}
{
  const e = await healedEnv("a11b");
  fs.writeFileSync(e.transcriptFiles[0], "");
  await tickAt(e, 60_000);
  check("(11b) empty transcript file: episode NOT ended", stillWatching(e, "a11b"));
  cleanup(e);
}
{
  const e = await healedEnv("a11c");
  fs.appendFileSync(e.transcriptFiles[0], `${JSON.stringify(USER_SLASH_COMPACT)}\n`);
  await tickAt(e, 60_000);
  check("(11c) a slash-command user record after the marker: episode NOT ended", stillWatching(e, "a11c"));
  fs.appendFileSync(e.transcriptFiles[0], `${JSON.stringify(OTHER_SYNTHETIC_ERROR)}\n`);
  await tickAt(e, 120_000);
  check("(11c) …nor does a later synthetic API-error assistant record", stillWatching(e, "a11c"));
  cleanup(e);
}
{
  const e = await healedEnv("a11d");
  fs.appendFileSync(e.transcriptFiles[0], `${JSON.stringify(USER_SLASH_COMPACT)}\n${JSON.stringify(ORDINARY_RECORD)}\n`);
  await tickAt(e, 60_000);
  check("(11d) a real assistant record after the marker: episode ENDED (claim cleared, notice dismissed)", ended(e, "a11d"));
  cleanup(e);
}
{
  const e = await healedEnv("a11e");
  fs.appendFileSync(e.transcriptFiles[0], `${JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`);
  await tickAt(e, 60_000);
  check("(11e) a compact_boundary record after the marker: episode ENDED", ended(e, "a11e"));
  cleanup(e);
}

// ===== (12) the dismiss is RETRIED on later ticks while an open notice remains (keyed on the notice, not the claim) =====
{
  const e = await healedEnv("a12");
  fs.appendFileSync(e.transcriptFiles[0], `${JSON.stringify(ORDINARY_RECORD)}\n`);
  const realDismiss = e.db.dismissNotices.bind(e.db);
  let dismissCalls = 0;
  e.db.dismissNotices = (...args) => { dismissCalls++; if (dismissCalls === 1) throw new Error("simulated dismiss failure"); return realDismiss(...args); };
  const origErr = console.error; console.error = () => {};
  await tickAt(e, 60_000);
  console.error = origErr;
  check("(12) tick 1: the claim is cleared but the dismiss threw, so the notice is still open", !e.db.getMeta(claimKey("a12")) && noticesFor(e, "a12").length === 1 && dismissCalls === 1);
  await tickAt(e, 120_000);
  check("(12) tick 2: the dismiss is retried (claim already empty) and succeeds", dismissCalls === 2 && noticesFor(e, "a12").length === 0);
  await tickAt(e, 180_000);
  check("(12) tick 3: nothing left to do, no further dismiss call", dismissCalls === 2);
  cleanup(e);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
