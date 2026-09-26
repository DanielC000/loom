import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f62ef199 — every Loom-trailer reader (git/worktrees.ts: findLandedSquashCommit, findLaterBranchSquash,
// scanMergedCommitMap via getTaskMergedInfo, readLandedTipTrailer) used to decide from a whole-message match, so a
// commit whose BODY merely quotes `Loom-Worker-Branch: <other branch>` made that other branch look landed. merge_batch
// lands each worker commit VERBATIM, so a quoted trailer line in a worker body is reachable in real use. The verdict
// now comes from parseLoomTrailerBlock: the message's FINAL paragraph, which must start with `Loom-Worker-Branch:` and
// hold only `Key: value` lines — the layout both the solo squash and the batch tip write.
//
// Proves on REAL git in a temp repo (no claude, no daemon):
//   (1) parseLoomTrailerBlock reads each trailer (Branch, Landed-Tip, Base, PathSet) from a real-layout block, and
//       rejects a quoted line mid-body, a quoted line as a non-block last paragraph, and prose after the trailer.
//   (2) a foreign branch quoted in a worker body (mid-body / as the worker's last paragraph before the real block / on
//       a commit with NO real block) is NOT landed for findLaterBranchSquash, findLandedSquashCommit, getTaskMergedInfo.
//   (3) POSITIVE CONTROLS: the branch that DID land (the real block on the same quoting commit) is found by each reader.
//   (4) a quoting commit NEWER than the real landing of the quoted branch does not hide the real one (the old
//       `--max-count=1` grep returned the newest quoting commit).
//   (5) readLandedTipTrailer reads the real tip and ignores a quoted Loom-Landed-Tip in the body.
// Run: pnpm build, then node test/merge-trailer-block-only.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const { parseLoomTrailerBlock, findLandedSquashCommit, findLaterBranchSquash, getTaskMergedInfo, readLandedTipTrailer, taskKey, __resetMergedCommitMapCacheForTest } =
  await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const ID = "-c user.email=t@loom -c user.name=t";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const HEX = (c) => c.repeat(40);

// ── (1) parser unit cases ────────────────────────────────────────────────────────────────────────────────────────
{
  const real = `feat(x): y\n\nbody\n\nLoom-Worker-Branch: loom/a\nLoom-Landed-Tip: ${HEX("a")}\nLoom-Worker-Base: ${HEX("b")}\nLoom-Worker-PathSet: ${HEX("c")}\n`;
  const p = parseLoomTrailerBlock(real);
  check("(1) solo layout: branch parsed", p?.branch === "loom/a");
  check("(1) solo layout: Loom-Landed-Tip parsed", p?.landedTip === HEX("a"));
  check("(1) solo layout: Loom-Worker-Base parsed", p?.base === HEX("b"));
  check("(1) solo layout: Loom-Worker-PathSet parsed", p?.pathSet === HEX("c"));
  const batch = `feat(x): y\n\nworker body\n\nLoom-Worker-Branch: loom/a\n`;
  check("(1) batch-tip layout (branch only) parsed", parseLoomTrailerBlock(batch)?.branch === "loom/a" && parseLoomTrailerBlock(batch)?.pathSet === null);
  check("(1) CRLF message parsed", parseLoomTrailerBlock(real.replace(/\n/g, "\r\n"))?.branch === "loom/a");
  check("(1) NEGATIVE: quote mid-body, real block for another branch → the OTHER branch",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/quoted\nmore prose\n\nLoom-Worker-Branch: loom/real\n`)?.branch === "loom/real");
  check("(1) NEGATIVE: quote mid-body with NO real block → null",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/quoted\nmore prose\n\nend of body\n`) === null);
  check("(1) NEGATIVE: prose line after the trailer line → not a block",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/quoted\nand then some prose\n`) === null);
  check("(1) NEGATIVE: quoted Loom-Landed-Tip in the body is not read from a non-final paragraph",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/a\nLoom-Landed-Tip: ${HEX("d")}\n\nLoom-Worker-Branch: loom/a\n`)?.landedTip === null);
  check("(1) NEGATIVE: bare subject with no trailer → null", parseLoomTrailerBlock("feat(x): y\n") === null);
  check("(1) NEGATIVE: a single-line message that is only a trailer line (the subject is never a trailer) → null",
    parseLoomTrailerBlock("Loom-Worker-Branch: loom/zz") === null);
  check("(1) NEGATIVE: subject + trailer lines with no blank line between (one paragraph) → null",
    parseLoomTrailerBlock("feat(x): y\nLoom-Worker-Branch: loom/zz\n") === null);
  check("(1) CONTROL: the same trailer after a blank line following the subject parses",
    parseLoomTrailerBlock("feat(x): y\n\nLoom-Worker-Branch: loom/zz\n")?.branch === "loom/zz");
  check("(1) NEGATIVE CONTROL: a bogus pattern parses nothing", parseLoomTrailerBlock("Loom-Nonsense: x\n") === null);
}

// ── fixture repo ─────────────────────────────────────────────────────────────────────────────────────────────────
const repo = path.join(os.tmpdir(), `loom-trailerblock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
fs.mkdirSync(repo, { recursive: true });
execSync("git init -q && git config user.email t@loom && git config user.name t", { cwd: repo });
let n = 0;
function commit(message) {
  n++;
  fs.writeFileSync(path.join(repo, `f${n}.txt`), `content ${n}\n`);
  execSync("git add .", { cwd: repo });
  const msgFile = path.join(repo, ".git", `msg${n}.txt`);
  fs.writeFileSync(msgFile, message);
  execSync(`git ${ID} commit -q -F "${msgFile}"`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}
const baseSha = commit("chore(test): init\n");

const taskFor = (label) => `trailerblock-task-${label}-${n}-${Math.random().toString(36).slice(2, 6)}`;
const foreignTask = taskFor("foreign");
const foreign = `loom/${taskKey(foreignTask)}`;
const realTask = taskFor("real");
const real = `loom/${taskKey(realTask)}`;
const bareTask = taskFor("bare");
const bare = `loom/${taskKey(bareTask)}`;

// (2a) batch-tip layout: worker body QUOTES foreign mid-body AND as its own last paragraph, then the real block.
const quotingTip = commit(
  `feat(x): quotes a foreign trailer\n\nworker body prose\nLoom-Worker-Branch: ${foreign}\nmore prose\n\nLoom-Worker-Branch: ${foreign}\n\nLoom-Worker-Branch: ${real}\n`,
);
// (2b) a NON-tip commit (no real block at all) that quotes the bare branch mid-body.
commit(`fix(x): non-tip quoting commit\n\nsee also\nLoom-Worker-Branch: ${bare}\nfor how that looked\n\nplain closing paragraph\n`);

// ── (2)/(3) readers ──────────────────────────────────────────────────────────────────────────────────────────────
check("(2) findLaterBranchSquash: quoted foreign branch is NOT landed", (await findLaterBranchSquash(repo, foreign, baseSha)) === "none");
check("(2) findLaterBranchSquash: quoted branch on a commit with no block is NOT landed", (await findLaterBranchSquash(repo, bare, baseSha)) === "none");
check("(3) CONTROL findLaterBranchSquash: the real block's branch IS found", (await findLaterBranchSquash(repo, real, baseSha)) === "found");
check("(3) CONTROL findLaterBranchSquash: a bogus branch → none", (await findLaterBranchSquash(repo, "loom/never-quoted-anywhere", baseSha)) === "none");

const quiet = () => {};
check("(2) findLandedSquashCommit: quoted foreign branch is NOT landed", (await findLandedSquashCommit(repo, foreign, "HEAD", {}, quiet)) === null);
check("(2) findLandedSquashCommit: quoted branch on a commit with no block is NOT landed", (await findLandedSquashCommit(repo, bare, "HEAD", {}, quiet)) === null);
check("(3) CONTROL findLandedSquashCommit: the real block's branch resolves the tip commit", (await findLandedSquashCommit(repo, real, "HEAD", {}, quiet)) === quotingTip);

__resetMergedCommitMapCacheForTest();
check("(2) getTaskMergedInfo: quoted foreign branch is NOT merged", (await getTaskMergedInfo(repo, foreignTask)) === null);
__resetMergedCommitMapCacheForTest();
check("(2) getTaskMergedInfo: quoted branch on a commit with no block is NOT merged", (await getTaskMergedInfo(repo, bareTask)) === null);
__resetMergedCommitMapCacheForTest();
const realInfo = await getTaskMergedInfo(repo, realTask);
check("(3) CONTROL getTaskMergedInfo: the real block's branch IS merged, at the tip commit", realInfo !== null && quotingTip.startsWith(realInfo.sha));

// ── (4) a NEWER quoting commit must not hide the real, older landing ─────────────────────────────────────────────
{
  const hiddenTask = taskFor("hidden");
  const hidden = `loom/${taskKey(hiddenTask)}`;
  const realLanding = commit(`feat(x): the real landing\n\nbody\n\nLoom-Worker-Branch: ${hidden}\n`);
  commit(`docs(x): newer commit quoting it\n\nexample:\nLoom-Worker-Branch: ${hidden}\nend of example\n`);
  check("(4) findLandedSquashCommit returns the REAL older landing, not the newer quoting commit", (await findLandedSquashCommit(repo, hidden, "HEAD", {}, quiet)) === realLanding);
  __resetMergedCommitMapCacheForTest();
  const info = await getTaskMergedInfo(repo, hiddenTask);
  check("(4) getTaskMergedInfo resolves the REAL older landing", info !== null && realLanding.startsWith(info.sha));
}

// ── (5) Loom-Landed-Tip ──────────────────────────────────────────────────────────────────────────────────────────
{
  const tip = HEX("e");
  const solo = commit(`feat(x): solo\n\nbody quotes a tip:\nLoom-Landed-Tip: ${HEX("f")}\n\nLoom-Worker-Branch: loom/solo-x\nLoom-Landed-Tip: ${tip}\n`);
  check("(5) readLandedTipTrailer reads the REAL tip from the final block", (await readLandedTipTrailer(repo, solo)) === tip);
  const quotedOnly = commit(`feat(x): batch tip\n\nquoted:\nLoom-Worker-Branch: loom/q\nLoom-Landed-Tip: ${HEX("f")}\n\nLoom-Worker-Branch: loom/solo-y\n`);
  check("(5) readLandedTipTrailer: a quoted tip with no tip in the final block → null", (await readLandedTipTrailer(repo, quotedOnly)) === null);
}

// ── (6) a REAL commit-msg hook that PREPENDS a trailer ahead of ours (Change-Id style) must not hide the landing ──────
{
  const hook = path.join(repo, ".git", "hooks", "commit-msg");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\ngit interpret-trailers --in-place --where start --trailer "Change-Id: I0123" "$1"\n`, { mode: 0o755 });
  const hookedTask = taskFor("hooked");
  const hooked = `loom/${taskKey(hookedTask)}`;
  const tip = HEX("9");
  const sha = commit(`feat(x): hooked landing\n\nbody\n\nLoom-Worker-Branch: ${hooked}\nLoom-Landed-Tip: ${tip}\n`);
  fs.rmSync(hook);
  const body = git(repo, `log -1 --format=%B ${sha}`);
  check("(6) precondition: the hook really inserted Change-Id AHEAD of Loom-Worker-Branch in the final paragraph",
    body.indexOf("Change-Id: I0123") !== -1 && body.indexOf("Change-Id: I0123") < body.indexOf("Loom-Worker-Branch:"));
  check("(6) parseLoomTrailerBlock still reads the branch and tip", parseLoomTrailerBlock(body)?.branch === hooked && parseLoomTrailerBlock(body)?.landedTip === tip);
  check("(6) findLandedSquashCommit detects the hooked landing", (await findLandedSquashCommit(repo, hooked, "HEAD", {}, quiet)) === sha);
  check("(6) findLaterBranchSquash detects the hooked landing", (await findLaterBranchSquash(repo, hooked, baseSha)) === "found");
  __resetMergedCommitMapCacheForTest();
  const info = await getTaskMergedInfo(repo, hookedTask);
  check("(6) getTaskMergedInfo detects the hooked landing", info !== null && sha.startsWith(info.sha));
  check("(6) readLandedTipTrailer reads the tip through the prepended trailer", (await readLandedTipTrailer(repo, sha)) === tip);
  check("(6) CONTROL: a quoted line in a non-final paragraph is still ignored with the hook shape present",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/quoted\n\nChange-Id: I1\nLoom-Worker-Branch: loom/real\n`)?.branch === "loom/real");
  check("(6) LIMIT (documented): a prose line such as [skip ci] in the final paragraph yields null",
    parseLoomTrailerBlock(`s\n\nLoom-Worker-Branch: loom/a\n[skip ci]\n`) === null);
}

// ── (7) a pinned trailing Signed-off-by AFTER our block ─────────────────────────────────────────────────────────────
{
  const sobTask = taskFor("sob");
  const sob = `loom/${taskKey(sobTask)}`;
  const tip = HEX("8");
  const sha = commit(`feat(x): signed\n\nbody\n\nLoom-Worker-Branch: ${sob}\nLoom-Landed-Tip: ${tip}\nSigned-off-by: T <t@loom>\n`);
  check("(7) parseLoomTrailerBlock reads branch + tip with Signed-off-by after the block",
    parseLoomTrailerBlock(git(repo, `log -1 --format=%B ${sha}`))?.branch === sob);
  check("(7) findLandedSquashCommit detects it", (await findLandedSquashCommit(repo, sob, "HEAD", {}, quiet)) === sha);
  check("(7) readLandedTipTrailer reads the tip", (await readLandedTipTrailer(repo, sha)) === tip);
}

// ── (8) a 3-newline gap before the block (commit.cleanup=verbatim / the batch writer's own `…body\n` + `\n\n`) ─────────
{
  check("(8) unit: 3-newline gap parses", parseLoomTrailerBlock(`s\n\nbody\n\n\nLoom-Worker-Branch: loom/g\n`)?.branch === "loom/g");
  check("(8) unit: whitespace-only blank lines in the gap parse", parseLoomTrailerBlock(`s\n\nbody\n \n\t\nLoom-Worker-Branch: loom/g\n`)?.branch === "loom/g");
  const gapTask = taskFor("gap");
  const gap = `loom/${taskKey(gapTask)}`;
  n++;
  fs.writeFileSync(path.join(repo, `f${n}.txt`), `content ${n}\n`);
  execSync("git add .", { cwd: repo });
  const msgFile = path.join(repo, ".git", `msg${n}.txt`);
  fs.writeFileSync(msgFile, `feat(x): verbatim gap\n\nbody\n\n\nLoom-Worker-Branch: ${gap}\n`);
  execSync(`git ${ID} commit -q --cleanup=verbatim -F "${msgFile}"`, { cwd: repo });
  const sha = git(repo, "rev-parse HEAD");
  check("(8) precondition: the committed message really keeps the 3-newline gap", git(repo, `log -1 --format=%B ${sha}`).includes("body\n\n\nLoom-Worker-Branch"));
  check("(8) findLandedSquashCommit detects the verbatim-gap landing", (await findLandedSquashCommit(repo, gap, "HEAD", {}, quiet)) === sha);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Loom trailers are read only from the final trailer block; a quoted trailer line in a worker body never marks a branch landed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
