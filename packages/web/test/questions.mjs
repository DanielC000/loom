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
  formatAttachmentSize, attachmentDetail, attachmentCountChip, attachmentStateChip,
  attachmentPreviewMode, attachmentOpenRefusal,
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

// ── Request ATTACHMENTS (epic 7d1d66ab, card 19b7cf7a — Direction B "Manifest") ─────────────────────
// Both surfaces (the collapsed row's count chip, the opened detail's manifest) read these, so a drift
// here is a drift between the two. The origin-dependent helpers are checked at BOTH polarities:
// loopback and remote genuinely resolve to different answers, and a test that only ever passes the
// ambient one would pass identically if the parameter were ignored outright.
const att = (over = {}) => ({
  id: "0", label: "direction-b-manifest.html", kind: "html", sizeBytes: 37_000,
  imageDimensions: null, available: true, openedAt: null, ...over,
});

check("formatAttachmentSize: B / KB / MB, and no fake 0 for a non-finite count", () => {
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(640), "640 B");
  assert.equal(formatAttachmentSize(1024), "1 KB");
  assert.equal(formatAttachmentSize(90_112), "88 KB");
  assert.equal(formatAttachmentSize(1_258_291), "1.2 MB");
  assert.equal(formatAttachmentSize(-1), "—");
  assert.equal(formatAttachmentSize(Number.NaN), "—");
});

check("attachmentDetail: size (+ image dimensions when known), and WHAT HAPPENED when unavailable", () => {
  assert.equal(attachmentDetail(att({ sizeBytes: 90_112 })), "88 KB");
  assert.equal(
    attachmentDetail(att({ sizeBytes: 90_112, imageDimensions: { width: 1440, height: 420 } })),
    "88 KB · 1440×420",
  );
  // ⛔ An unavailable row must NOT read as a size: those bytes are gone, so the number would describe
  // something that is no longer there.
  assert.equal(attachmentDetail(att({ sizeBytes: 90_112, available: false })), "the bytes are gone — nothing to open");
});

check("attachmentCountChip: kinds in a FIXED order, unavailable excluded from the counts", () => {
  const chip = attachmentCountChip([
    att({ id: "0", kind: "html" }),
    att({ id: "1", kind: "image" }),
    att({ id: "2", kind: "html" }),
    att({ id: "3", kind: "image" }),
    att({ id: "4", kind: "image", available: false }),
  ]);
  // image before html regardless of attach order — the chip must read the same across reads.
  assert.equal(chip.text, "2 image · 2 html");
  assert.equal(chip.unavailable, 1, "the unavailable one is counted separately, never inside a kind tally");
  assert.equal(chip.unopened, 4);
  assert.match(chip.title, /^5 attached · 2 image, 2 html · 4 not yet opened · 1 unavailable$/);
});

check("attachmentCountChip: ALL-unavailable leaves an empty text but still reports the count", () => {
  const chip = attachmentCountChip([att({ available: false }), att({ id: "1", available: false })]);
  assert.equal(chip.text, "", "no kind tally — nothing is actually there");
  assert.equal(chip.unavailable, 2);
  assert.equal(chip.unopened, 0, "an unavailable file is not 'unopened' — it is unopenable");
  assert.match(chip.title, /2 attached/);
  assert.match(chip.title, /2 unavailable/);
});

check("attachmentCountChip: an empty list is empty on every field (never a phantom '0 image')", () => {
  const chip = attachmentCountChip([]);
  assert.equal(chip.text, "");
  assert.equal(chip.unavailable, 0);
  assert.equal(chip.unopened, 0);
  assert.equal(chip.title, "0 attached");
});

check("attachmentStateChip: unavailable → new → opened <age>, in that precedence", () => {
  assert.deepEqual(attachmentStateChip({ available: false, openedAt: null }, NOW), { tone: "red", label: "unavailable" });
  // ⛔ unavailable WINS over an openedAt stamp: a file opened earlier and reaped since is gone NOW, and
  // reading "opened 4m ago" would describe bytes that no longer exist.
  assert.deepEqual(attachmentStateChip({ available: false, openedAt: ago(4 * 60_000) }, NOW), { tone: "red", label: "unavailable" });
  assert.deepEqual(attachmentStateChip({ available: true, openedAt: null }, NOW), { tone: "phosphor", label: "new" });
  assert.deepEqual(attachmentStateChip({ available: true, openedAt: ago(4 * 60_000) }, NOW), { tone: "muted", label: "opened 4m ago" });
  // An unparseable stamp still reads as opened — the FACT of the stamp is what the column is about.
  assert.deepEqual(attachmentStateChip({ available: true, openedAt: "not-a-date" }, NOW), { tone: "muted", label: "opened" });
});

check("attachmentPreviewMode: html renders inline ONLY on loopback; a remote origin says so instead", () => {
  assert.equal(attachmentPreviewMode({ kind: "html", available: true }, false), "html");
  assert.equal(attachmentPreviewMode({ kind: "html", available: true }, true), "html-needs-loopback");
  // An image works on BOTH — remote goes through the credentialed blob fetch (components/VaultAsset's
  // precedent), so the mode itself does not change.
  assert.equal(attachmentPreviewMode({ kind: "image", available: true }, false), "image");
  assert.equal(attachmentPreviewMode({ kind: "image", available: true }, true), "image");
  assert.equal(attachmentPreviewMode({ kind: "other", available: true }, false), "download");
  // ⛔ Availability is checked FIRST: a gone file is `missing` whatever its kind or the origin, so no
  // branch below can ever try to render bytes that are not there.
  for (const kind of ["image", "html", "other"]) {
    for (const remote of [false, true]) {
      assert.equal(attachmentPreviewMode({ kind, available: false }, remote), "missing", `${kind}/${remote}`);
    }
  }
});

check("attachmentOpenRefusal: openable only on loopback, and never for a gone file", () => {
  assert.equal(attachmentOpenRefusal({ available: true }, false), null, "loopback reads are ungated");
  // A new-tab navigation carries no Authorization header, so a remote open would 401 — refuse it WITH a
  // reason rather than landing a JSON error page in a fresh tab.
  assert.match(String(attachmentOpenRefusal({ available: true }, true)), /loopback/i);
  assert.match(String(attachmentOpenRefusal({ available: false }, false)), /bytes are gone/i);
  assert.match(String(attachmentOpenRefusal({ available: false }, true)), /bytes are gone/i);
});

console.log(`\n${pass} passed — decision-inbox helpers`);
