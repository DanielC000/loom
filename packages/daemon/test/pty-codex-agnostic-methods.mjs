import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 353f6dc4 (multi-harness epic df1f94b0 Phase 1, lead ruling #3 condition 2): "The 'zero extra code
// for agnostic methods' claim must be TESTED, not asserted from inspection." This is that test — a
// HERMETIC proof (no real codex install needed, unlike codex-mcp-reachability-real-spawn.mjs) that a
// codex-kind live entry, registered in PtyHost's private `liveCodex` map, drives the pinned
// AGNOSTIC-classified methods (pty-agnostic-methods-findanylive-guard.mjs's own AGNOSTIC_METHODS list)
// correctly via `findAnyLive` — with NO code path change needed for any of them.
//
// TECHNIQUE: directly registers a CodexLive-shaped object into PtyHost's `liveCodex` map — the SAME
// technique this project's own doctrine names as established precedent (`pty-prompt-mismatch-
// unresolved.mjs`'s own PART 6 calls a private method directly, "exactly as host.live is read directly
// elsewhere in that suite"): TypeScript's `private` is a compile-time-only annotation, so a compiled JS
// test can read/write it — this is a deliberate, precedented technique here, not a workaround. A fake
// `pty`/`logStream` stub is enough because NONE of the AGNOSTIC methods under test touch `.pty`/
// `.logStream` directly (verified by reading each one during the guard's own development — see that
// file's header) — only `.pending`/`.busy`/`.alive`/`.pid`/`.subscribers`/`.ring`/`.geometry`/`.mcpSeen`/
// `.activeTurn*`/`.drainHeld`/`.startedAt`. (Card a1916267: `.lastOutputAt` REMOVED from this list —
// `getLastOutputAt` is no longer AGNOSTIC; see that method's own doc in pty/host.ts and the negative
// assertion below.)
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-codex-agnostic-methods.mjs
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { PtyHost } = await import("../dist/pty/host.js");

const busyEvents = [];
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, busy) { busyEvents.push({ sessionId, busy }); },
  onExit() {},
};
const host = new PtyHost(events);

const SESSION_ID = "codex-agnostic-test";
const startedAt = Date.now() - 5000;
// onData/onExit CAPTURE their callback (never discard it) even though this test never fires either —
// this test drives no real spawn/exit path, but onexit-discard-guard.mjs correctly flags a fake pty whose
// onExit can't even receive a callback as indistinguishable from a real bug elsewhere silently losing it.
const fakePty = { pid: 424242, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
const fakeLogStream = { write() {}, end() {}, on() {} };
/** A minimal, real CodexLive-shaped object — every field an AGNOSTIC method under test actually reads. */
function makeCodexLive() {
  return {
    kind: "codex", pty: fakePty, pid: fakePty.pid, cwd: "/fake/codex/worktree",
    geometry: { cols: 120, rows: 40 },
    hookToken: "", engineSessionId: "engine-abc",
    ring: { chunks: [Buffer.from("hello codex")], bytes: 11 },
    subscribers: new Set(),
    alive: true, killed: false, startedAt,
    logStream: fakeLogStream, logBroken: false,
    busy: false,
    pending: [], stopping: false, drainHeld: false,
    role: "worker",
    mcpSeen: false, mcpSeenWaiters: [],
    activeTurnRoute: null, lastPromptRoute: null,
    activeTurnProactive: false, lastPromptProactive: false,
    activeTurnOwnerText: null, lastPromptOwnerText: null,
    recentOwnerTurns: [],
    activeTurnSenderId: null, lastPromptSenderId: null,
    trustDialogAnswered: true, screenScan: "",
    firstTurnStarted: false,
  };
}

// --- (T2, card 0770d916) prove this hand-written fixture's field set hasn't silently drifted from the
// REAL `CodexLive` interface — the shape `spawnCodexProcess`'s own object literal is CHECKED AGAINST AT
// COMPILE TIME (a direct `const live: CodexLive = {...}` literal assignment, so tsc already refuses a
// missing/renamed field there); this JS test file is never type-checked itself, so a field renamed or
// removed on the real interface could leave THIS fixture silently stale (still all-PASS, since nothing
// else here compares it against anything real) — exactly the class of bug the card's own finding named.
// Anchor-extracts the interface body (same technique profile-field-consumer-guard.mjs already uses for
// pty/host.ts regions) and asserts every key this fixture sets is a real field on that interface — this
// deliberately does NOT require the reverse (the interface may carry MORE fields than this fixture sets;
// see the file header above — the fixture is intentionally the minimal subset the AGNOSTIC methods under
// test actually read, not a full mirror).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const HOST_TS = fs.readFileSync(path.join(__dirname, "..", "src", "pty", "host.ts"), "utf8");
  const ifaceStart = HOST_TS.indexOf("export interface CodexLive {");
  const ifaceEnd = HOST_TS.indexOf("export interface SpawnOpts {", ifaceStart);
  check("(shape) CodexLive interface anchors found in host.ts", ifaceStart !== -1 && ifaceEnd !== -1 && ifaceEnd > ifaceStart);
  const CODEX_LIVE_IFACE = HOST_TS.slice(ifaceStart, ifaceEnd);
  // Field declarations are one per line, 2-space indented (`  fieldName: Type;` / `  fieldName?: Type;`) —
  // a JSDoc comment line is indented differently (`  /**` / `   *`) and never matches this shape.
  const realFieldNames = new Set([...CODEX_LIVE_IFACE.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*)\??:\s/gm)].map((m) => m[1]));
  check(`(shape) extraction found a plausible field count (>20, found ${realFieldNames.size})`, realFieldNames.size > 20);
  // Positive control FIRST (this project's own standing rule): the extraction must be able to discriminate
  // in BOTH directions, not just return a big, reassuring-looking set.
  check("(shape control) extraction correctly reports a fabricated field name ABSENT", !realFieldNames.has("thisFieldDoesNotExistOnCodexLive12345"));
  check("(shape control) extraction correctly finds a KNOWN real field (bootReadyTimer)", realFieldNames.has("bootReadyTimer"));

  const staleFixtureKeys = Object.keys(makeCodexLive()).filter((k) => !realFieldNames.has(k));
  check(
    `(shape) every field this hand-written fixture sets still exists on the REAL CodexLive interface (stale: ${staleFixtureKeys.join(", ") || "none"})`,
    staleFixtureKeys.length === 0,
  );
}

// --- Negative control FIRST: before any codex entry is registered, every accessor reads as genuinely
// ABSENT (never a measured 0/false/[]) — lead ruling #4's own binding condition, and the reason a SEPARATE
// registry was chosen over sentinel-populating Live in the first place. ------------------------------
check("(absent) isAlive on an unregistered sessionId reads false", host.isAlive(SESSION_ID) === false);
check("(absent) isBusy on an unregistered sessionId reads false", host.isBusy(SESSION_ID) === false);
check("(absent) getPid on an unregistered sessionId reads undefined (not 0)", host.getPid(SESSION_ID) === undefined);
check("(absent) getLastOutputAt on an unregistered sessionId reads undefined (not 0)", host.getLastOutputAt(SESSION_ID) === undefined);
check("(absent) liveStartedAt on an unregistered sessionId reads null", host.liveStartedAt(SESSION_ID) === null);
check("(absent) getPending on an unregistered sessionId reads [] (not a crash)", JSON.stringify(host.getPending(SESSION_ID)) === "[]");
check("(absent) getActiveTurnOrigin on an unregistered sessionId reads null", host.getActiveTurnOrigin(SESSION_ID) === null);
check("(absent) hasFirstTurnStarted on an unregistered sessionId reads false", host.hasFirstTurnStarted(SESSION_ID) === false);

// --- Register the codex entry directly into the private liveCodex map -------------------------------
const live = makeCodexLive();
host.liveCodex.set(SESSION_ID, live);

// --- hasFirstTurnStarted (card 361a5520) -----------------------------------------------------------
// RED-BEFORE-GREEN, recorded here rather than re-run: against the PRE-FIX `hasFirstTurnStarted` (a bare
// `this.live.get(sessionId)?.firstTurnStarted ?? false`), a registered codex entry — even with
// `firstTurnStarted:true` set below — read `false`, because a codex session lives in the SEPARATE
// `liveCodex` map, never `this.live`. That is the exact defect card 361a5520 fixes: a codex session's
// first-confirmed-turn state was structurally, permanently unreadable — indistinguishable from a session
// that genuinely never started, which is what `handleKickoffGiveUpExhausted` (sessions/service.ts) reads
// this for. Post-fix (`findAnyLive`), both checks below hold.
check("hasFirstTurnStarted reads false for a live codex entry whose first turn has not yet completed", host.hasFirstTurnStarted(SESSION_ID) === false);
live.firstTurnStarted = true;
check("hasFirstTurnStarted reads true once the codex entry's own field flips (routed through findAnyLive, zero codex-specific code in the accessor itself)", host.hasFirstTurnStarted(SESSION_ID) === true);
live.firstTurnStarted = false; // restore for the rest of this file's scenarios

// --- getLastOutputAt (card a1916267) — DELIBERATELY CLAUDE-ONLY, not AGNOSTIC -----------------------
// This is the negative proof for the fix: a codex entry that is genuinely LIVE and REGISTERED must still
// read `getLastOutputAt` as undefined, exactly like the "no entry at all" case above (line 109) — the two
// are indistinguishable BY DESIGN (see that getter's own doc, pty/host.ts) because the field no longer
// exists on CodexLive at all. Before the fix this read as a real, advancing number (proven historically by
// this same file's own removed `lastOutputAt: Date.now() - 1000` fixture field and its since-removed
// assertion) — the exact bug: codex's TUI repaints continuously with no turn running, so this signal never
// discriminated "working" from "idle and finished" on this harness.
check("getLastOutputAt reads undefined for a LIVE, REGISTERED codex entry — deliberately not agnostic (card a1916267)", host.getLastOutputAt(SESSION_ID) === undefined);

// --- isAlive / isBusy -----------------------------------------------------------------------------
check("isAlive reads true for a live codex entry (routed through findAnyLive, zero codex-specific code)", host.isAlive(SESSION_ID) === true);
check("isBusy reads false for an idle codex entry", host.isBusy(SESSION_ID) === false);
live.busy = true;
check("isBusy reads true once the codex entry's busy flag flips (proves this isn't cached/stale)", host.isBusy(SESSION_ID) === true);
live.busy = false;

// --- getPid / liveStartedAt -------------------------------------------------------------------------
check("getPid returns the codex pty's real pid", host.getPid(SESSION_ID) === fakePty.pid);
check("liveStartedAt returns the codex entry's startedAt while alive", host.liveStartedAt(SESSION_ID) === startedAt);
live.alive = false;
check("liveStartedAt reads null once the codex entry is no longer alive", host.liveStartedAt(SESSION_ID) === null);
live.alive = true;

// --- holdDrain / releaseDrain -----------------------------------------------------------------------
check("holdDrain sets drainHeld on a codex entry", (host.holdDrain(SESSION_ID), live.drainHeld === true));
check("releaseDrain clears drainHeld on a codex entry", (host.releaseDrain(SESSION_ID), live.drainHeld === false));

// --- markMcpSeen / waitForMcpSeen -------------------------------------------------------------------
{
  const waited = host.waitForMcpSeen(SESSION_ID, 5000);
  check("waitForMcpSeen registers a waiter (not yet resolved) before markMcpSeen fires", live.mcpSeenWaiters.length === 1);
  host.markMcpSeen(SESSION_ID);
  check("markMcpSeen flips mcpSeen true on the codex entry", live.mcpSeen === true);
  const seen = await waited;
  check("waitForMcpSeen's promise resolves true once markMcpSeen fires (not the timeout path)", seen === true);
  check("markMcpSeen drains the waiter list", live.mcpSeenWaiters.length === 0);
}

// --- The pending-queue accessor/mutator family -------------------------------------------------------
{
  const idA = randomUUID(); const idB = randomUUID();
  live.pending.push(
    { id: idA, text: "first queued turn", source: "system", kind: "agent", logicalId: idA, senderId: "mgr-1" },
    { id: idB, text: "second queued turn", source: "human", kind: "agent", logicalId: idB, senderId: null },
  );
  check("getPending returns queued texts in FIFO order for a codex entry", JSON.stringify(host.getPending(SESSION_ID)) === JSON.stringify(["first queued turn", "second queued turn"]));
  check("pendingAgentCount counts kind:'agent' entries for a codex entry", host.pendingAgentCount(SESSION_ID) === 2);
  const entries = host.getPendingEntries(SESSION_ID);
  check("getPendingEntries returns id-bearing entries (id/text/source/kind) for a codex entry", entries.length === 2 && entries[0].id === idA && entries[0].text === "first queued turn");
  const snap = host.getPersistablePendingSnapshot(SESSION_ID);
  check("getPersistablePendingSnapshot returns the texts for a codex entry", JSON.stringify(snap.texts) === JSON.stringify(["first queued turn", "second queued turn"]));

  const editResult = host.editQueued(SESSION_ID, idB, "edited human text");
  check("editQueued edits a human-authored entry for a codex entry", editResult.edited === true && live.pending[1].text === "edited human text");
  const editRefused = host.editQueued(SESSION_ID, idA, "should be refused");
  check("editQueued REFUSES an agent-authored (source:'system', kind:'agent') entry for a codex entry — trust boundary preserved with zero codex-specific code", editRefused.edited === false && editRefused.refused === true);

  // idA is source:"system"+kind:"agent" (agent-authored, NOT human-mutable per isHumanMutable) — naming it
  // in the reorder call must REFUSE the whole op (the trust-boundary guard), not reorder around it.
  const reorderRefused = host.reorderQueued(SESSION_ID, [idB, idA]);
  check("reorderQueued REFUSES the whole op when an agent-authored id is named for a codex entry — trust boundary preserved with zero codex-specific code", reorderRefused.reordered === false && reorderRefused.refused === true);
  const reorderResult = host.reorderQueued(SESSION_ID, [idB]);
  check("reorderQueued reorders mutable-only entries for a codex entry", reorderResult.reordered === true);

  const deleteResult = host.deleteQueued(SESSION_ID, idB);
  check("deleteQueued removes the named entry for a codex entry", deleteResult.deleted === true && live.pending.length === 1);

  const flushed = host.flushPending(SESSION_ID);
  check("flushPending drains and returns the remaining entry (with onDeliver-shape intact) for a codex entry", flushed.length === 1 && live.pending.length === 0);
}

// --- purgeQueuedByQuestionIds / purgeQueuedByReportEventIds / purgeQueuedWorkerIdleNudges ------------
{
  const qId = randomUUID();
  const rId = randomUUID();
  const idQ = randomUUID(); const idR = randomUUID(); const idOther = randomUUID();
  live.pending.push(
    { id: idQ, text: "question nudge", source: "system", kind: "warning", logicalId: idQ, questionId: qId },
    { id: idR, text: "report nudge", source: "system", kind: "warning", logicalId: idR, reportEventId: rId },
    { id: idOther, text: "unrelated", source: "system", kind: "warning", logicalId: idOther },
  );
  const purgedQ = host.purgeQueuedByQuestionIds(SESSION_ID, [qId]);
  check("purgeQueuedByQuestionIds removes exactly the tagged entry for a codex entry", purgedQ.length === 1 && purgedQ[0].id === idQ && live.pending.length === 2);
  const purgedR = host.purgeQueuedByReportEventIds(SESSION_ID, [rId]);
  check("purgeQueuedByReportEventIds removes exactly the tagged entry for a codex entry", purgedR.length === 1 && purgedR[0].id === idR && live.pending.length === 1);
  check("the unrelated entry survives both selective purges (FIFO-preserving, non-destructive scan)", live.pending[0].id === idOther);
  host.consumePending(SESSION_ID); // clean up for the next block
}

// --- consumePending ---------------------------------------------------------------------------------
{
  const id = randomUUID();
  live.pending.push({ id, text: "to consume", source: "system", kind: "agent", logicalId: id });
  const consumed = host.consumePending(SESSION_ID);
  check("consumePending returns queued texts AND clears the queue for a codex entry", JSON.stringify(consumed) === JSON.stringify(["to consume"]) && live.pending.length === 0);
}

// --- subscribe --------------------------------------------------------------------------------------
{
  const onDataCalls = []; const onControlCalls = [];
  const unsubscribe = host.subscribe(SESSION_ID, { onData: (b) => onDataCalls.push(b), onControl: (c) => onControlCalls.push(c) });
  check("subscribe replays the ring buffer immediately on attach for a codex entry", onDataCalls.length === 1 && onDataCalls[0].toString() === "hello codex");
  check("subscribe sends a sessionId control frame (engineSessionId) for a codex entry", onControlCalls.some((c) => c.type === "sessionId" && c.id === "engine-abc"));
  check("subscribe sends a geometry control frame for a codex entry", onControlCalls.some((c) => c.type === "geometry" && c.cols === 120 && c.rows === 40));
  check("subscribe actually registers the subscriber on the codex entry", live.subscribers.size === 1);
  unsubscribe();
  check("the returned unsubscribe function removes the subscriber from the codex entry", live.subscribers.size === 0);
}

// --- getActiveTurn*/getRecentOwnerTurns/getActiveTurnSenderId family ---------------------------------
{
  live.activeTurnRoute = { channel: "test-chat", chatId: "c1" };
  live.activeTurnProactive = true;
  live.activeTurnOwnerText = "the literal owner bytes";
  live.recentOwnerTurns = ["turn one", "turn two"];
  live.activeTurnSenderId = "sender-xyz";
  check("getActiveTurnOrigin reads the codex entry's activeTurnRoute", JSON.stringify(host.getActiveTurnOrigin(SESSION_ID)) === JSON.stringify(live.activeTurnRoute));
  check("getActiveTurnIsProactive reads true for a codex entry", host.getActiveTurnIsProactive(SESSION_ID) === true);
  check("getActiveTurnOwnerText reads the codex entry's owner text", host.getActiveTurnOwnerText(SESSION_ID) === "the literal owner bytes");
  check("getRecentOwnerTurns reads the codex entry's recent-turns window", JSON.stringify(host.getRecentOwnerTurns(SESSION_ID)) === JSON.stringify(["turn one", "turn two"]));
  check("getActiveTurnSenderId reads the codex entry's sender id", host.getActiveTurnSenderId(SESSION_ID) === "sender-xyz");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the 'zero extra code for agnostic methods' claim (lead ruling #3, condition 2) is PROVEN, not merely asserted from inspection: a codex-kind live entry, registered directly in PtyHost's own liveCodex map with no real spawn, drives every pinned AGNOSTIC method (isAlive/isBusy/getPid/liveStartedAt/holdDrain/releaseDrain/markMcpSeen/waitForMcpSeen/the full pending-queue family/subscribe/the getActiveTurn* family) correctly through findAnyLive with zero codex-specific code in any of them — and, checked FIRST as the negative control, every one of those same accessors reads as genuinely ABSENT (undefined/null/false/[]), never a measured zero, for a sessionId with no live entry at all in either registry. `getLastOutputAt` (card a1916267) is proven the OPPOSITE way, deliberately: still undefined even for a live, registered codex entry, because it's reclassified CLAUDE-ONLY."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
