import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 38d68b8d — DoD-2 of `59757189`: push an UNMATCHABLE prompt-mismatch's own captured intended text
// (or, with the content flag off, its length+hash signature) to the SENDER/parent — the party who can
// actually tell whether their content arrived, per card `68459420`'s "a recipient can never self-diagnose"
// rationale. `25f31381` ruled the existing PULL surface (`getLastMismatchUnmatched`, shipped by `59757189`
// DoD-1/3) does NOT obviate this push: a pull surface only helps someone who already suspects a mismatch.
//
// HERMETIC — no daemon, no real claude, no real pty (calls SessionService.handlePromptMismatchUnmatched
// directly with a hand-built info object, mirroring prompt-mismatch-unresolved-excerpt.mjs's own harness).
//
// THE DECISION UNDER TEST (see sessions/service.ts's own doc on handlePromptMismatchUnmatched, and card
// 38d68b8d's own board body): the NOTIFICATION always fires (the FACT — gen/intendedLen/writtenHash/
// reportedHash are unconditional), but the raw intended TEXT is gated behind the SAME LOOM_LOG_MESSAGE_
// CONTENT flag (isLogMessageContentEnabled, paths.ts) every other content-bearing diagnostic uses:
//   - flag OFF (default): the sender message states intendedLen + writtenHash/reportedHash, but never the
//     raw intended text.
//   - flag ON: the sender message carries the intended text verbatim.
// Both polarities are exercised in the SAME process (isLogMessageContentEnabled reads its env var at CALL
// time) — the MANDATORY other-direction control per this project's standing verification posture: a test
// proving only the ON path is exactly what a broken (always-on, or always-off) gate would also pass.
//
// Also proves: (a) no push at all when the session has no parent (nobody to tell — the pull surface still
// stands); (b) the push targets ONLY the parent, never the mismatched session itself (that session already
// got its own recipient-facing [loom:prompt-mismatch] notice via a separate code path in pty/host.ts, out
// of scope here); (c) intendedLen is stated explicitly regardless of the flag, per this card's own DoD-1.
//
// Card d1ac9fed (2026-09-23): `info.escalation` now discriminates TWO distinct uses of this method —
// `"single-event"` (PARTS 1-5, unchanged behavior — a `fallback-unrecognized` ABOVE the small-bucket
// magnitude bound, or arm-branched wording for the two benign offset arms, which no longer reach this
// method in PRODUCTION via pty/host.ts's own gating but whose wording is deliberately kept and still
// tested here since the method itself retains that logic byte-for-byte) and `"rate-exceeded"` (NEW, PART
// 6 — a small `fallback-unrecognized` that crossed the rate threshold, worded as a RATE, never a single
// event). See PtyHostEvents.onPromptMismatchUnmatched's own doc (pty/host.ts) for the full contract.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/prompt-mismatch-unmatched-push.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME BEFORE importing db.js/service.js (paths.ts reads it at import time).
const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-unmatched-push-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Start OFF — isLogMessageContentEnabled is read at CALL time, so this can be flipped mid-test.
delete process.env.LOOM_LOG_MESSAGE_CONTENT;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PROMPT_MISMATCH_UNMATCHED_NOTICE_TAG, PROMPT_MISMATCH_UNRESOLVED_NOTICE_TAG } = await import("../dist/pty/host.js");

// Minimal contract-faithful PtyStub — same shape prompt-mismatch-unresolved-excerpt.mjs already uses:
// this test only exercises the enqueueSystemNudge -> enqueueDurableMessage -> pty.enqueueStdin path.
class PtyStub {
  enqueued = [];
  enqueueStdin(sessionId, text) { this.enqueued.push({ sessionId, text }); return { delivered: true }; }
}

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `pmu-proj-${sfx}`, agent = `pmu-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: null,
});

const mgr = `pmu-mgr-${sfx}`;
mkSession({ id: mgr, role: "manager" });

const ptyStub = new PtyStub();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const baseInfo = {
  gen: 4, writtenHash: "cafebabe", reportedHash: "12345678", intendedLen: 987,
  intendedText: "[loom:from-manager] the ORIGINAL intended text Loom wrote for this generation, never matched",
  detectedAt: Date.now(),
  // Card d1ac9fed: PARTS 1-5 exercise the "single-event" branch (the pre-card behavior, unchanged) —
  // unaccountedIntended is carried by the real contract but unused by this branch's own wording.
  escalation: "single-event", unaccountedIntended: 900,
};

try {
  // ===== PART 1 — NEGATIVE CONTROL (flag OFF, the shipped default): the sender is told the FACT but never =====
  // ===== the raw content. =====
  {
    check("setup: flag genuinely reads OFF at call time", process.env.LOOM_LOG_MESSAGE_CONTENT !== "1");
    const wkr = `pmu-wkr-${sfx}-off`;
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkr, baseInfo);
    const toParent = ptyStub.enqueued.filter((e) => e.sessionId === mgr);
    check("1: exactly one message pushed to the sender/parent", toParent.length === 1);
    const senderMsg = toParent[0]?.text ?? "";
    check("2: flag OFF — the raw intended text does NOT reach the sender message", !senderMsg.includes(baseInfo.intendedText));
    check("3: flag OFF — intendedLen is still stated explicitly (DoD-1: 'alongside intendedLen')", senderMsg.includes(`${baseInfo.intendedLen}`));
    check("4: flag OFF — writtenHash/reportedHash (the signature) are still present", senderMsg.includes(baseInfo.writtenHash) && senderMsg.includes(baseInfo.reportedHash));
    check("5: the notice carries the UNMATCHED tag (not the -unresolved sibling's tag)", senderMsg.startsWith(PROMPT_MISMATCH_UNMATCHED_NOTICE_TAG));
    check("6: NEGATIVE CONTROL on the tag itself — the -unresolved sibling tag is NOT what this fired", !senderMsg.startsWith(PROMPT_MISMATCH_UNRESOLVED_NOTICE_TAG));
    check("7: the mismatched session itself gets NO push from this method (out of scope here — its own recipient notice is a separate code path)", ptyStub.enqueued.filter((e) => e.sessionId === wkr).length === 0);
  }

  // ===== PART 2 — POSITIVE CONTROL (flag ON): the sender message carries the intended text verbatim. =====
  {
    process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
    check("setup: flag genuinely reads ON at call time", process.env.LOOM_LOG_MESSAGE_CONTENT === "1");
    const wkr2 = `pmu-wkr-${sfx}-on`;
    mkSession({ id: wkr2, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkr2, baseInfo);
    const senderMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("8: flag ON — the raw intended text DOES reach the sender message, verbatim", senderMsg.includes(baseInfo.intendedText));
    check("9: flag ON — intendedLen and the hash signature are STILL present (this card never gates the backbone)", senderMsg.includes(`${baseInfo.intendedLen}`) && senderMsg.includes(baseInfo.writtenHash));
  }

  // ===== PART 3 — FLIPPING BACK OFF, SAME PROCESS: proves the gate is read live, not cached/latched from ======
  // ===== PART 2's earlier state (isLogMessageContentEnabled's own doc: "read at CALL time"). =====
  {
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    const wkr3 = `pmu-wkr-${sfx}-off-again`;
    mkSession({ id: wkr3, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkr3, baseInfo);
    const senderMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("10: flag flipped back OFF, same process — the raw text is omitted again (live read, not latched)", !senderMsg.includes(baseInfo.intendedText));
  }

  // ===== PART 4 — NO PARENT: nobody to push to. The notification must NOT fire at all (the pull surface, =====
  // ===== not exercised by this method, still stands as the only surface). =====
  {
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(mgr, baseInfo); // mgr itself has no parentSessionId
    check("11: a session with no parent gets no push at all — a silent no-op, mirroring handlePromptMismatchUnresolved/handlePasteTripwireGiveUp's own shape", ptyStub.enqueued.length === 0);
  }

  // ===== PART 5 — Card 1a315058 SCOPE EXTENSION: `info.arm` branches this message so it stops contradicting
  // ===== the SAME event's session-facing notice. Before this card, EVERY arm reaching this method (including
  // ===== the two already-benign offset shapes) was told "a possible LOSS" here while the session itself was
  // ===== told "NOT A LOSS" about the identical detection — one event, two contradictory verdicts. =====
  {
    const wkrBenign = `pmu-wkr-${sfx}-benign-insertion`;
    mkSession({ id: wkrBenign, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkrBenign, { ...baseInfo, arm: "fallback-benign-offset-insertion" });
    const benignInsertionMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("12: arm=fallback-benign-offset-insertion — the sender message now says NOT A LOSS, matching the session-facing notice (card 1a315058)",
      /NOT A LOSS/.test(benignInsertionMsg) && !/a possible LOSS/.test(benignInsertionMsg));

    const wkrBenignOmission = `pmu-wkr-${sfx}-benign-omission`;
    mkSession({ id: wkrBenignOmission, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkrBenignOmission, { ...baseInfo, arm: "fallback-benign-offset-omission" });
    const benignOmissionMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("13: arm=fallback-benign-offset-omission — the sender message ALSO says NOT A LOSS (card 1a315058)",
      /NOT A LOSS/.test(benignOmissionMsg) && !/a possible LOSS/.test(benignOmissionMsg));

    // NEGATIVE CONTROL — the genuinely-unrecognized arm keeps the "possible LOSS" wording, proving the
    // branch is arm-SPECIFIC, not a blanket softening of every message this method sends.
    const wkrUnrecognized = `pmu-wkr-${sfx}-unrecognized`;
    mkSession({ id: wkrUnrecognized, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    sessions.handlePromptMismatchUnmatched(wkrUnrecognized, { ...baseInfo, arm: "fallback-unrecognized" });
    const unrecognizedMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("14: NEGATIVE CONTROL — arm=fallback-unrecognized keeps 'a possible LOSS' (card 1a315058 only softens the two benign offset arms)",
      /a possible LOSS/.test(unrecognizedMsg) && !/NOT A LOSS/.test(unrecognizedMsg));
  }

  // ===== PART 6 — Card d1ac9fed: the NEW "rate-exceeded" branch, discriminated by info.escalation. Must
  // word the message as a RATE (naming count + window), NEVER a single isolated event, and must NOT use
  // either single-event wording ("a possible LOSS"/"NOT A LOSS"). =====
  {
    const wkrRate = `pmu-wkr-${sfx}-rate`;
    mkSession({ id: wkrRate, role: "worker", parentSessionId: mgr });
    ptyStub.enqueued.length = 0;
    const rateInfo = { ...baseInfo, arm: "fallback-unrecognized", escalation: "rate-exceeded", count: 3, windowMs: 30 * 60 * 1000 };
    delete rateInfo.unaccountedIntended; // not part of the rate-exceeded shape
    sessions.handlePromptMismatchUnmatched(wkrRate, rateInfo);
    const rateMsg = ptyStub.enqueued.find((e) => e.sessionId === mgr)?.text ?? "";
    check("15: exactly one message pushed for the rate escalation", ptyStub.enqueued.filter((e) => e.sessionId === mgr).length === 1);
    check("15: the message states RATE EXCEEDED and names the count precisely ('had 3 ... event(s)')", /RATE EXCEEDED/.test(rateMsg) && /had 3 \S+ event\(s\)/.test(rateMsg));
    check("15: the message names the window in minutes (30, from windowMs=1800000)", /30 minute/.test(rateMsg));
    check("15: NEGATIVE CONTROL — neither single-event wording appears (this is a RATE message, not a per-event one)",
      !/a possible LOSS of/.test(rateMsg) && !/NOT A LOSS: Loom's own reconciliation/.test(rateMsg));
    check("15: the notice carries the UNMATCHED tag", rateMsg.startsWith(PROMPT_MISMATCH_UNMATCHED_NOTICE_TAG));
    check("15: intendedLen and the hash signature are still present (the most-recent-occurrence fields)",
      rateMsg.includes(`${baseInfo.intendedLen}`) && rateMsg.includes(baseInfo.writtenHash) && rateMsg.includes(baseInfo.reportedHash));
  }
} finally {
  delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 38d68b8d's push to the sender/parent fires unconditionally (the FACT: gen/intendedLen/writtenHash/reportedHash) while the raw intended TEXT is gated behind LOOM_LOG_MESSAGE_CONTENT (default OFF, opt-in ON), read live within a single process; a session with no parent gets no push at all, and the mismatched session itself is never a recipient of this particular notice. Card d1ac9fed: info.escalation now discriminates two wordings — 'single-event' (the pre-card behavior, unchanged, including the arm-branched NOT-A-LOSS wording for the two benign offset arms even though they no longer reach this method in production) and 'rate-exceeded' (new — words the message as a RATE, count+window, never a single isolated event)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
