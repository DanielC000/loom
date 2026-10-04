// Hermetic unit test for lib/draftSubmit.ts — card a1ec70a6's second half: Board's Add-to-Inbox field
// cleared the typed title in the same tick it fired the create, so a 400/401 destroyed what the user had
// typed (the owner's never-clobber-user-input rule). Run:
//   node --experimental-strip-types packages/web/test/draft-submit.mjs
//
// ⚠️ SCOPE, stated up front: this covers the ORDERING and the outcome algebra only. What makes the ordering
// observable here is that the draft update is INJECTED — a pure test cannot see WHEN Board's own JSX calls
// it (the 654869e2 / formSync.ts lesson). The WIRING — that NewTask awaits the real mutation and keeps the
// title on a server refusal — is proved by packages/web/e2e/board-inbox-create-failure.spec.ts against a
// real daemon. Neither test substitutes for the other.
//
// Round 2 adds the case the first fix still got wrong: the clear was unconditional on success, so text the
// user typed WHILE the create was in flight was destroyed just the same. The guard moved in here (rather
// than into Board's own handler) precisely so this test can see it.
import assert from "node:assert/strict";
import { submitDraft } from "../src/lib/draftSubmit.ts";

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`ok   ${name}`); };

// A recorder: every call appends to one shared log, so the ORDER of `create` vs the draft update is
// assertable — which is the whole defect. `create` yields a microtask before settling, as a real mutation
// always does. `updateDraft` applies the updater to the LIVE draft, exactly as React's `setTitle` does, so
// a test can edit `state.draft` mid-flight and see which value the updater is handed.
function rig({ fail = false } = {}) {
  const log = [];
  let flight = false;
  const state = {
    log,
    draft: "fix(web): a card I typed",
    submits: 0,
    opts: {
      get draft() { return state.draft; },
      inFlight: () => flight,
      setInFlight: (v) => { flight = v; log.push(`inFlight=${v}`); },
      create: async () => {
        state.submits++;
        log.push("create:start");
        await Promise.resolve();
        log.push("create:settle");
        if (fail) throw new Error("400 unknown repoKey");
        return { id: "new-card" };
      },
      updateDraft: (update) => {
        const next = update(state.draft);
        log.push(next === state.draft ? "update:kept" : "update:cleared");
        state.draft = next;
      },
    },
  };
  return state;
}

await check("a SUCCESSFUL submit clears the draft — and only AFTER the create resolved", async () => {
  const r = rig();
  assert.equal(await submitDraft(r.opts), "created");
  assert.equal(r.draft, "");
  assert.deepEqual(r.log, ["inFlight=true", "create:start", "create:settle", "inFlight=false", "update:cleared"],
    "clearing is an effect of SUCCESS: it must not appear before create:settle");
});

// THE CARD'S CASE. Pre-fix, Board cleared the title in the same statement that fired the create, so this
// is the assertion that goes red on the old shape.
await check("a FAILED submit leaves the typed draft exactly as it was", async () => {
  const r = rig({ fail: true });
  assert.equal(await submitDraft(r.opts), "failed");
  assert.equal(r.draft, "fix(web): a card I typed", "a 400/401 must never eat the user's text");
  assert.equal(r.log.some((e) => e.startsWith("update:")), false, "a failure does not touch the draft at all");
  assert.deepEqual(r.log, ["inFlight=true", "create:start", "create:settle", "inFlight=false"]);
});

// ROUND 2's CASE. The first fix moved the clear after the await but left it unconditional, so a draft the
// user kept editing while the create was in flight was destroyed by the success — the same never-clobber
// rule, one tick later. Against that shape this assertion goes red with `draft === ""`.
await check("an edit made WHILE the create is in flight survives the success — only the SUBMITTED text is cleared", async () => {
  const r = rig();
  const submitted = r.draft;
  const pending = submitDraft(r.opts);
  r.draft = `${submitted} — plus a second thought`; // the user types on; the write is still out
  assert.equal(await pending, "created");
  assert.equal(r.draft, `${submitted} — plus a second thought`, "the newer text is no more the app's to delete than the first was");
  assert.equal(r.log.at(-1), "update:kept", "the updater saw the LIVE draft, not the submitting closure's stale copy");
});

await check("…and the card that WAS submitted is the one that got created — the surviving text is not a silent duplicate", async () => {
  const r = rig();
  const submitted = r.draft;
  const pending = submitDraft(r.opts);
  r.draft = "an unrelated second card";
  await pending;
  assert.equal(r.submits, 1, "one submit, one card");
  assert.equal(r.draft, "an unrelated second card", "…and the field is left holding text nothing has filed yet");
  assert.notEqual(r.draft, submitted);
});

await check("submitDraft never rejects — a thrown create is reported as an outcome, so callers can `void` it", async () => {
  const r = rig({ fail: true });
  await assert.doesNotReject(() => submitDraft(r.opts));
  assert.equal(r.log.at(-1), "inFlight=false", "the in-flight flag is released on the failure path too");
});

await check("an empty/whitespace draft never reaches the create at all", async () => {
  for (const draft of ["", "   ", "\n\t "]) {
    const r = rig();
    r.draft = draft;
    assert.equal(await submitDraft(r.opts), "empty", JSON.stringify(draft));
    assert.equal(r.submits, 0);
    assert.deepEqual(r.log, [], "no in-flight flag, no create, no clear");
  }
});

await check("a second submit while one is in flight is refused — ONE card per confirmed click", async () => {
  const r = rig();
  const first = submitDraft(r.opts);
  // Synchronously, while the first click is still awaiting its create: exactly the double-click case a
  // React-state guard cannot catch, because setState has not re-rendered when the second closure reads it.
  assert.equal(await submitDraft(r.opts), "busy");
  assert.equal(await first, "created");
  assert.equal(r.submits, 1, "the re-entrant click must not file a duplicate card");
});

await check("…and the guard is released, so the NEXT submit goes through", async () => {
  const r = rig();
  assert.equal(await submitDraft(r.opts), "created");
  r.draft = "a second card";
  assert.equal(await submitDraft(r.opts), "created");
  assert.equal(r.submits, 2);
});

console.log(`\n${pass} checks passed`);
