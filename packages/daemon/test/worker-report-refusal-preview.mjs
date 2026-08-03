import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_report(done) REFUSAL PREVIEW test (board card aa4e24ff, defect 1). In-process: drives
// SessionService.workerReport() directly against an isolated LOOM_HOME — NO claude, NO live daemon, NO
// real git on the happy path (sibling of worker-report-pending-guard.mjs, which this file does not
// duplicate — that file covers the REFUSAL DECISION; this one covers the REFUSAL MESSAGE'S WORDING).
//
// THE BUG THIS GUARDS: the refusal error embeds a PREVIEW of each still-queued instruction, truncated to
// 500 chars. The stored `session_message_queued` record's `text` is the FRAMED WIRE TEXT — messageWorker
// prepends `[loom:from-manager]\n` before persisting it — so an unlabelled preview of that text reads as
// a SECOND `[loom:from-manager]` frame wrapping a mid-sentence clip: an impersonation of a real delivery.
// A worker mistook exactly this for the real thing (the incident behind this card). The mechanism was
// never broken — the full body always lands intact at the next turn boundary — only the REFUSAL'S OWN
// RENDERING lied about what it was showing.
//
// Proves:
//   (1) the preview carries a truncated-preview marker AND a will-deliver-at-next-boundary marker
//   (2) the preview does NOT carry the bare `[loom:from-manager]` header (no impersonation)
//   (3) the instruction's own BODY text still appears in the preview (stripping the header must not eat
//       real content)
//   (4) ⭐ the underlying durable record's `text` is BYTE-IDENTICAL before and after the refusal call —
//       proving the refusal builder only computed a local display copy and never touched the record that
//       actually drains as the real delivery. A test that only checks the label would pass on a change
//       that silently stopped delivering; this is the one that would catch that.
//
// Run: 1) build daemon (pnpm build), 2) node test/worker-report-refusal-preview.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrrp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService, frameFromManager, FROM_MANAGER_TAG } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `wrrp-proj-${sfx}`, agentId = `wrrp-ag-${sfx}`, taskId = `wrrp-task-${sfx}`;
const mgrId = `wrrp-mgr-${sfx}`, workerId = `wrrp-wkr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-wrrp-repo-${sfx}`);
const worktreePath = path.join(os.tmpdir(), `loom-wrrp-wt-${sfx}`);
const branch = `loom/wrrp-${sfx}`;

try {
  // worktreePath EXISTS but is NOT a git repo ⇒ the done-precheck's git step fails SAFE to allow, so the
  // pending-direction preview is the sole thing under test.
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  db.insertProject({ id: projId, name: "WRRP", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "WRRP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Seed a queued record with the SAME framing production actually writes — built by calling the real
  // `frameFromManager` helper (the one `messageWorker` itself calls), never a hand-typed
  // `[loom:from-manager]\n...` literal. Hand-typing it here would make this test pass even if
  // `messageWorker`'s own framing (or the regex `FROM_MANAGER_HEADER_RE` strips) ever drifted apart —
  // it would only prove the strip matches ITSELF, not that it matches what production writes (CR
  // follow-up on this card: the original version of this test did exactly that).
  const msgId = randomUUID();
  const realBody = "STOP — the design changed, redo the auth flow against the new schema";
  const framedText = frameFromManager(realBody);
  db.appendEvent({
    id: randomUUID(), ts: now,
    managerSessionId: mgrId, workerSessionId: workerId, taskId,
    kind: "session_message_queued", detail: { msgId, text: framedText, sender: mgrId },
  });

  const before = db.listEvents(mgrId).find((e) => e.kind === "session_message_queued" && e.detail?.msgId === msgId);
  check("(setup) the durable record is seeded with the framed header intact", before.detail.text === framedText);

  const r = await sessions.workerReport(workerId, { status: "done", summary: "I think I'm done" });
  check("(refused) workerReport(done) is refused while the instruction is unconsumed", r.reported === false && r.refused === true);

  check("(1) preview carries the truncated-preview marker",
    r.error.includes("[preview only — full text arrives when you end this turn; do not act on this fragment]"));
  check("(2) preview does NOT carry the bare '[loom:from-manager]' header (no impersonation)",
    !r.error.includes(`[${FROM_MANAGER_TAG}]`));
  check("(3) preview still shows the instruction's real body text",
    r.error.includes(realBody));

  // (4) ⭐ the durable record itself — the thing that actually drains as the real delivery at the next
  // turn boundary — must be untouched. This is the assertion that would fail if a change accidentally
  // mutated the stored record instead of only building a local display copy.
  const after = db.listEvents(mgrId).find((e) => e.kind === "session_message_queued" && e.detail?.msgId === msgId);
  check("(4) the underlying durable record's text is BYTE-IDENTICAL after the refusal (full body still follows)",
    after.detail.text === framedText);
} finally {
  db.close();
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the worker_report(done) refusal's embedded preview marks itself as a truncated preview, drops the impersonating bare [loom:from-manager] header, still shows the real instruction body, and never mutates the underlying durable record the real delivery still drains from."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
