import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a419a7e6 — the DECIDED content-gate for the durable `prompt_mismatch_unresolved` orchestration
// event. HERMETIC — no daemon, no real claude, no real pty (calls SessionService.
// handlePromptMismatchUnresolved directly with a hand-built info object, mirroring
// give-up-exhausted-durable.mjs's own SessionService+PtyStub harness).
//
// THE DECISION UNDER TEST (see sessions/service.ts's own doc on handlePromptMismatchUnresolved, and this
// card's own board body): `detail.messageExcerpt` is gated behind the SAME `LOOM_LOG_MESSAGE_CONTENT` flag
// every other raw-text diagnostic in this codebase uses (isLogMessageContentEnabled, paths.ts) —
//   - flag OFF (default): the durable row carries NO messageExcerpt key at all (omitted, not an empty
//     string / not a redacted placeholder) — BYTE-IDENTICAL to the row shape that shipped before this card.
//   - flag ON: the durable row carries messageExcerpt verbatim as PtyHost supplied it (already bounded by
//     PROMPT_MISMATCH_EXCERPT_MAX_LEN upstream — this method never re-slices).
// Both polarities are exercised in the SAME process (isLogMessageContentEnabled reads its env var at CALL
// time — see that function's own doc — so no subprocess/module-reload dance is needed). This is the
// MANDATORY other-direction control per the card's own DoD-2 note: a test proving only the ON path is
// exactly what a broken (always-on, or always-off) gate would also pass.
//
// Also proves the length/hash BACKBONE (gen/writtenHash/reportedHash/intendedLen/recognizedGen/matchedLen/
// leadingRemainderLen/trailingRemainderLen) is UNAFFECTED by the flag either way — out of scope for this
// card to touch (CLAUDE.md: "the LENGTH/HASH backbone ... is OUT OF SCOPE and must not be gated off").
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/prompt-mismatch-unresolved-excerpt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js/service.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-excerpt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Start OFF — isLogMessageContentEnabled is read at CALL time, so this can be flipped mid-test.
delete process.env.LOOM_LOG_MESSAGE_CONTENT;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Minimal contract-faithful PtyStub — this test never exercises delivery, only the durable appendEvent
// this method fires BEFORE any enqueueSystemNudge call, so "delivered" is enough to keep the recipient/
// sender nudge dispatch below from touching a durable queued-message record we don't care about here.
// Card 87d2dc95 DoD-4: ALSO records every enqueued text (by sessionId), so PART 4 below can assert on the
// actual recipient/sender wording, not just the durable event's own structured fields (PARTs 1-3's scope).
class PtyStub {
  enqueued = [];
  enqueueStdin(sessionId, text) { this.enqueued.push({ sessionId, text }); return { delivered: true }; }
}

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `pme-proj-${sfx}`, agent = `pme-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: null,
});

const mgr = `pme-mgr-${sfx}`, wkr = `pme-wkr-${sfx}`;
mkSession({ id: mgr, role: "manager" });
mkSession({ id: wkr, role: "worker", parentSessionId: mgr });

const ptyStub = new PtyStub();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const baseInfo = {
  gen: 7, writtenHash: "deadbeef", reportedHash: "cafef00d", intendedLen: 1234,
  recognizedGen: 3, matchedLen: 999, leadingRemainderLen: 0, trailingRemainderLen: 0,
  messageExcerpt: "[loom:worker-report] the excerpt of the ORIGINAL intended text for this generation",
};

const unresolvedEventsFor = (workerId) => db.listEventsForWorker(workerId).filter((e) => e.kind === "prompt_mismatch_unresolved");

try {
  // ===== PART 1 — NEGATIVE CONTROL (flag OFF, the shipped default): no messageExcerpt key at all. =====
  {
    check("setup: flag genuinely reads OFF at call time", process.env.LOOM_LOG_MESSAGE_CONTENT !== "1");
    sessions.handlePromptMismatchUnresolved(wkr, baseInfo);
    const evs = unresolvedEventsFor(wkr);
    check("1: exactly one durable event recorded", evs.length === 1);
    const detail = evs[0]?.detail ?? {};
    check("2: flag OFF — messageExcerpt key is OMITTED entirely (not present, not an empty string)",
      !Object.prototype.hasOwnProperty.call(detail, "messageExcerpt"));
    check("3: flag OFF — the length/hash backbone is still fully present and untouched",
      detail.gen === baseInfo.gen && detail.writtenHash === baseInfo.writtenHash && detail.reportedHash === baseInfo.reportedHash
      && detail.intendedLen === baseInfo.intendedLen && detail.recognizedGen === baseInfo.recognizedGen
      && detail.matchedLen === baseInfo.matchedLen && detail.leadingRemainderLen === 0 && detail.trailingRemainderLen === 0);
  }

  // ===== PART 2 — POSITIVE CONTROL (flag ON): messageExcerpt is present, bounded, and verbatim. =====
  {
    process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
    const wkr2 = `${wkr}-on`;
    mkSession({ id: wkr2, role: "worker", parentSessionId: mgr });
    sessions.handlePromptMismatchUnresolved(wkr2, baseInfo);
    const evs = unresolvedEventsFor(wkr2);
    check("4: exactly one durable event recorded", evs.length === 1);
    const detail = evs[0]?.detail ?? {};
    check("5: flag ON — messageExcerpt is PRESENT and matches what PtyHost supplied, verbatim",
      detail.messageExcerpt === baseInfo.messageExcerpt);
    check("6: flag ON — the length/hash backbone is STILL untouched (this card never gates it)",
      detail.gen === baseInfo.gen && detail.writtenHash === baseInfo.writtenHash && detail.reportedHash === baseInfo.reportedHash
      && detail.intendedLen === baseInfo.intendedLen);
    // Card a419a7e6: this method never re-bounds the excerpt (PtyHost already bounded it via
    // PROMPT_MISMATCH_EXCERPT_MAX_LEN before this ever reaches here) — this assertion documents that
    // division of responsibility rather than re-deriving the bound here.
    check("7: sanity — the fixture excerpt itself is well under PtyHost's own bound (documents intent, doesn't re-derive it)",
      baseInfo.messageExcerpt.length < 200);
  }

  // ===== PART 3 — FLIPPING BACK OFF, SAME PROCESS: proves the gate is read live, not cached/latched from =====
  // ===== PART 1's earlier state (isLogMessageContentEnabled's own doc: "read at CALL time"). =====
  {
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    const wkr3 = `${wkr}-off-again`;
    mkSession({ id: wkr3, role: "worker", parentSessionId: mgr });
    sessions.handlePromptMismatchUnresolved(wkr3, baseInfo);
    const evs = unresolvedEventsFor(wkr3);
    const detail = evs[0]?.detail ?? {};
    check("8: flag flipped back OFF, same process — messageExcerpt is OMITTED again (live read, not latched)",
      !Object.prototype.hasOwnProperty.call(detail, "messageExcerpt"));
  }
  // ===== PART 4 — card 87d2dc95 DoD-4: the recipient/sender WORDING must state what is KNOWN, never a
  // causal VERDICT. The overclaiming phrases "most likely never reached it" and an unconditional "please
  // resend it" are gone — a wrong causal claim + an unconditional resend instruction is exactly what
  // pointed a real reader at the sibling duplicate-delivery defect this project spends real machinery
  // suppressing (see this card's own board body). =====
  {
    const wkr4 = `${wkr}-wording`;
    mkSession({ id: wkr4, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnresolved(wkr4, baseInfo);
    const recipientMsg = ptyStub.enqueued.find((e) => e.sessionId === wkr4)?.text ?? "";
    const senderMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("9: setup — both a recipient and a sender message were actually enqueued", recipientMsg.length > 0 && senderMsg.length > 0);
    check("10: the SENDER message no longer asserts the causal verdict \"most likely never reached it\"",
      !senderMsg.includes("most likely never reached it"));
    check("11: the SENDER message no longer issues an UNCONDITIONAL \"please resend it\" (softened to a conditional, duplicate-aware ask)",
      !senderMsg.includes("please resend it"));
    check("12: the SENDER message instead states what is KNOWN — no later generation's own submission was recognized as containing it",
      senderMsg.includes("no later generation's own submission was ever recognized as containing it"));
    check("13: the RECIPIENT message states the same KNOWN fact (no later confirmation was recognized), not a verdict about cause",
      recipientMsg.includes("No later generation's own confirmation was ever recognized as containing this content"));
    check("14: sanity — neither message dropped the underlying gen/hash identity a reader needs to locate the event",
      recipientMsg.includes(`gen=${baseInfo.gen}`) && senderMsg.includes(`gen=${baseInfo.gen}`));
  }
} finally {
  delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card a419a7e6's decided content-gate holds both directions: with LOOM_LOG_MESSAGE_CONTENT OFF (the shipped default) the durable prompt_mismatch_unresolved row's detail carries NO messageExcerpt key at all — byte-identical to before this card — and with it ON the row carries the bounded excerpt PtyHost supplied, verbatim; the length/hash backbone is untouched by the flag in either direction, and the gate is read live (not latched) within a single process. Card 87d2dc95 DoD-4: the recipient/sender notice wording no longer asserts the causal verdict \"most likely never reached it\" nor an unconditional \"please resend it\" — both messages instead state what is KNOWN (no later generation's own confirmation was ever recognized as containing the content) while keeping the gen/hash identity a reader needs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
