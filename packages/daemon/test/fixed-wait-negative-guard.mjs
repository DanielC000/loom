import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING GUARD (card 1addef27) — catches NEW or REGRESSED instances of the "fixed wait guarding a
// NEGATIVE assertion" defect class BY DEFAULT (no opt-in — a guard you must opt into reproduces `eb29e410`
// exactly), without re-auditing the whole suite first. The defect: a fixed-duration sleep asserting "X did
// NOT happen" passes silently if X arrives after the window — see memory
// `fixed-wait-polarity-negative-assertions-fail-silently` and the population screen at 975956b2.
//
// WHAT THIS IS: a static TEXT scan over packages/daemon/test/*.mjs (source, not dist — no build needed) —
// same shape as codescape-privacy-guard.mjs (walk + regex + a baseline), NOT a control-flow analyzer, and
// NOT the runtime-unit-test-of-a-lint-function shape of agent-prompt-lint.mjs (the card's own citation for
// this precedent was loose — codescape-privacy-guard.mjs is the one that actually applies here).
//
// WHAT IT CATCHES: a fixed-duration wait — `sleep(<expr>)` or `new Promise((r) => setTimeout(r, <expr>))`
// — idiom SHAPE only, regardless of whether the duration is an integer literal or a derived/named-constant
// expression (so adopting THIS CARD'S OWN "derive the window from a measured quantity" advice does not
// make a site invisible to this guard — measured empirically: broadening from literal-only to idiom-shape
// only grew the flagged set from 115 to 131 sites out of 645 total wait sites, not an explosion) —
// immediately followed (within 5 lines) by a check()/assert() whose label reads as a NEGATIVE-polarity
// claim (never/not/no/zero/unchanged/frozen/refuse/omit/etc.).
//
// ALSO CATCHES (card 0f744aa4): a `windowMs` sampling config — `observeOnce`/`assertNeverWithControl`'s
// (`_timing-guard.mjs`) fixed-duration sampling fallback — is a fixed wait too, even though it never spells
// `sleep(`/`setTimeout(` at the call site; a shipped file carried two uncontrolled negatives this way, one
// of them outright vacuous, and this guard ran green over it. Card 5e51e778 closed the SAME gap first, for
// the sibling DIFF-SCOPED guard (fixed-wait-witness-guard.mjs) — this is the matching fix for THIS
// (corpus-wide, negative-polarity-classifying) guard, deliberately using the SAME clearing rule that
// proved out there rather than a fresh, unproven one: a `windowMs`-idiom candidate is cleared the instant
// a `positiveControl` token (object key or call) appears ANYWHERE in its CONTIGUOUS blank-line-delimited
// BLOCK (see `blockBounds` below) — never a fixed line count. A fixed line count was measured, empirically,
// against THIS corpus while building this change, to be the wrong instrument here: a real, already-
// sanctioned site (ws-fleet-session-feed.mjs's own `positiveControl`-wrapped `observeOnce` call) has its
// consuming `check()` land INSIDE a naive 5-line window from the wait line, which would have produced a
// live false positive on real, already-correct production code the very first time this idiom was added —
// exactly the kind of repo-wide false positive CLAUDE.md warns this guard's blast radius makes unaffordable.
// `assertNeverWithControl` REFUSES to run without a `positiveControl` that itself proves, at runtime, that
// the check it guards CAN go true (card 1addef27) — so a `windowMs` site inside that structure is already
// runtime-proven, and clearing it here is not a bet, it's recognizing proof that already exists elsewhere.
//
// WHAT IT CANNOT SEE (stated plainly — a guard silently blind to an idiom is the same failure one level
// up, DoD-6): a locally-reimplemented waitUntil/poll-loop misused with a bad predicate (975956b2 found
// these are USUALLY safe — this guard does not verify that; it simply never flags the shape at all); a
// differently-named delay()/wait() helper; a raw non-awaited `setTimeout(fn, N)` (fire-and-forget, never
// `await`ed); or a check()/assert() whose label doesn't textually read as negative even though its polarity
// is (a mislabeled assertion escapes both a human reviewer and this heuristic alike). AND, new to the
// `windowMs` idiom specifically: a `positiveControl` supplied BY REFERENCE — a named function assigned to
// the `positiveControl` key from somewhere else in the file (worker-composer-dirty-signal.mjs's
// `proveClearMechanismWorks` is the real specimen) rather than an inline closure — is invisible to this
// block-scoped clearing rule, because the block containing the `windowMs` call never textually contains
// the word `positiveControl` at all. This residue is judged ACCEPTABLE, not closed: every current by-
// reference specimen in this corpus also has ZERO check()/assert() calls anywhere in its own block (it's a
// helper that RETURNS a verdict for something else to assert on), which already exempts it via the "no
// assertion nearby" rule below — so the by-reference gap is real in principle but, as of this card,
// unrealized in practice. A future by-reference site that DOES carry its own local check()/assert() call
// would need an explicit TIMING-GUARD-SAFE marker (same as any other reviewed exception) to clear — it will
// NOT be silently accepted.
//
// EXEMPTIONS: a flagged site clears ONLY by (a) a `// TIMING-GUARD-SAFE: <reason>` comment anywhere in the
// contiguous `//`-comment block immediately above the wait line (or on the wait line itself), where
// <reason> is one of the FOUR sanctioned clearing patterns below — the enum is CLOSED on purpose, because
// an exemption comment is itself a claim, and an open enum would let that claim mean anything — (b) being
// listed in KNOWN_UNAUDITED_WAITS, or (c) a `// TIMING-GUARD-FALSE-MATCH: <reason>` comment in the same
// position (card 1c5dda5d). (a)/(b) are both claims about THE WAIT — "this fixed duration is safe despite
// guarding a genuinely negative assertion." (c) is a DIFFERENT claim, about THE CLASSIFIER — "this
// assertion was never negative-polarity to begin with; NEG_KEYWORDS matched incidentally." Folding (c) into
// the same enum as (a) would erase that distinction and let a genuinely negative-polarity site borrow a
// classifier excuse it hasn't earned. (c) sites are NOT silently cleared the way (a)/(b) are — they're
// counted and printed as their OWN population (see FALSE_MATCH_REASONS / falseMatches below), so a rising
// false-match count stays visible as a signal that NEG_KEYWORDS itself needs work, instead of disappearing
// into the same bucket as genuinely-audited waits.
//
// ⭐ BASELINE KEY = (file, assertion label text) — NOT (file, line number). A worker was mid-flight
// migrating 49 test files onto a shared fixture (~10-line class body → 1-2 line import) the SAME day this
// guard shipped; 17 of those files overlapped this baseline, covering ~35 entries. A line-numbered key
// turns every one of those into a spurious NEW violation the instant lines shift — and "just regenerate
// the baseline" is the dangerous fix, because a blind regen silently absorbs any GENUINE new violation
// introduced by the same edit. The label text is what actually identifies the site semantically (it's
// already extracted below as `checkMatch[2]`) and survives any edit that doesn't touch the assertion's own
// wording — including line-shifting refactors, reordering, or a preceding wait construct being swapped for
// another. WHAT STILL INVALIDATES A BASELINE ENTRY: editing that check()'s own label text — which is
// exactly the moment a human is already looking at the assertion and should re-audit it anyway, so
// invalidation and the correct re-audit trigger coincide by construction.
//
// ⚠ COLLISION NOTE: at original baseline generation, 7 (file, label) pairs collapsed from 2 raw hits to 1
// — NOT a bug, but this note used to claim, unqualified, that all 7 were "manually verified" as ONE check()
// fed by TWO nearby wait constructs. Card f88c46df (2026-08-28) re-checked all 7 individually against the
// current corpus and that blanket claim did NOT hold for one of them — "manually verified" is dropped as a
// description of the set; each pair's real, individually-checked verdict is recorded below instead:
//   • codescape-health-probe.mjs (6) `build` ABSENT…never triggers a restart — GENUINE: a bounded
//     `for(...) await sleep(50)` poll loop immediately followed by a longer `sleep(500)` settle wait, both
//     real code, both within 5 lines of the one check().
//   • codescape-health-probe.mjs (7) `build: null` never triggers a restart — GENUINE, same shape as (6).
//   • codescape-supervisor.mjs (c) no further serve call is recorded after stop() — GENUINE: two sequential
//     real `await sleep(...)` waits (600ms then 300ms), both feeding the one check().
//   • gate-cancel.mjs (guard) cap 2 but SAME worktree — GENUINE: two sequential real `await sleep(10)`
//     waits, both feeding the one check().
//   • codescape-health-probe.mjs (8c)/(9) (installed build:null / build-matching drift) — NO LONGER
//     COLLIDE: both were genuine at note-writing time, but card 1aabf969 later replaced the settle-adjacent
//     fixed `sleep(500)` with a `waitForCompletedCondition(...)` poll-until-condition call and inserted an
//     explanatory comment block, pushing the still-present earlier `for(...) await sleep(50)` poll loop's
//     5-line window past the check(). Only the one remaining settle sleep is in range now — a distance
//     change, not a phantom.
//   • pending-ops-registry.mjs (clobber guard) run_C's entry SURVIVES…NOT clobbered — FALSIFIED: this is
//     the pair that broke the blanket claim. One of its two feeding "hits" was a `//`-comment (line 269)
//     quoting the wait idiom in prose ("…the way run_C's old internal sleep(30) was"), not a second real
//     wait — never manually verified as genuine, or the comment-vs-code distinction would have caught it.
//     Card 743be0c9 (merged c51cac2b) stopped scanning comment text for the idiom, so this pair also no
//     longer collides post-fix; see the DoD-2 REAL CORPUS checks below for the live specimen.
// ⇒ Net: 4 of the 7 confirmed genuine double-wait sites, 3 no longer collide at all in the current corpus
// (2 via the unrelated 1aabf969 refactor, 1 via the 743be0c9/c51cac2b comment-scan fix). Whichever the
// cause, ONE baseline entry still correctly covers each (file, label) pair's real wait line(s) — no
// baseline edit follows from this re-check. This is also why the entry count below (113, +2 hand-added —
// see next paragraph) is LOWER than the original line-keyed count (122): re-verify any such delta before
// trusting a future regeneration — a genuine (not artifact) merge or split is the one case DoD-5's
// "investigate before accepting" rule is for.
//
// KNOWN_UNAUDITED_WAITS is a PERMANENT BASELINE, not a countdown to zero — same posture as
// codescape-privacy-guard.mjs's KNOWN_LEAKING_FILES. Card 4479e6f0: this comment used to restate the entry
// count in prose ("115 entries") — it drifted to stale (real count 116) without anyone editing this
// comment, because nothing here re-derives it. A count stored beside the data it counts is a cache with no
// invalidation; the fix is to stop storing it here at all. The real count is DERIVED and PRINTED AT
// RUNTIME instead — see KNOWN_UNAUDITED_WAITS_TOTAL below and the final PASS/FAIL summary line, never
// restated as a literal in this comment again. Every entry in it (hand-added ones carry their own inline
// comment explaining why, e.g. companion-voice-tts-provision.mjs's) is UNEXAMINED under
// this card — 975956b2's own language — NOT cleared. Do not read this baseline as a completed census
// (DoD-7), and do not remove an entry to "clean up" without actually auditing that site's polarity/timing
// risk first. The property that matters: a NEW (file, label) pair — or one of the four retrofitted files
// regressing back to a raw fixed-wait-then-negative-check shape — fails the gate by default, so the
// footprint cannot grow silently even though this card does not close it.
//
// Run: node packages/daemon/test/fixed-wait-negative-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// CLOSED enum — see the EXEMPTIONS note above. The first three correspond to the clearing patterns
// source-verified on card 1addef27 (§ CLEARING in the memory note, and companion-voice-*.mjs's own
// annotations below).
//
// "poll-observes-prior-step": added card c976f009 (the same audit-tail card as `poll-replaces-blind-
// wait`-shaped fixes elsewhere in this corpus). Distinct from all three above: those are about the WAIT's
// OWN precondition/completion; this one is about a NEGATIVE-polarity check the window scan pulled in
// INCIDENTALLY — a genuinely different check(), 2-4 lines later, that this file's own author intends the
// wait to protect only indirectly. Source-verified per site, not a blanket excuse:
//   • wake.mjs ("it was consumed (no lingering row)"): the poll waits for `e.enqueued.length` to reflect
//     a fired wake. orchestration/wake.ts's `tick()` calls `this.deps.db.deleteWake(w.id)` (the row-removal
//     this check asserts) as the FIRST action per due wake, strictly BEFORE the dispatch/enqueue logic that
//     the poll actually observes (wake.ts ~line 200, "claim the slot first") — so by the time the poll's
//     condition is true, the delete has already happened even earlier in the same synchronous iteration.
//   • worker-stop-reap.mjs ("(B) killAllWorkers reports the correct live-worker count (2, not the live
//     manager too)"): reads `n`, captured SYNCHRONOUSLY before the poll ever starts
//     (`const n = sessions.killAllWorkers();` runs to completion, including its own return value, before
//     the poll's first check) — the poll doesn't race it at all, whatever it's waiting for.
//   • worker-stop-reap.mjs ("(B) exactly two reap calls were made (the live manager was never swept)"):
//     killAllWorkers only ever iterates the two seeded live workers (W1/W2) — there is no third live
//     worker in this fixture for a stray reap call to come from, so `reapCalls.includes(W1.worktreePath)
//     && reapCalls.includes(W2.worktreePath)` (the poll's own condition) and `reapCalls.length === 2` are
//     the SAME fact once both are observed present.
const SANCTIONED_REASONS = new Set(["sync-early-return", "sync-probe-no-macrotask", "fully-awaited-completion", "poll-observes-prior-step"]);

// CLOSED enum for TIMING-GUARD-FALSE-MATCH — see the EXEMPTIONS note above. Unlike SANCTIONED_REASONS
// (each a claim about why THE WAIT is safe), each entry here is a claim about why NEG_KEYWORDS fired on a
// label that is NOT actually negative-polarity — a classifier miss, not a timing argument. Card 1c5dda5d's
// specimen (worker-unconfirmed-delivery-signal.mjs, "getPendingConfirmMs is monotonically increasing…") is
// the first source-verified instance of this reason: NEG_KEYWORDS' bare "not" matched inside a methodology
// parenthetical explaining HOW the claim is proven ("…proves it's elapsed time, not a static marker"), not
// the claim's own polarity — the label's actual assertion ("is monotonically increasing") is
// POSITIVE-polarity and fails loudly on a static/wrong-typed value. `a14717af`'s `:234` specimen ("…not a
// hand-fed generation number") is the same shape, one card earlier. Extend this enum only with a NEW
// reason that is itself source-verified against a real site, same discipline as SANCTIONED_REASONS.
const FALSE_MATCH_REASONS = new Set(["keyword-in-methodology-aside"]);

const IDIOM_A = /\bsleep\(\s*[^)]+\)/;
const IDIOM_B = /new Promise\(\s*\(?\s*[a-zA-Z_$][\w$]*\s*\)?\s*=>\s*setTimeout\(\s*[a-zA-Z_$][\w$]*\s*,\s*[^)]+\)/;
// Card 0f744aa4 — see the header's "ALSO CATCHES" note. Deliberately the SAME regex as the sibling
// diff-scoped guard's own `IDIOM_WINDOWMS` (fixed-wait-witness-guard.mjs) — a proven idiom shape, not a
// fresh one. `\bwindowMs` alone (no trailing `:` in this comment, on purpose — this guard scans its own
// source, and the real token IS spelled with a colon in code).
const IDIOM_C = new RegExp("\\bwindowMs\\s*:");
const NEG_KEYWORDS = /\b(never|not\b|no\s|zero|absent|unaffected|unchanged|stops advancing|stayed|stays|frozen|didn.?t|doesn.?t|hasn.?t|won.?t|refuse|omit)/i;
// Card 0f744aa4: clears a `windowMs`-idiom candidate whose block already carries `assertNeverWithControl`'s
// mandatory, runtime-enforced positive control (card 1addef27) — same regex as the sibling diff-scoped
// guard's own `POSITIVE_CONTROL_RE`.
const POSITIVE_CONTROL_RE = /\bpositiveControl\s*[:(]/;
const EXEMPT_RE = /TIMING-GUARD-SAFE:\s*([a-z-]+)/;
const FALSE_MATCH_RE = /TIMING-GUARD-FALSE-MATCH:\s*([a-z-]+)/;
// Card a14717af: every check()/assert() call in a wait's window, not just the textually-first one — a
// non-global `.match()` silently drops every match after the first, which is how a genuinely-negative
// site sharing a window with an earlier positive-polarity check went unreported entirely (found 1 where
// two candidates existed). Matches check()/assert() in the order they appear in the window.
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;

// Card 743be0c9: IDIOM_A/IDIOM_B must NOT fire on the raw line text, because a `//`-comment can legitimately
// CONTAIN the literal idiom text — e.g. an explanatory TIMING-GUARD-* annotation quoting the call it's
// talking about ("...this is not competing against a moving deadline the way run_C's old internal sleep(30)
// was" — the real specimen that surfaced this, pending-ops-registry.mjs:269). Without stripping, that
// comment line is itself treated as a second wait site, producing a duplicate/phantom hit next to the real
// wait it's describing. Strip a TRAILING `//` comment before the idiom test only — this makes a
// WHOLE-LINE comment vanish entirely (nothing left for IDIOM_A/B to match) while leaving real code before
// the `//` on a mixed line (`await sleep(5); // ...`) intact. `(?<!:)` avoids truncating at a URL's `://`;
// same idiom as harness-adapter-claude-literal-guard.mjs's own `codeOnly` strip (that file's header has the
// CRLF gotcha this shares: no trailing `$` anchor, because this repo's source is CRLF and `.*$` would never
// reach a `\r`-terminated end-of-string — bare `.*` already consumes everything up to it). This is scoped
// STRICTLY to the idiom test below — markerReasonFor() (TIMING-GUARD-SAFE/-FALSE-MATCH lookback) still reads
// the ORIGINAL `lines` array unstripped, so a marker comment stays fully readable. Comments must become
// invisible for IDIOMS and stay readable for MARKERS — two opposite treatments of the same text, kept
// explicitly separate rather than collapsed into one pass.
const stripTrailingComment = (line) => line.replace(/(?<!:)\/\/.*/, "");

// file -> Set(assertion label text). EXCLUDING the 4 retrofitted files (no longer match the raw idiom at
// all — a regression there is a NEW flag, not a baseline hit) and the 2 files exempted via inline comment
// (companion-voice-enable-gate.mjs, companion-voice-tts-provision.mjs's line-37 site). Regenerate with the
// same walk+regex+NEG_KEYWORDS logic above if this ever needs re-deriving; do not hand-edit an entry
// without auditing the site (that's exactly the "read as a completed census" trap this guard exists to
// avoid reproducing) — and re-verify the total count per the COLLISION NOTE above before accepting it.
const KNOWN_UNAUDITED_WAITS = new Map([
  ["_probe-composer-dirty.mjs", [
    "2) the report text NEVER reached the TUI while the draft was open (no concatenation)",
  ]],
  ["_probe-resume-mode.mjs", [
    "BEFORE: a resume with no convergence lands at acceptEdits (one short of auto — the bug)",
    "AFTER: the fix drives the resumed session to AUTO with NO probe keystrokes (host feedback-cycled)",
  ]],
  ["_smoke-mode-fix-9c03f5a6.mjs", [
    "the [resume-mode] landed-mode log line appeared within 25s (no boot hang)",
    "a REAL turn completed (Stop hook fired) within 60s — no hang on any prompt/dialog",
  ]],
  ["agent-runs-primitive.mjs", [
    "6 BUG2: the completed run never flips to timed_out (timer was cleared, no late fire)",
  ]],
  ["agent-runs-rest.mjs", [
    "B2 a run with NO webhookUrl fires no webhook",
    "B3 a refused webhook does NOT throw into the teardown path",
  ]],
  ["claude-version-prewarm.mjs", [
    "a nonexistent LOOM_CLAUDE_BIN leaves the cache null (graceful degrade, not a hang/throw)",
  ]],
  ["codescape-health-probe.mjs", [
    // Card 4c7a337d, scenario (16): SAME shape and SAME structural reason as every other "stays terminal"
    // entry below in this file — once give-up sets `alive:false`, probeHealth()'s own early-return guard
    // (`if (this.stopped || !this.alive || this.probeInFlight) return;`) fires BEFORE the
    // `try{...}finally{this.completedProbeTicks++}` block, so the probe timer never completes another
    // tick post-give-up. There is no progress signal left to key a wait off — a genuinely fixed wall-clock
    // sleep is the only way to observe "stayed terminal", exactly like (2)/(10) just below.
    "(16) give-up STAYS terminal — no further restart / serve spawn, even with the health-probe timer still ticking",
    "(2) give-up STAYS terminal — no further restart / serve spawn, even with the health-probe timer still ticking",
    "(5) a persisting mismatch against the SAME installed build does NOT loop (still exactly 2 spawns on record)",
    "(6) `build` ABSENT from the health response never triggers a restart",
    "(7) `build: null` never triggers a restart",
    "(8) an unresolvable installed build (${installedFailureMode}) never triggers a restart",
    "(8c) an HONEST installed build:null never triggers a restart",
    "(9) `build` matching never restarts even when `version` differs — `version` is not the drift signal",
    "(10) give-up STAYS terminal under drift — no further restart / serve spawn, even with a fresh drift event and the health-probe timer still ticking",
    "(11) mid-burst: no restart has fired yet (each distinct build reset the still-open stability window)",
    "(11) after the single settled restart, no further restart follows (still exactly 2 spawns on record)",
    "(12) drift persisting after its one restart is spent logs the UNRESOLVED diagnostic exactly ONCE (not once per tick, and not silently forever)",
  ]],
  ["codescape-lifecycle-hooks.mjs", [
    "(1b) a taskless spawn never fires register-worktree (no stable worktreeId)",
    "(4) recycleWorker triggers no drop call (worktree not removed)",
    "(5) LOOM_DEV off: no supervisor call ever fired (spawn+merge+gc lifecycle)",
    "(6) project not enabled: no supervisor call ever fired (spawn+merge+gc lifecycle)",
  ]],
  ["codescape-supervisor.mjs", [
    "(dbPath) start(repoPaths, dbPath) with ONLY a dbPath (no env var) actually ingests+spawns serve",
    "(c) no further serve call is recorded after stop() (restart-on-death is disarmed)",
    "(bad-bin) after exhausting the bounded restart schedule, getPort() is null (gave up, NOT phantom-alive)",
    "(bad-bin) stays down (no stray restart revives it after giving up)",
  ]],
  ["companion-mirror.mjs", [
    "B: NOTHING mirrored — B has no telegram binding (no broadcast to A's telegram or anywhere else)",
    "failed-mirror: handleInAppInbound never throws even though the mirror send does",
  ]],
  // NOT part of the card's cleared citation (only companion-voice-tts-provision.mjs's line-37 site is) —
  // this section's __setTtsProvisionerForTest fake resolves fast today, but that's a test-scaffolding
  // timing argument this card never source-verified (the sanctioned "sync-probe-no-macrotask" reasoning is
  // specifically about venv.ts's REAL ensurePythonPackageAsync/probeOk path, not a fake). Genuinely
  // unaudited debt, not a manufactured clearance — hand-added since the whole file is excluded from the
  // auto-derivation above (it already carries one inline TIMING-GUARD-SAFE exemption).
  ["companion-voice-tts-provision.mjs", [
    "3: still not ready right after the failure (this call ALSO kicks a fresh attempt)",
    "3: a THIRD call is now ready — retried after a terminal failure, never a permanent dead-end",
  ]],
  ["end-me.mjs", [
    "(queued) the pty is NOT stopped — no Ctrl-C written",
    "(workers) the pty is NOT stopped — no Ctrl-C written",
  ]],
  ["gate-cancel.mjs", [
    "(guard) cap 2 but SAME worktree — B has not run yet while A holds it",
    "(auto-supersede) the self-check is QUEUED, not yet admitted (nothing spawned)",
    "(primitive gateType guard) the synthetic merge entry is queued, not yet admitted",
  ]],
  ["gate-idle-liveness.mjs", [
    "(1) THE RED-FIRST PROOF: onOutput advances lastOutputAt strictly forward — a static/broken wiring would leave this UNCHANGED",
  ]],
  ["gate-queue.mjs", [
    "(unit, handoff) after release, exactly 1 running (the FORMER queued entry) + 0 queued — never a moment with 2 running",
    "(unit) registry empty once both settle (no leaked entries)",
  ]],
  ["gate-semaphore-concurrency.mjs", [
    "(priority) an omitted-priority call defaults to high and jumps an already-queued low waiter",
  ]],
  ["gate-timeout-tree-kill.mjs", [
    "(no-fratricide) the WORKER-LOOKALIKE (excluded via pty.getPid) SURVIVES the exact same sweep — no fratricide",
  ]],
  ["graceful-stop.mjs", [
    "idle: still no hard kill after the escalation window",
    "busy-retry: hard-kill backstop stayed a no-op after a clean Stage-2 exit",
  ]],
  ["mcp-ready-gate.mjs", [
    "7: nudge NOT delivered/queued yet — MCP not seen",
    "9: a session that died before markMcpSeen never receives the deferred nudge",
    "no unhandled promise rejections were produced across all scenarios",
  ]],
  ["orch-abort-warn.mjs", [
    "(1) a NORMALLY completed request logs NO diagnostic warning",
    "(2) the client-aborted call never resolves normally on the client side",
  ]],
  ["pending-ops-registry.mjs", [
    "(nudge slow-ok) callback fired EXACTLY ONCE once the op actually terminates, with no re-poll",
    "(onSurfacedPending) the settled callback fires AFTER surfaced, never before — order holds even under the tightest possible race",
    "(clobber guard) run_C's entry SURVIVES run_A's late settle — NOT clobbered",
    "(onOpMinted retry) fires exactly once for the entry-creating call, never for a retry that attaches",
    "(onSettle clobber-guard) the ORPHAN's late settle never fires onSettle against the successor's key — still exactly 1 call",
  ]],
  ["pty-coalesce-drain.mjs", [
    "COALESCE: exactly ONE Enter (`\\\\r`) written for the whole drain (one turn, not three)",
  ]],
  ["pty-giveup-clear.mjs", [
    "(3) NO clear byte was ever written on a normally-confirmed turn (give-up path never triggers)",
    "(4) the redrain itself also gave up (harness never confirms) — busy fell back to false again",
  ]],
  ["pty-giveup-hold-until-confirmed.mjs", [
    "(3) THE BACKSTOP: the hold expired with no confirmation — busy re-armed (genuinely re-delivered)",
    "(3) sanity: still exactly 2 delivery attempts after another reconcile tick — no runaway loop",
  ]],
  ["pty-giveup-requeue.mjs", [
    "(1) sanity: still exactly 2 rounds' worth of attempts after another reconcile tick — no runaway loop",
    "(2) ORDERING: draining resubmits TEXT1 (not TEXT2) — its body appears a SECOND time",
    "(5) NO DUPLICATE, NO CLEAR: the message body was written exactly once, no backspace clear either",
  ]],
  ["pty-healifstuck-clear.mjs", [
    "(3) NO heal-time clear ever fired for a session that legitimately went on to submit",
  ]],
  ["pty-interrupt-redirect.mjs", [
    "after settle: busy was self-cleared (a busy=false edge appears, with no Stop hook)",
    "no double-submit: redirect still written exactly once",
    "stopping: still no crash, queue stays clear",
  ]],
  ["pty-log-stream-error.mjs", [
    "writeLog stays a no-op after logBroken (no new uncaughtException from further writes)",
  ]],
  ["pty-mode-convergence.mjs", [
    "1: NO auto-heal press fires when the session actually reached auto (not stuck in plan)",
    "2: the RAW cycler gave up WITHOUT a 3rd blind press (bounded, never infinite/overshooting)",
    "2: AUTO-HEAL fired a 3rd Shift+Tab — a worker is NEVER left stranded in plan",
    "2: the auto-heal fires AT MOST ONCE per session (modeLogged guard — no repeat correction)",
    "3: NO auto-heal press for a manager stranded in plan (role-gated — never fights a legitimate plan)",
    "4: heal converged the worker to auto (2 corrective presses) — never left stranded at acceptEdits",
    "5: the RAW cycler cleanly reached ITS OWN target `default` in exactly 3 presses (no give-up)",
    "5: NO further heal press — the heal's target IS `default` (this session's own config), ",
    "6: the raw main cycle issued ZERO presses (never had a definite footer to decide from)",
    "7: main convergence issued ZERO presses (resume already at its own configured target, acceptEdits)",
    "7: FIXED — no auto-heal press on resume for a startupModeCycles:0 config (stays at acceptEdits, ",
    "8: resume converged to auto via the heal (1 corrective press) — the common case is not regressed",
  ]],
  ["pty-mode-heal-retry.mjs", [
    "no further Shift+Tab after the heal converged (modeLogged guard — no repeat correction)",
  ]],
  ["pty-mode-race.mjs", [
    "still exactly 1 press — no concurrent press from the queued manual call",
    "still exactly 2 presses — the manual call has NOT started pressing during boot's cycle",
  ]],
  ["pty-owner-attestation.mjs", [
    "5: held while busy — no attestation yet (still the PRIMER turn)",
  ]],
  ["pty-proactive-turn.mjs", [
    "5: held while busy — no proactive attestation yet (still the PRIMER turn)",
  ]],
  ["pty-restart-nudge-atomicity.mjs", [
    "(A) mid-race: NOT yet a second bracketed paste (kickoff held, not racing the in-flight write)",
  ]],
  ["pty-resume-readiness.mjs", [
    "3: readiness fallback drained the nudge despite no SessionStart",
    "4: gate handled exactly once per session (no double-select)",
    "8: NO Enter was ever sent (would durably persist \\",
  ]],
  ["pty-submit-paste-end-retry.mjs", [
    "(a) no further re-assert/Enter writes after confirmation",
  ]],
  ["pty-submit-verify-retry.mjs", [
    "(4) no further Enter attempts after giving up (the retry loop actually stopped)",
    "(5) NO extra Enter from B's stale chain (only B's 1 + C's 1 attempt — no spurious 3rd write)",
    "(5) no further Enter writes after C ended (both chains are fully retired)",
  ]],
  ["pty-writechunked-done-on-death.mjs", [
    "sanity: the burst genuinely never completed (proves this exercised the not-alive bail, not a race that just finished naturally)",
  ]],
  ["run-gate-cancelled-retention.mjs", [
    "(D) THE FIX: the re-call after a cancel triggers a genuinely FRESH gate invocation (not a cache hit)",
  ]],
  ["scheduler-disabled.mjs", [
    "disabled: NO manager session booted in the agent",
  ]],
  ["scheduler.mjs", [
    "Transition-only: a second same-reason tick leaves lastDeferredAt UNCHANGED",
  ]],
  ["shutdown-endpoint.mjs", [
    "(b) requestShutdown NOT invoked by the rejected caller (still 1)",
  ]],
  ["update-endpoint.mjs", [
    "(b) beginSelfUpdate NOT invoked by the rejected caller (still 1)",
    "(c) beginSelfUpdate NOT invoked on a source daemon (still 1)",
  ]],
  ["worker-liveness-signal.mjs", [
    "(1) getLastOutputAt ADVANCES AGAIN on a second chunk — WITHIN the same turn (no Stop/hook in between)",
    "(3) with no further engine output, lastEngineOutputAt FREEZES (does not advance) — the wedge signal",
  ]],
  ["worker-run-gate.mjs", [
    "(G) a SUBSEQUENT gate run (past the retention window) still acquires the semaphore slot (no permanent leak)",
  ]],
  ["worker-session-reap.mjs", [
    "(C) the UNRELATED sibling worker's process is NEVER touched — the load-bearing scoping invariant",
  ]],
  ["worker-stop-reap.mjs", [
    "(B) killAllWorkers reports the correct live-worker count (2, not the live manager too)",
  ]],
  ["worktree-process-reap.mjs", [
    "(real) child B (a DIFFERENT worktree) is NEVER touched by a reap scoped to worktree A",
  ]],
  ["worktrees.mjs", [
    "(l2) all ${spawnedChildren.length} hanging children were ACTUALLY terminated (no orphans left running)",
  ]],
  ["ws-fleet.mjs", [
    "(4) an unknown message type is ignored (no throw, no resurrected subscription)",
    "(4b) a raw ${label} frame does not crash the handler (socket stays open, hub unchanged)",
    "(4c) sub:events with a non-string managerId or non-finite sinceSeq is ignored (hub subscription state unchanged)",
  ]],
  ["ws-json-hardening.mjs", [
    "(term) a raw ${label} frame does not crash the handler (socket stays open)",
    "(companion) a raw ${label} frame does not crash the handler (socket stays open)",
  ]],
]);

function baselineHas(file, label) {
  return KNOWN_UNAUDITED_WAITS.get(file)?.includes(label) ?? false;
}

// Card 4479e6f0: DERIVED, never hand-typed — see the header comment above for why a hand-typed count here
// went stale (115 written, 116 real) with no edit ever touching this line. Printed in the final PASS/FAIL
// summary below; nowhere in this file states the count as a literal.
const KNOWN_UNAUDITED_WAITS_TOTAL = [...KNOWN_UNAUDITED_WAITS.values()].reduce((n, arr) => n + arr.length, 0);

// Card a14717af: the pre-`ecf4e391` matcher scanned each wait's 5-line window with a non-global
// `.match()`, which silently returns only the FIRST check()/assert() found in that window — any further
// check()/assert() sharing the same window was never examined, regardless of its own polarity. Fixing
// that (via `matchAll`, see CHECK_OR_ASSERT_RE + scanFile below) surfaced 51 distinct (file, label) pairs
// that were STRUCTURALLY INVISIBLE to every prior run of this guard — not missed by an auditor, never
// even offered to one. THESE ARE UNAUDITED for actual timing-safety, exactly like KNOWN_UNAUDITED_WAITS
// above (same UNEXAMINED posture — see that constant's own header) — kept as a SEPARATE, explicitly-named
// list rather than folded into KNOWN_UNAUDITED_WAITS so the provenance ("never previously visible to this
// guard in any form, in ANY prior run") stays distinguishable from the older baseline's "already scanned
// by some earlier version of this matcher" posture. Folding them together would be indistinguishable from
// regenerating the baseline — the exact operation card a14717af's own header forbids, because it silently
// absorbs genuine new violations; keeping them apart is what makes this NOT that.
// Do NOT audit or fix a site from this list as part of maintaining this file — that work is tracked on
// separate follow-up cards card a14717af filed. This list exists ONLY to keep the guard green while these
// 51 sites stay visible, attributed, and gated (a NEW hit outside BOTH lists still fails the guard).
const NEWLY_VISIBLE_UNAUDITED_WAITS = new Map([
  ["agent-runs-rest.mjs", [
    "B3 the run still finalized terminally despite the refused webhook",
    "B3 the refused delivery WAS attempted (then swallowed)",
  ]],
  ["capability-registry.mjs", [
    "(venv) a LATER call resolves the now-warm binary (no re-provisioning)",
  ]],
  ["codescape-health-probe.mjs", [
    "(7) drift-check state also reads not-checked:running-absent for a running `build:null`",
    "(8c) an HONEST installed build:null is SILENT — it is a real answer, not a couldn't-read failure",
    "(12) the exhausted-restart guard itself is UNCHANGED — still no second restart while the SAME installed build persists",
    "(12) recovery did not trigger a restart (still exactly 2 spawns on record)",
  ]],
  ["codescape-lifecycle-hooks.mjs", [
    "(4) recycled worker's worktree still exists on disk (reused, not removed)",
  ]],
  ["codescape-mcp-spawn.mjs", [
    "(e2e) it registered under codescape's OWN manifest-resolved id (not Loom's project.id)",
  ]],
  ["codescape-supervisor.mjs", [
    "(dbPath) getPort() is live — the DB-path-only configuration reached spawnServe, not just the gate check",
    "(bad-bin) getPid() is null too (no live child left dangling)",
  ]],
  ["companion-mirror.mjs", [
    "A: the in-app adapter itself was never sent the mirror (only the OTHER bound channel)",
    "failed-mirror: the original turn was still submitted (mirror failure doesn't block the turn)",
    "failed-mirror: the failure is LOGGED (visible, not silently swallowed)",
  ]],
  ["gate-cancel.mjs", [
    "(primitive gateType guard) cancelQueued STILL REFUSES a queued deploy entry",
  ]],
  ["graceful-stop.mjs", [
    "idle: NOT hard-killed (escalation never fired)",
    "idle: exactly the original two Ctrl-Cs were written (byte-for-byte unchanged)",
  ]],
  ["mcp-ready-gate.mjs", [
    "7: nudge lands in the pending FIFO promptly once markMcpSeen fires (session not ready yet)",
  ]],
  ["merge-confirm-completion-nudge.mjs", [
    "(5) NO generic [loom:merge-done] echo for the SAME completion — THE double-fire this card fixes (187f5b76)",
    "(6) it names the worker + TIMEOUT wording (not a plain 'build gate failed')",
  ]],
  ["paste-placeholder-tripwire.mjs", [
    "RECOVERY (k): that warning is the ESCALATION, not a normal detection re-log",
    "(l) THE FIX: a MARKED recovery text's own collapse is recognized as a recovery attempt — ESCALATES, never treated as a fresh loss",
    "(m) the recovery notice is NOT part of that same write (it was minted too late to join it)",
    "(m) THE FIX: the delivered recovery still carries the ORIGINAL lost content (annotation never drops it)",
  ]],
  ["paste-recovery-boundary-annotation.mjs", [
    "(A) THE TRAP: with mintedAtGen=47 carried verbatim against a successor at submitGeneration=1 (1 <= 47), the annotation is ABSENT — silently inert, the SAME bug one call deeper",
    "(B) THE FIX: with mintedAtGen absent, the annotation IS PRESENT — an absolute wall-clock disclosure, not silence",
  ]],
  ["pending-ops-registry.mjs", [
    "(evict-on-settle) peek shows NOTHING immediately after settle — no stale 'running' op lingers",
    "(failed slow) once failed, it is EVICTED — not stuck showing 'running' forever",
    "(nudge slow-ok) callback has not fired yet — op still running",
    "(clobber guard) run_A's own completion nudge does NOT spuriously fire against the successor",
    "(durable dedupe) a re-call LONG AFTER retainMs still does NOT mint a fresh op — no second gate run",
    "(durable dedupe) the re-call returns the ORIGINAL cached verdict, not a fresh one",
  ]],
  ["periodic-snapshot.mjs", [
    "(2) snapshot NOT re-copied on unchanged ticks (mtime stable)",
  ]],
  ["pty-giveup-clear.mjs", [
    "(1) DEFERRED CLEAR: exactly ${TEXT.length} backspaces were written — by the REDRAIN, not by give-up itself",
  ]],
  ["pty-giveup-hold-until-confirmed.mjs", [
    "(3) THE BACKSTOP: the body was written a second time (actually re-delivered, not just re-counted)",
    "(4) THE DELIVERY: TEXT1's body was written a second time — actually delivered, not lost",
  ]],
  ["pty-giveup-requeue.mjs", [
    "(3) SUPPRESSED: nothing was ever requeued — pending stays empty",
    "(6) the kickoff was actually RE-DELIVERED (written to the pty a second time), not just re-queued",
  ]],
  ["pty-healifstuck-clear.mjs", [
    "(3) busy stayed false throughout (healIfStuck never re-triggered on the settled session)",
  ]],
  ["pty-log-stream-error.mjs", [
    "logBroken stays true (no spurious reset)",
  ]],
  ["pty-mode-convergence.mjs", [
    "6: NO auto-heal press fires for an unreadable footer — HEALABLE_MODES excludes 'unknown' by construction",
  ]],
  ["pty-mode-heal-retry.mjs", [
    "the heal's cycle has NOT given up yet — still polling, not a second finish",
  ]],
  ["pty-resume-readiness.mjs", [
    "8: exactly one Down and one Up — never a second correction attempt",
  ]],
  ["pty-submit-verify-retry.mjs", [
    "(5) busy was NOT wrongly cleared by B's stale chain — C's turn is still presumed in flight",
  ]],
  ["pty-writechunked-done-on-death.mjs", [
    "card 3ce3fa39: no backspace yet — give-up itself never writes the burst",
    "sanity: killing NOW is genuinely mid-burst, not after completion",
  ]],
  ["restart-giveup-hold.mjs", [
    "(4) THE DELIVERY: it was actually written — delivered, not silently lost",
  ]],
  ["task-defer-until.mjs", [
    "(3) getProjectTask second read performs NO further write — updatedAt unchanged",
  ]],
  ["wake.mjs", [
    "start-reconcile: it was consumed (no lingering row)",
  ]],
  ["worker-stop-reap.mjs", [
    "(B) exactly two reap calls were made (the live manager was never swept)",
  ]],
  ["_probe-composer-dirty.mjs", [
    "3) the queue is now empty (held turn drained, not stranded)",
  ]],
]);

function newlyVisibleHas(file, label) {
  return NEWLY_VISIBLE_UNAUDITED_WAITS.get(file)?.includes(label) ?? false;
}

// The 4 files card 1addef27 retrofitted to assertNeverWithControl — a raw fixed-wait-then-negative-check
// hit in ANY of these is a REGRESSION (the guard rejects it as a fresh flag, never silently re-baselines
// it), not new/unrelated debt.
// Card 4479e6f0, DoD-3: worker-kickoff-guarantee.mjs added as a 5th member. It was independently migrated
// to the SAME assertNeverWithControl/observeOnce shared helpers (with a `positiveControl` on every site —
// confirmed by reading the file directly, 2026-09-01), but was never recorded here, so it got no explicit
// regression check — only the generic "no new violations" catch-all. Membership here does two things a
// pruned KNOWN_UNAUDITED_WAITS entry alone would not: it names the file's migrated status explicitly
// (self-documenting, matching its true state) and it adds it to the loop below (`for (const retrofitted of
// RETROFITTED_FILES)`), which asserts — by name, every run — that this file specifically shows ZERO
// un-exempted raw-idiom hits, the same positive proof the original 4 files get. Leaving it out would mean
// a future regression here is caught only generically, with no file-specific confirmation it's expected
// clean. Verified safe to add now: scanFile('worker-kickoff-guarantee.mjs') finds no un-exempted hits as
// of this commit (every windowMs-idiom site in it carries a `positiveControl` in its own block, which
// clears it — see windowMsCandidateHits below).
const RETROFITTED_FILES = new Set([
  "ws-fleet-session-feed.mjs", "markitdown-prewarm.mjs", "markitdown-provision-nonblocking.mjs", "dev-server.mjs",
  "worker-kickoff-guarantee.mjs",
]);

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs"));
}

/** Scan backward from `waitLineIdx` through the contiguous `//`-comment block directly above it (plus the
 *  wait line itself, which may carry a trailing `//` comment) for a marker matching `markerRe`. Multi-line
 *  annotation comments are the norm in this codebase, so a single-line lookback would miss them. Shared by
 *  both TIMING-GUARD-SAFE and TIMING-GUARD-FALSE-MATCH — same placement rule, different marker + meaning. */
function markerReasonFor(lines, waitLineIdx, markerRe) {
  const onWaitLine = markerRe.exec(lines[waitLineIdx]);
  if (onWaitLine) return onWaitLine[1];
  for (let i = waitLineIdx - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
    const m = markerRe.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}
const exemptionReasonFor = (lines, waitLineIdx) => markerReasonFor(lines, waitLineIdx, EXEMPT_RE);
const falseMatchReasonFor = (lines, waitLineIdx) => markerReasonFor(lines, waitLineIdx, FALSE_MATCH_RE);

// Card 0f744aa4 — the CONTIGUOUS blank-line-delimited block containing `lines[idx]`. Deliberately the SAME
// function (by behavior, not by import — see below) as the sibling diff-scoped guard's own `blockBounds`
// (fixed-wait-witness-guard.mjs, card 5e51e778), which validated this boundary empirically (card e3faa8ac:
// a fixed ±25-line radius flagged 23/26 sites in one file; the blank-line boundary cut that to 15/26). A
// fresh, small copy rather than an import: that sibling guard needs a BUILD (it imports dist/git/
// worktrees.js for the real `git diff`); THIS guard's whole design point is "no build needed — pure
// source-text scan" (see the file header), and importing from a build-dependent module would quietly
// undo that property for every worker who only touched a test file. Returns [start, end] inclusive
// 0-based line indices.
function blockBounds(lines, idx) {
  let start = idx;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
  return [start, end];
}

// Card 0f744aa4 — measured, REAL false-positive collision: `windowMs` is not unique to the timing-guard
// idiom. Loom's own production config shape carries an UNRELATED `authFailLockout: { maxAttempts,
// windowMs, lockoutMs }` (a rate-limiter lockout window in ms — see PlatformConfig's `remoteAccess.
// rateLimit`), and two real test files (platform-forensics-reads.mjs, remote-bind.mjs) pass that literal
// config shape as test DATA, with genuinely negative-polarity check()/assert() calls elsewhere in the same
// block — a live false positive found by running this exact widened guard against the real corpus, not a
// hypothetical. Bare `windowMs:` alone is NOT a safe idiom test; a candidate only counts if its block also
// names the ONE primitive that actually consumes a `windowMs` sampling config (`_timing-guard.mjs`'s
// `observeOnce`/`assertNeverWithControl`) — an unrelated data literal never does.
const TIMING_GUARD_CALL_RE = /\b(?:observeOnce|assertNeverWithControl)\s*\(/;

/** Card 0f744aa4: classify a `windowMs`-idiom candidate line (0-indexed `i`). Not a candidate at all
 *  (returns `[]`) unless its blockBounds block also names `observeOnce`/`assertNeverWithControl` — see
 *  TIMING_GUARD_CALL_RE above for the real collision this guards against. Cleared (returns `[]`) if a
 *  `positiveControl` token appears anywhere in that same block — see the file header's "ALSO CATCHES" note
 *  for why block-scoped, not a fixed line count. Otherwise returns the label of every NEGATIVE-polarity
 *  check()/assert() call found AFTER `i` within the same block (a14717af's multi-match fix applies here
 *  too — a single wait can guard more than one assertion). A block with no check()/assert() at all after
 *  `i` returns `[]` too — a settle/pacing wait, out of scope by design, same posture the raw-idiom path
 *  already takes for a windowless site. */
function windowMsCandidateHits(lines, i) {
  const [start, end] = blockBounds(lines, i);
  const blockText = lines.slice(start, end + 1).join("\n");
  if (!TIMING_GUARD_CALL_RE.test(blockText)) return [];
  if (POSITIVE_CONTROL_RE.test(blockText)) return [];
  const afterText = lines.slice(i + 1, end + 1).join("\n");
  const out = [];
  for (const m of afterText.matchAll(CHECK_OR_ASSERT_RE)) {
    if (NEG_KEYWORDS.test(m[2])) out.push(m[2]);
  }
  return out;
}

function scanFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const codeOnly = stripTrailingComment(lines[i]);
    const isRawIdiom = IDIOM_A.test(codeOnly) || IDIOM_B.test(codeOnly);
    if (isRawIdiom) {
      const window = lines.slice(i, i + 5).join("\n");
      // Scan EVERY check()/assert() in the window (matchAll, not the first match only) — a single wait can
      // guard more than one assertion, and dropping anything past the first is a silent under-report.
      for (const m of window.matchAll(CHECK_OR_ASSERT_RE)) {
        const label = m[2];
        if (!NEG_KEYWORDS.test(label)) continue;
        hits.push({ file, lineNo: i + 1, label, exempt: exemptionReasonFor(lines, i), falseMatch: falseMatchReasonFor(lines, i) });
      }
      continue;
    }
    if (IDIOM_C.test(codeOnly)) {
      for (const label of windowMsCandidateHits(lines, i)) {
        hits.push({ file, lineNo: i + 1, label, exempt: exemptionReasonFor(lines, i), falseMatch: falseMatchReasonFor(lines, i) });
      }
    }
  }
  return hits;
}

const files = walkTestFiles();
// Card 6e9a9209 (census 46d6fdb7, class B): every check below gates on newViolations/regressions/etc.
// derived by iterating `files` — if walkTestFiles() opened ZERO files (TEST_DIR wrong, filter broken),
// every one of those checks passes VACUOUSLY (an empty scan trivially satisfies "found 0"). This is the
// scan-level population control: it fails loudly the moment the traversal itself opens nothing, instead
// of silently certifying an empty scan as a clean corpus. `files.length > 0` (not a hardcoded count) —
// any legitimate future test file only grows this population, never shrinks it toward the floor.
check(`the corpus scan opened at least one test/*.mjs file (found ${files.length})`, files.length > 0);

// Card 743be0c9, DoD-2 — BOTH DIRECTIONS, synthetic: a `//`-comment merely MENTIONING the idiom must NOT
// produce a hit, and a REAL idiom on a code line must STILL produce one. A fix that suppresses both would
// silently blind this guard to every genuine fixed wait in the corpus — worse than the phantom it replaces.
// ⚠️ Built via string concatenation, and the check() labels below deliberately avoid spelling the idiom text
// verbatim — this guard scans its OWN source too (TEST_DIR includes this file), so a literal contiguous
// "sleep(40)" written directly into this file's code would make THIS specimen block a genuine hit against
// itself: the exact self-referential trap the card's own irony describes, hit for real while drafting this.
const SLEEP_IDIOM_SAMPLE = "sleep" + "(40)";
const COMMENT_MENTIONING_IDIOM = "  // this wait matches " + SLEEP_IDIOM_SAMPLE + " — a TIMING-GUARD-SAFE annotation";
const CODE_WITH_TRAILING_COMMENT_MENTIONING_IDIOM = "  await " + SLEEP_IDIOM_SAMPLE + "; // trailing comment, also names " + SLEEP_IDIOM_SAMPLE;
check("sanity: a `//`-comment mentioning the wait idiom is invisible to the idiom test (no phantom site)",
  !IDIOM_A.test(stripTrailingComment(COMMENT_MENTIONING_IDIOM)));
check("sanity: a real wait call on a code line still matches after comment-stripping (fix does not blind real waits)",
  IDIOM_A.test(stripTrailingComment(CODE_WITH_TRAILING_COMMENT_MENTIONING_IDIOM)));

// Card 743be0c9, DoD-2 — BOTH DIRECTIONS, REAL CORPUS specimen (positive-controlled against the actual
// defect, not just a synthetic string): pending-ops-registry.mjs:269 is a `//` comment explaining a timing
// argument by naming the exact call it's contrasting against — a real TIMING-GUARD-style explanation that
// quotes the literal idiom text in prose. Line 270, immediately below it, is the REAL wait it's describing.
// Read directly (not embedded as a literal here, for the same self-scan reason as above) so this fails
// loudly if that file is ever edited out from under this check.
{
  const pendingOpsLines = fs.readFileSync(path.join(TEST_DIR, "pending-ops-registry.mjs"), "utf8").split("\n");
  const commentLine = pendingOpsLines[268]; // 1-indexed 269
  const realWaitLine = pendingOpsLines[269]; // 1-indexed 270
  check("sanity: pending-ops-registry.mjs:269 is still the comment specimen this check depends on (mentions the idiom in prose)",
    IDIOM_A.test(commentLine) && /^\s*\/\//.test(commentLine));
  check("sanity: pending-ops-registry.mjs:270 is still the real-wait specimen this check depends on (a real wait call)",
    IDIOM_A.test(realWaitLine));
  check("REAL CORPUS: the comment at pending-ops-registry.mjs:269 mentioning the idiom in prose is invisible to the idiom test",
    !IDIOM_A.test(stripTrailingComment(commentLine)));
  check("REAL CORPUS: the real wait at pending-ops-registry.mjs:270 still matches after comment-stripping (fix does not blind it)",
    IDIOM_A.test(stripTrailingComment(realWaitLine)));
}

// Card 0f744aa4, DoD-2 — POSITIVE CONTROL for the new `windowMs` idiom, both directions, synthetic (built
// via concatenation — the self-scan trap: this guard scans its own source, so the literal text "window" +
// "Ms" + ":" written contiguously anywhere in THIS file's code would itself become a genuine hit against
// this file, same trap the SLEEP_IDIOM_SAMPLE block above already works around for IDIOM_A).
{
  const WMS = "window" + "Ms";
  // (1) UNCONTROLLED: a windowMs-sampled observeOnce with NO positiveControl anywhere in its block,
  // immediately followed by a NEGATIVE-polarity check() — the exact shape of the real incident this card
  // exists to close (a shipped file carrying two uncontrolled negatives this way).
  const uncontrolled = [
    "{",
    `  const ok = await observeOnce({ check: () => x > 5, ${WMS}: 100 });`,
    '  check("x never exceeds 5 within the window", ok);',
    "}",
  ];
  check("sanity: the UNCONTROLLED synthetic candidate line matches the new windowMs idiom",
    IDIOM_C.test(stripTrailingComment(uncontrolled[1])));
  check("POSITIVE CONTROL: an uncontrolled windowMs site immediately followed by a NEGATIVE-polarity check() IS detected",
    windowMsCandidateHits(uncontrolled, 1).length > 0);

  // (2) CONTROLLED: the identical shape, but with a `positiveControl` key present anywhere in the SAME
  // block — the sanctioned route (card 1addef27) — must clear, not merely happen to fall outside some
  // fixed line count. This is the case a naive fixed-line-window widening gets wrong: the real specimen
  // (ws-fleet-session-feed.mjs) has its own consuming check() land INSIDE a 5-line window from the wait
  // line, which a window-based (rather than block-based) rule would have flagged as a live false positive
  // on already-correct production code.
  const controlled = [
    "{",
    "  positiveControl: async () => {",
    `    const ok = await observeOnce({ check: () => x > 5, ${WMS}: 100 });`,
    "    return ok;",
    "  },",
    '  check("x never exceeds 5 within the window", ok);',
    "}",
  ];
  check("sanity: the CONTROLLED synthetic candidate line ALSO matches the new windowMs idiom (fix does not blind real sites)",
    IDIOM_C.test(stripTrailingComment(controlled[2])));
  check("a positiveControl token anywhere in the block clears a windowMs candidate (card 5e51e778's own proven clearing rule)",
    windowMsCandidateHits(controlled, 2).length === 0);

  // (3) NO ASSERTION NEARBY: a windowMs-sampled observeOnce with no check()/assert() anywhere in its own
  // block at all — the ordinary settle/pacing shape, left alone by design (same posture the raw-idiom path
  // already takes for a windowless site). This is the REAL shape of worker-composer-dirty-signal.mjs's
  // `proveClearMechanismWorks` (a helper that RETURNS a verdict for something else, far away, to assert
  // on) — see the header's "WHAT IT CANNOT SEE" note on by-reference positiveControl.
  const noAssertionNearby = [
    "{",
    `  return await observeOnce({ check: () => x > 5, ${WMS}: 100 });`,
    "}",
  ];
  check("sanity: a windowMs candidate with no check()/assert() anywhere in its block is left alone (settle/pacing wait, out of scope by design)",
    windowMsCandidateHits(noAssertionNearby, 1).length === 0);
}

const newViolations = [];
const badExemptions = [];
const regressions = [];
const falseMatches = [];
const badFalseMatches = [];

for (const file of files) {
  for (const hit of scanFile(file)) {
    const key = `${file}:${hit.lineNo}`; // display-only — membership below is keyed by (file, label)
    if (hit.exempt) {
      if (!SANCTIONED_REASONS.has(hit.exempt)) badExemptions.push({ ...hit, key });
      continue; // validly exempted — cleared, not baselined
    }
    if (hit.falseMatch) {
      // Card 1c5dda5d: a claim about the CLASSIFIER, not the wait — kept OUT of newViolations/baseline
      // entirely (this was never a genuinely negative-polarity site to audit), but tracked as its own
      // population rather than folded silently into the exempt-and-forgotten set above.
      if (!FALSE_MATCH_REASONS.has(hit.falseMatch)) badFalseMatches.push({ ...hit, key });
      else falseMatches.push({ ...hit, key });
      continue;
    }
    if (RETROFITTED_FILES.has(file)) { regressions.push({ ...hit, key }); continue; }
    if (baselineHas(file, hit.label)) continue; // baselined debt, not clearance — see header
    if (newlyVisibleHas(file, hit.label)) continue; // card a14717af: surfaced by the matcher fix, unaudited — see header
    newViolations.push({ ...hit, key });
  }
}

check(`no NEW fixed-wait-guarding-a-negative-assertion sites outside the baseline (found ${newViolations.length})`, newViolations.length === 0);
for (const v of newViolations) console.log(`  NEW  ${v.key}  "${v.label}"`);

check(`no REGRESSION in the 4 retrofitted files back to a raw fixed-wait-then-negative-check (found ${regressions.length})`, regressions.length === 0);
for (const r of regressions) console.log(`  REGRESSION  ${r.key}  "${r.label}"`);

check(`every TIMING-GUARD-SAFE exemption cites one of the ${SANCTIONED_REASONS.size} sanctioned reasons (found ${badExemptions.length} invalid)`, badExemptions.length === 0);
for (const b of badExemptions) console.log(`  BAD-EXEMPTION  ${b.key}  reason="${b.exempt}"`);

// Card 1c5dda5d: TIMING-GUARD-FALSE-MATCH sites are a SEPARATE, VISIBLE population — not silently cleared
// like a TIMING-GUARD-SAFE exemption, and not counted toward newViolations/the baseline. This check always
// passes (cond:true) — it exists to print the count and each site, not to gate the guard; a rising count is
// the signal that NEG_KEYWORDS itself needs work.
check(`${falseMatches.length} site(s) cleared via TIMING-GUARD-FALSE-MATCH (classifier false positives — reported separately from TIMING-GUARD-SAFE clearances, not itself a pass/fail signal)`, true);
for (const f of falseMatches) console.log(`  FALSE-MATCH  ${f.key}  reason="${f.falseMatch}"  "${f.label}"`);

check(`every TIMING-GUARD-FALSE-MATCH cites one of the ${FALSE_MATCH_REASONS.size} sanctioned reasons (found ${badFalseMatches.length} invalid)`, badFalseMatches.length === 0);
for (const b of badFalseMatches) console.log(`  BAD-FALSE-MATCH  ${b.key}  reason="${b.falseMatch}"`);

// The 4 confirmed instances from card 1addef27 must actually be gone from the raw idiom shape (not merely
// exempted or baselined) — proves the retrofit landed, not just that this guard would have accepted a
// no-op. A fresh scan of each of these 4 files finding ZERO idiom-shape matches (retrofitted files use
// assertNeverWithControl, which does not contain the raw idiom text at the call site) confirms this.
for (const retrofitted of RETROFITTED_FILES) {
  const stillRaw = scanFile(retrofitted).some((h) => !h.exempt);
  check(`${retrofitted}: the retrofit actually removed the raw fixed-wait-then-negative-check shape`, !stillRaw);
}

console.log(failures === 0
  ? `\n✅ ALL PASS — no new/regressed fixed-wait-guarding-a-negative-assertion sites. This is NOT a completed census: the baseline above (${KNOWN_UNAUDITED_WAITS_TOTAL} entries, keyed by file+label — see the header's BASELINE KEY note) is UNAUDITED debt, not cleared code.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
