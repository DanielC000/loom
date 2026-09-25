// Hermetic unit test for the web-side merge-gate CADENCE derivations in src/lib/mergeGate.ts — the pure,
// JSX-free helpers behind the Overview gate strip and the Settings cadence panel (card 00664e74).
//
// It covers the parts that are genuinely easy to get wrong and cheap to pin here rather than in a browser:
// the five-state classification and its precedence, the N+1 ordinal ("N ungated merges ALLOWED" ⇒ the
// (N+1)th runs the gate), the three-valued cadence ⇄ two-stored-keys round trip, interval validation
// (including blank-means-never), and the four contract points the daemon card amended late — the optional
// branchTip/candidates, a null fromSha reading as "since tracking began", and the escalated-failure key
// being `gateOwed && lastFailure` rather than lastFailure alone.
//
// Like fleet.mjs/diff.mjs, the web package has no test runner, so this is a self-contained node script,
// wired into @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/merge-gate.mjs
import assert from "node:assert/strict";
import {
  ago, badgeForInterval, bisectLabel, cadenceConfigWrite, cadenceOf, gateFailureAttentionText,
  intervalError, intervalFieldOf, INTERVAL_MAX, INTERVAL_MIN, isEscalatedFailure, landingLabel, ordinal,
  parseInterval, readMergeGate, RECENT_VERDICT_CAP, shortSha, showsTicks, TICK_TRACK_MAX,
  verdictMark, weakeningNote,
} from "../src/lib/mergeGate.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A status factory — only the contract fields, defaulting to the healthy fully-gated project.
const st = (o = {}) => ({
  cadence: "every", interval: null, ungatedSinceLastPass: 0, nextLandingGated: false,
  gateOwed: false, lastPassAt: null, lastFailure: null, recent: [], ...o,
});
const failure = (o = {}) => ({ at: "2026-09-25T12:00:00.000Z", opId: "op-1", fromSha: "aaaaaaaaaa", toSha: "bbbbbbbbbb", ...o });
// A fixed clock so every age assertion below is exact rather than tolerance-based.
const NOW = +new Date("2026-09-25T12:00:00.000Z");
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

// ── The five states + their precedence ───────────────────────────────────────────────────────────────

check("cadence=every reads as the healthy phosphor state", () => {
  const r = readMergeGate(st({ cadence: "every" }));
  assert.equal(r.state, "every");
  assert.equal(r.tone, "phosphor");
  assert.equal(r.glow, false);
  assert.equal(r.badge, "Every merge");
  assert.match(r.sentence, /Every merge runs the gate command/);
});

check("cadence=never is RED and counts the damage rather than just saying 'off'", () => {
  const r = readMergeGate(st({ cadence: "never", ungatedSinceLastPass: 17 }));
  assert.equal(r.state, "never");
  assert.equal(r.tone, "red", "a standing hazard, not a neutral setting");
  assert.equal(r.badge, "Never gated");
  assert.match(r.sentence, /17 merges have landed unverified/, "the unverified count IS the readout");
});

check("cadence=interval mid-count is amber and says how many are left", () => {
  const r = readMergeGate(st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 3 }));
  assert.equal(r.state, "counting");
  assert.equal(r.tone, "amber");
  assert.equal(r.badge, "Every 6th merge", "N=5 ungated allowed ⇒ the 6th runs the gate");
  assert.match(r.sentence, /2 more merges land ungated/);
});

check("the 'more merges' sentence is singular at exactly one left, and never negative", () => {
  assert.match(readMergeGate(st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 4 })).sentence, /1 more merge lands ungated/);
  // Over-count (an interval lowered mid-cycle) must not render "-2 more merges".
  const over = readMergeGate(st({ cadence: "interval", interval: 2, ungatedSinceLastPass: 7 }));
  assert.match(over.sentence, /The next merge runs the gate\./);
  assert.ok(!over.sentence.includes("-"), "no negative remainder leaks into the copy");
});

check("nextLandingGated is CYAN (verification imminent, not a verdict)", () => {
  const r = readMergeGate(st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 5, nextLandingGated: true }));
  assert.equal(r.state, "due");
  assert.equal(r.tone, "cyan", "Loom's established non-verdict / info tone");
  assert.equal(r.glow, false);
  assert.match(r.sentence, /A pass resets the counter to 0; a fail keeps every merge gated\./);
});

check("an escalated failure OUTRANKS every cadence, and is the only glowing state", () => {
  for (const cadence of ["every", "interval", "never"]) {
    const r = readMergeGate(st({ cadence, interval: cadence === "interval" ? 5 : null, gateOwed: true, lastFailure: failure(), ungatedSinceLastPass: 5 }));
    assert.equal(r.state, "failed", `${cadence} must still read as failed`);
    assert.equal(r.tone, "red");
    assert.equal(r.glow, true, "the CRT glow is reserved for a real verdict");
    assert.match(r.sentence, /Every merge is gated until one passes\. 5 merges landed unverified behind it\./);
  }
});

// ── Contract point 4: the escalated-failure key ──────────────────────────────────────────────────────
// A gate that fails under cadence=every lands in recent/lastFailure but does NOT set gateOwed. Keying on
// lastFailure alone would paint a healthy fully-gated project red forever after one red gate.

check("a failure WITHOUT gateOwed does not escalate (the cadence=every case)", () => {
  const s = st({ cadence: "every", gateOwed: false, lastFailure: failure() });
  assert.equal(isEscalatedFailure(s), false);
  assert.equal(readMergeGate(s).state, "every", "a fully-gated project stays green after one red gate");
  assert.equal(gateFailureAttentionText(s), null, "and raises no Attention row");
});

check("gateOwed WITHOUT a failure is a 'due', not a failure (the gate-the-next-merge button)", () => {
  const s = st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 2, gateOwed: true, nextLandingGated: true, lastFailure: null });
  assert.equal(isEscalatedFailure(s), false);
  assert.equal(readMergeGate(s).state, "due");
  assert.equal(gateFailureAttentionText(s), null);
});

check("BOTH flags together escalate, regardless of how the timestamps compare", () => {
  // A lastPassAt LATER than the failure is a daemon-side inconsistency; the UI follows the flags the
  // contract names rather than second-guessing them from timestamps.
  const s = st({ gateOwed: true, lastFailure: failure({ at: "2026-09-25T12:00:00.000Z" }), lastPassAt: "2026-09-25T13:00:00.000Z" });
  assert.equal(isEscalatedFailure(s), true);
  assert.equal(readMergeGate(s).state, "failed");
});

// ── Contract points 1+2: branchTip / candidates, and a null fromSha ──────────────────────────────────

check("bisectLabel renders a short range, and 'since tracking began' when there was never a pass", () => {
  assert.equal(bisectLabel(failure({ fromSha: "1234567890ab", toSha: "abcdef123456" })), "1234567..abcdef1");
  assert.equal(bisectLabel(failure({ fromSha: null })), "since tracking began",
    "a null fromSha is a WORSE situation, not an unknown one — it must not be hidden");
  assert.equal(bisectLabel(failure({ toSha: null })), null, "no toSha ⇒ no range recorded at all");
  assert.equal(bisectLabel(null), null);
  assert.equal(bisectLabel(undefined), null);
});

check("landingLabel prefers a batch count, then the branch NAME, then the tip sha, else nothing", () => {
  assert.deepEqual(landingLabel({ candidates: 4, branchTip: null }), { label: "batch", value: "4 branches" });
  assert.deepEqual(landingLabel({ candidates: 1 }), { label: "batch", value: "1 branch" }, "singular at K=1");

  // The NAME outranks the sha whenever the daemon knows it — a person goes looking for "loom/4e762baf",
  // not for a truncated hash.
  assert.deepEqual(landingLabel({ branch: "loom/4e762baf", branchTip: "deadbeefcafe" }),
    { label: "branch", value: "loom/4e762baf" }, "the name wins over the tip");
  assert.deepEqual(landingLabel({ branch: "loom/4e762baf" }), { label: "branch", value: "loom/4e762baf" });
  // …and the sha is the FALLBACK, not the other way round.
  assert.deepEqual(landingLabel({ branchTip: "deadbeefcafe" }), { label: "branch", value: "deadbee" });
  // A blank/whitespace name must fall through to the sha, not render an empty chip.
  assert.deepEqual(landingLabel({ branch: "   ", branchTip: "deadbeefcafe" }), { label: "branch", value: "deadbee" });
  assert.equal(landingLabel({ branch: null, branchTip: null }), null);
  // A BATCH keeps its count even if a stray branch name rides along — K is the truer description.
  assert.deepEqual(landingLabel({ candidates: 3, branch: "loom/x" }), { label: "batch", value: "3 branches" });

  // Every field is optional and may be ABSENT (not merely null) on an older daemon.
  assert.equal(landingLabel({}), null);
  assert.equal(landingLabel({ branchTip: null }), null);
  assert.equal(landingLabel(null), null);
  assert.equal(landingLabel(undefined), null);
});

check("the Attention text prefers the branch NAME when the daemon supplies one", () => {
  const s = st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 5, gateOwed: true,
    lastFailure: failure({ branch: "loom/4e762baf", branchTip: "4e762baf9999" }) });
  const text = gateFailureAttentionText(s, +new Date("2026-09-25T12:14:00.000Z"));
  assert.match(text, /^Periodic gate failed on loom\/4e762baf 14m ago\./);
});

check("the Attention text names the landing and the bisect range when both are known", () => {
  const s = st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 5, gateOwed: true,
    lastFailure: failure({ branchTip: "4e762baf9999", fromSha: "1111111111", toSha: "2222222222" }) });
  const text = gateFailureAttentionText(s, +new Date("2026-09-25T12:14:00.000Z"));
  assert.match(text, /^Periodic gate failed on 4e762ba 14m ago\./);
  assert.match(text, /Every merge stays gated until one passes/);
  assert.match(text, /5 merges landed ungated before it \(1111111\.\.2222222\)\./);
});

check("the Attention text degrades cleanly with no branch, no range, and a single merge behind it", () => {
  const s = st({ gateOwed: true, ungatedSinceLastPass: 1, lastFailure: failure({ branchTip: null, fromSha: null, toSha: null }) });
  const text = gateFailureAttentionText(s, +new Date("2026-09-25T12:05:00.000Z"));
  assert.ok(!text.includes(" on "), "no branch ⇒ no dangling 'on'");
  assert.ok(!text.includes("("), "no range ⇒ no empty parenthetical");
  assert.match(text, /1 merge landed ungated before it\./, "singular");
});

// ── Ordinals: N is the count of ungated landings ALLOWED, so the gated one is the (N+1)th ────────────

check("badgeForInterval is the (N+1)th, with correct English ordinals", () => {
  assert.equal(badgeForInterval(1), "Every 2nd merge", "N=1 means every OTHER merge");
  assert.equal(badgeForInterval(2), "Every 3rd merge");
  assert.equal(badgeForInterval(5), "Every 6th merge");
  assert.equal(badgeForInterval(10), "Every 11th merge");
  assert.equal(badgeForInterval(12), "Every 13th merge");
  assert.equal(badgeForInterval(20), "Every 21st merge");
  assert.equal(badgeForInterval(100), "Every 101st merge");
  assert.equal(badgeForInterval(0), "Every Nth merge", "no interval known yet ⇒ the generic word");
});

check("ordinal handles the 11/12/13 teens exception and the hundreds that mimic it", () => {
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(111), "111th");
  assert.equal(ordinal(112), "112th");
  assert.equal(ordinal(21), "21st");
  assert.equal(ordinal(102), "102nd");
  assert.equal(ordinal(1001), "1001st");
});

// ── Interval validation ──────────────────────────────────────────────────────────────────────────────

check("blank is NOT an error — it selects the `never` cadence (continuous with N to infinity)", () => {
  assert.equal(intervalError(""), null);
  assert.equal(intervalError("   "), null);
  assert.equal(parseInterval(""), null);
});

check("a non-integer, a zero, and a negative are all refused with the one shared message", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "5x", "1e3", "٣"]) {
    const err = intervalError(bad);
    assert.ok(err, `${bad} must be refused`);
    assert.match(err, new RegExp(`whole number of ${INTERVAL_MIN} or more`), `${bad}: states the rule`);
    assert.equal(parseInterval(bad), null, `${bad} never parses to a stored value`);
  }
});

check("the upper bound is stated in its own message, not the generic one", () => {
  assert.equal(intervalError(String(INTERVAL_MAX)), null, "the max itself is legal");
  const err = intervalError(String(INTERVAL_MAX + 1));
  assert.ok(err);
  assert.match(err, new RegExp(`most Loom accepts is ${INTERVAL_MAX}`));
});

check("a valid integer parses, tolerating surrounding whitespace", () => {
  assert.equal(parseInterval("5"), 5);
  assert.equal(parseInterval("  12  "), 12);
  assert.equal(parseInterval("1"), 1);
});

// ── Cadence ⇄ the two stored keys ────────────────────────────────────────────────────────────────────

check("cadenceOf reads all three states, and an absent mergeGate key inherits `every`", () => {
  assert.equal(cadenceOf(undefined), "every", "no override ⇒ inherits the on default");
  assert.equal(cadenceOf({}), "every");
  assert.equal(cadenceOf({ mergeGate: "on" }), "every");
  assert.equal(cadenceOf({ mergeGate: "off" }), "never");
  assert.equal(cadenceOf({ mergeGate: "off", mergeGateInterval: 5 }), "interval");
  // An interval stored while the gate is ON is ignored — the gate runs every merge anyway.
  assert.equal(cadenceOf({ mergeGate: "on", mergeGateInterval: 5 }), "every");
});

check("intervalFieldOf seeds the field, and is blank when no interval is stored", () => {
  assert.equal(intervalFieldOf({ mergeGate: "off", mergeGateInterval: 7 }), "7");
  assert.equal(intervalFieldOf({ mergeGate: "off" }), "");
  assert.equal(intervalFieldOf(undefined), "");
});

check("`every` CLEARS both keys rather than storing mergeGate:'on'", () => {
  const w = cadenceConfigWrite("every", "5");
  assert.deepEqual(w.set, {}, "nothing is written back as the default");
  assert.deepEqual(w.unset.sort(), ["orchestration.mergeGate", "orchestration.mergeGateInterval"]);
});

check("`never` stores off and unsets the interval", () => {
  const w = cadenceConfigWrite("never", "5");
  assert.deepEqual(w.set, { mergeGate: "off" });
  assert.deepEqual(w.unset, ["orchestration.mergeGateInterval"], "a stale interval must not survive");
});

check("`interval` stores both keys and unsets nothing", () => {
  const w = cadenceConfigWrite("interval", "5");
  assert.deepEqual(w.set, { mergeGate: "off", mergeGateInterval: 5 });
  assert.deepEqual(w.unset, []);
});

check("`interval` with a BLANK field degrades to `never`, never to an invalid stored value", () => {
  const w = cadenceConfigWrite("interval", "");
  assert.deepEqual(w.set, { mergeGate: "off" });
  assert.deepEqual(w.unset, ["orchestration.mergeGateInterval"]);
  assert.equal(cadenceOf({ ...w.set }), "never", "the write round-trips back to the cadence it means");
});

check("every cadence write round-trips through cadenceOf", () => {
  for (const [cad, raw] of [["every", ""], ["never", ""], ["interval", "5"], ["interval", "1"]]) {
    const w = cadenceConfigWrite(cad, raw);
    const stored = { ...w.set };
    const expected = cad === "interval" && raw === "" ? "never" : cad;
    assert.equal(cadenceOf(stored), expected, `${cad}/${raw || "blank"} round-trips`);
  }
});

// ── The verdict strip's three-way mark ───────────────────────────────────────────────────────────────
// `cleared` records that a human cadence change dropped an OWED gate. Nothing ran, nothing was verified,
// and the counter is NOT reset — so it must never render as a pass or a fail.

check("a pass and a fail render as the verdict marks, in their own tones", () => {
  const p = verdictMark({ result: "pass", at: iso(60) }, NOW);
  assert.equal(p.kind, "pass");
  assert.equal(p.tone, "phosphor");
  assert.equal(p.glyph, "✓");
  assert.match(p.title, /^passed 1h 0m ago/);

  const f = verdictMark({ result: "fail", at: iso(14), branch: "loom/abc", fromSha: "1111111aaa", toSha: "2222222bbb" }, NOW);
  assert.equal(f.kind, "fail");
  assert.equal(f.tone, "red");
  assert.equal(f.glyph, "✗");
  assert.match(f.title, /^failed 14m ago/);
  assert.match(f.title, /branch loom\/abc/, "the tooltip carries what landed");
  assert.match(f.title, /1111111\.\.2222222/, "and the bisect range");
});

check("a CLEARED entry is neutral — never a pass, never a fail", () => {
  const c = verdictMark({ result: "cleared", at: iso(30), reason: "cadence-changed" }, NOW);
  assert.equal(c.kind, "cleared");
  assert.equal(c.tone, "muted", "not red: nothing failed");
  assert.notEqual(c.tone, "phosphor", "and not green: nothing was verified either");
  assert.notEqual(c.glyph, "✓");
  assert.notEqual(c.glyph, "✗");
  assert.equal(c.title, "owed gate cleared by a settings change 30m ago", "the manager's exact wording");
});

check("an UNKNOWN clear reason is named, never labelled as a settings change", () => {
  // Labelling an unfamiliar reason "a settings change" would state a cause we were never told; naming the
  // raw reason makes a new one surface instead of being silently mislabelled.
  const c = verdictMark({ result: "cleared", at: iso(5), reason: "gate-disabled" }, NOW);
  assert.equal(c.kind, "cleared");
  assert.match(c.title, /owed gate cleared \(gate-disabled\)/);
  assert.ok(!c.title.includes("settings change"), "must not claim a cause it was not given");

  const none = verdictMark({ result: "cleared", at: iso(5) }, NOW);
  assert.match(none.title, /reason not given/, "an absent reason is stated, not invented");
});

check("a cleared entry carrying none of the sha/branch fields still renders", () => {
  // The wire shape for a clear is just {result, at, reason} — every other field is absent, and a reader
  // that assumed they were present would throw on the one entry kind that has none of them.
  assert.doesNotThrow(() => verdictMark({ result: "cleared", at: iso(1), reason: "cadence-changed" }, NOW));
  assert.equal(verdictMark({ result: "cleared", at: iso(1), reason: "cadence-changed" }, NOW).kind, "cleared");
});

// ── The tick track's degrade threshold ───────────────────────────────────────────────────────────────

check("the tick track degrades to a Meter above TICK_TRACK_MAX", () => {
  assert.ok(TICK_TRACK_MAX >= 8 && TICK_TRACK_MAX <= 16, "a sane, countable-at-a-glance ceiling");
  assert.equal(showsTicks(1), true);
  assert.equal(showsTicks(TICK_TRACK_MAX), true, "the threshold itself still ticks");
  assert.equal(showsTicks(TICK_TRACK_MAX + 1), false, "one over degrades");
  assert.equal(showsTicks(null), false, "no interval ⇒ no track at all");
  assert.equal(showsTicks(0), false);
});

check("the verdict strip's cap is the last six, per the owner's direction-C borrowing", () => {
  assert.equal(RECENT_VERDICT_CAP, 6);
});

// ── Formatting helpers ───────────────────────────────────────────────────────────────────────────────

check("ago renders compact mono ages and never an em-dash", () => {
  const base = +new Date("2026-09-25T12:00:00.000Z");
  const at = (ms) => ago(new Date(base - ms).toISOString(), base);
  assert.equal(at(0), "just now");
  assert.equal(at(30_000), "just now");
  assert.equal(at(14 * 60_000), "14m ago");
  assert.equal(at(59 * 60_000), "59m ago");
  assert.equal(at((2 * 60 + 14) * 60_000), "2h 14m ago");
  assert.equal(at((3 * 24 * 60 + 4 * 60) * 60_000), "3d 4h ago");
  assert.equal(ago(null), "never");
  // A clock-skewed FUTURE stamp must read as "just now", never a negative age.
  assert.equal(ago(new Date(base + 60_000).toISOString(), base), "just now");
  assert.equal(ago("not-a-date", base), "unknown");
  for (const out of [at(0), at(14 * 60_000), ago(null)]) assert.ok(!out.includes("—"), "no em-dash");
});

check("shortSha truncates to 7 and passes a blank/null through as null", () => {
  assert.equal(shortSha("1234567890abcdef"), "1234567");
  assert.equal(shortSha("abc"), "abc", "an already-short value is not padded");
  assert.equal(shortSha(null), null);
  assert.equal(shortSha(undefined), null);
  assert.equal(shortSha("   "), null);
});

// ── Copy discipline (CLAUDE.md + the web-design skill: no em-dashes in UX copy) ──────────────────────

check("the weakening note states the real cost at each non-default cadence", () => {
  assert.equal(weakeningNote("every", null), null, "the default cadence weakens nothing");

  const never = weakeningNote("never", null);
  assert.equal(never.tone, "red");
  assert.match(never.text, /No merge will run the gate command/);
  assert.match(never.text, /No agent can make this change/, "the trust boundary is part of the warning");

  const interval = weakeningNote("interval", 5);
  assert.equal(interval.tone, "amber");
  assert.match(interval.text, /up to 5 merges reach the default branch/);
  assert.match(interval.text, /not which merge broke it/, "the bisect cost is stated, not implied");

  assert.match(weakeningNote("interval", 1).text, /up to 1 merge reach/, "singular at N=1");
  // An unknown/invalid N states NO cost — a note reading "up to 0 merges" would sit directly under the
  // error saying 0 is not allowed, contradicting it.
  assert.equal(weakeningNote("interval", null), null, "blank/mid-typing ⇒ no cost claim");
  assert.equal(weakeningNote("interval", 0), null, "an invalid 0 ⇒ no cost claim");
});

check("no rendered state sentence or badge contains an em-dash", () => {
  const states = [
    st({ cadence: "every" }),
    st({ cadence: "never", ungatedSinceLastPass: 17 }),
    st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 3 }),
    st({ cadence: "interval", interval: 5, ungatedSinceLastPass: 5, nextLandingGated: true }),
    st({ gateOwed: true, lastFailure: failure(), ungatedSinceLastPass: 5 }),
  ];
  for (const s of states) {
    const r = readMergeGate(s);
    assert.ok(!r.sentence.includes("—"), `em-dash in: ${r.sentence}`);
    assert.ok(!r.badge.includes("—"), `em-dash in badge: ${r.badge}`);
  }
  // The weakening notes and the Attention text are rendered copy too — the same rule binds them.
  for (const note of [weakeningNote("never", null), weakeningNote("interval", 5)]) {
    assert.ok(!note.text.includes("—"), `em-dash in weakening note: ${note.text}`);
  }
  const attn = gateFailureAttentionText(st({ gateOwed: true, ungatedSinceLastPass: 3, lastFailure: failure() }));
  assert.ok(!attn.includes("—"), `em-dash in attention text: ${attn}`);
});

console.log(`\n${pass} check(s) passed`);
