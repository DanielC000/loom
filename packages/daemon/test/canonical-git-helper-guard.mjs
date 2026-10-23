import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 356538ef) — every git call on the CANONICAL MERGE PATH goes through the shared
// `canonicalGit` factory (git/bounded.ts), never a bare `boundedSimpleGit(` / `simpleGit(` and never a raw child-process
// `git`. The shared `.git` is worker-writable (merge drivers, replace refs), so a sibling call that bypasses the helper
// silently reopens S11/S12 — the recurring defect class this card exists to stop.
//
// WHAT THIS ASSERTS (source-TEXT, comment-stripped; NOT a behaviour test — canonical-git-isolation.mjs is that):
//  (1) STRICT files — `git/worktrees.ts`, `git/batch-merge.ts` and `git/mainline-watch.ts` (the canonical merge path + the mainline tripwire, card 4fa36502): no `boundedSimpleGit(` /
//      `simpleGit(` call; every `spawn("git", [` carries `...CANONICAL_GIT_CONFIG_ARGS` as its first args; no other raw
//      child-process git (`execFile*`/`exec*`/`spawnSync`).
//  (2) WHOLE-TREE: any OTHER `packages/daemon/src/**/*.ts` file that constructs git directly via a LITERAL
//      `boundedSimpleGit(`/`simpleGit(`/bare-`"git"`-string spawn must appear in ALLOWLIST below, each with a one-line
//      reason. A NEW bypass site therefore fails here until someone decides, in writing, that it is genuinely off the
//      canonical path (or routes it through the helper).
//  (3) GLOBAL, NO ALLOWLIST (card b5416a46, widened by Code Review 201f0c7e): no file anywhere under src/** spawns
//      git via a literal bare "git" command, in EITHER of two shapes — see this check's own comment, below, for the
//      full reasoning: an ARGUMENT-shaped match (`("git", ` — CALLEE-AGNOSTIC, catches an aliased/local-variable
//      wrapper around spawn/execFile*/exec* just as readily as the real name) and a SHELL-STRING-shaped match
//      (`exec(`/`execSync("git ` — callee-SCOPED to those two specific names, deliberately NOT widened further; see
//      the check's own comment for the false-positive trap that scoping avoids). Every such site (strict,
//      allowlisted, or not) must resolve the binary via the shared chokepoint instead (`boundedSimpleGit`'s own
//      internal `resolveWin32GitBinary()`, or `resolveGitBinaryForSpawn()` for a raw child-process spawn) so win32
//      never falls back to a bare, hijackable PATH lookup. This is WHY (1)'s/(2)'s own literal-`"git"` patterns
//      above now find nothing real post-b5416a46 — every legitimate site calls the resolver instead of writing the
//      literal.
//
// GAPS, NAMED (this does NOT cover): a git call reached through a factory that returns a NON-canonical instance
// (e.g. an injected `gitFactory` test seam — used as-is by design); a `simple-git` import spelled differently
// (aliased import); a raw child-process git call whose command is a variable NOT sourced from the shared resolver
// (check (3) only catches the LITERAL `"git"` string shape, not an arbitrary unresolved variable); an ALIASED/
// renamed `exec`/`execSync` import feeding the shell-string shape (PAT_SHELLSTRING is callee-scoped, by design —
// see that check's own comment); a shell-string command built via `cmd /c git ...`, a template-literal
// interpolation, or any other shape that doesn't literally start the string with the bare word `git`.
//
// Run: node packages/daemon/test/canonical-git-helper-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TEST_DIR, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const STRICT = ["git/worktrees.ts", "git/batch-merge.ts", "git/mainline-watch.ts"];

// Files that build git directly and are deliberately NOT the canonical merge path. Path (relative to src/) -> reason.
const ALLOWLIST = {
  "git/bounded.ts": "the helper module itself — the only place simpleGit() is constructed",
  "git/writer.ts": "human-only REST checkout/commit/push surface (a trust boundary of its own, card f7a80d76); not the daemon's merge path",
  "git/reader.ts": "read-only log/branches view for the UI; never merges or lands anything",
  "git/unanchored-comment-blocks.ts": "read-only diff scan for the comment-anchor advisory; never merges",
  "runs/snapshot.ts": "run snapshot of the project's own working tree; not a merge",
  "sessions/service.ts": "worktree GC/size probes via boundedGit(); no merge or content judgement",
  "setup/bootstrap.ts": "`git init` of a brand-new project dir; no shared worker-writable .git exists yet",
  "orchestration/restart.ts": "supervisor-liveness ancestry check; reads only",
  "vault/versioner.ts": "an ordinary (non-merge-eligible) vault is the human's OWN notes repo, never touched by a worker/merge, so plain boundedSimpleGit is fine there; a merge-eligible shared vault (card bf11ac3f) IS a real canonical repo a worker merge can touch, but that path's own add/commit already route through the shared killableCanonicalRaw — the canonical shape is never left unprotected, only the ordinary-vault construction is off-path",
};
// NOTE (card b5416a46): `deploy-staleness.ts`, `skills/assets-git-status.ts`, `mcp/decisions.ts` and
// `pty/codex-doctrine.ts` used to be allowlisted here for a raw literal `execFileSync("git", …)`/
// `spawn("git", …)`/`execFile("git", …)` — each now resolves the binary via the shared chokepoint
// (`resolveGitBinaryForSpawn()`) instead, so none of them match `constructsGit()`'s literal-"git" pattern
// any more and they were REMOVED from ALLOWLIST (a listed-but-no-longer-matching entry fails the
// stale-entry check below by design). They're still read-only, still off the canonical merge path — they
// just no longer need a carve-out from check (2) because they no longer spawn a bare, unresolved "git" at
// all; check (3) below is what now covers them (and every other file) instead.

// `canonicalRaw(` is the exported test seam that takes a caller-supplied prefix-builder: no production caller may use it (canonicalGit's own `raw` is the only one).
const BARE_SIMPLE_GIT = /\b(?:boundedSimpleGit|simpleGit|canonicalRaw)\s*\(/;
const SPAWN_GIT = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["'`]git["'`]/g;
const SPAWN_GIT_OK = /\bspawn\s*\(\s*["'`]git["'`]\s*,\s*\[\s*\.\.\.CANONICAL_GIT_CONFIG_ARGS\s*,/g;

/** Violations in a STRICT file's raw text. */
export function strictViolations(raw) {
  const t = stripComments(raw);
  const v = [];
  if (BARE_SIMPLE_GIT.test(t)) v.push("bare boundedSimpleGit(/simpleGit(/canonicalRaw( call — use canonicalGit");
  const all = (t.match(SPAWN_GIT) ?? []).length;
  const ok = (t.match(SPAWN_GIT_OK) ?? []).length;
  if (all !== ok) v.push(`${all - ok} raw child-process git call(s) without ...CANONICAL_GIT_CONFIG_ARGS`);
  return v;
}
/** Does a file (raw text) construct git directly at all? (the whole-tree trigger) */
export function constructsGit(raw) {
  const t = stripComments(raw);
  return BARE_SIMPLE_GIT.test(t) || new RegExp(SPAWN_GIT.source).test(t);
}

// ── Self-test: the scanner can FAIL (RED demo on known-bad text) and is quiet on known-good text.
check("(self) a bare boundedSimpleGit( call in a strict file is flagged", strictViolations("const g = boundedSimpleGit(p, 1);").length === 1);
check("(self) a canonicalRaw( call (the prefix-builder test seam) is flagged in a strict file", strictViolations("await canonicalRaw(g, args, () => []);").length === 1);
check("(self) a bare simpleGit( call is flagged", strictViolations("const g = simpleGit(p);").length === 1);
check("(self) a raw spawn(\"git\", [...]) without the canonical args is flagged", strictViolations('spawn("git", ["ls-tree"], {});').length === 1);
check("(self) execFileSync(\"git\") is flagged in a strict file", strictViolations('execFileSync("git", ["show"]);').length === 1);
check("(self) spawn(\"git\", [...CANONICAL_GIT_CONFIG_ARGS, …]) is accepted", strictViolations('spawn("git", [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree"], {});').length === 0);
check("(self) canonicalGit( is accepted", strictViolations("const g = canonicalGit(p, 1);").length === 0);
check("(self) a mention inside a comment is NOT a call", strictViolations("// boundedSimpleGit(x) and simpleGit(y)\n/* spawn(\"git\", []) */\nconst a = 1;").length === 0);

// ── (1) STRICT files.
for (const rel of STRICT) {
  const raw = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
  const v = strictViolations(raw);
  check(`(strict) ${rel}: every canonical-path git call routes through canonicalGit / CANONICAL_GIT_CONFIG_ARGS${v.length ? ` — ${v.join("; ")}` : ""}`, v.length === 0);
}

// ── (2) WHOLE-TREE: an unlisted file that constructs git directly fails.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const allSrcFiles = walk(SRC_DIR);
const found = [];
for (const abs of allSrcFiles) {
  const rel = path.relative(SRC_DIR, abs).replace(/\\/g, "/");
  if (STRICT.includes(rel)) continue;
  if (constructsGit(fs.readFileSync(abs, "utf8"))) found.push(rel);
}
const unlisted = found.filter((r) => !(r in ALLOWLIST));
check(`(tree) every OTHER file constructing git directly is in the allowlist with a reason${unlisted.length ? ` — UNLISTED: ${unlisted.join(", ")}` : ""}`, unlisted.length === 0);
const stale = Object.keys(ALLOWLIST).filter((r) => !found.includes(r));
check(`(tree) no STALE allowlist entry (each listed file still constructs git directly)${stale.length ? ` — STALE: ${stale.join(", ")}` : ""}`, stale.length === 0);
check("(tree) the scan is non-vacuous: it saw the helper module and at least 5 constructing files", found.includes("git/bounded.ts") && found.length >= 5);

// ── (3) GLOBAL, NO ALLOWLIST (card b5416a46, widened by Code Review 201f0c7e): nothing anywhere under
// src/** spawns git via a literal bare "git" command — the absolute-resolution chokepoint
// (`resolveWin32GitBinary()` / `resolveGitBinaryForSpawn()`, both in git/bounded.ts) replaces every such
// call. Unlike (1)/(2) above, this scans STRICT and allowlisted files too: there is no legitimate reason
// for ANY file, anywhere, to write the literal "git" as a direct spawn command once every real call site
// resolves it instead.
//
// TWO independent shapes, CALLEE-AGNOSTIC where that's actually possible:
//  PAT_ARRAY — `(` + optional space + a quoted "git"/"git.exe" token + a comma, with NO requirement on
//    what precedes the `(`. This is what the original (pre-201f0c7e) version of this check missed: it
//    only matched a FIXED callee-name list (spawn/spawnSync/execFile/execFileSync/exec/execSync), so a
//    local alias — `const runGit = execFileSync; runGit("git", [...])` (the EXACT shape
//    `vault/versioner.ts`'s `flushSync` used before card b5416a46 fixed it, via `this.gitDeps.
//    flushExecFileSyncImpl ?? execFileSync`) — passed clean. Matching on the ARGUMENT shape instead of
//    the callee name closes that gap regardless of what the function is named or imported as.
//  PAT_SHELLSTRING — `exec`/`execSync` specifically (NOT callee-agnostic — see the reason below) + `(` +
//    a quoted string starting with "git" followed by whitespace (the git subcommand continues inside
//    that SAME string, e.g. `execSync("git config user.name")` — the exact shape this check's own
//    development found LIVE and unfixed in `hasConfiguredGitIdentitySync` (vault/versioner.ts), closed by
//    this same commit). Scoped to `exec`/`execSync` BY DESIGN, not widened to every callee name the way
//    PAT_ARRAY is: `spawn`/`spawnSync`/`execFile`/`execFileSync` all take an args ARRAY as a separate
//    parameter and structurally cannot have a "whole command as one string" shape at all, so there is
//    nothing for a callee-agnostic version of this fragment to generalize over — widening the argument
//    pattern itself (`["'\`]git\s` with no callee anchor) was tried and REJECTED: on this real repo it
//    false-positived on nine genuinely unrelated call sites, all of them a plain diagnostic/log STRING
//    that happens to start with the English word "git " (e.g. `unavailable("git log returned no HEAD
//    commit...")`, `warnDegraded(\`git grep exceeded ...\`)`) — those are messages, not spawns, and a
//    check that can't tell the two apart stops being trustworthy. A RENAMED/aliased `exec`/`execSync`
//    import is therefore a residual gap for THIS fragment specifically (named below), accepted rather
//    than chasing it into the same false-positive trap.
const PAT_ARRAY = /\(\s*["'`]git(?:\.exe)?["'`]\s*,/;
const PAT_SHELLSTRING = /\b(?:exec|execSync)\s*\(\s*["'`]git(?:\.exe)?\s/;
const BARE_GIT_LITERAL_SPAWN = new RegExp(`${PAT_ARRAY.source}|${PAT_SHELLSTRING.source}`);
check("(self) a literal bare git spawn (array form) is flagged by the global no-allowlist check", BARE_GIT_LITERAL_SPAWN.test(stripComments('execFileSync("git", ["log"]);')));
check("(self) a literal bare git spawn via an ALIASED callee (the exact vault/versioner.ts flushSync shape) is flagged — callee-agnostic", BARE_GIT_LITERAL_SPAWN.test(stripComments('const runGit = execFileSync;\nrunGit("git", ["status", "--porcelain"], opts);')));
check("(self) a literal bare git spawn via an aliased IMPORT is flagged — callee-agnostic", BARE_GIT_LITERAL_SPAWN.test(stripComments('import { execFileSync as runGit } from "node:child_process";\nrunGit("git", ["add", "-A"], opts);')));
check("(self) a literal bare git shell-string spawn (the hasConfiguredGitIdentitySync shape) is flagged", BARE_GIT_LITERAL_SPAWN.test(stripComments('const name = execSync("git config user.name", opts).toString();')));
check("(self) a spawn via the resolver (not a literal) is NOT flagged by the global check", !BARE_GIT_LITERAL_SPAWN.test(stripComments('execFileSync(resolveGitBinaryForSpawn(), ["log"]);')));
check("(self) a mention inside a comment is NOT flagged by the global check", !BARE_GIT_LITERAL_SPAWN.test(stripComments('// execFileSync("git", []);\nconst a = 1;')));
check("(self) an unrelated diagnostic/log string starting with the word \"git\" is NOT flagged — the false-positive trap PAT_SHELLSTRING's callee scoping avoids", !BARE_GIT_LITERAL_SPAWN.test(stripComments('unavailable("git log returned no HEAD commit (a commitless repo?)", "could-not-measure", baked);')));
const bareLiteralHits = [];
for (const abs of allSrcFiles) {
  const rel = path.relative(SRC_DIR, abs).replace(/\\/g, "/");
  if (BARE_GIT_LITERAL_SPAWN.test(stripComments(fs.readFileSync(abs, "utf8")))) bareLiteralHits.push(rel);
}
check(`(global) no file anywhere under src/** spawns git via a literal bare "git" command, array- or shell-string-form (every site resolves the binary via the shared chokepoint)${bareLiteralHits.length ? ` — FOUND: ${bareLiteralHits.join(", ")}` : ""}`, bareLiteralHits.length === 0);

// ── (4) card 7ebb4acf (Code Review S3) — the info/grafts + .git/shallow + commit-graph neutralization
// reaches BOTH canonicalGit AND the raw-spawn path (spawnCanonicalGitTree), and CANONICAL_GIT_CONFIG
// carries core.commitGraph=false. Source-text only (bounded.ts itself) — behavioral proof is
// canonical-git-graft-shallow-neutralization.mjs.
const BOUNDED_PATH = path.join(SRC_DIR, "git", "bounded.ts");
const ENV_PREPARE_SITE_RE = /env:\s*prepareCanonicalEnv\(/g;
const GRAFT_SENTINEL_RE = /GIT_GRAFT_FILE:\s*freshGitSentinelPath\(/;
const SHALLOW_SENTINEL_RE = /GIT_SHALLOW_FILE:\s*freshGitSentinelPath\(/;
const COMMIT_GRAPH_CONFIG_RE = /CANONICAL_GIT_CONFIG\s*=\s*\[[^\]]*["']core\.commitGraph=false["']/;

/** @returns {{ rawSpawnSiteCount: number, graftSentinelSet: boolean, shallowSentinelSet: boolean, commitGraphDisabled: boolean }} */
export function checkGraftShallowGraphWiring(raw) {
  const t = stripComments(raw);
  return {
    rawSpawnSiteCount: (t.match(ENV_PREPARE_SITE_RE) ?? []).length,
    graftSentinelSet: GRAFT_SENTINEL_RE.test(t),
    shallowSentinelSet: SHALLOW_SENTINEL_RE.test(t),
    commitGraphDisabled: COMMIT_GRAPH_CONFIG_RE.test(t),
  };
}

// (self) RED demo: removing each piece flips its own check, independently.
{
  const good = 'const CANONICAL_GIT_CONFIG = ["core.useReplaceRefs=false", "core.commitGraph=false"];\n'
    + 'function a() { return { env: prepareCanonicalEnv(env) }; }\n'
    + 'function b() { return { env: prepareCanonicalEnv(env) }; }\n'
    + 'function prepareCanonicalEnv() { return { GIT_GRAFT_FILE: freshGitSentinelPath("graft"), GIT_SHALLOW_FILE: freshGitSentinelPath("shallow") }; }\n';
  const w = checkGraftShallowGraphWiring(good);
  check("(self) the wiring check reads 2 raw-spawn sites + both sentinels + commitGraph=false on known-good text", w.rawSpawnSiteCount === 2 && w.graftSentinelSet && w.shallowSentinelSet && w.commitGraphDisabled);
  check("(self) removing the SECOND raw-spawn site drops the count to 1 — RED", checkGraftShallowGraphWiring(good.replace('function b() { return { env: prepareCanonicalEnv(env) }; }\n', "")).rawSpawnSiteCount === 1);
  check("(self) removing GIT_GRAFT_FILE's sentinel call flips graftSentinelSet false — RED", !checkGraftShallowGraphWiring(good.replace('GIT_GRAFT_FILE: freshGitSentinelPath("graft")', "GIT_GRAFT_FILE: undefined")).graftSentinelSet);
  check("(self) removing GIT_SHALLOW_FILE's sentinel call flips shallowSentinelSet false — RED", !checkGraftShallowGraphWiring(good.replace('GIT_SHALLOW_FILE: freshGitSentinelPath("shallow")', "GIT_SHALLOW_FILE: undefined")).shallowSentinelSet);
  check("(self) removing core.commitGraph=false flips commitGraphDisabled false — RED", !checkGraftShallowGraphWiring(good.replace(', "core.commitGraph=false"', "")).commitGraphDisabled);
  check("(self) a mention inside a comment is NOT matched (comment-stripped first)", checkGraftShallowGraphWiring("// env: prepareCanonicalEnv(env)\nconst a = 1;").rawSpawnSiteCount === 0);
}

// ── the real file ──
const boundedWiring = checkGraftShallowGraphWiring(fs.readFileSync(BOUNDED_PATH, "utf8"));
check(`(wiring) exactly 2 raw-spawn sites in git/bounded.ts pass env: prepareCanonicalEnv( (both rawViaDirectSpawn and rawViaWinJobLauncher) — found ${boundedWiring.rawSpawnSiteCount}`, boundedWiring.rawSpawnSiteCount === 2);
check("(wiring) prepareCanonicalEnv sets GIT_GRAFT_FILE via freshGitSentinelPath", boundedWiring.graftSentinelSet);
check("(wiring) prepareCanonicalEnv sets GIT_SHALLOW_FILE via freshGitSentinelPath", boundedWiring.shallowSentinelSet);
check("(wiring) CANONICAL_GIT_CONFIG carries core.commitGraph=false", boundedWiring.commitGraphDisabled);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
