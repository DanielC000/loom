// Hermetic unit test for the web-side ms ⇄ human-unit conversion in src/lib/msUnits.ts, the shared
// canonical-ms bounds table it reads, and the two source-level invariants that keep them the ONLY path a
// timing field can take (card 0a5d61c9).
//
// What it actually pins, in the order the card's own DoD states it:
//   (1) msFromUnit ROUNDS. `16.1 * 1000` is 16100.000000000002 in IEEE-754 and every server-side ms
//       validator is `.int()`, so the unrounded product 400s with "Expected integer". The float hazard is
//       asserted DIRECTLY first, so this test fails loudly if a future engine ever made the product exact
//       (which would make every other assertion here pass for the wrong reason).
//   (2) msRangeError compares the SAME rounded integer the submit path sends — so the inline error and the
//       server can never disagree about a value sitting exactly on a bound.
//   (3) PLATFORM_MS_BOUNDS carries the values the daemon's zod schema enforced BEFORE card 0a5d61c9 moved
//       the literals into it. The expected table below is a hand-authored copy of those pre-move literals,
//       so a typo during the relocation fails here rather than silently retuning a platform-wide bound.
//   (4) Four source scans: every GLOBAL_FIELDS entry in Settings.tsx has a bound (a missing one renders
//       a silently unbounded field, since MsField simply drops the hint when `bounds` is undefined);
//       every entry's display unit renders BOTH halves of that bound as a short, readable figure (card
//       7663eeb4 — hours cannot state a sub-hour floor: 60_000ms is 0.016666666666666666h); every
//       HAND-WRITTEN `<MsField>` call site, which declares its unit and bounds inline and so is invisible
//       to the table scan, is held to that same rule (card cb6a51b8 — the Connections rate-limit window
//       had shipped exactly that defect in minutes); and no bare `Number(...) * UNIT_MS` conversion has
//       crept back in anywhere under src/.
//   (5) Card 826483a7: the four rate-limit loop-breaker fields are actually RENDERED (card dfef375f
//       landed them REST-only), each ms one in a unit that renders its shared bound whole, and their one
//       cross-field invariant (backoff base vs ceiling) behaves as the resolve-time CLAMP it is rather
//       than a rejection the UI would have to invent.
//
// Like fleet.mjs/merge-gate.mjs, the web package has no test runner, so this is a self-contained node
// script, auto-discovered by test/run-all.mjs (wired into @loom/web's `build`). Standalone:
//   node --experimental-strip-types packages/web/test/ms-units.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLATFORM_MS_BOUNDS, ORCHESTRATION_TIMEOUT_MS_BOUNDS, MAX_TIMER_DELAY_MS, resolveConfig } from "@loom/shared";
import {
  UNIT_MS, msFromUnit, msInUnit, msRangeError, msRangeErrors, msRangeHint, msStr,
} from "../src/lib/msUnits.ts";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── (1) The float hazard is real, and msFromUnit is what removes it ──────────────────────────────────

check("the unrounded product really is a non-integer float (the bug this card fixes)", () => {
  // The control for every assertion below: if this ever becomes exact, the rounding assertions would pass
  // vacuously. 16.1 is the exact value from the card's own repro.
  assert.notEqual(16.1 * UNIT_MS.s, 16100);
  assert.equal(16.1 * UNIT_MS.s, 16100.000000000002);
  assert.equal(Number.isInteger(16.1 * UNIT_MS.s), false);
});

check("msFromUnit returns a whole-millisecond integer for a fractional seconds entry", () => {
  assert.equal(msFromUnit("16.1", "s"), 16100);
  assert.equal(Number.isInteger(msFromUnit("16.1", "s")), true);
});

check("msFromUnit rounds in every unit, not just seconds", () => {
  assert.equal(msFromUnit("0.5", "s"), 500);
  assert.equal(msFromUnit("1.1", "m"), 66_000);
  assert.equal(msFromUnit("2.9", "m"), 174_000);
  assert.equal(msFromUnit("0.1", "h"), 360_000);
  assert.equal(msFromUnit("1.7", "h"), 6_120_000);
  for (const unit of ["s", "m", "h"]) {
    for (const v of ["16.1", "0.3", "7.7", "1.23", "99.99"]) {
      assert.equal(Number.isInteger(msFromUnit(v, unit)), true, `${v}${unit} must convert to an integer`);
    }
  }
});

check("msFromUnit leaves a sub-millisecond value rounded, never fractional", () => {
  // 0.0001s is 0.1ms — it rounds to 0, which the bound check then rejects. The important property is that
  // an `.int()` validator never sees 0.1.
  assert.equal(msFromUnit("0.0001", "s"), 0);
  assert.equal(msFromUnit("0.0006", "s"), 1);
});

check("msFromUnit preserves the non-finite passthrough every call site's guard depends on", () => {
  // Each call site does `Number.isFinite(n) ? n : originalString` so a junk entry reaches the server as a
  // string and 400s readably (rather than JSON-serializing to null, which collides with the clear
  // sentinel). Math.round must not turn either case into a finite number.
  assert.equal(Number.isNaN(msFromUnit("abc", "s")), true);
  assert.equal(Number.isFinite(msFromUnit("abc", "s")), false);
  assert.equal(msFromUnit("1e999", "s"), Infinity);
  assert.equal(Number.isFinite(msFromUnit("1e999", "s")), false);
});

check("msFromUnit does NOT special-case blank — callers trim-check first (blank means inherit)", () => {
  // Pinned so nobody 'helpfully' makes blank return NaN: Settings' call sites all branch on blank BEFORE
  // converting, because blank is a clear-to-inherit, not a zero.
  assert.equal(msFromUnit("", "s"), 0);
});

check("msStr is the exact inverse for a whole-unit value", () => {
  assert.equal(msStr(16_100, "s"), "16.1");
  assert.equal(msStr(600_000, "m"), "10");
  assert.equal(msStr(undefined, "s"), "");
  assert.equal(msFromUnit(msStr(16_100, "s"), "s"), 16_100);
});

// ── (2) The range check compares the SAME integer the submit path sends ──────────────────────────────

check("msRangeError accepts a fractional entry whose ROUNDED value sits exactly on the max", () => {
  // THE coupling assertion. Against the unrounded product (16100.000000000002) this value is out of range
  // and Save would have been blocked for a value the server accepts — the client and server disagreeing at
  // a boundary. It only passes because both sides round through msFromUnit.
  assert.equal(msRangeError("16.1", "s", { min: 1000, max: 16_100 }), null);
  assert.equal(msRangeError("16.1", "s", { min: 16_100, max: 20_000 }), null);
});

check("msRangeError still catches a genuinely out-of-range entry, stated in the field's own unit", () => {
  // An ORDINARY bound (a real policy ceiling) — both halves, in the field's own unit. deployCommandTimeoutMs
  // rather than gateCommandTimeoutMs, because the gate field's max is the raw timer ceiling and so takes
  // the one-sided form pinned in the next check. Derived from the LIVE bound rather than a hardcoded
  // "1800s", so this keeps discriminating if either end ever moves instead of silently testing a value
  // that is no longer out of range.
  const b = ORCHESTRATION_TIMEOUT_MS_BOUNDS.deployCommandTimeoutMs;
  const minS = b.min / 1000, maxS = b.max / 1000; // field's own unit (seconds)
  const overMax = String(maxS + 1);
  assert.equal(msRangeError(overMax, "s", b), `must be between ${minS}s and ${maxS}s`);
  assert.equal(msRangeError(String(minS / 2), "s", b), `must be between ${minS}s and ${maxS}s`);
  // The raw millisecond figures never appear in the message — that is the whole point. Both ends, since
  // only one of them is what a careless `${b.min}`/`${b.max}` interpolation would leak.
  const msg = msRangeError(overMax, "s", b);
  assert.equal(new RegExp(String(b.max)).test(msg), false);
  assert.equal(new RegExp(String(b.min)).test(msg), false);
});

check("msRangeError omits the max half exactly where msRangeHint does, and says which end was breached", () => {
  // Card cb6a51b8. msRangeHint already refused to render a MAX_TIMER_DELAY_MS ceiling as a figure (it
  // divides to 2147483.647s / 35791.39411666667m / 596.5232352777778h — a non-policy number that reads as
  // a policy choice), but the ERROR interpolated it anyway. The two renderers now share one rule, so a
  // figure hidden from the hint can never arrive via the error instead.
  const b = ORCHESTRATION_TIMEOUT_MS_BOUNDS.gateCommandTimeoutMs;
  assert.equal(b.max, MAX_TIMER_DELAY_MS, "this check is only meaningful while the gate field has no policy max");
  // UNDER the floor — the common case, and the one that used to read "must be between 1s and 2147483.647s".
  assert.equal(msRangeError("0.5", "s", b), "must be at least 1s");
  // OVER the ceiling — the ceiling is named in words, never as a figure.
  assert.equal(msRangeError(String(b.max / 1000 + 1), "s", b), "must not exceed the maximum timer delay");
  // Neither polarity leaks the figure, in ms or in ANY display unit this module has. The loop is what
  // makes this a rule about the number rather than about the one rendering that happened to be wrong.
  for (const value of ["0.5", String(b.max / 1000 + 1)]) {
    const msg = msRangeError(value, "s", b);
    assert.ok(msg, `expected an error for ${value}`);
    for (const fig of [String(b.max), ...Object.keys(UNIT_MS).map((u) => String(b.max / UNIT_MS[u]))]) {
      assert.equal(msg.includes(fig), false, `"${msg}" leaks the unstatable ceiling as ${fig}`);
    }
  }
  // CONTROL on the rule, not the constant: a bound ONE MILLISECOND below the timer ceiling is an ordinary
  // policy max and must still state BOTH halves. Without this, "omit the max half" could have been
  // implemented as "omit any large max" and this check would not notice.
  const nearly = { min: 1000, max: MAX_TIMER_DELAY_MS - 1 };
  assert.equal(
    msRangeError("0.5", "s", nearly),
    `must be between 1s and ${(MAX_TIMER_DELAY_MS - 1) / 1000}s`,
  );
  // And an in-range value is still clean at such a bound — the omission changes the MESSAGE, never the verdict.
  assert.equal(msRangeError("1", "s", b), null);
  assert.equal(msRangeError(String(b.max / 1000), "s", b), null);
});

check("msRangeError reports nothing for blank, for no bounds, or for a non-numeric entry", () => {
  const b = { min: 1000, max: 2000 };
  assert.equal(msRangeError("", "s", b), null);
  assert.equal(msRangeError("   ", "s", b), null);
  assert.equal(msRangeError("1.5", "s", undefined), null);
  assert.equal(msRangeError("abc", "s", b), null); // the NaN -> strict-zod 400 path owns this one
});

check("msInUnit / msRangeHint translate a canonical-ms bound into the displayed unit", () => {
  assert.equal(msInUnit(1_800_000, "s"), "1800s");
  assert.equal(msInUnit(500, "s"), "0.5s");
  assert.equal(msInUnit(3_600_000, "h"), "1h");
  assert.equal(msRangeHint({ min: 5000, max: 3_600_000 }, "s"), "min 5s · max 3600s");
  assert.equal(msRangeHint(PLATFORM_MS_BOUNDS.updateCheckIntervalMs, "h"), "min 1h · max 24h");
});

check("msRangeHint omits the max half for a bound sitting at MAX_TIMER_DELAY_MS (the raw timer ceiling, not a policy cap)", () => {
  assert.equal(msRangeHint(ORCHESTRATION_TIMEOUT_MS_BOUNDS.gateCommandTimeoutMs, "s"), "min 1s");
  // Control: an ordinary bound (not at the timer ceiling) still shows its max, same as before.
  assert.equal(msRangeHint({ min: 1000, max: MAX_TIMER_DELAY_MS - 1 }, "s"), `min 1s · max ${(MAX_TIMER_DELAY_MS - 1) / 1000}s`);
});

check("msRangeErrors names each offending field and omits the clean ones", () => {
  const b = { min: 1000, max: 60_000 };
  assert.deepEqual(
    msRangeErrors([
      ["Git push (s)", "999", "s", b],
      ["Git local op (s)", "30", "s", b],
      ["Reconcile (s)", "", "s", b],
      ["Wake tick (s)", "120", "s", b],
    ]),
    ["Git push (s) must be between 1s and 60s", "Wake tick (s) must be between 1s and 60s"],
  );
  assert.deepEqual(msRangeErrors([]), []);
});

// ── (3) The relocated bounds equal the literals the daemon schema enforced before the move ───────────
//
// A hand-authored copy of mcp/platform.ts's pre-0a5d61c9 `.min()/.max()` literals. Independent of the
// table under test, so a relocation typo fails here instead of quietly changing a platform-wide bound.

const WATCHER = { min: 5000, max: 3_600_000 };
const EXPECTED_PLATFORM_MS_BOUNDS = {
  rateLimit: {
    defaultBackoffMs: { min: 60_000, max: 86_400_000 },
    resetBufferMs: { min: 0, max: 600_000 },
    deadlineAfterResetMs: { min: 60_000, max: 86_400_000 },
    deadlineNoResetMs: { min: 600_000, max: 172_800_000 },
    recencyWindowMs: { min: 0, max: 86_400_000 },
    // Card dfef375f item 3 (the loop breaker) — loopBreakerMaxRecaps is a plain count, deliberately
    // absent (mirrors exhaustedThresholdPct, unitless and also absent from this table).
    // Round 2: loopBreakerQuickGapMs replaces loopBreakerWindowMs — a SHORT gap by design ("a few
    // minutes"), so its floor is seconds, not the shared 60s floor every other rateLimit field uses.
    loopBreakerQuickGapMs: { min: 1_000, max: 3_600_000 },
    loopBreakerBackoffBaseMs: { min: 60_000, max: 86_400_000 },
    loopBreakerBackoffCeilingMs: { min: 60_000, max: 86_400_000 },
  },
  watchers: {
    contextWatchMs: WATCHER,
    idleWatchMs: WATCHER,
    rateLimitWatchMs: WATCHER,
    usagePollMs: WATCHER,
    wakeMs: WATCHER,
    schedulerMs: WATCHER,
    reconcileMs: WATCHER,
    snapshotMs: WATCHER,
    crashRecoveryWatchMs: WATCHER,
    pollMs: WATCHER,
  },
  timeouts: {
    gitOpMs: { min: 1000, max: 120_000 },
    gitLocalMs: { min: 1000, max: 120_000 },
    gitPushMs: { min: 1000, max: 600_000 },
    provisionMs: { min: 10_000, max: 1_800_000 },
    busyStaleMs: { min: 30_000, max: 1_800_000 },
    runMs: { min: 30_000, max: 3_600_000 },
  },
  connections: {
    requestTimeoutMs: { min: 1000, max: 120_000 },
    rateLimitWindowMs: { min: 1000, max: 3_600_000 },
  },
  usageSampleIntervalMs: { min: 60_000, max: 3_600_000 },
  updateCheckIntervalMs: { min: 3_600_000, max: 86_400_000 },
};

check("PLATFORM_MS_BOUNDS matches the pre-relocation daemon-schema literals, exactly and exhaustively", () => {
  // deepEqual both ways round: a MISSING entry and an EXTRA one are both failures. An extra entry here
  // means a bound was added to the table without a matching decision about what the schema enforces.
  assert.deepEqual(
    JSON.parse(JSON.stringify(PLATFORM_MS_BOUNDS)),
    EXPECTED_PLATFORM_MS_BOUNDS,
  );
});

check("every PLATFORM_MS_BOUNDS entry is a well-formed, non-degenerate ms range", () => {
  const walk = (node, path) => {
    if (typeof node.min === "number" && typeof node.max === "number") {
      assert.equal(Number.isInteger(node.min), true, `${path}.min must be a whole ms`);
      assert.equal(Number.isInteger(node.max), true, `${path}.max must be a whole ms`);
      assert.equal(node.min >= 0, true, `${path}.min must not be negative`);
      assert.equal(node.min < node.max, true, `${path} must be a non-empty range`);
      return 1;
    }
    return Object.entries(node).reduce((n, [k, v]) => n + walk(v, `${path}.${k}`), 0);
  };
  const leaves = walk(PLATFORM_MS_BOUNDS, "PLATFORM_MS_BOUNDS");
  // 8 rateLimit (card dfef375f item 3 added 3: loopBreakerQuickGapMs/BackoffBaseMs/BackoffCeilingMs) +
  // 10 watchers + 6 timeouts + 2 connections + 2 top-level.
  assert.equal(leaves, 28);
});

check("a unitless platform field is deliberately ABSENT from the ms table", () => {
  // Listing one would imply a unit translation that does not exist. Guards against a well-meaning future
  // edit folding the plain counts in alongside the ms fields.
  assert.equal("exhaustedThresholdPct" in PLATFORM_MS_BOUNDS.rateLimit, false);
  assert.equal("loopBreakerMaxRecaps" in PLATFORM_MS_BOUNDS.rateLimit, false);
  assert.equal("maxResponseBytes" in PLATFORM_MS_BOUNDS.connections, false);
  assert.equal("rateLimitMax" in PLATFORM_MS_BOUNDS.connections, false);
  assert.equal("usageSampleRetentionDays" in PLATFORM_MS_BOUNDS, false);
  assert.equal("maxConcurrentGates" in PLATFORM_MS_BOUNDS, false);
});

// ── (4) Source scans: the helper is the only conversion, and no global field is silently unbounded ───

const settingsSrc = readFileSync(join(srcDir, "pages", "Settings.tsx"), "utf8");

/** The GLOBAL_FIELDS table as Settings.tsx literally declares it: key -> {grp, sub, label, unit}. Read
 *  from the source literal rather than imported, because importing the .tsx would pull React in. */
function globalFieldsTable() {
  const block = settingsSrc.slice(
    settingsSrc.indexOf("const GLOBAL_FIELDS: GlobalFieldDesc[] = ["),
    settingsSrc.indexOf("// Loads /api/platform/config then mounts the form"),
  );
  const out = new Map();
  for (const m of block.matchAll(
    /\{\s*grp:\s*"(\w+)",\s*(?:sub:\s*"(\w+)",\s*)?key:\s*"(\w+)",\s*label:\s*"([^"]*)",\s*unit:\s*"(\w+)"/g,
  )) out.set(m[3], { grp: m[1], sub: m[2], label: m[4], unit: m[5] });
  return out;
}

check("every GLOBAL_FIELDS entry in Settings.tsx has a PLATFORM_MS_BOUNDS entry", () => {
  // MsField silently renders no range hint and no inline error when `bounds` is undefined, so a global ms
  // field added without a bound fails OPEN — invisible in a render-only eyeball. This scan is what makes
  // that visible. Reads the literal table so it can never drift from what the page actually renders.
  const block = settingsSrc.slice(
    settingsSrc.indexOf("const GLOBAL_FIELDS: GlobalFieldDesc[] = ["),
    settingsSrc.indexOf("// Loads /api/platform/config then mounts the form"),
  );
  assert.equal(block.length > 0, true, "could not locate the GLOBAL_FIELDS table");
  // `sub` (card 826483a7's presentational second axis) sits BETWEEN grp and key on the entries that carry
  // it, so it must be optional-matched here rather than ignored: a `grp,key`-only pattern silently skips
  // every sub-carrying entry, which is the exact fail-OPEN this scan exists to prevent. The count
  // assertion below is what makes a future regression here loud instead of invisible.
  const entries = [...block.matchAll(/\{\s*grp:\s*"(\w+)",\s*(?:sub:\s*"\w+",\s*)?key:\s*"(\w+)"/g)].map((m) => [m[1], m[2]]);
  // Positive control on the scan itself: a broken regex returning zero rows must fail, not pass silently.
  assert.equal(entries.length, 24, `expected 24 GLOBAL_FIELDS entries, parsed ${entries.length}`);
  for (const [grp, key] of entries) {
    const group = PLATFORM_MS_BOUNDS[grp];
    assert.ok(group, `GLOBAL_FIELDS group "${grp}" has no PLATFORM_MS_BOUNDS group`);
    assert.ok(group[key], `GLOBAL_FIELDS field ${grp}.${key} has no PLATFORM_MS_BOUNDS entry (it would render unbounded)`);
  }
});

/** A bound figure MsField actually renders: `ms / UNIT_MS[unit]`, stringified. "Legible" = a whole number
 *  or at most two decimals, so `0.5s` stays a perfectly good way to state a 500ms floor while
 *  `0.016666666666666666h` does not. Exponential notation (`1e-7`) fails too, by the same reading. */
const LEGIBLE_FIGURE = /^\d+(\.\d{1,2})?$/;
const figureIn = (ms, unit) => String(ms / UNIT_MS[unit]);

/** Which halves of a bound a field actually RENDERS as a figure. `MAX_TIMER_DELAY_MS` is the raw Node
 *  timer ceiling rather than a policy cap, and since card cb6a51b8 BOTH renderers suppress it — the hint
 *  drops the max half and the inline error goes one-sided ("must not exceed the maximum timer delay"), so
 *  there is no path left by which that figure reaches the page and nothing to check. Every other max is
 *  rendered twice over, which is why both halves are checked below. */
const renderedHalves = (b) => (b.max === MAX_TIMER_DELAY_MS ? ["min"] : ["min", "max"]);

/** Assert every figure a bounded field renders reads as a short number in its own declared unit. Shared
 *  by the GLOBAL_FIELDS sweep and the hand-written-call-site sweep so the two can never drift into
 *  judging the same thing by different rules. `what` names the offender in the failure. */
function assertLegibleBothHalves(b, unit, what) {
  for (const half of renderedHalves(b)) {
    const fig = figureIn(b[half], unit);
    assert.ok(
      LEGIBLE_FIGURE.test(fig),
      `${what} in "${unit}" renders its ${half} bound as ${fig}${unit} — pick a unit whose bound reads as a short figure`,
    );
  }
}

check("every GLOBAL_FIELDS entry renders BOTH halves of its bound as a legible figure in its own unit", () => {
  // Card 7663eeb4. The per-field version of this rule arrived with card 826483a7's three loop-breaker
  // fields (section 5 below, which pins their tighter whole-number choice); it is corpus-wide here
  // because the two fields that actually shipped the defect — "Default backoff" and "Deadline, no reset",
  // both in hours over a sub-hour floor — predate that card and no check could see them. A unit is not a
  // per-card aesthetic decision: it decides whether this field's own policy bound is statable at all.
  //
  // This covers the GLOBAL_FIELDS *table*. Settings.tsx's hand-written MsField call sites declare their
  // unit and bounds inline and are invisible here; the check immediately below sweeps those, by the same
  // rule through the same helper (card cb6a51b8, which closed the one illegible call site 7663eeb4 could
  // only report up — Connections → "Rate limit window", floor 1000ms, then in minutes).
  const table = globalFieldsTable();
  // Second exact count, on a SEPARATE regex from the scan above: both must see the whole table, so a
  // future property inserted between `grp` and `key` cannot silently empty one of them (card 826483a7
  // shipped exactly that fail-open, caught only by a count).
  assert.equal(table.size, 24, `expected 24 parsed GLOBAL_FIELDS entries, got ${table.size}`);
  for (const [key, { grp, unit, label }] of table) {
    assertLegibleBothHalves(PLATFORM_MS_BOUNDS[grp][key], unit, `${label} (${grp}.${key})`);
  }
  // Discriminating controls on the RULE, so the sweep above cannot pass merely by matching anything.
  // Hours over these two floors is a real option the table could pick (it is what it picked until this
  // card) and is exactly what the rule rejects:
  assert.equal(LEGIBLE_FIGURE.test(figureIn(PLATFORM_MS_BOUNDS.rateLimit.defaultBackoffMs.min, "h")), false);
  assert.equal(LEGIBLE_FIGURE.test(figureIn(PLATFORM_MS_BOUNDS.rateLimit.deadlineNoResetMs.min, "h")), false);
  // ...while a sub-unit bound that still reads cleanly must NOT be rejected — the rule is legibility,
  // not whole numbers (a stricter integer rule here would forbid a legitimate "0.5s" floor).
  assert.equal(LEGIBLE_FIGURE.test(figureIn(500, "s")), true);
  assert.equal(LEGIBLE_FIGURE.test(figureIn(0, "h")), true);
  // And the figures the page really prints come from msInUnit/msRangeHint, not from this test's own
  // arithmetic — asserted through the helper, at whatever unit the table currently declares, so changing
  // either field's unit back fails HERE with the rendered string rather than only in the sweep.
  for (const [key, expected] of [
    ["defaultBackoffMs", "min 1m · max 1440m"],
    ["deadlineNoResetMs", "min 10m · max 2880m"],
  ]) {
    assert.equal(msRangeHint(PLATFORM_MS_BOUNDS.rateLimit[key], table.get(key).unit), expected, key);
  }
});

/** The canonical-ms bounds tables a Settings.tsx `bounds={…}` prop may name. A path rooted anywhere else
 *  FAILS the sweep below rather than being skipped — a third table added later must be wired in here
 *  deliberately, not drop silently out of coverage. */
const MS_BOUND_ROOTS = { PLATFORM_MS_BOUNDS, ORCHESTRATION_TIMEOUT_MS_BOUNDS };

/** Every `<MsField …/>` element in Settings.tsx, as its raw prop text. Lazy to the first `/>` after the
 *  tag name, which is that element's own close for every call site in this file: none nests a child
 *  element, and no prop string contains a `/>`. */
const msFieldCallSites = () => [...settingsSrc.matchAll(/<MsField\b([\s\S]*?)\/>/g)].map((m) => m[1]);

check("every hand-written MsField call site renders its bound as a legible figure in its own unit", () => {
  // Card cb6a51b8, the second half of the rule above. The GLOBAL_FIELDS sweep reads a TABLE; these call
  // sites declare `unit` and `bounds` inline in JSX, so they had no static coverage at all — and one of
  // them had shipped the very defect card 7663eeb4 fixed in the table (Connections → "Rate limit window",
  // a 1000ms floor rendered in minutes as 0.016666666666666666m, in the always-on hint AND the inline
  // error). They are swept here through the SAME `assertLegibleBothHalves` helper, so the two populations
  // can never be judged by rules that have drifted apart.
  //
  // Deliberately NOT checked here: that a label's own "(s)"/"(m)"/"(h)" suffix agrees with the declared
  // `unit`. That is a different rule about a different hazard (a mislabelled box, silently off by 60×),
  // the table-driven fields have no such check either, and bolting it on would make this sweep's own
  // negative control — flip one `unit` and leave the label — red for two reasons instead of one.
  const sites = msFieldCallSites();
  // Positive control on the parse: a regex that stopped matching would empty this sweep and pass clean.
  assert.equal(sites.length, 9, `expected 9 <MsField> call sites in Settings.tsx, parsed ${sites.length}`);

  const literal = (props, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(props) ?? [])[1];
  const handWritten = [], tableDriven = [];
  for (const props of sites) {
    const unit = literal(props, "unit");
    (unit === undefined ? tableDriven : handWritten).push({ props, unit, label: literal(props, "label") });
  }
  // The PARTITION is pinned too: exactly one site takes its unit from a variable, and it is the
  // GLOBAL_FIELDS renderer the check above already covers field by field. A second expression-unit site
  // would be a genuine hole — a bounded field no static check can see — so it must fail here, loudly,
  // rather than land in the bucket this sweep skips.
  assert.equal(tableDriven.length, 1, `expected exactly 1 table-driven <MsField> site, found ${tableDriven.length}`);
  assert.ok(/unit=\{f\.unit\}/.test(tableDriven[0].props), "the one expression-unit site should be the GLOBAL_FIELDS renderer");
  assert.equal(handWritten.length, 8, `expected 8 hand-written <MsField> sites, found ${handWritten.length}`);

  for (const { props, unit, label } of handWritten) {
    assert.ok(label, `a hand-written <MsField> has no literal label: ${props.trim().slice(0, 80)}`);
    // `bounds` must be a plain dotted path into one of the shared tables — the only shape this scan can
    // resolve, and the only shape a hand-written site has ever used. A computed expression, or a missing
    // prop (MsField then renders NO hint and NO inline error at all — the same fail-open the table scan
    // above exists to catch), fails rather than being skipped.
    const path = (/\bbounds=\{([A-Za-z_][\w.]*)\}/.exec(props) ?? [])[1];
    assert.ok(path, `${label} declares a literal unit but no resolvable bounds path — it would render unbounded`);
    const [root, ...rest] = path.split(".");
    assert.ok(root in MS_BOUND_ROOTS, `${label} reads bounds from an unknown table "${root}" — add it to MS_BOUND_ROOTS`);
    const b = rest.reduce((o, k) => (o ?? {})[k], MS_BOUND_ROOTS[root]);
    assert.ok(b && typeof b.min === "number" && typeof b.max === "number", `${label}: ${path} is not an MsBounds entry`);
    assertLegibleBothHalves(b, unit, `${label} (${path})`);
  }

  // Discriminating control, on the real specimen: the SAME field's SAME bound, in the unit it actually
  // shipped in, is rejected — so the sweep above passes because the unit moved, not because the rule
  // matches anything handed to it. Asserted through the shared helper, not just the regex, so a helper
  // that stopped throwing would be caught here as well.
  const window = PLATFORM_MS_BOUNDS.connections.rateLimitWindowMs;
  assert.equal(LEGIBLE_FIGURE.test(figureIn(window.min, "m")), false);
  assert.equal(LEGIBLE_FIGURE.test(figureIn(window.min, "s")), true);
  assert.throws(
    () => assertLegibleBothHalves(window, "m", "Rate limit window"),
    /renders its min bound as 0\.016666666666666666m/,
  );
  // And the strings the page really prints come from the helpers, at the unit the source now declares.
  assert.equal(msRangeHint(window, "s"), "min 1s · max 3600s");
  assert.equal(msRangeError("0.5", "s", window), "must be between 1s and 3600s");
});

// ── (5) The rate-limit loop-breaker fields are actually rendered, in units that read whole ───────────
//
// Card 826483a7. Card dfef375f landed four platform fields that no control rendered — REST-only, so the
// only way to tune the loop breaker was a hand-written PATCH. These pin that they are on the page AND
// that each ms one is displayed in the unit whose shared bound is a WHOLE number: `loopBreakerQuickGapMs`
// has a deliberately-seconds floor (1s), and both backoff fields' floor is 60_000 — shown in hours that
// renders "min 0.016666666666666666h", which reads as a broken hint rather than a policy minimum.

check("the three loop-breaker ms fields are rendered by Settings.tsx, under the loopBreaker sub-panel", () => {
  const table = globalFieldsTable();
  // Positive control: the same parse finds a long-standing field, so a zero/short parse cannot read as
  // "the loop-breaker fields are missing".
  assert.ok(table.get("defaultBackoffMs"), "the parse no longer finds a pre-existing GLOBAL_FIELDS entry");
  assert.equal(table.get("defaultBackoffMs").sub, undefined, "a plain rateLimit field must carry no sub");
  for (const key of ["loopBreakerQuickGapMs", "loopBreakerBackoffBaseMs", "loopBreakerBackoffCeilingMs"]) {
    const f = table.get(key);
    assert.ok(f, `${key} is REST-only again — no GLOBAL_FIELDS entry renders it`);
    assert.equal(f.grp, "rateLimit", `${key} must PATCH into the rateLimit group`);
    assert.equal(f.sub, "loopBreaker", `${key} must render in the loop-breaker panel, not the Rate Limits grid`);
  }
});

check("each loop-breaker ms field is displayed in a unit that renders BOTH its shared bounds whole", () => {
  const table = globalFieldsTable();
  for (const key of ["loopBreakerQuickGapMs", "loopBreakerBackoffBaseMs", "loopBreakerBackoffCeilingMs"]) {
    const { unit } = table.get(key);
    const b = PLATFORM_MS_BOUNDS.rateLimit[key];
    for (const half of ["min", "max"]) {
      assert.equal(
        Number.isInteger(b[half] / UNIT_MS[unit]), true,
        `${key} shown in "${unit}" renders its ${half} as ${b[half] / UNIT_MS[unit]}${unit} — pick a unit whose bound is whole`,
      );
    }
  }
  // Discriminating control: hours is a REAL option the table could have picked for the two backoff
  // fields, and it is exactly what this assertion rejects — so the check above is not vacuous.
  assert.equal(Number.isInteger(PLATFORM_MS_BOUNDS.rateLimit.loopBreakerBackoffBaseMs.min / UNIT_MS.h), false);
  // The two backoff fields share ONE unit on purpose: "base must not exceed ceiling" (the clamp below) is
  // only readable on the page if both are entered in the same unit.
  assert.equal(table.get("loopBreakerBackoffBaseMs").unit, table.get("loopBreakerBackoffCeilingMs").unit);
});

check("an out-of-range loop-breaker entry is rejected in the field's OWN unit, never raw ms", () => {
  const table = globalFieldsTable();
  for (const key of ["loopBreakerQuickGapMs", "loopBreakerBackoffBaseMs", "loopBreakerBackoffCeilingMs"]) {
    const { unit, label } = table.get(key);
    const b = PLATFORM_MS_BOUNDS.rateLimit[key];
    const expected = `must be between ${msInUnit(b.min, unit)} and ${msInUnit(b.max, unit)}`;
    const overMax = String(b.max / UNIT_MS[unit] + 1);
    assert.equal(msRangeError(overMax, unit, b), expected, `${label} ceiling`);
    // The raw millisecond ceiling — what the server's own 400 quotes — never reaches the user.
    assert.equal(new RegExp(String(b.max)).test(msRangeError(overMax, unit, b)), false);
    // In range stays silent, so the error above is not a field that simply always complains.
    assert.equal(msRangeError(String(b.max / UNIT_MS[unit]), unit, b), null, `${label} exactly on max`);
  }
  // And a blocked Save names the field, using the label the page actually renders.
  assert.deepEqual(
    msRangeErrors([[
      table.get("loopBreakerBackoffCeilingMs").label, "99999", table.get("loopBreakerBackoffCeilingMs").unit,
      PLATFORM_MS_BOUNDS.rateLimit.loopBreakerBackoffCeilingMs,
    ]]),
    ["Backoff ceiling (m) must be between 1m and 1440m"],
  );
});

check("the plain-count loop-breaker field has its OWN control, deliberately outside the ms grid", () => {
  // Absent from GLOBAL_FIELDS (it has no unit to translate), but it must still be ON the page — so assert
  // both halves: a bare "not in the grid" check passes just as happily if nothing renders it at all.
  assert.equal(globalFieldsTable().has("loopBreakerMaxRecaps"), false);
  assert.equal("loopBreakerMaxRecaps" in PLATFORM_MS_BOUNDS.rateLimit, false);
  assert.ok(
    /<NumField label="Max consecutive re-caps"/.test(settingsSrc),
    "loopBreakerMaxRecaps has no NumField — it is REST-only again",
  );
  // Its value must reach the wire: the field is read inside buildGlobalOverride's rateLimit branch (the
  // mis-bound-write-key hazard — a rendered control writing nothing looks identical to a working one).
  assert.ok(
    /entries\.loopBreakerMaxRecaps\s*=/.test(settingsSrc),
    "the Max consecutive re-caps control never writes loopBreakerMaxRecaps into the PATCH body",
  );
});

check("backoff base above its ceiling is CLAMPED at resolve time, never rejected (card dfef375f round 2 item 7)", () => {
  // The loop breaker's one cross-field invariant. It is deliberately NOT a zod rejection: base and ceiling
  // are independently valid, only the COMBINATION is wrong, and a human editing one field at a time must
  // not get a 400 for a transient combination. So the UI must NOT invent a client-side rejection either —
  // it states the clamp in the base field's note and lets the `effective:` hint show the resolved value.
  // Second arg IS the PlatformConfigOverride (no `platform:` wrapper) — the same call Settings.tsx makes.
  const resolved = resolveConfig(undefined, {
    rateLimit: { loopBreakerBackoffBaseMs: 86_400_000, loopBreakerBackoffCeilingMs: 1_800_000 },
  }).platform.rateLimit;
  assert.equal(resolved.loopBreakerBackoffCeilingMs, 1_800_000, "the ceiling itself is honored as written");
  assert.equal(resolved.loopBreakerBackoffBaseMs, 1_800_000, "a base above the ceiling must resolve TO the ceiling");
  // Control: a base BELOW the ceiling is passed through untouched, so the clamp is a clamp and not a
  // blanket overwrite of the base with the ceiling.
  const ok = resolveConfig(undefined, {
    rateLimit: { loopBreakerBackoffBaseMs: 600_000, loopBreakerBackoffCeilingMs: 1_800_000 },
  }).platform.rateLimit;
  assert.equal(ok.loopBreakerBackoffBaseMs, 600_000);
  // Both single-field values the clamp fired on are individually IN RANGE — so the combination really is
  // the only thing wrong, which is why no single-field bound check can catch it.
  assert.equal(msRangeError("1440", "m", PLATFORM_MS_BOUNDS.rateLimit.loopBreakerBackoffBaseMs), null);
  assert.equal(msRangeError("30", "m", PLATFORM_MS_BOUNDS.rateLimit.loopBreakerBackoffCeilingMs), null);
  // And the page says so where the user is typing, naming the referenced field rather than its position
  // (the Settings positional-hint trap: "the field above" is true at one width, if any).
  assert.ok(
    /Clamped to never exceed the backoff ceiling\./.test(settingsSrc),
    "the backoff-base note no longer states the clamp against the ceiling by name",
  );
  // And the LIVE advisory is a status, not an error: it must never join globalRangeErrors (which gates
  // Save), or the UI would be rejecting the very combination the daemon accepts and clamps.
  assert.ok(/data-testid="loop-breaker-clamp-note"/.test(settingsSrc), "the live clamp advisory is gone");
  assert.ok(/role="status"[\s\S]{0,120}loop-breaker-clamp-note/.test(settingsSrc),
    "the clamp advisory must be role=status, not role=alert — it does not block Save");
  const rangeErrorsCall = settingsSrc.slice(
    settingsSrc.indexOf("const globalRangeErrors = msRangeErrors(["),
    settingsSrc.indexOf("const group = (grp: Grp"),
  );
  assert.equal(rangeErrorsCall.length > 0, true, "could not locate the globalRangeErrors call");
  assert.equal(/loopBreakerClamp/.test(rangeErrorsCall), false,
    "the clamp advisory leaked into globalRangeErrors — that would block Save on a combination the daemon accepts");
});

check("no bare `Number(...) * UNIT_MS` conversion survives anywhere under src/", () => {
  // The whole card is "ONE ms-conversion helper". A second, unrounded call site reintroduces the exact
  // 400 this fixes, and nothing else in the suite would notice.
  const files = [];
  const walkDir = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walkDir(full);
      else if (/\.tsx?$/.test(e.name)) files.push(full);
    }
  };
  walkDir(srcDir);
  // Positive control: the scan must actually be reading real files.
  assert.equal(files.length > 20, true, `expected to scan many src files, found ${files.length}`);
  const bare = /Number\([^)]*\)\s*\*\s*UNIT_MS/;
  const offenders = files.filter((f) => bare.test(readFileSync(f, "utf8")));
  // The one legitimate site is msFromUnit's own body, which rounds — assert it IS matched, so the pattern
  // is proven capable of firing before the emptiness of the rest is read as meaningful.
  const helper = join(srcDir, "lib", "msUnits.ts");
  assert.equal(bare.test(readFileSync(helper, "utf8")), true, "the scan pattern no longer matches msFromUnit's own body");
  assert.deepEqual(offenders, [helper], `bare ms conversion outside msFromUnit: ${offenders.join(", ")}`);
});

console.log(`\n${pass} check(s) passed`);
