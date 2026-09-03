// Card bcaba183 — install.ps1 hard-codes `$WindowsBuildFloor = 18309` and refuses to install below it.
// That number is NOT arbitrary: it is node-pty's own ConPTY threshold, vendored at
// node_modules/node-pty/lib/windowsPtyAgent.js — `this._useConpty = this._getWindowsBuildNumber() >= 18309`.
// Nothing links the two today. If a future node-pty bump (the deferred 1.2.0 GA line, card a1f111f4,
// already removed winpty entirely) moves that threshold, install.ps1 keeps enforcing the OLD one and
// nothing catches the drift — the installer would either block users the runtime would have supported,
// or admit users the runtime won't. This test closes that gap.
//
// PRECEDENT: same hazard shape as test/node-pty-quoting-parity.mjs (a node-pty bump silently changing a
// hand-maintained adaptation) — this mirrors its structure: extract the REAL value from the vendored
// dependency, extract OUR hand-maintained copy, and assert byte/number equality. Unlike that test,
// this one is NOT Windows-only-runnable (see PORTABILITY below).
//
// EXTRACTION METHOD, and why it's brittle by nature (card DoD-2): both values are pulled out of shipped
// TEXT via regex — install.ps1's own `$WindowsBuildFloor = <N>` assignment, and node-pty's compiled
// `_getWindowsBuildNumber() >= <N>` comparison. A regex over someone else's source is inherently fragile:
// if upstream reshapes the expression (a named constant, a different comparison operator, a helper
// function), the pattern can silently stop matching. ⛔ THAT is a silent-failure polarity a guard must
// never have: a matcher that finds NOTHING must FAIL loudly, never fall through as a pass. Both
// extractions below throw (exit 1) on zero matches AND on more than one match (ambiguous) — this test
// never treats "couldn't find it" as "must still be fine".
//
// PORTABILITY (DoD-4): this test reads windowsPtyAgent.js as PLAIN TEXT (fs.readFileSync via
// require.resolve to locate it) — it never `require()`s/executes the module, never touches ConPTY/winpty
// native bindings, and never runs any Windows-specific pty code. That keeps it safe to run unconditionally
// in the ordinary cross-platform gate (this repo's CI runs ubuntu-latest) instead of silently no-oping
// there — a Windows-only concern still needs a check that actually RUNS somewhere other than the owner's
// Windows gate host.
//
// POSITIVE CONTROL (DoD-3): the property holds today, so a broken/vacuous comparator would read green
// and prove nothing. Below, a comparator sanity check (mirroring node-pty-quoting-parity.mjs's own
// pattern) proves plain `===` on two extracted numbers can report BOTH a genuine mismatch and a genuine
// match, using synthetic values, before any real-file verdict is trusted. Separately (not embedded here,
// since it would require mutating real repo files at test time), this guard was verified end-to-end by
// temporarily editing install.ps1's `$WindowsBuildFloor` value, confirming this test goes RED, then
// restoring it and confirming GREEN again — see the worker report for card bcaba183 for that run.
//
// KEPT NARROW (DoD-5): one named constant pair. No open-ended scanning of either file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function fail(message) {
  console.error(`❌ windows-build-floor-parity: ${message}`);
  process.exit(1);
}

// --- extract install.ps1's hand-maintained floor -----------------------------------------------------
const installPs1Path = path.join(__dirname, "..", "..", "..", "install.ps1");
let installPs1Source;
try {
  installPs1Source = fs.readFileSync(installPs1Path, "utf8");
} catch (err) {
  fail(`could not read install.ps1 at ${installPs1Path}: ${err.message}`);
}

const INSTALL_FLOOR_RE = /\$WindowsBuildFloor\s*=\s*(\d+)/g;
const installMatches = [...installPs1Source.matchAll(INSTALL_FLOOR_RE)];
if (installMatches.length === 0) {
  fail(
    `found ZERO "$WindowsBuildFloor = <N>" assignments in ${installPs1Path} — either the variable was ` +
    "renamed/restructured, or this pattern has drifted from the real source. A zero-match extraction " +
    "must FAIL, not silently pass as if the two floors still agreed.",
  );
}
if (installMatches.length > 1) {
  fail(
    `found ${installMatches.length} "$WindowsBuildFloor = <N>" assignments in ${installPs1Path} (expected ` +
    `exactly 1) — ambiguous which one is authoritative: ${installMatches.map((m) => m[1]).join(", ")}`,
  );
}
const installFloor = Number(installMatches[0][1]);

// --- extract node-pty's REAL ConPTY threshold, as TEXT (never executed — see PORTABILITY above) -------
let windowsPtyAgentPath;
try {
  windowsPtyAgentPath = require.resolve("node-pty/lib/windowsPtyAgent.js");
} catch (err) {
  fail(`could not resolve node-pty/lib/windowsPtyAgent.js: ${err.message}`);
}
const windowsPtyAgentSource = fs.readFileSync(windowsPtyAgentPath, "utf8");
const nodePtyVersion = require("node-pty/package.json").version;

const NODE_PTY_THRESHOLD_RE = /_getWindowsBuildNumber\(\)\s*>=\s*(\d+)/g;
const nodePtyMatches = [...windowsPtyAgentSource.matchAll(NODE_PTY_THRESHOLD_RE)];
if (nodePtyMatches.length === 0) {
  fail(
    `found ZERO "_getWindowsBuildNumber() >= <N>" comparisons in ${windowsPtyAgentPath} (node-pty@` +
    `${nodePtyVersion}) — the vendored expression has drifted from the shape this test expects (a ` +
    "renamed helper, a different comparison, a named constant). A zero-match extraction must FAIL, not " +
    "silently pass as if the two floors still agreed.",
  );
}
if (nodePtyMatches.length > 1) {
  fail(
    `found ${nodePtyMatches.length} "_getWindowsBuildNumber() >= <N>" comparisons in ` +
    `${windowsPtyAgentPath} (node-pty@${nodePtyVersion}) (expected exactly 1) — ambiguous which one is ` +
    `the real ConPTY gate: ${nodePtyMatches.map((m) => m[1]).join(", ")}`,
  );
}
const nodePtyThreshold = Number(nodePtyMatches[0][1]);

console.log(
  `[windows-build-floor-parity] install.ps1 $WindowsBuildFloor=${installFloor} vs node-pty@` +
  `${nodePtyVersion} ConPTY threshold=${nodePtyThreshold}`,
);

// --- DoD 3: positive-control the comparator BEFORE trusting any of its verdicts on the real values.
// An always-equal (or always-unequal) comparator would pass or fail every case silently — prove plain
// numeric `===` can report BOTH a genuine mismatch and a genuine match on known synthetic inputs first.
check("comparator positive control: DETECTS a real mismatch between two different numbers", (18309 === 18310) === false);
check("comparator positive control: reports a match for identical numbers (sanity)", (18309 === 18309) === true);

// --- the real check ------------------------------------------------------------------------------------
check(
  `install.ps1's $WindowsBuildFloor (${installFloor}) matches node-pty@${nodePtyVersion}'s real ConPTY ` +
  `threshold (${nodePtyThreshold})`,
  installFloor === nodePtyThreshold,
);

console.log(failures === 0
  ? `\n✅ ALL PASS — install.ps1's hand-maintained Windows build floor still agrees with the REAL ` +
    `node-pty@${nodePtyVersion} ConPTY threshold.`
  : `\n❌ ${failures} FAILURE(S) — install.ps1's $WindowsBuildFloor has DRIFTED from node-pty@` +
    `${nodePtyVersion}'s real ConPTY threshold. See card bcaba183: update install.ps1's ` +
    "$WindowsBuildFloor (and its accompanying doc comments/guide text) to match the new value, or this " +
    "installer will silently block or admit the wrong set of Windows builds.");
process.exit(failures === 0 ? 0 : 1);
