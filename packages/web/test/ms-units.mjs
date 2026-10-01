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
//   (4) Two source scans: every GLOBAL_FIELDS entry in Settings.tsx has a bound (a missing one renders a
//       silently unbounded field, since MsField simply drops the hint when `bounds` is undefined), and no
//       bare `Number(...) * UNIT_MS` conversion has crept back in anywhere under src/.
//
// Like fleet.mjs/merge-gate.mjs, the web package has no test runner, so this is a self-contained node
// script, auto-discovered by test/run-all.mjs (wired into @loom/web's `build`). Standalone:
//   node --experimental-strip-types packages/web/test/ms-units.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLATFORM_MS_BOUNDS, ORCHESTRATION_TIMEOUT_MS_BOUNDS } from "@loom/shared";
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
  assert.equal(
    msRangeError("8000", "s", ORCHESTRATION_TIMEOUT_MS_BOUNDS.gateCommandTimeoutMs),
    "must be between 1s and 7200s",
  );
  assert.equal(
    msRangeError("0.5", "s", ORCHESTRATION_TIMEOUT_MS_BOUNDS.gateCommandTimeoutMs),
    "must be between 1s and 7200s",
  );
  // The raw millisecond figure never appears in the message — that is the whole point.
  const msg = msRangeError("8000", "s", ORCHESTRATION_TIMEOUT_MS_BOUNDS.gateCommandTimeoutMs);
  assert.equal(/7200000/.test(msg), false);
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
  // 5 rateLimit + 10 watchers + 6 timeouts + 2 connections + 2 top-level.
  assert.equal(leaves, 25);
});

check("a unitless platform field is deliberately ABSENT from the ms table", () => {
  // Listing one would imply a unit translation that does not exist. Guards against a well-meaning future
  // edit folding the plain counts in alongside the ms fields.
  assert.equal("exhaustedThresholdPct" in PLATFORM_MS_BOUNDS.rateLimit, false);
  assert.equal("maxResponseBytes" in PLATFORM_MS_BOUNDS.connections, false);
  assert.equal("rateLimitMax" in PLATFORM_MS_BOUNDS.connections, false);
  assert.equal("usageSampleRetentionDays" in PLATFORM_MS_BOUNDS, false);
  assert.equal("maxConcurrentGates" in PLATFORM_MS_BOUNDS, false);
});

// ── (4) Source scans: the helper is the only conversion, and no global field is silently unbounded ───

const settingsSrc = readFileSync(join(srcDir, "pages", "Settings.tsx"), "utf8");

check("every GLOBAL_FIELDS entry in Settings.tsx has a PLATFORM_MS_BOUNDS entry", () => {
  // MsField silently renders no range hint and no inline error when `bounds` is undefined, so a global ms
  // field added without a bound fails OPEN — invisible in a render-only eyeball. This scan is what makes
  // that visible. Reads the literal table so it can never drift from what the page actually renders.
  const block = settingsSrc.slice(
    settingsSrc.indexOf("const GLOBAL_FIELDS: GlobalFieldDesc[] = ["),
    settingsSrc.indexOf("// Loads /api/platform/config then mounts the form"),
  );
  assert.equal(block.length > 0, true, "could not locate the GLOBAL_FIELDS table");
  const entries = [...block.matchAll(/\{\s*grp:\s*"(\w+)",\s*key:\s*"(\w+)"/g)].map((m) => [m[1], m[2]]);
  // Positive control on the scan itself: a broken regex returning zero rows must fail, not pass silently.
  assert.equal(entries.length, 21, `expected 21 GLOBAL_FIELDS entries, parsed ${entries.length}`);
  for (const [grp, key] of entries) {
    const group = PLATFORM_MS_BOUNDS[grp];
    assert.ok(group, `GLOBAL_FIELDS group "${grp}" has no PLATFORM_MS_BOUNDS group`);
    assert.ok(group[key], `GLOBAL_FIELDS field ${grp}.${key} has no PLATFORM_MS_BOUNDS entry (it would render unbounded)`);
  }
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
