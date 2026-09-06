// Hermetic unit test for the DECISION INBOX pure helpers (card 8701bdbb, child B). The state-chip
// tone/label, the watchdog derivation, the relative-age formatter, and the attention-row text all live
// in src/lib/questions.ts (JSX-free) so both the components and lib/attention import ONE source — this
// test can't drift from what ships. Run:
//   node --experimental-strip-types packages/web/test/questions.mjs
import assert from "node:assert/strict";
import {
  DECISION_WATCHDOG_MS, relativeAge, isDecisionWatchdog, questionStateChip, decisionAttentionText,
  requestAttentionLabel, requestOutcome,
  requestFilerLabel, requestRoutedLabel, requestProvenanceText,
} from "../src/lib/questions.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const NOW = Date.parse("2026-07-08T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

check("relativeAge formats now / minutes / hours / days", () => {
  assert.equal(relativeAge(ago(0), NOW), "now");
  assert.equal(relativeAge(ago(4 * 60_000), NOW), "4m ago");
  assert.equal(relativeAge(ago(3 * 3_600_000), NOW), "3h ago");
  assert.equal(relativeAge(ago(2 * 86_400_000), NOW), "2d ago");
  assert.equal(relativeAge(null, NOW), "");
  assert.equal(relativeAge("not-a-date", NOW), "");
});

check("pending → cyan PENDING", () => {
  const c = questionStateChip({ state: "pending", answeredAt: null }, NOW);
  assert.equal(c.tone, "cyan");
  assert.equal(c.label, "PENDING");
});

check("consumed → muted CONSUMED ✓", () => {
  const c = questionStateChip({ state: "consumed", answeredAt: ago(10 * 60_000) }, NOW);
  assert.equal(c.tone, "muted");
  assert.equal(c.label, "CONSUMED ✓");
});

check("answered under the threshold → muted ANSWERED (not watchdog)", () => {
  const q = { state: "answered", answeredAt: ago(DECISION_WATCHDOG_MS - 60_000) };
  assert.equal(isDecisionWatchdog(q, NOW), false);
  const c = questionStateChip(q, NOW);
  assert.equal(c.tone, "muted");
  assert.equal(c.label, "ANSWERED");
});

check("answered PAST the threshold → amber WAITING ON MGR (watchdog re-escalation)", () => {
  const q = { state: "answered", answeredAt: ago(DECISION_WATCHDOG_MS + 60_000) };
  assert.equal(isDecisionWatchdog(q, NOW), true);
  const c = questionStateChip(q, NOW);
  assert.equal(c.tone, "amber");
  assert.equal(c.label, "WAITING ON MGR");
});

check("a pending question is never a watchdog, even if 'old'", () => {
  assert.equal(isDecisionWatchdog({ state: "pending", answeredAt: null }, NOW), false);
});

// question_cancel + dismiss (card feat(orchestration): question_cancel + dismiss) — the fourth terminal
// state, reachable only from pending, never confusable with an actual answer.
check("cancelled → red CANCELLED (never confusable with the muted answered/consumed states)", () => {
  const c = questionStateChip({ state: "cancelled", answeredAt: null }, NOW);
  assert.equal(c.tone, "red");
  assert.equal(c.label, "CANCELLED");
});

check("a cancelled question is never a watchdog either", () => {
  assert.equal(isDecisionWatchdog({ state: "cancelled", answeredAt: null }, NOW), false);
});

check("requestOutcome: a cancelled request reads 'cancelled' + its reason, checked BEFORE the per-type switch", () => {
  assert.equal(
    requestOutcome({ type: "decision", chosenOption: null, note: null, state: "cancelled", cancelledReason: "superseded by a fresher ask" }),
    "cancelled · superseded by a fresher ask",
  );
  // no reason given → still reads "cancelled", never falls through to the type-specific "—"/answer text.
  assert.equal(
    requestOutcome({ type: "decision", chosenOption: null, note: null, state: "cancelled", cancelledReason: null }),
    "cancelled",
  );
  // a cancelled PERMISSION must never read "denied" (chosenOption is null, never a real answer).
  assert.equal(
    requestOutcome({ type: "permission", chosenOption: null, note: null, state: "cancelled", cancelledReason: null }),
    "cancelled",
  );
  // a cancelled CREDENTIAL must never claim "provided".
  assert.equal(
    requestOutcome({ type: "credential", chosenOption: null, note: null, state: "cancelled", cancelledReason: "no longer needed" }),
    "cancelled · no longer needed",
  );
});

// Card 5b22b262 — the attention row carries the CURRENT ROUTING TARGET ("who will act on this"),
// FRAMED as a destination. The old `mgr <id8>` read as the ASKER while carrying a mutable id, so it
// misattributed the ask after any recycle. Compact surface ⇒ one id, deliberately, not both.
check("decisionAttentionText: routed to mgr <id8> · <project> — <title>", () => {
  assert.equal(
    decisionAttentionText({ sessionId: "7a3f91c2aaaa", title: "Rate-limit strategy", projectName: "Loom" }),
    "routed to mgr 7a3f91c2 · Loom — Rate-limit strategy",
  );
  // no project name → still renders the routing target + title
  assert.equal(
    decisionAttentionText({ sessionId: "b2d40f18bbbb", title: "Protected main" }),
    "routed to mgr b2d40f18 — Protected main",
  );
});

// Card 5b22b262 — provenance vs routing. `filedBySessionId` is the IMMUTABLE filer; `sessionId` is the
// MUTABLE routing target (reparentQuestions rewrites it on every recycle). The inbox shows BOTH.
check("requestFilerLabel: the immutable filer, and an explicit UNKNOWN for a legacy null", () => {
  assert.equal(requestFilerLabel({ filedBySessionId: "d3d3faf4dead" }), "filed by d3d3faf4");
  // ⛔ a legacy row must read as explicitly unknown — NEVER a fallback to sessionId, which is the bug.
  assert.equal(requestFilerLabel({ filedBySessionId: null }), "filer unknown");
});

check("requestRoutedLabel: the current routing target, framed as a destination", () => {
  assert.equal(requestRoutedLabel({ sessionId: "a3f48a8fbeef" }), "now routed to a3f48a8f");
});

check("requestProvenanceText: BOTH ids, in the owner's own form", () => {
  // The diverged case this card exists for — a row filed by one seat, since reparented onto another.
  assert.equal(
    requestProvenanceText({ filedBySessionId: "d3d3faf4dead", sessionId: "a3f48a8fbeef" }),
    "filed by d3d3faf4 · now routed to a3f48a8f",
  );
  // A legacy row still shows the routing target — only the FILER half is unknown.
  assert.equal(
    requestProvenanceText({ filedBySessionId: null, sessionId: "a3f48a8fbeef" }),
    "filer unknown · now routed to a3f48a8f",
  );
  // ⛔ The unrecycled case still renders BOTH: they are separate facts, and a one-id rendering could
  // never reveal a divergence. The repeated id is the point — it is what makes a LATER split legible.
  assert.equal(
    requestProvenanceText({ filedBySessionId: "7a3f91c2aaaa", sessionId: "7a3f91c2aaaa" }),
    "filed by 7a3f91c2 · now routed to 7a3f91c2",
  );
});

check("requestAttentionLabel: type-aware global attention label, per Request type", () => {
  assert.equal(requestAttentionLabel("decision"), "DECISION NEEDED");
  assert.equal(requestAttentionLabel("input"), "INPUT NEEDED");
  assert.equal(requestAttentionLabel("permission"), "PERMISSION NEEDED");
  assert.equal(requestAttentionLabel("credential"), "SECRET NEEDED");
});

console.log(`\n${pass} passed — decision-inbox helpers`);
