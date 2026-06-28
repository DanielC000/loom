import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Session/run AUDIT LOG — the replayable + diffable timeline over Loom's EXISTING durable record
// (the `orchestration_events` table + `sessions` metadata). HERMETIC + CLAUDE-FREE + NETWORK-FREE, in the
// style of agent-runs-audit.mjs / alert-webhook.mjs: a seeded in-process Db, the pure read model imported
// from dist, AND the REAL buildServer driven by app.inject (every non-db dep stubbed). No new capture
// pipeline is exercised — only reads of what appendEvent / insertSession already persist.
//
// Covers the card DoD:
//   (db)    db.listEventsForSession unions manager+worker touches; db.listChildSessions incl. archived.
//   (model) buildSessionTimeline (one session) + buildWaveTimeline (manager + workers, de-duped) order by
//           ts, number seq 0..n-1, and resolve the actor `sessions` map; a wave picks up a cross-tree
//           worker-keyed event the manager query alone would miss.
//   (diff)  diffTimelines aligns the two streams by signature (LCS → same/added/removed) with an outcome
//           discriminator (worker_report:done vs :blocked) and reports per-kind count deltas.
//   (rest)  GET /api/audit/session/:id, /api/audit/wave/:managerId, /api/audit/diff (explicit b + the
//           predecessor-resolution form), with the right 404s/400s. HUMAN/loopback, no Bearer.
// Run: 1) build (turbo builds shared first), 2) node test/audit-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-auditlog-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45396";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { buildSessionTimeline, buildWaveTimeline, diffTimelines, signatureOf } = await import("../dist/sessions/audit.js");

const now = Date.now();
const ts = (n) => new Date(now + n * 1000).toISOString(); // strictly-increasing ISO instants

try {
  const db = new Db(path.join(tmpHome, "audit.db"));
  db.insertProject({ id: "p1", name: "Proj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: ts(0), archivedAt: null });
  db.insertAgent({ id: "aLead", projectId: "p1", name: "Lead", startupPrompt: "", position: 0 });
  db.insertAgent({ id: "aDev", projectId: "p1", name: "Dev", startupPrompt: "", position: 1 });

  const mkSession = (id, role, extra = {}) => db.insertSession({
    id, projectId: "p1", agentId: extra.agentId ?? "aLead", engineSessionId: null, title: extra.title ?? null,
    cwd: tmpHome, processState: "exited", resumability: "unknown", busy: false,
    createdAt: ts(0), lastActivity: ts(0), lastError: null, role,
    parentSessionId: extra.parentSessionId ?? null, taskId: extra.taskId ?? null,
    gen: extra.gen ?? 0, recycledFrom: extra.recycledFrom ?? null, archivedAt: extra.archivedAt ?? null,
  });

  // The CURRENT wave: manager m1 (recycled from m0) + workers w1, w2 (w2 archived → still part of history).
  mkSession("m0", "manager", { gen: 0 });
  mkSession("m1", "manager", { gen: 1, recycledFrom: "m0" });
  mkSession("w1", "worker", { agentId: "aDev", parentSessionId: "m1", taskId: "t1", title: "feat A" });
  mkSession("w2", "worker", { agentId: "aDev", parentSessionId: "m1", taskId: "t2", title: "feat B", archivedAt: ts(9) });
  mkSession("w0", "worker", { agentId: "aDev", parentSessionId: "m0", taskId: "t1", title: "feat A (gen0)" });
  mkSession("pLead", "platform", {}); // a cross-tree sender (Platform Lead)

  const ev = (id, ms, kind, manager, worker, taskId, detail) =>
    db.appendEvent({ id, ts: ts(ms), managerSessionId: manager, workerSessionId: worker, taskId, kind, detail });

  // m1 wave — manager-keyed events (the replay of the current run).
  ev("e1", 1, "spawn_worker", "m1", "w1", "t1", { branch: "loom/t1" });
  ev("e2", 2, "message_worker", "m1", "w1", "t1", { text: "tighten the gate" });
  ev("e3", 3, "worker_report", "m1", "w1", "t1", { status: "done", summary: "landed" });
  ev("e4", 4, "merge_request", "m1", "w1", "t1", {});
  ev("e5", 5, "merge_done", "m1", "w1", "t1", { sha: "abc123" });
  ev("e6", 6, "spawn_worker", "m1", "w2", "t2", { branch: "loom/t2" });
  ev("e7", 7, "worker_report", "m1", "w2", "t2", { status: "blocked", summary: "needs a decision" });
  // A CROSS-TREE worker-keyed event: a Platform Lead message TO w1 (manager field = pLead, NOT m1). The
  // wave union must pick this up via w1, even though listEvents(m1) alone would miss it.
  ev("e8", 8, "session_message", "pLead", "w1", null, { text: "fyi" });

  // m0 wave — the PREDECESSOR run (a different outcome: the merge was rejected, no second worker).
  ev("f1", 1, "spawn_worker", "m0", "w0", "t1", { branch: "loom/t1" });
  ev("f2", 2, "worker_report", "m0", "w0", "t1", { status: "done", summary: "landed" });
  ev("f3", 3, "merge_request", "m0", "w0", "t1", {});
  ev("f4", 4, "merge_rejected", "m0", "w0", "t1", { reason: "build red" });

  // =====================================================================================================
  // (db) the new read primitives
  // =====================================================================================================
  const m1Touches = db.listEventsForSession("m1");
  check("(db) listEventsForSession(m1) returns the 7 manager-keyed events", m1Touches.length === 7);
  const w1Touches = db.listEventsForSession("w1");
  check("(db) listEventsForSession(w1) unions manager+worker touches incl. the cross-tree send (6)",
    w1Touches.length === 6 && w1Touches.some((e) => e.id === "e8"));
  const kids = db.listChildSessions("m1");
  check("(db) listChildSessions(m1) includes the ARCHIVED worker w2 (full history, not the rail feed)",
    kids.length === 2 && kids.some((s) => s.id === "w2"));

  // =====================================================================================================
  // (model) buildSessionTimeline / buildWaveTimeline — ordering, seq, actor map, the wave union
  // =====================================================================================================
  const m1Session = buildSessionTimeline(db, "m1");
  check("(model) session timeline scope/rootId", m1Session.scope === "session" && m1Session.rootId === "m1");
  check("(model) session timeline has the 7 manager events, ts-ordered", m1Session.eventCount === 7
    && m1Session.events.every((e, i) => i === 0 || e.ts >= m1Session.events[i - 1].ts));
  check("(model) seq is a dense 0..n-1 replay index", m1Session.events.every((e, i) => e.seq === i));
  check("(model) firstTs/lastTs span the timeline", m1Session.firstTs === m1Session.events[0].ts
    && m1Session.lastTs === m1Session.events[6].ts);
  check("(model) actor map resolves referenced sessions with role+lineage",
    m1Session.sessions.m1?.role === "manager" && m1Session.sessions.w1?.parentSessionId === "m1" && m1Session.sessions.w1?.taskId === "t1");

  const w1Session = buildSessionTimeline(db, "w1");
  check("(model) w1 session timeline includes the cross-tree send + resolves the pLead actor",
    w1Session.eventCount === 6 && w1Session.events.some((e) => e.id === "e8") && w1Session.sessions.pLead?.role === "platform");

  const wave = buildWaveTimeline(db, "m1");
  check("(model) wave scope/rootId", wave.scope === "wave" && wave.rootId === "m1");
  check("(model) wave de-dups to 8 events (7 manager + the 1 cross-tree worker-keyed)", wave.eventCount === 8);
  check("(model) wave picks up the worker-keyed event the manager query misses", wave.events.some((e) => e.id === "e8"));
  check("(model) wave actor map spans m1, w1, w2, pLead",
    ["m1", "w1", "w2", "pLead"].every((id) => wave.sessions[id]));
  check("(model) wave events have a dense seq + ts order", wave.events.every((e, i) => e.seq === i)
    && wave.events.every((e, i) => i === 0 || e.ts >= wave.events[i - 1].ts));

  check("(model) buildSessionTimeline returns null for an unknown session", buildSessionTimeline(db, "nope") === null);
  check("(model) buildWaveTimeline returns null for an unknown manager", buildWaveTimeline(db, "nope") === null);

  // signature discriminator
  check("(model) signatureOf folds the outcome discriminator into the kind",
    signatureOf({ kind: "worker_report", detail: { status: "done" } }) === "worker_report:done"
    && signatureOf({ kind: "merge_done", detail: null }) === "merge_done");

  // =====================================================================================================
  // (diff) diffTimelines — sequence alignment (LCS) + per-kind outcome deltas
  // =====================================================================================================
  const m0Session = buildSessionTimeline(db, "m0");
  const diff = diffTimelines(m1Session, m0Session); // a = current (m1), b = predecessor (m0)
  check("(diff) a/b headers carry rootId/scope/eventCount", diff.a.rootId === "m1" && diff.a.eventCount === 7
    && diff.b.rootId === "m0" && diff.b.eventCount === 4);
  // Common subsequence: spawn_worker, worker_report:done, merge_request (3).
  check("(diff) LCS finds the 3 common steps", diff.summary.sameCount === 3);
  check("(diff) summary.changed is true (the runs diverge)", diff.summary.changed === true);
  check("(diff) merge_done is a REMOVED step (only in a=m1)",
    diff.steps.some((s) => s.op === "removed" && s.signature === "merge_done" && s.a?.kind === "merge_done" && s.b === null));
  // merge_rejected carries detail.reason, so its signature folds in the reason discriminator ("merge_rejected:build red").
  check("(diff) merge_rejected is an ADDED step (only in b=m0), signature carries the reason discriminator",
    diff.steps.some((s) => s.op === "added" && s.signature === "merge_rejected:build red" && s.b?.kind === "merge_rejected" && s.a === null));
  check("(diff) the changed worker_report outcome aligns by discriminator (:blocked is removed)",
    diff.steps.some((s) => s.op === "removed" && s.signature === "worker_report:blocked"));
  const md = (k) => diff.kindDeltas.find((d) => d.kind === k);
  check("(diff) kindDeltas: merge_done a:1 b:0 delta:-1", md("merge_done")?.a === 1 && md("merge_done")?.b === 0 && md("merge_done")?.delta === -1);
  check("(diff) kindDeltas: merge_rejected a:0 b:1 delta:+1", md("merge_rejected")?.a === 0 && md("merge_rejected")?.b === 1 && md("merge_rejected")?.delta === 1);
  check("(diff) kindDeltas: spawn_worker a:2 b:1 delta:-1", md("spawn_worker")?.a === 2 && md("spawn_worker")?.b === 1 && md("spawn_worker")?.delta === -1);
  check("(diff) kindDeltas are sorted by kind", diff.kindDeltas.every((d, i) => i === 0 || d.kind >= diff.kindDeltas[i - 1].kind));
  // An IDENTICAL diff (a timeline vs itself) reports no change.
  const same = diffTimelines(m1Session, m1Session);
  check("(diff) a timeline diffed against itself is unchanged", same.summary.changed === false
    && same.summary.addedCount === 0 && same.summary.removedCount === 0 && same.summary.sameCount === 7);

  // =====================================================================================================
  // (rest) the human-only loopback readers (no Bearer)
  // =====================================================================================================
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const rSession = await app.inject({ method: "GET", url: "/api/audit/session/w1" });
  check("(rest) GET /api/audit/session/:id → 200 WITHOUT a Bearer", rSession.statusCode === 200);
  check("(rest) session reader returns the timeline shape", rSession.json().scope === "session" && rSession.json().eventCount === 6);

  const rWave = await app.inject({ method: "GET", url: "/api/audit/wave/m1" });
  check("(rest) GET /api/audit/wave/:managerId → 200 with the 8-event wave", rWave.statusCode === 200
    && rWave.json().scope === "wave" && rWave.json().eventCount === 8);

  const rUnknownS = await app.inject({ method: "GET", url: "/api/audit/session/nope" });
  check("(rest) unknown session → 404", rUnknownS.statusCode === 404);
  const rUnknownW = await app.inject({ method: "GET", url: "/api/audit/wave/nope" });
  check("(rest) unknown wave manager → 404", rUnknownW.statusCode === 404);

  // diff — explicit b
  const rDiff = await app.inject({ method: "GET", url: "/api/audit/diff?a=m1&b=m0&scope=session" });
  check("(rest) GET /api/audit/diff?a&b → 200 with the diff", rDiff.statusCode === 200
    && rDiff.json().summary.sameCount === 3 && rDiff.json().summary.changed === true);
  check("(rest) diff a/b match the requested roots", rDiff.json().a.rootId === "m1" && rDiff.json().b.rootId === "m0");

  // diff — PREDECESSOR resolution (b omitted → a's recycledFrom)
  const rPred = await app.inject({ method: "GET", url: "/api/audit/diff?a=m1" });
  check("(rest) diff with b omitted resolves the predecessor (m1.recycledFrom = m0)",
    rPred.statusCode === 200 && rPred.json().b.rootId === "m0" && rPred.json().a.rootId === "m1");

  // diff — error cases
  const rNoPred = await app.inject({ method: "GET", url: "/api/audit/diff?a=m0" });
  check("(rest) diff with no b AND no predecessor → 400", rNoPred.statusCode === 400);
  const rNoA = await app.inject({ method: "GET", url: "/api/audit/diff" });
  check("(rest) diff with no 'a' → 400", rNoA.statusCode === 400);
  const rBadA = await app.inject({ method: "GET", url: "/api/audit/diff?a=nope&b=m0" });
  check("(rest) diff with an unknown 'a' → 404", rBadA.statusCode === 404);
  const rBadB = await app.inject({ method: "GET", url: "/api/audit/diff?a=m1&b=nope" });
  check("(rest) diff with an unknown 'b' → 404", rBadB.statusCode === 404);

  // diff at WAVE scope works too (m1 wave vs m0 wave)
  const rWaveDiff = await app.inject({ method: "GET", url: "/api/audit/diff?a=m1&b=m0&scope=wave" });
  check("(rest) diff scope=wave compares the two waves", rWaveDiff.statusCode === 200
    && rWaveDiff.json().a.scope === "wave" && rWaveDiff.json().b.scope === "wave");

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Audit log: a replayable per-session + per-wave event timeline over the existing orchestration_events + sessions store (ts-ordered, seq-indexed, actor map; the wave union picks up cross-tree worker-keyed events), a structured LCS+kind-delta diff (with outcome discriminators and predecessor resolution), and the human-only loopback REST readers (session/wave/diff) with the right 404s/400s — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
