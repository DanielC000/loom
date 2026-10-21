// Hermetic unit test for lib/queueDrafts.ts — the queue editor's draft store (card 525c8ad9, review
// rounds 2 and 3). Run standalone with:
//   node --experimental-strip-types packages/web/test/queue-drafts.mjs
//
// Two properties are under test, and they pull against each other, which is the whole reason this
// file exists rather than an e2e:
//   • a draft must SURVIVE anything that is not a decision to discard (an unmount, a tab hop) — the
//     round-2 defect, where a Terminal→Diff route change destroyed a half-written queued message;
//   • and it must NOT survive the entry itself leaving the queue — the round-3 defect, where the
//     store only ever grew, because a queue entry drains at a turn boundary or is re-minted under a
//     fresh id and neither path goes anywhere near the editor.
// Only the second is reachable from a browser test at all (the first needs a real drained queue), so
// both are pinned here against the module's real behaviour.
import assert from "node:assert/strict";
import {
  clearQueueDraft, getQueueDraft, getQueueEditing, isQueueExpanded, pruneQueueDrafts,
  setQueueDraft, setQueueEditing, setQueueExpanded,
} from "../src/lib/queueDrafts.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const A = "session-a";
const B = "session-b";

check("a draft round-trips, and is scoped to its own session AND its own entry", () => {
  setQueueDraft(A, "e1", "draft one");
  setQueueDraft(A, "e2", "draft two");
  setQueueDraft(B, "e1", "other session, same entry id");
  assert.equal(getQueueDraft(A, "e1"), "draft one");
  assert.equal(getQueueDraft(A, "e2"), "draft two");
  assert.equal(getQueueDraft(B, "e1"), "other session, same entry id");
  // The one that would silently cross-contaminate if the key were the entry id alone.
  assert.notEqual(getQueueDraft(A, "e1"), getQueueDraft(B, "e1"));
});

check("an entry with NO draft reads undefined, distinctly from one deliberately emptied", () => {
  // These are different states on purpose (round-3 nit 4): collapsing them made a remount re-seed the
  // entry's original text, silently undoing the user's own clearing of the box.
  assert.equal(getQueueDraft(A, "never-touched"), undefined);
  setQueueDraft(A, "emptied", "");
  assert.equal(getQueueDraft(A, "emptied"), "");
  assert.notEqual(getQueueDraft(A, "emptied"), getQueueDraft(A, "never-touched"));
});

check("clearQueueDraft removes exactly one entry's draft", () => {
  setQueueDraft(A, "e3", "to be cleared");
  clearQueueDraft(A, "e3");
  assert.equal(getQueueDraft(A, "e3"), undefined);
  assert.equal(getQueueDraft(A, "e1"), "draft one", "clearing e3 must not disturb its siblings");
});

check("pruning drops the drafts of entries that LEFT the queue, and keeps the ones still in it", () => {
  setQueueDraft(A, "gone-1", "x");
  setQueueDraft(A, "gone-2", "y");
  setQueueDraft(A, "emptied", "");
  const reopened = pruneQueueDrafts(A, ["e1", "e2"]);
  assert.equal(getQueueDraft(A, "gone-1"), undefined, "a drained entry's draft must be dropped");
  assert.equal(getQueueDraft(A, "gone-2"), undefined);
  assert.equal(getQueueDraft(A, "emptied"), undefined,
    "an EMPTY draft is still a draft and must be pruned like any other, or it leaks forever");
  assert.equal(getQueueDraft(A, "e1"), "draft one", "an entry still in the queue keeps its draft");
  assert.equal(getQueueDraft(A, "e2"), "draft two");
  assert.equal(reopened, false, "nothing was being edited, so the prune had no editing row to clear");
});

check("pruning NEVER touches another session's drafts", () => {
  // The prune walks every key in one shared Map, so a prefix test that matched loosely would let one
  // session's poll quietly delete another's unfinished work.
  assert.equal(getQueueDraft(B, "e1"), "other session, same entry id");
  pruneQueueDrafts(A, []);
  assert.equal(getQueueDraft(A, "e1"), undefined, "an empty present-list legitimately clears the session");
  assert.equal(getQueueDraft(B, "e1"), "other session, same entry id",
    "session B's draft must be untouched by a prune of session A");
});

check("pruning clears the editing row only when ITS entry is the one that left", () => {
  setQueueEditing(A, "still-here");
  assert.equal(pruneQueueDrafts(A, ["still-here"]), false);
  assert.equal(getQueueEditing(A), "still-here", "the edited entry is still queued — keep the editor open");

  setQueueEditing(A, "drained");
  assert.equal(pruneQueueDrafts(A, ["still-here"]), true,
    "the prune must REPORT that it closed the editor, so the component can drop its own copy of that state");
  assert.equal(getQueueEditing(A), null);
});

check("the drawer flag round-trips and is per-session", () => {
  assert.equal(isQueueExpanded(A), false, "a session nobody expanded starts collapsed");
  setQueueExpanded(A, true);
  assert.equal(isQueueExpanded(A), true);
  assert.equal(isQueueExpanded(B), false);
  setQueueExpanded(A, false);
  assert.equal(isQueueExpanded(A), false);
});

console.log(`\n${pass} passed — queueDrafts survives an unmount and does not survive a drained entry`);
