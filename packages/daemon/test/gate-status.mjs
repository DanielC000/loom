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
// card 4c5bf820 — SETTLED VERDICT: for a settled "gate" (worker self-check) op specifically, `gate_status`
// NO LONGER stops at the bare classification — it now ALSO reports the recorded verdict (passed/reason/
// durationMs/validatedHead/headWarning/steps/outputTail/gateDetail), reusing the SAME tombstone row this
// file already proves survives settle. The "(e2e gate, SETTLED VERDICT, PASS/FAIL)" blocks below prove: a
// real settled PASS/FAIL is readable via `gate_status` ALONE, with no nudge ever read in either test — the
// DoD-4 regression this card exists to close (a passing self-check used to retain NOTHING beyond a bare
// "gate passed" string).
//
// card 9f6598dd — WIDENS THE ABOVE TO THE "merge" KIND (Finding 1): a settled "merge" op used to be
// GENUINELY unchanged by 4c5bf820 — its onSettle call site never passed a verdict at all, so `gate_status`
// on a settled merge op returned `{state:"settled",gateType:"merge",elapsedMs:null,idleMs:null}` and
// NOTHING else — no outcome, no duration, no extended flag. The "(e2e merge, card 9f6598dd — SETTLED
// VERDICT, PASS/FAIL)" blocks below prove the fix through the REAL `confirmWorkerMergeTracked` (not the DB
// layer directly): `outcome` ("pass"/"fail"), `admittedAt`/`settledAt`/`totalDurationMs` (the REAL total op
// wall time, not just the gate step's own `Σ(steps)` floor), and `extended` (whether the gate run ever
// consumed its one-time auto-extend — proven via an injected `hooks.onExtend()` seam, not a real slow
// timeout) — all asserted ONLY AFTER the op has genuinely left `PendingOpRegistry`'s own short-lived
// retained view (`peekPendingMerge` reverts to `undefined`), which is the entire point of DoD item 5: a
// record read while still `running`/retained proves nothing this card is about. A NEGATIVE CONTROL
// (gateless project) proves `extended` is `undefined`, never a fabricated `false`, when no gate ever
// spawned at all — distinguishing that from "spawned, never extended" (the fail-block's case). The
// "(e2e, tombstone terminal states)" block below still separately proves a "merge" row's OTHER terminal
// states (evicted-dead-owner) map through correctly, unaffected by this card.
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
//            - "settled" (never "not_found") once a PENDING-PATH op settles, and that a settled op stays
//              positively queryable rather than reverting to a hole; for a "gate" row specifically (card
//              4c5bf820), ALSO the recorded pass/fail verdict itself — see the header comment above.
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

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gst-home-${Date.now()}-${process.pid}`);
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

// Card e082bf4d (p2, on this project's board): confirmWorkerMergeTracked can LEGITIMATELY exceed
// SYNC_ATTACH_BUDGET_MS under CPU contention and degrade to the async `{settled:false, op}` pending
// path instead of settling inline — documented, expected production behavior, reproduced 1/10 under
// 24x host oversubscription. The three "(e2e merge …)" blocks below verify that the PERSISTED RECORD
// survives the op leaving the live registry, regardless of WHICH path got it there — the inline-ness is
// incidental to the ASSERTION. This helper accepts EITHER shape: on the fast path it hands back
// `r.value` unchanged; on the async path it polls `gate_status(opId)` until the op reaches `"settled"`
// (the SAME durable tombstone read the rest of each block already relies on) before handing back its
// opId. It relaxes ONLY which path gets a caller to a settled opId — every assertion made AFTER this
// call (outcome, admittedAt/settledAt/totalDurationMs, extended) stays exactly as strict as before,
// unconditional on which path fired.
//
// RECORD THE FACT, DON'T JUST TOLERATE IT (manager refinement, peer-caught): accepting either path
// silently would make the inline path UNFALSIFIABLE — if confirmWorkerMergeTracked degraded to
// ALWAYS-async tomorrow, this test would stay green forever with nothing to notice. Every call logs a
// single greppable `[settle-path]` line naming WHICH path actually fired, unconditionally (inline case
// included) — a real behavioural shift then shows up in the run log even though it can never fail the
// build on environmental timing. Mirrors this project's own `evt("build_gate", …)` discipline (fires
// BEFORE the pass/fail branch, which is what made 613 duration rows — including every rejected run —
// recoverable after the fact): record what happened regardless of outcome.
async function settleMergeEitherPath(sessions, r, label) {
  if (r.settled) {
    console.log(`[settle-path] (${label}) inline — confirmWorkerMergeTracked settled within SYNC_ATTACH_BUDGET_MS`);
    return { opId: r.value.opId, value: r.value, viaAsync: false };
  }
  check(`(${label}) precondition: the async pending path hands back a real opId to track`, typeof r.op?.opId === "string" && r.op.opId.length > 0);
  const opId = r.op.opId;
  await waitUntil(() => (sessions.gateStatus(opId).state === "settled" ? true : undefined), { timeoutMs: 20_000, label: `${label}: async merge op to settle` });
  console.log(`[settle-path] (${label}) async — confirmWorkerMergeTracked exceeded SYNC_ATTACH_BUDGET_MS (card e082bf4d — CPU contention), degraded to {status:"pending"}; inline-only checks skipped for this run, every other assertion still runs at full strictness`);
  return { opId, value: undefined, viaAsync: true };
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

    // DETERMINISTIC SYNC (manager finding, DIRECTIVE #1 on card 63bdd2cc): runWorkerGate awaits a REAL git
    // call (computeWorktreeGateStamp) BEFORE it ever invokes the injected runGate/fakeGate — a genuine
    // async gap this test never synchronized on, previously masked by the old 12s budget (that real git
    // call always finished well inside 12s, so fakeGate had always already run by the time this test
    // reached `releaseGate(...)` below). Shrinking the budget to 300ms exposed the race for real:
    // `releaseGate` could still be undefined here. Fixed at the source — wait for PROOF fakeGate was
    // entered (gateEnteredP), not for a budget to elapse — robust at ANY budget, per card c062a307.
    let releaseGate, gateEntered;
    const gateEnteredP = new Promise((r) => { gateEntered = r; });
    const fakeGate = () => new Promise((res) => { releaseGate = res; gateEntered(); });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // TUNABLE-FAST (card 63bdd2cc): the injected fakeGate never resolves on its own — no real subprocess
    // is involved here at all (unlike the completion-nudge tests, which need a REAL gate for realism) — so
    // there is zero realism cost to shrinking the sync-wait budget via the `syncAttachBudgetMs` DI seam
    // (card 0faaaa55). runWorkerGate still genuinely degrades to pending, just against a much smaller wait.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: 300 });

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

    await gateEnteredP; // the gate is provably entered; releaseGate is assigned — no race on the budget
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

  // ── (e2e gate, card 4c5bf820 — SETTLED VERDICT, PASS) THE central DoD-4 regression: a settled PASS is
  // readable via gate_status with NO nudge involved at all. `ptyStub.enqueueStdin` below is a bare no-op —
  // nothing is ever captured or read from it in this block; every assertion is derived ONLY from
  // `sessions.gateStatus(opId)`, proving the verdict is recoverable independent of whether any nudge was
  // ever delivered, read, or even inspectable. ──────────────────────────────────────────────────────────
  {
    const P = `gst-verdict-pass-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-VERDICT-PASS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-VERDICT-PASS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // A rich, real-shaped GateSequentialResult — this is what runGateSequential actually returns on a
    // green run post-card-4c5bf820 (steps + outputTail both populated, not just `{passed:true}`).
    const richPassGate = async () => ({ passed: true, steps: [{ step: "pnpm test", durationMs: 4200, status: 0 }], outputTail: "42 passed, 0 failed" });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: richPassGate });

    const result = await sessions.runWorkerGate(workerId);
    check("(e2e verdict pass) settles INLINE, passed:true, and the sync result already carries steps/outputTail", result.settled === true && result.ok === true && result.value.passed === true && result.value.steps?.length === 1 && result.value.outputTail === "42 passed, 0 failed");
    const opId = result.value.opId;

    const status = sessions.gateStatus(opId);
    check("(e2e verdict pass — THE FIX) gate_status alone reports passed:true for a settled PASS, no nudge read anywhere in this test", status.state === "settled" && status.passed === true);
    check("(e2e verdict pass) durationMs is a real non-negative number", typeof status.durationMs === "number" && status.durationMs >= 0);
    check("(e2e verdict pass) validatedHead is set (the worktree's real HEAD sha)", typeof status.validatedHead === "string" && status.validatedHead.length > 0);
    check("(e2e verdict pass) steps round-trips through the tombstone", Array.isArray(status.steps) && status.steps.length === 1 && status.steps[0].step === "pnpm test");
    check("(e2e verdict pass) outputTail round-trips through the tombstone — the DoD item 2 fix: a passing gate used to retain NOTHING here", status.outputTail === "42 passed, 0 failed");
    check("(e2e verdict pass) cancelled/reason/gateDetail are all absent (never a fabricated value for fields that don't apply to a pass)", status.cancelled === undefined && status.reason === undefined && status.gateDetail === undefined);
  }

  // ── (e2e gate, card 4c5bf820 — SETTLED VERDICT, FAIL) same regression, the failure side: reason +
  // gateDetail (the SAME rich diagnosis the [loom:gate-failed] nudge carries) are ALSO readable via
  // gate_status alone, with no nudge read. ─────────────────────────────────────────────────────────────
  {
    const P = `gst-verdict-fail-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-VERDICT-FAIL", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-VERDICT-FAIL-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const richFailGate = async () => ({
      passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false,
      outputTail: "FAIL  some_test.mjs", failingTest: "some_test.mjs",
      steps: [{ step: "pnpm test", durationMs: 900, status: 1 }],
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: richFailGate });

    const result = await sessions.runWorkerGate(workerId);
    check("(e2e verdict fail) settles INLINE, passed:false", result.settled === true && result.ok === true && result.value.passed === false);
    const opId = result.value.opId;

    const status = sessions.gateStatus(opId);
    check("(e2e verdict fail — THE FIX) gate_status alone reports passed:false for a settled FAIL, no nudge read anywhere in this test", status.state === "settled" && status.passed === false);
    check("(e2e verdict fail) reason is the real headline (\"build gate failed\")", status.reason === "build gate failed");
    check("(e2e verdict fail) gateDetail carries the SAME rich diagnosis the failure nudge embeds", status.gateDetail?.failedStep === "pnpm test" && status.gateDetail?.failingTest === "some_test.mjs" && status.gateDetail?.exitCode === 1);
    check("(e2e verdict fail) steps/outputTail are ALSO present on the fail path (parity with pass)", Array.isArray(status.steps) && status.steps.length === 1 && status.outputTail === "FAIL  some_test.mjs");
    check("(e2e verdict fail) cancelled is absent — a real failure must never read as a cancel", status.cancelled === undefined);
  }

  // ── (e2e merge, card 9f6598dd — SETTLED VERDICT, PASS + extended, AND retention past registry eviction)
  // Finding 1's exact repro: BEFORE this card, `gate_status` on a settled "merge" op returned
  // {state:"settled",gateType:"merge",elapsedMs:null,idleMs:null} — nothing else, because the merge-kind
  // onSettle call site never passed a verdict at all. This proves the fix end-to-end through the REAL
  // confirmWorkerMergeTracked (not the DB layer directly), driven by an injected `runGate` seam that ALSO
  // fires `hooks.onExtend()` — proving the `anyExtended`/`gateExtended` wiring threads all the way from
  // gate-runner's own liveness hook to the persisted `extended` field, without a slow real timeout. THE
  // WHOLE POINT (card DoD item 5): asserted only AFTER `peekPendingMerge` reverts to `undefined` — i.e.
  // after the op has genuinely LEFT PendingOpRegistry's own retained live view (MERGE_OP_RETAIN_MS), not
  // while it's still `running` or sitting in that short-lived cache. Reading it mid-flight would prove
  // nothing this card is about. ─────────────────────────────────────────────────────────────────────────
  {
    const P = `gst-mverdict-pass-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-MVERDICT-PASS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`, mgrId = `${P}-mgr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-MVERDICT-PASS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // Fires `hooks.onExtend()` before resolving green — the SAME liveness hook gate-runner.ts's own
    // runGateStep calls on a real auto-extend, exercising confirmWorkerMerge's mirroring wrapper without
    // a real slow timeout (gate-timeout-extend.mjs already proves the underlying extend MECHANISM; this
    // proves the WIRING from that hook to the persisted record).
    const richPassGateExtended = async (_gate, _cwd, _timeoutMs, _runStep, _env, _allowExtend, _cancelSignal, hooks) => {
      hooks?.onExtend?.();
      return { passed: true, steps: [{ step: "pnpm gate", durationMs: 4200, status: 0 }], outputTail: "ok" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: richPassGateExtended });

    const t0 = Date.now();
    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    // Card e082bf4d: accept EITHER the inline OR the async pending path — see settleMergeEitherPath's own
    // doc. The inline-only checks below fire ONLY when this run actually settled inline; the eviction +
    // gate_status checks that follow run unconditionally, at full strictness, either way.
    const { opId, value, viaAsync } = await settleMergeEitherPath(sessions, r, "e2e merge verdict pass");
    if (!viaAsync) {
      check("(e2e merge verdict pass) settled INLINE this run, merged:true", r.ok === true && value.merged === true);
      check("(e2e merge verdict pass) the sync result ALREADY carries gateExtended:true (the wiring this card adds)", value.gateExtended === true);
    }

    // Wait for the op to genuinely LEAVE the live retained view — see the block header above for why this
    // is the whole point, not incidental.
    await waitUntil(() => (sessions.peekPendingMerge(workerId) === undefined ? true : undefined), { timeoutMs: 10_000, label: "merge op to leave PendingOpRegistry's retained view" });

    const status = sessions.gateStatus(opId);
    check("(e2e merge verdict pass — THE FIX) gate_status alone reports outcome:\"pass\" for a settled merge, past eviction, no nudge read anywhere in this test", status.state === "settled" && status.outcome === "pass");
    check("(e2e merge verdict pass) admittedAt is a real ISO timestamp no earlier than this test's own start", typeof status.admittedAt === "string" && Date.parse(status.admittedAt) >= t0 - 1000);
    check("(e2e merge verdict pass) settledAt is a real ISO timestamp at/after admittedAt", typeof status.settledAt === "string" && Date.parse(status.settledAt) >= Date.parse(status.admittedAt));
    check("(e2e merge verdict pass) totalDurationMs is a real non-negative number, settledAt - admittedAt", typeof status.totalDurationMs === "number" && status.totalDurationMs >= 0 && status.totalDurationMs === Date.parse(status.settledAt) - Date.parse(status.admittedAt));
    check("(e2e merge verdict pass — THE WIRING) extended:true round-trips through the tombstone, from the SAME onExtend hook gate-runner.ts itself calls", status.extended === true);
    // Card a1a8c5c4: BEFORE this card a PASSING merge gate's output was persisted NOWHERE — not this
    // tombstone, not orchestration_events, not even the ephemeral pty text (only a REJECTION ever printed
    // a tail). `richPassGateExtended` above already stubs `outputTail: "ok"` on its green return — this is
    // the exact value that used to be silently discarded the moment `confirmWorkerMerge` saw `passed:true`.
    check("(e2e merge verdict pass — a1a8c5c4 FIX) outputTail round-trips through the tombstone — a passing MERGE gate used to retain NO output of its own before this card", status.outputTail === "ok");
  }

  // ── (e2e merge, card 9f6598dd — SETTLED VERDICT, FAIL) the rejection side: outcome:"fail" + gateDetail
  // (the SAME rich diagnosis the [loom:merge-rejected] nudge carries) are ALSO readable via gate_status
  // alone, past eviction — AND `extended` stays `false` (not `undefined`) here: the gate DID spawn, it
  // just never called onExtend, so "spawned, never extended" must be distinguishable from "never spawned
  // at all" (proven by the NEXT block's negative control). ────────────────────────────────────────────
  {
    const P = `gst-mverdict-fail-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-MVERDICT-FAIL", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`, mgrId = `${P}-mgr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-MVERDICT-FAIL-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const richFailGate = async () => ({
      passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false,
      outputTail: "FAIL  some_test.mjs", failingTest: "some_test.mjs",
      steps: [{ step: "pnpm gate", durationMs: 900, status: 1 }],
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: richFailGate });

    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    // Card e082bf4d: accept EITHER settlement path — see settleMergeEitherPath's own doc.
    const { opId, value, viaAsync } = await settleMergeEitherPath(sessions, r, "e2e merge verdict fail");
    if (!viaAsync) {
      check("(e2e merge verdict fail) settled INLINE this run, merged:false", r.ok === true && value.merged === false);
    }

    await waitUntil(() => (sessions.peekPendingMerge(workerId) === undefined ? true : undefined), { timeoutMs: 10_000, label: "merge op to leave PendingOpRegistry's retained view" });

    const status = sessions.gateStatus(opId);
    check("(e2e merge verdict fail — THE FIX) gate_status alone reports outcome:\"fail\" for a settled rejected merge, past eviction", status.state === "settled" && status.outcome === "fail");
    check("(e2e merge verdict fail) gateDetail carries the SAME rich diagnosis the [loom:merge-rejected] nudge embeds", status.gateDetail?.failedStep === "pnpm gate" && status.gateDetail?.failingTest === "some_test.mjs" && status.gateDetail?.exitCode === 1);
    // Card 361520a0, Half Three: `gateDetail.stderrTail`/`.steps` used to be silently dropped here (present
    // on the SYNC ConfirmMergeResult and in the pty notify text, but never persisted into the durable
    // verdict payload gate_status/gate_history read) — the exact "carries no tail" gap the card measured.
    check("(e2e merge verdict fail — HALF THREE) gate_status ALSO carries the stderr tail — previously dropped here", status.gateDetail?.stderrTail === "FAIL  some_test.mjs");
    check("(e2e merge verdict fail — HALF THREE) gate_status ALSO carries per-step durations — previously dropped here", Array.isArray(status.gateDetail?.steps) && status.gateDetail.steps.length === 1 && status.gateDetail.steps[0].step === "pnpm gate" && status.gateDetail.steps[0].durationMs === 900);
    check("(e2e merge verdict fail) extended is false (spawned, never extended) — NOT undefined (a distinct claim from \"never spawned\", see the negative control below)", status.extended === false);
    check("(e2e merge verdict fail) admittedAt/settledAt/totalDurationMs are ALL present on the fail path too (parity with pass)", typeof status.admittedAt === "string" && typeof status.settledAt === "string" && typeof status.totalDurationMs === "number");
    // Card a1a8c5c4: outputTail is now a TOP-LEVEL field on both outcomes (mirroring the sibling "gate"
    // kind since 4c5bf820) — distinct from `gateDetail.stderrTail`, which already carried this same text
    // on the fail path before this card. The FAIL side isn't the gap this card closes (a rejection already
    // had SOME durable trace via the pty notify text) — this just proves parity now that PASS has one too.
    check("(e2e merge verdict fail — a1a8c5c4) outputTail is ALSO present as a top-level field (parity with pass)", status.outputTail === "FAIL  some_test.mjs");
  }

  // ── (e2e merge, card 9f6598dd — NEGATIVE CONTROL) a GATELESS project's merge never spawns a gate at
  // all — `extended` must be ABSENT (undefined), never a fabricated `false`, distinguishing "no gate ran"
  // from "a gate ran and never extended" (the block above). Without this control, `extended === false`
  // would be ambiguous between the two. ─────────────────────────────────────────────────────────────────
  {
    const P = `gst-mverdict-nogate-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST-MVERDICT-NOGATE", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null }); // no gateCommand
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`, mgrId = `${P}-mgr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-MVERDICT-NOGATE-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    // Card e082bf4d: accept EITHER settlement path — see settleMergeEitherPath's own doc.
    const { opId, value, viaAsync } = await settleMergeEitherPath(sessions, r, "e2e merge negative control");
    if (!viaAsync) {
      check("(e2e merge negative control) precondition: a gateless project still merges green (settled inline this run)", r.ok === true && value.merged === true);
      check("(e2e merge negative control) gateExtended is undefined on the sync result — no gate ever spawned", value.gateExtended === undefined);
    }

    await waitUntil(() => (sessions.peekPendingMerge(workerId) === undefined ? true : undefined), { timeoutMs: 10_000, label: "merge op to leave PendingOpRegistry's retained view" });

    const status = sessions.gateStatus(opId);
    check("(e2e merge negative control — THE DISCRIMINATOR) gate_status's extended is ALSO undefined here, never a fabricated false, distinguishing \"no gate ran\" from the fail-block's \"ran, never extended\"", status.state === "settled" && status.outcome === "pass" && status.extended === undefined);
    // Card a1a8c5c4: no gate spawned at all here — outputTail must stay undefined, never a fabricated
    // empty string, same "nothing to report" discipline `extended` already follows above.
    check("(e2e merge negative control — a1a8c5c4) outputTail is undefined — no gate ran, nothing to report", status.outputTail === undefined);
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
  ? "\n✅ ALL PASS — GateSemaphore.findByOpId locates a running/queued entry by its FULL opId or an unambiguous 8-char PREFIX (card 225bc7bd), distinguishes an ambiguous prefix (kind:\"ambiguous\") from no live match at all (kind:\"none\"), and nothing once settled; SessionService.gateStatus (card e3e40167) reports \"running\" (by full id or prefix) with a plausible elapsedMs for a genuinely in-flight gate op, SCOPED so a stranger session/project gets \"unknown\" rather than a peek at another session's live run; falls through to the durable pending_gate_ops tombstone once the live registry is empty and reports \"settled\" for BOTH a pending-path op that surfaced pending before settling AND a FAST-PATH op that settled inline and never surfaced pending at all (the exact case the original edc1ec12 shape could never distinguish from a never-minted opId); that tombstone fallback is scope-checked identically to the live lookup (a stranger still can't learn a settled op's outcome, reading \"unknown\" rather than \"settled\" OR the false claim \"never_existed\"); \"evicted-dead-owner\" and \"orphaned-by-restart\" map through from their respective tombstone states; a minted-but-not-yet-live row reads \"pending\"; an UNSCOPED (manager-shaped) query for a genuinely bogus, never-minted opId reads \"never_existed\" — a POSITIVE assertion, proven side-by-side with a real settled op in the SAME run so the two are demonstrably NOT the same answer, the exact conflation this card exists to fix — while a SCOPED query for that SAME bogus id lands in \"unknown\" instead, identical to a stranger's query against a real foreign op, so nothing about a real op's existence ever leaks through the sink value. Card 4c5bf820: for a settled \"gate\" op specifically, gate_status ALSO reports the real recorded verdict (passed/reason/durationMs/validatedHead/headWarning/steps/outputTail/gateDetail) for BOTH a pass and a fail, proven via the REAL runWorkerGate with NO nudge ever read in either test. Card 9f6598dd — THE NEWEST FIX: a settled \"merge\" op is NO LONGER the one kind left behind — gate_status ALSO reports outcome/admittedAt/settledAt/totalDurationMs/extended for a merge op, proven via the REAL confirmWorkerMergeTracked, asserted only AFTER the op has genuinely left PendingOpRegistry's own retained view (never mid-flight), with a negative control proving `extended` stays undefined (never a fabricated false) when no gate ever spawned at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
