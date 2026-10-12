// Hermetic unit test for the attention-queue DISMISS KEY derivation (card 611e76ba — the owner's ruling
// that every attention row must be hideable with one ×). No daemon, no claude, no React.
//
// The property under test is the one the whole feature rests on, and it has TWO halves that fail in
// opposite directions — both are asserted for every kind below:
//   • STABLE while the state that raised the alert is unchanged. A key that moves on its own (an elapsed
//     age, a re-derived `Date.now()`, a rolling counter) makes × useless: the row returns seconds later
//     under a new key, which is exactly the friction the owner reported.
//   • DIFFERENT on a genuinely new occurrence. A key that is TOO stable (the bare session id) silently
//     retires an alert forever, which is worse — the next real incident never surfaces at all.
// Testing only one half passes against a constant, so each case below checks both.
//
// Like fleet.mjs/companion.mjs, the web package has no test runner, so this is a self-contained node
// script, auto-discovered by test/run-all.mjs (wired into @loom/web's `build`, which CI runs via
// `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/attention-dismiss.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  idleDoneEpisodeStarts, rateLimitDismissKey, requestAttentionBranch, requestDismissKey,
  sessionEpisodeDismissKey,
} from "../src/lib/fleet.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const future = new Date(NOW + 60 * 60_000).toISOString();
const past = new Date(NOW - 60 * 60_000).toISOString();

// ── Requests: identity + WHICH presentation branch fired ──────────────────────────────────────────────

check("requestAttentionBranch: a plain pending request is 'pending'", () => {
  assert.equal(requestAttentionBranch({ id: "q1" }, NOW), "pending");
});

check("requestAttentionBranch: escalatedAt alone makes it 'stale'", () => {
  assert.equal(requestAttentionBranch({ id: "q1", escalatedAt: past }, NOW), "stale");
});

check("requestAttentionBranch: an UNEXPIRED snooze suppresses stale back to pending", () => {
  assert.equal(requestAttentionBranch({ id: "q1", escalatedAt: past, acknowledgedUntil: future }, NOW), "pending");
});

check("requestAttentionBranch: an EXPIRED snooze does not suppress — it re-reddens", () => {
  assert.equal(requestAttentionBranch({ id: "q1", escalatedAt: past, acknowledgedUntil: past }, NOW), "stale");
});

check("requestAttentionBranch: orphaned outranks stale", () => {
  assert.equal(requestAttentionBranch({ id: "q1", escalatedAt: past, sessionOrphaned: true }, NOW), "orphaned");
});

check("request key: SAME state ⇒ byte-identical key (a dismiss stays stuck across polls)", () => {
  const q = { id: "q1", escalatedAt: past };
  // Two different "now"s stand in for two successive polls: nothing about the request changed, so the
  // key must not move. This is what a Date.now()-derived key would fail.
  assert.equal(requestDismissKey(q, NOW), requestDismissKey(q, NOW + 5 * 60_000));
});

check("request key: crossing INTO stale is a new occurrence ⇒ the row comes back", () => {
  const before = requestDismissKey({ id: "q1" }, NOW);
  const after = requestDismissKey({ id: "q1", escalatedAt: past }, NOW);
  assert.notEqual(before, after, "dismissing the cyan row must not pre-hide the red STALE escalation");
});

check("request key: the asking session dying is a new occurrence", () => {
  const before = requestDismissKey({ id: "q1", escalatedAt: past }, NOW);
  const after = requestDismissKey({ id: "q1", escalatedAt: past, sessionOrphaned: true }, NOW);
  assert.notEqual(before, after);
});

check("request key: a re-snooze does NOT mint a new key (the deadline is not the state token)", () => {
  // Both are 'pending' (unexpired snooze). If the key carried acknowledgedUntil, moving the snooze would
  // resurrect a row the human already hid.
  const a = requestDismissKey({ id: "q1", escalatedAt: past, acknowledgedUntil: future }, NOW);
  const b = requestDismissKey({ id: "q1", escalatedAt: past, acknowledgedUntil: new Date(NOW + 3 * 3600_000).toISOString() }, NOW);
  assert.equal(a, b);
});

check("request key: a DIFFERENT request is never hidden by another's dismiss", () => {
  assert.notEqual(requestDismissKey({ id: "q1" }, NOW), requestDismissKey({ id: "q2" }, NOW));
});

// ── Session-row kinds: identity + the field frozen for the episode ────────────────────────────────────

check("session episode key: same lastActivity ⇒ same key; a new episode ⇒ a new key", () => {
  const s = { id: "sess-1", lastActivity: "2026-10-12T11:00:00.000Z" };
  assert.equal(sessionEpisodeDismissKey("cl", s), sessionEpisodeDismissKey("cl", { ...s }));
  const acted = { ...s, lastActivity: "2026-10-12T11:30:00.000Z" };
  assert.notEqual(sessionEpisodeDismissKey("cl", s), sessionEpisodeDismissKey("cl", acted),
    "a session that acted again (or was resumed) must be able to raise the alert afresh");
});

check("session episode key: the prefix keeps two kinds about ONE session independent", () => {
  const s = { id: "sess-1", lastActivity: "2026-10-12T11:00:00.000Z" };
  assert.notEqual(sessionEpisodeDismissKey("cl", s), sessionEpisodeDismissKey("of", s),
    "hiding CRASH-LOOPED must not also hide ORPHANED FLEET for the same session");
});

check("rate-limit key: same park ⇒ same key; the NEXT park ⇒ a new key", () => {
  const s = { id: "sess-1", rateLimitedUntil: "2026-10-12T12:30:00.000Z" };
  assert.equal(rateLimitDismissKey(s), rateLimitDismissKey({ ...s }));
  assert.notEqual(rateLimitDismissKey(s), rateLimitDismissKey({ ...s, rateLimitedUntil: "2026-10-12T14:00:00.000Z" }));
});

// ── QUEUE DRAINED: the episode derivation (the one kind that cannot key on its event id) ──────────────

let evSeq = 0;
const ev = (managerSessionId, kind, state, ts) => ({
  id: `ev-${++evSeq}`, ts, managerSessionId, kind,
  detail: state === undefined ? {} : { state },
});
const t = (min) => new Date(NOW + min * 60_000).toISOString();

check("idleDoneEpisodeStarts: a single done report starts an episode", () => {
  const e = ev("m1", "idle_report", "done", t(0));
  assert.equal(idleDoneEpisodeStarts([e]).get("m1"), e.id);
});

check("idleDoneEpisodeStarts: REPEATED done reports keep the FIRST id (no churn)", () => {
  // This is the whole reason this helper exists: `idle_report` is agent-filed, so a manager that stays
  // drained re-files state:"done" on every nudge cycle. Keying on the event id would mint a fresh key
  // every few minutes and the × would do nothing.
  const first = ev("m1", "idle_report", "done", t(0));
  const events = [first, ev("m1", "idle_report", "done", t(10)), ev("m1", "idle_report", "done", t(20))];
  assert.equal(idleDoneEpisodeStarts(events).get("m1"), first.id);
});

check("idleDoneEpisodeStarts: working BREAKS the run — draining again is a NEW episode", () => {
  const first = ev("m1", "idle_report", "done", t(0));
  const working = ev("m1", "idle_report", "working", t(10));
  const second = ev("m1", "idle_report", "done", t(20));
  const events = [first, working, second];
  assert.equal(idleDoneEpisodeStarts(events).get("m1"), second.id,
    "the board going empty again after being non-empty must re-surface the alert");
});

check("idleDoneEpisodeStarts: idle_escalated also breaks the run", () => {
  const first = ev("m1", "idle_report", "done", t(0));
  const esc = ev("m1", "idle_escalated", undefined, t(10));
  const second = ev("m1", "idle_report", "done", t(20));
  assert.equal(idleDoneEpisodeStarts([first, esc, second]).get("m1"), second.id);
});

check("idleDoneEpisodeStarts: a run that ENDS non-done leaves no entry", () => {
  const events = [ev("m1", "idle_report", "done", t(0)), ev("m1", "idle_report", "waiting", t(10))];
  assert.equal(idleDoneEpisodeStarts(events).has("m1"), false,
    "no QUEUE DRAINED item is rendered in that state, so there is no key to derive");
});

check("idleDoneEpisodeStarts: managers are independent", () => {
  const a = ev("m1", "idle_report", "done", t(0));
  const b = ev("m2", "idle_report", "done", t(5));
  const m = idleDoneEpisodeStarts([a, b]);
  assert.equal(m.get("m1"), a.id);
  assert.equal(m.get("m2"), b.id);
});

check("idleDoneEpisodeStarts: UNSORTED input is sorted by ts, not trusted in array order", () => {
  const first = ev("m1", "idle_report", "done", t(0));
  const working = ev("m1", "idle_report", "working", t(10));
  const second = ev("m1", "idle_report", "done", t(20));
  assert.equal(idleDoneEpisodeStarts([second, first, working]).get("m1"), second.id);
});

check("idleDoneEpisodeStarts: unrelated event kinds are ignored entirely", () => {
  const first = ev("m1", "idle_report", "done", t(0));
  const noise = ev("m1", "merge_request", undefined, t(10));
  assert.equal(idleDoneEpisodeStarts([first, noise]).get("m1"), first.id,
    "a merge_request between two done reports is not an idle disposition and must not split the episode");
});

// ── The structural invariant: EVERY builder sets a dismissKey ─────────────────────────────────────────
// A source scan, deliberately. The thing most likely to regress here is not any one key's shape — it is
// kind 19 being added in a year's time with no dismissKey at all, silently re-introducing exactly the
// undismissable row the owner complained about. That cannot be asserted from lib/attention at runtime
// (it imports React, react-query and ./api), and an e2e can only cover the kinds it happens to seed.

const attentionSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "attention.ts"), "utf8");

check("every items.push(...) in useAttention sets a dismissKey (card 611e76ba)", () => {
  // Each builder is an object literal pushed onto `items`. Split on the push boundary and require the
  // field in each resulting block, up to the next push.
  const blocks = attentionSrc.split("items.push(").slice(1);
  assert.ok(blocks.length >= 15, `expected to find the attention builders, found ${blocks.length}`);
  const missing = [];
  for (const b of blocks) {
    // `kind: "..."` is how each builder names itself; the ternary Request builder carries three.
    const kinds = [...b.matchAll(/kind: (?:"([A-Z][^"]*)"|label)/g)].map((m) => m[1] ?? "REQUEST");
    if (!/dismissKey:/.test(b)) missing.push(kinds.join("/") || "(unnamed builder)");
  }
  assert.deepEqual(missing, [],
    `these attention builders render a row with no × — every kind must be dismissable: ${missing.join(", ")}`);
});

check("the dismiss-key scan is falsifiable (positive control)", () => {
  // The assertion above is an ABSENCE claim, so prove the detector can actually return non-empty: feed it
  // a builder with the dismissKey removed and require it to be reported.
  const broken = attentionSrc.replace(/dismissKey: `bq:\$\{e\.id\}`,\r?\n/, "");
  assert.notEqual(broken, attentionSrc, "the QUIET BOARD dismissKey line moved — update this control");
  const blocks = broken.split("items.push(").slice(1);
  const missing = blocks.filter((b) => !/dismissKey:/.test(b));
  assert.equal(missing.length, 1, "removing one dismissKey must make the scan above fail, not pass");
});

check("no builder keys its dismiss on a value that moves every poll", () => {
  // `Date.now()` / `new Date()` inside a dismissKey is the specific footgun the design rule names: it
  // renders identically and makes × useless. Cheap, exact, and it cannot false-positive on prose.
  const bad = [...attentionSrc.matchAll(/dismissKey: [^\r\n]*/g)]
    .map((m) => m[0])
    .filter((line) => /Date\.now\(\)|new Date\(/.test(line));
  assert.deepEqual(bad, [], `a dismissKey must never be derived from the current time: ${bad.join(" | ")}`);
});

console.log(`\n${pass} checks passed`);
