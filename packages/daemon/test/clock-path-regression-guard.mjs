import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING GUARD (card c1d48ea7) — stops the clock-derived-FILESYSTEM-PATH defect class from silently
// regenerating after card 11a25f10's 257-site sweep. Same shape as fixed-wait-negative-guard.mjs (a static
// TEXT scan over packages/daemon/test/*.mjs, source not dist, baseline + separate categories), applied to a
// different defect class. Not a re-sweep — 11a25f10 already did that; its inventory is on that card. This
// guard only decides whether a NEW site regenerates the class.
//
// THE INCIDENT THIS GUARDS AGAINST: while 11a25f10 sat in the merge queue, a different branch (1555e361)
// landed `` `loom-mst-passmarker9-${Date.now()}.flag` `` — a brand-new bare clock-derived path — into
// merge-spawn-tracked.mjs, one of the very files 11a25f10 had just fixed. Fixed manually by d1dddb65. This
// guard is what should have caught that automatically.
//
// ⭐⭐ ENUMERATE, NOT COUNT (card a14717af, on fixed-wait-negative-guard.mjs — the file this guard's overall
// STRUCTURE is modeled on): that guard's matcher can UNDER-report — it observedly printed `found 1` on a
// scenario with two candidate sites and named the wrong one. `found 0` from an under-reporting matcher is
// indistinguishable from a clean tree, which is exactly the failure this card exists to prevent. THIS
// guard's `classifyFile` below has no windowing, no lookahead, and no cross-line pairing at all — every
// line is independently tested against DATE_TOKEN_RE/CONTEXT_RE/RANDOM_RE/PID_RE in one pass with no early
// break/return/continue-past-a-match, and every qualifying line is unconditionally pushed to `hits.bare` or
// `hits.tierB` (verify by reading the loop — no dedup, no "first match wins"). The two `for (const v of
// new*Violations)` loops further down print EVERY entry, not a count. Positive-control-verified with TWO
// adjacent synthetic violations (not one — a single-violation fixture can't distinguish "enumerates" from
// "stops at first hit"): both an adjacent bare pair and an adjacent Tier-B-candidate pair were shown to be
// reported in full, then removed — see the task report for the raw command+output of both.
//
// WHAT COUNTS AS A "SITE": a line matching BOTH (a) a `${Date.now()` template interpolation, AND (b) one of
// the three shapes 11a25f10's real inventory actually used to derive a filesystem path on that same line —
// `os.tmpdir(`, `path.join(`, or an assignment to `LOOM_HOME`. Validated against the live corpus, not
// assumed: a bare `Date.now()` sweep over test/*.mjs returns 1399 hits, almost all legitimate (ids, project
// names, cache-busting, elapsed-time measurement — see the population check below); requiring the path-shape
// co-occurrence on the SAME line narrows that to 760, and every one of those 760 carries the `${Date.now()`
// interpolation form (checked, not assumed — 0 counterexamples). POSITIVE CONTROL for the scope pattern
// itself: platform-mgmt-surface.mjs's post-fix line and merge-spawn-tracked.mjs's post-fix passMarker9 line
// both still match this shape (they use `${Date.now()}-${process.pid}`, which is still `${Date.now()`) —
// confirming the pattern doesn't accidentally stop seeing a site just because it got hardened.
//
// ⭐⭐ THE TIER DISTINCTION — READ 11a25f10's §TIERS FIRST. This guard does NOT do real call-count /
// control-flow analysis (that's a much bigger and different project). It uses two CHEAP, IMPERFECT proxies
// and states their blind spots plainly rather than letting a green run imply coverage it doesn't have:
//
//   PROXY 1 — LEXICAL INDENTATION: a site whose declaration line starts with no leading whitespace (module
//   top-level `const`/`let`/`var`, or a bare `process.env.LOOM_HOME = ...` assignment) is treated as
//   TIER-A-shaped (evaluated once per process — see 11a25f10's §MECHANISM for why that's the right
//   question, not "is it at the top of the file"). An indented site is treated as TIER-B-CANDIDATE-shaped
//   (could be evaluated more than once per process — inside a test() body, a helper, a hook, a loop).
//
//   PROXY 2 — INLINE ARROW-FUNCTION DEFINITIONS: a site is ALSO treated as TIER-B-CANDIDATE-shaped,
//   regardless of physical indentation, when the same line contains `=>` BEFORE the `${Date.now()` token —
//   i.e. the line itself IS a function definition (the exact `const mkRepo = (tag) => ...` shape 11a25f10
//   found hardest to catch, because a single-line arrow function can sit flush-left at module scope and
//   still be called N times). This is the one refinement beyond naive indentation-only, added because a
//   flush-left arrow-function-definition site would otherwise slip into TIER-A-OK and be presumed safe by
//   construction — exactly the "pattern-matches as already-fixed" trap 11a25f10 named.
//
//   WHAT THIS STILL CANNOT SEE (stated plainly, per this card's own DoD-2 — a guard that overstates its
//   scope is worse than none): a NAMED `function foo(...) { ... }` declaration whose own signature line is
//   flush-left is caught correctly (the Date.now()-bearing line inside its body is indented, so PROXY 1
//   catches it) — but a site where the clock-derived token is assigned to an intermediate variable (e.g. a
//   shared `sfx` suffix) on one line and joined into a path via `path.join(...)` on a LATER line is invisible
//   to this per-line scan entirely, in either direction (missed as a site, not merely miscategorized). The
//   live corpus already contains several such `sfx` sites and every one already carries `Math.random()`
//   alongside `Date.now()`, so this blind spot has not (yet) hidden an actual bare regression — but a future
//   one could. Do not read a green run here as proof no such site exists.
//
// CLASSIFICATION (four buckets, only two ever gate):
//   SAFE-RANDOM — the line also carries `Math.random()` or `randomUUID(` as a per-call discriminator. This
//     actually varies per evaluation regardless of tier, so it is NEVER flagged, baselined, or counted.
//   TIER-A-OK — flush-left/module-scope AND carries `${process.pid}` (no arrow-def shape). Correct-by-
//     construction for the axis it discriminates on (cross-process only) — never flagged or baselined.
//   BARE — no `${process.pid}` and no random discriminator, regardless of tier. Unambiguously the same
//     defect class as the passMarker9 incident. Gates: any NEW (file, line-text) pair outside
//     KNOWN_BARE_DEBT fails immediately.
//   TIER-B-CANDIDATE — indented/arrow-def-shaped AND carries `${process.pid}` but no random discriminator.
//     This is the group 11a25f10 warned is "hardest to find" (pid makes it LOOK fixed; per §TIERS, pid
//     discriminates nothing on the same-process axis Tier B actually collides on). Gates: any NEW (file,
//     line-text) pair outside KNOWN_TIER_B_DEBT fails immediately, forcing a human to either fix it
//     properly (fs.mkdtempSync / randomUUID / a counter — 11a25f10 DoD-2) or explicitly audit-and-baseline it.
//
// ⚠ Both baselines below are UNAUDITED DEBT CARRIED FORWARD, not cleared code — same posture as
// fixed-wait-negative-guard.mjs's KNOWN_UNAUDITED_WAITS. Nobody has individually verified whether any given
// TIER-B-CANDIDATE entry's enclosing function is actually called more than once; 11a25f10 explicitly said
// "do not re-sweep" and this card does not either. The property that matters: neither list can grow
// silently — a NEW entry in either category fails the gate by default.
//
// ⭐ BASELINE KEY = (file, trimmed line text) — NOT (file, line number), for the same reason
// fixed-wait-negative-guard.mjs keys on assertion-label text: line numbers shift on unrelated edits nearby,
// and a line-numbered key would turn every such shift into a spurious NEW violation. Editing the flagged
// line itself (renaming the variable, changing the literal prefix, adding/removing the pid suffix) is
// exactly the moment a human is already looking at the site and should re-audit it — so invalidation and
// the correct re-audit trigger coincide by construction, same as the precedent file.
//
// ✅ POSITIVE CONTROL (run manually, not part of this file's own execution — pasted in the task report):
//   1. `git show d1dddb65~1:packages/daemon/test/merge-spawn-tracked.mjs > packages/daemon/test/merge-spawn-tracked.mjs`
//      (temporarily restores the pre-fix bare passMarker9 line into the working tree)
//   2. `node packages/daemon/test/clock-path-regression-guard.mjs` → must FAIL, flagging merge-spawn-tracked.mjs
//      as a NEW BARE site (it is not in KNOWN_BARE_DEBT — only the 6 pre-existing bare sites are).
//   3. `git checkout -- packages/daemon/test/merge-spawn-tracked.mjs` (restores the real, fixed file)
//   4. `node packages/daemon/test/clock-path-regression-guard.mjs` → must PASS again.
//
// Run: node packages/daemon/test/clock-path-regression-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DATE_TOKEN_RE = /\$\{\s*Date\.now\(\)/;
const CONTEXT_RE = /os\.tmpdir\(|LOOM_HOME|path\.join\(/;
const PID_RE = /\$\{\s*process\.pid\s*\}/;
const RANDOM_RE = /Math\.random\(\)|randomUUID\(/;

// The 6 pre-existing bare sites, as of this card. NOT part of 11a25f10's fix scope (that sweep was
// page-capped and never claimed exhaustiveness — see its own "100+ sites — a FLOOR" framing).
//
// worktrees.mjs (4 sites, NOT FIXED — DoD-5 of card fd849a45: no action expected, defensible as-is): every
// one builds a path whose test outcome is governed by an INJECTED fake (gitFactory/removeDir) or by the
// path's own asserted absence, never by real disk contents found AT that literal path — `ghostPath` (grep
// `const ghostPath`) is asserted "not on disk → fs.rm no-ops"; `stuckPath` (grep `const stuckPath`) drives a
// stubbed gitFactory plus a never-resolving removeDir, so the literal path value never reaches real fs/git at
// all; `goneTarget` (grep `const goneTarget`) and `noRepoPath` (grep `const noRepoPath`) are asserted-absent
// by construction (an already-gone removal target / a nonexistent repo path). A collision between two
// evaluations of any of these would not change the assertion's outcome — recorded here as a fact about the
// corpus, not a safety claim, so a future reader doesn't re-triage them from scratch.
//
// inbox-pull.mjs (2 sites, AUDITED 2026-08-04 by card fd849a45, left AS-IS — no fix needed): the `dbFile`
// assigned from `` `svc-${Date.now()}.db` `` (grep "svc-\${Date.now()}") and the one assigned from
// `` `surface-${Date.now()}.db` `` (grep "surface-\${Date.now()}") each sit inside their own bare top-level
// `{ }` scoping block — (S) and (T) respectively — that this standalone script executes LINEARLY,
// TOP-TO-BOTTOM, EXACTLY ONCE per process — no wrapping function, loop, or hook, and the file is never
// imported by anything else (verified: a repo-wide grep for "inbox-pull" turns up only comment references in
// gate-queue.mjs/gate-history.mjs/orchestration.ts, never an import); it runs ONLY as a fresh child process
// spawned per invocation (test-daemon.mjs's `runOne`, or a direct `node test/inbox-pull.mjs`). So each
// `Date.now()` call here fires exactly once per process — the same-process axis Tier B actually collides on
// is structurally absent, despite the indentation making PROXY 1 flag these as Tier-B-shaped. Cross-process:
// the enclosing `tmpHome` (grep `const tmpHome = path.join(os.tmpdir()`, near the top of the file, before the
// (H)/(S)/(T) blocks) is `` `loom-inbox-${Date.now()}-${process.pid}` `` — ALREADY pid-qualified — so two
// concurrently-running processes can never share a `tmpHome`, and therefore never share the resulting
// `dbFile` path either, regardless of the inner literal's own missing pid suffix. Both axes closed by
// construction; no fix needed.
const KNOWN_BARE_DEBT = new Map([
  ["inbox-pull.mjs", [
    "const dbFile = path.join(tmpHome, `svc-${Date.now()}.db`);",
    "const dbFile = path.join(tmpHome, `surface-${Date.now()}.db`);",
  ]],
  ["worktrees.mjs", [
    "const ghostPath = path.join(process.env.LOOM_HOME, `ghost-${Date.now()}`); // not on disk → fs.rm no-ops",
    "const stuckPath = path.join(process.env.LOOM_HOME, `stuck-${Date.now()}`); // Date.now() here = unique path, not a duration",
    "const goneTarget = path.join(process.env.LOOM_HOME, `already-gone-${Date.now()}`);",
    "const noRepoPath = path.join(process.env.LOOM_HOME, `no-such-repo-${Date.now()}`);",
  ]],
]);

// The 66 pre-existing TIER-B-CANDIDATE sites, as of this card — auto-derived by the same walk+regex logic
// this file runs (regenerate with the classification block below if this ever needs re-deriving; do not
// hand-edit an entry without actually auditing that site's call count first, per the header note above).
const KNOWN_TIER_B_DEBT = new Map([
  ["agent-runs-spend.mjs", ["const cwd = path.join(os.tmpdir(), `loom-spend-tx-${Date.now()}-${process.pid}`);"]],
  ["audit-surface.mjs", [
    "const fixtureRoot = path.join(os.tmpdir(), `loom-p5-src-${Date.now()}-${process.pid}`);",
    "const outsideSecret = path.join(os.tmpdir(), `loom-p5-secret-${Date.now()}-${process.pid}.txt`);",
  ]],
  ["companion-delivery-introspection.mjs", ["const audioFile = path.join(os.tmpdir(), `loom-inapp-voice-${Date.now()}-${process.pid}.ogg`);"]],
  ["companion-memory-recall.mjs", ["const repo = path.join(os.tmpdir(), `loom-mem-recall-repo-${Date.now()}-${process.pid}`);"]],
  ["context-stats.mjs", ["const wrongCwd = path.join(os.tmpdir(), `loom-ctx-WRONG-${Date.now()}-${process.pid}`);"]],
  ["deploy-staleness.mjs", [
    "const noRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-norepo-${Date.now()}-${process.pid}`));",
    "const incRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-increpo-${Date.now()}-${process.pid}`));",
    "const incDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-incdist-${Date.now()}-${process.pid}`));",
    "const shRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-shrepo-${Date.now()}-${process.pid}`));",
    "const shDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-shdaemondist-${Date.now()}-${process.pid}`));",
    "const shSharedDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-shshareddist-${Date.now()}-${process.pid}`));",
    "const webRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-webrepo-${Date.now()}-${process.pid}`));",
    "const webDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-webdaemondist-${Date.now()}-${process.pid}`));",
    "const webWebDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-webwebdist-${Date.now()}-${process.pid}`));",
    "const noWebRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-nowebrepo-${Date.now()}-${process.pid}`));",
    "const noWebDistDir = path.join(os.tmpdir(), `loom-dpstl-missingwebdist-${Date.now()}-${process.pid}`); // never created",
    "const noWebDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-nowebdaemondist-${Date.now()}-${process.pid}`));",
    "const procRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-procrepo-${Date.now()}-${process.pid}`));",
    "const procDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-procdist-${Date.now()}-${process.pid}`));",
  ]],
  ["manager-context-block.mjs", [
    "const spaceVaultDir = path.join(os.tmpdir(), `loom-mctxblk-spacevault-${Date.now()}-${process.pid}`, \"Obsidian Vault\", \"Projects\", spaceProjectName);",
    "const sizeVault = path.join(os.tmpdir(), `loom-mctxblk-sizevault-${Date.now()}-${process.pid}`);",
    "const vaultCustom = path.join(os.tmpdir(), `loom-mctxblk-vaultcustom-${Date.now()}-${process.pid}`);",
    "const refRepoA = path.join(os.tmpdir(), `loom-mctxblk-refA-${Date.now()}-${process.pid}`);",
    "const refRepoB = path.join(os.tmpdir(), `loom-mctxblk-refB-${Date.now()}-${process.pid}`);",
    "const repoR = path.join(os.tmpdir(), `loom-mctxblk-repoR-${Date.now()}-${process.pid}`);",
    "const vaultR = path.join(os.tmpdir(), `loom-mctxblk-vaultR-${Date.now()}-${process.pid}`);",
  ]],
  ["merge-gate-retry-disabled.mjs", ["repo: path.join(os.tmpdir(), `loom-mgrd-repo-${Date.now()}-${process.pid}`), file: \"feature.txt\","]],
  ["merge-spawn-tracked.mjs", [
    "const marker = path.join(os.tmpdir(), `loom-mst-marker-${Date.now()}-${process.pid}.log`);",
    "const marker = path.join(os.tmpdir(), `loom-mst-marker7-${Date.now()}-${process.pid}.log`);",
    "const passMarker = path.join(os.tmpdir(), `loom-mst-passmarker9-${Date.now()}-${process.pid}.flag`);",
  ]],
  ["mgmt-project-agent.mjs", ["const legacyRepo = path.join(os.tmpdir(), `loom-mgmt-legacyrepo-${Date.now()}-${process.pid}`);"]],
  ["paste-placeholder-tripwire.mjs", ["const cwd = path.join(os.tmpdir(), `loom-ppt-txt-${Date.now()}-${process.pid}`);"]],
  ["paste-recovery-boundary-carry.mjs", ["const tmpHome3 = path.join(os.tmpdir(), `loom-prbc3-${Date.now()}-${process.pid}`);"]],
  ["platform-lead-resume-doc.mjs", [
    "const home2 = path.join(os.tmpdir(), `loom-lead-resumedoc-home2-${Date.now()}-${process.pid}`);",
    "const home3 = path.join(os.tmpdir(), `loom-lead-resumedoc-home3-${Date.now()}-${process.pid}`);",
    "const home4 = path.join(os.tmpdir(), `loom-lead-resumedoc-home4-${Date.now()}-${process.pid}`);",
    "const home5 = path.join(os.tmpdir(), `loom-lead-resumedoc-home5-${Date.now()}-${process.pid}`);",
  ]],
  ["repo-entry-no-gate-by-design.mjs", ["const tmpHome = path.join(os.tmpdir(), `loom-rengbd-rest-${Date.now()}-${process.pid}`);"]],
  ["run-gate-cancelled-retention.mjs", ["const repo = path.join(os.tmpdir(), `loom-gcr-d2-repo-${Date.now()}-${process.pid}`);"]],
  ["run-gate-result-consumption.mjs", [
    "const repo = path.join(os.tmpdir(), `loom-rgc-repo-a-${Date.now()}-${process.pid}`);",
    "const repo = path.join(os.tmpdir(), `loom-rgc-repo-b-${Date.now()}-${process.pid}`);",
    "const repo = path.join(os.tmpdir(), `loom-rgc-repo-c-${Date.now()}-${process.pid}`);",
  ]],
  ["schedule-name.mjs", [
    "const tmpHome = path.join(os.tmpdir(), `loom-schedname-mig-${Date.now()}-${process.pid}`);",
    "const tmpHome = path.join(os.tmpdir(), `loom-schedname-comp-${Date.now()}-${process.pid}`);",
  ]],
  ["schedule-prompt.mjs", [
    "const tmpHome = path.join(os.tmpdir(), `loom-schedprompt-mig-${Date.now()}-${process.pid}`);",
    "const tmpHome = path.join(os.tmpdir(), `loom-schedprompt-comp-${Date.now()}-${process.pid}`);",
  ]],
  ["schedule-wake-time-echo.mjs", ["const tmpHome = path.join(os.tmpdir(), `loom-sched-echo-${Date.now()}-${process.pid}`);"]],
  ["setup-surface.mjs", ["const freshVault = path.join(os.tmpdir(), `loom-setup-fresh-vault-${Date.now()}-${process.pid}`);"]],
  ["sibling-session-sweep.mjs", [
    "const repo = path.join(os.tmpdir(), `loom-sss-merge-repo-${Date.now()}-${process.pid}`);",
    "const wt = path.join(os.tmpdir(), `loom-sss-recycle-wt-${Date.now()}-${process.pid}`);",
    "const repo = path.join(os.tmpdir(), `loom-sss-recycle-repo-${Date.now()}-${process.pid}`);",
  ]],
  ["task-dedupe.mjs", ["const tmpHome2 = path.join(os.tmpdir(), `loom-task-dedupe-boarding-${Date.now()}-${process.pid}`);"]],
  // The redproof's OWN deliberately-pre-fix demonstration variable — this line's whole point (card 11a25f10)
  // is to BE the shape this guard flags; it must stay baselined, not fixed, or the redproof it lives in
  // stops proving anything.
  ["temp-path-collision-guard.mjs", ["const mkRepoBare = (tag) => path.join(os.tmpdir(), `loom-mkrepo-${tag}-${Date.now()}-${process.pid}`);"]],
  ["usage-limit-events.mjs", ["process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rlevents-gw-${Date.now()}-${process.pid}`);"]],
  ["usage-limit-weekly-sentinel.mjs", ["const cwd = path.join(os.tmpdir(), `loom-wls-txt-${Date.now()}-${process.pid}`);"]],
  ["user-audit-surface.mjs", ["const outsideSecret = path.join(os.tmpdir(), `loom-b3-secret-${Date.now()}-${process.pid}.txt`);"]],
  ["worker-prompt.mjs", [
    "const refRepoA = path.join(os.tmpdir(), `loom-wprompt-refA-${Date.now()}-${process.pid}`);",
    "const refRepoB = path.join(os.tmpdir(), `loom-wprompt-refB-${Date.now()}-${process.pid}`);",
    "repoR = path.join(os.tmpdir(), `loom-wprompt-repoR-${Date.now()}-${process.pid}`);",
    "const repoRev = path.join(os.tmpdir(), `loom-wprompt-repoRev-${Date.now()}-${process.pid}`);",
  ]],
  ["worker-set-mode.mjs", [
    "const tmpHome = path.join(os.tmpdir(), `loom-wsm-pty-${Date.now()}-${process.pid}`);",
    "const tmpHome = path.join(os.tmpdir(), `loom-wsm-svc-${Date.now()}-${process.pid}`);",
  ]],
  ["worker-spawn-cap-queue.mjs", [
    "const repoC = path.join(os.tmpdir(), `loom-wscq-repoC-${Date.now()}-${process.pid}`);",
    "const repoD = path.join(os.tmpdir(), `loom-wscq-repoD-${Date.now()}-${process.pid}`);",
  ]],
  ["worker-spawn-taskless.mjs", ["const repoCap = path.join(os.tmpdir(), `loom-wstl-cap-repo-${Date.now()}-${process.pid}`);"]],
]);

function baselineHas(map, file, text) {
  return map.get(file)?.includes(text) ?? false;
}

// SELF-EXCLUSION: this file's own baseline data below is a big block of string LITERALS that themselves
// contain `${Date.now()` + path-context text (that's the whole point — they're recorded site text). Without
// excluding SELF, the scanner would match its own baseline entries as if they were live source sites,
// double-counting them against themselves. Every other file's exclusion-worthiness is a judgment call; this
// one is structural and applies to every run.
function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

function classifyFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const hits = { bare: [], tierB: [] };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!DATE_TOKEN_RE.test(raw) || !CONTEXT_RE.test(raw)) continue;
    if (RANDOM_RE.test(raw)) continue; // SAFE-RANDOM — never flagged
    const trimmed = raw.trim();
    const hasPid = PID_RE.test(raw);
    const dateIdx = raw.search(DATE_TOKEN_RE);
    const arrowIdx = raw.indexOf("=>");
    const isInlineArrowDef = arrowIdx !== -1 && arrowIdx < dateIdx;
    const tierBShaped = /^[ \t]/.test(raw) || isInlineArrowDef;
    if (!hasPid) {
      hits.bare.push({ file, lineNo: i + 1, text: trimmed });
    } else if (tierBShaped) {
      hits.tierB.push({ file, lineNo: i + 1, text: trimmed });
    } // else: flush-left + pid, no arrow-def shape → TIER-A-OK, never flagged
  }
  return hits;
}

// ── Population/scope sanity — validates the pattern where the token is KNOWN PRESENT, per this card's
// own DoD-4, rather than trusting a zero from an untested regex. ──────────────────────────────────────
const rawDateNowHits = walkTestFiles()
  .flatMap((f) => fs.readFileSync(path.join(TEST_DIR, f), "utf8").split("\n").filter((l) => /Date\.now\(\)/.test(l)))
  .length;
check(`sanity: a naive Date.now() sweep over test/*.mjs returns a large, mostly-irrelevant population (found ${rawDateNowHits}, expect > 1000 — confirms the path-context filter below is doing real narrowing, not vacuously matching everything)`,
  rawDateNowHits > 1000);

const files = walkTestFiles();
const newBareViolations = [];
const newTierBViolations = [];
let knownBareDebtSeen = 0;
let knownTierBDebtSeen = 0;

for (const file of files) {
  const { bare, tierB } = classifyFile(file);
  for (const hit of bare) {
    if (baselineHas(KNOWN_BARE_DEBT, hit.file, hit.text)) knownBareDebtSeen++;
    else newBareViolations.push(hit);
  }
  for (const hit of tierB) {
    if (baselineHas(KNOWN_TIER_B_DEBT, hit.file, hit.text)) knownTierBDebtSeen++;
    else newTierBViolations.push(hit);
  }
}

// Positive-control sanity for the BASELINE lookup itself: the passMarker9 line, in its CURRENT (fixed)
// form, must be found sitting inside the Tier-B baseline (not the bare one — it already carries a pid) so
// that a genuine edit to it would show up as a NEW violation rather than silently vanishing from both maps.
check("sanity: merge-spawn-tracked.mjs's current (fixed) passMarker9 line is present in KNOWN_TIER_B_DEBT",
  baselineHas(KNOWN_TIER_B_DEBT, "merge-spawn-tracked.mjs", "const passMarker = path.join(os.tmpdir(), `loom-mst-passmarker9-${Date.now()}-${process.pid}.flag`);"));

check(`no NEW bare clock-derived-path sites outside the baseline (found ${newBareViolations.length}; ${knownBareDebtSeen} known-debt sites carried forward — see the KNOWN_BARE_DEBT header for per-site audit status, not all 6 unaudited)`,
  newBareViolations.length === 0);
for (const v of newBareViolations) console.log(`  NEW-BARE  ${v.file}:${v.lineNo}  ${v.text}`);

check(`no NEW indented/fn-def pid-only (Tier-B-candidate) clock-derived-path sites outside the baseline (found ${newTierBViolations.length}; ${knownTierBDebtSeen} known-debt sites carried forward, unaudited)`,
  newTierBViolations.length === 0);
for (const v of newTierBViolations) console.log(`  NEW-TIER-B  ${v.file}:${v.lineNo}  ${v.text}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — no new/regressed clock-derived-filesystem-path sites. NOT a completed census: ${knownBareDebtSeen} bare sites carried forward (2 AUDITED benign by card fd849a45, 4 defensible-as-is via injected-fake/non-existence — see the KNOWN_BARE_DEBT header) + ${knownTierBDebtSeen} Tier-B-candidate sites (still UNAUDITED debt, not cleared code) above. This guard also does not see a clock token joined into a path on a LATER line than where it's derived (see header) — a green run here is not proof no such site exists.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
