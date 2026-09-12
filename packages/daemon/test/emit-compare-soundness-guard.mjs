import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// EMIT-COMPARE SOUNDNESS PRECONDITION GUARD (card 2154b6ad, Code Review requirement; extended by card
// bafc68e7 to cover the daemon+shared scope too). `computeEmitCompareGate` (git/worktrees.ts) and
// `computeAncestorBehaviouralMatch` (deploy-staleness.ts) each compare a CHANGED compiled file's
// transpiled output IN ISOLATION. That is only sound if no OTHER (unchanged) file's compiled behavior can
// depend on a changed file's TYPE-only content. Two known TypeScript mechanisms could break that:
//   - `emitDecoratorMetadata` — reflects a decorated member's TYPE into runtime metadata another file
//     could read.
//   - `const enum` — its members are INLINED at every use site program-wide, so a value edit in the enum's
//     own file silently changes every OTHER file that references it, invisibly to a single-file compare.
// `emitCompareSoundnessOk` (`emit-compare-soundness.ts`, re-implemented here structurally, see below)
// checks BOTH live, PARAMETERIZED BY SCOPE: `git/worktrees.ts` calls it daemon-only, `deploy-staleness.ts`
// calls it daemon+shared. This file is the regression test for that check staying correct under BOTH
// scopes, run against the REAL repo (must currently PASS — the mechanism is only shipped because neither
// condition holds today, in either scope) plus synthetic controls proving the check can actually FAIL when
// the precondition is violated, AND that the scope *parameter* discriminates on a synthetic tree (a check
// that only ever returns "sound" is not evidence of anything). That last control (§F) proves the
// PARAMETER discriminates, never that either caller's REAL, hand-copied-here scope constant is covered —
// (G)/(H) below close exactly that gap (card 8abf427f, off Code Review F3/F5 on card bafc68e7): they read
// the REAL `WORKTREES_EMIT_COMPARE_SCOPE`/`DEPLOY_STALENESS_EMIT_COMPARE_SCOPE` object literals as TEXT out
// of git/worktrees.ts/deploy-staleness.ts and assert they still match DAEMON_SCOPE/DAEMON_SHARED_SCOPE
// below, so a production scope narrowing (or an unnoticed widening) now flips (G) red instead of passing
// silently. Because (G) reads real packages/daemon/src/**/*.ts SOURCE TEXT and pattern-matches it — a
// genuinely NEW read, not already re-verified live the way (A)/(E)'s const-enum walk is (see
// git/worktrees.ts's own shape-(6) doc for why THAT walk needs no seat) — this file is a real member of
// `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (git/worktrees.ts); see that list's own entry for this file.
//
// Code Review (manager #128): `emitDecoratorMetadata` is checked in BOTH files of the daemon's real
// `extends` chain — `tsconfig.base.json` AND `packages/daemon/tsconfig.json` (which extends the base and
// carries its OWN `compilerOptions` block). An earlier version of `emitCompareSoundnessOk` read only the
// base file, so the flag added to the PACKAGE file instead was invisible to it — see (A2) below, the
// regression coverage for that specific hole.
//
// WHY RE-IMPLEMENTED HERE RATHER THAN IMPORTING emitCompareSoundnessOk (card bafc68e7's own decision
// record repeats this — see `docs/decisions/bafc68e7-emit-compare-soundness-shared-scope.md`'s "Do not"):
// the production function reads real worktree PATHS, not injectable text — re-deriving its checks here
// directly against real/fixture file content is simpler than standing up a throwaway git worktree per
// case, keeps this guard exercisable with plain fs (matching this repo's other static guards), and means
// an accidental future import can't make this guard pass by construction. Both regexes/scopes below are
// copied verbatim from `emit-compare-soundness.ts` — if that module's checks or either caller's real scope
// ever change, this file's own copies must be updated in lockstep or this guard silently stops testing the
// real thing.
//
// Run: node packages/daemon/test/emit-compare-soundness-guard.mjs (no build needed — pure fs/regex)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Kept in lockstep with worktrees.ts's own CONST_ENUM — see that copy's doc for why this requires the
// actual declaration shape (`const enum <Identifier> {`) rather than a bare word-adjacency match: a looser
// pattern false-positived on this repo's OWN doc comments explaining the mechanism (discovered by actually
// running this exact check against this exact repo before shipping it, not by inspection).
const CONST_ENUM = /\bconst\s+enum\s+[A-Za-z_$][\w$]*\s*\{/;

function walkTsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// The two REAL production scopes, copied verbatim from git/worktrees.ts's WORKTREES_EMIT_COMPARE_SCOPE and
// deploy-staleness.ts's DEPLOY_STALENESS_EMIT_COMPARE_SCOPE — kept here, not imported, for the same reason
// stated above.
const DAEMON_SCOPE = {
  tsconfigRelPaths: ["tsconfig.base.json", path.join("packages", "daemon", "tsconfig.json")],
  srcDirRelPaths: [path.join("packages", "daemon", "src")],
};
const DAEMON_SHARED_SCOPE = {
  tsconfigRelPaths: [...DAEMON_SCOPE.tsconfigRelPaths, path.join("packages", "shared", "tsconfig.json")],
  srcDirRelPaths: [...DAEMON_SCOPE.srcDirRelPaths, path.join("packages", "shared", "src")],
};

// Structural re-derivation of emit-compare-soundness.ts's own emitCompareSoundnessOk, parameterized the
// SAME way (never defaulted) — used by the (D)/(F) synthetic-fixture controls below; sections (A)/(A2)/(E)
// assert each sub-check individually for finer-grained PASS/FAIL reporting.
function soundnessOk(repoRoot, scope) {
  for (const tsconfigRelPath of scope.tsconfigRelPaths) {
    try {
      const raw = fs.readFileSync(path.join(repoRoot, tsconfigRelPath), "utf8");
      const opts = JSON.parse(raw).compilerOptions;
      if (opts?.emitDecoratorMetadata === true) return false;
    } catch {
      return false;
    }
  }
  try {
    for (const srcDirRelPath of scope.srcDirRelPaths) {
      for (const file of walkTsFiles(path.join(repoRoot, srcDirRelPath))) {
        if (CONST_ENUM.test(fs.readFileSync(file, "utf8"))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Text-extraction helpers for (G)/(H) (card 8abf427f) — parse an `EmitCompareSoundnessScope`-typed object
// literal out of real .ts SOURCE TEXT (never imported/executed — same injectable-text posture this whole
// guard takes per its own header). Tolerant of either a bare string literal or a `path.join(...)` call as
// an array element, the two shapes the real constants actually use — each computed through the SAME node
// `path` module both sides of the comparison already go through, so a match is platform-consistent. Fails
// closed to `null` on no match, never to an empty/partial scope, so a renamed constant or reshaped literal
// is reported as "not found" (sanity check fails loud) rather than silently comparing against nothing.
function parsePathJoinArgs(argsText) {
  const parts = [];
  const partRe = /"([^"]*)"|'([^']*)'/g;
  let m;
  while ((m = partRe.exec(argsText))) parts.push(m[1] ?? m[2]);
  return path.join(...parts);
}
function extractScopeArray(blockText, arrayName) {
  const arrMatch = new RegExp(`${arrayName}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(blockText);
  if (!arrMatch) return null;
  const elems = [];
  const elemRe = /path\.join\(([^)]*)\)|"([^"]*)"|'([^']*)'/g;
  let m;
  while ((m = elemRe.exec(arrMatch[1]))) {
    elems.push(m[1] !== undefined ? parsePathJoinArgs(m[1]) : (m[2] ?? m[3]));
  }
  return elems;
}
function extractScopeLiteral(sourceText, constName) {
  const blockMatch = new RegExp(`const\\s+${constName}\\s*:\\s*EmitCompareSoundnessScope\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(sourceText);
  if (!blockMatch) return null;
  const tsconfigRelPaths = extractScopeArray(blockMatch[1], "tsconfigRelPaths");
  const srcDirRelPaths = extractScopeArray(blockMatch[1], "srcDirRelPaths");
  if (tsconfigRelPaths === null || srcDirRelPaths === null) return null;
  return { tsconfigRelPaths, srcDirRelPaths };
}
function scopesEqual(a, b) {
  const arraysEqual = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]);
  return !!a && !!b && arraysEqual(a.tsconfigRelPaths, b.tsconfigRelPaths) && arraysEqual(a.srcDirRelPaths, b.srcDirRelPaths);
}

// ── (A) REAL REPO — the precondition must hold TODAY, or the mechanism this guard protects has no
//        business being live ─────────────────────────────────────────────────────────────────────────
{
  const tsconfigBase = JSON.parse(fs.readFileSync(path.join(repoRoot, "tsconfig.base.json"), "utf8"));
  check("(A) tsconfig.base.json does not set emitDecoratorMetadata:true", tsconfigBase.compilerOptions?.emitDecoratorMetadata !== true);

  // (A2) THE PACKAGE FILE — the specific hole found in Code Review: an earlier version of
  // emitCompareSoundnessOk read only tsconfig.base.json above, so this file was invisible to it.
  const tsconfigPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "daemon", "tsconfig.json"), "utf8"));
  check("(A2) packages/daemon/tsconfig.json really does extend the base config (sanity: this is the real chain, not an assumption)", tsconfigPackage.extends === "../../tsconfig.base.json");
  check("(A2) packages/daemon/tsconfig.json does not set emitDecoratorMetadata:true", tsconfigPackage.compilerOptions?.emitDecoratorMetadata !== true);

  const srcDir = path.join(repoRoot, "packages", "daemon", "src");
  const tsFiles = walkTsFiles(srcDir);
  check("(A) walked a non-trivial number of real source files (sanity: the walk itself works)", tsFiles.length > 50);
  const hits = tsFiles.filter((f) => CONST_ENUM.test(fs.readFileSync(f, "utf8")));
  check("(A) no `const enum` declaration exists under packages/daemon/src today", hits.length === 0);
}

// ── (B) POSITIVE CONTROL for the regex's word boundary — pty/host.ts's own `const enumerate = ...` MUST
//        NOT trip the check (a same-prefix identifier is not the `const enum` keyword pair) ────────────
{
  const hostTs = fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "pty", "host.ts"), "utf8");
  check("(B) pty/host.ts really does contain `const enumerate =` (the query and path both work; this is not a vacuous absence)", /const enumerate\s*=/.test(hostTs));
  check("(B) the const-enum regex does NOT match `const enumerate =` (word-boundary correctness)", !CONST_ENUM.test("const enumerate = deps.enumerate ?? x;"));
}

// ── (C) NEGATIVE CONTROL — prove the check can actually FAIL: a synthetic fixture file containing a
//        genuine `const enum` declaration MUST trip it. Without this, (A) passing is indistinguishable
//        from a broken/vacuous check that always returns "sound" ─────────────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsg-"));
  try {
    const fixture = path.join(tmpDir, "fixture.ts");
    fs.writeFileSync(fixture, "const enum Direction { Up, Down }\nexport { Direction };\n");
    const hits = walkTsFiles(tmpDir).filter((f) => CONST_ENUM.test(fs.readFileSync(f, "utf8")));
    check("(C) a genuine `const enum` declaration in a fixture file DOES trip the check", hits.length === 1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── (D) NEGATIVE CONTROL for the tsconfig check itself — a synthetic tree whose tsconfig.base.json sets
//        emitDecoratorMetadata:true MUST make the re-derived soundnessOk() itself return false. (Card
//        8abf427f, Code Review F3: the prior version of this section only asserted `JSON.parse` and
//        optional-chaining behavior on an inline object literal — zero connection to any predicate, real
//        or re-derived; it passed even if the whole emit-compare feature were deleted.) ─────────────────
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsg-decorator-"));
  try {
    fs.writeFileSync(path.join(tmpRepo, "tsconfig.base.json"), '{"compilerOptions":{"emitDecoratorMetadata":true}}\n');
    fs.mkdirSync(path.join(tmpRepo, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "packages", "daemon", "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(tmpRepo, "packages", "daemon", "src", "clean.ts"), "export const x = 1;\n");
    check(
      "(D) a tsconfig.base.json with emitDecoratorMetadata:true DOES trip the re-derived soundnessOk() to false",
      soundnessOk(tmpRepo, DAEMON_SCOPE) === false,
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

// ── (E) REAL REPO, WIDER SCOPE (card bafc68e7) — deploy-staleness.ts's own daemon+shared coverage must
//        ALSO hold true today, over and above (A)'s daemon-only checks ─────────────────────────────────
{
  const tsconfigShared = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "shared", "tsconfig.json"), "utf8"));
  check("(E) packages/shared/tsconfig.json does not set emitDecoratorMetadata:true", tsconfigShared.compilerOptions?.emitDecoratorMetadata !== true);

  const sharedSrcDir = path.join(repoRoot, "packages", "shared", "src");
  const sharedTsFiles = walkTsFiles(sharedSrcDir);
  check("(E) walked a non-trivial number of real packages/shared/src files (sanity: not scanning an empty dir)", sharedTsFiles.length > 0);
  const sharedHits = sharedTsFiles.filter((f) => CONST_ENUM.test(fs.readFileSync(f, "utf8")));
  check("(E) no `const enum` declaration exists under packages/shared/src today", sharedHits.length === 0);

  check("(E) the real repo is SOUND under the full daemon+shared scope (deploy-staleness.ts's own coverage)", soundnessOk(repoRoot, DAEMON_SHARED_SCOPE) === true);
}

// ── (F) DISCRIMINATING CONTROL (card bafc68e7) — prove the SCOPE PARAMETER ITSELF discriminates: a
//        violation planted ONLY under a shared-scope-shaped src dir must be INVISIBLE to the daemon-only
//        scope object and CAUGHT by the daemon+shared scope object on the exact SAME tree — "what would
//        this print if the feature were broken?" CORRECTED (Code Review F3): this does NOT prove anything
//        about the REAL production scope constants (`WORKTREES_EMIT_COMPARE_SCOPE` in worktrees.ts,
//        `DEPLOY_STALENESS_EMIT_COMPARE_SCOPE` in deploy-staleness.ts) — this file never reads either one;
//        `DAEMON_SCOPE`/`DAEMON_SHARED_SCOPE` just below are hand-copied literals, per this file's own
//        header. A caller that silently narrowed its REAL scope constant would NOT be caught by this
//        control alone — (G)/(H) below close that gap (card 8abf427f) by reading the real literals. ─────
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ecsg-scope-"));
  try {
    fs.writeFileSync(path.join(tmpRepo, "tsconfig.base.json"), "{}\n");
    fs.mkdirSync(path.join(tmpRepo, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "packages", "daemon", "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(tmpRepo, "packages", "daemon", "src", "clean.ts"), "export const x = 1;\n");

    fs.mkdirSync(path.join(tmpRepo, "packages", "shared", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "packages", "shared", "tsconfig.json"), "{}\n");
    fs.writeFileSync(
      path.join(tmpRepo, "packages", "shared", "src", "violating.ts"),
      "const enum Direction { Up, Down }\nexport { Direction };\n",
    );

    // Code Review nitpick: this used to be TWO checks calling the identical expression under two labels
    // ("sanity" and "DAEMON-only scope reads SOUND") — collapsed to one; a real duplicate assertion adds
    // no coverage, only the appearance of it.
    check("(F) DAEMON-only scope reads SOUND on this tree — it never looks at packages/shared/src at all (control isn't vacuous)", soundnessOk(tmpRepo, DAEMON_SCOPE) === true);
    check(
      "(F) DISCRIMINATING: the SAME tree under DAEMON+SHARED scope reads NOT-sound — the real violation lives only in the wider scope's own coverage",
      soundnessOk(tmpRepo, DAEMON_SHARED_SCOPE) === false,
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

// ── (G) REAL PRODUCTION SCOPE CONSTANTS (card 8abf427f, closing the gap (F)'s own header names) — read the
//        ACTUAL `WORKTREES_EMIT_COMPARE_SCOPE` (git/worktrees.ts) and `DEPLOY_STALENESS_EMIT_COMPARE_SCOPE`
//        (deploy-staleness.ts) object literals as TEXT and assert they still match this guard's own
//        hand-copied DAEMON_SCOPE/DAEMON_SHARED_SCOPE above. (A)/(A2)/(E)/(F) above only ever exercise this
//        file's OWN copies — a real caller silently NARROWING its production scope (e.g. dropping
//        packages/shared/src from deploy-staleness.ts's coverage) changed nothing any of them could see,
//        because nothing above ever reads the real constant. This section does. ───────────────────────────
{
  const worktreesSrcText = fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "git", "worktrees.ts"), "utf8");
  const deployStalenessSrcText = fs.readFileSync(path.join(repoRoot, "packages", "daemon", "src", "deploy-staleness.ts"), "utf8");

  const realWorktreesScope = extractScopeLiteral(worktreesSrcText, "WORKTREES_EMIT_COMPARE_SCOPE");
  check("(G) sanity: WORKTREES_EMIT_COMPARE_SCOPE literal was found and parsed out of the real git/worktrees.ts source", realWorktreesScope !== null);
  check(
    "(G) the REAL git/worktrees.ts WORKTREES_EMIT_COMPARE_SCOPE matches this guard's own DAEMON_SCOPE copy — a production narrowing/widening here is now caught",
    scopesEqual(realWorktreesScope, DAEMON_SCOPE),
  );

  const realDeployStalenessScope = extractScopeLiteral(deployStalenessSrcText, "DEPLOY_STALENESS_EMIT_COMPARE_SCOPE");
  check("(G) sanity: DEPLOY_STALENESS_EMIT_COMPARE_SCOPE literal was found and parsed out of the real deploy-staleness.ts source", realDeployStalenessScope !== null);
  check(
    "(G) the REAL deploy-staleness.ts DEPLOY_STALENESS_EMIT_COMPARE_SCOPE matches this guard's own DAEMON_SHARED_SCOPE copy — a production narrowing/widening here is now caught",
    scopesEqual(realDeployStalenessScope, DAEMON_SHARED_SCOPE),
  );
}

// ── (H) NEGATIVE CONTROL for (G) — prove the extraction+comparison mechanism can actually FAIL: synthetic
//        source text shaped exactly like the real declaration but with ONE path element removed (the
//        textual shape a real narrowing takes) MUST be reported as a mismatch, not silently accepted ────
{
  const narrowedSourceText = `
const WORKTREES_EMIT_COMPARE_SCOPE: EmitCompareSoundnessScope = {
  tsconfigRelPaths: ["tsconfig.base.json"],
  srcDirRelPaths: [path.join("packages", "daemon", "src")],
};
`;
  const extracted = extractScopeLiteral(narrowedSourceText, "WORKTREES_EMIT_COMPARE_SCOPE");
  check("(H) sanity: the narrowed fixture text itself still parses (control isn't vacuous)", extracted !== null);
  check(
    "(H) DISCRIMINATING: a scope literal missing one tsconfig path (the textual shape a real narrowing takes) is correctly reported as NOT matching the real DAEMON_SCOPE copy",
    extracted !== null && scopesEqual(extracted, DAEMON_SCOPE) === false,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the real repo satisfies the soundness precondition today under BOTH the daemon-only scope (git/worktrees.ts) and the daemon+shared scope (deploy-staleness.ts), pty/host.ts's `const enumerate` identifier does not false-positive, the const-enum/emitDecoratorMetadata fixtures prove the checks can genuinely fail, a violation planted only under packages/shared/src is invisible to a daemon-only SCOPE OBJECT but caught by a daemon+shared SCOPE OBJECT on the identical tree (proving the scope PARAMETER discriminates), AND the REAL git/worktrees.ts + deploy-staleness.ts scope constants — read as text, not hand-copied — still match this guard's own copies (proving a production scope narrowing would now be caught, not just a synthetic one)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
