// Hermetic unit test for the DECISION INBOX pure helpers (card 8701bdbb, child B). The state-chip
// tone/label, the watchdog derivation, the relative-age formatter, and the attention-row text all live
// in src/lib/questions.ts (JSX-free) so both the components and lib/attention import ONE source — this
// test can't drift from what ships. Run:
//   node --experimental-strip-types packages/web/test/questions.mjs
import assert from "node:assert/strict";
import {
  DECISION_WATCHDOG_MS, relativeAge, isDecisionWatchdog, questionStateChip, decisionAttentionText,
  requestAttentionLabel,
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

check("decisionAttentionText: mgr <id8> · <project> — <title>", () => {
  assert.equal(
    decisionAttentionText({ sessionId: "7a3f91c2aaaa", title: "Rate-limit strategy", projectName: "Loom" }),
    "mgr 7a3f91c2 · Loom — Rate-limit strategy",
  );
  // no project name → still renders the mgr + title
  assert.equal(
    decisionAttentionText({ sessionId: "b2d40f18bbbb", title: "Protected main" }),
    "mgr b2d40f18 — Protected main",
  );
});

check("requestAttentionLabel: type-aware global attention label, per Request type", () => {
  assert.equal(requestAttentionLabel("decision"), "DECISION NEEDED");
  assert.equal(requestAttentionLabel("input"), "INPUT NEEDED");
  assert.equal(requestAttentionLabel("permission"), "PERMISSION NEEDED");
  assert.equal(requestAttentionLabel("credential"), "SECRET NEEDED");
});

console.log(`\n${pass} passed — decision-inbox helpers`);
