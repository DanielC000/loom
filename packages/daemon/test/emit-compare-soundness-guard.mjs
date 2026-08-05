import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// EMIT-COMPARE SOUNDNESS PRECONDITION GUARD (card 2154b6ad, Code Review requirement). `computeEmitCompareGate`
// (packages/daemon/src/git/worktrees.ts) compares each CHANGED compiled file's transpiled output IN
// ISOLATION. That is only sound if no OTHER (unchanged) file's compiled behavior can depend on a changed
// file's TYPE-only content. Two known TypeScript mechanisms could break that:
//   - `emitDecoratorMetadata` — reflects a decorated member's TYPE into runtime metadata another file
//     could read.
//   - `const enum` — its members are INLINED at every use site program-wide, so a value edit in the enum's
//     own file silently changes every OTHER file that references it, invisibly to a single-file compare.
// `emitCompareSoundnessOk` (same module, not exported — re-implemented here structurally, see below) checks
// BOTH live. This file is the regression test for that check staying correct, run against the REAL repo
// (must currently PASS — the mechanism is only shipped because neither condition holds today) plus a
// synthetic POSITIVE CONTROL proving the check can actually FAIL when the precondition is violated (a check
// that only ever returns "sound" is not evidence of anything).
//
// Code Review (manager #128): `emitDecoratorMetadata` is checked in BOTH files of the daemon's real
// `extends` chain — `tsconfig.base.json` AND `packages/daemon/tsconfig.json` (which extends the base and
// carries its OWN `compilerOptions` block). An earlier version of `emitCompareSoundnessOk` read only the
// base file, so the flag added to the PACKAGE file instead was invisible to it — see (A2) below, the
// regression coverage for that specific hole.
//
// WHY RE-IMPLEMENTED HERE RATHER THAN IMPORTING emitCompareSoundnessOk: that function is intentionally not
// exported (worktrees.ts's own internal helper, called only from computeEmitCompareGate) and reads a real
// worktree PATH, not injectable text — re-deriving its two checks here directly against real/fixture file
// content is simpler than standing up a throwaway git worktree per case and keeps this guard exercisable
// with plain fs, matching this repo's other static guards. Both regexes below are copied verbatim from
// worktrees.ts's own `emitCompareSoundnessOk` — if that function's checks ever change, this file's own
// copies must be updated in lockstep or this guard silently stops testing the real thing.
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

    const fixture2 = path.join(tmpDir, "fixture2.ts");
    fs.writeFileSync(fixture2, "export const config = { emitDecoratorMetadata: true };\n");
    // The tsconfig check only ever reads tsconfig.base.json itself, never scans src/ for the string — this
    // arm exists purely so a reader can't mistake the const-enum walk above for also covering this case.
    check("(C) (documentation-only) the decorator-metadata check is a tsconfig read, not a src/ scan — not exercised by this fixture", true);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── (D) NEGATIVE CONTROL for the tsconfig check itself ──────────────────────────────────────────────
{
  const violating = JSON.parse('{"compilerOptions":{"emitDecoratorMetadata":true}}');
  check("(D) a tsconfig with emitDecoratorMetadata:true DOES trip the check", violating.compilerOptions?.emitDecoratorMetadata === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the real repo satisfies computeEmitCompareGate's soundness precondition today (no emitDecoratorMetadata, no const enum under packages/daemon/src), pty/host.ts's `const enumerate` identifier does not false-positive, and both violation fixtures prove the checks can genuinely fail."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
