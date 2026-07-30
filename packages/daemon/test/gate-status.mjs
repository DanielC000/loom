import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_status(opId) (card edc1ec12, Platform-Audit finding 7afa6ea9; GENERALIZED by card e3e40167) — a
// status lookup: a caller holding an opId from a `run_gate`/`worker_merge_confirm` {status:"pending"}
// response (or even one that settled INLINE — see below) can check whether that run is still queued,
// actually running (and for how long), or already reached a TERMINAL CLASSIFICATION — WITHOUT waiting for
// the eventual completion nudge, and without that classification ever being confused with "never existed".
//
// card 225bc7bd: `gate_status` used to do an EXACT-match-only lookup, so pasting the 8-char short id Loom
// displays everywhere else silently missed a genuinely LIVE op. Fixed by resolving `opId` as EITHER a full
// id OR an unambiguous prefix, with an ambiguous prefix returning a distinct outcome.
//
// card e3e40167 — THE CENTRAL DEFECT THIS FILE NOW PROVES FIXED: `pending_gate_ops` used to write a durable
// row ONLY for an op that was actually SURFACED PENDING (PendingOpRegistry.attach's `onSurfacedPending`).
// A FAST op — one that settles inline within the sync-attach budget, the COMMON case for a passing gate —
// never surfaced pending, so it NEVER got a row. Once PendingOpRegistry itself evicted it on settle (which
// happens immediately), `gate_status` on that exact opId was INDISTINGUISHABLE from an opId that was NEVER
// MINTED AT ALL — both returned "not_found". The (e2e gate, FAST PATH — the conflation repro) block below
// is the RED-first reproduction: it drives a real fast-settling gate through `runWorkerGate`, then asserts
// its opId reads back as `"settled"`, not the SAME answer a bogus, never-minted opId gets (`"never_existed"`)
// — proving those two are now genuinely distinguishable where they used to collapse into one value.
//
// A SECOND, subtler instance of the SAME defect class was caught in manager review one layer down, at the
// SCOPING boundary: an earlier version of this fix collapsed a SCOPED caller's miss (a stranger querying a
// real op that isn't theirs) into `"never_existed"` too — which is a POSITIVE, and here FALSE, claim that
// the id was never minted at all, when in fact it was minted and the row genuinely exists; the scope filter
// simply hid it from this particular caller. `"unknown"` is the fix: a distinct sixth value that is ALSO
// the sink for a genuinely-bogus id under scoping (so nothing leaks — a stranger can't tell "not yours"
// from "never existed" by the value returned), but is never itself a false non-existence claim the way
// `never_existed` would be. See the "(e2e scope, unknown-sink)" checks below for the side-by-side proof.
//
// Proves:
//   (unit) GateSemaphore.findByOpId locates a RUNNING entry and a QUEUED entry by the FULL opId carried on
//          their GateDescriptor; resolves an unambiguous 8-char PREFIX of a live opId to that SAME entry
//          (the exact false-negative card 225bc7bd fixes); returns kind:"ambiguous" (naming both
//          candidates, never picking one) for a prefix matching two live opIds; returns kind:"none" for an
//          opId with no live entry at all — three DISTINGUISHABLE outcomes, and once settled, the same
//          full opId no longer resolves either (this is only the LIVE-registry half of the picture now —
//          see the e2e tombstone-fallback tests below for what a `kind:"none"` result resolves to next).
//   (e2e)  SessionService.gateStatus, via the REAL runWorkerGate AND confirmWorkerMergeTracked (an
//          injected `runGate` seam controls timing without a real spawn):
//            - "running" while genuinely in-flight (by full id AND by its 8-char prefix), with a plausible
//              elapsedMs — SCOPED to the owning worker/project (a stranger gets "unknown", never a peek at
//              another session's live run; see the "unknown" bullet below for why that's a DIFFERENT value
//              from the genuine-miss "never_existed" two bullets down).
//            - "settled" (never "not_found") once a PENDING-PATH op settles — proving this never surfaces
//              a terminal PASS/FAIL result itself, only the classification, and that a settled op stays
//              positively queryable rather than reverting to a hole.
//            - "settled" for a FAST-PATH op too (the conflation repro above) — the case the original
//              edc1ec12 shape could never distinguish from "never existed".
//            - "never_existed" for a genuinely bogus, never-minted opId queried WITHOUT scoping (the
//              manager path) — a POSITIVE assertion, proven alongside BOTH a real fast-settled op and a
//              real live op in the same run, so it can't be accidentally satisfied by an empty
//              registry/table.
//            - "unknown" — the SIXTH, review-caught value (a scoped caller's miss must NOT collapse into
//              `never_existed`: the op may genuinely exist, just not be theirs, and the scoped candidate-
//              set filter can't tell those two cases apart — see gateStatus's own doc). Proven to be the
//              EXACT SAME answer for a stranger querying a REAL foreign op and a stranger querying a
//              BOGUS one — no existence leak either way, and never a false non-existence claim.
//            - "evicted-dead-owner" / "orphaned-by-restart" for those terminal tombstone states, mapped
//              straight through from the durable row.
//            - "ambiguous" for a prefix matching two TOMBSTONED ops (not just two live ones).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gst-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const GIT_ID = "-c user.email=gst@loom -c user.name=gst";
const now = new Date().toISOString();

// ── (unit) GateSemaphore.findByOpId ──────────────────────────────────────────────────────────────────
{
  const mkHold = () => { let release; const p = new Promise((res) => { release = res; }); return { p, release: (v) => release(v) }; };

  const sem = new GateSemaphore();
  const OP_RUNNING = "ec0f9383-bcd0-498e-9f51-7f5fdd66dd14"; // real-shaped opId (card 225bc7bd's own repro)
  const OP_QUEUED = "b7a1c9de-1111-2222-3333-444455556666";
  const hRunning = mkHold();
  const pRun = sem.runExclusive(1, { gateType: "merge", projectId: "P", sessionId: "s1", opId: OP_RUNNING }, () => hRunning.p);
  const pQueued = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s2", opId: OP_QUEUED }, async () => "second");
  await sleep(20); // let pRun acquire the lane (cap 1) + pQueued queue behind it, never invoking its own fn

  const running = sem.findByOpId(OP_RUNNING);
  check("(unit) findByOpId locates the RUNNING entry by its FULL opId", running.kind === "found" && running.record.phase === "running" && running.record.opId === OP_RUNNING);
  const queued = sem.findByOpId(OP_QUEUED);
  check("(unit) findByOpId locates the QUEUED entry by its FULL opId", queued.kind === "found" && queued.record.phase === "queued" && queued.record.opId === OP_QUEUED);

  // card 225bc7bd's actual bug: an 8-char PREFIX of a live opId used to report "not found" (undefined) —
  // indistinguishable from a settled/nonexistent op — even though the run was genuinely live.
  const prefixHit = sem.findByOpId(OP_RUNNING.slice(0, 8));
  check("(unit) an unambiguous 8-char opId PREFIX resolves to the SAME running entry", prefixHit.kind === "found" && prefixHit.record.opId === OP_RUNNING);
  const prefixHitQueued = sem.findByOpId(OP_QUEUED.slice(0, 8));
  check("(unit) an unambiguous 8-char opId PREFIX also resolves a QUEUED entry", prefixHitQueued.kind === "found" && prefixHitQueued.record.opId === OP_QUEUED);

  // An AMBIGUOUS prefix (matches two distinct live opIds) is a THIRD, distinguishable outcome — must never
  // silently pick one, and must never collapse into "not found" (a miss that can't resolve is a different
  // answer than a miss that means "gone").
  const OP_AMBIG_A = "aaaaaaaa-0001-0000-0000-000000000000";
  const OP_AMBIG_B = "aaaaaaaa-0002-0000-0000-000000000000";
  const hAmbigA = mkHold();
  const pAmbigA = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s3", opId: OP_AMBIG_A }, () => hAmbigA.p);
  const pAmbigB = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s4", opId: OP_AMBIG_B }, async () => "second"); // queues behind A
  await sleep(20);
  const ambiguous = sem.findByOpId("aaaaaaaa");
  check(
    "(unit) a prefix matching TWO live opIds returns kind:\"ambiguous\", naming BOTH candidates",
    ambiguous.kind === "ambiguous" && ambiguous.ids.length === 2 && ambiguous.ids.includes(OP_AMBIG_A) && ambiguous.ids.includes(OP_AMBIG_B),
  );

  const none = sem.findByOpId("deadbeef-0000-0000-0000-000000000000");
  check("(unit) an opId with no match at all returns kind:\"none\" — distinguishable from \"found\" and \"ambiguous\"", none.kind === "none");
  const tooShort = sem.findByOpId(OP_RUNNING.slice(0, 4));
  check("(unit) a ref shorter than the 8-char prefix floor never matches, even against a live op (too short to resolve safely)", tooShort.kind === "none");

  // card fc243a43 — the worker-facing gate_status: `scopeSessionId` filters the CANDIDATE SET itself
  // before prefix resolution, so a caller can never learn anything about another session's live op.
  const ownScoped = sem.findByOpId(OP_RUNNING, "s1");
  check("(unit) scopeSessionId=owner still resolves the entry (own op, full id)", ownScoped.kind === "found" && ownScoped.record.opId === OP_RUNNING);
  const ownScopedPrefix = sem.findByOpId(OP_RUNNING.slice(0, 8), "s1");
  check("(unit) scopeSessionId=owner still resolves the entry (own op, 8-char prefix)", ownScopedPrefix.kind === "found" && ownScopedPrefix.record.opId === OP_RUNNING);
  const foreignScoped = sem.findByOpId(OP_RUNNING, "s2");
  check("(unit) scopeSessionId=non-owner (s2, the OP_QUEUED owner) gets kind:\"none\" for s1's op — never \"found\"", foreignScoped.kind === "none");
  // The ambiguous-prefix pair (OP_AMBIG_A owned by s3, OP_AMBIG_B owned by s4, set up just above) is the
  // key proof: scoped to s3 alone, the SAME prefix that was ambiguous UNSCOPED now resolves UNIQUELY to
  // s3's own op — a scoped caller's ambiguity is computed ONLY over its own ops, so it can never learn
  // that a same-prefix op exists under a session it doesn't own (no count, no ids, not even "ambiguous").
  const ambigScopedToOwner = sem.findByOpId("aaaaaaaa", "s3");
  check("(unit) the SAME ambiguous prefix, scoped to s3, resolves UNIQUELY to s3's own op — never \"ambiguous\"", ambigScopedToOwner.kind === "found" && ambigScopedToOwner.record.opId === OP_AMBIG_A);
  const ambigScopedToNobody = sem.findByOpId("aaaaaaaa", "s-nobody");
  check("(unit) the SAME ambiguous prefix, scoped to a session that owns NEITHER candidate, resolves \"none\"", ambigScopedToNobody.kind === "none");

  hRunning.release("done");
  hAmbigA.release("done");
  await Promise.all([pRun, pQueued, pAmbigA, pAmbigB]);
  check("(unit) once settled, the SAME full opId is no longer found (live-only lookup, never a terminal result)", sem.findByOpId(OP_RUNNING).kind === "none");
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gst\n");
  execSync(`git init -q && git config user.email gst@loom && git config user.name gst && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const dbs = [];
const worktrees = [];
try {
  // ── (e2e, gate kind) sessions.gateStatus reflects a REAL runWorkerGate op's live state ──────────────
  {
    const P = `gst-gate-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    let releaseGate;
    const fakeGate = () => new Promise((res) => { releaseGate = res; });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    // The injected fakeGate never resolves on its own — runWorkerGate genuinely degrades to pending past
    // SYNC_ATTACH_BUDGET_MS (12s, not injectable — same wait every completion-nudge test already pays).
    const first = await sessions.runWorkerGate(workerId);
    check("(e2e gate) degrades to pending past the sync-wait budget", first.settled === false);
    const opId = first.op.opId;

    const status = sessions.gateStatus(opId);
    check("(e2e gate) gate_status reports state:\"running\" while genuinely in flight", status.state === "running" && status.gateType === "worker");
    check("(e2e gate) elapsedMs is a plausible number (at least the sync-wait budget already elapsed)", typeof status.elapsedMs === "number" && status.elapsedMs >= 0);

    // card 225bc7bd's actual bug, reproduced against the REAL MCP-facing method (not just the unit-layer
    // GateSemaphore): the 8-char short id Loom displays for this SAME opId used to report "not_found" —
    // indistinguishable from settled/nonexistent — even though the run was genuinely live.
    const prefixStatus = sessions.gateStatus(opId.slice(0, 8));
    check("(e2e gate) gate_status ALSO resolves an unambiguous 8-char opId PREFIX to the SAME live run", prefixStatus.state === "running" && prefixStatus.gateType === "worker");

    // ── card fc243a43 — the worker-facing gate_status is SCOPED to the caller's own op ─────────────────
    // A second worker in the SAME project, with no gate op of its own, must NOT be able to read the first
    // worker's genuinely-in-flight op — the exact security question the card names as "the entire design
    // question". Proven first at the service layer (sessions.gateStatus's scopeSessionId), then again at
    // the real MCP tool-call boundary below.
    const otherWorkerId = `${P}-wkr-other`;
    db.insertSession({ id: otherWorkerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });

    const ownScoped = sessions.gateStatus(opId, workerId);
    check("(e2e scope) the OWNING worker reads its OWN in-flight op fine (state:\"running\")", ownScoped.state === "running" && ownScoped.gateType === "worker");
    const foreignScoped = sessions.gateStatus(opId, otherWorkerId);
    check("(e2e scope) a DIFFERENT worker in the same project CANNOT read that op by its opId — refused as \"unknown\", never \"running\"", foreignScoped.state === "unknown" && foreignScoped.gateType === null);

    // Same proof again at the ACTUAL MCP tool-call boundary — each worker gets its own buildServer'd
    // surface (mirrors production: sessionId is derived server-side from the URL path, never client-
    // supplied), so this exercises the real registerGateStatus(server, sessions, sessionId) wiring, not
    // just the service method directly.
    const router = new OrchestrationMcpRouter(db, sessions);
    const connect = async (sessionId) => {
      const server = router.buildServer(sessionId, "worker");
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: `gate-status-scope-${sessionId}`, version: "0" });
      await client.connect(clientT);
      return { server, client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
    };

    const owner = await connect(workerId);
    check("(e2e scope, MCP) gate_status IS registered on the worker's own MCP surface", Object.keys(owner.server._registeredTools).includes("gate_status"));
    const ownToolStatus = await owner.call("gate_status", { opId });
    check("(e2e scope, MCP) the owning worker's gate_status tool call reports its OWN op's real state", ownToolStatus.state === "running" && ownToolStatus.gateType === "worker");

    const stranger = await connect(otherWorkerId);
    const strangerToolStatus = await stranger.call("gate_status", { opId });
    check("(e2e scope, MCP) a DIFFERENT worker's gate_status tool call CANNOT read the owner's op — refused as \"unknown\"", strangerToolStatus.state === "unknown" && strangerToolStatus.gateType === null);
    // ...and the same holds for the OWNER's short 8-char prefix — a stranger gets no partial credit either.
    const strangerPrefixStatus = await stranger.call("gate_status", { opId: opId.slice(0, 8) });
    check("(e2e scope, MCP) a stranger ALSO can't resolve the owner's op by its 8-char prefix", strangerPrefixStatus.state === "unknown");

    await owner.client.close();
    await stranger.client.close();

    releaseGate({ passed: true });
    // POLL, don't guess (card 0fa5beef's own anti-pattern — a blind sleep here races the REAL post-settle
    // work runWorkerGate does before the durable row flips to 'settled': a second computeWorktreeGateStamp
    // git call, recordGateTimeoutOutcome, etc. — genuinely variable duration under host load, not a fixed
    // microtask tick). Wait for the durable row to reach its TERMINAL state specifically — "pending" is a
    // real, distinct, non-terminal intermediate the op passes through (minted + surfaced, not yet settled)
    // and must NOT be accepted as "done waiting", or this poll returns before onSettle has actually run.
    const after = await waitUntil(() => {
      const s = sessions.gateStatus(opId);
      return s.state === "settled" ? s : undefined;
    }, { timeoutMs: 10_000, label: "gate op tombstone to reach state:\"settled\" after releaseGate" });
    // card e3e40167 — REWRITTEN (was "not_found"): the durable tombstone survives the settle, so this now
    // POSITIVELY reports "settled" instead of reverting to a hole indistinguishable from never-minted.
    // Still never surfaces the actual pass/fail verdict itself — that's what the [loom:gate-*] nudge is for.
    check("(e2e gate) once settled, gate_status reports \"settled\" (not \"not_found\") — never a terminal PASS/FAIL result of its own", after.state === "settled" && after.gateType === "worker" && after.elapsedMs === null);

    // ── card e3e40167 — the SAME settled op's opId, scoped to a STRANGER, still reads back "unknown", not
    // "settled": the tombstone fallback must inherit gate_status's worker-scoping guarantee (card fc243a43)
    // exactly like the live lookup already does — a settled op surviving indefinitely must never become a
    // wider disclosure surface than the live op it replaced. ─────────────────────────────────────────────
    // NOT "never_existed" — that would be a FALSE positive-nonexistence claim (manager review catch, card
    // e3e40167): the op WAS minted, the row DOES exist, the scope filter merely hid it from this caller. A
    // scoped miss must land in the SAME honest-ambiguity sink a genuinely-bogus id gets — see the
    // side-by-side comparison against a scoped bogus query just below — never a confident "gone" claim.
    const afterForeign = sessions.gateStatus(opId, otherWorkerId);
    check("(e2e scope, tombstone) a stranger STILL cannot learn the owner's op settled — \"unknown\", never \"settled\" or \"never_existed\"", afterForeign.state === "unknown");

    // ── card e3e40167 DoD1/DoD5 — THE CENTRAL CONFLATION REPRO: an UNSCOPED (manager-shaped) query for a
    // genuinely bogus, never-minted opId reads back "never_existed" — but it must be DISTINGUISHABLE from
    // the real settled op right next to it, proving this isn't just "everything after settle looks the
    // same". "never_existed" is only ever safe to return from an UNSCOPED, full-view query (see gateStatus's
    // own doc) — that's what this asserts here; the SCOPED case is proven separately right below. ─────────
    const bogusOpId = "00000000-0000-4000-8000-000000000000";
    const bogus = sessions.gateStatus(bogusOpId);
    check("(e2e conflation repro) an UNSCOPED query for a never-minted opId reads \"never_existed\"", bogus.state === "never_existed" && bogus.gateType === null);
    check("(e2e conflation repro) THE central fix: the real settled op and the bogus never-minted op do NOT collapse to the same answer", after.state !== bogus.state);

    // ── card e3e40167 — MANAGER-CAUGHT REQUIREMENT: a SCOPED query for that SAME bogus opId must land in
    // the identical "unknown" sink a scoped query for the REAL (but foreign) settled op gets — proving the
    // sink genuinely leaks nothing (a stranger can't distinguish "real op, not yours" from "never existed
    // at all" by the VALUE returned) while still never being the POSITIVE "never_existed" claim. ──────────
    const bogusScoped = sessions.gateStatus(bogusOpId, otherWorkerId);
    check("(e2e scope, unknown-sink) a SCOPED query for a never-minted opId ALSO reads \"unknown\", never \"never_existed\"", bogusScoped.state === "unknown");
    check("(e2e scope, unknown-sink) a stranger querying a REAL foreign op and a stranger querying a BOGUS op get the EXACT SAME answer — no existence leak", afterForeign.state === bogusScoped.state);
  }

  // ── (e2e gate, FAST PATH) card e3e40167's central defect, reproduced directly: a gate that settles
  // INLINE (never surfaces pending — the common case for a passing gate) must ALSO stay positively
  // queryable as "settled" afterward, not revert to the SAME "never_existed" a bogus opId gets. The
  // original edc1ec12 shape only ever wrote a durable row via onSurfacedPending, so a fast op's opId was
  // NEVER recorded at all — this is the exact gap that made a fast-settled op indistinguishable from one
  // that was never minted, once PendingOpRegistry itself evicted it (which happens immediately on settle).
  {
    const P = `gst-fast-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-FAST", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-FAST-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // Resolves IMMEDIATELY — well under SYNC_ATTACH_BUDGET_MS, so runWorkerGate settles INLINE and never
    // surfaces pending at all (never calls onSurfacedPending — only onOpMinted + onSettle fire for this op).
    const fastGate = async () => ({ passed: true });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fastGate });

    const result = await sessions.runWorkerGate(workerId);
    check("(e2e gate, fast path) settles INLINE — never degrades to pending", result.settled === true && result.ok === true && result.value.passed === true);
    const fastOpId = result.value.opId;
    check("(e2e gate, fast path) precondition: the settled result carries an opId at all", typeof fastOpId === "string" && fastOpId.length > 0);

    const fastStatus = sessions.gateStatus(fastOpId);
    check("(e2e gate, fast path — THE CENTRAL FIX) a fast-settled op's opId reads \"settled\", not \"never_existed\"", fastStatus.state === "settled" && fastStatus.gateType === "worker");

    const bogusOpId = "11111111-0000-4000-8000-000000000000";
    const bogusStatus = sessions.gateStatus(bogusOpId);
    check("(e2e gate, fast path) a DIFFERENT, never-minted opId — checked in the SAME run — still reads \"never_existed\"", bogusStatus.state === "never_existed");
    check("(e2e gate, fast path) the fast-settled op and the bogus op are DISTINGUISHABLE — the exact conflation this card fixes", fastStatus.state !== bogusStatus.state);

    // Prefix resolution reaches the tombstone fallback too.
    const fastPrefixStatus = sessions.gateStatus(fastOpId.slice(0, 8));
    check("(e2e gate, fast path) an unambiguous 8-char prefix of the settled opId ALSO resolves via the tombstone", fastPrefixStatus.state === "settled");
  }

  // ── (e2e, tombstone terminal states) gate_status maps EVERY pending_gate_ops.state value through —
  // evicted-dead-owner and orphaned-by-restart, not just settled. Drives the DB layer directly (these two
  // states are already proven to be WRITTEN correctly by pending-gate-ops.mjs/merge-confirm-dead-owner-
  // recovery.mjs; this proves gate_status correctly READS them back once written). ──────────────────────
  {
    const P = `gst-terminal-${Date.now()}`;
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-TERMINAL", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "m", startupPrompt: "", position: 0 });
    const mgrId = `${P}-mgr1`;
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    db.insertPendingGateOp({ opId: "evicted-op-1", kind: "merge", key: `merge:${mgrId}`, ownerSessionId: mgrId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true });
    db.evictPendingGateOpDeadOwner("evicted-op-1");
    const evictedStatus = sessions.gateStatus("evicted-op-1");
    check("(e2e terminal states) an evicted-dead-owner tombstone reads back \"evicted-dead-owner\"", evictedStatus.state === "evicted-dead-owner" && evictedStatus.gateType === "merge");

    db.insertPendingGateOp({ opId: "orphaned-op-1", kind: "gate", key: `gate:${mgrId}`, ownerSessionId: mgrId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true });
    db.markPendingGateOpOrphaned("orphaned-op-1");
    const orphanedStatus = sessions.gateStatus("orphaned-op-1");
    check("(e2e terminal states) an orphaned-by-restart tombstone reads back \"orphaned-by-restart\"", orphanedStatus.state === "orphaned-by-restart" && orphanedStatus.gateType === "worker");

    // A row a caller can genuinely observe mid-flight: minted, not yet surfaced/settled (the narrow window
    // before it registers with the live GateSemaphore, or immediately post-restart before the next boot's
    // reconcileOrphanedGateOps sweep runs) — must read as "pending", never collapse to "never_existed"
    // (the op demonstrably EXISTS) or "settled" (no verdict was ever reached).
    db.insertPendingGateOp({ opId: "still-pending-op-1", kind: "gate", key: `gate:${mgrId}-p`, ownerSessionId: mgrId, projectId: P, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
    const stillPendingStatus = sessions.gateStatus("still-pending-op-1");
    check("(e2e terminal states) a minted-but-not-yet-live row reads back \"pending\" — never \"never_existed\"", stillPendingStatus.state === "pending");
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore.findByOpId locates a running/queued entry by its FULL opId or an unambiguous 8-char PREFIX (card 225bc7bd), distinguishes an ambiguous prefix (kind:\"ambiguous\") from no live match at all (kind:\"none\"), and nothing once settled; SessionService.gateStatus (card e3e40167) reports \"running\" (by full id or prefix) with a plausible elapsedMs for a genuinely in-flight gate op, SCOPED so a stranger session/project gets \"unknown\" rather than a peek at another session's live run; falls through to the durable pending_gate_ops tombstone once the live registry is empty and reports \"settled\" for BOTH a pending-path op that surfaced pending before settling AND — THE CENTRAL FIX — a FAST-PATH op that settled inline and never surfaced pending at all (the exact case the original edc1ec12 shape could never distinguish from a never-minted opId); that tombstone fallback is scope-checked identically to the live lookup (a stranger still can't learn a settled op's outcome, reading \"unknown\" rather than \"settled\" OR the false claim \"never_existed\"); \"evicted-dead-owner\" and \"orphaned-by-restart\" map through from their respective tombstone states; a minted-but-not-yet-live row reads \"pending\"; an UNSCOPED (manager-shaped) query for a genuinely bogus, never-minted opId reads \"never_existed\" — a POSITIVE assertion, proven side-by-side with a real settled op in the SAME run so the two are demonstrably NOT the same answer, the exact conflation this card exists to fix — while a SCOPED query for that SAME bogus id lands in \"unknown\" instead, identical to a stranger's query against a real foreign op, so nothing about a real op's existence ever leaks through the sink value."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
