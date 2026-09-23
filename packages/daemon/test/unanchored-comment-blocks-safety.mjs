import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Safety-net tests for detectUnanchoredAddedCommentBlocks (card 9d0c004e, code-review follow-up):
//   (H) HANG-PROOFING (review point 1): a branch that carries its OWN poisoned copy of
//       comment-anchor-lint.mjs (a top-level hang) at the OLD lookup path — proving the detector genuinely
//       never reads worktree/branch content for the linter module itself: it completes quickly and
//       correctly despite that poisoned content sitting right there in the diff.
//   (I) IMPORT-FAILURE FAIL-SAFE (review point 6): via the `__setCommentAnchorLintScriptPathForTest` test
//       seam — a nonexistent script path, and a well-formed-but-export-missing module — both degrade to
//       the empty result, never throw.
//   (J) TRUNCATION (review point 6, + the "count the total" nit): a branch adding MORE than the 20-block
//       cap all qualify — `blocks.length === 20`, `truncated === true`, `totalCount` names the real total,
//       and the rendered advisory message states "showing 20 of <N>".
//
// NOT covered here, deliberately: actually exercising a HUNG import() via the test seam. Nothing in this
// detector bounds the import() call itself (see its own decision record: only the daemon's OWN packaged,
// trusted copy is ever imported, so an import-level timeout was judged unnecessary) — deliberately forcing
// a hang through the override seam would hang this test process itself, not prove anything safely. Scenario
// (H) above proves the actually-relevant claim: a hang IN REPO CONTENT cannot reach the import path at all.
// Run: 1) build daemon (pnpm build), 2) node test/unanchored-comment-blocks-safety.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const {
  detectUnanchoredAddedCommentBlocks, formatUnanchoredCommentBlocksAdvisory, __setCommentAnchorLintScriptPathForTest,
} = await import("../dist/git/unanchored-comment-blocks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ucbs@loom -c user.name=ucbs";

function longUnanchoredComment(n, prefix = "line") {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`// ${prefix} ${i} of the block, deliberately generic filler text`);
  return lines.join("\n");
}

function initRepo(repo, seedFiles = {}) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ucbs\n");
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "ucbs@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "ucbs"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function cutBranch(repo, branch) {
  const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  return base;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const cleanupPaths = [];
function mkRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-ucbs-${name}-${sfx}`);
  cleanupPaths.push(repo);
  return repo;
}
function mkFixture(name, content) {
  const dir = path.join(os.tmpdir(), `loom-ucbs-fixture-${name}-${sfx}`);
  cleanupPaths.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fixture.mjs");
  fs.writeFileSync(file, content);
  return file;
}

try {
  // ── (H) HANG-PROOFING: a poisoned in-repo copy at the OLD lookup path has ZERO effect ──────────────
  {
    const repo = mkRepo("hang");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucbs-h");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-h.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\nexport const h = 1;\n`);
    // A poisoned copy of comment-anchor-lint.mjs, committed on this SAME branch at the OLD lookup path
    // (a worktree's own packages/daemon/assets/comment-anchor-lint.mjs) — a top-level hang. If the
    // detector ever imported THIS instead of the daemon's own packaged copy, this call would never return.
    const poisonPath = path.join(repo, "packages", "daemon", "assets", "comment-anchor-lint.mjs");
    fs.mkdirSync(path.dirname(poisonPath), { recursive: true });
    fs.writeFileSync(poisonPath, "export const DEFAULT_MIN_LINES = 15;\nawait new Promise(() => {});\n");
    commitAll(repo, "add long unanchored block + a poisoned in-repo linter copy", GIT_ID);

    const startedAt = Date.now();
    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucbs-h", base);
    const elapsedMs = Date.now() - startedAt;
    check("(H) completes quickly despite the poisoned in-repo copy (< 10s, no hang)", elapsedMs < 10_000);
    check("(H) still finds the real block (using the daemon's OWN packaged copy, not the poisoned one)", result.blocks.length === 1);
    check("(H) flagged block names the real example file, never the poisoned linter copy", result.blocks[0]?.file === "packages/daemon/src/example-h.ts");
  }

  // ── (I) IMPORT-FAILURE FAIL-SAFE: nonexistent script path -> empty result, never throws ───────────
  {
    const repo = mkRepo("importfail-missing");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucbs-i1");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-i1.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\nexport const i1 = 1;\n`);
    commitAll(repo, "add long unanchored block", GIT_ID);

    __setCommentAnchorLintScriptPathForTest(path.join(os.tmpdir(), `loom-ucbs-does-not-exist-${sfx}.mjs`));
    let threw = false;
    let result;
    try { result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucbs-i1", base); }
    catch { threw = true; }
    __setCommentAnchorLintScriptPathForTest(null); // restore the real daemon asset for later scenarios

    check("(I1) a nonexistent script path never throws", threw === false);
    check("(I1) degrades to the empty result", result?.blocks.length === 0 && result?.truncated === false && result?.totalCount === 0 && result?.minLines === null);
  }

  // ── (I2) IMPORT-FAILURE FAIL-SAFE: a well-formed module MISSING the expected exports -> empty result ─
  {
    const repo = mkRepo("importfail-badexports");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucbs-i2");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-i2.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\nexport const i2 = 1;\n`);
    commitAll(repo, "add long unanchored block", GIT_ID);

    const badFixture = mkFixture("badexports", "export const DEFAULT_MIN_LINES = 15;\n// extractCommentBlocks/isInScope renamed away or removed — the exact incident this test guards against\n");
    __setCommentAnchorLintScriptPathForTest(badFixture);
    let threw = false;
    let result;
    try { result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucbs-i2", base); }
    catch { threw = true; }
    __setCommentAnchorLintScriptPathForTest(null);

    check("(I2) an export-missing module never throws", threw === false);
    check("(I2) degrades to the empty result (advisory silently disabled, not crashed)", result?.blocks.length === 0 && result?.minLines === null);
  }

  // ── (J) TRUNCATION: more than MAX_BLOCKS (20) qualifying blocks -> capped, truncated, total named ───
  {
    const repo = mkRepo("truncation");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucbs-j");
    const N = 25;
    for (let i = 1; i <= N; i++) {
      const filePath = path.join(repo, "packages", "daemon", "src", `example-j${i}.ts`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${longUnanchoredComment(16, `file${i}`)}\nexport const j${i} = ${i};\n`);
    }
    commitAll(repo, `add ${N} long unanchored blocks across ${N} files`, GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucbs-j", base);
    check("(J) capped at MAX_BLOCKS (20)", result.blocks.length === 20);
    check("(J) truncated is true", result.truncated === true);
    check(`(J) totalCount names the real total (${N})`, result.totalCount === N);

    const msg = formatUnanchoredCommentBlocksAdvisory(result, "manager");
    check("(J) advisory message states the real total, not just the capped count", msg.includes(`adds ${N} comment block(s)`));
    check("(J) advisory message states how many are shown vs the total", msg.includes(`showing 20 of ${N}`));
  }
} finally {
  for (const p of cleanupPaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectUnanchoredAddedCommentBlocks is unaffected by a poisoned in-repo copy of comment-anchor-lint.mjs (never hangs, never uses it), fails safe (never throws) on a missing or export-broken linter module, and caps its reported blocks at 20 while naming the real total in both the result and the rendered advisory."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
