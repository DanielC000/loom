// Card fc53ea74 — regression coverage for scripts/test-daemon.mjs's lane-port allocator. Imports the
// REAL `reserveLanePort` export directly (never a duplicated copy — the same discipline
// test-daemon-discovery.mjs already established for `discoverHermeticTests`), and exercises it the way
// `runOne` actually uses it: one call per test-file run, with no awareness of any OTHER process doing the
// same thing concurrently.
//
// WHY THIS MATTERS: the OLD scheme (`4400 + lane`, card fa52f555) was safe only WITHIN one
// `test-daemon.mjs` invocation's own fixed pool of lanes — two CONCURRENT invocations (two gates admitted
// at once under `maxConcurrentGates` >= 2, or two workers' own `run_gate` on the same repo, which
// `gate-semaphore.ts`'s `mergeRepoFree` deliberately leaves unguarded for worker-vs-worker) would each
// independently compute the IDENTICAL port for the same lane index. `reserveLanePort` fixes this by
// asking the OS for a genuinely free ephemeral port at the instant of reservation, which is unique across
// every process on the host, not just within one. Code Review of the first landing also established this
// isn't merely theoretical: `mgmt-surface.mjs`/`platform-scope.mjs`/`profiles-rest.mjs`/`scheduler.mjs`
// each spawn a REAL daemon that `.listen()`s on the `LOOM_PORT` this allocator provides.
//
// Fully hermetic — no daemon, no claude; a handful of real TCP port reservations + a source-text check.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { finishAndExit } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { reserveLanePort } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

/** The SAME uniqueness check the real assertions below run — applied to any allocator shaped like
 *  `reserveLanePort` (a zero-arg function returning a port, sync or async), so the known-bad baseline and
 *  the real check below are PROVABLY the same test, not two differently-worded ones that could drift. */
async function checkConcurrentUniqueness(allocator, concurrentCount) {
  const ports = await Promise.all(Array.from({ length: concurrentCount }, () => allocator()));
  return { ports, allUnique: new Set(ports).size === ports.length };
}

// --- [known-bad baseline] RED PROOF: the SAME uniqueness check, run against the OLD 4400+lane scheme
// applied the way two CONCURRENT invocations would each independently apply it for the SAME lane index —
// MUST find a real collision (not a vacuous `x === x` — this actually calls checkConcurrentUniqueness and
// inspects its verdict, the identical function the real assertions below trust). If this ever stops
// finding a collision, the real assertions below would be proving nothing, since a vacuous "always
// unique" checker would pass both. --------------------------------------------------------------------
{
  const legacyLane0Allocator = () => 4400 + 0; // every concurrent invocation's own "lane 0" under the OLD scheme
  const { ports, allUnique } = await checkConcurrentUniqueness(legacyLane0Allocator, 6);
  check(
    `[known-bad baseline] checkConcurrentUniqueness ACTUALLY DETECTS the OLD 4400+lane scheme's collision across 6 concurrent "invocations" of lane 0 (ports: ${JSON.stringify(ports)})`,
    allUnique === false,
  );
}

// --- The REAL allocator: simulate several CONCURRENT invocations each calling reserveLanePort() for
// their own lane 0 (the exact call shape runOne uses), with no coordination between them — must NEVER
// collide, unlike the baseline above, via the SAME checkConcurrentUniqueness verdict. -------------------
{
  const CONCURRENT_INVOCATIONS = 6; // comfortably more than POOL_SIZE's own default (3), so this also
  // covers the cross-process case, not just two lanes within one pool
  const { ports, allUnique } = await checkConcurrentUniqueness(reserveLanePort, CONCURRENT_INVOCATIONS);
  check(
    `reserveLanePort() returns ${CONCURRENT_INVOCATIONS} genuinely DISTINCT ports across ${CONCURRENT_INVOCATIONS} concurrent "invocations" of lane 0`,
    allUnique,
  );
  check(
    "every reserved port is a real, well-formed TCP port number",
    ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536),
  );
}

// --- Repeat the real-allocator check sequentially a few times too — reserveLanePort releases its probe
// socket immediately after reserving (see _hermetic-port.mjs's own TOCTOU-residual doc), so back-to-back
// SEQUENTIAL calls from what could be the SAME lane across different test files must also stay distinct,
// not just concurrent ones. --------------------------------------------------------------------------
{
  const sequential = [];
  for (let i = 0; i < 4; i++) sequential.push(await reserveLanePort());
  check(
    "sequential reserveLanePort() calls (one lane running several test files in a row) also never repeat a port",
    new Set(sequential).size === sequential.length,
  );
}

// --- SOURCE/SEAM ASSERTION (Code Review follow-up): prove runOne itself actually CALLS reserveLanePort()
// for its own port — not just that the exported helper is independently correct. Reverting runOne's own
// call site back to the literal `4400 + lane` while leaving the exported `reserveLanePort` function alone
// would keep every assertion above green (they only ever call the export directly), so this closes that
// gap by reading the REAL scripts/test-daemon.mjs source text. --------------------------------------
{
  const sourceText = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs"), "utf8");
  const stripped = stripComments(sourceText);
  // Matches either `const port = await reserveLanePort()` or the try/catch-wrapped `port =
  // await reserveLanePort()` (no `const` — `port` is declared `let` one line earlier so the catch
  // block below can also assign it) — both are "runOne gets its port from calling reserveLanePort()".
  const REAL_WIRING_RE = /\bport\s*=\s*await\s+reserveLanePort\(\)/;
  // [sanity] the extractor's own positive/negative controls, before trusting it against real content.
  check(
    "sanity: the real wiring pattern IS detected against a synthetic positive control",
    REAL_WIRING_RE.test(stripComments("  const port = await reserveLanePort();\n")) && REAL_WIRING_RE.test(stripComments("  port = await reserveLanePort();\n")),
  );
  check(
    "sanity: the OLD literal pattern IS detected against a synthetic positive control (so its ABSENCE below is meaningful)",
    /\bport\s*=\s*4400\s*\+\s*lane\b/.test(stripComments("  const port = 4400 + lane;\n")),
  );
  check(
    "sanity: a COMMENT merely mentioning the old literal is NOT detected (negative control — stripComments actually strips it)",
    !/\bport\s*=\s*4400\s*\+\s*lane\b/.test(stripComments("  // the old port = 4400 + lane scheme\n")),
  );
  check(
    "runOne's real source assigns its port via `port = await reserveLanePort()`",
    REAL_WIRING_RE.test(stripped),
  );
  check(
    "runOne's real source NEVER assigns a port via the OLD literal `4400 + lane` formula",
    !/\bport\s*=\s*4400\s*\+\s*lane\b/.test(stripped),
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-port-allocation: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
