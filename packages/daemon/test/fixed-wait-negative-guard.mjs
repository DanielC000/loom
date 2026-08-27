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
// WHAT IT CANNOT SEE (stated plainly — a guard silently blind to an idiom is the same failure one level
// up, DoD-6): a locally-reimplemented waitUntil/poll-loop misused with a bad predicate (975956b2 found
// these are USUALLY safe — this guard does not verify that; it simply never flags the shape at all); a
// differently-named delay()/wait() helper; a raw non-awaited `setTimeout(fn, N)` (fire-and-forget, never
// `await`ed); or a check()/assert() whose label doesn't textually read as negative even though its polarity
// is (a mislabeled assertion escapes both a human reviewer and this heuristic alike).
//
// EXEMPTIONS: a flagged site clears ONLY by (a) a `// TIMING-GUARD-SAFE: <reason>` comment anywhere in the
// contiguous `//`-comment block immediately above the wait line (or on the wait line itself), where
// <reason> is one of the THREE sanctioned clearing patterns below — the enum is CLOSED on purpose, because
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
// ⚠ COLLISION NOTE: when regenerating, 7 (file, label) pairs collapsed from 2 raw hits to 1 — NOT a bug.
// Each is ONE check() fed by TWO nearby wait constructs (e.g. a bounded `for(...) await sleep(N)` poll
// loop immediately followed by a longer settle sleep) — manually verified by grepping each label back to
// source: every one resolves to exactly ONE check() call. One baseline entry correctly covers both feeding
// wait lines, because the audit unit is the ASSERTION, not each individual timer call upstream of it. This
// is why the entry count below (113, +2 hand-added — see next paragraph) is LOWER than the prior
// line-keyed count (122): re-verify this delta before trusting a future regeneration — a genuine (not
// artifact) merge or split is the one case DoD-5's "investigate before accepting" rule is for.
//
// KNOWN_UNAUDITED_WAITS is a PERMANENT BASELINE, not a countdown to zero — same posture as
// codescape-privacy-guard.mjs's KNOWN_LEAKING_FILES. Every one of its 115 entries (113 auto-derived +
// 2 hand-added for companion-voice-tts-provision.mjs — see the comment at that entry) is UNEXAMINED under
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

// CLOSED enum — see the EXEMPTIONS note above. Each corresponds to one of the three clearing patterns
// source-verified on card 1addef27 (§ CLEARING in the memory note, and companion-voice-*.mjs's own
// annotations below).
const SANCTIONED_REASONS = new Set(["sync-early-return", "sync-probe-no-macrotask", "fully-awaited-completion"]);

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
const NEG_KEYWORDS = /\b(never|not\b|no\s|zero|absent|unaffected|unchanged|stops advancing|stayed|stays|frozen|didn.?t|doesn.?t|hasn.?t|won.?t|refuse|omit)/i;
const EXEMPT_RE = /TIMING-GUARD-SAFE:\s*([a-z-]+)/;
const FALSE_MATCH_RE = /TIMING-GUARD-FALSE-MATCH:\s*([a-z-]+)/;
// Card a14717af: every check()/assert() call in a wait's window, not just the textually-first one — a
// non-global `.match()` silently drops every match after the first, which is how a genuinely-negative
// site sharing a window with an earlier positive-polarity check went unreported entirely (found 1 where
// two candidates existed). Matches check()/assert() in the order they appear in the window.
const CHECK_OR_ASSERT_RE = /(?:check|assert)\(\s*(["'`])((?:(?!\1).)*)\1/g;

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
  ["worker-kickoff-guarantee.mjs", [
    "(H1a) still exactly ONE forced submit (no repeat firing)",
    "(H1b) NO forced submit — nothing was ever written to the pty by Loom's own submit()",
    "(H1c) ready-after-enqueue: no forced submit — the turn had already started when ready landed",
    "(H1d) resume path: NEVER force-submits (no kickoff was ever passed)",
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
const RETROFITTED_FILES = new Set([
  "ws-fleet-session-feed.mjs", "markitdown-prewarm.mjs", "markitdown-provision-nonblocking.mjs", "dev-server.mjs",
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

function scanFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!IDIOM_A.test(line) && !IDIOM_B.test(line)) continue;
    const window = lines.slice(i, i + 5).join("\n");
    // Scan EVERY check()/assert() in the window (matchAll, not the first match only) — a single wait can
    // guard more than one assertion, and dropping anything past the first is a silent under-report.
    for (const m of window.matchAll(CHECK_OR_ASSERT_RE)) {
      const label = m[2];
      if (!NEG_KEYWORDS.test(label)) continue;
      hits.push({ file, lineNo: i + 1, label, exempt: exemptionReasonFor(lines, i), falseMatch: falseMatchReasonFor(lines, i) });
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
  ? "\n✅ ALL PASS — no new/regressed fixed-wait-guarding-a-negative-assertion sites. This is NOT a completed census: the baseline above (115 entries, keyed by file+label — see the header's BASELINE KEY note) is UNAUDITED debt, not cleared code."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
