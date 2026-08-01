import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status / worker_list "staleDirective" projection test (card 343441bd) — the manager-facing
// signal distinguishing "worker_message delivered" from "apparently acted upon". Mirrors
// worker-reported-state.mjs's discipline: HERMETIC, NO claude, NO external daemon — seeds a real Db
// (sessions + orchestration_events, incl. the new turn_seq counter) and drives the REAL manager MCP
// tools (worker_list / worker_status) in-process over an InMemoryTransport pair, so it asserts the
// literal tool output a manager would see.
//
// THE LOAD-BEARING PROPERTY under test: staleDirective must NOT fire for a worker legitimately mid a
// single long turn (turnsSinceDelivery stays <= 1 no matter how long that one turn runs — turn-count
// based, never wall-clock), and must NOT fire once any worker_report lands after delivery. A false
// positive here is worse than no signal at all (see the card body's anti-goal).
//
// Card 0fbb0507 widens the whole projection to ALSO cover `redirect_worker` events (cases (o)-(s) below) —
// pre-fix, a PARKED redirect (the "land it NOW" escalation) surfaced NOTHING here at all. Card 99339bcd
// closes the residual gap 0fbb0507 left on the IMMEDIATE-delivery redirect path (cases (q)-(q3)): before
// it, an immediately-delivered redirect that silently gave up and parked was UNTRACKABLE (no id to key
// off at all); (q) still models that pre-fix bare shape for permanent regression coverage of already-
// persisted legacy rows, (q2)/(q3) prove the fix resolves both the plain-success and give-up/park cases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-stale-directive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-24T12:00:00.000Z";
const projId = "proj-sd";
const agentId = "agent-sd";
db.insertProject({ id: projId, name: "StaleDirective", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
// turnSeq is NOT settable at insertSession time (mirrors production — a fresh row always starts at the
// schema DEFAULT 0; only `db.incrementTurnSeq` ever advances it, exactly as onTurnCompleted does at the
// real Stop-hook chokepoint). So this seeds it the SAME way production does: N real increments.
function seedWorker(id, parentId, { busy = false, turnSeq = 0 } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
  for (let i = 0; i < turnSeq; i++) db.incrementTurnSeq(id);
}
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(Date.parse(now) + sec * 1000).toISOString();

seedManager("MGR");
seedManager("MGR2"); // card 3c712d4e's recycle-boundary case (u) — a successor manager post-recycle

// (a) FIRES: immediate delivery at turnSeq=0, worker now at turnSeq=3 (three real turns, no report at all).
seedWorker("w-stale", "MGR", { turnSeq: 3 });
ev("w-stale", "MGR", "message_worker", at(0), { msgId: "m-stale", turnSeqAtDelivery: 0 });

// (b) NO-FIRE — the long-single-turn case: immediate delivery at turnSeq=0, worker only at turnSeq=1
// (ONE completed turn since delivery, however long it ran — turnsSinceDelivery=1 < threshold).
seedWorker("w-onelongturn", "MGR", { turnSeq: 1 });
ev("w-onelongturn", "MGR", "message_worker", at(0), { msgId: "m-onelongturn", turnSeqAtDelivery: 0 });

// (c) NO-FIRE — acknowledged: a worker_report lands AFTER delivery, even though turnSeq has advanced
// well past the threshold.
seedWorker("w-acked", "MGR", { turnSeq: 5 });
ev("w-acked", "MGR", "message_worker", at(0), { msgId: "m-acked", turnSeqAtDelivery: 0 });
ev("w-acked", "MGR", "worker_report", at(10), { status: "progress", summary: "on it" });

// (d) FIRES — the HELD/incident-relevant path: message_worker held at send (no turnSeqAtDelivery on
// its own event), delivered LATER via session_message_delivered stamped at turnSeq=1; worker now at 4.
seedWorker("w-held-stale", "MGR", { turnSeq: 4 });
ev("w-held-stale", "MGR", "message_worker", at(0), { msgId: "m-held-stale" });
ev("w-held-stale", "MGR", "session_message_delivered", at(1), { msgId: "m-held-stale", turnSeqAtDelivery: 1 });

// (e) NO-FIRE — still queued: held at send, never resolved (no session_message_delivered event at all).
seedWorker("w-still-queued", "MGR", { turnSeq: 9 });
ev("w-still-queued", "MGR", "message_worker", at(0), { msgId: "m-still-queued" });

// (f) NO-FIRE — held then SUPERSEDED (e.g. a later worker_redirect flushed it): the resolution event
// carries a reason and deliberately no turnSeqAtDelivery, since it never actually delivered the text.
seedWorker("w-superseded", "MGR", { turnSeq: 9 });
ev("w-superseded", "MGR", "message_worker", at(0), { msgId: "m-superseded" });
ev("w-superseded", "MGR", "session_message_delivered", at(1), { msgId: "m-superseded", reason: "superseded" });

// (g) boundary: exactly threshold-1 turns since delivery → NO-FIRE; exactly threshold turns → FIRES.
seedWorker("w-below-threshold", "MGR", { turnSeq: 2 });
ev("w-below-threshold", "MGR", "message_worker", at(0), { msgId: "m-below", turnSeqAtDelivery: 0 });
seedWorker("w-at-threshold", "MGR", { turnSeq: 3 });
ev("w-at-threshold", "MGR", "message_worker", at(0), { msgId: "m-at", turnSeqAtDelivery: 0 });

// (h) never messaged at all → staleDirective null, no crash on a worker with zero message_worker events.
seedWorker("w-never-messaged", "MGR", { turnSeq: 9 });

// (i) a LATEST message_worker after an earlier stale one clears tracking back to the new (fresh) one —
// "latest wins", mirroring reportedProjection's own scoping.
seedWorker("w-superseded-by-newer", "MGR", { turnSeq: 5 });
ev("w-superseded-by-newer", "MGR", "message_worker", at(0), { msgId: "m-old", turnSeqAtDelivery: 0 });
ev("w-superseded-by-newer", "MGR", "message_worker", at(20), { msgId: "m-new", turnSeqAtDelivery: 5 });

// ============ Card 9da2a435 — PARKED directive coverage (the give-up chain staleDirective missed) ============
// THE LIVE SPECIMEN this reproduces: `worker_message` returned `{delivered:true}` for msgId `df77b3d7`,
// the text never reached the worker's transcript, and the worker sat `busy:false` idle for ~26 minutes —
// because a directive whose Enter is never confirmed also never advances the worker's own turnSeq, so the
// OLD staleDirectiveProjection's `turnsSinceDelivery` stayed 0 forever and read `null` (indistinguishable
// from "recently delivered, no problem yet"). These seed the REAL event shape `handleGiveUpExhausted`
// (sessions/service.ts) emits — `session_message_gave_up` with `outcome: "reminted"|"parked"` — exactly as
// production appends it, driving the same real worker_list/worker_status tools as every case above.
//
// CR follow-up: `GIVE_UP_REMINT_LIMIT` defaults to 1 (sessions/service.ts), so a ROOT msgId (chainDepth 0)
// ALWAYS re-mints at least once (`0 < 1`) before it can ever park — a give-up `outcome:"parked"` event
// carrying `msgId === rootMsgId` directly is NOT a shape production can emit. Every "parked" case below
// therefore goes through at least one "reminted" hop first, matching what `handleGiveUpExhausted` actually
// produces — do NOT special-case "a root can never park" in the PROJECTION itself, only in this seeding:
// once card 129efe74 lands, a redriven message may reach a park at chainDepth 0 by a different path, and
// `resolveDirectiveOutcome`'s chain walk already handles that (a park found on the very first msgId it
// checks) without needing to know whether the msgId it's looking at happens to equal the root.

// (j) FIRES parkedDirective — a realistic single-hop remint-then-park chain (root gives up once, reminted
// under a fresh msgId, THAT gives up too and parks — the only shape GIVE_UP_REMINT_LIMIT=1 can produce).
// turnSeq never advances past 0 (no turn ever ran) — the exact shape that used to make staleDirective (and
// therefore the whole projection) read as if nothing were wrong.
seedWorker("w-parked", "MGR", { turnSeq: 0 });
ev("w-parked", "MGR", "message_worker", at(0), { msgId: "m-parked", turnSeqAtDelivery: 0 });
ev("w-parked", "MGR", "session_message_gave_up", at(5), { msgId: "m-parked", rootMsgId: "m-parked", chainDepth: 0, outcome: "reminted", remintedAs: "m-parked-1" });
ev("w-parked", "MGR", "session_message_gave_up", at(10), { msgId: "m-parked-1", rootMsgId: "m-parked", chainDepth: 1, outcome: "parked" });

// (k) STICKY — parked, and an intervening worker_report does NOT clear it (CR follow-up [1]: the two
// branches have opposite epistemics from staleDirective's "any report since clears it" rule — a parked
// directive's text never reached the worker, so nothing it reports can be an acknowledgement of THIS one).
seedWorker("w-parked-sticky", "MGR", { turnSeq: 1 });
ev("w-parked-sticky", "MGR", "message_worker", at(0), { msgId: "m-parked-sticky", turnSeqAtDelivery: 0 });
ev("w-parked-sticky", "MGR", "session_message_gave_up", at(5), { msgId: "m-parked-sticky", rootMsgId: "m-parked-sticky", chainDepth: 0, outcome: "reminted", remintedAs: "m-parked-sticky-1" });
ev("w-parked-sticky", "MGR", "session_message_gave_up", at(10), { msgId: "m-parked-sticky-1", rootMsgId: "m-parked-sticky", chainDepth: 1, outcome: "parked" });
ev("w-parked-sticky", "MGR", "worker_report", at(20), { status: "progress", summary: "unrelated checkpoint, never saw the parked directive" });

// (k2) CLEARS — parked, but a NEWER worker_message supersedes tracking entirely ("latest wins", the only
// way parkedDirective is meant to clear).
seedWorker("w-parked-superseded", "MGR", { turnSeq: 1 });
ev("w-parked-superseded", "MGR", "message_worker", at(0), { msgId: "m-parked-old", turnSeqAtDelivery: 0 });
ev("w-parked-superseded", "MGR", "session_message_gave_up", at(5), { msgId: "m-parked-old", rootMsgId: "m-parked-old", chainDepth: 0, outcome: "reminted", remintedAs: "m-parked-old-1" });
ev("w-parked-superseded", "MGR", "session_message_gave_up", at(10), { msgId: "m-parked-old-1", rootMsgId: "m-parked-old", chainDepth: 1, outcome: "parked" });
ev("w-parked-superseded", "MGR", "message_worker", at(20), { msgId: "m-parked-new", turnSeqAtDelivery: 1 });

// (l) FIRES staleDirective, reported against the ROOT msgId — a re-mint chain that eventually DELIVERS
// (the reminted msgId gets its own session_message_delivered, held-path style) and then goes stale.
// The manager only ever saw the ROOT msgId from its own worker_message call, so that's what must be
// reported back, not the internal remint id.
seedWorker("w-reminted-then-stale", "MGR", { turnSeq: 6 });
ev("w-reminted-then-stale", "MGR", "message_worker", at(0), { msgId: "m-remint-root", turnSeqAtDelivery: 0 });
ev("w-reminted-then-stale", "MGR", "session_message_gave_up", at(5), { msgId: "m-remint-root", rootMsgId: "m-remint-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-remint-1" });
ev("w-reminted-then-stale", "MGR", "session_message_delivered", at(6), { msgId: "m-remint-1", turnSeqAtDelivery: 1 });

// (m) NO-FIRE — re-minted and still genuinely in flight (held, not yet resolved either way). Neither
// delivered-and-stale nor parked; nothing to report yet, same as a plain still-queued directive.
seedWorker("w-reminted-pending", "MGR", { turnSeq: 9 });
ev("w-reminted-pending", "MGR", "message_worker", at(0), { msgId: "m-remint-pending-root", turnSeqAtDelivery: 0 });
ev("w-reminted-pending", "MGR", "session_message_gave_up", at(5), { msgId: "m-remint-pending-root", rootMsgId: "m-remint-pending-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-remint-pending-1" });

// (n) FIRES parkedDirective via a MULTI-HOP chain (reminted TWICE, then parked) — proves the chain walk
// keeps following `remintedAs` across more than one hop, not just the single hop GIVE_UP_REMINT_LIMIT=1
// happens to produce today (this seeds a hypothetical higher limit to exercise the general walk).
seedWorker("w-multihop-parked", "MGR", { turnSeq: 0 });
ev("w-multihop-parked", "MGR", "message_worker", at(0), { msgId: "m-multi-root", turnSeqAtDelivery: 0 });
ev("w-multihop-parked", "MGR", "session_message_gave_up", at(5), { msgId: "m-multi-root", rootMsgId: "m-multi-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-multi-r1" });
ev("w-multihop-parked", "MGR", "session_message_gave_up", at(10), { msgId: "m-multi-r1", rootMsgId: "m-multi-root", chainDepth: 1, outcome: "reminted", remintedAs: "m-multi-r2" });
ev("w-multihop-parked", "MGR", "session_message_gave_up", at(15), { msgId: "m-multi-r2", rootMsgId: "m-multi-root", chainDepth: 2, outcome: "parked" });

// ============ Card 0fbb0507 — widen the projection to `redirect_worker` (a parked REDIRECT surfaced
// NOTHING at all pre-fix — this is the RED-first case for that exact defect) ============
// `redirect_worker`'s own event shape (deliverRedirect, sessions/service.ts): held (delivered:false)
// stamps `queuedMsgId` (the SAME msgId `enqueueDurableMessage` mints internally, card 02621025) — the
// give-up/park chain below is keyed to THAT id, exactly like message_worker's own `msgId`. As of card
// 99339bcd, an IMMEDIATE delivery (delivered:true, worker was idle) ALSO stamps `queuedMsgId` (the same
// msgId, returned unconditionally by `enqueueDurableMessage`) plus `turnSeqAtDelivery` — previously
// neither was stamped on that path (see case (q) below, which still models that pre-fix bare shape as a
// permanent regression guard for any already-persisted legacy row).

// (o) FIRES parkedDirective for a PARKED REDIRECT — the reported defect itself. Mirrors (n)'s
// remint-then-park shape (a root always re-mints at least once before it can park at GIVE_UP_REMINT_LIMIT=1
// — see (j)'s own doc) but rooted at a HELD redirect's `queuedMsgId` instead of a message_worker's `msgId`.
// Pre-fix, staleDirectiveProjection's scan never looked at `redirect_worker` events at all, so this worker
// read byte-identical to a worker that was never redirected — this case is RED before the widening lands.
seedWorker("w-redirect-parked", "MGR", { turnSeq: 0 });
ev("w-redirect-parked", "MGR", "redirect_worker", at(0), { delivered: false, superseded: 0, queuedMsgId: "r-parked" });
ev("w-redirect-parked", "MGR", "session_message_gave_up", at(5), { msgId: "r-parked", rootMsgId: "r-parked", chainDepth: 0, outcome: "reminted", remintedAs: "r-parked-1" });
ev("w-redirect-parked", "MGR", "session_message_gave_up", at(10), { msgId: "r-parked-1", rootMsgId: "r-parked", chainDepth: 1, outcome: "parked" });

// (p) FIRES staleDirective for a HELD redirect that later DELIVERS (session_message_delivered, held-path
// style, mirrors (d)/(l)) and then goes stale with no worker_report since — proves the held-then-delivered
// walk resolves identically for a redirect's `queuedMsgId` as it does for a message's `msgId`.
seedWorker("w-redirect-held-stale", "MGR", { turnSeq: 4 });
ev("w-redirect-held-stale", "MGR", "redirect_worker", at(0), { delivered: false, superseded: 1, queuedMsgId: "r-held-stale" });
ev("w-redirect-held-stale", "MGR", "session_message_delivered", at(1), { msgId: "r-held-stale", turnSeqAtDelivery: 1 });

// (q) LEGACY / PRE-99339bcd SHAPE: an immediately-delivered redirect logged before this card's fix carries
// no `queuedMsgId` and no `turnSeqAtDelivery` at all (deliverRedirect used to discard `r.msgId` on that
// path). Production never emits this shape for a FRESH send anymore (see (q2)/(q3) below) — this case is
// permanent regression coverage for the defensive `!rootMsgId` fallback in staleDirectiveProjection, which
// deliberately still reads an already-persisted legacy row exactly as it always did (never retroactively
// reinterpreted). Must NOT crash, and must read as a plain "delivered" with nothing further to track — no
// staleDirective/parkedDirective, regardless of how far turnSeq has since advanced.
seedWorker("w-redirect-immediate", "MGR", { turnSeq: 9 });
ev("w-redirect-immediate", "MGR", "redirect_worker", at(0), { delivered: true, superseded: 1 });

// (q2) FIXED SHAPE — card 99339bcd's actual fix: an immediately-delivered redirect that never gives up
// now stamps a real `queuedMsgId` + `turnSeqAtDelivery` (mirrors messageWorker's own immediate-path
// stamp — see redirect-worker.mjs case (4b) for the service-level proof deliverRedirect emits exactly
// this shape). Resolves to `directive:{state:"delivered", msgId:"ri-tracked"}` — NOT the bare/untracked
// "delivered" of (q) — and, like a plain message_worker, still goes stale after enough real turns with no
// report (mirrors case (a)); this is the FIX for the "success path regresses to pending forever" risk this
// card's own investigation had to rule out (turnSeqAtDelivery is what lets the walk resolve to "delivered"
// instead of stalling at "pending" — omitting it would have been a real regression, not a neutral no-op).
seedWorker("w-redirect-immediate-tracked", "MGR", { turnSeq: 3 });
ev("w-redirect-immediate-tracked", "MGR", "redirect_worker", at(0), { delivered: true, superseded: 0, queuedMsgId: "ri-tracked", turnSeqAtDelivery: 0 });

// (q3) RED-FIRST PROOF — the card's actual DoD: an IMMEDIATELY-delivered redirect whose async hand-off
// confirmation silently GIVES UP and PARKS (card 04de8bbf: an immediate hand-off can still fail this way
// exactly like a held one can). Production-faithful remint-then-park shape (two hops, mirrors (o)/(n) —
// a root always re-mints at least once before GIVE_UP_REMINT_LIMIT=1 lets it park; seeding
// `msgId === rootMsgId` directly on a park is a shape production can never emit). turnSeq stays 0 — the
// hand-off's Enter was never actually confirmed, so no real turn ever ran, exactly like (j)'s held-parked
// case. Pre-99339bcd, this shape was UNREACHABLE from real `deliverRedirect` output (the immediate path
// stamped no id at all, so this whole chain had nothing to key off of and the directive read as a bare,
// unalarmed "delivered" like (q) — a parked redirect on this path was invisible). This is what the fix
// makes auditable.
seedWorker("w-redirect-immediate-parked", "MGR", { turnSeq: 0 });
ev("w-redirect-immediate-parked", "MGR", "redirect_worker", at(0), { delivered: true, superseded: 1, queuedMsgId: "ri-parked", turnSeqAtDelivery: 0 });
ev("w-redirect-immediate-parked", "MGR", "session_message_gave_up", at(5), { msgId: "ri-parked", rootMsgId: "ri-parked", chainDepth: 0, outcome: "reminted", remintedAs: "ri-parked-1" });
ev("w-redirect-immediate-parked", "MGR", "session_message_gave_up", at(10), { msgId: "ri-parked-1", rootMsgId: "ri-parked", chainDepth: 1, outcome: "parked" });

// (r) latest-wins ACROSS KINDS: an older message_worker followed by a NEWER redirect_worker (delivered
// immediately, fixed shape) — the redirect becomes the tracked directive with its OWN real msgId,
// exactly mirroring how `deliverRedirect` actually flushes/supersedes any queued message at send time.
seedWorker("w-redirect-supersedes-message", "MGR", { turnSeq: 5 });
ev("w-redirect-supersedes-message", "MGR", "message_worker", at(0), { msgId: "m-old-for-redirect", turnSeqAtDelivery: 0 });
ev("w-redirect-supersedes-message", "MGR", "redirect_worker", at(20), { delivered: true, superseded: 1, queuedMsgId: "ri-supersedes", turnSeqAtDelivery: 5 });

// (s) latest-wins ACROSS KINDS, the other direction: a PARKED redirect superseded by a NEWER message_worker
// — clears parkedDirective the same way a newer message_worker clears an OLDER parked message_worker (k2),
// now proven across kinds too.
seedWorker("w-message-supersedes-parked-redirect", "MGR", { turnSeq: 1 });
ev("w-message-supersedes-parked-redirect", "MGR", "redirect_worker", at(0), { delivered: false, superseded: 0, queuedMsgId: "r-parked-old" });
ev("w-message-supersedes-parked-redirect", "MGR", "session_message_gave_up", at(5), { msgId: "r-parked-old", rootMsgId: "r-parked-old", chainDepth: 0, outcome: "reminted", remintedAs: "r-parked-old-1" });
ev("w-message-supersedes-parked-redirect", "MGR", "session_message_gave_up", at(10), { msgId: "r-parked-old-1", rootMsgId: "r-parked-old", chainDepth: 1, outcome: "parked" });
ev("w-message-supersedes-parked-redirect", "MGR", "message_worker", at(20), { msgId: "m-new-after-redirect", turnSeqAtDelivery: 1 });

// ============ Card 3c712d4e — "parked" is not always terminal: a LATE confirming hook can prove the
// original delivery actually landed (handleGiveUpConfirmed, sessions/service.ts, appends a
// `session_message_gave_up` event on the SAME msgId with `outcome: "confirmed-after-park"`). Pre-fix,
// `resolveDirectiveOutcome` returns the instant it finds the FIRST (chronologically earliest)
// `outcome:"parked"` event for a msgId and never looks further — so a sender re-reading worker_list/
// worker_status AFTER the confirmation lands still sees a STICKY `parkedDirective` and the tool's own
// "RE-SEND — Loom will not retry it for you" advice, even though the message demonstrably already ran.
// Following that advice manufactures the exact duplicate this whole family of cards exists to prevent
// (see `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` / card 417cea0a's own hedge: "MAY
// follow up... its absence is NOT evidence"). THE FIX makes this mechanically decidable AT READ TIME —
// from the SAME durable event history, not from a best-effort notice landing in time.

// (t) RED-FIRST: parked, then a LATER confirmed-after-park event for the SAME msgId lands. Must resolve
// to a NEW, distinct state — NOT a plain "parked" — and parkedDirective must clear (a confirmed message
// is not one you should re-send).
seedWorker("w-parked-then-confirmed", "MGR", { turnSeq: 0 });
ev("w-parked-then-confirmed", "MGR", "message_worker", at(0), { msgId: "m-pc", turnSeqAtDelivery: 0 });
ev("w-parked-then-confirmed", "MGR", "session_message_gave_up", at(5), { msgId: "m-pc", rootMsgId: "m-pc", chainDepth: 0, outcome: "reminted", remintedAs: "m-pc-1" });
ev("w-parked-then-confirmed", "MGR", "session_message_gave_up", at(10), { msgId: "m-pc-1", rootMsgId: "m-pc", chainDepth: 1, outcome: "parked" });
ev("w-parked-then-confirmed", "MGR", "session_message_gave_up", at(240), { msgId: "m-pc-1", rootMsgId: "m-pc", outcome: "confirmed-after-park", latencyMs: 230000 });

// (u) RECYCLE-BOUNDARY: the identical parked-then-confirmed shape, but the worker's OWNING manager has
// since changed (parentSessionId now points at MGR2, a successor — mirroring reparentLiveWorkers on a
// real worker_recycle) while the original give-up chain events still carry the PREDECESSOR's
// managerSessionId ("MGR"). Failure mode (a) named in the card body is a DIFFERENT mechanism
// (`hasAmbiguousMatch`'s text-signature match, which embeds the sender's own session id) breaking across
// this exact boundary — this test does NOT exercise that mechanism and proves nothing about it either
// way. What THIS test proves, from reading `resolveDirectiveOutcome`/`staleDirectiveProjection` itself:
// they never match on text or on managerSessionId at all — only on the WORKER's own msgId-keyed durable
// events — so this projection's confirmed-after-park resolution must hold regardless of which manager
// (predecessor or successor) is asking, i.e. it does not regress across the SAME boundary failure mode
// (a) names for the other mechanism.
seedWorker("w-parked-then-confirmed-recycled", "MGR2", { turnSeq: 0 });
ev("w-parked-then-confirmed-recycled", "MGR", "message_worker", at(0), { msgId: "m-pcr", turnSeqAtDelivery: 0 });
ev("w-parked-then-confirmed-recycled", "MGR", "session_message_gave_up", at(5), { msgId: "m-pcr", rootMsgId: "m-pcr", chainDepth: 0, outcome: "reminted", remintedAs: "m-pcr-1" });
ev("w-parked-then-confirmed-recycled", "MGR", "session_message_gave_up", at(10), { msgId: "m-pcr-1", rootMsgId: "m-pcr", chainDepth: 1, outcome: "parked" });
ev("w-parked-then-confirmed-recycled", "MGR", "session_message_gave_up", at(240), { msgId: "m-pcr-1", rootMsgId: "m-pcr", outcome: "confirmed-after-park", latencyMs: 230000 });

const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; }, // card ae0b7891: no archived-without-report worker in this test
  async getDanglingWorkers() { return []; }, // card ba41b402: no stopped-but-unmerged worker in this test
}));
const server = router.buildServer("MGR", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "stale-directive-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const status = async (id) => parse(await client.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));

// Second manager identity (MGR2) — the recycle-boundary case (u) queries as the SUCCESSOR, since
// worker_list/worker_status are scoped to the calling manager and "w-parked-then-confirmed-recycled" is
// now parented to MGR2, not MGR.
const serverMgr2 = router.buildServer("MGR2", "manager");
const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
await serverMgr2.connect(serverT2);
const clientMgr2 = new Client({ name: "stale-directive-test-mgr2", version: "0" });
await clientMgr2.connect(clientT2);
const statusMgr2 = async (id) => parse(await clientMgr2.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));

const list = parse(await client.callTool({ name: "worker_list", arguments: {} }));
const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));

check("(a) FIRES: 3 real turns since immediate delivery, no report at all",
  byId["w-stale"]?.staleDirective !== null
  && byId["w-stale"]?.staleDirective?.msgId === "m-stale"
  && byId["w-stale"]?.staleDirective?.turnsSinceDelivery === 3);

check("(b) NO-FIRE: one long single turn since delivery (turnsSinceDelivery=1, below threshold)",
  byId["w-onelongturn"]?.staleDirective === null);

check("(c) NO-FIRE: acknowledged by a worker_report after delivery, even at turnSeq=5",
  byId["w-acked"]?.staleDirective === null);

check("(d) FIRES: the HELD/incident-relevant path — stamped at actual (held) delivery, not enqueue",
  byId["w-held-stale"]?.staleDirective !== null
  && byId["w-held-stale"]?.staleDirective?.msgId === "m-held-stale"
  && byId["w-held-stale"]?.staleDirective?.turnsSinceDelivery === 3);

check("(e) NO-FIRE: still queued (held, never resolved) — nothing to judge staleness against yet",
  byId["w-still-queued"]?.staleDirective === null);

check("(f) NO-FIRE: held then superseded — never actually delivered",
  byId["w-superseded"]?.staleDirective === null);

check("(g) boundary: turnsSinceDelivery=2 (threshold-1) → NO-FIRE",
  byId["w-below-threshold"]?.staleDirective === null);
check("(g) boundary: turnsSinceDelivery=3 (== threshold) → FIRES",
  byId["w-at-threshold"]?.staleDirective !== null);

check("(h) never messaged → staleDirective null, no crash",
  byId["w-never-messaged"]?.staleDirective === null);

check("(i) latest message_worker wins — tracks the NEW directive (turnsSinceDelivery=0), not the old stale one",
  byId["w-superseded-by-newer"]?.staleDirective === null);

// ============ Card 9da2a435 — PARKED directive coverage ============
check("(j) FIRES parkedDirective: single-hop remint-then-park (the only shape GIVE_UP_REMINT_LIMIT=1 can produce), turnSeq never advanced",
  byId["w-parked"]?.parkedDirective !== null
  && byId["w-parked"]?.parkedDirective?.msgId === "m-parked"
  && byId["w-parked"]?.staleDirective === null);

check("(k) STICKY: parked directive is NOT cleared by an intervening worker_report",
  byId["w-parked-sticky"]?.parkedDirective !== null
  && byId["w-parked-sticky"]?.parkedDirective?.msgId === "m-parked-sticky"
  && byId["w-parked-sticky"]?.staleDirective === null);

check("(k2) CLEARS: parked directive superseded by a NEWER worker_message ('latest wins')",
  byId["w-parked-superseded"]?.parkedDirective === null
  && byId["w-parked-superseded"]?.staleDirective === null
  && byId["w-parked-superseded"]?.directive?.msgId === "m-parked-new");

check("(l) FIRES staleDirective against the ROOT msgId after a re-mint chain actually delivers and goes stale",
  byId["w-reminted-then-stale"]?.staleDirective !== null
  && byId["w-reminted-then-stale"]?.staleDirective?.msgId === "m-remint-root"
  && byId["w-reminted-then-stale"]?.staleDirective?.turnsSinceDelivery === 5
  && byId["w-reminted-then-stale"]?.parkedDirective === null);

check("(m) NO-FIRE: re-minted and still genuinely in flight (held, unresolved either way)",
  byId["w-reminted-pending"]?.staleDirective === null && byId["w-reminted-pending"]?.parkedDirective === null);

check("(n) FIRES parkedDirective via a multi-hop (two-remint) chain — the walk keeps following remintedAs",
  byId["w-multihop-parked"]?.parkedDirective !== null
  && byId["w-multihop-parked"]?.parkedDirective?.msgId === "m-multi-root"
  && byId["w-multihop-parked"]?.staleDirective === null);

// ============ Card 0fbb0507 — redirect_worker coverage (the reported defect + its RED-first case) ============
check("(o) FIRES parkedDirective for a PARKED REDIRECT — the reported defect: pre-fix this read null",
  byId["w-redirect-parked"]?.parkedDirective !== null
  && byId["w-redirect-parked"]?.parkedDirective?.msgId === "r-parked"
  && byId["w-redirect-parked"]?.staleDirective === null
  && byId["w-redirect-parked"]?.directive?.state === "parked");

check("(p) FIRES staleDirective for a HELD redirect that later delivers and goes stale",
  byId["w-redirect-held-stale"]?.staleDirective !== null
  && byId["w-redirect-held-stale"]?.staleDirective?.msgId === "r-held-stale"
  && byId["w-redirect-held-stale"]?.staleDirective?.turnsSinceDelivery === 3
  && byId["w-redirect-held-stale"]?.parkedDirective === null);

check("(q) LEGACY pre-99339bcd shape (no queuedMsgId/turnSeqAtDelivery persisted): defensive fallback still reads delivered/msgId:null, no alarms — never retroactively reinterpreted",
  byId["w-redirect-immediate"]?.directive?.state === "delivered"
  && byId["w-redirect-immediate"]?.directive?.msgId === null
  && byId["w-redirect-immediate"]?.staleDirective === null
  && byId["w-redirect-immediate"]?.parkedDirective === null);

check("(q2) card 99339bcd FIX: an immediately-delivered redirect that never gives up resolves delivered WITH its real msgId (not null)",
  byId["w-redirect-immediate-tracked"]?.directive?.state === "delivered"
  && byId["w-redirect-immediate-tracked"]?.directive?.msgId === "ri-tracked"
  && byId["w-redirect-immediate-tracked"]?.parkedDirective === null);

check("(q2) and still goes stale like a plain message_worker once enough real turns pass with no report",
  byId["w-redirect-immediate-tracked"]?.staleDirective !== null
  && byId["w-redirect-immediate-tracked"]?.staleDirective?.msgId === "ri-tracked"
  && byId["w-redirect-immediate-tracked"]?.staleDirective?.turnsSinceDelivery === 3);

check("(q3) RED-FIRST PROOF: card 99339bcd FIXES an immediately-delivered redirect that silently gives up and parks — UNREACHABLE from real deliverRedirect output before this fix",
  byId["w-redirect-immediate-parked"]?.parkedDirective !== null
  && byId["w-redirect-immediate-parked"]?.parkedDirective?.msgId === "ri-parked"
  && byId["w-redirect-immediate-parked"]?.staleDirective === null
  && byId["w-redirect-immediate-parked"]?.directive?.state === "parked");

check("(r) latest-wins across kinds: a newer immediate redirect supersedes an older outstanding message, tracked with its OWN real msgId",
  byId["w-redirect-supersedes-message"]?.directive?.state === "delivered"
  && byId["w-redirect-supersedes-message"]?.directive?.msgId === "ri-supersedes"
  && byId["w-redirect-supersedes-message"]?.directive?.at === at(20)
  && byId["w-redirect-supersedes-message"]?.staleDirective === null);

check("(s) latest-wins across kinds: a newer message_worker clears a PARKED redirect ('latest wins')",
  byId["w-message-supersedes-parked-redirect"]?.parkedDirective === null
  && byId["w-message-supersedes-parked-redirect"]?.staleDirective === null
  && byId["w-message-supersedes-parked-redirect"]?.directive?.msgId === "m-new-after-redirect");

// ============ Card 9da2a435 — `directive` raw-state discriminator (CR follow-up [2]) ============
check("directive: never messaged → {msgId:null, state:\"none\", at:null}",
  byId["w-never-messaged"]?.directive?.msgId === null
  && byId["w-never-messaged"]?.directive?.state === "none"
  && byId["w-never-messaged"]?.directive?.at === null);

check("directive: still queued (held, unresolved) → state \"pending\" — distinguishable from never-messaged",
  byId["w-still-queued"]?.directive?.msgId === "m-still-queued"
  && byId["w-still-queued"]?.directive?.state === "pending");

check("directive: delivered-and-fresh (below stale threshold) → state \"delivered\"",
  byId["w-onelongturn"]?.directive?.state === "delivered"
  && byId["w-onelongturn"]?.directive?.msgId === "m-onelongturn");

check("directive: delivered-and-stale → state still reads \"delivered\" (staleDirective is the alarm layer)",
  byId["w-stale"]?.directive?.state === "delivered" && byId["w-stale"]?.directive?.msgId === "m-stale");

check("directive: parked → state \"parked\", at === parkedAt",
  byId["w-parked"]?.directive?.state === "parked"
  && byId["w-parked"]?.directive?.msgId === "m-parked"
  && byId["w-parked"]?.directive?.at === byId["w-parked"]?.parkedDirective?.parkedAt);

// ============ Card 3c712d4e — "parked" is not always terminal (confirmed-after-park) ============
check("(t) RED-FIRST: a LATER confirmed-after-park event resolves directive.state to \"confirmed-after-park\", NOT a sticky \"parked\"",
  byId["w-parked-then-confirmed"]?.directive?.state === "confirmed-after-park"
  && byId["w-parked-then-confirmed"]?.directive?.msgId === "m-pc");

check("(t) parkedDirective clears once confirmed-after-park lands — a confirmed message must not carry the tool's own \"RE-SEND\" advice",
  byId["w-parked-then-confirmed"]?.parkedDirective === null
  && byId["w-parked-then-confirmed"]?.staleDirective === null);

check("(u) RECYCLE-BOUNDARY: the SAME resolution holds when queried by a SUCCESSOR manager (parentSessionId changed, give-up events still carry the predecessor's managerSessionId) — the decision is keyed to the worker's own msgId history, not to any session-embedded text",
  byId["w-parked-then-confirmed-recycled"] === undefined); // not MGR's worker — sanity: absent from MGR's own fleet view

const uViaMgr2 = await statusMgr2("w-parked-then-confirmed-recycled");
check("(u) worker_status via the successor manager (MGR2) resolves confirmed-after-park identically",
  uViaMgr2.directive?.state === "confirmed-after-park"
  && uViaMgr2.directive?.msgId === "m-pcr"
  && uViaMgr2.parkedDirective === null
  && uViaMgr2.staleDirective === null);

// ============================ worker_status mirrors worker_list ============================
const sStale = await status("w-stale");
check("worker_status(w-stale) carries the same staleDirective as worker_list",
  sStale.staleDirective?.msgId === "m-stale" && sStale.staleDirective?.turnsSinceDelivery === 3);
const sAcked = await status("w-acked");
check("worker_status(w-acked) → staleDirective null (acknowledged)", sAcked.staleDirective === null);
const sParked = await status("w-parked");
check("worker_status(w-parked) carries the same parkedDirective as worker_list",
  sParked.parkedDirective?.msgId === "m-parked" && sParked.staleDirective === null);
const sRedirectParked = await status("w-redirect-parked");
check("worker_status(w-redirect-parked) carries the same parkedDirective as worker_list — the reported defect, mirrored",
  sRedirectParked.parkedDirective?.msgId === "r-parked" && sRedirectParked.staleDirective === null);
const sRedirectImmediateParked = await status("w-redirect-immediate-parked");
check("worker_status(w-redirect-immediate-parked) carries the same parkedDirective as worker_list — card 99339bcd's fix, mirrored",
  sRedirectImmediateParked.parkedDirective?.msgId === "ri-parked" && sRedirectImmediateParked.staleDirective === null);

await client.close();
await clientMgr2.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — staleDirective fires only once a worker_message directive has aged past the turn threshold with no worker_report since delivery (both the immediate and held delivery paths), never fires on a long single turn or once acknowledged by any report, and correctly ignores a still-queued/superseded/never-messaged/superseded-by-a-newer-directive worker. parkedDirective (card 9da2a435) correctly fires for a directive whose give-up chain terminated PARKED — realistic single-hop and multi-hop remint-then-park chains, matching production's GIVE_UP_REMINT_LIMIT=1 shape — is STICKY against an intervening worker_report (opposite epistemics from staleDirective), clears only once superseded by a newer worker_message, stays null while a re-mint is still genuinely in flight, and staleDirective still reports against the ROOT msgId a manager actually recognizes even after a chain resolves via a re-mint. The raw `directive` discriminator (none/pending/delivered/parked) finally distinguishes a never-messaged worker from every other state, which used to be byte-identical. Card 0fbb0507 widens all of the above to `redirect_worker` too: a HELD redirect's give-up chain (keyed to its `queuedMsgId`) parks/delivers/goes-stale exactly like a message's does, and 'latest wins' now holds ACROSS kinds in both directions (a redirect supersedes an older message; a message clears an older, even parked, redirect). Card 99339bcd then closes the one residual gap 0fbb0507 left open: an IMMEDIATELY-delivered redirect now ALSO stamps a real correlatable msgId + turnSeqAtDelivery (mirroring messageWorker's own immediate-path stamp), so it resolves to delivered/stale/parked exactly like a held redirect or a plain message — including a give-up that silently parks, previously invisible on this path entirely — while an already-persisted PRE-FIX row (no id at all) still reads exactly as it always did via the defensive fallback, never retroactively reinterpreted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
