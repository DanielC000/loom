import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// diffBranch `files:`/`pathGlob` filter + patch pathspec (card 4cee7413, extended by card fdf09672).
// REAL git on temp repos, no daemon.
//
// Card fdf09672 replaced diffBranch's diffstat source with `git diff --numstat -z` (parseNumstatZ),
// never `--stat`'s DISPLAY text — so `f.file` is always the real path and a rename's old name is a
// dedicated `f.renameFrom` field, never reconstructed from `{old => new}`/`old => new` text (the two
// helpers that used to do that, normalizeDiffstatPath/diffstatRenameSource, are deleted; this file no
// longer unit-tests them directly). It also added `--literal-pathspecs` to the filtered-patch pathspec
// build (a GLOBAL flag, must precede the subcommand — verified on real git).
//
// Pre-fix sha 94d89e15ebcee843dbd198b3f534d46f9452d731 (this card's own branch point) is cited below for
// every case that discriminates — i.e. demonstrably failed against that sha and passes against the fix
// (verified via `pnpm --filter @loom/daemon negative-control`, not re-derived per-run here).
//
// Run: 1) pnpm build, 2) node test/diff-branch-rename-files-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const { diffBranch, parseNumstatZ } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dbr@loom -c user.name=dbr";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repos = [];
function mkRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-dbr-${name}-${sfx}`);
  repos.push(repo);
  return repo;
}
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email dbr@loom && git config user.name dbr", { cwd: repo });
}

// ══════════════════════ (T) parseNumstatZ unit cases (pure function, no git needed) ═══════════════════
{
  check("(T) ordinary non-rename record parses cleanly", JSON.stringify(parseNumstatZ("3\t1\ta.txt\0")) === JSON.stringify([{ file: "a.txt", insertions: 3, deletions: 1, binary: false }]));
  check("(T) binary record (- -) parses with 0/0 counts", JSON.stringify(parseNumstatZ("-\t-\tbin.dat\0")) === JSON.stringify([{ file: "bin.dat", insertions: 0, deletions: 0, binary: true }]));
  check("(T) well-formed rename record parses with renameFrom", JSON.stringify(parseNumstatZ("1\t0\t\0old.txt\0new.txt\0")) === JSON.stringify([{ file: "new.txt", renameFrom: "old.txt", insertions: 1, deletions: 0, binary: false }]));

  // card fdf09672 (CR 7b67f7b5, finding 2): a TRUNCATED rename record whose declared new-path token is
  // an EMPTY STRING (not `undefined` — the stream still has a token there, it's just empty) must throw,
  // never silently return `{file:"", renameFrom:"old"}`. Pre-fix, the check was `newPath === undefined`
  // only, which an empty string defeats.
  let threwEmptyNew = false;
  try { parseNumstatZ("1\t2\t\0old\0"); } catch { threwEmptyNew = true; }
  check("(T) truncated rename (empty new-path token) throws, never returns an empty-string file", threwEmptyNew);

  // Symmetric case: the OLD-path token is the empty one.
  let threwEmptyOld = false;
  try { parseNumstatZ("1\t2\t\0\0new.txt\0"); } catch { threwEmptyOld = true; }
  check("(T) truncated rename (empty old-path token) throws, never returns an empty-string renameFrom", threwEmptyOld);

  // Negative control, the other direction: the stream truly ending early (genuinely `undefined` tokens,
  // not just empty ones) must still throw too — confirms the fix WIDENED the check rather than replacing
  // it with something narrower that stopped catching the ORIGINAL (already-working) undefined case.
  let threwGenuinelyMissing = false;
  try { parseNumstatZ("1\t2\t\0old"); } catch { threwGenuinelyMissing = true; } // stream ends right after "old" — no new-path token at all, not even an empty one
  check("(T) negative control: a genuinely missing (not just empty) new-path token still throws", threwGenuinelyMissing);
}

try {
  // ══════════════════════ (R) RENAME — the card's ORIGINAL named-but-already-fixed case ═══════════════
  {
    const repo = mkRepo("rename");
    initRepo(repo);
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "old.ts"), body);
    fs.writeFileSync(path.join(repo, "other.ts"), "x\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    execSync("git mv src/old.ts src/new.ts", { cwd: repo });
    fs.writeFileSync(path.join(repo, "src", "new.ts"), body.replace("line 5\n", "line 5 EDITED\n"));
    fs.writeFileSync(path.join(repo, "other.ts"), "y\n");
    commitAll(repo, "rename+edit", GIT_ID);

    const all = await diffBranch(repo, "feat", "main", {});
    const renamed = all.allFiles.find((f) => f.file === "src/new.ts");
    check("(R) premise: f.file is the real post-rename path, never display-text arrows", all.allFiles.every((f) => !f.file.includes("=>")));
    check("(R) premise: the rename carries a dedicated renameFrom field", renamed?.renameFrom === "src/old.ts");

    const byFile = await diffBranch(repo, "feat", "main", { files: ["src/new.ts"] });
    check("(R) files:[new path] keeps the renamed entry", byFile.files.length === 1 && byFile.filesChanged === 1);
    check("(R) files:[new path] patch is NON-empty and carries the edit", byFile.patch.includes("line 5 EDITED"));
    check("(R) files:[new path] patch excludes the unrelated file", !byFile.patch.includes("other.ts"));
    check("(R) files:[new path] patch pairs the rename (rename from/to)", byFile.patch.includes("rename from src/old.ts") && byFile.patch.includes("rename to src/new.ts"));
    check("(R) files:[new path] patch does NOT re-add the unchanged content", !byFile.patch.includes("+line 7") && byFile.patch.includes("+line 5 EDITED"));

    const byOld = await diffBranch(repo, "feat", "main", { files: ["src/old.ts"] });
    check("(R) files:[OLD path] also matches via renameFrom (preserves the only intentional old-behavior)", byOld.files.length === 1 && byOld.patch.includes("rename from src/old.ts"));

    const byGlob = await diffBranch(repo, "feat", "main", { pathGlob: "src/*.ts" });
    check("(R) pathGlob on the new path returns a non-empty patch", byGlob.patch.includes("line 5 EDITED"));
    check("(R) pathGlob patch also pairs the rename", byGlob.patch.includes("rename from src/old.ts"));

    const none = await diffBranch(repo, "feat", "main", { files: ["nope/absent.ts"] });
    check("(R) negative control: a path matching nothing stays empty", none.patch === "" && none.files.length === 0);
  }

  // ══════════════════════ (B) BRACE-COLLISION — a REAL `{{x}}`-style filename, no rename ════════════════
  // Pre-fix: normalizeDiffstatPath("{{tpl}}/a.txt") -> "{tpl}/a.txt" (a path that doesn't exist), so
  // files:["{{tpl}}/a.txt"] matched nothing and the patch pathspec built from the mangled name failed.
  {
    const repo = mkRepo("brace");
    initRepo(repo);
    fs.mkdirSync(path.join(repo, "{{tpl}}"), { recursive: true });
    fs.writeFileSync(path.join(repo, "{{tpl}}", "a.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "base\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "{{tpl}}", "a.txt"), "base\nEDIT-BRACE\n");
    commitAll(repo, "edit brace-named file", GIT_ID);

    const all = await diffBranch(repo, "feat", "main", {});
    check("(B) allFiles carries the REAL unmangled brace-named path", all.allFiles.some((f) => f.file === "{{tpl}}/a.txt"));
    check("(B) no entry is corrupted into the mangled {tpl}/a.txt form", !all.allFiles.some((f) => f.file === "{tpl}/a.txt"));

    const byFile = await diffBranch(repo, "feat", "main", { files: ["{{tpl}}/a.txt"] });
    check("(B) files:[real brace path] matches the entry", byFile.files.length === 1 && byFile.files[0]?.file === "{{tpl}}/a.txt");
    check("(B) patch resolves against the real pathspec and carries the edit", byFile.patch.includes("EDIT-BRACE"));
  }

  // ══════════════════════ (N) NON-ASCII — a real café.txt filename ══════════════════════════════════════
  // Pre-fix: `--stat`'s C-quoting under core.quotepath turned this into the literal string
  // `"caf\303\251.txt"`, which never matches the real file as a pathspec.
  {
    const repo = mkRepo("nonascii");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "café.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "base\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "café.txt"), "base\nEDIT-NONASCII\n");
    commitAll(repo, "edit non-ASCII file", GIT_ID);

    const all = await diffBranch(repo, "feat", "main", {});
    check("(N) allFiles carries the REAL unquoted non-ASCII path", all.allFiles.some((f) => f.file === "café.txt"));
    check("(N) no entry is corrupted into the C-quoted octal form", !all.allFiles.some((f) => f.file.startsWith('"caf')));

    const byFile = await diffBranch(repo, "feat", "main", { files: ["café.txt"] });
    check("(N) files:[real non-ASCII path] matches the entry", byFile.files.length === 1 && byFile.files[0]?.file === "café.txt");
    check("(N) patch resolves against the real pathspec and carries the edit", byFile.patch.includes("EDIT-NONASCII"));
    // (N2) card fdf09672, 5th site: the PATCH TEXT's own `+++`/`---` lines must not be C-quoted either —
    // `-z` has no effect on a unified patch's header lines, so this needs `-c core.quotepath=false`
    // separately from the `--numstat -z`/pathspec fixes above.
    check("(N2) patch header carries the REAL unquoted path, not C-quoted octal text", byFile.patch.includes("+++ b/café.txt"));
    check("(N2) unfiltered patch ALSO carries the real unquoted header", (await diffBranch(repo, "feat", "main", {})).patch.includes("+++ b/café.txt"));
  }

  // ══════════════════════ (S) SPACE — a real "has space.txt" filename (regression check) ═══════════════
  {
    const repo = mkRepo("space");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "has space.txt"), "base\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "has space.txt"), "base\nEDIT-SPACE\n");
    commitAll(repo, "edit space-named file", GIT_ID);

    const byFile = await diffBranch(repo, "feat", "main", { files: ["has space.txt"] });
    check("(S) files:[space-named path] matches and patch carries the edit", byFile.files.length === 1 && byFile.patch.includes("EDIT-SPACE"));
  }

  // ══════════════ (D) LEADING-DASH — a real "-leadingdash.txt" filename (regression check) ═════════════
  // Never actually broken (the `--` separator was always present) — pinned anyway since the patch
  // pathspec build now goes through `.raw(["--literal-pathspecs", "diff", ...])` instead of `.diff([...])`,
  // a real call-shape change that could in principle have dropped the `--` separator.
  {
    const repo = mkRepo("dash");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "-leadingdash.txt"), "base\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "-leadingdash.txt"), "base\nEDIT-DASH\n");
    commitAll(repo, "edit leading-dash-named file", GIT_ID);

    const byFile = await diffBranch(repo, "feat", "main", { files: ["-leadingdash.txt"] });
    check("(D) files:[leading-dash path] matches and patch carries the edit, never mistaken for a git option", byFile.files.length === 1 && byFile.patch.includes("EDIT-DASH"));
  }

  // ══════════════ (G) GLOB-MAGIC — a REAL "[x].txt" filename vs an unrelated "x.txt" ═══════════════════
  // Verified on real git: WITHOUT --literal-pathspecs, pathspec `[x].txt` ALSO matches `x.txt` (bracket
  // char-class). Pre-fix (no --literal-pathspecs on this call at all): files:["[x].txt"] would have
  // produced a patch that ALSO includes x.txt's unrelated edit.
  {
    const repo = mkRepo("globmagic");
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "[x].txt"), "base\n");
    fs.writeFileSync(path.join(repo, "x.txt"), "base\n");
    commitAll(repo, "init", GIT_ID);
    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "[x].txt"), "base\nEDIT-BRACKET\n");
    fs.writeFileSync(path.join(repo, "x.txt"), "base\nEDIT-X\n");
    commitAll(repo, "edit both files", GIT_ID);

    const byFile = await diffBranch(repo, "feat", "main", { files: ["[x].txt"] });
    check("(G) files:[literal bracket path] selects only that ONE diffstat entry", byFile.files.length === 1 && byFile.files[0]?.file === "[x].txt");
    check("(G) patch carries the selected file's own edit", byFile.patch.includes("EDIT-BRACKET"));
    check("(G) patch does NOT cross-contaminate with x.txt's edit (--literal-pathspecs working)", !byFile.patch.includes("EDIT-X"));
  }
} finally {
  for (const repo of repos) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
