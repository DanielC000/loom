import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 61d0c029) — sibling of canonical-git-helper-guard.mjs's check (3) for a tree that
// check structurally cannot see: canonical-git-helper-guard.mjs's check (3) scans packages/daemon/src/**
// *.ts only. The two shipped session hooks (decision-records.mjs, comment-anchor-lint.mjs) are plain .mjs
// files under packages/daemon/assets/, run directly by the Claude CLI's hook runner — they cannot import
// packages/daemon/src/git/bounded.ts (there is no dist to import from inside a hook invocation), so a bare
// `execFileSync("git", …)` in either one was invisible to every existing guard (the gap card 61d0c029
// found: both hooks ran an unresolved "git" on win32 even after 5b50eede/b5416a46 made every daemon-src
// git spawn resolve an absolute git.exe). This guard closes that gap for the TOP-LEVEL
// `packages/daemon/assets/*.mjs` files, using the SAME two literal-spawn shapes (array-arg,
// shell-string) canonical-git-helper-guard.mjs's check (3) already established — duplicated here (not
// imported) so this stays a pure, standalone source-text scan with no coupling to a file
// (canonical-git-helper-guard.mjs) that is itself NOT unconditionally run on every reduced gate.
//
// SCOPE: top-level packages/daemon/assets/*.mjs only — a bare, non-recursive readdirSync, deliberately not
// a repo-wide walk. Nothing under assets/skills/**, assets/scripts/**, assets/native/** spawns git today
// (grep-verified at card 61d0c029); if one ever does, that is a fresh scope decision, not a silent
// widening of this glob.
//
// The sanctioned resolver for this directory is `resolveGitBinaryForSpawn()`
// (packages/daemon/assets/git-resolve.mjs — a standalone, duplicated-not-imported copy of bounded.ts's own
// resolver; see that file's own header for why, and packages/daemon/test/git-resolve-assets-parity.mjs for
// the test keeping the two from drifting).
//
// Run: node packages/daemon/test/assets-git-literal-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(TEST_DIR, "..", "assets");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Same two literal-spawn shapes as canonical-git-helper-guard.mjs's check (3) — see that file's own
// comment for the false-positive trap PAT_SHELLSTRING's callee-scoping avoids (a diagnostic string
// beginning with the English word "git " is not a spawn).
const PAT_ARRAY = /\(\s*["'`]git(?:\.exe)?["'`]\s*,/;
const PAT_SHELLSTRING = /\b(?:exec|execSync)\s*\(\s*["'`]git(?:\.exe)?\s/;
const BARE_GIT_LITERAL_SPAWN = new RegExp(`${PAT_ARRAY.source}|${PAT_SHELLSTRING.source}`);

// ── Self-test: the scanner can FAIL (RED demo on known-bad text) and is quiet on known-good text.
check("(self) a literal bare git spawn (array form) is flagged", BARE_GIT_LITERAL_SPAWN.test(stripComments('execFileSync("git", ["rev-parse", "--verify"]);')));
check("(self) a literal bare git shell-string spawn is flagged", BARE_GIT_LITERAL_SPAWN.test(stripComments('const out = execSync("git config user.name").toString();')));
check("(self) a spawn via the resolver (not a literal) is NOT flagged", !BARE_GIT_LITERAL_SPAWN.test(stripComments('execFileSync(resolveGitBinaryForSpawn(), ["rev-parse"]);')));
check("(self) a mention inside a comment is NOT flagged", !BARE_GIT_LITERAL_SPAWN.test(stripComments('// execFileSync("git", []);\nconst a = 1;')));
check("(self) an unrelated diagnostic string starting with the word \"git\" is NOT flagged", !BARE_GIT_LITERAL_SPAWN.test(stripComments('warn("git log returned no HEAD commit");')));

// ── The real scan: every top-level packages/daemon/assets/*.mjs file.
const assetMjsFiles = fs.readdirSync(ASSETS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
  .map((e) => e.name)
  .sort();
const hits = [];
for (const name of assetMjsFiles) {
  const raw = fs.readFileSync(path.join(ASSETS_DIR, name), "utf8");
  if (BARE_GIT_LITERAL_SPAWN.test(stripComments(raw))) hits.push(name);
}
check(`(scan) no top-level packages/daemon/assets/*.mjs file spawns git via a literal bare "git" command (every site must resolve the binary via git-resolve.mjs's resolveGitBinaryForSpawn())${hits.length ? ` — FOUND: ${hits.join(", ")}` : ""}`, hits.length === 0);
check(`(scan) the scan is non-vacuous: it saw at least 3 top-level assets/*.mjs files`, assetMjsFiles.length >= 3);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
