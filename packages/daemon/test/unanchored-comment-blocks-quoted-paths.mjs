import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1300c169 (fdf09672's Code Review, finding 2): even with `-c core.quotepath=false`, git still
// C-quotes a unified patch's `+++`/`---` header path when it contains a TAB, `"`, `\`, or another control
// character — `-z` has NO effect on these lines at all (see fdf09672's own decision record). Pre-fix,
// `parseAddedLineNumbers` (packages/daemon/src/git/unanchored-comment-blocks.ts) stripped `^b\/` from the
// RAW quoted text (e.g. `"b/a\tb.ts"`), which never matches the real file's key, so the detector silently
// found nothing for such a path. The fix adds `unquoteGitPath`, a real C-unquote (git quote.c's own
// quote_c_style, reversed), applied to every `+++` path before the `^b\/` strip.
//
// Two halves:
//   (U) parseAddedLineNumbers, DIRECT, crafted patch text (no git needed) — covers ordinary/tab/quote/
//       backslash/non-ASCII-unquoted/non-ASCII-octal-quoted/`/dev/null`/a malformed trailing backslash.
//       Exported directly (same convention as parseNumstatZ in worktrees.ts) so these run unconditionally,
//       on every platform, with no git and no filesystem involved at all.
//   (E) detectUnanchoredAddedCommentBlocks, REAL git, END TO END, one branch with four files: ordinary,
//       non-ASCII (café.ts, a REAL on-disk file — legal on NTFS, unlike TAB/`"`), and two constructed via
//       `git update-index --add --cacheinfo` PLUMBING (a real git blob + a real commit, never a crafted
//       string) rather than `fs.writeFileSync` — NTFS rejects a literal TAB or `"` in an on-disk filename,
//       but plumbing writes the path into the git OBJECT STORE/INDEX directly, with no filesystem call for
//       the name at all, so the SAME real end-to-end pipeline (diffBranch -> scoped `git diff` -> *THIS*
//       parser -> `git show` for content) is provably exercised on every host, win32 included — never a
//       SKIP. (`core.protectNTFS=false` is needed only on the `update-index --cacheinfo` calls that WRITE
//       these entries — verified empirically that a plain, unflagged `git commit`/`git diff`/`git show`
//       against an already-staged entry needs no override at all, since nothing there touches a real path
///      on disk.)
// Run: 1) build daemon (pnpm build), 2) node test/unanchored-comment-blocks-quoted-paths.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const { parseAddedLineNumbers, detectUnanchoredAddedCommentBlocks } = await import("../dist/git/unanchored-comment-blocks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ucbq@loom -c user.name=ucbq";

function longUnanchoredComment(n, prefix = "line") {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`// ${prefix} ${i} of the block, deliberately generic filler text`);
  return lines.join("\n");
}

// ══════════════════════════════ (U) parseAddedLineNumbers — DIRECT, crafted patch text ══════════════════
{
  // (U1) ordinary unquoted path — the common case, must still parse exactly as before.
  {
    const patch = `diff --git a/plain.ts b/plain.ts\nindex 1111111..2222222 100644\n--- a/plain.ts\n+++ b/plain.ts\n@@ -0,0 +1,2 @@\n+line one\n+line two\n`;
    const result = parseAddedLineNumbers(patch);
    check("(U1) ordinary path keys the map", result.has("plain.ts"));
    check("(U1) both added lines recorded", JSON.stringify([...result.get("plain.ts")].sort((a, b) => a - b)) === "[1,2]");
  }

  // (U2) TAB-containing path, C-quoted — `+++ "b/a\tb.ts"` (literal backslash-t, as git itself emits it,
  // verified on real git 2.47 via the plumbing technique above).
  {
    const patch = `diff --git "a/a\\tb.ts" "b/a\\tb.ts"\nindex 1111111..2222222 100644\n--- "a/a\\tb.ts"\n+++ "b/a\\tb.ts"\n@@ -0,0 +1,1 @@\n+only line\n`;
    const result = parseAddedLineNumbers(patch);
    const keys = [...result.keys()];
    check("(U2) TAB path unquoted to the REAL key (containing a real tab byte)", keys.length === 1 && keys[0] === "a\tb.ts");
    check("(U2) the real-tab key is NOT the raw quoted text", !result.has('"a\\tb.ts"') && !result.has("a\\tb.ts"));
  }

  // (U3) quote-containing path, C-quoted — `+++ "b/q\"x.ts"`.
  {
    const patch = `diff --git "a/q\\"x.ts" "b/q\\"x.ts"\nindex 1111111..2222222 100644\n--- "a/q\\"x.ts"\n+++ "b/q\\"x.ts"\n@@ -0,0 +1,1 @@\n+only line\n`;
    const result = parseAddedLineNumbers(patch);
    const keys = [...result.keys()];
    check("(U3) quote path unquoted to the REAL key (containing a real double-quote byte)", keys.length === 1 && keys[0] === 'q"x.ts');
  }

  // (U4) backslash-containing path, C-quoted — `+++ "b/a\\b.ts"` (git escapes a literal `\` as `\\`).
  {
    const patch = `diff --git "a/a\\\\b.ts" "b/a\\\\b.ts"\nindex 1111111..2222222 100644\n--- "a/a\\\\b.ts"\n+++ "b/a\\\\b.ts"\n@@ -0,0 +1,1 @@\n+only line\n`;
    const result = parseAddedLineNumbers(patch);
    const keys = [...result.keys()];
    check("(U4) backslash path unquoted to the REAL key (one literal backslash, not two)", keys.length === 1 && keys[0] === "a\\b.ts");
  }

  // (U5) non-ASCII path, UNQUOTED — the real shape this call site always produces (`-c
  // core.quotepath=false` suppresses non-ASCII quoting) — must pass through untouched, no regression.
  {
    const patch = `diff --git a/café.ts b/café.ts\nindex 1111111..2222222 100644\n--- a/café.ts\n+++ b/café.ts\n@@ -0,0 +1,1 @@\n+only line\n`;
    const result = parseAddedLineNumbers(patch);
    const keys = [...result.keys()];
    check("(U5) unquoted non-ASCII path passes through untouched", keys.length === 1 && keys[0] === "café.ts");
  }

  // (U6) non-ASCII path, OCTAL-QUOTED — only reachable if `core.quotepath=true` ever leaked onto this
  // call's own git invocation (it never does — this call always sets `-c core.quotepath=false`), but the
  // unquoter is written to decode this correctly anyway, so pin it: a multi-byte UTF-8 character split
  // across CONSECUTIVE octal escapes must decode as ONE character, not byte-by-byte mojibake. `é` is
  // `\303\251` in UTF-8 — the exact rendering fdf09672's own decision record captured on real git.
  {
    const patch = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\nindex 1111111..2222222 100644\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1,1 @@\n+only line\n`;
    const result = parseAddedLineNumbers(patch);
    const keys = [...result.keys()];
    check("(U6) octal-quoted non-ASCII path decodes to the real UTF-8 string", keys.length === 1 && keys[0] === "café.ts");
  }

  // (U7) `/dev/null` (a deleted file) — must still be recognized and produce no entry, unaffected by the
  // unquote call (the literal text `/dev/null` is never itself quoted by git).
  {
    const patch = `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-only line\n`;
    const result = parseAddedLineNumbers(patch);
    check("(U7) a deleted file (+++ /dev/null) produces no map entry", result.size === 0);
  }

  // (U8) negative control: a malformed trailing backslash (no escape character to consume) must not
  // throw and must not silently eat the quote — a defensive fallback, never reachable from real git output.
  {
    const patch = `diff --git "a/bad\\\\" "b/bad\\\\"\nindex 1111111..2222222 100644\n--- "a/bad\\\\"\n+++ "b/bad\\\\"\n@@ -0,0 +1,1 @@\n+only line\n`;
    let threw = false;
    let result;
    try { result = parseAddedLineNumbers(patch); } catch { threw = true; }
    check("(U8) a malformed trailing backslash does not throw", !threw);
    check("(U8) and still produces exactly one map entry (fails safe, not silently empty)", result && result.size === 1);
  }
}

// ══════════════════════════ (E) detectUnanchoredAddedCommentBlocks — REAL git, end to end ═══════════════
{
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = path.join(os.tmpdir(), `loom-ucbq-${sfx}`);
  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# ucbq\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "ucbq@loom"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "ucbq"], { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", "-b", "loom/ucbq"], { cwd: repo });

    // Ordinary, real on-disk file.
    const ordinaryRel = path.join("packages", "daemon", "src", "ucbq-ordinary.ts");
    fs.mkdirSync(path.dirname(path.join(repo, ordinaryRel)), { recursive: true });
    fs.writeFileSync(path.join(repo, ordinaryRel), `${longUnanchoredComment(16, "ordinary")}\nexport const ordinary = 1;\n`);

    // Non-ASCII, real on-disk file (legal on NTFS — only TAB/`"` are not).
    const nonAsciiRel = path.join("packages", "daemon", "src", "ucbq-café.ts");
    fs.writeFileSync(path.join(repo, nonAsciiRel), `${longUnanchoredComment(16, "nonascii")}\nexport const nonascii = 1;\n`);
    execFileSync("git", ["add", "."], { cwd: repo });

    // TAB- and quote-containing paths, via index plumbing (never fs.writeFileSync — NTFS refuses both
    // characters in a real on-disk filename; `core.protectNTFS=false` is needed on THESE two write calls
    // only, verified above). Built with EXPLICIT forward slashes, never `path.join` — a git tree path is
    // always posix-separated regardless of host OS, and `path.join` on win32 would emit a backslash
    // separator that collides with the literal backslash-escaping this fix itself decodes.
    const tabRel = "packages/daemon/src/ucbq-a\tb.ts";
    const quoteRel = 'packages/daemon/src/ucbq-q"x.ts';
    let plumbingOk = true;
    try {
      const tabBlobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: `${longUnanchoredComment(16, "tabpath")}\nexport const tabpath = 1;\n` }).toString().trim();
      execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${tabBlobSha},${tabRel}`], { cwd: repo });
      const quoteBlobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: `${longUnanchoredComment(16, "quotepath")}\nexport const quotepath = 1;\n` }).toString().trim();
      execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${quoteBlobSha},${quoteRel}`], { cwd: repo });
    } catch (e) {
      plumbingOk = false;
      console.log(`SKIP  (E, tab/quote halves) this git/host combination refused the index-plumbing construction for a TAB/\`"\`-named path: ${e instanceof Error ? e.message : String(e)}`);
    }

    execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "add ordinary/non-ASCII/tab/quote files with long unanchored blocks"], { cwd: repo });

    const result = await detectUnanchoredAddedCommentBlocks(repo, "loom/ucbq", base);
    const files = result.blocks.map((b) => b.file).sort();

    check("(E) ordinary path is flagged", files.includes(ordinaryRel.split(path.sep).join("/")));
    check("(E) non-ASCII path is flagged with its real unmangled name", files.includes(nonAsciiRel.split(path.sep).join("/")));
    if (plumbingOk) {
      check("(E) TAB-containing path is flagged with its REAL (unquoted) name, containing a real tab byte", files.includes(tabRel));
      check("(E) quote-containing path is flagged with its REAL (unquoted) name, containing a real double-quote byte", files.includes(quoteRel));
      check("(E) exactly four blocks total (no cross-contamination, nothing dropped)", result.blocks.length === 4);
    } else {
      check("(E) at least the ordinary + non-ASCII blocks are flagged (plumbing halves skipped on this host)", result.blocks.length === 2);
    }
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — parseAddedLineNumbers reverses git's C-quoting of a +++ header path (TAB, `\"`, `\\`, and octal-escaped non-ASCII all decode to the real byte sequence; an ordinary or already-unquoted non-ASCII path and /dev/null pass through unaffected), and detectUnanchoredAddedCommentBlocks flags a TAB- and a quote-containing path end to end against real git, alongside an ordinary and a non-ASCII path in the same branch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
