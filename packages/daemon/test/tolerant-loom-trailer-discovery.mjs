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
// Run: 1) build daemon (pnpm build), 2) node test/tolerant-loom-trailer-discovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-tltd-home-");

const { Db } = await import("../dist/db.js");
const { createWorktree, findLandedSquashCommit, tolerantFindLoomTrailerBlock, verifyLoomTrailersExactAndReadable, parseLoomTrailerBlock } = await import("../dist/git/worktrees.js");

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
