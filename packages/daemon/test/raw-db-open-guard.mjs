import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// STANDING GUARD (card 943a1817, follow-up (a) of 0a03059e's Code Review 45fba6cf). 0a03059e made the
// `Db` CLASS refuse the real prod DB unless the daemon declares itself (`declareDaemonProcess()`) or a
// caller opts in via code (`{ allowProdDb: true }`) — see docs/decisions/0a03059e-prod-db-default-refuse.md.
// That guard lives entirely INSIDE the `Db` constructor (`assertProdDbOpenAllowed`, src/db.ts). A RAW
// `new Database(file)` (better-sqlite3's own class, imported directly) bypasses the `Db` constructor —
// and therefore `assertProdDbOpenAllowed` — ENTIRELY. If the incident 0a03059e fixed had used raw SQL
// instead of `db.insertProject()`, that fix would not have stopped it. This is the backstop for that:
// a committed-code scan that fails on any raw read-write `new Database(` outside an explicit allowlist.
//
// RULE: every raw `new Database(...)` (or an aliased import of the same better-sqlite3 default export)
// found in COMMITTED, non-test source either (a) is one of the two ALLOWLIST entries below, each with a
// one-line reason, or (b) carries `readonly: true` in its own options argument. Nothing else passes.
// `backfill-task-relations.mjs`/`backfill-transcripts.mjs` are NOT allowlist entries — they pass under
// (b), the general rule, because they already open `{ readonly: true, fileMustExist: true }` — which is
// deliberate: a FUTURE ad-hoc investigation script that opens read-only needs no new allowlist entry
// either, it just needs the same flag. See 0a03059e's own "Do not" list, item 4, for why a NEW DB-opening
// call site must be classified against ITS guard before being added anywhere (daemon-declares, explicit
// human opt-in, or structurally-never-prod) — this scan is the mechanical half of that classification for
// the raw-`Database`-bypass case specifically.
//
// SCOPE / WHAT THIS CANNOT SEE (card's own DoD: state this plainly):
//   - This is a STATIC scan of whatever `.ts`/`.mjs` files currently sit on disk under the roots below —
//     the same mechanism every sibling committed-code scanner in this suite uses (plain `fs.readFileSync`
//     over the checked-out tree, not `git show`/`git ls-tree`). At merge time that tree IS the committed
//     state on the branch being merged, so this is a scan "over committed code" in the sense the card
//     asks for — but it is NOT git-aware, so an UNCOMMITTED file sitting in the worktree at scan time
//     would in fact be seen (it's just a file on disk). What it genuinely CANNOT see is the shape of the
//     real 0a03059e incident: a script that ran once, outside any of these roots (or anywhere on disk at
//     all, by the time any gate runs), and was never committed — it leaves nothing on disk for a static
//     scan, committed or not, to find. No source-scan guard can close that gap; 0a03059e's actual fix
//     (the runtime refusal inside `Db` itself) is what closes it. This scan's job is narrower: catch a
//     COMMITTED raw-open bypass before it ships, not catch an ephemeral script that already ran.
//   - A per-line, non-nested comment classifier (see `stripComments` below) — not a real parser. It is
//     deliberately hardened against the one false-NEGATIVE direction that matters for a security guard
//     (an inline `/* readonly: true */` comment masking a genuinely read-write open — see that function's
//     own comment), but it can still be fooled by a `.claude`-literal-guard-style edge case: a `.ts`/`.mjs`
//     template string that embeds comment-shaped text across a literal line break, or a string literal
//     that itself contains an unbalanced `/*`/`*/`/`//`. Not observed in this codebase today.
//   - Import-alias detection (see `BETTER_SQLITE3_IMPORT_RES` below) recognizes the two shapes this
//     codebase actually uses (`import Database from "better-sqlite3"` and
//     `const { default: X } = await import("better-sqlite3")`) plus a bare `require("better-sqlite3")`
//     assignment. A literal `new Database(` is ALWAYS checked too, regardless of what these patterns find
//     — so an exotic alias shape this scanner doesn't recognize is only a true blind spot if that same
//     file ALSO never uses the bare identifier `Database` anywhere. Not observed in this codebase today.
//
// ✅ POSITIVE CONTROL, RUN MANUALLY DURING THIS GUARD'S OWN DEVELOPMENT (not part of this file's own
// execution — planting a violation in real tracked source is a one-off manual act, not something this
// file should do to itself on every run): add `const x = new Database(someRealVar);` (no `readonly`) to
// a non-allowlisted file under one of the scanned roots → this guard must FAIL, naming that file:line.
// Remove it → must PASS again. Exercised for real during this card's development (a throwaway file under
// packages/daemon/src), reported in the card's worker_report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Directories this scan walks, repo-root-relative (POSIX). Deliberately NOT `packages/daemon/test/**`
// (see the DoD-required justification below) and deliberately NOT `packages/daemon/dist/**` (compiled
// output — the source-text property this guard checks lives in source; scanning dist too would just be a
// second, derived copy of the same finding with no new information, and dist is gitignored/build-only,
// not "committed code").
//
// WHY `packages/daemon/test/**` IS OUT OF SCOPE (card's own DoD-required justification): a repo-wide
// sweep (`git grep -n "new Database(" -- packages/` during this card's own development) found raw opens
// in ~80 files under packages/daemon/test/ — every one of them opens a TEST-OWNED temp file (a per-test
// `tmpHome`/`dbFile`/`legacyFile` path, e.g. `path.join(tmpHome, "legacy.db")`), never `DB_PATH` or the
// real prod path, as part of hand-crafting a legacy/pre-migration DB shape to test a migration against.
// None of them has any route to the real `~/.loom/loom.db` — the exact hazard this guard exists to catch
// is a bypass that reaches the REAL prod DB, and a test's own throwaway fixture file structurally cannot
// be that (`_guard.mjs`'s `requireHermeticEnv()` convention, imported by the overwhelming majority of
// these files, additionally refuses to run at all against a non-isolated LOOM_HOME). Scanning that
// directory would add ~80 files of pure noise with zero security value, which is also why 0a03059e's own
// card body names this directory as "likely out of scope" in the first place.
const SCAN_ROOTS = [
  "packages/daemon/src",
  "packages/daemon/scripts",
  "packages/shared/src",
  "packages/web/src",
  "scripts",
  "bin",
];

// Directory NAMES to never descend into, at any depth, under any root above.
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", "test", "e2e", "coverage"]);

function isUnderscoreExcluded(name) {
  return name.startsWith("_");
}

function walk(dir, exts, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // root doesn't exist on this checkout (e.g. a package reorganized away) — nothing to scan
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name) || isUnderscoreExcluded(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const root of SCAN_ROOTS) {
  walk(path.join(REPO_ROOT, root), [".ts", ".tsx", ".mjs"], files);
}
check(`the real corpus scan opened at least one file (found ${files.length})`, files.length > 0);

// Per-line comment classifier. PRESERVES LINE COUNT (a blanked comment line becomes an EMPTY line, never
// omitted) so a later byte-offset-to-line-number computation stays aligned with the ORIGINAL file.
//
// HARDENED beyond this suite's usual per-line discipline (harness-adapter-claude-literal-guard.mjs /
// codescape-supervisor-shutdown-wiring.mjs) in ONE deliberate way: those guards only strip a line-START
// block comment and a trailing `//`; they leave an INLINE `/* ... */` span (not at line start) untouched.
// For THOSE guards that's a false-POSITIVE risk at worst (an irrelevant comment mention gets flagged,
// annoying but safe). For THIS guard it would be a false-NEGATIVE risk instead — a genuinely read-write
// open spelled `new Database(file, { /* legacy: */ readonly: true });` where the `readonly: true` is
// real, that's fine either way; but `new Database(file, { fileMustExist: true, /* readonly: true */ });`
// is a GENUINE, unflagged read-write open whose only "readonly: true" is an inline comment someone left
// behind — exactly the dangerous direction for a security guard. So this function ALSO strips any
// same-line `/* ... */` span before testing for `readonly: true`. Non-greedy, single-line only — it does
// not handle a `/*`/`*/` pair split across two lines inside what would otherwise read as real code (that
// case still goes through the multi-line `inBlock` state machine below, which already blanks both ends).
function stripComments(source) {
  const state = { inBlock: false };
  const lines = source.split("\n");
  const kept = lines.map((raw) => {
    const trimmed = raw.trim();
    if (state.inBlock) {
      const closeIdx = raw.indexOf("*/");
      if (closeIdx === -1) return "";
      state.inBlock = false;
      return raw.slice(closeIdx + 2);
    }
    if (trimmed.startsWith("//")) return "";
    if (trimmed.startsWith("/*")) {
      const closeIdx = raw.indexOf("*/");
      if (closeIdx === -1) {
        state.inBlock = true;
        return "";
      }
      return raw.slice(closeIdx + 2); // single-line block comment at line-start, code may follow it
    }
    if (trimmed.startsWith("*")) return ""; // JSDoc/block-comment continuation line
    let codeLine = raw.replace(/\/\*.*?\*\//g, ""); // inline same-line block comment(s) — see header above
    codeLine = codeLine.replace(/(?<!:)\/\/.*/, ""); // trailing `//` comment (not a `://` URL)
    return codeLine;
  });
  return kept.join("\n");
}

// Recognizes the better-sqlite3 import/require shapes actually used in this codebase (card's own DoD:
// "an import alias for Database"). A bare `new Database(` is ALWAYS checked too (see IDENTIFIERS below),
// independent of whether any of these patterns match — see the header's own note on the residual blind
// spot this leaves (an alias this scanner doesn't recognize, on a file that also never says `Database`).
const BETTER_SQLITE3_IMPORT_RES = [
  /import\s+(\w+)\s+from\s*["']better-sqlite3["']/g,
  /\{\s*default:\s*(\w+)\s*\}\s*=\s*(?:await\s+)?import\(\s*["']better-sqlite3["']\s*\)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']better-sqlite3["']\s*\)/g,
];

// Balanced-paren extraction of a call's argument list, starting AT the opening `(` (text[startIdx] must
// be `"("`). Skips over string literals (single/double/backtick, with `\`-escape handling) so a `(` or
// `)` inside a string (e.g. a path like "C:/Users/x(1)/loom.db") can't desync the depth count — needed
// because the DoD explicitly calls out "multi-line options objects" as a realistic shape to handle, and a
// naive same-line regex can't see past the first `\n`. Returns `{ args, end }` (end = index of the
// matching `)`), or `null` if the parens never balance (malformed/truncated — callers treat that as "no
// provable readonly", i.e. fail closed, never fail open).
function extractBalanced(text, startIdx) {
  let depth = 0;
  let inString = null;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: text.slice(startIdx + 1, i), end: i };
    }
  }
  return null;
}

const READONLY_TRUE_RE = /readonly\s*:\s*true/;

// The two legitimate raw opens 0a03059e's own card body names as pre-existing exceptions, each with its
// OWN reason (0a03059e's "Do not" list, item 4: classify a new site as daemon/opt-in/never-prod before
// adding it — these two were already classified there, this just encodes that classification mechanically).
const ALLOWLIST = new Map([
  // The `Db` CLASS's own constructor — this IS `assertProdDbOpenAllowed`'s call site (src/db.ts). It is
  // the thing 0a03059e's runtime guard protects, not a bypass of it; excluding it here is not a gap, it's
  // the reason this whole mechanism exists one layer up.
  ["packages/daemon/src/db.ts", "the Db class's own constructor — assertProdDbOpenAllowed's call site, not a bypass of it"],
  // Read-write (default) connection, but documented NEVER-WRITES: db-backup.ts's own comment at its call
  // site states "The backup itself only READS the source — it never mutates it" — read-write is needed
  // only so SQLite can run WAL recovery normally at boot (a read-only connection can fail on a WAL DB
  // needing recovery). 0a03059e's own "Do not" list names this file explicitly as "carded separately for
  // its own guard" — i.e. deliberately NOT folded into the readonly-flag rule this scan otherwise enforces.
  ["packages/daemon/src/orchestration/db-backup.ts", "online-backup/WAL-recovery connection, documented never-mutates — carded separately per 0a03059e"],
]);

const violations = [];
const allowlistHits = new Map(); // relPath -> count, so a vacuous allowlist entry can be caught

for (const file of files) {
  const relPath = path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const raw = fs.readFileSync(file, "utf8");
  const stripped = stripComments(raw);

  const identifiers = new Set(["Database"]);
  for (const re of BETTER_SQLITE3_IMPORT_RES) {
    for (const m of stripped.matchAll(re)) identifiers.add(m[1]);
  }

  for (const ident of identifiers) {
    const callRe = new RegExp(`\\bnew\\s+${ident}\\s*\\(`, "g");
    let m;
    while ((m = callRe.exec(stripped))) {
      const openParenIdx = m.index + m[0].length - 1;
      const extracted = extractBalanced(stripped, openParenIdx);
      const argsText = extracted ? extracted.args : "";
      const lineNo = stripped.slice(0, m.index).split("\n").length;

      if (ALLOWLIST.has(relPath)) {
        allowlistHits.set(relPath, (allowlistHits.get(relPath) ?? 0) + 1);
        continue;
      }
      if (!READONLY_TRUE_RE.test(argsText)) {
        violations.push({ file: relPath, line: lineNo, snippet: stripped.split("\n")[lineNo - 1]?.trim() ?? "" });
      }
    }
  }
}

check(`no un-allowlisted raw read-write new Database( open (found ${violations.length})`, violations.length === 0);
for (const v of violations) console.log(`  VIOLATION  ${v.file}:${v.line}  ${v.snippet}`);

// Every allowlist entry must still match a REAL raw open today (not vacuous) — same discipline the
// sessionenv-mask-six-mcp-sites chokepoint guard applies to its own allowlist.
for (const [relPath, reason] of ALLOWLIST) {
  check(`allowlist entry still matches a real raw open: ${relPath} (${reason})`, (allowlistHits.get(relPath) ?? 0) > 0);
}

// ---- Synthetic sanity checks (in-memory strings — never the real tree) ----
// These prove the MECHANISM, independent of whatever the real corpus happens to contain right now —
// per this project's standing verification posture, a search/assertion needs a negative control AND a
// positive control that isn't trivially satisfied by the corpus alone.

function scanSyntheticSource(src) {
  const stripped = stripComments(src);
  const identifiers = new Set(["Database"]);
  for (const re of BETTER_SQLITE3_IMPORT_RES) {
    for (const m of stripped.matchAll(re)) identifiers.add(m[1]);
  }
  const found = [];
  for (const ident of identifiers) {
    const callRe = new RegExp(`\\bnew\\s+${ident}\\s*\\(`, "g");
    let m;
    while ((m = callRe.exec(stripped))) {
      const openParenIdx = m.index + m[0].length - 1;
      const extracted = extractBalanced(stripped, openParenIdx);
      const argsText = extracted ? extracted.args : "";
      found.push({ ident, hasReadonly: READONLY_TRUE_RE.test(argsText) });
    }
  }
  return found;
}

{
  const violating = scanSyntheticSource('const x = new Database(somePath);');
  check("sanity: a bare new Database(path) with no options is flagged (no readonly:true)",
    violating.length === 1 && violating[0].hasReadonly === false);
}
{
  const safe = scanSyntheticSource('const x = new Database(somePath, { readonly: true });');
  check("sanity: new Database(path, { readonly: true }) is NOT flagged",
    safe.length === 1 && safe[0].hasReadonly === true);
}
{
  const safeMultiline = scanSyntheticSource(
    'const x = new Database(\n  somePath,\n  {\n    readonly: true,\n    fileMustExist: true,\n  },\n);'
  );
  check("sanity: a MULTI-LINE options object with readonly: true (realistic shape, DoD-required) is NOT flagged",
    safeMultiline.length === 1 && safeMultiline[0].hasReadonly === true);
}
{
  const commentMention = scanSyntheticSource('// const x = new Database(evil); this is just a comment\nconst y = 1;');
  check("sanity: a bare `//`-commented mention of new Database( is NOT a false positive (comment-stripped)",
    commentMention.length === 0);
}
{
  const inlineBlockCommentTrap = scanSyntheticSource(
    'const x = new Database(somePath, { fileMustExist: true, /* readonly: true */ });'
  );
  check("sanity: an INLINE /* readonly: true */ comment does NOT count as real readonly — hardened false-negative defense (see stripComments header)",
    inlineBlockCommentTrap.length === 1 && inlineBlockCommentTrap[0].hasReadonly === false);
}
{
  const aliased = scanSyntheticSource(
    'const { default: DB } = await import("better-sqlite3");\nconst x = new DB(somePath);'
  );
  check("sanity: an import alias for Database (destructured default) is detected, and a bare open through it is flagged",
    aliased.length === 1 && aliased[0].ident === "DB" && aliased[0].hasReadonly === false);
}
{
  const parenInPath = scanSyntheticSource('const x = new Database(path.join(dir, "a(1)", "loom.db"));');
  check("sanity: a nested paren inside the first argument (e.g. path.join(...)) does not desync balanced extraction",
    parenInPath.length === 1 && parenInPath[0].hasReadonly === false);
}
{
  const negativeControl = scanSyntheticSource('const x = new TotallyFakeSqliteClassThatDoesNotExist(somePath);');
  check("negative control: a bogus identifier the scanner was never told about is not matched at all",
    negativeControl.length === 0);
}

console.log(failures === 0
  ? `\n✅ ALL PASS — every raw \`new Database(\` (or recognized import alias of it) under ${SCAN_ROOTS.join(", ")} is either one of the ${ALLOWLIST.size} documented allowlist entries or carries its own \`readonly: true\`; \`packages/daemon/test/**\` is deliberately out of scope (see header — ~80 files, all on test-owned temp paths, none reaching the real prod DB). This guard is comment-stripped (including inline /* */ spans — see stripComments's own header for why that hardening matters here specifically), so a comment-only or whitespace-only diff cannot flip its verdict; it is therefore NOT added to CHANGED_TS_TEXT_SCANNER_REPO_PATHS or CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS (worktrees.ts's own shape-(3) precedent, codescape-supervisor-shutdown-wiring.mjs), nor to STATIC_GUARD_REPO_PATHS (the only thing that can introduce a genuine violation is a behavioural .ts/.mjs edit, which already fails computeEmitCompareGate's transpile-identity check and forces the full gate — where this file, an ordinary packages/daemon/test/*.mjs, already runs as part of the normal corpus walk).`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
