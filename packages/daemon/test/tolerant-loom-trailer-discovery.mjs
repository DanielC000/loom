import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 45036494 — `tolerantFindLoomTrailerBlock` (git/worktrees.ts), the DISCOVERY-ONLY tolerant reader
// that recovers a "displaced" landing (a repo's own commit-msg hook moved Loom's trailer paragraph out
// of the message's final position) at `findLandedSquashCommit`/`scanMergedCommitMap`/
// `findAllLandedTrailerCommits`. `parseLoomTrailerBlock` itself is UNCHANGED (card 95940402's own "Do
// not") — this file tests ONLY the new tolerant function, directly, plus one real-git integration proof
// that widened discovery still composes correctly with c13666c6's own ledger gate (a forged candidate is
// DISCOVERED by the tolerant reader, then REFUSED by the ledger, exactly as it should be).
//
// PART A (pure, no git): the function's own bounds —
//   (ACCEPT-DISPLACED) the ordinary case: a Loom block + one trailing trailer-shaped paragraph.
//   (ACCEPT-AT-CAP) exactly 3 trailing paragraphs, exactly at the line cap — still accepted.
//   (REFUSE-TWO-BLOCKS) two independently-well-formed Loom blocks anywhere — ambiguous.
//   (REFUSE-PROSE-AFTER) a trailing paragraph with so much as one prose line — refused.
//   (REFUSE-TOO-MANY-PARAGRAPHS) 4 trailing trailer-shaped paragraphs — over the paragraph cap.
//   (REFUSE-TOO-MANY-LINES) 3 trailing paragraphs whose total line count exceeds the line cap.
//   (REFUSE-DUPLICATE-KEY) an earlier paragraph quotes `Loom-Worker-Branch:` verbatim (the
//     `5e323196`/`6cc1333f` shape) — refused as ambiguous, never silently overwritten.
//   (REFUSE-CASE-VARIANT) the same shape, but the quoted line uses different casing.
//   (REFUSE-UNREADABLE) OUT OF SCOPE by design: foreign text folded INTO the same final paragraph (no
//     blank-line boundary) — there is no paragraph boundary to walk past.
//   (ACCEPT-ORDINARY) sanity: an ordinary, undisplaced trailer (the ALREADY-last paragraph) still
//     resolves via the tolerant function too (it does not regress the trivial case).
//   (REFUSE-LONE-CASE-VARIANT) / (REFUSE-UNKNOWN-KEY) — Code Review 04cfeb36 round 2 (BLOCKING): a LONE
//     case-variant or unknown reserved key, with no canonical duplicate, used to round-trip fine (the
//     round-trip only ever compared the 4 canonical fields it already knew about). Also a property-style
//     check: every ACCEPT fixture must classify "displaced" or "verified" under
//     `verifyLoomTrailersExactAndReadable`, never "forged".
//
// PART B (real git): (HOOK-FORGED-DISPLACED-REFUSED) — a forged commit (never landed by Loom's own merge
// code) carrying a well-formed-but-WRONG-content Loom block followed by a DCO line, on a GONE branch —
// tolerant discovery finds a CANDIDATE, but c13666c6's own ledger gate (verifyGoneBranchLanding) still
// refuses it, because it was never actually ledgered. Proves widening discovery never bypasses the gate.
//
// PART C (real git): (SHADOW) — a newer hand-authored commit quoting an older genuine landing's trailer
// must not hide it, via findLandedSquashCommit's own `--grep` discovery loop.
//
// PART D (real git, round 3): (MAP-SHADOW) — the SAME scenario as (SHADOW), but through
// getMergedCommitMapCached / findLandedSquashCommitViaMap / getTaskMergedInfo instead — the map path had
// its own, separate ranking logic from findLandedSquashCommit's own loop-local tracking variables, so
// nothing proved the map path shared the (SHADOW) fix until this test existed. (Card c0d0eac9 later
// replaced BOTH paths' single-winner ranking with a shared, bounded candidate-list walk — see PART E/F/G.)
//
// PART E (real git, card c0d0eac9): (REVERSE-SHADOW) — the round-3 residual this card fixes: an OLDER
// strict landing hiding a NEWER genuine tolerantly-readable (hook-displaced) landing of the SAME branch
// name, re-cut between the two landings. Both findLandedSquashCommit and the map path must resolve the
// newer genuine landing, not the older one; the branch-present (re-cut, mid-task) case must still fail
// safe to null via the pre-existing re-task guard.
//
// PART F (real git, card c0d0eac9): (CAP-IMPROVEMENT) — relabelled from round 1's own "(CAP-FLOOR)": this
// is NOT a floor test (round 2 Code Review 96b5b772, finding 5) — the PRE-card ("strict always wins")
// code ALSO returns null for 6 newer strict forgeries ahead of a genuine older strict landing, since it
// verifies only the single newest strict candidate it finds and never retries. This scenario proves an
// IMPROVEMENT over that baseline (this card's own bounded fallback finds the genuine landing where the
// pre-card code could not), not a floor it was already meeting. See PART H for the TRUE floor test.
//
// PART G (real git, card c0d0eac9): (SPAWN BOUND) — the ordinary single-candidate case (one genuine,
// gone-branch, strict landing — no fakes, no re-cut) costs EXACTLY 5 git spawns (round 2, finding 5 —
// tightened from "<=10"), matching the pre-card shape (one verification attempt) rather than scaling with
// the new caps.
//
// PART H (real git, card c0d0eac9 round 2, Code Review 96b5b772, finding 1, CRITICAL): (MAP-LIST-FLOOR) —
// a TRUE floor test: the pre-card code resolves a genuine strict landing correctly REGARDLESS of how many
// newer tolerant-shaped candidates precede it (it never even looks at a tolerant candidate once a strict
// one exists anywhere). k=13 and k=20 newer tolerant fakes above a genuine strict, gone-branch landing
// must still resolve to the genuine landing on BOTH readers — proving the map path's own per-branch
// candidate list (bounded at MAP_CANDIDATE_LIST_CAP) can never let tolerant entries evict the strict ones
// the live, unbounded findLandedSquashCommit scan would still find.
//
// PART I (real git, card c0d0eac9 round 2, finding 2): (SHADOW-SKIP-ARM) — the ledger's own degenerate
// "skip" verdict (a scope with ZERO ledger rows — maxRowId null) accepts EVERY branch-gone candidate
// unconditionally, including a never-landed tolerant forgery. A newer tolerant forgery must not beat an
// older genuine strict landing merely because both happen to pass this weakest possible tier — only
// POSITIVE proof (the ledger's own "recorded" verdict — NEVER a PathSet trailer, which is forgeable; see
// round 3's own SHADOW-SKIP-ARM-PATHSET extension below) may let a tolerant candidate win.
//
// PART J (real git, card c0d0eac9 round 2, finding 2): (SHADOW-PRESENT-ARM) — the branch-present content
// check is likewise never positive proof: a newer, hand-authored decoy whose TREE happens to match the
// current LIVE branch's own content must not be reported as "already landed" just because its content
// matches — content equality proves nothing about AUTHORSHIP.
//
// PART K (real git, card c0d0eac9, RETRACTED round 2 -> round 4 finding B1): (TRANSIENT-FAULT) — round 2's
// own ruling here ("a transient fault on ONE candidate must never abort the whole lookup; the walk
// continues to an OLDER candidate") is RETRACTED by round 4: continuing can only ever return the right
// answer or a STALE sha, indistinguishable from inside the walk, so the fix now aborts to `null` on this
// shape instead — see PART N/O below and the decision record's own round-4 section.
//
// PART L (real git, card c0d0eac9 round 3, finding 3, NARROWED by round 4 — see PART N/O): a transient
// ledger "error" verdict on a STRICT candidate aborts the WHOLE lookup to null rather than falling through
// to an older, stale candidate — round 3's own first cut at what round 4 (finding B1) later generalizes.
//
// PART M (real git, card c0d0eac9 round 3, finding 1, CRITICAL): (MAP-PATH-FAULT) — a `git branch --list`
// failure on the map path must fail the WHOLE lookup to null, never silently degrade to
// `branchPresent:false` — which would route a genuinely LIVE re-cut branch onto the branch-gone arm and
// skip the re-task guard entirely, letting a stale older landing finalize over live, unmerged work.
//
// PART I is also EXTENDED (round 3 finding 2, round 4 finding N3): a PathSet-bearing fake — self-
// consistent (same tree as its own parent, so its own Loom-Worker-PathSet trailer trivially verifies
// against its own ancestry, per decision 756a2cd8: "proves files, never authorship") — must not win over
// a genuine older strict landing either, on the ledger-skip arm, the complete NO-LEDGER case, AND (round
// 4) getTaskMergedInfo and the NO-LEDGER map path specifically (the reviewer's own probe B showed these
// two reads correct on HEAD but wrong on round 3's own commit, un-asserted by round 3's own test).
//
// PART N (real git, card c0d0eac9 round 4, finding B1, scenario H): (STALE-FALLTHROUGH-PATHSET) — round
// 3's abort only fired on a LEDGER error. A transient failure in `verifyPersistedPathSet`'s own diff call
// (on a STRICT candidate carrying a REAL, self-consistent Base/PathSet trailer pair) must ALSO abort the
// whole lookup, never fall through to an older, stale candidate.
//
// PART O (real git, card c0d0eac9 round 4, finding B1, scenario D): (TOLERANT-ERROR-ABORT) — round 3's
// abort fired ONLY for `candidate.strict`. On a TOLERANT-ONLY branch (no strict candidate anywhere in the
// list), a ledger error on the newest tolerant candidate must ALSO abort the whole lookup, never fall
// through to an older, stale tolerant candidate — this is the LEAD's "ANY non-definitive outcome on ANY
// candidate" ruling, generalized past round 3's strict-only version.
//
// PART S (real git, card c0d0eac9 round 6, finding 2): (PARENTLESS-NO-BASE) — the no-Base path's
// `rev-parse ${sha}^` throws for a PARENTLESS candidate commit (no Loom-Worker-Base trailer, brought onto
// main as a second parent via an unrelated-history merge) — wrongly classified "error" pre-fix, aborting
// the whole lookup even though a genuine older landing still resolves.
//
// PART T (real git, card c0d0eac9 round 6, manager correction after CR b298e180): (GENUINE-PASS-THROUGH-
// DASH-C) — a genuine, sole candidate with a real, self-consistent Base+PathSet pair must still resolve
// PASS through the real reader's two `-c`-prefixed calls (not silently throw on every input).
//
// PART U (real git, card c0d0eac9 round 7, finding 2): (REF-NAME-BASE-SHAPE) — a ref-name-shaped
// Loom-Worker-Base must be rejected as a definitive fail, never silently accepted as the candidate's own
// claimed sha. See the decision record for the narrow scope of what this closes.
//
// Run: 1) build daemon (pnpm build), 2) node test/tolerant-loom-trailer-discovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-tltd-home-");

const { Db } = await import("../dist/db.js");
const {
  createWorktree, findLandedSquashCommit, tolerantFindLoomTrailerBlock, verifyLoomTrailersExactAndReadable, parseLoomTrailerBlock,
  getMergedCommitMapCached, findLandedSquashCommitViaMap, getTaskMergedInfo, changedPathSetDigest,
} = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "tltd", GIT_AUTHOR_EMAIL: "tltd@loom", GIT_COMMITTER_NAME: "tltd", GIT_COMMITTER_EMAIL: "tltd@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=tltd@loom -c user.name=tltd";
const now = new Date().toISOString();

// ===================== PART A: pure string-level bounds (no git) =====================

{
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/abc\nLoom-Worker-Base: deadbeef\n\nSigned-off-by: CI Bot <ci@example.com>";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(ACCEPT-DISPLACED) resolves the displaced Loom block", r !== null && r.branch === "loom/abc" && r.base === "deadbeef");
}

{
  // Exactly 3 trailing paragraphs, 4 lines each = 12 total lines — AT both caps, still accepted.
  const trailing = Array.from({ length: 3 }, (_, i) => `Change-Id: I${i}\nReviewed-by: x${i}\nTested-by: y${i}\nCc: z${i}`).join("\n\n");
  const msg = `feat(x): a change\n\nLoom-Worker-Branch: loom/atcap\n\n${trailing}`;
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(ACCEPT-AT-CAP) exactly 3 trailing paragraphs / 12 total lines — still accepted", r !== null && r.branch === "loom/atcap");
}

{
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/one\n\nLoom-Worker-Branch: loom/two\n\nSigned-off-by: x";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-TWO-BLOCKS) two independently well-formed Loom blocks — ambiguous, refused", r === null);
}

{
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/abc\n\nthis is not a trailer line at all";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-PROSE-AFTER) a trailing prose line — refused", r === null);
}

{
  const trailing = Array.from({ length: 4 }, (_, i) => `Change-Id: I${i}`).join("\n\n");
  const msg = `feat(x): a change\n\nLoom-Worker-Branch: loom/toomanyparas\n\n${trailing}`;
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-TOO-MANY-PARAGRAPHS) 4 trailing paragraphs (cap is 3) — refused", r === null);
}

{
  // 3 paragraphs (within the paragraph cap) but 5 lines each = 15 total lines, over the 12-line cap.
  const trailing = Array.from({ length: 3 }, (_, i) => `A${i}: 1\nB${i}: 2\nC${i}: 3\nD${i}: 4\nE${i}: 5`).join("\n\n");
  const msg = `feat(x): a change\n\nLoom-Worker-Branch: loom/toomanylines\n\n${trailing}`;
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-TOO-MANY-LINES) 3 paragraphs but 15 total trailing lines (cap is 12) — refused", r === null);
}

{
  // The 5e323196/6cc1333f shape: an EARLIER paragraph quotes the real trailer line verbatim (e.g. a
  // worker's own commit body mentioning the mechanism), then the REAL block, then the hook's line.
  const msg = "feat(x): a change\n\nFor reference, Loom stamps:\nLoom-Worker-Branch: loom/real\n\nLoom-Worker-Branch: loom/real\n\nSigned-off-by: x";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-DUPLICATE-KEY) an earlier paragraph quotes the same reserved key verbatim — refused", r === null);
}

{
  const msg = "feat(x): a change\n\nloom-worker-branch: loom/real\n\nLoom-Worker-Branch: loom/real\n\nSigned-off-by: x";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-CASE-VARIANT) a case-variant duplicate of the same reserved key — refused", r === null);
}

{
  // "unreadable": a prose line folded INTO the same paragraph as the Loom trailer, no blank line — there
  // is no paragraph boundary for this function to walk past; it correctly cannot recover this at all.
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/abc\n[skip ci]";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-UNREADABLE) OUT OF SCOPE by design: no paragraph boundary to walk past — refused", r === null);
}

{
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/ordinary\nLoom-Landed-Tip: abcdef0000000000000000000000000000000000";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(ACCEPT-ORDINARY) sanity: an ALREADY-last-paragraph trailer still resolves (no regression on the trivial case)", r !== null && r.branch === "loom/ordinary" && r.landedTip === "abcdef0000000000000000000000000000000000");
}

// Code Review 04cfeb36, round 2, MAJOR: the ORIGINAL round-1 code only ever refused a DUPLICATE of a
// canonical key — a LONE case-variant or a LONE unknown reserved key, with no canonical duplicate at all,
// silently round-tripped fine (the round-trip only ever compared the 4 canonical fields it already knew
// about, never asking whether some OTHER scanned key existed that it had never heard of). Both repros
// below are the reviewer's own, verbatim.
{
  const msg = "s\n\nLoom-Worker-Branch: loom/x\nloom-worker-pathset: " + "d".repeat(64) + "\n\nSigned-off-by: a";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-LONE-CASE-VARIANT) a LONE case-variant reserved key (no canonical duplicate) — refused, never silently ignored", r === null);
}

{
  const msg = "feat(x): a change\n\nLoom-Worker-Branch: loom/x\nLoom-Worker-Extra: zzz\n\nSigned-off-by: a";
  const r = tolerantFindLoomTrailerBlock(msg);
  check("(REFUSE-UNKNOWN-KEY) a LONE unknown reserved-shaped key — refused, never silently ignored", r === null);
}

// Property-style check (Code Review 04cfeb36, round 2): for every fixture where the tolerant reader
// ACCEPTS, the SAME message must classify as "displaced" (or fully "verified") under
// `verifyLoomTrailersExactAndReadable` — i.e. the tolerant reader never accepts anything the landing path
// itself would call a forgery. `expected` is built the SAME way production does: from the discovered
// fields, never hand-authored per fixture.
{
  const ACCEPT_FIXTURES = [
    ["ACCEPT-DISPLACED", "feat(x): a change\n\nLoom-Worker-Branch: loom/abc\nLoom-Worker-Base: deadbeef\n\nSigned-off-by: CI Bot <ci@example.com>"],
    ["ACCEPT-AT-CAP", `feat(x): a change\n\nLoom-Worker-Branch: loom/atcap\n\n${Array.from({ length: 3 }, (_, i) => `Change-Id: I${i}\nReviewed-by: x${i}\nTested-by: y${i}\nCc: z${i}`).join("\n\n")}`],
    ["ACCEPT-ORDINARY", "feat(x): a change\n\nLoom-Worker-Branch: loom/ordinary\nLoom-Landed-Tip: abcdef0000000000000000000000000000000000"],
  ];
  for (const [label, msg] of ACCEPT_FIXTURES) {
    const r = tolerantFindLoomTrailerBlock(msg);
    if (r === null) { check(`(PROPERTY ${label}) precondition: tolerant accepts this fixture`, false); continue; }
    const expected = { "Loom-Worker-Branch": r.branch };
    if (r.landedTip !== null) expected["Loom-Landed-Tip"] = r.landedTip;
    if (r.base !== null) expected["Loom-Worker-Base"] = r.base;
    if (r.pathSet !== null) expected["Loom-Worker-PathSet"] = r.pathSet;
    const verdict = verifyLoomTrailersExactAndReadable(msg, expected);
    check(`(PROPERTY ${label}) tolerant-accepts ⇒ verifyLoomTrailersExactAndReadable says "displaced" or verified, never "forged"`,
      verdict.ok === true || verdict.kind === "displaced");
  }
}

// Round 3: the 3 fixtures above carry NO bad reserved key, so the property above passed VACUOUSLY against
// pre-fix 209b1ef3 too (pre-fix code accepts a clean fixture just as correctly as the fix does) — it never
// actually exercised the round-2 defect. These two are the round-2 Code Review's own repros (verbatim) —
// messages pre-fix code silently ACCEPTED (a lone case-variant / an unknown reserved key, each followed by
// a hook paragraph). Phrased as the SAME property but as a plain implication ("accepted ⇒ not forged")
// rather than "must accept, then check" — so it is vacuously (and correctly) TRUE now that the fix REFUSES
// both. Against pre-fix 209b1ef3 the antecedent holds (tolerant wrongly accepts) while the consequent is
// false (both genuinely classify "forged" — independent of tolerantFindLoomTrailerBlock, computed straight
// from `expected`), so the implication — and so this property — is FALSE pre-fix: RED.
{
  const WRONGLY_ACCEPTED_FIXTURES = [
    ["LONE-CASE-VARIANT", "s\n\nLoom-Worker-Branch: loom/x\nloom-worker-pathset: " + "d".repeat(64) + "\n\nSigned-off-by: a", { "Loom-Worker-Branch": "loom/x" }],
    ["UNKNOWN-KEY", "feat(x): a change\n\nLoom-Worker-Branch: loom/x\nLoom-Worker-Extra: zzz\n\nSigned-off-by: a", { "Loom-Worker-Branch": "loom/x" }],
  ];
  for (const [label, msg, expected] of WRONGLY_ACCEPTED_FIXTURES) {
    const r = tolerantFindLoomTrailerBlock(msg);
    const notForged = r === null || (() => {
      const verdict = verifyLoomTrailersExactAndReadable(msg, expected);
      return verdict.ok === true || verdict.kind === "displaced";
    })();
    check(`(PROPERTY-WRONGLY-ACCEPTED ${label}) accepted ⇒ not forged — vacuously true once refused; FALSE pre-fix (209b1ef3 wrongly accepted a genuinely-forged message)`, notForged);
  }
}

// ===================== PART B: real git — forged discovery still refused by the ledger gate =====================

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-tltd-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# tltd\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "tltd@loom"); git(repo, "config", "user.name", "tltd");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

{
  const repo = makeRepo("forged");
  const projId = `tltd-proj-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // Establish a REAL ledger boundary via a genuine landing (mirrors branch-gone-ledger-cutover-gate.mjs's
  // own `warmup` pattern) — a real Loom-Worker-Branch trailer commit, recorded in the ledger.
  const { worktreePath, branch: realBranch } = await createWorktree(repo, projId, `tltd-real-task-${Date.now()}`);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "real.ts"), "export const real = 1;\n");
  commitAll(worktreePath, "feat(x): real change", GIT_ID);
  const preReal = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", realBranch);
  git(repo, "commit", "-m", `feat(x): real change\n\nLoom-Worker-Branch: ${realBranch}`);
  const realTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", realBranch, realTip, preReal);
  check("(HOOK-FORGED-DISPLACED-REFUSED) setup: a real ledger boundary now exists", ledger.resolveBoundary() !== null);

  // Forge a commit (never landed by Loom's own merge code) for a branch that is currently gone, parented
  // on the real tip — a well-formed Loom block (content wrong: it names a branch no worker ever had)
  // followed by a DCO line, i.e. EXACTLY the shape tolerant discovery is designed to recover.
  const forgedBranch = "loom/forged-displaced-0000";
  const tree = git(repo, "rev-parse", `${realTip}^{tree}`);
  const forgedMsg = `feat(x): innocuous\n\nLoom-Worker-Branch: ${forgedBranch}\n\nSigned-off-by: CI Bot <ci@example.com>`;
  const forged = git(repo, "commit-tree", tree, "-p", realTip, "-m", forgedMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);

  check("(HOOK-FORGED-DISPLACED-REFUSED) setup control: the real strict reader cannot parse the forged commit's trailer", parseLoomTrailerBlock(forgedMsg) === null);
  check("(HOOK-FORGED-DISPLACED-REFUSED) setup control: the tolerant reader, in isolation, WOULD discover it", tolerantFindLoomTrailerBlock(forgedMsg)?.branch === forgedBranch);
  check("(HOOK-FORGED-DISPLACED-REFUSED) setup control: the forged branch name is genuinely gone", git(repo, "branch", "--list", forgedBranch) === "");

  const found = await findLandedSquashCommit(repo, forgedBranch, "HEAD", { goneBranchLedger: ledger });
  check("(HOOK-FORGED-DISPLACED-REFUSED) THE FIX HOLDS: discovered-then-REFUSED — findLandedSquashCommit still returns null (the ledger gate catches what discovery alone cannot)", found === null);

  db.close();
}

// ===================== PART C: a newer hand-authored quoting commit must not shadow an older landing
//                        (Code Review 04cfeb36, round 2, minor) =====================
{
  const repo = makeRepo("shadow");
  const projId = `tltd-shadow-proj-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-SHADOW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // The OLDER, GENUINE landing: a real squash commit with a clean, strict-parseable final-paragraph
  // trailer, recorded in the ledger — exactly like any ordinary landing.
  const { worktreePath, branch: shadowBranch } = await createWorktree(repo, projId, `tltd-shadow-task-${Date.now()}`);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "shadow.ts"), "export const shadow = 1;\n");
  commitAll(worktreePath, "feat(x): shadow genuine change", GIT_ID);
  const preGenuine = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", shadowBranch);
  git(repo, "commit", "-m", `feat(x): shadow genuine change\n\nLoom-Worker-Branch: ${shadowBranch}`);
  const genuineTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", shadowBranch, genuineTip, preGenuine);
  // branch gone, as after a real finalize — the worktree must be removed first (git refuses to delete a
  // branch still checked out in a linked worktree).
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", shadowBranch], { cwd: repo });
  check("(SHADOW) setup: the genuine older landing strict-parses cleanly", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", genuineTip)) !== null);

  // The NEWER, HAND-AUTHORED commit (the reviewer's own "honest trigger"): a commit QUOTING the same
  // Loom block, followed by a Claude-Session-shaped paragraph — tolerant-parseable, never ledgered,
  // never a real landing (same tree as its own parent — no content change of its own).
  const tree = git(repo, "rev-parse", `${genuineTip}^{tree}`);
  const fakeMsg = `feat(x): innocuous\n\nLoom-Worker-Branch: ${shadowBranch}\n\nClaude-Session: https://claude.ai/code/session_fake`;
  const fakeSha = git(repo, "commit-tree", tree, "-p", genuineTip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(SHADOW) setup control: the fake newer commit is genuinely NEWER, tolerant-parseable, never strict", parseLoomTrailerBlock(fakeMsg) === null && tolerantFindLoomTrailerBlock(fakeMsg)?.branch === shadowBranch);
  check("(SHADOW) setup control: the fake commit was never ledgered (unlike the genuine one)", ledger.rowsByTips([fakeSha]).length === 0);

  const found = await findLandedSquashCommit(repo, shadowBranch, "HEAD", { goneBranchLedger: ledger });
  check("(SHADOW) THE FIX: the OLDER genuine landing is found, never hidden by the newer fake quoting commit", found === genuineTip);

  db.close();
}

// ===================== PART D: the SAME shadow scenario through the MAP path (Code Review 04cfeb36,
//                        round 2, minor — map twin added round 3) =====================
{
  const repo = makeRepo("map-shadow");
  const projId = `tltd-map-shadow-proj-${Date.now()}`;
  const taskId = `tltd-map-shadow-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-MAP-SHADOW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // The OLDER, GENUINE landing — `taskId` (not a hand-picked branch string) drives both this cut AND the
  // later getTaskMergedInfo lookup, since that function derives its own branch from taskId the same way
  // createWorktree does.
  const { worktreePath, branch: mapShadowBranch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "map-shadow.ts"), "export const mapShadow = 1;\n");
  commitAll(worktreePath, "feat(x): map-shadow genuine change", GIT_ID);
  const preGenuine = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", mapShadowBranch);
  git(repo, "commit", "-m", `feat(x): map-shadow genuine change\n\nLoom-Worker-Branch: ${mapShadowBranch}`);
  const genuineTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", mapShadowBranch, genuineTip, preGenuine);
  // branch gone, as after a real finalize — the worktree must be removed first (git refuses to delete a
  // branch still checked out in a linked worktree).
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", mapShadowBranch], { cwd: repo });
  check("(MAP-SHADOW) setup: the genuine older landing strict-parses cleanly", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", genuineTip)) !== null);

  // The NEWER, HAND-AUTHORED commit (same "honest trigger" as (SHADOW)): quotes the same Loom block,
  // followed by a Claude-Session-shaped paragraph — tolerant-parseable, never ledgered, never a real
  // landing (same tree as its own parent — no content change of its own).
  const tree = git(repo, "rev-parse", `${genuineTip}^{tree}`);
  const fakeMsg = `feat(x): innocuous\n\nLoom-Worker-Branch: ${mapShadowBranch}\n\nClaude-Session: https://claude.ai/code/session_fake`;
  const fakeSha = git(repo, "commit-tree", tree, "-p", genuineTip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(MAP-SHADOW) setup control: the fake newer commit is genuinely NEWER, tolerant-parseable, never strict", parseLoomTrailerBlock(fakeMsg) === null && tolerantFindLoomTrailerBlock(fakeMsg)?.branch === mapShadowBranch);
  check("(MAP-SHADOW) setup control: the fake commit was never ledgered (unlike the genuine one)", ledger.rowsByTips([fakeSha]).length === 0);

  // Card c0d0eac9: scanMergedCommitMap's table now retains a bounded, newest-first LIST of candidates per
  // branch (never a single "ranked winner") — the fake (newer) and genuine (older) candidates are BOTH
  // kept, in that order; which one actually resolves is decided at RESOLVE time (findLandedSquashCommitViaMap/
  // getTaskMergedInfo, checked below), not at scan time.
  const { map } = await getMergedCommitMapCached(repo, "HEAD", {});
  const mapShadowCandidateShas = (map.get(mapShadowBranch) ?? []).map((e) => e.sha);
  check("(MAP-SHADOW) setup: the table retains BOTH candidates, newest-first (fake, then genuine)", mapShadowCandidateShas[0] === fakeSha && mapShadowCandidateShas[1] === genuineTip);

  const viaMap = await findLandedSquashCommitViaMap(repo, mapShadowBranch, "HEAD", { goneBranchLedger: ledger });
  check("(MAP-SHADOW) THE FIX, via findLandedSquashCommitViaMap: the OLDER genuine landing is found, never hidden by the newer fake quoting commit", viaMap.hit === true && viaMap.sha === genuineTip);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(MAP-SHADOW) THE FIX, via getTaskMergedInfo: the same genuine landing resolves end-to-end (by taskId, not a hand-picked branch)", viaTask?.sha === genuineTip.slice(0, 7));

  db.close();
}

// ===================== PART E (card c0d0eac9): (REVERSE-SHADOW) — an OLDER strict landing must not hide
//                        a NEWER genuine tolerantly-readable (hook-displaced) landing of the SAME
//                        re-cut branch name =====================
{
  const repo = makeRepo("reverse-shadow");
  const projId = `tltd-rshadow-proj-${Date.now()}`;
  const taskId = `tltd-rshadow-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-RSHADOW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S1: the OLDER, GENUINE, strict-parseable landing.
  const cut1 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut1.worktreePath);
  const branch = cut1.branch;
  fs.writeFileSync(path.join(cut1.worktreePath, "s1.ts"), "export const s1 = 1;\n");
  commitAll(cut1.worktreePath, "feat(x): s1 change", GIT_ID);
  const preS1 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s1 change\n\nLoom-Worker-Branch: ${branch}`);
  const s1Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s1Tip, preS1);
  check("(REVERSE-SHADOW) setup: S1 strict-parses cleanly", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", s1Tip)) !== null);
  execFileSync("git", ["worktree", "remove", "--force", cut1.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });

  const afterS1 = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REVERSE-SHADOW) sanity: right after S1 (branch gone), lookup correctly finds S1", afterS1 === s1Tip);

  // Re-cut the SAME branch name (same taskId) from main (post-S1).
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  check("(REVERSE-SHADOW) setup: re-cut branch has the SAME name as before", cut2.branch === branch);

  const whileLive = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REVERSE-SHADOW) branch-present (re-cut, before T2): still fails safe to null (RE-TASK GUARD, unaffected by this card)", whileLive === null);

  // T2: a SECOND, genuine, HOOK-DISPLACED (tolerant-only) landing of the SAME branch name — newer than S1.
  fs.writeFileSync(path.join(cut2.worktreePath, "t2.ts"), "export const t2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): t2 change", GIT_ID);
  const preT2 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): t2 change\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`);
  const t2Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, t2Tip, preT2);
  check("(REVERSE-SHADOW) setup: T2 is genuinely newer than S1", t2Tip !== s1Tip);
  check("(REVERSE-SHADOW) setup: T2 is NOT strict-parseable (hook displaced the trailer)", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t2Tip)) === null);
  check("(REVERSE-SHADOW) setup: T2 IS tolerant-parseable", tolerantFindLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t2Tip))?.branch === branch);
  check("(REVERSE-SHADOW) setup: T2 is genuinely ledgered (a real landing, not a forgery)", ledger.rowsByTips([t2Tip]).length === 1);
  execFileSync("git", ["worktree", "remove", "--force", cut2.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });

  const foundAfterT2 = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REVERSE-SHADOW) THE FIX: branch-gone lookup resolves the NEWER genuine T2, never the older S1", foundAfterT2 === t2Tip);

  const { map } = await getMergedCommitMapCached(repo, "HEAD", {});
  const rshadowCandidateShas = (map.get(branch) ?? []).map((e) => e.sha);
  check("(REVERSE-SHADOW) setup: the table retains BOTH candidates, newest-first (T2, then S1)", rshadowCandidateShas[0] === t2Tip && rshadowCandidateShas[1] === s1Tip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REVERSE-SHADOW) THE FIX, via findLandedSquashCommitViaMap: resolves T2, never S1", viaMap.hit === true && viaMap.sha === t2Tip);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(REVERSE-SHADOW) THE FIX, via getTaskMergedInfo: resolves T2 end-to-end (by taskId)", viaTask?.sha === t2Tip.slice(0, 7));

  db.close();
}

// ===================== PART F (card c0d0eac9): (CAP-IMPROVEMENT) — several newer, never-ledgered,
//                        STRICT-shaped candidates must never hide a genuine OLDER strict landing (NOT a
//                        floor test — see this file's own header, round 2 finding 5) =====================
{
  const repo = makeRepo("cap-floor");
  const projId = `tltd-capfloor-proj-${Date.now()}`;
  const taskId = `tltd-capfloor-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-CAPFLOOR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "real.ts"), "export const real = 1;\n");
  commitAll(cut.worktreePath, "feat(x): real change", GIT_ID);
  const preReal = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): real change\n\nLoom-Worker-Branch: ${branch}`);
  const genuineTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, genuineTip, preReal);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(CAP-FLOOR) setup: genuine older landing is ledgered", ledger.rowsByTips([genuineTip]).length === 1);

  // 6 NEWER, STRICT-SHAPED (final paragraph is exactly the Loom block, nothing after) forged commits,
  // never ledgered — each fails verification. 6 > MIXED_VERIFY_CAP (5), so this also exercises PHASE 2's
  // strict-only fallback, which must still reach the genuine landing underneath them.
  let tip = genuineTip;
  const fakeShas = [];
  for (let i = 0; i < 6; i++) {
    const tree = git(repo, "rev-parse", `${tip}^{tree}`);
    const fakeMsg = `feat(x): innocuous ${i}\n\nLoom-Worker-Branch: ${branch}`;
    const fake = git(repo, "commit-tree", tree, "-p", tip, "-m", fakeMsg);
    git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fake);
    fakeShas.push(fake);
    tip = fake;
  }
  check("(CAP-FLOOR) setup: 6 fake strict-shaped commits planted, none ledgered", fakeShas.every((s) => ledger.rowsByTips([s]).length === 0));

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(CAP-IMPROVEMENT) 6 failing newer strict candidates still resolve to the genuine older landing, never null", found === genuineTip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(CAP-IMPROVEMENT) map path: the same genuine landing resolves via findLandedSquashCommitViaMap", viaMap.hit === true && viaMap.sha === genuineTip);

  db.close();
}

// ===================== PART G (card c0d0eac9): (SPAWN BOUND) — the ordinary single-candidate case costs
//                        a small, fixed number of git spawns, matching the pre-card shape =====================
{
  const repo = makeRepo("spawn-bound");
  const projId = `tltd-spawnbound-proj-${Date.now()}`;
  const taskId = `tltd-spawnbound-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-SPAWNBOUND", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "only.ts"), "export const only = 1;\n");
  commitAll(cut.worktreePath, "feat(x): only change", GIT_ID);
  const preOnly = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): only change\n\nLoom-Worker-Branch: ${branch}`);
  const onlyTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, onlyTip, preOnly);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });

  // A counting-but-delegating gitFactory (every call still hits real git) — same pattern as
  // branch-gone-ledger-cutover-gate.mjs's own `countingGitFactory`.
  function countingGitFactory(counterRef) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => { counterRef.count++; return real.raw(args); } };
    };
  }

  const counter = { count: 0 };
  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: countingGitFactory(counter) });
  check("(SPAWN BOUND) setup: the single ordinary candidate still resolves correctly", found === onlyTip);
  // Bounded, small, and the SAME order as branch-gone-ledger-cutover-gate.mjs's own (SPAWN COUNT) scenario
  // for a single candidate (git log --grep, branch --list, rev-parse parent, the pathset diff, plus the
  // ledger gate's own ~2-4 spawns) — never scaling with MIXED_VERIFY_CAP/STRICT_FALLBACK_VERIFY_CAP, since
  // only ONE candidate exists to verify at all; phase 1 finds it on its first attempt and phase 2 never runs.
  console.log(`  -> single-candidate spawn count: ${counter.count}`);
  // Round 2, finding 5: tightened from "<=10" to an EXACT count — re-measured against the committed code
  // (log --grep, branch --list, merge-base/rev-parse-parent, the pathset diff, the ledger gate's own
  // spawns) and pinned so a future regression that silently adds a spawn to this path is caught.
  check("(SPAWN BOUND) a single-candidate lookup costs EXACTLY 5 git calls (no scaling with the new caps)", counter.count === 5);

  db.close();
}

// ===================== PART H (card c0d0eac9 round 2, Code Review 96b5b772, finding 1, CRITICAL):
//                        (MAP-LIST-FLOOR) — many newer tolerant fakes must never evict a genuine strict
//                        landing from the map's own bounded per-branch candidate list =====================
async function mapListFloorScenario(k) {
  const repo = makeRepo(`map-list-floor-${k}`);
  const projId = `tltd-mlf${k}-proj-${Date.now()}`;
  const taskId = `tltd-mlf${k}-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: `TLTD-MLF${k}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "real.ts"), "export const real = 1;\n");
  commitAll(cut.worktreePath, "feat(x): real change", GIT_ID);
  const preReal = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): real change\n\nLoom-Worker-Branch: ${branch}`);
  const genuineTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, genuineTip, preReal);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check(`(MAP-LIST-FLOOR k=${k}) setup: genuine older strict landing is ledgered`, ledger.rowsByTips([genuineTip]).length === 1);

  // k NEWER, TOLERANT-SHAPED (Loom block + a trailing Signed-off-by paragraph), never-ledgered fakes —
  // each fails verification, but under the OLD shared-cap map list they could still EVICT the genuine
  // strict candidate from the retained list entirely once k >= MIXED_VERIFY_CAP.
  let tip = genuineTip;
  const fakeShas = [];
  for (let i = 0; i < k; i++) {
    const tree = git(repo, "rev-parse", `${tip}^{tree}`);
    const fakeMsg = `feat(x): innocuous ${i}\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`;
    const fake = git(repo, "commit-tree", tree, "-p", tip, "-m", fakeMsg);
    git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fake);
    fakeShas.push(fake);
    tip = fake;
  }
  check(`(MAP-LIST-FLOOR k=${k}) setup: ${k} fake tolerant-shaped commits planted, none ledgered`, fakeShas.every((s) => ledger.rowsByTips([s]).length === 0));

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check(`(MAP-LIST-FLOOR k=${k}) THE FLOOR, direct reader: ${k} failing newer tolerant candidates still resolve to the genuine older strict landing`, found === genuineTip);

  const { map } = await getMergedCommitMapCached(repo, "HEAD", {});
  const retainedShas = (map.get(branch) ?? []).map((e) => e.sha);
  check(`(MAP-LIST-FLOOR k=${k}) setup: the genuine strict landing is still retained in the map's own per-branch list`, retainedShas.includes(genuineTip));

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check(`(MAP-LIST-FLOOR k=${k}) THE FLOOR, map path: resolves the genuine older strict landing, never null/undefined`, viaMap.hit === true && viaMap.sha === genuineTip);

  db.close();
}
await mapListFloorScenario(13);
await mapListFloorScenario(20);

// ===================== PART I (card c0d0eac9 round 2, finding 2): (SHADOW-SKIP-ARM) — the ledger's own
//                        degenerate "skip" verdict (zero rows) must never let a tolerant forgery beat a
//                        genuine older strict landing =====================
{
  const repo = makeRepo("shadow-skip-arm");
  const projId = `tltd-ssa-proj-${Date.now()}`;
  const taskId = `tltd-ssa-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-SSA", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");
  check("(SHADOW-SKIP-ARM) setup: the ledger genuinely has ZERO rows (maxRowId null, boundary null)", ledger.resolveBoundary() === null);

  // The OLDER, GENUINE strict landing — deliberately NEVER ledgered (simulates the real "very first
  // landing ever confirmed" quirk, c13666c6's own named quirk — the ledger has no rows at all yet).
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "s1.ts"), "export const s1 = 1;\n");
  commitAll(cut.worktreePath, "feat(x): s1 change", GIT_ID);
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s1 change\n\nLoom-Worker-Branch: ${branch}`);
  const s1Tip = git(repo, "rev-parse", "HEAD");
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(SHADOW-SKIP-ARM) setup: S1 strict-parses cleanly", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", s1Tip)) !== null);
  check("(SHADOW-SKIP-ARM) setup: the ledger STILL has zero rows (S1 was never recorded)", ledger.maxRowId() === null);

  // A NEWER, hand-authored, tolerant-shaped forgery — never landed by Loom's own merge code, never
  // ledgered — naming the SAME branch.
  const tree = git(repo, "rev-parse", `${s1Tip}^{tree}`);
  const fakeMsg = `feat(x): innocuous\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`;
  const fakeSha = git(repo, "commit-tree", tree, "-p", s1Tip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(SHADOW-SKIP-ARM) setup control: the fake is genuinely newer, tolerant-parseable, never strict", parseLoomTrailerBlock(fakeMsg) === null && tolerantFindLoomTrailerBlock(fakeMsg)?.branch === branch);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(SHADOW-SKIP-ARM) THE FIX: the OLDER genuine S1 is found, never the newer fake (positive-proof gate)", found === s1Tip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(SHADOW-SKIP-ARM) THE FIX, map path: resolves S1, never the fake", viaMap.hit === true && viaMap.sha === s1Tip);

  // Round 3 (finding 2): a PathSet-bearing fake — SELF-CONSISTENT (same tree as its own parent, i.e. a
  // ZERO-diff commit, so its own Loom-Worker-PathSet trailer trivially verifies against its own ancestry —
  // decision 756a2cd8: "proves files, never authorship") — must not win over S1 either, on BOTH the
  // ledger-skip arm (ledger present, zero rows) AND the complete NO-LEDGER case (deps carries no
  // goneBranchLedger key at all). Round 2's own fix (`positiveProof: pathSetVerified || verdict ===
  // "recorded"`) let a self-consistent PathSet trailer alone count as positive proof; round 3 drops
  // `pathSetVerified` from `positiveProof` entirely — only a ledger "recorded" verdict counts now.
  {
    const emptyPathSetDigest = createHash("sha256").update([].sort().join("\n")).digest("hex");
    const pathsetFakeMsg = `feat(x): innocuous pathset\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-PathSet: ${emptyPathSetDigest}\n\nSigned-off-by: CI Bot <ci@example.com>`;
    const pathsetFakeSha = git(repo, "commit-tree", tree, "-p", s1Tip, "-m", pathsetFakeMsg);
    git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", pathsetFakeSha);
    check("(SHADOW-SKIP-ARM-PATHSET) setup control: the fake is genuinely newer, tolerant-parseable, never strict, and carries the PathSet trailer",
      parseLoomTrailerBlock(pathsetFakeMsg) === null && tolerantFindLoomTrailerBlock(pathsetFakeMsg)?.pathSet === emptyPathSetDigest);

    const foundWithLedger = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
    check("(SHADOW-SKIP-ARM-PATHSET) THE FIX, ledger-skip arm: a self-consistent PathSet trailer alone is never positive proof — S1 still wins", foundWithLedger === s1Tip);

    const foundNoLedger = await findLandedSquashCommit(repo, branch, "HEAD", {});
    check("(SHADOW-SKIP-ARM-PATHSET) THE FIX, NO-LEDGER variant (deps carries no goneBranchLedger at all): S1 still wins", foundNoLedger === s1Tip);

    const viaMapWithLedger = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
    check("(SHADOW-SKIP-ARM-PATHSET) THE FIX, map path, ledger-skip arm: S1 still wins", viaMapWithLedger.hit === true && viaMapWithLedger.sha === s1Tip);

    // Round 4 (finding N3, Code Review 06825f63's own probe B): the reviewer's probe showed HEAD correct
    // but d3d82bc7 wrong on these two SPECIFIC reads — getTaskMergedInfo (the end-to-end, by-taskId path)
    // and the map path under the NO-LEDGER variant — neither was asserted by round 3's own test.
    const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
    check("(SHADOW-SKIP-ARM-PATHSET) THE FIX, getTaskMergedInfo, ledger-skip arm: resolves S1, never the fake", viaTask?.sha === s1Tip.slice(0, 7));

    const viaMapNoLedger = await findLandedSquashCommitViaMap(repo, branch, "HEAD", {});
    check("(SHADOW-SKIP-ARM-PATHSET) THE FIX, map path, NO-LEDGER variant: S1 still wins", viaMapNoLedger.hit === true && viaMapNoLedger.sha === s1Tip);
  }

  db.close();
}

// ===================== PART J (card c0d0eac9 round 2, finding 2): (SHADOW-PRESENT-ARM) — a content-only
//                        match must never be reported as "already landed" while the branch is genuinely
//                        LIVE with real unmerged work =====================
{
  const repo = makeRepo("shadow-present-arm");
  const projId = `tltd-spa-proj-${Date.now()}`;
  const taskId = `tltd-spa-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-SPA", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S1: an OLDER, genuine strict landing of the branch's FIRST generation.
  const cut1 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut1.worktreePath);
  const branch = cut1.branch;
  fs.writeFileSync(path.join(cut1.worktreePath, "s1.ts"), "export const s1 = 1;\n");
  commitAll(cut1.worktreePath, "feat(x): s1 change", GIT_ID);
  const preS1 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s1 change\n\nLoom-Worker-Branch: ${branch}`);
  const s1Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s1Tip, preS1);
  execFileSync("git", ["worktree", "remove", "--force", cut1.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });

  // Re-cut the SAME branch name (second generation) and give it NEW, real, unmerged work — stays LIVE
  // for the rest of this test (never landed again).
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  fs.writeFileSync(path.join(cut2.worktreePath, "s2.ts"), "export const s2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): s2 live change", GIT_ID);
  const branchRefTree = git(repo, "rev-parse", `refs/heads/${branch}^{tree}`);
  check("(SHADOW-PRESENT-ARM) setup: branch is genuinely present (live, unmerged)", git(repo, "branch", "--list", branch) !== "");

  // A NEWER, hand-authored decoy commit on main — its TREE is crafted to literally equal the LIVE
  // branch's CURRENT tip tree, so branchContentLandedInCommit's content-equality check trivially passes,
  // without the decoy being the branch's real author or the branch ever having actually landed.
  const fakeMsg = `feat(x): innocuous\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`;
  const fakeSha = git(repo, "commit-tree", branchRefTree, "-p", s1Tip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(SHADOW-PRESENT-ARM) setup control: the fake is genuinely newer, tolerant-parseable, never strict", parseLoomTrailerBlock(fakeMsg) === null && tolerantFindLoomTrailerBlock(fakeMsg)?.branch === branch);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(SHADOW-PRESENT-ARM) THE FIX: never falsely reports 'already landed' via content-only match while the branch is genuinely live", found === null);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(SHADOW-PRESENT-ARM) THE FIX, map path: same — never a false content-only accept", viaMap.hit === true && viaMap.sha === null);

  db.close();
}

// ===================== PART K (card c0d0eac9, RETRACTED round 2 -> round 4 finding B1): (TRANSIENT-FAULT)
//                        — round 2's own ruling here ("a transient fault on ONE candidate must never abort
//                        the whole lookup — the walk continues to an older candidate") is RETRACTED by
//                        round 4: a transient failure means that candidate's real status is UNKNOWN, so
//                        continuing can only ever return the right answer OR a STALE sha, and the walk
//                        cannot tell which from the inside. The fix now takes the pre-card FLOOR (null) on
//                        this shape instead — see the decision record's round-4 section for the full
//                        reasoning. =====================
{
  const repo = makeRepo("transient-fault");
  const projId = `tltd-tf-proj-${Date.now()}`;
  const taskId = `tltd-tf-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-TF", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // The branch, cut from main's VERY FIRST commit (init) and kept LIVE with real unmerged work — never
  // squash-landed. Neither decoy below descends from this branch's own history; both are independent,
  // content-matching commits on main, so NEITHER trips the re-task guard — this isolates finding 3 (the
  // try/catch gap) from finding 2 (positive proof), which PART J already covers separately.
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "s2.ts"), "export const s2 = 1;\n");
  commitAll(cut.worktreePath, "feat(x): live change", GIT_ID);
  const branchRefTree = git(repo, "rev-parse", `refs/heads/${branch}^{tree}`);
  const initTip = git(repo, "rev-parse", "HEAD");
  check("(TRANSIENT-FAULT) setup: branch is genuinely present (live, unmerged)", git(repo, "branch", "--list", branch) !== "");

  // OLDER: a strict-shaped decoy on main, parented on main's own init commit, with its TREE crafted to
  // equal the live branch's CURRENT tip tree — content-equality passes once reached, same construction as
  // PART J's own fake, just STRICT instead of tolerant (strict never needs positive proof).
  const olderMsg = `feat(x): innocuous older\n\nLoom-Worker-Branch: ${branch}`;
  const olderSha = git(repo, "commit-tree", branchRefTree, "-p", initTip, "-m", olderMsg);
  // DECOY: a NEWER strict-shaped decoy, parented on OLDER (so it's genuinely newer in `git log` order),
  // SAME crafted tree — its own merge-base call is the one we fault-inject below.
  const decoyMsg = `feat(x): innocuous newer\n\nLoom-Worker-Branch: ${branch}`;
  const decoySha = git(repo, "commit-tree", branchRefTree, "-p", olderSha, "-m", decoyMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", decoySha);
  check("(TRANSIENT-FAULT) setup control: neither decoy is an ancestor of the live branch (merge-base misses both)",
    git(repo, "merge-base", olderSha, `refs/heads/${branch}`) !== olderSha
    && git(repo, "merge-base", decoySha, `refs/heads/${branch}`) !== decoySha);
  check("(TRANSIENT-FAULT) setup control: both decoys strict-parse, DECOY genuinely newer than OLDER", parseLoomTrailerBlock(olderMsg)?.branch === branch && parseLoomTrailerBlock(decoyMsg)?.branch === branch);

  // Fault-inject: a counting-but-delegating gitFactory whose `raw()` THROWS specifically for a
  // `merge-base` call naming the DECOY's own sha — every other call (including OLDER's own merge-base)
  // passes through to real git untouched.
  function faultyGitFactory() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return {
        raw: (args) => {
          if (args[0] === "merge-base" && args[1] === decoySha) {
            throw new Error("(TRANSIENT-FAULT) injected transient failure");
          }
          return real.raw(args);
        },
      };
    };
  }

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(TRANSIENT-FAULT) THE RETRACTED FIX (round 4): a transient fault on the newer decoy aborts the WHOLE lookup to null — never falls back to the older, forged OLDER", found === null);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(TRANSIENT-FAULT) THE RETRACTED FIX, map path: same abort-to-null", viaMap.hit === true && viaMap.sha === null);

  db.close();
}

// ===================== PART L (card c0d0eac9 round 3, finding 3): (ERROR-ABORT) — a transient ledger
//                        "error" verdict on a STRICT candidate must abort the WHOLE lookup to null, never
//                        fall through to an OLDER, stale candidate — restoring round 2's own single-
//                        attempt floor for this specific failure shape =====================
{
  const repo = makeRepo("error-abort");
  const projId = `tltd-ea-proj-${Date.now()}`;
  const taskId = `tltd-ea-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-EA", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S0: the OLDER, genuine strict landing — real squash, ledgered.
  const cut0 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut0.worktreePath);
  const branch = cut0.branch;
  fs.writeFileSync(path.join(cut0.worktreePath, "s0.ts"), "export const s0 = 1;\n");
  commitAll(cut0.worktreePath, "feat(x): s0 change", GIT_ID);
  const preS0 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}`);
  const s0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s0Tip, preS0);
  execFileSync("git", ["worktree", "remove", "--force", cut0.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(ERROR-ABORT) setup: S0 is genuinely ledgered", ledger.rowsByTips([s0Tip]).length === 1);

  // S2: the SAME branch name re-cut (second generation) and landed a SECOND time — also a genuine, real
  // squash, also ledgered, and genuinely NEWER than S0.
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  fs.writeFileSync(path.join(cut2.worktreePath, "s2.ts"), "export const s2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): s2 change", GIT_ID);
  const preS2 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s2 change\n\nLoom-Worker-Branch: ${branch}`);
  const s2Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s2Tip, preS2);
  execFileSync("git", ["worktree", "remove", "--force", cut2.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(ERROR-ABORT) setup: S2 is genuinely ledgered and newer than S0",
    ledger.rowsByTips([s2Tip]).length === 1 && git(repo, "merge-base", s0Tip, s2Tip) === s0Tip);

  // Fault-inject: a gitFactory whose `raw()` throws specifically for the ledger's own PRE-LEDGER
  // boundary-check `merge-base` call naming S2's own sha — every other call (including S0's own identical
  // check, with a DIFFERENT sha argument) passes through to real git untouched. This makes
  // classifyAgainstLedgerUncached return "error" for S2 specifically, never "unrecorded" — the distinction
  // this finding is about.
  function faultyGitFactory() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return {
        raw: (args) => {
          if (args[0] === "merge-base" && args[1] === s2Tip) {
            throw new Error("(ERROR-ABORT) injected ledger pre-ledger-boundary failure");
          }
          return real.raw(args);
        },
      };
    };
  }

  // The faulty calls run FIRST, deliberately — classifyAgainstLedger's own verdict cache is process-
  // global and keyed on (sha, refTip, maxRowId), independent of reader; an "error" verdict is NEVER
  // cached (by design — see classifyAgainstLedger's own doc), but a "recorded" one IS, so running a clean
  // lookup for S2 first would poison these two faulty assertions with a cached pre-fault verdict that
  // never gives the fault a chance to fire.
  const foundFaulty = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(ERROR-ABORT) THE FIX: S2's ledger error aborts the WHOLE lookup to null — never falls back to stale S0", foundFaulty === null);

  const viaMapFaulty = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(ERROR-ABORT) THE FIX, map path: same abort-to-null, never stale S0", viaMapFaulty.hit === true && viaMapFaulty.sha === null);

  // Setup control: run AFTER the faulty assertions above (see the caching note) — WITHOUT the fault,
  // "newest verified wins" correctly resolves to S2, proving this scenario really exercises the walk's
  // ordinary happy path and the null results above are caused by the fault, not some other refusal.
  const foundClean = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(ERROR-ABORT) setup control: without the fault, the newer S2 resolves correctly (sanity for walk order)", foundClean === s2Tip);

  db.close();
}

// ===================== PART M (card c0d0eac9 round 3, finding 1, CRITICAL): (MAP-PATH-FAULT) — a
//                        `git branch --list` failure on the map path must fail the WHOLE lookup to null,
//                        never silently degrade to branchPresent:false — which would route a genuinely
//                        LIVE re-cut branch onto the branch-gone arm and skip the re-task guard entirely =====================
{
  const repo = makeRepo("map-path-fault");
  const projId = `tltd-mpf-proj-${Date.now()}`;
  const taskId = `tltd-mpf-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-MPF", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S1: a genuine strict landing, recorded in the ledger.
  const cut1 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut1.worktreePath);
  const branch = cut1.branch;
  fs.writeFileSync(path.join(cut1.worktreePath, "s1.ts"), "export const s1 = 1;\n");
  commitAll(cut1.worktreePath, "feat(x): s1 change", GIT_ID);
  const preS1 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s1 change\n\nLoom-Worker-Branch: ${branch}`);
  const s1Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s1Tip, preS1);
  execFileSync("git", ["worktree", "remove", "--force", cut1.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(MAP-PATH-FAULT) setup: S1 is genuinely ledgered", ledger.rowsByTips([s1Tip]).length === 1);

  // Re-cut the SAME branch name (second generation) with NEW, real, unmerged work — stays LIVE for the
  // rest of this test (never landed again).
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  fs.writeFileSync(path.join(cut2.worktreePath, "s2.ts"), "export const s2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): s2 live change", GIT_ID);
  check("(MAP-PATH-FAULT) setup: the branch is genuinely re-cut and present (live, unmerged)", git(repo, "branch", "--list", branch) !== "");

  function faultyBranchListGitFactory() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return {
        raw: (args) => {
          if (args[0] === "branch" && args[1] === "--list") {
            throw new Error("(MAP-PATH-FAULT) injected branch --list failure");
          }
          return real.raw(args);
        },
      };
    };
  }

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyBranchListGitFactory() });
  check("(MAP-PATH-FAULT) THE FIX: a branch-list failure fails the WHOLE map-path lookup — hit:true (S1's trailer is a candidate), sha:null, NEVER S1's sha",
    viaMap.hit === true && viaMap.sha === null);

  const info = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger, gitFactory: faultyBranchListGitFactory() });
  check("(MAP-PATH-FAULT) THE FIX, getTaskMergedInfo: same — null, never S1's sha", info === null);

  // Setup control: WITHOUT the fault, the live re-cut branch still correctly fails safe to null too (the
  // PRE-EXISTING re-task guard, unaffected by this card) — proving the fault above is what's actually
  // under test here, not some other, unrelated refusal.
  const viaMapClean = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(MAP-PATH-FAULT) setup control: WITHOUT the fault, the live re-cut branch still resolves to sha:null (the pre-existing re-task guard, not this fix)",
    viaMapClean.hit === true && viaMapClean.sha === null);

  db.close();
}

// ===================== PART N (card c0d0eac9 round 4, finding B1, scenario H): (STALE-FALLTHROUGH-PATHSET)
//                        — round 3 only aborted on a LEDGER error, on a STRICT candidate. A transient
//                        PathSet-diff failure (verifyPersistedPathSet's own `changedPathSetDigest` call)
//                        on the NEWEST candidate — S2, genuine + ledgered + carrying REAL (self-
//                        consistent, not forged) Base/PathSet trailers — must ALSO abort the WHOLE lookup
//                        to null, never fall through to an OLDER, STALE candidate (S0, also genuine +
//                        ledgered) =====================
{
  const repo = makeRepo("stale-fallthrough-pathset");
  const projId = `tltd-sfp-proj-${Date.now()}`;
  const taskId = `tltd-sfp-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-SFP", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");
  const sg = simpleGit(repo);

  // S0: the OLDER, genuine strict landing — real squash, ledgered, with a REAL Base + PathSet trailer
  // pair. Stamped the same way production does: commit first (so the digest is computed off the REAL
  // committed diff, never a hand-guessed one), then amend ONLY the message (never the tree) to add the
  // trailers — matching mergeBranchLocked's own order (card c862f14c).
  const cut0 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut0.worktreePath);
  const branch = cut0.branch;
  fs.writeFileSync(path.join(cut0.worktreePath, "s0.ts"), "export const s0 = 1;\n");
  commitAll(cut0.worktreePath, "feat(x): s0 change", GIT_ID);
  const preS0 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}`);
  const pathSet0 = await changedPathSetDigest(sg, preS0, git(repo, "rev-parse", "HEAD"));
  git(repo, "commit", "--amend", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: ${preS0}\nLoom-Worker-PathSet: ${pathSet0}`);
  const s0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s0Tip, preS0);
  execFileSync("git", ["worktree", "remove", "--force", cut0.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(STALE-FALLTHROUGH-PATHSET) setup: S0 is genuinely ledgered with a real, self-consistent Base+PathSet trailer pair",
    ledger.rowsByTips([s0Tip]).length === 1 && parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", s0Tip))?.pathSet === pathSet0);

  // S2: the SAME branch name re-cut (second generation), landed a SECOND time — same real-trailer
  // construction, genuinely NEWER than S0.
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  fs.writeFileSync(path.join(cut2.worktreePath, "s2.ts"), "export const s2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): s2 change", GIT_ID);
  const preS2 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s2 change\n\nLoom-Worker-Branch: ${branch}`);
  const pathSet2 = await changedPathSetDigest(sg, preS2, git(repo, "rev-parse", "HEAD"));
  git(repo, "commit", "--amend", "-m", `feat(x): s2 change\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: ${preS2}\nLoom-Worker-PathSet: ${pathSet2}`);
  const s2Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s2Tip, preS2);
  execFileSync("git", ["worktree", "remove", "--force", cut2.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(STALE-FALLTHROUGH-PATHSET) setup: S2 is genuinely ledgered with a real Base+PathSet pair, newer than S0",
    ledger.rowsByTips([s2Tip]).length === 1
    && parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", s2Tip))?.pathSet === pathSet2
    && git(repo, "merge-base", s0Tip, s2Tip) === s0Tip);

  // Fault-inject: a gitFactory whose `raw()` throws specifically for the PathSet-verify diff call naming
  // S2's own (base, sha) range — `${preS2}..${s2Tip}`, the LAST element verifyPersistedPathSet's own
  // changedPathSetDigest call always passes (NAME_ONLY_DIFF_FLAGS + the range) — S0's own, differently-
  // shaped range (`${preS0}..${s0Tip}`) passes through to real git untouched.
  function faultyGitFactory() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return {
        raw: (args) => {
          if (args.includes("diff") && args[args.length - 1] === `${preS2}..${s2Tip}`) {
            throw new Error("(STALE-FALLTHROUGH-PATHSET) injected path-set diff failure");
          }
          return real.raw(args);
        },
      };
    };
  }

  // verifyPersistedPathSet carries NO cache of its own (unlike classifyAgainstLedger), so order doesn't
  // matter here the way it did for (ERROR-ABORT) — still faulty-then-clean, for consistency with the rest
  // of this file.
  const foundFaulty = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(STALE-FALLTHROUGH-PATHSET) THE FIX (scenario H): S2's PathSet-diff error aborts the WHOLE lookup to null — never falls back to stale S0", foundFaulty === null);

  const viaMapFaulty = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(STALE-FALLTHROUGH-PATHSET) THE FIX, map path: same abort-to-null, never stale S0", viaMapFaulty.hit === true && viaMapFaulty.sha === null);

  const infoFaulty = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(STALE-FALLTHROUGH-PATHSET) THE FIX, getTaskMergedInfo: same — null, never S0's sha", infoFaulty === null);

  const foundClean = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(STALE-FALLTHROUGH-PATHSET) setup control: without the fault, the newer S2 resolves correctly (sanity for walk order)", foundClean === s2Tip);

  db.close();
}

// ===================== PART O (card c0d0eac9 round 4, finding B1, scenario D): (TOLERANT-ERROR-ABORT) —
//                        round 3's abort fired ONLY `candidate.strict && outcome.ledgerError`. On a
//                        TOLERANT-ONLY branch (no strict candidate anywhere in the list), a ledger error
//                        on the newest tolerant candidate (T2, genuine + ledgered) must ALSO abort the
//                        WHOLE lookup, never fall through to an OLDER, STALE tolerant candidate (T0, also
//                        genuine + ledgered) =====================
{
  const repo = makeRepo("tolerant-error-abort");
  const projId = `tltd-tea-proj-${Date.now()}`;
  const taskId = `tltd-tea-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-TEA", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // T0: the OLDER, genuine, HOOK-DISPLACED (tolerant-only) landing — same construction as PART E's own T2
  // (a trailing Signed-off-by paragraph after the Loom block) — ledgered.
  const cut0 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut0.worktreePath);
  const branch = cut0.branch;
  fs.writeFileSync(path.join(cut0.worktreePath, "t0.ts"), "export const t0 = 1;\n");
  commitAll(cut0.worktreePath, "feat(x): t0 change", GIT_ID);
  const preT0 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): t0 change\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`);
  const t0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, t0Tip, preT0);
  execFileSync("git", ["worktree", "remove", "--force", cut0.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(TOLERANT-ERROR-ABORT) setup: T0 is NOT strict-parseable but IS tolerant-parseable, and genuinely ledgered",
    parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t0Tip)) === null
    && tolerantFindLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t0Tip))?.branch === branch
    && ledger.rowsByTips([t0Tip]).length === 1);

  // T2: the SAME branch name re-cut, landed a SECOND time, same hook-displaced construction — genuinely
  // newer than T0, also ledgered.
  const cut2 = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut2.worktreePath);
  fs.writeFileSync(path.join(cut2.worktreePath, "t2.ts"), "export const t2 = 1;\n");
  commitAll(cut2.worktreePath, "feat(x): t2 change", GIT_ID);
  const preT2 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): t2 change\n\nLoom-Worker-Branch: ${branch}\n\nSigned-off-by: CI Bot <ci@example.com>`);
  const t2Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, t2Tip, preT2);
  execFileSync("git", ["worktree", "remove", "--force", cut2.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(TOLERANT-ERROR-ABORT) setup: T2 is likewise tolerant-only, genuinely newer than T0, and genuinely ledgered",
    parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t2Tip)) === null
    && tolerantFindLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", t2Tip))?.branch === branch
    && ledger.rowsByTips([t2Tip]).length === 1
    && git(repo, "merge-base", t0Tip, t2Tip) === t0Tip);

  // Fault-inject: the SAME technique as (ERROR-ABORT) — throw on the ledger's own pre-ledger boundary
  // `merge-base` call naming T2's own sha specifically; T0's identical check (different sha arg) passes
  // through untouched.
  function faultyGitFactory() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return {
        raw: (args) => {
          if (args[0] === "merge-base" && args[1] === t2Tip) {
            throw new Error("(TOLERANT-ERROR-ABORT) injected ledger pre-ledger-boundary failure");
          }
          return real.raw(args);
        },
      };
    };
  }

  // Faulty calls run FIRST (same caching caveat as ERROR-ABORT — classifyAgainstLedger's verdict cache is
  // process-global; a clean lookup for T2 first would cache "recorded" and the fault would never fire).
  const foundFaulty = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(TOLERANT-ERROR-ABORT) THE FIX (scenario D): T2's ledger error aborts the WHOLE lookup to null — never falls back to stale T0, even with NO strict candidate anywhere in the list", foundFaulty === null);

  const viaMapFaulty = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger, gitFactory: faultyGitFactory() });
  check("(TOLERANT-ERROR-ABORT) THE FIX, map path: same abort-to-null, never stale T0", viaMapFaulty.hit === true && viaMapFaulty.sha === null);

  const foundClean = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(TOLERANT-ERROR-ABORT) setup control: without the fault, the newer T2 resolves correctly (sanity for walk order)", foundClean === t2Tip);

  db.close();
}

// ===================== PART P (card c0d0eac9 round 5, finding 1, MAJOR, CR4's exact fixture; EXTENDED
//                        round 6, finding 1, CR5's own measured regression): (BASE-TRAILER-FORGED) — a
//                        candidate's own `Loom-Worker-Base` trailer is CANDIDATE-SUPPLIED data, parsed
//                        with no shape validation (`/^\S+$/`). A bogus value (e.g. "deadbeef") made
//                        `git diff <base>..<sha>` throw, which round 4 classified as a non-definitive
//                        "error" and aborted the WHOLE lookup — needing no forged STRICT commit at all: a
//                        newer TOLERANT-only commit naming the branch, with a bogus Base + a PathSet + a
//                        trailing Claude-Session paragraph, is enough — and that exact shape fits an
//                        honest human docs commit quoting a Loom block. Round 6 extends this with FOUR
//                        more Base shapes round 5's own fix (the `^{commit}` peel) still mishandled: an
//                        EXISTING blob, an EXISTING tree, an EXISTING tag (never peeled — this card
//                        accepts ONLY a raw commit object as a Base), and a 40-hex string that is ALSO a
//                        real ref name (the "ambiguous ref" shape) =====================
{
  const repo = makeRepo("base-trailer-forged");
  const projId = `tltd-btf-proj-${Date.now()}`;
  const taskId = `tltd-btf-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-BTF", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S0: the OLDER, genuine strict landing — real squash, ledgered, branch gone.
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "s0.ts"), "export const s0 = 1;\n");
  commitAll(cut.worktreePath, "feat(x): s0 change", GIT_ID);
  const preS0 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}`);
  const s0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s0Tip, preS0);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(BASE-TRAILER-FORGED) setup: S0 is genuinely ledgered", ledger.rowsByTips([s0Tip]).length === 1);

  // The NEWER, hand-authored, tolerant-shaped commit — never landed by Loom's own merge code, never
  // ledgered — naming the SAME branch, with a BOGUS Loom-Worker-Base ("deadbeef", 8 hex chars — too short
  // to be a real object id) + an arbitrary PathSet + a trailing Claude-Session paragraph (so it's
  // tolerant-only, not strict: the Loom block is NOT the message's own final paragraph).
  const tree = git(repo, "rev-parse", `${s0Tip}^{tree}`);
  const fakeMsg = `feat(x): innocuous docs commit\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: deadbeef\nLoom-Worker-PathSet: ${"a".repeat(64)}\n\nClaude-Session: https://claude.ai/code/session_fake`;
  const fakeSha = git(repo, "commit-tree", tree, "-p", s0Tip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(BASE-TRAILER-FORGED) setup control: the fake is genuinely newer, tolerant-parseable, never strict, and carries the bogus Base",
    parseLoomTrailerBlock(fakeMsg) === null && tolerantFindLoomTrailerBlock(fakeMsg)?.base === "deadbeef");

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(BASE-TRAILER-FORGED) THE FIX: a bogus Base trailer is a DEFINITIVE fail on the fake, never an abort — S0 still resolves", found === s0Tip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(BASE-TRAILER-FORGED) THE FIX, map path: S0 still resolves, never null", viaMap.hit === true && viaMap.sha === s0Tip);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(BASE-TRAILER-FORGED) THE FIX, getTaskMergedInfo: S0 still resolves end-to-end, never null", viaTask?.sha === s0Tip.slice(0, 7));

  // Round 6 (finding 1, CR5's own measured regression): round 5's `<id>^{commit}` peel is NOT
  // stderr-free — an EXISTING non-commit object (blob/tree) makes git print "expected commit type" and
  // exit 1, which simple-git throws on, wrongly classified "error" and aborting the whole lookup. Round 7
  // correction: an AMBIGUOUS 40-hex-string-that's-also-a-ref-name does NOT throw via the ambiguity itself
  // (an ambiguity alone exits 0 with a stderr WARNING only) — here it throws because git's ambiguity
  // precedence resolves it to the TREE object, which then fails the SAME "expected commit type" way as
  // the TREE sub-case above it. Each sub-case below plants a REAL, EXISTING object of the wrong shape as
  // the Base and re-checks all 3 readers still resolve S0, never abort to null.
  const blobSha = git(repo, "rev-parse", `${s0Tip}:s0.ts`);
  const treeSha = git(repo, "rev-parse", `${s0Tip}^{tree}`);
  git(repo, "tag", "-a", "-m", "tag msg", "btf-tag", s0Tip);
  const tagSha = git(repo, "rev-parse", "btf-tag");
  // Ambiguous-ref shape: a real tag literally NAMED after treeSha's own hex text, pointing at a DIFFERENT
  // object (s0Tip) — the string "treeSha" is now both a real object id AND a real ref name.
  git(repo, "tag", treeSha, s0Tip);

  const BASE_SUBCASES = [
    ["BLOB", blobSha],
    ["TREE", treeSha],
    ["TAG", tagSha],
    ["AMBIGUOUS-REF", treeSha], // same string as TREE's own sha — now also a tag name (planted above)
  ];
  for (const [label, baseValue] of BASE_SUBCASES) {
    const subMsg = `feat(x): innocuous docs commit (${label})\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: ${baseValue}\nLoom-Worker-PathSet: ${"a".repeat(64)}\n\nClaude-Session: https://claude.ai/code/session_fake_${label}`;
    const subSha = git(repo, "commit-tree", tree, "-p", s0Tip, "-m", subMsg);
    git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", subSha);
    check(`(BASE-TRAILER-FORGED ${label}) setup control: the fake carries this Base value`,
      tolerantFindLoomTrailerBlock(subMsg)?.base === baseValue);

    const subFound = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
    check(`(BASE-TRAILER-FORGED ${label}) THE FIX: a ${label}-shaped Base is a DEFINITIVE fail, never an abort — S0 still resolves`, subFound === s0Tip);

    const subViaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
    check(`(BASE-TRAILER-FORGED ${label}) THE FIX, map path: S0 still resolves, never null`, subViaMap.hit === true && subViaMap.sha === s0Tip);

    const subViaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
    check(`(BASE-TRAILER-FORGED ${label}) THE FIX, getTaskMergedInfo: S0 still resolves end-to-end, never null`, subViaTask?.sha === s0Tip.slice(0, 7));
  }

  db.close();
}

// ===================== PART Q (card c0d0eac9 round 5, finding 1): (BASE-TRAILER-INJECTION-SHAPE) — the
//                        SAME scenario as PART P, but with a Base value crafted to look like a git CLI
//                        flag (`--output=x`, never valid hex) — proving the shape check rejects it BEFORE
//                        it ever reaches a git argument at all (never merely "fails the same way"), by
//                        asserting no file named anything starting with the injected flag's own target
//                        appears anywhere under the repo afterward. This is the SAME call site a separate,
//                        pre-existing `--output=` argument-injection finding (reviewer 26278861, carded
//                        separately — NOT fixed here) also names; this card's shape validation closes it
//                        for THIS path as a side effect, without being the fix FOR that card =====================
{
  const repo = makeRepo("base-trailer-injection-shape");
  const projId = `tltd-btis-proj-${Date.now()}`;
  const taskId = `tltd-btis-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-BTIS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "s0.ts"), "export const s0 = 1;\n");
  commitAll(cut.worktreePath, "feat(x): s0 change", GIT_ID);
  const preS0 = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}`);
  const s0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s0Tip, preS0);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });

  const tree = git(repo, "rev-parse", `${s0Tip}^{tree}`);
  const INJECTION_TARGET = "injected-output-marker";
  const fakeMsg = `feat(x): innocuous docs commit\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: --output=${INJECTION_TARGET}\nLoom-Worker-PathSet: ${"a".repeat(64)}\n\nClaude-Session: https://claude.ai/code/session_fake`;
  const fakeSha = git(repo, "commit-tree", tree, "-p", s0Tip, "-m", fakeMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", fakeSha);
  check("(BASE-TRAILER-INJECTION-SHAPE) setup control: the fake carries the flag-shaped Base value",
    tolerantFindLoomTrailerBlock(fakeMsg)?.base === `--output=${INJECTION_TARGET}`);

  // Before: confirm the repo tree genuinely has no file matching the injection target yet (a positive
  // control for the listing-based assertion below — an always-empty listing would be meaningless).
  const beforeListing = fs.readdirSync(repo);
  check("(BASE-TRAILER-INJECTION-SHAPE) setup control: no file matching the injection target exists yet",
    !beforeListing.some((name) => name.includes(INJECTION_TARGET)));

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(BASE-TRAILER-INJECTION-SHAPE) THE FIX: still resolves S0, never null", found === s0Tip);

  const afterListing = fs.readdirSync(repo);
  check("(BASE-TRAILER-INJECTION-SHAPE) THE FIX: the shape check rejects the flag-shaped Base BEFORE it ever reaches a git argument — no file matching the injection target was written anywhere in the repo",
    !afterListing.some((name) => name.includes(INJECTION_TARGET)));

  db.close();
}

// ===================== PART R (card c0d0eac9 round 5, CR4's reasoned point): (ORPHAN-NO-COMMON-ANCESTOR)
//                        — `git merge-base` between a candidate and a LIVE branch with NO common ancestor
//                        exits 1 with empty output and (empirically, via simple-git) never throws at all.
//                        Pre-fix, this empty mergeBase flowed into branchContentLandedInCommit's own FIRST
//                        diff call (`${mergeBase}..${branchRef}`), which ALSO resolves empty for a
//                        completely-unrelated range — triggering that function's "branch has no changes
//                        of its own" vacuous-pass shortcut and WRONGLY reporting the disconnected orphan
//                        candidate as landed. This is a worse-than-abort false ACCEPT, not merely a
//                        below-floor null — the fix must treat "no common ancestor" as a DEFINITIVE fail
//                        before ever reaching the content check =====================
{
  const repo = makeRepo("orphan-no-common-ancestor");
  const projId = `tltd-onca-proj-${Date.now()}`;
  const taskId = `tltd-onca-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-ONCA", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // The branch: cut from main's CURRENT tip, present but with ZERO commits of its own (deliberately —
  // see below). branchPresent is true for the rest of this test.
  //
  // Deliberately NO commit on top of the cut: `branchContentLandedInCommit`'s FIRST diff call
  // (`${mergeBase}..${branchRef}`) with an EMPTY mergeBase was measured (real git, including with a
  // DIRTY working tree to rule out the on-disk-files theory — see the decision record's round-6
  // correction) to diff against the repo's own HEAD, not an empty tree and not the working tree — so it
  // only reproduces the vacuous "no changes, pass" shortcut when the branch's own tree happens to be
  // IDENTICAL to HEAD's. A branch with real unmerged work (a different tree) instead hits a DEFINITIVE
  // mismatch on the function's own SECOND diff call regardless of this card's fix, never exercising the
  // shape this scenario is actually about.
  const mainTipBeforeOrphan = git(repo, "rev-parse", "HEAD");
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  check("(ORPHAN-NO-COMMON-ANCESTOR) setup: branch is genuinely present", git(repo, "branch", "--list", branch) !== "");
  check("(ORPHAN-NO-COMMON-ANCESTOR) setup control: the branch's tree is genuinely identical to HEAD's own tree (no changes of its own)",
    git(repo, "rev-parse", `refs/heads/${branch}^{tree}`) === git(repo, "rev-parse", `${mainTipBeforeOrphan}^{tree}`));

  // A PARENTLESS (true root, via commit-tree with NO -p) commit carrying the branch's own trailer — it
  // shares NO history with ANYTHING in this repo, including main's pre-orphan tip and the live branch.
  const orphanTip = git(repo, "commit-tree", git(repo, "rev-parse", `${mainTipBeforeOrphan}^{tree}`), "-m", `feat(x): orphan\n\nLoom-Worker-Branch: ${branch}`);
  // Merge it into main as a real SECOND-parent merge, so the scan (which walks HEAD's own history) can
  // discover it — but the LIVE branch was cut BEFORE this merge and never crosses it, so merge-base(orphanTip,
  // refs/heads/<branch>) has genuinely nothing in common.
  const mergeSha = git(repo, "commit-tree", git(repo, "rev-parse", `${mainTipBeforeOrphan}^{tree}`), "-p", mainTipBeforeOrphan, "-p", orphanTip, "-m", "merge(x): bring in an unrelated history");
  git(repo, "update-ref", "-m", "merge", "refs/heads/main", mergeSha);
  // The test's own `git()` helper is execFileSync-based, which THROWS on merge-base's exit 1 (unlike
  // simple-git's own raw(), which empirically resolves this exact shape without throwing at all — see the
  // decision record) — catch it here rather than crash the test script itself.
  let noCommonAncestor = false;
  try {
    execFileSync("git", ["merge-base", orphanTip, `refs/heads/${branch}`], { cwd: repo, encoding: "utf8" });
  } catch (e) {
    noCommonAncestor = e.status === 1 && !e.stdout && !e.stderr;
  }
  check("(ORPHAN-NO-COMMON-ANCESTOR) setup control: orphanTip and the live branch genuinely share NO common ancestor (exit 1, empty output)", noCommonAncestor);
  check("(ORPHAN-NO-COMMON-ANCESTOR) setup control: the orphan commit strict-parses and is reachable from HEAD",
    parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", orphanTip))?.branch === branch);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(ORPHAN-NO-COMMON-ANCESTOR) THE FIX: a disconnected orphan candidate is a DEFINITIVE fail, never a false accept — null, never orphanTip", found === null);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(ORPHAN-NO-COMMON-ANCESTOR) THE FIX, map path: same — null, never a false accept", viaMap.hit === true && viaMap.sha === null);

  db.close();
}

// ===================== PART S (card c0d0eac9 round 6, finding 2, MAJOR): (PARENTLESS-NO-BASE) — the
//                        no-Base path's `rev-parse ${sha}^` throws "fatal: ambiguous argument ... unknown
//                        revision" for a PARENTLESS (root) candidate commit — a real, reachable shape: a
//                        tolerant-only candidate (a PathSet, but NO Loom-Worker-Base trailer) merged onto
//                        main as a second parent via an unrelated-history merge, newer in log order than
//                        a genuine older strict landing. Pre-fix this throws, is classified "error", and
//                        aborts the WHOLE lookup to null even though S0 genuinely resolves =====================
{
  const repo = makeRepo("parentless-no-base");
  const projId = `tltd-pnb-proj-${Date.now()}`;
  const taskId = `tltd-pnb-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-PNB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");

  // S0: the OLDER, genuine strict landing — real squash, ledgered, branch gone.
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "s0.ts"), "export const s0 = 1;\n");
  commitAll(cut.worktreePath, "feat(x): s0 change", GIT_ID);
  const preS0 = git(repo, "rev-parse", "HEAD");
  const mainTipBeforeOrphan = preS0;
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): s0 change\n\nLoom-Worker-Branch: ${branch}`);
  const s0Tip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, s0Tip, preS0);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(PARENTLESS-NO-BASE) setup: S0 is genuinely ledgered", ledger.rowsByTips([s0Tip]).length === 1);

  // Card c0d0eac9 round 7 (finding 1): with EQUAL committer dates, `git log`'s default order breaks the
  // tie by parent order (S0, the first parent of mergeSha below, is listed before the candidate) — so the
  // walk would resolve S0 directly and never even TRY the candidate, passing vacuously regardless of the
  // fix. Pin the candidate's own date strictly AFTER S0's so it genuinely sorts first, on any clock.
  const s0Epoch = parseInt(git(repo, "show", "-s", "--format=%ct", s0Tip), 10);
  const parentlessDate = `${s0Epoch + 5} +0000`;

  // A PARENTLESS (true root, via commit-tree with NO -p) tolerant-only candidate — carries a PathSet
  // trailer but deliberately NO Loom-Worker-Base, so verifyPersistedPathSet takes the no-override branch
  // and tries `rev-parse <sha>^` on a commit that genuinely has no parent at all.
  const parentlessMsg = `feat(x): innocuous docs commit\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-PathSet: ${"a".repeat(64)}\n\nClaude-Session: https://claude.ai/code/session_fake`;
  const parentlessSha = execFileSync("git", ["commit-tree", git(repo, "rev-parse", `${mainTipBeforeOrphan}^{tree}`), "-m", parentlessMsg], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, ...IDENT, GIT_AUTHOR_DATE: parentlessDate, GIT_COMMITTER_DATE: parentlessDate },
  }).trim();
  check("(PARENTLESS-NO-BASE) setup control: the candidate genuinely has no parent",
    git(repo, "rev-list", "--parents", "-n1", parentlessSha).trim().split(/\s+/).filter(Boolean).length === 1);
  // Merge it into main via a real second-parent merge, so it's reachable from HEAD and NEWER in log order
  // than S0 (which already landed before this merge happens).
  const mergeSha = git(repo, "commit-tree", git(repo, "rev-parse", `${mainTipBeforeOrphan}^{tree}`), "-p", s0Tip, "-p", parentlessSha, "-m", "merge(x): bring in an unrelated history");
  git(repo, "update-ref", "-m", "merge", "refs/heads/main", mergeSha);
  const logOrder = git(repo, "log", "--format=%H", "HEAD").split("\n");
  check("(PARENTLESS-NO-BASE) setup control: log order lists the candidate BEFORE S0 (committer-date pinned, not a tie)",
    logOrder.indexOf(parentlessSha) !== -1 && logOrder.indexOf(s0Tip) !== -1 && logOrder.indexOf(parentlessSha) < logOrder.indexOf(s0Tip));
  check("(PARENTLESS-NO-BASE) setup control: the candidate is tolerant-only, carries a PathSet but no Base",
    parseLoomTrailerBlock(parentlessMsg) === null
    && tolerantFindLoomTrailerBlock(parentlessMsg)?.branch === branch
    && tolerantFindLoomTrailerBlock(parentlessMsg)?.base === null
    && tolerantFindLoomTrailerBlock(parentlessMsg)?.pathSet !== null);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(PARENTLESS-NO-BASE) THE FIX: a parentless candidate's own no-parent shape is a DEFINITIVE fail, never an abort — S0 still resolves", found === s0Tip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(PARENTLESS-NO-BASE) THE FIX, map path: S0 still resolves, never null", viaMap.hit === true && viaMap.sha === s0Tip);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(PARENTLESS-NO-BASE) THE FIX, getTaskMergedInfo: S0 still resolves end-to-end, never null", viaTask?.sha === s0Tip.slice(0, 7));

  db.close();
}

// ===================== PART T (card c0d0eac9 round 6): (GENUINE-PASS-THROUGH-DASH-C) — a genuine
//                        candidate, with a REAL self-consistent Base+PathSet pair, must still resolve
//                        PASS through the real reader's two `-c`-prefixed calls — not silently throw.
//                        =====================
// @decision c0d0eac9 round 6 — a `-c key=val` prefix on a gated key throws regardless of intent;
// confirm the specific key is ungated before trusting it to pass through silently.
{
  const repo = makeRepo("genuine-pass-through-dash-c");
  const projId = `tltd-gpdc-proj-${Date.now()}`;
  const taskId = `tltd-gpdc-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-GPDC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");
  const sg = simpleGit(repo);

  // A single genuine strict landing, ledgered, branch gone, with a REAL, self-consistent Base + PathSet
  // trailer pair — the ONLY candidate in this repo's history, so there is no older fallback to mask a
  // silently-broken `-c` call: if either `-c`-prefixed check throws on this genuinely well-formed input,
  // this candidate fails and the lookup returns null, never the genuine sha.
  const cut = await createWorktree(repo, projId, taskId);
  registerForCleanup(cut.worktreePath);
  const branch = cut.branch;
  fs.writeFileSync(path.join(cut.worktreePath, "only.ts"), "export const only = 1;\n");
  commitAll(cut.worktreePath, "feat(x): only change", GIT_ID);
  const preOnly = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-m", `feat(x): only change\n\nLoom-Worker-Branch: ${branch}`);
  const pathSetDigest = await changedPathSetDigest(sg, preOnly, git(repo, "rev-parse", "HEAD"));
  git(repo, "commit", "--amend", "-m", `feat(x): only change\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: ${preOnly}\nLoom-Worker-PathSet: ${pathSetDigest}`);
  const onlyTip = git(repo, "rev-parse", "HEAD");
  db.recordMainlineLandedCommit(projId, "primary", branch, onlyTip, preOnly);
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(GENUINE-PASS-THROUGH-DASH-C) setup: the ONLY candidate is genuinely ledgered with a real, self-consistent Base+PathSet pair",
    ledger.rowsByTips([onlyTip]).length === 1 && parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", onlyTip))?.pathSet === pathSetDigest);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(GENUINE-PASS-THROUGH-DASH-C) THE PROOF: the `-c`-prefixed calls do NOT silently throw on genuine input — the ONLY candidate resolves PASS, never null", found === onlyTip);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(GENUINE-PASS-THROUGH-DASH-C) THE PROOF, map path: resolves PASS, never null", viaMap.hit === true && viaMap.sha === onlyTip);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(GENUINE-PASS-THROUGH-DASH-C) THE PROOF, getTaskMergedInfo: resolves PASS end-to-end via the \"pathset\" verification mode specifically",
    viaTask?.sha === onlyTip.slice(0, 7) && viaTask?.verification === "pathset");

  db.close();
}

// ===================== PART U (card c0d0eac9 round 7, finding 2): (REF-NAME-BASE-SHAPE) — a
//                        ref-name-shaped Loom-Worker-Base (41-64 hex, never a valid SHA-1 object-id
//                        shape) must be rejected as a definitive fail, never accepted as if its resolved
//                        TARGET were the candidate's own claimed sha.
//                        =====================
// @decision c0d0eac9 round 7 (finding 2) — this closes the ref-name identity mismatch and the
// three-way re-resolution race ONLY; it does not close end-to-end forgery acceptance at a zero-row
// ledger on a tolerant-only branch, which stays open by design (decision 756a2cd8).
{
  const repo = makeRepo("ref-name-base");
  const projId = `tltd-rnb-proj-${Date.now()}`;
  const taskId = `tltd-rnb-task-${Date.now()}`;
  const db = new Db();
  db.insertProject({ id: projId, name: "TLTD-RNB", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const ledger = db.getGoneBranchLedgerFacts(projId, "primary");
  check("(REF-NAME-BASE-SHAPE) setup: the ledger genuinely has ZERO rows (maxRowId null, boundary null)",
    ledger.maxRowId() === null && ledger.resolveBoundary() === null);

  // A branch name, never actually landed — this scenario needs no genuine landing at all; the forgery
  // below is the ONLY candidate findLandedSquashCommit will ever see for it. createWorktree is used only
  // to get the SAME deterministic branch name getTaskMergedInfo will derive from taskId.
  const cut = await createWorktree(repo, projId, taskId);
  const branch = cut.branch;
  execFileSync("git", ["worktree", "remove", "--force", cut.worktreePath], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
  check("(REF-NAME-BASE-SHAPE) setup control: the branch is genuinely gone", git(repo, "branch", "--list", branch) === "");

  const baseTip = git(repo, "rev-parse", "HEAD");
  // A 50-hex-char string — too long to be a SHA-1 object id, so git resolves it ONLY as a REF NAME. Plant
  // a real tag with exactly this literal text, pointing at baseTip (the attacker-controlled stand-in for
  // a raw commit sha a genuine Loom-Worker-Base trailer would carry).
  const refNameHex = "3".repeat(50);
  git(repo, "tag", refNameHex, baseTip);
  check("(REF-NAME-BASE-SHAPE) setup control: refNameHex resolves (via the planted ref) to baseTip, proving it is NOT itself a raw object id",
    git(repo, "rev-parse", "--verify", "--quiet", `${refNameHex}^{object}`) === baseTip && refNameHex !== baseTip);

  // Build the candidate's real tree (one genuine file change over baseTip) and compute its TRUE PathSet
  // digest via the SAME production function the real writer uses — not a decoy digest; it is what a
  // genuine landing of this exact diff would stamp.
  const sg = simpleGit(repo);
  fs.writeFileSync(path.join(repo, "rnb.ts"), "export const rnb = 1;\n");
  commitAll(repo, "feat(x): rnb content (tree donor only — main is reset away from this below)", GIT_ID);
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const treeDonorSha = git(repo, "rev-parse", "HEAD");
  const expectedDigest = await changedPathSetDigest(sg, baseTip, treeDonorSha);
  execFileSync("git", ["update-ref", "refs/heads/main", baseTip], { cwd: repo });

  // The forged, NEVER-LANDED, tolerant-only candidate: Loom-Worker-Base is the REF-NAME text (never a raw
  // object id), paired with the genuinely-matching PathSet digest above.
  const forgedMsg = `feat(x): innocuous docs commit\n\nLoom-Worker-Branch: ${branch}\nLoom-Worker-Base: ${refNameHex}\nLoom-Worker-PathSet: ${expectedDigest}\n\nSigned-off-by: CI Bot <ci@example.com>`;
  const forgedSha = git(repo, "commit-tree", tree, "-p", baseTip, "-m", forgedMsg);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forgedSha);
  check("(REF-NAME-BASE-SHAPE) setup control: the candidate is tolerant-only, carries the ref-name-shaped Base and the genuinely-matching PathSet",
    parseLoomTrailerBlock(forgedMsg) === null
    && tolerantFindLoomTrailerBlock(forgedMsg)?.branch === branch
    && tolerantFindLoomTrailerBlock(forgedMsg)?.base === refNameHex
    && tolerantFindLoomTrailerBlock(forgedMsg)?.pathSet === expectedDigest);

  const found = await findLandedSquashCommit(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REF-NAME-BASE-SHAPE) THE FIX: a ref-name-shaped Base is a DEFINITIVE fail, never accepted as a real landing — null, never the forged sha", found === null);

  const viaMap = await findLandedSquashCommitViaMap(repo, branch, "HEAD", { goneBranchLedger: ledger });
  check("(REF-NAME-BASE-SHAPE) THE FIX, map path: same — never a false accept", viaMap.hit === true && viaMap.sha === null);

  const viaTask = await getTaskMergedInfo(repo, taskId, { goneBranchLedger: ledger });
  check("(REF-NAME-BASE-SHAPE) THE FIX, getTaskMergedInfo: same — never a false accept", viaTask === null);

  db.close();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
