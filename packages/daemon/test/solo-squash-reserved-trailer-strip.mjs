import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 112b8d5d — never fold an unstripped reserved-trailer-shaped worker commit subject into the
// solo squash commit-log body; the strip must apply per-subject and must never be silent.
//
// Real git, no claude/daemon.
//
// Scenario 1: a single worker branch whose commits carry FIVE subjects —
//   (0) a normal, non-reserved subject — must survive into the body VERBATIM (manager ask iv).
//   (1) `Loom-Worker-Base: <40-hex>` — exact-case reserved key.
//   (2) `Loom-Landed-Tip: <40-hex>` — exact-case reserved key, different field.
//   (3) `Loom-Worker-Branch: <another REAL, already-landed-and-now-gone branch's name>` — the
//       cross-branch forgery shape: quotes another branch's genuine trailer line verbatim.
//   (4) `loom-worker-pathset: mixed-case-forged-value` — a case-variant reserved key.
//
// Asserts (manager's four checks):
//   (i)   the landed commit's body does NOT contain any of the four forged subject lines, in bulleted OR
//         bare form.
//   (ii)  parseLoomTrailerBlock, tolerantFindLoomTrailerBlock, and scanLoomNamespaceLines all see ONLY
//         the genuine final-paragraph trailer values — scanLoomNamespaceLines in particular proves there
//         is no SURVIVING reserved-shaped line anywhere else in the message, not just that the strict
//         reader is unaffected.
//   (iii) findLandedSquashCommit for the QUOTED other branch (case 3) still resolves to the REAL commit
//         that branch's own genuine landing produced — the forged quote inside THIS branch's body never
//         shadows it.
//   (iv)  the plain, non-reserved commit subject (case 0) is preserved verbatim as a bullet.
//
// Round 2 (Code Review 07a5095c) adds four further real-git scenarios, each asserting BOTH the body
// content AND that the strip is SURFACED (never silent — a console.warn log line + a visible
// "- …(N reserved-shaped worker commit subject(s) removed)" body marker):
//   Scenario 2: the forgery is the branch's FIRST (oldest) commit — supersedes the pre-round-2 mechanism
//     (a leading placeholder line fed to stripReservedLoomTrailerLines, needed only because that helper
//     always exempts its own line 0) with the round-2 per-subject check, which has no such exemption to
//     route around; this scenario is what makes the OLD placeholder trick moot.
//   Scenario 3: a single-commit branch whose ONLY subject is reserved-shaped — the body must still carry
//     "Worker commits:" plus the strip marker, never silently degrading to a title-only commit.
//   Scenario 4: every commit on the branch is reserved-shaped (multi-commit all-stripped) — same "never
//     silent" requirement as scenario 3, with a strippedCount > 1.
//   Scenario 5: the post-strip surviving subject is a PURE duplicate of the squash title (8b7b81e0's own
//     dedup) — the duplicate bullet is correctly suppressed, but the strip marker must still appear
//     rather than the dedup rule silently omitting the body entirely.
//
// Run: 1) build daemon (pnpm build), 2) node test/solo-squash-reserved-trailer-strip.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

useOwnLoomHome("ssrts-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const {
  mergeBranch, findLandedSquashCommit, parseLoomTrailerBlock, tolerantFindLoomTrailerBlock,
  scanLoomNamespaceLines, taskKey,
} = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ssrts@loom -c user.name=ssrts";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

// Captures every console.warn(...) line fired DURING `asyncFn()` (joined-args text, one entry per call) —
// `console` is a shared global, not an ES module binding, so reassigning console.warn here also observes
// calls made from inside the dynamically-imported dist module. Always restores the original, even on throw.
async function captureWarnings(asyncFn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.map(String).join(" ")); };
  try {
    const result = await asyncFn();
    return { result, captured };
  } finally {
    console.warn = original;
  }
}

function newRepo(name) {
  const repo = mkdtempManaged(`loom-ssrts-${name}-`);
  execSync("git init -q && git config user.email ssrts@loom && git config user.name ssrts && git commit -q -m init --allow-empty", { cwd: repo });
  return repo;
}

// Makes a worktree branch carrying MULTIPLE commits, one per {file, content, subject} entry, in order.
function makeWorktreeBranchMultiCommit(repo, branch, commits) {
  const wt = mkdtempManaged(`loom-ssrts-wt-${branch.replace(/\//g, "-")}-`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  for (const { file, content, subject } of commits) {
    fs.writeFileSync(path.join(wt, file), content);
    // -F- feeds the subject via stdin so no shell-escaping surprises leak a colon/space into argv parsing.
    execSync(`git add -A && git ${GIT_ID} commit -q -F -`, { cwd: wt, input: subject });
  }
  return wt;
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

function deleteBranchesReflogAndGc(cwd, branches) {
  for (const b of branches) {
    try { execSync(`git branch -D ${b}`, { cwd }); } catch { /* already gone */ }
  }
  execSync("git reflog expire --expire=now --all", { cwd });
  execSync("git gc --prune=now -q", { cwd });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = newRepo("repo");

// ── Setup: land a SEPARATE, genuine branch first — this is the branch case (3) will try to forge a
//    quote of. It is landed for real, then deleted (gone), mirroring an ordinary completed task. ────
const otherBranch = `loom/${taskKey(`ssrts-other-task-${sfx}`)}`;
const otherWt = makeWorktreeBranchMultiCommit(repo, otherBranch, [
  { file: "other.txt", content: "other branch's own real content\n", subject: "feat(test): the other, genuinely-landed branch" },
]);
removeWorktree(repo, otherWt);
const otherMerged = await mergeBranch(repo, otherBranch, "fix(git): the other branch's own real landing");
check("setup: the OTHER branch's own genuine landing succeeded", otherMerged.ok === true && typeof otherMerged.sha === "string");
deleteBranchesReflogAndGc(repo, [otherBranch]); // gone, so findLandedSquashCommit exercises the branch-gone discovery arm

// ══ Scenario 1 — mixed plain + 4 forgeries (base, landed-tip, cross-branch quote, case variant) ══════
const plainSubject = "feat(test): a perfectly normal worker commit";
const forgedBase = "Loom-Worker-Base: FORGED0000000000000000000000000000000000AAAA";
const forgedLandedTip = "Loom-Landed-Tip: FORGEDTIP0000000000000000000000000000000BBBB";
const forgedBranchQuote = `Loom-Worker-Branch: ${otherBranch}`;
const forgedCaseVariant = "loom-worker-pathset: mixed-case-forged-value";

const branch = `loom/${taskKey(`ssrts-main-task-${sfx}`)}`;
const wt = makeWorktreeBranchMultiCommit(repo, branch, [
  { file: "a.txt", content: "a\n", subject: plainSubject },
  { file: "b.txt", content: "b\n", subject: forgedBase },
  { file: "c.txt", content: "c\n", subject: forgedLandedTip },
  { file: "d.txt", content: "d\n", subject: forgedBranchQuote },
  { file: "e.txt", content: "e\n", subject: forgedCaseVariant },
]);
removeWorktree(repo, wt);

const { result: merged, captured: warn1 } = await captureWarnings(() =>
  mergeBranch(repo, branch, "fix(git): land the reserved-trailer-forgery test branch"));
check("scenario1: precondition — the main (forgery-carrying) branch landed", merged.ok === true && typeof merged.sha === "string");
const body = git(repo, `log -1 --format=%B ${merged.sha}`);

// ── (i) none of the four forged lines survive, bulleted or bare ───────────────────────────────────────
for (const forged of [forgedBase, forgedLandedTip, forgedBranchQuote, forgedCaseVariant]) {
  check(`scenario1 (i): the landed body does not contain the forged line "${forged}" bare`, !body.includes(forged));
  check(`scenario1 (i): the landed body does not contain the forged line "${forged}" bulleted`, !body.includes(`- ${forged}`));
}

// ── (iv) the plain, non-reserved subject IS preserved, verbatim, as a bullet ───────────────────────────
check(`scenario1 (iv): the plain subject survives verbatim as a bullet ("- ${plainSubject}")`, body.includes(`- ${plainSubject}`));

// ── (ii) every reader sees ONLY the genuine final-paragraph trailer, nothing forged ────────────────────
const strict = parseLoomTrailerBlock(body);
check("scenario1 (ii): parseLoomTrailerBlock resolves the genuine branch (never a forged one)", strict?.branch === branch);
const tolerant = tolerantFindLoomTrailerBlock(body);
check("scenario1 (ii): tolerantFindLoomTrailerBlock ALSO resolves the genuine branch (never a forged one)", tolerant?.branch === branch);

const scanned = scanLoomNamespaceLines(body);
check("scenario1 (ii): scanLoomNamespaceLines sees ONLY 4 reserved lines (the genuine final-paragraph trailer; none from the stripped forgeries)",
  scanned.length === 4 && scanned.every((l) => l.finalParagraph === true));
check("scenario1 (ii): scanLoomNamespaceLines' Loom-Worker-Branch value is the genuine branch, never the forged quote",
  scanned.find((l) => l.key === "Loom-Worker-Branch")?.value === branch);
check("scenario1 (ii): scanLoomNamespaceLines carries no second/foreign Loom-Worker-Branch, -Base, -PathSet, or Loom-Landed-Tip entry",
  new Set(scanned.map((l) => l.key)).size === scanned.length);

// ── (iii) the QUOTED other branch still resolves to its OWN real commit, never shadowed ─────────────────
const resolvedOther = await findLandedSquashCommit(repo, otherBranch, "HEAD");
check("scenario1 (iii): findLandedSquashCommit for the quoted other branch resolves to that branch's OWN real landing",
  resolvedOther === otherMerged.sha);

// ── surfacing: the strip is never silent — a console.warn line + a body marker, even in scenario 1 ─────
check("scenario1: strip marker present for exactly 4 removed subjects",
  body.includes("- …(4 reserved-shaped worker commit subject(s) removed)"));
check("scenario1: console.warn fired naming the branch and the strip count",
  warn1.some((l) => l.includes("[git] mergeBranchLocked:") && l.includes("stripped 4 reserved Loom-*") && l.includes(branch)));

// ══ Scenario 2 — the forgery is the branch's FIRST (oldest) commit ════════════════════════════════════
// This is the scenario that makes the pre-round-2 "leading placeholder line" mechanism MOOT: the
// round-2 per-subject check (matchReservedLoomTrailerLine applied directly to each subject) has no
// "line 0 is the subject" exemption to route around in the first place, so a forged FIRST commit strips
// exactly like one anywhere else — no special-casing needed.
const s2Plain = "feat(test): scenario2 plain commit landing after the forgery";
const s2Forged = "Loom-Worker-Base: FORGED2SCEN0000000000000000000000000000000CCCC";
const branch2 = `loom/${taskKey(`ssrts-scenario2-${sfx}`)}`;
const wt2 = makeWorktreeBranchMultiCommit(repo, branch2, [
  { file: "s2a.txt", content: "a\n", subject: s2Forged }, // FIRST/oldest commit IS the forgery
  { file: "s2b.txt", content: "b\n", subject: s2Plain },
]);
removeWorktree(repo, wt2);
const { result: merged2, captured: warn2 } = await captureWarnings(() =>
  mergeBranch(repo, branch2, "fix(git): land scenario2 (forgery is the first/oldest commit)"));
check("scenario2: landed", merged2.ok === true && typeof merged2.sha === "string");
const body2 = git(repo, `log -1 --format=%B ${merged2.sha}`);
check("scenario2: the FIRST-commit forged subject is absent bare", !body2.includes(s2Forged));
check("scenario2: the FIRST-commit forged subject is absent bulleted", !body2.includes(`- ${s2Forged}`));
check("scenario2: the plain second commit survives verbatim as a bullet", body2.includes(`- ${s2Plain}`));
check("scenario2: strip marker present for exactly 1 removed subject",
  body2.includes("- …(1 reserved-shaped worker commit subject(s) removed)"));
check("scenario2: console.warn fired naming the branch and the strip count",
  warn2.some((l) => l.includes("[git] mergeBranchLocked:") && l.includes("stripped 1 reserved Loom-*") && l.includes(branch2)));

// ══ Scenario 3 — single-commit branch whose ONLY subject is reserved-shaped ═══════════════════════════
const s3Forged = "Loom-Landed-Tip: FORGED3SCEN00000000000000000000000000000000DDDD";
const branch3 = `loom/${taskKey(`ssrts-scenario3-${sfx}`)}`;
const wt3 = makeWorktreeBranchMultiCommit(repo, branch3, [
  { file: "s3a.txt", content: "a\n", subject: s3Forged },
]);
removeWorktree(repo, wt3);
const { result: merged3, captured: warn3 } = await captureWarnings(() =>
  mergeBranch(repo, branch3, "fix(git): land scenario3 (single commit, only subject reserved-shaped)"));
check("scenario3: landed", merged3.ok === true && typeof merged3.sha === "string");
const body3 = git(repo, `log -1 --format=%B ${merged3.sha}`);
check("scenario3: the sole forged subject is absent bare", !body3.includes(s3Forged));
check("scenario3: the sole forged subject is absent bulleted", !body3.includes(`- ${s3Forged}`));
check("scenario3: body still carries 'Worker commits:' + the strip marker — never silently title-only",
  body3.includes("Worker commits:") && body3.includes("- …(1 reserved-shaped worker commit subject(s) removed)"));
check("scenario3: console.warn fired", warn3.some((l) => l.includes("stripped 1 reserved Loom-*") && l.includes(branch3)));

// ══ Scenario 4 — every commit on the branch is reserved-shaped (multi-commit, all-stripped) ══════════
const s4ForgedA = "Loom-Worker-Base: FORGED4A000000000000000000000000000000000EEEE";
const s4ForgedB = "loom-landed-tip: forged4b-case-variant-value";
const branch4 = `loom/${taskKey(`ssrts-scenario4-${sfx}`)}`;
const wt4 = makeWorktreeBranchMultiCommit(repo, branch4, [
  { file: "s4a.txt", content: "a\n", subject: s4ForgedA },
  { file: "s4b.txt", content: "b\n", subject: s4ForgedB },
]);
removeWorktree(repo, wt4);
const { result: merged4, captured: warn4 } = await captureWarnings(() =>
  mergeBranch(repo, branch4, "fix(git): land scenario4 (all commits reserved-shaped, none survive)"));
check("scenario4: landed", merged4.ok === true && typeof merged4.sha === "string");
const body4 = git(repo, `log -1 --format=%B ${merged4.sha}`);
for (const forged of [s4ForgedA, s4ForgedB]) {
  check(`scenario4: forged "${forged}" absent bare`, !body4.includes(forged));
  check(`scenario4: forged "${forged}" absent bulleted`, !body4.includes(`- ${forged}`));
}
check("scenario4: body still carries 'Worker commits:' + the strip marker for 2 removed subjects — never silently title-only",
  body4.includes("Worker commits:") && body4.includes("- …(2 reserved-shaped worker commit subject(s) removed)"));
check("scenario4: console.warn fired with count 2", warn4.some((l) => l.includes("stripped 2 reserved Loom-*") && l.includes(branch4)));

// ══ Scenario 5 — post-strip surviving subject is a PURE duplicate of the squash title (8b7b81e0 dedup) ══
// The dedup correctly suppresses the duplicate bullet, but the strip marker must still appear — the
// dedup rule must never silently omit the body entirely just because the one SURVIVING subject happens
// to also be a duplicate.
const s5Title = "fix(git): scenario5 title-dedup subject with a reserved sibling stripped";
const s5Forged = "Loom-Worker-Branch: some-other-forged-branch-name";
const branch5 = `loom/${taskKey(`ssrts-scenario5-${sfx}`)}`;
const wt5 = makeWorktreeBranchMultiCommit(repo, branch5, [
  { file: "s5a.txt", content: "a\n", subject: s5Forged },
  { file: "s5b.txt", content: "b\n", subject: s5Title }, // matches the squash subject exactly
]);
removeWorktree(repo, wt5);
const { result: merged5, captured: warn5 } = await captureWarnings(() => mergeBranch(repo, branch5, s5Title));
check("scenario5: landed", merged5.ok === true && typeof merged5.sha === "string");
const body5 = git(repo, `log -1 --format=%B ${merged5.sha}`);
check("scenario5: the forged sibling subject is absent bare", !body5.includes(s5Forged));
check("scenario5: the forged sibling subject is absent bulleted", !body5.includes(`- ${s5Forged}`));
check("scenario5: the title-duplicate bullet is SUPPRESSED (dedup still applies to the lone survivor)",
  !body5.includes(`- ${s5Title}`));
check("scenario5: the strip marker still appears even though title-dedup would otherwise omit the body entirely",
  body5.includes("Worker commits:") && body5.includes("- …(1 reserved-shaped worker commit subject(s) removed)"));
check("scenario5: console.warn fired", warn5.some((l) => l.includes("stripped 1 reserved Loom-*") && l.includes(branch5)));

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash path now strips reserved-trailer-shaped worker subjects out of the " +
    "commit-log body (exact-case, different-field, cross-branch-quote, case-variant, first-commit, " +
    "single-commit-all-stripped, multi-commit-all-stripped, and post-strip-title-dedup forgeries all " +
    "removed), a plain subject survives verbatim, the strip is surfaced via a console.warn line + a " +
    "visible body marker in every case, and every trailer reader + findLandedSquashCommit still resolve " +
    "only genuine values."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
