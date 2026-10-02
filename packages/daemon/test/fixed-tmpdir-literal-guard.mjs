import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs text scan below, no Db used
// STANDING GUARD (card a6b1c4c7) — catches a brand-new `path.join(os.tmpdir(), <fully fixed literal>)`
// fixture before it ships, the same shape that made merge-commit-kill-confirm.mjs's `makeRepo`/
// `makeWorktree` collide: two CONCURRENT invocations of the SAME test file (two worker `run_gate`s
// admitted at once, which now happens routinely) computed the IDENTICAL `os.tmpdir()`-relative path —
// `path.join(os.tmpdir(), \`loom-killconfirm-${tag}\`)` called as `makeRepo("positive-control")` — so one
// run's `git init -q` collided with the other's mid-init, and either run's cleanup could delete the
// other's still-live repo. Fixed by switching to `mkdtempManaged` (`_tmp-fixture.mjs`), which mints an
// atomically-unique dir regardless of what the caller passes.
//
// ⚠️ STATED SCOPE (CHECK 1 below), READ BEFORE TRUSTING A GREEN RUN: CHECK 1 only sees a literal with
// ZERO `${...}` interpolation sitting DIRECTLY as `path.join(os.tmpdir(), <here>)`'s second argument — a
// plain string or a template literal with no substitution at all. On its own it does NOT, and structurally
// cannot, catch the exact shape that caused THIS card's own incident: a parameterized helper
// (`path.join(os.tmpdir(), \`prefix-${tag}\`)`) called with a hardcoded STRING LITERAL argument for `tag`
// at one specific call site while its sibling call sites pass a genuinely per-run-unique value.
//
// CHECK 2 (card 00c356c6) closes that gap mechanically — see its own header block further down, right
// above `findFunctionBodies`, for the method, the soundness evidence (RED on a planted specimen of this
// exact incident, GREEN on the real corpus), and its own stated remaining blind spots. CHECK 2 is a bigger,
// different kind of check than CHECK 1 (call-site/parameter tracing, not a single-line regex) — same
// honesty posture as clock-path-regression-guard.mjs's own "WHAT THIS STILL CANNOT SEE" section — so a
// human reviewing a new test-fixture-constructing function should still judge whether EVERY caller
// supplies a value that varies per run; CHECK 2 narrows what that judgment has to cover, it does not
// replace it (see CHECK 2's own stated blind spots for exactly what it still misses).
//
// CHECK 1 — SAFE BY CONSTRUCTION, NEVER FLAGGED: a match whose line also contains `mkdtempSync(` —
// `fs.mkdtempSync` appends 6 kernel-random characters to whatever prefix it's given, so the literal being
// fixed is irrelevant; this is the SAME safe idiom `mkdtempManaged` (`_tmp-fixture.mjs`) wraps.
//
// CHECK 1 — BASELINE KEY = (file, trimmed line text) — not (file, line number); mirrors clock-path-
// regression-guard.mjs's own reasoning: a line-numbered key would turn an unrelated nearby edit into a
// spurious NEW violation, while editing the flagged line itself (the moment a human should re-audit it)
// correctly invalidates its baseline entry.
//
// Each entry below was individually read at card a6b1c4c7 and confirmed to never create a real
// file/directory at the literal path — grouped by the shape that makes each one safe. Re-verify a site's
// classification if its surrounding code changes; do not add a new entry here without reading what it
// actually does, per this file's own rule.
//
// ✅ CHECK 1 POSITIVE CONTROL (run manually, not part of this file's own execution):
//   1. `git show HEAD~1:packages/daemon/test/merge-commit-kill-confirm.mjs` (the pre-fix revision carried
//      `path.join(os.tmpdir(), \`loom-killconfirm-${tag}\`)`, which has interpolation, so even the OLD file
//      would not trip CHECK 1 directly — see the scope note above). To exercise CHECK 1's own detector
//      positively, temporarily add a line like `const x = path.join(os.tmpdir(), "a-fixed-name");` to any
//      test file and confirm this guard FAILS, naming it; then remove it and confirm PASS again.
//
// ✅ CHECK 2 POSITIVE CONTROL — see CHECK 2's own header block below for the full method; in short,
//   planting the exact pre-fix `makeRepo(tag)` / `makeRepo("positive-control")` incident shape in a
//   throwaway file makes CHECK 2 FAIL, naming the exact call site (verified while building this check,
//   see card 00c356c6's worker_report for the raw run).
//
// Run: node packages/daemon/test/fixed-tmpdir-literal-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// CHECK 1 — matches path.join(os.tmpdir(), <quoted literal>) on one line, either quote style. Captures
// the literal body in group 2 so the caller can test it for `${` interpolation.
const TMPDIR_JOIN_RE = /path\.join\(\s*os\.tmpdir\(\)\s*,\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*\)/g;

const KNOWN_FIXED_LITERAL_DEBT = new Map([
  // Process-wide LOCK / CACHE singleton paths — deliberately fixed (one lock, one cache, shared by design
  // across every process on the host), not a per-test fixture at all.
  ["_codex-real-spawn-lock.mjs", [
    'const LOCK_PATH = process.env.LOOM_CODEX_REAL_SPAWN_LOCK_PATH || path.join(os.tmpdir(), "loom-codex-real-spawn.lock"); // env: hermetic-test seam (card fb119c4c)',
    'const PROBE_CACHE_PATH = process.env.LOOM_CODEX_USAGE_PROBE_CACHE || path.join(os.tmpdir(), "loom-codex-usage-probe.json"); // env: hermetic-test seam',
  ]],
  // "Deliberately nonexistent codex binary" probes — LOOM_CODEX_BIN is pointed at a path that must NEVER
  // exist (simulates "codex binary missing"); nothing is ever created at it, so a fixed name is the point.
  ["batch-merge-branch-diverted-no-fallback.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-divert-unverified-nudge-text.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-diverted-not-cached.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-ff-unverified-no-fallback.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-mainline-advanced-post-ff.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["batch-merge-watermark-branch-pin.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["canonical-git-isolation.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-cgi-no-such-codex-bin");']],
  ["mainline-watch-batch-edges.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-batch.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot-dedupe.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot-reader.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-boot.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-bounds.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-ff-unverified.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-reads.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-rebind-reset.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch-spawns.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["mainline-watch.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");']],
  ["merge-confirm-dirty-gate-verdict-cache-retry-and-guard.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcdg-nonexistent-codex");']],
  ["merge-confirm-dirty-gate-verdict-cache.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcdg-nonexistent-codex");']],
  ["merge-confirm-fail-identity-void-links.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfil-nonexistent-codex");']],
  ["merge-confirm-fail-identity-void.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfiv-nonexistent-codex");']],
  ["merge-confirm-gate-tip-round-trip.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgtrt-nonexistent-codex");']],
  ["merge-confirm-gated-tip-squash.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgt-nonexistent-codex");']],
  ["merge-confirm-inert-skip-pin.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcisp-nonexistent-codex");']],
  ["merge-confirm-reuse-head-rule.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcrhr-nonexistent-codex");']],
  ["merge-confirm-solo-finalize-tip-cas.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcsf-nonexistent-codex");']],
  ["merge-reviewed-tip-refusal.mjs", ['process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mrt-no-such-codex-bin");']],
  // Pure-function / passthrough probes — the literal path is an argument value asserted to flow through
  // unchanged; nothing ever reads or writes the path on disk.
  ["comment-anchor-lint-hook.mjs", ['isInScope(REPO, path.join(os.tmpdir(), "elsewhere.ts")) === null);']],
  ["harness-adapter-delegates.mjs", ['const absolute = path.join(os.tmpdir(), "not-a-real-binary-xyz");']],
  // DB-only / config-string fixtures — the literal is stored as a STRING VALUE (a vaultPath override) and
  // compared back from the Db; never fs-read or fs-written at that path.
  ["mgmt-project-agent.mjs", ['const newVaultPath = path.join(os.tmpdir(), "new-vault");']],
  ["mgmt-surface.mjs", ['const newVaultPath = path.join(os.tmpdir(), "m2");']],
  ["platform-mgmt-surface.mjs", ['const newVaultPath = path.join(os.tmpdir(), "ord2");']],
  // DB-key-only identifiers — p1/p2 are only ever used as string keys into this file's OWN isolated,
  // per-process LOOM_HOME's sqlite db (wedged-worktree tracking); never touched on the real filesystem.
  ["worktree-wedge-retry.mjs", [
    'const p1 = path.join(os.tmpdir(), "loom-wwr-unit-1");',
    'const p2 = path.join(os.tmpdir(), "loom-wwr-unit-2");',
  ]],
]);

function baselineHas(map, file, text) {
  return map.get(file)?.includes(text) ?? false;
}

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

function classifyFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes("mkdtempSync(")) continue; // SAFE BY CONSTRUCTION — see header
    TMPDIR_JOIN_RE.lastIndex = 0;
    let m;
    while ((m = TMPDIR_JOIN_RE.exec(raw)) !== null) {
      const literal = m[2];
      if (literal.includes("${")) continue; // has interpolation — out of this guard's stated scope
      hits.push({ file, lineNo: i + 1, text: raw.trim() });
    }
  }
  return hits;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// CHECK 2 (card 00c356c6) — catches the PARAMETERIZED-HELPER shape CHECK 1 states above it cannot see: a
// helper function (`function foo(tag) { ... path.join(os.tmpdir(), \`prefix-${tag}\`) ... }`, not itself
// using `mkdtempSync`/`mkdtempManaged`) whose own interpolated path has NO per-call dynamic discriminator
// of its own (no `Date.now()`/`Math.random()`/`process.pid`/`randomUUID`/`crypto.random`, directly or one
// level of indirection through a helper it calls, e.g. `sfxOf(tag)` or `freshSfx()`) — meaning the path's
// uniqueness depends ENTIRELY on what the CALLER passes for that parameter — and THEN finds a call site
// passing a BARE STRING/TEMPLATE LITERAL (zero `${...}` interpolation) for that exact parameter. This is
// the literal a6b1c4c7 incident shape: `makeRepo("positive-control")`.
//
// METHOD (two stages, deliberately separate so each can be read and verified on its own):
//   STAGE 1 — find every top-level `function NAME(params) { ... }` / `const NAME = (params) => { ... }`
//   whose body references `os.tmpdir()` (and does not itself call `mkdtempSync`/`mkdtemp`). For each LINE
//   in that body matching `os.tmpdir()`, check whether one of the function's own declared parameters is
//   interpolated into it. If so, resolve every OTHER `${identifier...}` on that same line: if any resolves
//   (by reading its own `const`/`let`/`var` definition, or one level through a helper function it calls)
//   to something containing a per-call entropy source, the site is SAFE BY CONSTRUCTION regardless of what
//   the caller passes — skip it. Otherwise it's a PARAM-DEPENDENT SITE.
//   STAGE 2 — for each PARAM-DEPENDENT SITE, scan the WHOLE FILE (not just the function body) for every
//   call to that function name (skipping the definition line itself), and check the argument in the
//   relevant parameter position: a BARE string/template literal (a quoted literal with zero `${...}`
//   interpolation) is flagged.
//
// WHY THIS IS SOUND ENOUGH TO GATE ON — verified against the real incident and the real corpus, not
// merely asserted: planting the EXACT pre-fix merge-commit-kill-confirm.mjs shape (`function makeRepo(tag)
// { return path.join(os.tmpdir(), \`loom-killconfirm-${tag}\`); }` called as `makeRepo("positive-control")`)
// in a throwaway file makes this detector FAIL, naming the exact call site. Run against the REAL corpus as
// it stands today, it finds ZERO bare-literal call sites (card 00c356c6's own sweep — see that card's
// worker_report for the full audit; every one of the ~20 real fixture-writing helpers STAGE 1 found
// already mixes in a `sfx`/`freshSfx()`/`sfxOf()` discriminator built from `Date.now()` + `Math.random()`
// at every call site).
//
// STATED REMAINING BLIND SPOTS (so a green run here is not read as proof of more than it shows):
//  - Call-site argument matching only recognizes a SIMPLE top-level `fnName(arg1, arg2, ...)` call —
//    `fnName.call(...)`, a destructured/spread call, or a call reached only through a higher-order wrapper
//    (`const wrapped = makeRepo; wrapped("x")`) is invisible.
//  - The "does this identifier resolve to something dynamic" check follows at most ONE level of
//    indirection through a helper call (e.g. `const sfx = freshSfx();`) — a chain three calls deep would
//    not be traced and the site would be (over-)flagged as param-dependent, which fails SAFE (a human then
//    has to look, not a silent miss) rather than failing unsafe.
//  - Only `function NAME(...) { ... }` and `const NAME = (...) => { ... }` definitions are recognized — a
//    method on an object literal, a class method, or a function assigned via `NAME = function() {}` (no
//    `const`) is not matched by STAGE 1 at all.
// A human reviewing a brand-new test-fixture-constructing function should still judge every caller, same
// as CHECK 1's header already says — this narrows the mechanical floor, it does not replace that judgment.
//
// CHECK 2 — BASELINE KEY = (file, fnName, call-site line text) — same reasoning as CHECK 1's baseline:
// editing the flagged call site is exactly the moment a human should re-audit it.
const KNOWN_PARAMETERIZED_LITERAL_DEBT = new Map([
  // Empty as of card 00c356c6's sweep — every real call site audited uses a per-call dynamic value. Add an
  // entry here ONLY after individually reading what the call site actually does (same rule as CHECK 1's
  // KNOWN_FIXED_LITERAL_DEBT above), never to silence this check without auditing.
]);

const FUNC_DEF_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/;
const ARROW_CONST_RE = /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/;
const ARROW_CONST_SINGLE_RE = /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(\w+)\s*=>\s*\{/;
const DYNAMIC_RE = /Date\.now\s*\(\)|Math\.random\s*\(\)|process\.pid|randomUUID|crypto\.random|performance\.now\s*\(\)/;

// Finds top-level function/arrow-const definitions taking at least one parameter, returning each with its
// own body's line range (simple brace-depth matching — see STATED REMAINING BLIND SPOTS above for what
// this cannot see).
function findFunctionBodies(lines) {
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FUNC_DEF_RE.exec(line) || ARROW_CONST_RE.exec(line) || ARROW_CONST_SINGLE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    const params = (m[2] || "").split(",").map((p) => p.trim().split("=")[0].trim().replace(/[{}]/g, "")).filter(Boolean);
    if (!params.length) continue; // no params — not the parameterized shape CHECK 2 hunts
    let depth = 0, started = false, endLine = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
      if (started && depth <= 0) { endLine = j; break; }
      if (j - i > 400) { endLine = j; break; } // safety bound against a runaway unbalanced-brace scan
    }
    results.push({ name, params, startLine: i + 1, lines: lines.slice(i, endLine + 1), body: lines.slice(i, endLine + 1).join("\n") });
  }
  return results;
}

// Resolves whether `ident` (as used inside `fileText`) carries a per-call entropy source — either directly
// in its own `const`/`let`/`var` definition, or one level through a helper function it calls (e.g.
// `const sfx = freshSfx();` where `freshSfx` itself builds from `Date.now()`/`Math.random()`).
function isIdentifierDynamic(fileText, ident, depth = 0) {
  if (depth > 2) return false;
  const defRe = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*([^;\\n]+)`);
  const fnDefRe = new RegExp(`(?:function\\s+${ident}\\s*\\([^)]*\\)|const\\s+${ident}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>|const\\s+${ident}\\s*=\\s*(?:async\\s*)?\\w+\\s*=>)\\s*\\{?`);
  const m = defRe.exec(fileText);
  if (m) {
    const rhs = m[1];
    if (DYNAMIC_RE.test(rhs)) return true;
    const callMatch = /^(\w+)\s*\(/.exec(rhs.trim());
    if (callMatch) return isIdentifierDynamic(fileText, callMatch[1], depth + 1); // one level of indirection
    return false;
  }
  const idx = fileText.search(fnDefRe);
  if (idx >= 0) { const snippet = fileText.slice(idx, idx + 300); return DYNAMIC_RE.test(snippet); }
  return false;
}

// Finds every PARAM-DEPENDENT SITE (STAGE 1) in one file: a tmpdir()-path line inside a parameterized
// helper, where none of the line's interpolated identifiers resolve to a dynamic source.
function findParamDependentSites(file, text) {
  const lines = text.split("\n");
  const fns = findFunctionBodies(lines);
  const sites = [];
  for (const fn of fns) {
    if (!/os\.tmpdir\(\)/.test(fn.body)) continue;
    if (/mkdtempSync\s*\(|mkdtemp\s*\(/.test(fn.body)) continue; // SAFE BY CONSTRUCTION — same rule as CHECK 1
    const tmpdirLines = fn.lines.map((l, idx) => ({ l, idx })).filter((x) => /tmpdir\(\)/.test(x.l));
    for (const { l, idx } of tmpdirLines) {
      const paramIdx = fn.params.findIndex((p) => p.length > 1 && new RegExp(`\\$\\{${p}[.\\}]|\\b${p}\\b`).test(l));
      if (paramIdx === -1) continue; // this line doesn't use any of the function's own parameters
      const paramUsed = fn.params[paramIdx];
      let lineIsDynamic = DYNAMIC_RE.test(l);
      for (const expr of [...l.matchAll(/\$\{([^}]+)\}/g)].map((mm) => mm[1])) {
        const identMatch = /^([A-Za-z_$][\w$]*)/.exec(expr.trim());
        if (!identMatch || identMatch[1] === paramUsed) continue;
        if (isIdentifierDynamic(text, identMatch[1])) lineIsDynamic = true;
      }
      if (!lineIsDynamic) {
        sites.push({ file, fnName: fn.name, paramIdx, paramUsed, lineNo: fn.startLine + idx, lineText: l.trim() });
      }
    }
  }
  return sites;
}

// Naive top-level comma split for one call's argument list, respecting (), [], {} nesting and string /
// template literal bodies (so a comma inside a literal or a nested call is never mistaken for an arg
// separator).
function splitArgs(argStr) {
  const args = [];
  let depth = 0, cur = "", inStr = null;
  for (let i = 0; i < argStr.length; i++) {
    const c = argStr[i];
    if (inStr) {
      cur += c;
      if (c === "\\") { cur += argStr[++i] ?? ""; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

// STAGE 2 — for one PARAM-DEPENDENT SITE, scans the whole file for call sites of its function and flags
// any whose argument at `site.paramIdx` is a bare string/template literal with zero `${...}` interpolation.
function findLiteralCallSites(file, text, site) {
  const hits = [];
  const callRe = new RegExp(`\\b${site.fnName}\\s*\\(`, "g");
  let m;
  while ((m = callRe.exec(text)) !== null) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const nlIdx = text.indexOf("\n", m.index);
    const lineText = text.slice(lineStart, nlIdx === -1 ? text.length : nlIdx);
    if (new RegExp(`function\\s+${site.fnName}\\s*\\(|const\\s+${site.fnName}\\s*=`).test(lineText)) continue; // skip the def itself
    let depth = 0, i = m.index + m[0].length - 1, argStart = i + 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) break; }
    }
    const arg = splitArgs(text.slice(argStart, i))[site.paramIdx];
    if (arg === undefined) continue;
    const isBareLiteral = /^"(?:[^"\\]|\\.)*"$/.test(arg) || /^'(?:[^'\\]|\\.)*'$/.test(arg) || /^`(?:[^`\\$]|\\.)*`$/.test(arg);
    if (isBareLiteral) hits.push({ file, fnName: site.fnName, arg, lineText: lineText.trim() });
  }
  return hits;
}

// ── Population/scope sanity — the matcher is shown capable of finding a REAL hit before trusting any
// zero it reports elsewhere (same discipline clock-path-regression-guard.mjs's own sanity check uses). ──
const sampleFile = "worktree-wedge-retry.mjs";
const sampleHits = classifyFile(sampleFile);
check(`sanity: the matcher DOES find the known-present worktree-wedge-retry.mjs baseline sites (found ${sampleHits.length}, expect 2 — confirms the pattern isn't vacuously matching nothing)`,
  sampleHits.length === 2);

const files = walkTestFiles();
const newViolations = [];
let knownDebtSeen = 0;

for (const file of files) {
  for (const hit of classifyFile(file)) {
    if (baselineHas(KNOWN_FIXED_LITERAL_DEBT, hit.file, hit.text)) knownDebtSeen++;
    else newViolations.push(hit);
  }
}

// Negative control: a pattern that must NOT match anything in this corpus — proves the regex itself isn't
// so loose it would match arbitrary unrelated text (e.g. a bogus function name).
const bogusHits = files.flatMap((file) =>
  fs.readFileSync(path.join(TEST_DIR, file), "utf8").split("\n")
    .filter((l) => /definitelyNotARealFunctionCallXyz123\(\s*os\.tmpdir\(\)/.test(l)));
check(`negative control: a bogus pattern finds zero hits (found ${bogusHits.length})`, bogusHits.length === 0);

check(`CHECK 1: no NEW fixed-literal (zero-interpolation) path.join(os.tmpdir(), ...) sites outside the baseline (found ${newViolations.length}; ${knownDebtSeen} known-debt sites carried forward, each individually audited at card a6b1c4c7 — see the KNOWN_FIXED_LITERAL_DEBT header)`,
  newViolations.length === 0);
for (const v of newViolations) console.log(`  NEW-FIXED-LITERAL  ${v.file}:${v.lineNo}  ${v.text}`);

// ── CHECK 2 execution — see its own header block above for the method and soundness evidence. ──
// Population/scope sanity for CHECK 2's own matcher, same discipline as CHECK 1's sanity check above: the
// parameterized-helper finder is shown capable of finding a KNOWN-PRESENT site before trusting any zero it
// reports elsewhere.
const sampleParamSites = findParamDependentSites("merge-danger-window.mjs", fs.readFileSync(path.join(TEST_DIR, "merge-danger-window.mjs"), "utf8"));
check(`sanity: CHECK 2's STAGE 1 matcher DOES find the known-present merge-danger-window.mjs param-dependent site (found ${sampleParamSites.length}, expect 1 — confirms STAGE 1 isn't vacuously matching nothing)`,
  sampleParamSites.length === 1);

const newParamLiteralViolations = [];
let knownParamDebtSeen = 0;
for (const file of files) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  for (const site of findParamDependentSites(file, text)) {
    for (const hit of findLiteralCallSites(file, text, site)) {
      if (baselineHas(KNOWN_PARAMETERIZED_LITERAL_DEBT, hit.file, `${hit.fnName}::${hit.lineText}`)) knownParamDebtSeen++;
      else newParamLiteralViolations.push(hit);
    }
  }
}

// Negative control for CHECK 2's call-site scan: a bogus function name must find zero call sites.
const bogusParamHits = files.flatMap((file) =>
  findLiteralCallSites(file, fs.readFileSync(path.join(TEST_DIR, file), "utf8"), { fnName: "definitelyNotARealFunctionCallXyz123", paramIdx: 0 }));
check(`negative control: CHECK 2's call-site scan for a bogus function name finds zero hits (found ${bogusParamHits.length})`, bogusParamHits.length === 0);

check(`CHECK 2: no NEW parameterized-helper call site passing a bare literal for a non-dynamic tmpdir()-path parameter (found ${newParamLiteralViolations.length}; ${knownParamDebtSeen} known-debt sites carried forward — see the KNOWN_PARAMETERIZED_LITERAL_DEBT header)`,
  newParamLiteralViolations.length === 0);
for (const v of newParamLiteralViolations) console.log(`  NEW-PARAMETERIZED-LITERAL  ${v.file} :: ${v.fnName}(${v.arg})  -- ${v.lineText}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — CHECK 1: no new/regressed fixed-literal os.tmpdir() fixture sites (${knownDebtSeen} known-debt sites carried forward, all individually audited, see header). CHECK 2: no new parameterized-helper call site passing a bare literal for a non-dynamic tmpdir()-path parameter (${knownParamDebtSeen} known-debt sites carried forward). Stated remaining scope limits live in each check's own header — a new test-fixture-constructing function still needs a human to judge whether every caller supplies a per-run-unique value.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
