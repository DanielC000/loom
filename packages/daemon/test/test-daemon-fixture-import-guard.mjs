// test-daemon-fixture-import-guard.mjs — fails fast when writeRealTestDaemonScript's hand-maintained
// fixture file list misses a real static import of scripts/test-daemon.mjs (card 5d4765b9).
//
// WHY THIS EXISTS: test/_emit-compare-fixtures.mjs's writeRealTestDaemonScript writes a REAL, self-
// resolving copy of scripts/test-daemon.mjs — plus a HAND-MAINTAINED list of its local sibling modules —
// into synthetic fixture repos (see that function's own header doc). ESM resolves STATIC imports
// eagerly, so when test-daemon.mjs (or one of its mirrored siblings) gains a NEW static relative import
// that isn't ALSO added to that hand-maintained list, every synthetic fixture repo's written copy fails
// module resolution at dynamic-import time, before any of its own code runs — and the loaders that depend
// on this (`loadExcludedTestDirNames`/`loadNotHermeticNames`, git/worktrees.ts) silently fall back to
// their fail-closed branch. That reads as "not reducible" rather than as a real failure, so every
// emit-compare / batch-merge-reduced-gate scenario that exercises them falls to the full gate — far from
// the actual cause. This trap has fired at least twice (op a450e3dd / card 89ab1e01's own original
// top-level `_codex-real-spawn-lock.mjs` import — fixed by making that import LAZY instead, per
// `@decision 3791b14e` in scripts/test-daemon.mjs — and again per card fc53ea74's own branch). Only a
// header comment on `writeRealTestDaemonScript` guarded against a repeat before this file.
//
// SCOPE, DELIBERATELY: STATIC relative imports only (`import ... from "./x.mjs"` / `export ... from
// "./x.mjs"` / a bare side-effect `import "./x.mjs";`), transitively through each discovered local
// sibling's OWN static imports — never a dynamic `await import(...)`. This matches the design
// `@decision 3791b14e` already established: the two loaders above only ever read test-daemon.mjs's
// EXPORTS, never execute its `isMain()` body, so a sibling reachable ONLY via a lazy, call-site dynamic
// import (`_codex-real-spawn-lock.mjs`, `scripts/lib/gate-timing-retention.mjs`) is never actually needed
// by them — scanning dynamic imports here would false-flag that deliberate exemption.
//
// Comment-stripped first (`_strip-comments.mjs`) so a decision comment merely MENTIONING a relative path
// (this file's own header is full of them) can never be mistaken for a real import line.
//
// Run: 1) build the daemon (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/test-daemon-fixture-import-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "./_strip-comments.mjs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const ENTRY_ABS = path.join(REPO_ROOT, "packages", "daemon", "scripts", "test-daemon.mjs");

// Matches a STATIC `import ... from "./relative"` / `export ... from "./relative"` line, or a bare
// side-effect `import "./relative";` line — never a dynamic `await import(...)` call: that has no `from`
// keyword, and `import(` has no whitespace before its `(`, so neither pattern below can ever match it.
const STATIC_IMPORT_FROM_RE = /^(?:import|export)\s+[^"']*\bfrom\s+["'](\.[^"']+)["']\s*;?\s*$/;
const STATIC_SIDE_EFFECT_IMPORT_RE = /^import\s+["'](\.[^"']+)["']\s*;?\s*$/;

/** Every RELATIVE specifier (`./…`/`../…`) a STATIC import/export-from/side-effect-import line in `text`
 *  names — comment-stripped first, so a comment merely MENTIONING a path never counts. A bare-specifier
 *  import (`"node:fs"`, a bare package name) never matches either pattern (both require the quoted text
 *  to start with a literal `.`), so only relative siblings are ever returned. */
function extractStaticRelativeImports(text) {
  const specifiers = new Set();
  for (const raw of stripComments(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(STATIC_IMPORT_FROM_RE) || line.match(STATIC_SIDE_EFFECT_IMPORT_RE);
    if (m) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/** Transitive closure of every LOCAL module `entryAbsPath` reaches via a STATIC relative import, walking
 *  each discovered sibling's own static imports in turn. `readFile`/`pathOps` are injected (never the
 *  real `fs`/`path` directly) so the synthetic RED-proof below can drive this against in-memory fixture
 *  text with no real filesystem and no platform-specific path semantics. Returns absolute paths (in
 *  whatever shape `pathOps` uses); the entry file itself is never included — nothing needs to "cover
 *  itself". */
function collectStaticImportClosure(entryAbsPath, readFile, pathOps) {
  const closure = new Set();
  const seen = new Set([entryAbsPath]);
  const queue = [entryAbsPath];
  while (queue.length) {
    const current = queue.shift();
    const text = readFile(current);
    for (const spec of extractStaticRelativeImports(text)) {
      const resolved = pathOps.normalize(pathOps.resolve(pathOps.dirname(current), spec));
      closure.add(resolved);
      if (!seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
    }
  }
  return closure;
}

function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

// --- sanity: the extractor's own positive/negative controls, before trusting it against real content ---
{
  const synthetic = [
    'import fs from "node:fs";', // bare specifier — never relative, must not be captured
    'import { a } from "../test/_tmp-fixture.mjs";', // real shape
    'import { b } from "./temp-reaper.mjs";', // real shape, same-dir
    'import "./side-effect.mjs";', // side-effect only
    '// import { c } from "./not-real.mjs"; (a comment, never real)', // must NOT count
    'const { d } = await import("./lazy.mjs");', // dynamic, assigned — must NOT count (DoD scope)
    'await import("./also-lazy.mjs");', // dynamic, unassigned — must NOT count (DoD scope)
  ].join("\n");
  const found = extractStaticRelativeImports(synthetic);
  check("sanity: a real static named-import line IS captured", found.includes("../test/_tmp-fixture.mjs"));
  check("sanity: a real static same-dir named-import line IS captured", found.includes("./temp-reaper.mjs"));
  check("sanity: a bare side-effect import line IS captured", found.includes("./side-effect.mjs"));
  check("sanity: a bare node: specifier is NOT captured (not relative)", ![...found].some((s) => s.includes("node:")));
  check("sanity: a COMMENTED-OUT import line is NOT captured (negative control)", !found.includes("./not-real.mjs"));
  check("sanity: an assigned dynamic `await import(...)` is NOT captured (scope: static only)", !found.includes("./lazy.mjs"));
  check("sanity: a bare, unassigned dynamic `await import(...)` is NOT captured (scope: static only)", !found.includes("./also-lazy.mjs"));
  check(`sanity: exactly 3 static relative specifiers found (found ${found.length}: ${JSON.stringify(found)})`, found.length === 3);
}

// --- RED PROOF: the closure walker + missing-file check, against a SYNTHETIC in-memory fixture tree ---
{
  const files = {
    "/entry.mjs": 'import { a } from "./a.mjs";\nimport { b } from "./sub/b.mjs";\n',
    "/a.mjs": 'import { c } from "./c.mjs";\n',
    "/c.mjs": "export const c = 1;\n",
    "/sub/b.mjs": 'const { lazy } = await import("./lazy.mjs");\nexport const b = 1;\n', // lazy sibling excluded
  };
  const readFile = (p) => {
    if (!(p in files)) throw new Error(`fixture missing: ${p}`);
    return files[p];
  };
  const closure = collectStaticImportClosure("/entry.mjs", readFile, path.posix);
  const closurePaths = [...closure].sort();
  check(
    `RED-PROOF fixture: closure finds exactly the 3 statically-reachable siblings (found ${JSON.stringify(closurePaths)})`,
    closurePaths.length === 3 && closurePaths.includes("/a.mjs") && closurePaths.includes("/c.mjs") && closurePaths.includes("/sub/b.mjs"),
  );
  check("RED-PROOF fixture: the lazily-imported /lazy.mjs is correctly EXCLUDED (scope: static only)",
    !closurePaths.includes("/lazy.mjs"));

  // The missing-file check itself: a "written" set lacking one required sibling must be flagged BY NAME —
  // this is the exact shape of the real bug (op a450e3dd / fc53ea74): a sibling the real import graph
  // needs that the hand-maintained fixture list forgot.
  const writtenMissingOne = new Set(["/a.mjs", "/c.mjs"]); // /sub/b.mjs deliberately absent
  const missing = closurePaths.filter((p) => !writtenMissingOne.has(p));
  check("RED PROOF: a fixture list missing a real static sibling IS flagged, naming it",
    missing.length === 1 && missing[0] === "/sub/b.mjs");
  const writtenComplete = new Set(closurePaths);
  check("GREEN: a fixture list carrying every static sibling flags nothing",
    closurePaths.filter((p) => !writtenComplete.has(p)).length === 0);
}

// --- the real assertion: scripts/test-daemon.mjs's REAL transitive static-import closure vs. what
// writeRealTestDaemonScript ACTUALLY writes into a fixture repo ---

check(`sanity: the real entry file exists (${ENTRY_ABS})`, fs.existsSync(ENTRY_ABS));

const realClosure = collectStaticImportClosure(ENTRY_ABS, (p) => fs.readFileSync(p, "utf8"), path);
const requiredRepoRelative = [...realClosure].map(toRepoRelative).sort();
check(
  `sanity: the real closure is non-empty (found ${requiredRepoRelative.length}: ${JSON.stringify(requiredRepoRelative)})`,
  requiredRepoRelative.length > 0,
);

const { writeRealTestDaemonScript } = await import("./_emit-compare-fixtures.mjs");
const scratchDir = mkdtempManaged("test-daemon-fixture-guard-");
writeRealTestDaemonScript(scratchDir);

/** Every file writeRealTestDaemonScript actually wrote, as repo-relative POSIX paths — derived by really
 *  calling the function and walking its output, never by parsing its source: its destinations mirror the
 *  real repo-relative layout 1:1 (`path.join(repoDir, "packages", "daemon", "scripts", ...)`), so walking
 *  what it wrote IS the set of repo-relative paths it mirrors. */
function listWrittenRepoRelativePaths(repoDir) {
  const written = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else written.push(path.relative(repoDir, abs).split(path.sep).join("/"));
    }
  };
  walk(repoDir);
  return written;
}
const writtenSet = new Set(listWrittenRepoRelativePaths(scratchDir));
check(
  `sanity: writeRealTestDaemonScript wrote a non-empty fixture tree (found ${writtenSet.size}: ${JSON.stringify([...writtenSet].sort())})`,
  writtenSet.size > 0,
);

const missingFromFixtureList = requiredRepoRelative.filter((p) => !writtenSet.has(p));
check(
  `every static relative sibling scripts/test-daemon.mjs transitively imports is mirrored by writeRealTestDaemonScript's fixture file list (missing: ${JSON.stringify(missingFromFixtureList)})`,
  missingFromFixtureList.length === 0,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the static-import extractor is proven both ways on synthetic fixtures (a real import is caught, a comment/bare-specifier/dynamic-import is not), the closure walker + missing-file check is RED-PROVEN against a synthetic reproduction of the motivating incident, and every static relative sibling scripts/test-daemon.mjs's real import graph transitively reaches is currently mirrored by writeRealTestDaemonScript's fixture file list."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
