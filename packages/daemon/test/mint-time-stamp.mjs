// Regression test for card 21a281b6 — stamp delivered agent-message frames (peer_message, session_message,
// worker_message, and their :redirect variants) with a daemon-supplied absolute UTC mint time, WITHOUT
// corrupting the give-up/resend content-matching machinery those same frames flow through.
//
// COVERS:
//   (A) worker_message: a message delivered on its OWN FIRST write carries NO mint-time stamp — a
//       deliberate, documented trade-off (see annotateMintStamp's own doc, pty/host.ts): the ambiguous-
//       match signature (hasAmbiguousMatch, card 4a0af485) is seeded from a message's first write, and a
//       fresh resend's pristine text could never reproduce a wall-clock value baked into that signature.
//   (B) worker_message: a message queued behind TWO intervening different-sender turns — so it drains only
//       once the submit generation has genuinely advanced past its own mint (mirroring card 788781da's
//       measured 10-15 min routine lag) — DOES carry `[loom:mint-time] Originally sent at <ISO>.`, with the
//       ISO value bounded by the real send window. (A SINGLE intervening turn is not enough to prove this:
//       `joinSubmittedText` reads the generation BEFORE its own increment, so a message that drains as the
//       very next turn after one confirmed turn still lands exactly on its own mint generation.)
//   (C) peer_message: same late-delivery stamp, PLUS the pre-existing `[loom:from-manager · … ·
//       projectId:… · sessionId:…]` frame line is byte-identical to what card 63e423cc already produces —
//       additive only, never re-ordered/re-worded (this frame is read by a peer project's real manager).
//   (D) session_message (Platform Lead, messageSessionAsPlatform): same late-delivery stamp.
//   (E) worker_redirect: the HELD (interrupting) path also carries the stamp — `interruptForRedirect`'s
//       settle clears the stale busy OUT OF BAND (mirroring healIfStuck's own out-of-band clear), which
//       advances the generation counter past the redirect's own mint on its own, so a single intervening
//       busy turn (not two full confirmed turns, unlike B/C/D) is already enough.
//   (F) DoD-4: the escalation dedupe signature (`title|severity`, companion/attention-push.ts
//       `escalationSignature`) is untouched — its exact formula (reproduced from source) ignores any extra
//       detail field by construction, so a stamp could never enter it even if one were ever added there.
//
// RUN (no daemon needed): node test/mint-time-stamp.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs = 10_000)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout), so the call below now
// goes straight to the shared `_wait.mjs` helper with an explicit options object (same timeoutMs:10_000/
// intervalMs:2 this file's own defaults used — values unchanged).

const tmpHome = path.join(os.tmpdir(), `loom-mint-stamp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// NOT end-anchored: `writtenText()` concatenates every raw write for a session (bracket-paste markers,
// "enter" key writes, and later turns too), so the stamp is never at the literal end of that whole buffer.
const MINT_RE = /\[loom:mint-time\] Originally sent at (\S+)\./;

/** Per-session write capture, keyed by sessionId (createPty's own opts carry it). */
class CapturingHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.writesById = new Map(); }
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    this.writesById.set(opts.sessionId, writes);
    return Object.assign(base, { write: (d) => { writes.push(d); } });
  }
  /** The raw concatenation of every write ever made for this session (bracket-paste markers, "enter" key
   *  writes, and every turn's own chunk, all run together) — usually NOT what a test wants directly; see
   *  {@link lastPastedChunk}. */
  writtenText(sessionId) { return (this.writesById.get(sessionId) ?? []).join(""); }
}

/** Real writes wrap each turn's own submitted text in bracketed-paste markers (`ESC[200~ … ESC[201~`) —
 *  extracts the content of the LAST such bracket pair, i.e. the most recently drained turn's own chunk,
 *  cutting out every earlier turn's own filler content and the enter/reassert control writes around it. */
function lastPastedChunk(writtenText) {
  const matches = [...writtenText.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

const busyLog = {};
const host = new CapturingHost({
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
});
const db = new Db();
const sessions = new SessionService(db, host, new OrchestrationControl());

function spawnLive(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

/** Confirms the CURRENTLY running turn cleanly (no give-up). Entirely synchronous — a confirmed
 *  turn's Stop hook drains any next entry (if present) in the SAME call, so awaiting a busy-false
 *  transition here would wrongly block until THAT next entry also somehow resolves. */
function confirmAndEnd(sessionId) {
  host.deliverHook(sessionId, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(sessionId, { hook_event_name: "Stop" });
}

/**
 * Enqueues `sendFn()`'s target message behind TWO intervening, different-sender, cleanly-confirmed turns
 * before finally letting it drain — see this file's own header comment for why ONE intervening turn is not
 * enough to push `currentGen` past the target's own `mintedAtGen` (drainPending reads the generation BEFORE
 * its own increment, so a message enqueued during turn N and drained as turn N+1 still lands exactly on its
 * own mint generation). `sessionId` must be IDLE when called.
 */
function delayedSend(sessionId, sendFn) {
  host.enqueueStdin(sessionId, "FILLER_TURN_1", "system", undefined, undefined, "agent"); // turn N (immediate)
  host.enqueueStdin(sessionId, "FILLER_TURN_2", "system", undefined, undefined, "agent"); // queued, ahead of target
  const targetSendAt = Date.now();
  const result = sendFn(); // target enqueued while turn N is busy -> HELD, mintedAtGen = N
  confirmAndEnd(sessionId); // ends turn N -> drains FILLER_TURN_2 as turn N+1 (target still queued, different sender)
  confirmAndEnd(sessionId); // ends turn N+1 -> drains target as turn N+2 (currentGen = N+1 > mintedAtGen = N)
  const targetRecvAt = Date.now();
  return { result, targetSendAt, targetRecvAt };
}

try {
  // ============================================================================================================
  // (A) + (B) worker_message
  // ============================================================================================================
  {
    const projId = `mts-wm-${sfx}`, agentId = `mts-wm-ag-${sfx}`, mgrId = `mts-wm-mgr-${sfx}`, wkrId = `mts-wm-wkr-${sfx}`;
    db.insertProject({ id: projId, name: projId, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    db.insertSession({ id: wkrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });
    spawnLive(wkrId);

    // (A) IMMEDIATE: worker idle -> delivered as its own first write. No mint-time stamp.
    const rA = sessions.messageWorker(mgrId, wkrId, "IMMEDIATE_DIRECTIVE");
    check("(A) setup: delivered immediately (worker was idle)", rA.delivered === true);
    const chunkA = lastPastedChunk(host.writtenText(wkrId));
    check("(A) an immediate (first-write) delivery carries NO mint-time stamp (protects hasAmbiguousMatch)",
      chunkA.includes("IMMEDIATE_DIRECTIVE") && !chunkA.includes("[loom:mint-time]"));
    confirmAndEnd(wkrId);

    // (B) DELAYED: two intervening confirmed turns behind the target.
    const { result: rB, targetSendAt, targetRecvAt } = delayedSend(wkrId, () => sessions.messageWorker(mgrId, wkrId, "DELAYED_DIRECTIVE"));
    check("(B) setup: the target directive was HELD (busy) when sent", rB.delivered === false);

    const chunkB = lastPastedChunk(host.writtenText(wkrId));
    const m = chunkB.match(MINT_RE);
    check("(B) a delivery delayed past its own mint generation DOES carry the mint-time stamp",
      chunkB.includes("DELAYED_DIRECTIVE") && !!m);
    if (m) {
      const mintedMs = Date.parse(m[1]);
      check("(B) the stamped time is an absolute ISO-8601 UTC timestamp bounded by the real send window",
        !Number.isNaN(mintedMs) && mintedMs >= targetSendAt - 5 && mintedMs <= targetRecvAt + 5);
    }
  }

  // ============================================================================================================
  // (C) peer_message — same late-delivery stamp, plus the pre-existing frame prefix stays byte-identical.
  // ============================================================================================================
  {
    const projA = `mts-pm-a-${sfx}`, agentA = `mts-pm-a-ag-${sfx}`, mgrA = `mts-pm-a-mgr-${sfx}`;
    const projB = `mts-pm-b-${sfx}`, agentB = `mts-pm-b-ag-${sfx}`, mgrB = `mts-pm-b-mgr-${sfx}`;
    db.insertProject({ id: projA, name: "Project A", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: projB, name: "Project B", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentA, projectId: projA, name: "t", startupPrompt: "", position: 0 });
    db.insertAgent({ id: agentB, projectId: projB, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrA, projectId: projA, agentId: agentA, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    db.insertSession({ id: mgrB, projectId: projB, agentId: agentB, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    db.createProjectLink(projA, projB);
    spawnLive(mgrB);

    const { result: rC } = delayedSend(mgrB, () => sessions.messagePeerManager(mgrA, projB, "PEER_DELAYED_DIRECTIVE"));
    check("(C) setup: the peer message was queued (target manager busy) when sent", rC.deliveryStatus === "queued");

    const chunkC = lastPastedChunk(host.writtenText(mgrB));
    const prefixMatch = chunkC.match(/^\[loom:from-manager · Project A · projectId:(\S+) · sessionId:(\S+)\]\n/);
    check("(C) the pre-existing peer_message frame prefix is byte-identical (projectId + sessionId stamped, untouched)",
      !!prefixMatch && prefixMatch[1] === projA && prefixMatch[2] === mgrA);
    check("(C) a delayed peer_message ALSO carries the mint-time stamp", MINT_RE.test(chunkC) && chunkC.includes("PEER_DELAYED_DIRECTIVE"));
  }

  // ============================================================================================================
  // (D) session_message (Platform Lead) — same late-delivery stamp.
  // ============================================================================================================
  {
    const projId = `mts-sm-${sfx}`, agentId = `mts-sm-ag-${sfx}`, sessId = `mts-sm-sess-${sfx}`;
    db.insertProject({ id: projId, name: projId, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: sessId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    spawnLive(sessId);

    const { result: rD } = delayedSend(sessId, () => sessions.messageSessionAsPlatform(sessId, "PLATFORM_DELAYED_DIRECTIVE", "platform-lead-fake"));
    check("(D) setup: the session_message was queued (target session busy) when sent", rD.deliveryStatus === "queued");

    const chunkD = lastPastedChunk(host.writtenText(sessId));
    check("(D) the [loom:from-platform] tag line + mint stamp are both present on a delayed session_message",
      chunkD.includes("[loom:from-platform]\n") && MINT_RE.test(chunkD) && chunkD.includes("PLATFORM_DELAYED_DIRECTIVE"));
  }

  // ============================================================================================================
  // (E) worker_redirect — the HELD (interrupting) path. `interruptForRedirect`'s settle clears the stale
  //     busy OUT OF BAND (no confirming Stop hook), which — like `healIfStuck`'s own out-of-band clear —
  //     advances `submitGeneration` past the redirect's own mint generation, so even a SINGLE intervening
  //     busy turn is enough (unlike (B)/(C)/(D), which need two full confirmed turns): the redirect's own
  //     drain reads `currentGen` past its own `mintedAtGen` on this path alone.
  // ============================================================================================================
  {
    const projId = `mts-rd-${sfx}`, agentId = `mts-rd-ag-${sfx}`, mgrId = `mts-rd-mgr-${sfx}`, wkrId = `mts-rd-wkr-${sfx}`;
    db.insertProject({ id: projId, name: projId, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
    db.insertSession({ id: wkrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });
    spawnLive(wkrId);

    host.enqueueStdin(wkrId, "KEEP_BUSY", "system", undefined, undefined, "agent");
    check("(E) setup: worker is busy on an unrelated turn", busyLog[wkrId]?.at(-1) === true);
    const rE = sessions.redirectWorker(mgrId, wkrId, "REDIRECT_DIRECTIVE");
    check("(E) setup: the redirect is HELD (busy -> interrupting)", rE.delivered === false && rE.interrupting === true);
    // The interrupt settle timer clears the (now stale) busy and drains the redirect as its own turn.
    await sharedWaitUntil(() => lastPastedChunk(host.writtenText(wkrId)).includes("REDIRECT_DIRECTIVE"), { timeoutMs: 10_000, intervalMs: 2 });

    const chunkE = lastPastedChunk(host.writtenText(wkrId));
    check("(E) a HELD worker_redirect carries the mint-time stamp (the interrupt settle's own generation bump is enough)",
      chunkE.includes("REDIRECT_DIRECTIVE") && MINT_RE.test(chunkE));
  }

  // ============================================================================================================
  // (F) DoD-4: the escalation dedupe signature ignores any extra detail field by construction.
  // ============================================================================================================
  {
    // Reproduces companion/attention-push.ts's private `escalationSignature` EXACTLY (title|severity, no
    // other field ever read) — proving an injected mint-time-shaped field could never change the signature
    // even if one somehow reached this detail object (it does not: platformEscalate/appendEscalationDetail
    // are untouched by this card's diff — verified separately, not re-derivable from this pure function).
    const escalationSignature = (detail) => {
      const d = detail ?? {};
      const title = typeof d.title === "string" ? d.title : "";
      const severity = typeof d.severity === "string" ? d.severity : "";
      return `${title}|${severity}`;
    };
    const clean = { title: "Something broke", severity: "high" };
    const withLeakedStamp = { title: "Something broke", severity: "high", mintedAtWallClock: Date.now(), mintTime: new Date().toISOString() };
    check("(F) DoD-4: two escalation details sharing title+severity produce an IDENTICAL signature, even when one carries extra mint-time-shaped fields a leak might have added",
      escalationSignature(clean) === escalationSignature(withLeakedStamp));
    check("(F) DoD-4 negative control: a genuinely DIFFERENT title/severity pair produces a DIFFERENT signature (the check above isn't vacuous)",
      escalationSignature(clean) !== escalationSignature({ title: "Something else broke", severity: "high" }));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message/peer_message/session_message/worker_redirect all stamp a delayed delivery with a daemon-supplied `[loom:mint-time] Originally sent at <ISO>.`, an immediate (first-write) delivery stays unannotated (protecting hasAmbiguousMatch's resend auto-join), the peer_message frame's pre-existing tag line is byte-identical, and the escalation dedupe signature ignores any extra detail field by construction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
