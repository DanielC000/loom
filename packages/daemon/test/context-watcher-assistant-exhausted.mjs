import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 98ac2bd4 — ContextWatcher detects context EXHAUSTION on a Companion (assistant-role) session,
// marks it, files an `assistant_context_exhausted` event and a daemon-authored inbox `notice` row (the
// Companion's own channel is the dead session). NO claude: the watcher takes an injected pty slice and
// tick() is driven directly. Same hermetic shape as context-watcher-context-exhausted.mjs (manager twin).
//
// Covers: mark + lastError + event + notice; no repeat on the next tick; no repeat after a simulated reboot
// (fresh Db handle on the same file + fresh watcher); the notice is listed by the inbox read even though the
// filer session is exhausted; a manager's exhaustion is unchanged (control); a non-matching transcript files
// nothing (negative control).
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-watcher-assistant-exhausted.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

// @decision 668bc52c — sandbox HOME/USERPROFILE before importing dist; never write a transcript fixture
// under the real homedir.
const sandboxHome = mkdtempManaged("loom-ctxw-asstexh-home-");
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { ContextWatcher, assistantExhaustionNoticeId } = await import("../dist/orchestration/context-watcher.js");
const { classify } = await import("../dist/companion/attention-push.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-11-06T10:00:00.000Z");
const RUN_SUFFIX = `${Date.now()}-${process.pid}`;

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};
const ORDINARY_RECORD = {
  type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
};

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-ctxw-asstexh-${RUN_SUFFIX}-${Math.random().toString(36).slice(2, 8)}.db`);
  const e = { dbFile, transcriptFiles: [], alive: new Set(), markedExhausted: [], enqueued: [] };
  e.projId = `cwa-p-${RUN_SUFFIX}`;
  e.agentId = `cwa-a-${RUN_SUFFIX}`;
  e.open = () => {
    e.db = new Db(dbFile);
    e.pty = {
      isAlive: (id) => e.alive.has(id),
      enqueueStdin: (id, text) => { e.enqueued.push({ id, text }); return { delivered: true, queued: false }; },
      markContextExhausted: (id) => {
        e.markedExhausted.push(id);
        if (!e.alive.has(id)) return false;
        e.db.setBusy(id, false);
        return true;
      },
      busySinceMs: () => null,
    };
    e.watcher = new ContextWatcher({ db: e.db, pty: e.pty, ratio: 0 });
  };
  e.open();
  const now = NOW.toISOString();
  e.db.insertProject({ id: e.projId, name: "CtxAsstExh", repoPath: e.projId, vaultPath: e.projId, config: {}, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: e.agentId, projectId: e.projId, name: "Juno", startupPrompt: "chat", position: 0 });
  return e;
}

function seedSession(e, id, role, record, extra = {}) {
  const cwd = `${e.projId}-${id}`;
  const engineSessionId = `eng-${RUN_SUFFIX}-${id}`;
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd,
    processState: "live", resumability: "resumable", busy: true,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    ctxInputTokens: null, ctxTurns: null, model: null, ...extra,
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

const eventsOf = (e, id, kind) => e.db.listEvents(id).filter((ev) => ev.kind === kind);
const noticesFor = (e, id) => e.db.listOpenQuestions().filter((q) => q.sessionId === id && q.type === "notice");

// ===== (1) DETECTED — a busy Companion whose transcript ends in the terminal marker =====
{
  const e = makeEnv();
  seedSession(e, "asst-exh", "assistant", REAL_EXHAUSTION_RECORD);
  e.watcher.tick(NOW);

  check("(1) pty.markContextExhausted was called for the Companion", e.markedExhausted.includes("asst-exh"));
  const row = e.db.getSession("asst-exh");
  check("(1) busy is now false", row.busy === false);
  check("(1) contextExhaustedAt is set", typeof row.contextExhaustedAt === "string" && row.contextExhaustedAt.length > 0);
  check("(1) lastError names the exhaustion", /context exhausted/i.test(row.lastError ?? ""));

  const events = eventsOf(e, "asst-exh", "assistant_context_exhausted");
  check("(1) exactly ONE assistant_context_exhausted event, filed under the Companion itself", events.length === 1 && events[0].managerSessionId === "asst-exh" && events[0].workerSessionId == null);
  check("(1) NO manager_context_exhausted event is filed for a Companion (a manager-kind consumer must never see it)", eventsOf(e, "asst-exh", "manager_context_exhausted").length === 0);
  check("(1) nothing is pushed into the dead session's queue", e.enqueued.length === 0);
  check("(1) classify() routes the new kind to the context-overflow attention class", classify("assistant_context_exhausted", events[0]?.detail) === "context-overflow");

  const notices = noticesFor(e, "asst-exh");
  check("(1) exactly ONE inbox notice row for the Companion", notices.length === 1);
  const n = notices[0];
  check("(1) the notice is a type:notice in state 'notice', unread/undismissed", n?.type === "notice" && n?.state === "notice" && n?.dismissedAt == null);
  check("(1) the notice names the Companion's display name and what the owner can do", /Juno/.test(n?.title ?? "") && /open the session|fresh Companion/i.test(n?.body ?? ""));
  check("(1) the notice carries NO transcript content (the exhaustion record's text is absent)", !/Prompt is too long|invalid_request/.test(`${n?.title}${n?.body}`));
  check("(1) the inbox read lists it while the filer session is exhausted (agentName joined via the filer, session still routed)", n?.agentName === "Juno" && n?.sessionLive === true && n?.sessionOrphaned === false);
  check("(1) the event records the notice id", events[0]?.detail?.noticeId === n?.id);

  // ===== (2) no repeat on the next tick =====
  e.watcher.tick(new Date(NOW.getTime() + 60_000));
  check("(2) next tick does not re-mark", e.markedExhausted.filter((id) => id === "asst-exh").length === 1);
  check("(2) next tick files no second event", eventsOf(e, "asst-exh", "assistant_context_exhausted").length === 1);
  check("(2) next tick files no second notice", noticesFor(e, "asst-exh").length === 1);

  // ===== (3) no repeat after a simulated reboot (fresh Db handle on the SAME file + fresh watcher) =====
  e.db.close();
  e.open();
  e.watcher.tick(new Date(NOW.getTime() + 120_000));
  check("(3) after a simulated reboot the session still reads exhausted", typeof e.db.getSession("asst-exh").contextExhaustedAt === "string");
  check("(3) after a simulated reboot: still ONE notice", noticesFor(e, "asst-exh").length === 1);
  check("(3) after a simulated reboot: still ONE event", eventsOf(e, "asst-exh", "assistant_context_exhausted").length === 1);

  // ===== (4) heal: a crash between the mark and the notice insert — the next tick files the missing notice
  // (once), keyed to the same episode. =====
  e.db.db.prepare("DELETE FROM questions WHERE session_id = ?").run("asst-exh");
  e.watcher.tick(new Date(NOW.getTime() + 180_000));
  check("(4) a missing notice for an already-marked episode is re-filed exactly once", noticesFor(e, "asst-exh").length === 1);
  e.watcher.tick(new Date(NOW.getTime() + 240_000));
  check("(4) …and not again on the following tick", noticesFor(e, "asst-exh").length === 1);

  // ===== (5) a human DISMISSAL is respected: the dismissed row still dedupes, so no new notice appears =====
  e.db.db.prepare("UPDATE questions SET dismissed_at = ? WHERE session_id = ?").run(NOW.toISOString(), "asst-exh");
  e.watcher.tick(new Date(NOW.getTime() + 300_000));
  check("(5) a dismissed notice is not re-filed", e.db.db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ?").get("asst-exh").c === 1);
  cleanup(e);
}

// ===== (6) NEGATIVE CONTROL — a Companion whose transcript does NOT end in the marker files nothing =====
{
  const e = makeEnv();
  seedSession(e, "asst-ok", "assistant", ORDINARY_RECORD);
  e.watcher.tick(NOW);
  check("(6) healthy Companion: not marked", e.markedExhausted.length === 0 && e.db.getSession("asst-ok").contextExhaustedAt == null);
  check("(6) healthy Companion: no event, no notice", eventsOf(e, "asst-ok", "assistant_context_exhausted").length === 0 && noticesFor(e, "asst-ok").length === 0);
  cleanup(e);
}

// ===== (7) CONTROL — a MANAGER's exhaustion is unchanged: manager kind, no notice =====
{
  const e = makeEnv();
  seedSession(e, "mgr-exh", "manager", REAL_EXHAUSTION_RECORD);
  e.watcher.tick(NOW);
  check("(7) manager marked exhausted", e.db.getSession("mgr-exh").contextExhaustedAt != null);
  check("(7) manager still files manager_context_exhausted (exactly one)", eventsOf(e, "mgr-exh", "manager_context_exhausted").length === 1);
  check("(7) manager files NO assistant_context_exhausted event", eventsOf(e, "mgr-exh", "assistant_context_exhausted").length === 0);
  check("(7) manager gets NO daemon-authored inbox notice", noticesFor(e, "mgr-exh").length === 0);
  cleanup(e);
}

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ===== (8) notice id is a v4-shaped UUID, deterministic in (session, stamp), differing across both =====
{
  const a = assistantExhaustionNoticeId("s1", "2026-11-06T10:00:00.000Z");
  check("(8) id is v4-shaped", V4.test(a));
  check("(8) id is deterministic", a === assistantExhaustionNoticeId("s1", "2026-11-06T10:00:00.000Z"));
  check("(8) id differs by stamp and by session", a !== assistantExhaustionNoticeId("s1", "2026-11-06T10:00:01.000Z") && a !== assistantExhaustionNoticeId("s2", "2026-11-06T10:00:00.000Z"));
  check("(8) different sessions don't share an 8-char prefix by construction", a.slice(0, 8) !== assistantExhaustionNoticeId("s2", "2026-11-06T10:00:00.000Z").slice(0, 8));
  const e = makeEnv();
  seedSession(e, "asst-id", "assistant", REAL_EXHAUSTION_RECORD);
  e.watcher.tick(NOW);
  check("(8) the filed notice row id is v4-shaped", noticesFor(e, "asst-id").length === 1 && V4.test(noticesFor(e, "asst-id")[0].id));
  cleanup(e);
}

// ===== (9) a codex-harness Companion is skipped entirely =====
{
  const e = makeEnv();
  seedSession(e, "asst-codex", "assistant", REAL_EXHAUSTION_RECORD, { harness: "codex" });
  e.watcher.tick(NOW);
  check("(9) codex Companion: not marked, no event, no notice",
    e.markedExhausted.length === 0 && e.db.getSession("asst-codex").contextExhaustedAt == null
    && eventsOf(e, "asst-codex", "assistant_context_exhausted").length === 0 && noticesFor(e, "asst-codex").length === 0);
  cleanup(e);
}

// ===== (10) recovery then a SECOND exhaustion: dismissed ⇒ a fresh notice; undismissed ⇒ none =====
{
  const e = makeEnv();
  seedSession(e, "asst-rec", "assistant", REAL_EXHAUSTION_RECORD);
  e.watcher.tick(NOW);
  check("(10) first episode: one notice", noticesFor(e, "asst-rec").length === 1);
  const firstId = noticesFor(e, "asst-rec")[0].id;
  // recovery: the next turn's rising edge clears the mark; the transcript still ends in the marker and it goes busy again.
  e.db.clearContextExhaustedOnResume("asst-rec");
  e.db.setBusy("asst-rec", true);
  e.watcher.tick(new Date(NOW.getTime() + 60_000));
  check("(10) second exhaustion while the first notice is UNDISMISSED: re-marked, a second event, but NO second notice",
    e.db.getSession("asst-rec").contextExhaustedAt != null && eventsOf(e, "asst-rec", "assistant_context_exhausted").length === 2
    && noticesFor(e, "asst-rec").length === 1 && noticesFor(e, "asst-rec")[0].id === firstId);
  check("(10) …and the second event points at the notice already in force", eventsOf(e, "asst-rec", "assistant_context_exhausted").every((ev) => ev.detail.noticeId === firstId));
  // owner dismisses, recovers, exhausts again ⇒ a fresh notice
  e.db.dismissNotices([firstId], NOW.toISOString());
  e.db.clearContextExhaustedOnResume("asst-rec");
  e.db.setBusy("asst-rec", true);
  e.watcher.tick(new Date(NOW.getTime() + 120_000));
  check("(10) after a dismissal, a third exhaustion files a NEW notice",
    e.db.db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ?").get("asst-rec").c === 2);
  cleanup(e);
}

// ===== (11) restart re-mark: in-memory hold lost, DB mark cleared by the next delivery, turn fails again
// ⇒ re-mark with a NEW stamp; no second notice while the first is undismissed =====
{
  const e = makeEnv();
  seedSession(e, "asst-rst", "assistant", REAL_EXHAUSTION_RECORD);
  e.watcher.tick(NOW);
  e.db.close();
  e.open(); // simulated reboot
  e.db.clearContextExhaustedOnResume("asst-rst");
  e.db.setBusy("asst-rst", true);
  e.watcher.tick(new Date(NOW.getTime() + 600_000));
  check("(11) restart re-mark: the session is re-marked with a new stamp", e.db.getSession("asst-rst").contextExhaustedAt === new Date(NOW.getTime() + 600_000).toISOString());
  check("(11) restart re-mark: still exactly ONE notice", noticesFor(e, "asst-rst").length === 1);
  cleanup(e);
}

// ===== (12) the notice name prefers the Companion's given name, else the agent name =====
{
  const e = makeEnv();
  seedSession(e, "asst-nm", "assistant", REAL_EXHAUSTION_RECORD);
  e.db.upsertCompanionConfig({ sessionId: "asst-nm", botTokenBlob: "x", channel: "telegram", allowedChatId: "1", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: false, name: "  Ember  " });
  e.watcher.tick(NOW);
  const n = noticesFor(e, "asst-nm")[0];
  check("(12) given name wins over the agent name", /^Ember has run out/.test(n?.title ?? "") && !/Juno/.test(n?.title ?? ""));
  cleanup(e);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
