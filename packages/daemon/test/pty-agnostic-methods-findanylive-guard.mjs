import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// STANDING GUARD (multi-harness epic df1f94b0 Phase 1, card 353f6dc4, lead ruling #5) — the STRUCTURAL
// backstop ruling #5 required for the codex-registry split: `PtyHost` now keeps codex sessions in a
// SEPARATE private map (`liveCodex`) from claude's own (`live`), so any method classified AGNOSTIC in
// `docs/design/multi-harness-parity-matrix.md`'s PtyHost inventory — one that's supposed to work for
// EITHER harness — must route its session-id lookup through `this.findAnyLive(id)`, the ONE resolver
// that checks both maps. A method that instead reads `this.live.get(id)` directly SILENTLY IGNORES a
// codex session (findAnyLive checks liveCodex too; a bare `this.live.get` never does) — the exact
// "two registries drift" hazard the ruling named as this design's one real risk, reproduced in a NEW
// place if this guard doesn't exist.
//
// SCOPE: a fixed, hand-maintained list of method names (AGNOSTIC_METHODS below) — the ones THIS card
// verified BY READING their body (not merely trusted from the parity matrix's own [grep]-confidence
// rows — one of which, `writeStdin`, turned out to be misclassified and is deliberately EXCLUDED here;
// see the parity matrix's own correction). For each, this guard locates its real method body in
// `pty/host.ts` via a BALANCED-BRACE scan from the signature line (not a fixed line-window, and not
// "until the next method" — either would risk under- or over-capturing) and asserts the body contains
// `this.findAnyLive(` and does NOT ALSO contain a same-purpose `this.live.get(` call.
//
// ⚠️ MAINTENANCE: adding a NEW harness-agnostic method to `PtyHost` does not automatically appear here —
// add its name to AGNOSTIC_METHODS (and to the parity matrix's own inventory table) in the SAME change
// that adds the method, mirroring the discipline `harness-adapter-claude-literal-guard.mjs`'s ALLOWLIST
// already asks for. This guard cannot discover a method's own INTENDED classification from source alone
// (the classification is a judgment call, not derivable) — it only proves that whatever's on the pinned
// list actually uses the shared resolver, and that the list isn't vacuously empty or silently
// mismatched (see the "found a definition" check below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_FILE = path.resolve(__dirname, "..", "src", "pty", "host.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/**
 * The pinned set of AGNOSTIC-classified `PtyHost` methods this card migrated to `findAnyLive`. Kept as a
 * flat array (not re-derived from the parity matrix doc — a prose table is not a machine-checkable
 * source of truth, and re-deriving from it would just move the "trust this label" problem, not remove
 * it) — see this file's own header for the maintenance discipline.
 */
const AGNOSTIC_METHODS = [
  "markMcpSeen", "waitForMcpSeen",
  "getPending", "getActiveTurnOrigin", "getActiveTurnIsProactive", "getActiveTurnOwnerText",
  "getRecentOwnerTurns", "getActiveTurnSenderId",
  "getPersistablePendingSnapshot", "getPendingEntries", "pendingAgentCount", "consumePending",
  "flushPending", "purgeQueuedByQuestionIds", "purgeQueuedByReportEventIds",
  "purgeQueuedWorkerReportNudgesForWorker", "purgeQueuedWorkerIdleNudges",
  "deleteQueued", "editQueued", "reorderQueued",
  "subscribe", "isAlive", "isBusy", "holdDrain", "releaseDrain", "liveStartedAt", "getPid",
  "getLastOutputAt",
];

/**
 * Locate `methodName`'s real body inside `src` (a `PtyHost` class-member method, 2-space indent) via a
 * BALANCED-BRACE scan starting at the signature line — the scan tracks `{`/`}` depth character-by-
 * character (comments/strings are NOT excluded from the character count; every method in
 * AGNOSTIC_METHODS is plain control-flow code with no `{`/`}` inside a string or comment, verified by
 * reading each one during this card's migration) and stops the instant depth returns to 0, so the
 * captured text is exactly that one method's body — never a truncated prefix (fixed line count) nor an
 * over-capture bleeding into the next method (a "scan until the next signature" heuristic would risk
 * both). Returns `null` if the signature itself isn't found at all (a rename/removal — a real problem
 * this guard must FLAG, not silently skip).
 */
function findMethodBody(src, methodName) {
  const sigRe = new RegExp(`^  (?:private |async |static )*${methodName}\\(`, "m");
  const sigMatch = sigRe.exec(src);
  if (!sigMatch) return null;
  const startIdx = sigMatch.index;
  // The signature can carry an INLINE OBJECT-TYPE return annotation on the same line (e.g.
  // `deleteQueued(...): { deleted: boolean; refused?: boolean } {`) — a naive `indexOf("{", startIdx)`
  // finds that type literal's OWN brace first, which is independently balanced and closes BEFORE the
  // real body ever opens, terminating the scan on the return-type shape instead of the body (a real bug
  // this guard's own development hit — every method in this file's style puts the body's opening brace
  // as the LAST character on the signature's first line, so the last `{` on that line is the real one).
  const firstNewlineIdx = src.indexOf("\n", startIdx);
  const sigLine = src.slice(startIdx, firstNewlineIdx === -1 ? undefined : firstNewlineIdx);
  const braceOffsetInSigLine = sigLine.lastIndexOf("{");
  if (braceOffsetInSigLine === -1) return null;
  const firstBraceIdx = startIdx + braceOffsetInSigLine;
  let depth = 0;
  let i = firstBraceIdx;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(startIdx, i);
}

/** The actual classifier: does `body` route its session lookup through `findAnyLive`, with no
 *  `this.live.get(` fallback also present? Exported as a function (not inlined into the loop below) so
 *  the sanity/positive-control checks can exercise it directly against synthetic bodies. */
function usesFindAnyLive(body) {
  return body.includes("this.findAnyLive(") && !body.includes("this.live.get(");
}

// --- Sanity / positive+negative controls on the CLASSIFIER ITSELF, before trusting it against the real file ---

check(
  "sanity: a synthetic method body using this.findAnyLive( ONLY is classified as using the resolver (positive control)",
  usesFindAnyLive("methodName(sessionId) {\n    const live = this.findAnyLive(sessionId);\n    return live?.busy ?? false;\n  }"),
);
check(
  "sanity: a synthetic method body using this.live.get( directly (no findAnyLive at all) is classified as NOT using the resolver — the real regression shape (negative control)",
  !usesFindAnyLive("methodName(sessionId) {\n    const live = this.live.get(sessionId);\n    return live?.busy ?? false;\n  }"),
);
check(
  "sanity: a synthetic body using BOTH this.findAnyLive( and a leftover this.live.get( is classified as NOT clean — a half-migrated method must still fail",
  !usesFindAnyLive("methodName(sessionId) {\n    const a = this.findAnyLive(sessionId);\n    const b = this.live.get(sessionId);\n    return a ?? b;\n  }"),
);

// --- findMethodBody itself: proven against REAL, known-shape source, not just trusted by inspection ---

const hostSrc = fs.readFileSync(HOST_FILE, "utf8");
{
  const isAliveBody = findMethodBody(hostSrc, "isAlive");
  check("sanity: findMethodBody finds a REAL method (isAlive) in the real file (found a non-null body)", isAliveBody !== null);
  check(
    "sanity: findMethodBody's captured isAlive body is BALANCED (equal { and } counts) — proves the brace scan didn't over/under-capture",
    isAliveBody !== null && (isAliveBody.match(/\{/g) ?? []).length === (isAliveBody.match(/\}/g) ?? []).length,
  );
  check(
    "sanity: findMethodBody's captured isAlive body does NOT bleed into the next method's signature (a real over-capture symptom)",
    isAliveBody !== null && !isAliveBody.includes("isBusy(sessionId"),
  );
}
check(
  "sanity: findMethodBody returns null for a method name that does not exist (negative control — proves this doesn't silently match something else)",
  findMethodBody(hostSrc, "thisMethodDoesNotExistAnywhereInHostTs12345") === null,
);
{
  // RED PROOF (real bug hit during this guard's own development): deleteQueued's signature carries an
  // INLINE OBJECT-TYPE return annotation on the same line (`): { deleted: boolean; refused?: boolean } {`)
  // — a naive "first { after the signature" scan finds that type literal's own (independently balanced)
  // braces and stops there, never reaching the real body at all, which would make this guard vacuously
  // pass every method with this exact shape (deleteQueued/editQueued/reorderQueued/
  // getPersistablePendingSnapshot all have it) by finding a body that trivially satisfies neither
  // pattern's presence. Asserted here against the REAL file so a future regression to that naive scan is
  // caught immediately rather than by all four call sites silently returning short/wrong captures.
  const deleteQueuedBody = findMethodBody(hostSrc, "deleteQueued");
  check(
    "RED PROOF (real bug): findMethodBody on deleteQueued (inline object-type return annotation) captures the REAL body, not just the return-type literal",
    deleteQueuedBody !== null && deleteQueuedBody.includes("this.findAnyLive("),
  );
  check(
    "findMethodBody on deleteQueued's captured body is BALANCED",
    deleteQueuedBody !== null && (deleteQueuedBody.match(/\{/g) ?? []).length === (deleteQueuedBody.match(/\}/g) ?? []).length,
  );
}

// --- Population sanity: the pinned list itself must be non-trivial ---

check(`sanity: AGNOSTIC_METHODS is non-empty (found ${AGNOSTIC_METHODS.length})`, AGNOSTIC_METHODS.length > 0);

// --- The real assertion, over the real corpus ---

const notFound = [];
const violations = [];
for (const name of AGNOSTIC_METHODS) {
  const body = findMethodBody(hostSrc, name);
  if (body === null) { notFound.push(name); continue; }
  if (!usesFindAnyLive(body)) violations.push(name);
}
check(
  `every AGNOSTIC_METHODS entry has a REAL definition in pty/host.ts (found ${notFound.length} not-found: ${JSON.stringify(notFound)})`,
  notFound.length === 0,
);
check(
  `every AGNOSTIC_METHODS entry routes its session lookup through this.findAnyLive( with no leftover this.live.get( (found ${violations.length} violation(s): ${JSON.stringify(violations)})`,
  violations.length === 0,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the balanced-brace method-body scan is proven against real source (isAlive), the this.findAnyLive-vs-this.live.get classifier is proven both ways (findAnyLive-only passes, live.get-only and half-migrated bodies fail) including on synthetic fixtures, and every pinned AGNOSTIC method in pty/host.ts currently routes through the shared findAnyLive resolver — the structural backstop lead ruling #5 required against the two-registry (claude `live` / codex `liveCodex`) drift hazard."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
