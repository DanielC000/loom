import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unit tests for detectUnanchoredAddedCommentBlocks (card 9d0c004e) — the diff-scoped detector both
// worker_report and worker_merge's review step reuse. REAL git on temp repos, no daemon/SessionService
// involved (see unanchored-comment-blocks-warnings.mjs for the two integration surfaces,
// unanchored-comment-blocks-safety.mjs for hang-proofing/import-failure/truncation, and
// unanchored-comment-blocks-asset-contract.mjs for the packaged-asset export-shape backstop).
//
// Proves, against a plain single-directory repo (no worktree needed — the detector reads ref content via
// `git show <branch>:<file>`, never the filesystem, so a bare `git checkout -b` branch inside one repo dir
// is a real, faithful fixture):
//   (A) a branch that ADDS a long (>= DEFAULT_MIN_LINES) comment block with NO @decision anchor -> flagged.
//   (B) the SAME shape but anchored (`@decision sha:<8hex>` inside the block) -> NOT flagged.
//   (C) a legacy block already on main, unchanged by this branch (the branch only touches an unrelated
//       line elsewhere in the SAME file) -> NOT flagged — diff-scoped, never the whole corpus.
//   (D) RULE 3 (card review point 3): a 1-line LEGACY comment with >= DEFAULT_MIN_LINES NEW lines appended
//       directly under it (no blank line -> one contiguous block) -> flagged, because the branch-ADDED
//       line COUNT inside the block clears the threshold, even though the block as a whole is not
//       entirely new. A short append (< threshold) -> NOT flagged.
//   (E) RENAME (card review point 2): `git mv` plus a new long unanchored block in the renamed file's new
//       content -> still flagged — `git diff --stat`'s `{old => new}` rendering must not swallow it.
//   (F) a file OUTSIDE comment-anchor-lint's own source scope -> NOT flagged.
//   (G) the `hint.allFiles` path (a caller-supplied pre-fetched diffstat) produces the SAME result as the
//       no-hint path for the same branch.
// Run: 1) build daemon (pnpm build), 2) node test/unanchored-comment-blocks-detect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const { detectUnanchoredAddedCommentBlocks } = await import("../dist/git/unanchored-comment-blocks.js");
const { diffBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ucb@loom -c user.name=ucb";

function longUnanchoredComment(n, prefix = "line") {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`// ${prefix} ${i} of the block, deliberately generic filler text`);
  return lines.join("\n");
}

function initRepo(repo, seedFiles = {}) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ucb\n");
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "ucb@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "ucb"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// Returns the repo's base branch name (whatever `git init`'s ambient `init.defaultBranch` produced —
// never hardcoded as "main"/"master") BEFORE switching, so callers have a real base ref to diff against.
function cutBranch(repo, branch) {
  const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  return base;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repos = [];
function mkRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-ucb-${name}-${sfx}`);
  repos.push(repo);
  return repo;
}

try {
  // ── (A) ADDED, UNANCHORED, LONG -> flagged ─────────────────────────────────────────────────────────
  {
    const repo = mkRepo("added");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucb-a");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-a.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\nexport const a = 1;\n`);
    commitAll(repo, "add long unanchored block", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-a", base);
    check("(A) minLines resolved from the real script", result.minLines === 15);
    check("(A) exactly one block flagged", result.blocks.length === 1);
    check("(A) totalCount matches (not truncated)", result.totalCount === 1 && result.truncated === false);
    check("(A) flagged block names the right file", result.blocks[0]?.file === "packages/daemon/src/example-a.ts");
    check("(A) flagged block spans the whole 16-line comment run", result.blocks[0]?.length === 16);
  }

  // ── (B) ADDED, ANCHORED, LONG -> NOT flagged ───────────────────────────────────────────────────────
  {
    const repo = mkRepo("anchored");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucb-b");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-b.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = longUnanchoredComment(16).split("\n");
    lines.splice(3, 0, "// @decision sha:deadbeef — kept for a real reason, see the record");
    fs.writeFileSync(filePath, `${lines.join("\n")}\nexport const b = 1;\n`);
    commitAll(repo, "add long anchored block", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-b", base);
    check("(B) anchored block is NOT flagged", result.blocks.length === 0);
  }

  // ── (C) LEGACY, UNCHANGED -> NOT flagged (diff-scoped, never the whole corpus) ─────────────────────
  {
    const repo = mkRepo("legacy");
    const legacyRel = path.join("packages", "daemon", "src", "example-c.ts");
    initRepo(repo, { [legacyRel]: `${longUnanchoredComment(20)}\nexport const c = 1;\nexport const untouched = 2;\n` });
    const base = cutBranch(repo, "loom/ucb-c");
    // Touch an UNRELATED line in the SAME file — the pre-existing 20-line block itself is untouched.
    const filePath = path.join(repo, legacyRel);
    const content = fs.readFileSync(filePath, "utf8").replace("export const untouched = 2;", "export const touched = 3;");
    fs.writeFileSync(filePath, content);
    commitAll(repo, "tweak an unrelated line", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-c", base);
    check("(C) legacy unchanged block is NOT flagged", result.blocks.length === 0);
  }

  // ── (D) RULE 3: legacy 1-line comment + >=15 NEW lines appended under it -> flagged by ADDED COUNT ──
  {
    const repo = mkRepo("grown");
    const legacyRel = path.join("packages", "daemon", "src", "example-d.ts");
    initRepo(repo, { [legacyRel]: `// a single legacy comment line, no anchor\nexport const d = 1;\n` });
    const base = cutBranch(repo, "loom/ucb-d");
    const filePath = path.join(repo, legacyRel);
    // Insert 20 NEW comment lines directly under the legacy one (no blank line -> stays ONE block).
    const grown = `// a single legacy comment line, no anchor\n${longUnanchoredComment(20, "new narrative")}\nexport const d = 1;\n`;
    fs.writeFileSync(filePath, grown);
    commitAll(repo, "grow the legacy comment with new narrative", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-d", base);
    check("(D) grown legacy block IS flagged (20 added lines >= 15-line threshold)", result.blocks.length === 1);
    check("(D) flagged block's whole length is 21 (1 legacy + 20 new)", result.blocks[0]?.length === 21);
  }
  // ── (D2) same shape, but the append is SHORT (< threshold) -> NOT flagged ─────────────────────────
  {
    const repo = mkRepo("grown-short");
    const legacyRel = path.join("packages", "daemon", "src", "example-d2.ts");
    initRepo(repo, { [legacyRel]: `// a single legacy comment line, no anchor\nexport const d2 = 1;\n` });
    const base = cutBranch(repo, "loom/ucb-d2");
    const filePath = path.join(repo, legacyRel);
    const grown = `// a single legacy comment line, no anchor\n${longUnanchoredComment(5, "new narrative")}\nexport const d2 = 1;\n`;
    fs.writeFileSync(filePath, grown);
    commitAll(repo, "grow the legacy comment with a SHORT append", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-d2", base);
    check("(D2) short append (5 added lines < 15) is NOT flagged", result.blocks.length === 0);
  }

  // ── (E) RENAME: git mv + a new long unanchored block in the renamed file -> still flagged ──────────
  {
    const repo = mkRepo("rename");
    const oldRel = path.join("packages", "daemon", "src", "old-name.ts");
    // A big-enough ORIGINAL body is load-bearing here: git's rename detector keys off BYTE-level
    // similarity (roughly: unchanged bytes / total bytes >= 50%), not line-count proportion — a small
    // original file plus a same-size-or-larger appended block drops well under that threshold and git
    // reports a plain delete+add instead of a rename, which would make this test pass vacuously without
    // ever exercising the bug it's meant to catch (verified empirically while writing this fixture).
    const originalBody = Array.from({ length: 100 }, (_, i) => `export const x${i + 1} = ${i + 1};`).join("\n") + "\n";
    initRepo(repo, { [oldRel]: originalBody });
    const base = cutBranch(repo, "loom/ucb-e");
    const newRel = path.join("packages", "daemon", "src", "new-name.ts");
    execFileSync("git", ["mv", oldRel, newRel], { cwd: repo });
    const newFilePath = path.join(repo, newRel);
    fs.writeFileSync(newFilePath, `${originalBody}${longUnanchoredComment(16)}\n`);
    commitAll(repo, "rename + add long unanchored block", GIT_ID);

    // Sanity: confirm `git diff --stat` really does render the rename in bracket form for this fixture —
    // otherwise this test would pass vacuously without ever exercising the bug it's meant to catch.
    const statOut = execFileSync("git", ["diff", "--stat", `${base}...loom/ucb-e`], { cwd: repo, encoding: "utf8" });
    check("(E) sanity: git diff --stat renders the rename in bracket form (not a vacuous fixture)", /\{old-name\.ts => new-name\.ts\}/.test(statOut));

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-e", base);
    check("(E) rename does not swallow the new block — still flagged", result.blocks.length === 1);
    check("(E) flagged block names the NEW (post-rename) path", result.blocks[0]?.file === "packages/daemon/src/new-name.ts");
  }

  // ── (F) a file OUTSIDE comment-anchor-lint's own source scope -> NOT flagged ───────────────────────
  {
    const repo = mkRepo("outofscope");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucb-f");
    const filePath = path.join(repo, "docs", "example-f.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\n`);
    commitAll(repo, "add long block in an out-of-scope file", GIT_ID);

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-f", base);
    check("(F) out-of-scope file is NOT flagged", result.blocks.length === 0);
  }

  // ── (G) hint.allFiles path produces the SAME result as the no-hint path ────────────────────────────
  {
    const repo = mkRepo("hint");
    initRepo(repo);
    const base = cutBranch(repo, "loom/ucb-g");
    const filePath = path.join(repo, "packages", "daemon", "src", "example-g.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${longUnanchoredComment(16)}\nexport const g = 1;\n`);
    commitAll(repo, "add long unanchored block", GIT_ID);

    const noHint = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-g", base);
    const diff = await diffBranch(repo, "loom/ucb-g", base, { includePatch: false });
    const withHint = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucb-g", base, {}, { allFiles: diff.allFiles });
    check("(G) hint path finds the same block as the no-hint path", withHint.blocks.length === 1 && noHint.blocks.length === 1);
    check("(G) hint path result is byte-identical to the no-hint path",
      JSON.stringify(withHint.blocks) === JSON.stringify(noHint.blocks));
  }
} finally {
  for (const repo of repos) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectUnanchoredAddedCommentBlocks flags a branch-added long unanchored comment block (whether wholly new or grown onto an existing legacy comment by >= threshold ADDED lines), stays silent when anchored, stays silent on an unchanged legacy block and a below-threshold append (diff-scoped), survives a rename, stays silent outside comment-anchor-lint's own source scope, and produces an identical result whether or not a caller supplies a pre-fetched diffstat hint."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
