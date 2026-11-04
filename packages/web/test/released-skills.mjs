// Hermetic unit test for src/lib/releasedSkills.ts — the derived copy behind the released-skill panel
// (card 75ea3f73, over card 8b38b920's REST routes). No daemon, no DOM: it imports the TS source
// directly under Node's type stripping, so it exercises the REAL shipped helpers.
//
// The assertions here are deliberately about the three things the decision record forbids getting wrong,
// not about exact wording for its own sake:
//   1. `abandoned` must never read as an edit (it may be byte-identical to what Loom placed);
//   2. `tracked:"unknown"` must never be worded as a confirmed tracked file;
//   3. an unrecognised reason must still render, not blank the panel.
//
//   node --experimental-strip-types packages/web/test/released-skills.mjs
import assert from "node:assert/strict";
import {
  releaseReasonGloss, releaseReasonTone, releasedAgeLabel, shortFingerprint,
  trackedBadgeLabel, trackedBlockReason,
} from "../src/lib/releasedSkills.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// --- reason glosses ---------------------------------------------------------------------------

check("each of the daemon's three reasons has its own distinct gloss", () => {
  const g = ["modified", "unverifiable-legacy", "abandoned"].map(releaseReasonGloss);
  assert.equal(new Set(g).size, 3, "two reasons share a gloss, so the badge carries the only distinction");
  for (const t of g) assert.ok(t.length > 20, `a gloss is too short to explain anything: ${JSON.stringify(t)}`);
});

// ⛔ The decision record's own prohibition. `abandoned` is an age/cap give-up — the content may be
// byte-identical to Loom's own placement — so wording it as a change sends the reader hunting for a diff
// that does not exist. Asserted as an ABSENCE of edit vocabulary, so a future rewording can't reintroduce
// it by picking a different synonym than whatever this test happened to quote.
check("the `abandoned` gloss never describes an edit", () => {
  const g = releaseReasonGloss("abandoned").toLowerCase();
  for (const word of ["edit", "modif", "changed", "differs", "diverg"]) {
    assert.ok(!g.includes(word), `the abandoned gloss implies an edit via ${JSON.stringify(word)}: ${g}`);
  }
  // And the positive control for that absence check: `modified` DOES use that vocabulary, so the sweep
  // above is demonstrably capable of firing rather than vacuously passing on any text at all.
  const m = releaseReasonGloss("modified").toLowerCase();
  assert.ok(["edit", "modif", "changed", "differs", "diverg"].some((w) => m.includes(w)),
    `the edit-vocabulary sweep matches nothing even in the 'modified' gloss, so its absence above proves nothing: ${m}`);
});

check("an unrecognised reason still renders a gloss and a tone instead of blanking", () => {
  const g = releaseReasonGloss("some-reason-a-later-daemon-adds");
  assert.ok(g.length > 20, "an unknown reason produced no gloss");
  assert.notEqual(g, releaseReasonGloss("modified"), "an unknown reason borrowed a real reason's gloss");
  assert.equal(releaseReasonTone("some-reason-a-later-daemon-adds"), "muted");
});

check("reason tones are the intended three, and none of them is red", () => {
  assert.equal(releaseReasonTone("modified"), "amber");
  assert.equal(releaseReasonTone("unverifiable-legacy"), "cyan");
  assert.equal(releaseReasonTone("abandoned"), "muted");
  // red is reserved for a refusal the reader has actually run into; a frozen copy is not an error.
  for (const r of ["modified", "unverifiable-legacy", "abandoned"]) {
    assert.notEqual(releaseReasonTone(r), "red", `${r} renders as an error`);
  }
});

// --- the tri-state tracked check --------------------------------------------------------------

check("only `untracked` leaves the way clear; the other two each block with their OWN wording", () => {
  assert.equal(trackedBlockReason("untracked"), null);
  assert.equal(trackedBadgeLabel("untracked"), null, "the ordinary case should carry no badge");

  const tracked = trackedBlockReason("tracked");
  const unknown = trackedBlockReason("unknown");
  assert.ok(tracked && unknown, "a blocking state produced no reason text");
  assert.notEqual(tracked, unknown, "the two blocking states share one message");
  assert.ok(trackedBadgeLabel("tracked") !== trackedBadgeLabel("unknown"), "the two badges are identical");
});

// ⛔ The daemon tri-stated this on purpose: "has a git-tracked file" is a FALSE claim about a check that
// never completed. The unknown wording must say it could not be checked, and must NOT assert tracking.
check("the `unknown` wording claims a failed CHECK, never a confirmed tracked file", () => {
  const u = trackedBlockReason("unknown").toLowerCase();
  assert.ok(/could not|cannot|unable/.test(u), `the unknown reason does not say the check failed: ${u}`);
  assert.ok(!/\bis tracked\b|\bare tracked\b/.test(u), `the unknown reason asserts tracking as a fact: ${u}`);
  // Positive control: the real tracked reason DOES assert tracking, so the clause above can fire.
  assert.ok(/\bis tracked\b/.test(trackedBlockReason("tracked").toLowerCase()),
    "the 'asserts tracking' pattern matches nothing even in the tracked reason, so its absence proves nothing");
});

// --- age label --------------------------------------------------------------------------------

const AT = Date.UTC(2026, 0, 10, 12, 0, 0);
const after = (ms) => releasedAgeLabel(AT, AT + ms);

check("the age label reads in the largest sensible unit, singular and plural", () => {
  assert.equal(after(0), "frozen just now");
  assert.equal(after(30_000), "frozen just now");
  assert.equal(after(60_000), "frozen 1 minute ago");
  assert.equal(after(5 * 60_000), "frozen 5 minutes ago");
  assert.equal(after(60 * 60_000), "frozen 1 hour ago");
  assert.equal(after(3 * 60 * 60_000), "frozen 3 hours ago");
  assert.equal(after(24 * 60 * 60_000), "frozen 1 day ago");
  assert.equal(after(9 * 24 * 60 * 60_000), "frozen 9 days ago");
});

// `firstSeenAt` comes out of a hand-editable JSON sidecar and is compared against the BROWSER's clock,
// so a future timestamp is reachable without anything being broken. It must not render a negative age.
check("a future or unusable firstSeenAt degrades to 'just now', never a negative age", () => {
  assert.equal(after(-5 * 60_000), "frozen just now");
  assert.equal(releasedAgeLabel(Number.NaN, AT), "frozen just now");
});

// --- fingerprint ------------------------------------------------------------------------------

check("the fingerprint is truncated for display, and a null one says so", () => {
  assert.equal(shortFingerprint(null), "unreadable");
  assert.equal(shortFingerprint("abc"), "abc", "a short fingerprint should not gain an ellipsis");
  assert.equal(shortFingerprint("0123456789ab"), "0123456789ab", "exactly 12 chars is not truncated");
  assert.equal(shortFingerprint("0123456789abcdef0123"), "0123456789ab…");
});

console.log(`\n${pass} passed`);
