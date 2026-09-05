import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH DEDUPE KEY, BEHAVIOURAL COVERAGE (card `1c51de69`, out of Code Review `f96c209a` on card
// `3a2dac9c` — DoD-1, the substantive item on that card).
//
// THE GAP THIS CLOSES: `3a2dac9c` rebuilt `mergeBatchTracked`'s in-memory dedupe/attach key from each
// candidate's `lineageRootId` (rather than its raw session id) so the key survives a mid-batch recycle of
// the manager OR any candidate — see `buildBatchDedupeKey`'s own doc in sessions/service.ts for the full
// rationale. That change shipped verified by code inspection + the existing 22-file regression suite, but
// NO test exercised the new key end to end.
//
// THE POPULATION POINT (the important part, not the missing test itself): a `packages/daemon/test/` grep
// for `merge-batch:` finds only the DURABLE TOMBSTONE key (gate-status.mjs, pending-ops-registry.mjs) — a
// DIFFERENT, unchanged key — plus one stale comment. None of those files touch the in-memory dedupe key
// this file covers; their green says nothing about it.
//
// HERMETIC: mirrors merge-confirm-worker-lineage-resolve.mjs's fixture shape (predecessor/successor/
// unrelated sessions, no real git needed for the pure key-computation checks) plus that same file's
// "assert registry CARDINALITY, not just a returned opId" pattern for the attach()-level checks.
//
// Proves:
//   (1) STABILITY: `buildBatchDedupeKey` returns the SAME key across a recycle of BOTH the manager and
//       the sole worker candidate — the exact scenario `3a2dac9c` DoD-3 fixed (a raw-id key would differ
//       here and mint a second, concurrent batch op on a retry after a recycle).
//   (2) NON-COLLISION: a genuinely different candidate set (an unrelated worker, same manager) produces a
//       DIFFERENT key — the lineage-rooting doesn't collapse distinct batches into one.
//   (3) CARDINALITY (mirrors merge-confirm-worker-lineage-resolve.mjs's own strongest assertion): actually
//       attach()-ing under the predecessor-computed key, then again under the successor-computed key,
//       leaves EXACTLY ONE "merge" op in the registry — the assertion that actually catches a second mint,
//       not just a returned opId that could coincidentally match.
//   (4) CARDINALITY NEGATIVE CONTROL: attaching under the (3)'s genuinely-different key from (2) DOES
//       mint a second, distinct op — proving check (3) isn't vacuously green because attach() always
//       dedupes regardless of key.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-dedupe-key-lineage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbdk-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService, buildBatchDedupeKey } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 100 });

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mbdk-proj-${sfx}`, agentId = `mbdk-agent-${sfx}`;
const mgrPredId = `mbdk-mgrpred-${sfx}`, mgrSuccId = `mbdk-mgrsucc-${sfx}`;
const wPredId = `mbdk-wpred-${sfx}`, wSuccId = `mbdk-wsucc-${sfx}`;
const unrelatedId = `mbdk-unrelated-${sfx}`;
const someCwd = os.tmpdir();

try {
  db.insertProject({ id: projId, name: "MBDK", repoPath: someCwd, vaultPath: someCwd, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

  // The PREDECESSOR manager — recycled away, row never deleted (mirrors recycleManager's own shape).
  db.insertSession({ id: mgrPredId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: someCwd, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The SUCCESSOR manager — fresh id, `recycledFrom` pointing at the predecessor.
  db.insertSession({ id: mgrSuccId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: someCwd, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: mgrPredId });

  // The PREDECESSOR worker — same shape.
  db.insertSession({ id: wPredId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: someCwd, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrPredId });
  // The SUCCESSOR worker — fresh id, `recycledFrom` pointing at the predecessor, now parented to the
  // successor manager (mirrors reparentLiveWorkers' own shape after a manager recycle).
  db.insertSession({ id: wSuccId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: someCwd, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrSuccId, recycledFrom: wPredId });

  // An UNRELATED worker — no recycledFrom link to anything above — the non-collision control.
  db.insertSession({ id: unrelatedId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: someCwd, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrPredId });

  // ── (1) STABILITY: the real, lineage-rooted key is the SAME across a recycle of BOTH the manager and
  // the sole candidate ──────────────────────────────────────────────────────────────────────────────────
  const key1 = buildBatchDedupeKey(db, mgrPredId, [{ workerSessionId: wPredId }]);
  const key2 = buildBatchDedupeKey(db, mgrSuccId, [{ workerSessionId: wSuccId }]);
  check("(1) buildBatchDedupeKey is STABLE across a recycle of both the manager and the sole candidate", key1 === key2);

  // ── (2) NON-COLLISION: a genuinely different candidate set produces a genuinely different key ────────
  const key3 = buildBatchDedupeKey(db, mgrPredId, [{ workerSessionId: unrelatedId }]);
  check("(2) NON-COLLISION: a different candidate set produces a different key", key1 !== key3);

  // ── (3) CARDINALITY: attach()-ing under the PREDECESSOR-computed key, then again under the
  // SUCCESSOR-computed key, dedupe-hits the SAME op — exactly ONE "merge" op ends up registered ─────────
  void sessions.pendingOps.attach(key1, "merge", mgrPredId, 10, () => new Promise(() => {}));
  await waitUntil(
    () => sessions.pendingOps.peek(key1)?.state === "running",
    { label: "predecessor-keyed batch op observable as running" },
  );
  const zombie = sessions.pendingOps.peek(key1);
  void sessions.pendingOps.attach(key2, "merge", mgrSuccId, 10, () => new Promise(() => {}));
  check("(3) CARDINALITY: attaching under the successor-computed key dedupe-hits the SAME op — exactly ONE merge op exists", sessions.pendingOps.listAllOfKind("merge").length === 1);
  check("(3) …and it's still the SAME real op, not a coincidental opId match", sessions.pendingOps.peek(key2)?.opId === zombie.opId);

  // ── (4) CARDINALITY NEGATIVE CONTROL: attaching under key3 (a genuinely different candidate set) DOES
  // mint a second, distinct op — proving (3)'s green isn't vacuous (attach() dedupes on the KEY, not
  // unconditionally) ───────────────────────────────────────────────────────────────────────────────────
  // `attach()` registers its entry SYNCHRONOUSLY (pending-ops.ts: `this.entries.set` precedes its own
  // first `await`) — no wait needed; the mint is already visible the instant this call returns.
  void sessions.pendingOps.attach(key3, "merge", mgrPredId, 10, () => new Promise(() => {}));
  check("(4) NEGATIVE CONTROL: a different key is NOT dedupe-collapsed into the first op — two distinct ops now exist", sessions.pendingOps.listAllOfKind("merge").length === 2);
} finally {
  db.close();
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `buildBatchDedupeKey`'s lineage-rooted key is STABLE across a recycle of both the owning manager and the sole candidate (the exact scenario a raw-id key would have fractured — verified red against that old shape by hand, outside this file's own run), a genuinely different candidate set produces a genuinely different key (no false collision), and attaching under the predecessor- vs successor-computed key dedupe-hits the SAME registered \"merge\" op (registry cardinality stays at 1) while a truly different key still mints a real second op (cardinality rises to 2) — proving the cardinality check isn't vacuously green."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
