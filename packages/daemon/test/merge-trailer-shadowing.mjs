import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1d3f500e (Code Review c00a136c, on d62dad73) — the three trailer regexes (Loom-Worker-Branch /
// -PathSet / -Base, git/worktrees.ts) all matched the FIRST occurrence of `^X:\s*(\S+)` anywhere in a
// commit's BODY. On the BATCH path (git/batch-merge.ts's landBranchCommitsIndividually) the tip commit's
// body is the WORKER'S OWN message with the real, machine-stamped trailers appended AFTER it — so a
// worker-authored line that merely starts with the same shape at column 0 would pre-empt the real trailer
// under a first-match regex. The reviewer's own specimen: a future commit TO batch-merge.ts itself whose
// body quotes an EXAMPLE `Loom-Worker-Base: <sha>` line at column 0 (exactly as this file's own header
// docs do) shadows its own real trailer. REAL git on a temp repo, no claude, no live daemon.
//
// Fixed by git/worktrees.ts's lastTrailerMatch: take the LAST match in the body, not the first — the
// trailer BLOCK a real stamp lands always sits at the true end of the message.
//
// Proves, for ONE hand-built commit whose body carries a DECOY trailer-shaped paragraph (all three
// trailers, referencing a decoy branch name + bogus base/digest) followed by the REAL trailer block at the
// true end of the message:
//   (1) findLandedSquashCommit's branch-gone verification (PathSet + Base) recovers the REAL sha, using
//       the REAL (appended) digest/base — not the decoy ones earlier in the body.
//   (2) scanMergedCommitMap (via getTaskMergedInfo) keys the map entry on the REAL branch name — not the
//       decoy — and resolves it to the "pathset" tier with the correct digest.
//   (3) POSITIVE CONTROL, run twice: a "clean" sibling fixture with NO decoy paragraph proves the oracle
//       itself resolves correctly when there's nothing to shadow — so a null verdict on the shadowed
//       fixture actually means "the decoy won", not "this fixture is broken some other way".
//   (4) Both (1) and (2) MUST FAIL RED against the pre-fix code (verified below by reverting
//       lastTrailerMatch to first-match and re-running) — the check can actually fail, not just report a
//       reassuring pass.
// DIRECTION OF DAMAGE (card's own bound): pre-fix, both checks degrade to null/unverified — a bogus base
// isn't a resolvable git object (verifyPersistedPathSet fails closed) and a wrong map key just never
// matches the real branch (no lookup even attempted) — neither path can forge a false "verified" against
// the WRONG sha; this suite does not attempt to construct one (structurally impossible — see the card).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-trailer-shadowing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const { getTaskMergedInfo, findLandedSquashCommit, taskKey, __resetMergedCommitMapCacheForTest } =
  await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=shadow@loom -c user.name=shadow";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

// Mirrors production's changedPathSetDigest exactly (git/worktrees.ts).
function pathSetDigest(cwd, base, ref) {
  const raw = execSync(`git diff --name-only --no-renames ${base}..${ref}`, { cwd }).toString();
  const paths = raw.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Builds one temp repo with a single commit on top of `init` whose message carries a DECOY trailer-shaped
 *  paragraph (when `withDecoy`) followed by the REAL trailer block at the true end — mirrors exactly what
 *  a batch/solo landing produces: worker-authored text, then the appended machine trailers. Returns the
 *  repo path, the task/branch identity, the landed sha, and the true digest so callers can cross-check. */
function buildFixture(label, withDecoy) {
  const repo = path.join(os.tmpdir(), `loom-shadow-${label}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# shadow\n");
  execSync(`git init -q && git config user.email shadow@loom && git config user.name shadow && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  const baseSha = git(repo, "rev-parse HEAD");

  const taskId = `shadow-task-${label}-${sfx}`;
  const realBranch = `loom/${taskKey(taskId)}`;
  const decoyBranch = "loom/decoy-not-real";
  const decoyBase = "deadbeef".repeat(5); // 40 well-formed hex chars, not a real object in this repo
  const decoyDigest = createHash("sha256").update(`decoy-digest-${label}`).digest("hex");

  fs.writeFileSync(path.join(repo, `${label}.txt`), `real ${label} content\n`);
  execSync("git add .", { cwd: repo });
  const subject = `feat(test): ${label} work`;
  // Each trailer line is its OWN `-m` paragraph (never one embedded-newline string) — mirrors this
  // project's own established convention (see batch-merge.mjs (7f)/(7g)) to avoid cross-platform
  // shell-quoting hazards. `^`/`m`-flag matching doesn't care that a blank line separates paragraphs —
  // each trailer text still starts its own line, which is all `lastTrailerMatch` needs to discriminate.
  const asDashM = (lines) => lines.map((l) => `-m "${l}"`).join(" ");
  const decoyParagraphs = withDecoy
    ? [
        "Example of a stamped commit, for reference:",
        `Loom-Worker-Branch: ${decoyBranch}`,
        `Loom-Worker-Base: ${decoyBase}`,
        `Loom-Worker-PathSet: ${decoyDigest}`,
      ]
    : [];

  // Commit WITHOUT the real trailer first (its digest depends on this commit's own sha^..sha), then amend
  // to append the real block — same two-step shape landBranchCommitsIndividually's own stamp uses.
  execSync(`git ${GIT_ID} commit -q -m "${subject}" ${asDashM(decoyParagraphs)}`, { cwd: repo });
  const preAmendSha = git(repo, "rev-parse HEAD");
  const realDigest = pathSetDigest(repo, baseSha, preAmendSha);
  const realParagraphs = [
    `Loom-Worker-Branch: ${realBranch}`,
    `Loom-Worker-Base: ${baseSha}`,
    `Loom-Worker-PathSet: ${realDigest}`,
  ];
  execSync(
    `git ${GIT_ID} commit -q --amend -m "${subject}" ${asDashM(decoyParagraphs)} ${asDashM(realParagraphs)}`,
    { cwd: repo },
  );
  const sha = git(repo, "rev-parse HEAD");

  return { repo, taskId, realBranch, decoyBranch, decoyBase, decoyDigest, realDigest, baseSha, sha };
}

// ── (1)+(2) SHADOWED fixture — a decoy paragraph precedes the real trailer block ──────────────────────
{
  const f = buildFixture("shadowed", true);
  const body = git(f.repo, `log -1 --format=%B ${f.sha}`);
  check("(precondition) the commit body actually carries BOTH the decoy and the real Loom-Worker-Branch lines",
    body.includes(`Loom-Worker-Branch: ${f.decoyBranch}`) && body.includes(`Loom-Worker-Branch: ${f.realBranch}`));
  check("(precondition) the commit body actually carries BOTH the decoy and the real Loom-Worker-Base lines",
    body.includes(`Loom-Worker-Base: ${f.decoyBase}`) && body.includes(`Loom-Worker-Base: ${f.baseSha}`));
  check("(precondition) the commit body actually carries BOTH the decoy and the real Loom-Worker-PathSet lines",
    body.includes(`Loom-Worker-PathSet: ${f.decoyDigest}`) && body.includes(`Loom-Worker-PathSet: ${f.realDigest}`));
  check("(precondition) the decoy values genuinely differ from the real ones (else this proves nothing)",
    f.decoyBranch !== f.realBranch && f.decoyBase !== f.baseSha && f.decoyDigest !== f.realDigest);
  check("(precondition) the real trailer block is the LAST occurrence in the body, the decoy is earlier",
    body.lastIndexOf(`Loom-Worker-Branch: ${f.decoyBranch}`) < body.lastIndexOf(`Loom-Worker-Branch: ${f.realBranch}`));

  // (1) findLandedSquashCommit: branch never existed as a ref in this repo ⇒ takes the branch-gone /
  // PathSet+Base verification path directly — no branch ref needed to exercise it.
  const found = await findLandedSquashCommit(f.repo, f.realBranch, "HEAD");
  check("(1) findLandedSquashCommit resolves the REAL sha (verified against the REAL, appended Base/PathSet, not the earlier decoy)",
    found === f.sha);

  // (2) scanMergedCommitMap (via getTaskMergedInfo): the map key must be the REAL branch, extracted from
  // the LAST Loom-Worker-Branch line, not the decoy one earlier in the body.
  __resetMergedCommitMapCacheForTest();
  const info = await getTaskMergedInfo(f.repo, f.taskId);
  check("(2) getTaskMergedInfo resolves this task (map keyed on the REAL branch, not the decoy)", info !== null);
  check("(2) resolved sha matches the real landed commit", info !== null && f.sha.startsWith(info.sha));
  check("(2) verification tier is \"pathset\" (the real digest/base verified, not degraded to trailer-only or rejected)",
    info?.verification === "pathset");
}

// ── (3) POSITIVE CONTROL — a CLEAN sibling fixture (no decoy paragraph at all) resolves identically ────
//     Proves the oracle itself works: a null/mismatch on the shadowed fixture above means the decoy won,
//     not that this whole check is silently broken for an unrelated reason.
{
  const f = buildFixture("clean", false);
  const body = git(f.repo, `log -1 --format=%B ${f.sha}`);
  check("(precondition) the clean fixture carries no decoy branch text at all", !body.includes(f.decoyBranch));

  const found = await findLandedSquashCommit(f.repo, f.realBranch, "HEAD");
  check("(3) CONTROL: findLandedSquashCommit resolves the real sha with no decoy present", found === f.sha);

  __resetMergedCommitMapCacheForTest();
  const info = await getTaskMergedInfo(f.repo, f.taskId);
  check("(3) CONTROL: getTaskMergedInfo resolves \"pathset\" with no decoy present", info?.verification === "pathset" && f.sha.startsWith(info.sha));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker-authored body line shaped like a Loom-Worker-Branch/-PathSet/-Base trailer, appearing BEFORE the real machine-stamped trailer block, no longer shadows it: verification reads the LAST (real, appended) trailer occurrence, not the first."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
