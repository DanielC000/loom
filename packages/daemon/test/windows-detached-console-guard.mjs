import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING GUARD (card 060b9cb7) — a `child_process.spawn`/`fork` options object that literally sets
// `detached: true` with no `windowsHide: true` alongside it, on Windows, unconditionally pops a brand-new
// VISIBLE console window for the child — regardless of whether the calling process already has one
// (that is specifically what `detached:true` changes; see `assets/skills/orchestrate/scripts/dev-server.mjs`'s
// own "SUPERVISOR" comment, which already verified this against a real spawn before this card existed).
// This is the confirmed root cause of card `060b9cb7` ("the merge gate popping visible console windows"
// ~20-30 minutes into a run): `test/dev-server.mjs` + `test/dev-server-stop-tree.mjs` + `test/serve-static.mjs`
// exercise the real `dev-server.mjs`/`serve-static.mjs` skill scripts' real `detached:true` spawn ~a dozen
// times, back to back. See `docs/decisions/060b9cb7-*.md` for the full investigation.
//
// MECHANISM: unlike an ordinary `spawn()`/`fork()` call with NO `detached` option (which just inherits
// whatever console the calling process tree already has — no new window), `detached:true` is Windows-
// specific and ALWAYS forces a new console allocation, visible unless `windowsHide:true` (CREATE_NO_WINDOW)
// is also set. `windowsHide:true` changes nothing else: not the spawned command, its args, its cwd, its
// stdio, or its process-group membership; it's a documented no-op on POSIX. That is why the fix for this
// card's three confirmed sites is additive-only (one new key beside the existing `detached: true`).
//
// SCOPE: scans `packages/daemon/assets/**/*.mjs` and `packages/daemon/src/**/*.ts` — the same two trees
// the card's own investigation covered. Deliberately does NOT scan `packages/daemon/test/**` — three
// test-fixture sites (`test/fixtures/_late-close-parent.mjs`, `test/fixtures/_child-ebusy-exhausted.mjs`,
// `test/dev-server-teardown.mjs`'s own `ROOT_SCRIPT` string) share this same shape and were explicitly
// left OUT OF SCOPE by card `060b9cb7`'s own kickoff (production/shipped code only) — this guard does not
// cover them, and a reader should not assume it does.
//
// DETECTION: a literal `detached\s*:\s*true` match, never a variable/shorthand/conditional reference —
// this is deliberate, not a gap: the three genuinely POSIX-only call sites this card's investigation
// found (`gate-runner.ts`'s `runGateStep`, `git/worktrees.ts`'s two `createWorktree` provision spawns,
// `restart.ts`'s `runBuildStep`) all spread a `detached` VALUE that is `process.platform !== "win32"`
// (a variable or an inline conditional) — never the bare literal `true` — so none of them can ever match
// this pattern in the first place; they need no allowlist entry, because the pattern itself never reaches
// them. Only a call site that forces `detached` to `true` UNCONDITIONALLY, including on win32, matches —
// which is exactly the shape that provably pops a window.
//
// For each match, this walks OUTWARD by brace-balance to find the enclosing `{ ... }` options-object
// literal (never a fixed line-count window — an object can legitimately span many lines, e.g. this card's
// own fix, which puts a 2-line explanatory comment between `detached: true,` and `windowsHide: true,`) and
// requires a `windowsHide\s*:\s*true` literal to appear somewhere inside that SAME object. A file/line not
// in ALLOWLIST below with no such match is a violation.
//
// COMMENT-STRIPPING: this codebase's own comments routinely say things like "a `detached:true` child..."
// in prose (this file's own header above does it too) — scanning raw text without stripping `//` and
// `/* */` comments first produced 8 false-positive "no balanced enclosing object" violations in this
// guard's very first real run, every one of them a comment, not code (measured directly — see the
// decision record). `stripComments` below replaces comment BYTES with spaces (never deletes a line), so
// every real match's line number stays exactly what `fs.readFileSync` would report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.resolve(__dirname, ".."); // test/ -> packages/daemon

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Reasoned exceptions — each is a real, literal `detached: true` with no `windowsHide`, deliberately left
// unfixed by card `060b9cb7`. Keyed by path relative to `packages/daemon/`, whole-file (neither file has
// more than one `detached:true`-bearing call site worth distinguishing — see each reason).
const ALLOWLIST = [
  {
    path: "assets/scripts/ensure-obsidian.mjs",
    reason: "launches Obsidian, a real GUI app, via a detached spawn so it outlives this short-lived " +
      "preflight. `windowsHide:true` sets CREATE_NO_WINDOW on the child's startup info, which risks " +
      "hiding Obsidian's OWN window too (not just a console) — not safe-by-default here. Card 060b9cb7.",
  },
  {
    path: "src/index.ts",
    reason: "the packaged-only `loom update` self-update spawn (`beginSelfUpdate`) — gated behind " +
      "`isPackagedInstall()`, never reached by a from-source dev daemon, and therefore never reached by " +
      "`pnpm --filter @loom/daemon test:daemon`/the merge gate this card is about. Card 060b9cb7.",
  },
];
const allowlistedPaths = new Set(ALLOWLIST.map((e) => e.path));

function walk(dir, extensions, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist on this checkout — nothing to scan
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, extensions, out);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(abs);
    }
  }
  return out;
}

/** Finds the enclosing `{ ... }` span (as [startIdx, endIdx), both inclusive of the braces) around
 *  `matchIdx` by balancing braces outward — never a fixed line/char window. Returns null if the file is
 *  malformed enough that no balanced enclosing object can be found (never thrown — a scan bug must not
 *  crash the whole guard; it's reported as its own violation instead, naming the file). */
function findEnclosingBraces(text, matchIdx) {
  let depth = 0;
  let start = -1;
  for (let i = matchIdx; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  let end = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) { end = i; break; }
      depth--;
    }
  }
  if (end === -1) return null;
  return [start, end];
}

/** Replaces line-comment and block-comment BYTES with spaces (newlines inside a comment are kept as
 *  newlines), so line numbers computed against the result exactly match `fs.readFileSync`'s own.
 *  String/template literal contents are copied verbatim (including any comment-opener sequence they
 *  happen to contain) so a real quoted string is never mistaken for a comment — this is a lightweight
 *  lexer, not a full parser, and does not claim to handle every JS edge case (e.g. a bare regex literal
 *  containing a slash-slash), only real file content. */
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i]; i++;
      }
      if (i < n) { out += text[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const DETACHED_TRUE_RE = /\bdetached\s*:\s*true\b/g;
const WINDOWS_HIDE_TRUE_RE = /\bwindowsHide\s*:\s*true\b/;

/** Returns an array of violation descriptions (empty = clean) for one file's TEXT — pure, so the controls
 *  below can drive it directly against a synthetic string without touching the filesystem. Strips
 *  comments FIRST (see `stripComments`) so prose mentioning `detached:true` never false-positives. */
function scanText(rawText, label) {
  const text = stripComments(rawText);
  const violations = [];
  let m;
  DETACHED_TRUE_RE.lastIndex = 0;
  while ((m = DETACHED_TRUE_RE.exec(text)) !== null) {
    const span = findEnclosingBraces(text, m.index);
    const lineNo = text.slice(0, m.index).split("\n").length;
    if (span === null) {
      violations.push(`${label}:${lineNo} — \`detached: true\` found but no balanced enclosing { } object could be located (malformed scan target?)`);
      continue;
    }
    const objectText = text.slice(span[0], span[1] + 1);
    if (!WINDOWS_HIDE_TRUE_RE.test(objectText)) {
      violations.push(`${label}:${lineNo} — \`detached: true\` with no \`windowsHide: true\` in the same options object (Windows pops a new visible console)`);
    }
  }
  return violations;
}

function scanFile(abs) {
  const rel = path.relative(DAEMON_ROOT, abs).split(path.sep).join("/");
  if (allowlistedPaths.has(rel)) return []; // reasoned exception — see ALLOWLIST above
  const text = fs.readFileSync(abs, "utf8");
  return scanText(text, rel);
}

// --- Positive control: a planted `detached:true` with no `windowsHide` MUST be caught. -------------
{
  const bad = `
    function spawnThing() {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
    }
  `;
  const v = scanText(bad, "<planted-bad-fixture>");
  check("[positive control] a planted detached:true with no windowsHide is caught", v.length === 1);
}

// --- Negative control: the allowlisted shapes (as real text, not a filesystem read) pass. -----------
{
  const allowlistShapeA = `
    // win32 + linux: spawn the executable directly, detached + unref'd by the real launcher below.
    return { command: target, args: [], detached: true };
  `;
  // This shape has no windowsHide and WOULD be flagged if it weren't allowlisted by PATH — proving the
  // control is meaningful (the allowlist is what suppresses it, not an accidental pattern miss).
  const v1 = scanText(allowlistShapeA, "<allowlist-shape-fixture>");
  check("[negative control, pre-allowlist] the allowlisted shape IS flagged by scanText alone (proves the allowlist, not the regex, is what clears it)", v1.length === 1);
}
{
  // The genuinely POSIX-only conditional shapes never match the literal-`true` pattern at all — never
  // reach the allowlist, never flagged.
  const conditionalShape = `
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32" });
  `;
  const v = scanText(conditionalShape, "<conditional-shape-fixture>");
  check("[negative control] `detached: process.platform !== \"win32\"` never matches the literal-true pattern", v.length === 0);
}
{
  // The three fixed sites, exactly as they now read on disk, must be clean.
  const fixedShape = `
    const child = spawn(process.execPath, ["-e", SUPERVISOR_CODE, payload], {
      detached: true,
      // @decision 060b9cb7 — detached:true alone pops a new VISIBLE console on Windows;
      // windowsHide:true suppresses only that window, no-op on POSIX.
      windowsHide: true,
      stdio: "ignore",
    });
  `;
  const v = scanText(fixedShape, "<fixed-shape-fixture>");
  check("[negative control] the real fixed shape (comment between detached and windowsHide) is clean", v.length === 0);
}
{
  // The guard's FIRST real run against this repo false-positived on exactly this shape: prose that
  // mentions `detached:true` inside a comment, with no actual object literal anywhere nearby (8 real
  // specimens, e.g. `packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs`'s own "SUPERVISOR"
  // note). Without comment-stripping this reports "no balanced enclosing object" as a violation; with it,
  // there's no live `detached: true` left to match at all.
  const commentOnlyMention = `
    // created with \`detached:true\` (Windows gives it its own new console) that itself needs a shell
    /* posix: the caller must have spawned with detached:true so child.pid is the process GROUP id */
    function unrelated() { return 1; }
  `;
  const v = scanText(commentOnlyMention, "<comment-only-mention-fixture>");
  check("[regression control] a comment merely MENTIONING detached:true (no real object literal) is not flagged", v.length === 0);
}

// --- Real scan: packages/daemon/assets/**/*.mjs + packages/daemon/src/**/*.ts -------------------------
const assetFiles = walk(path.join(DAEMON_ROOT, "assets"), [".mjs"]);
const srcFiles = walk(path.join(DAEMON_ROOT, "src"), [".ts"]);
// Measured on this repo at card 060b9cb7 (2026-11-04): 12 .mjs under assets/, 261 .ts under src/. These
// floors are a generous "did the walk even run" check, not a precise expected count — assets/ is mostly
// *.md skill docs (few *.mjs scripts), so ">50" (an earlier, wrong assumption) always failed here.
check(`sanity: scanned a non-trivial population (${assetFiles.length} .mjs under assets/, ${srcFiles.length} .ts under src/)`, assetFiles.length >= 5 && srcFiles.length >= 50);

const allViolations = [];
for (const f of [...assetFiles, ...srcFiles]) {
  allViolations.push(...scanFile(f));
}
check(`sanity: both allowlisted files still exist and were actually scanned-and-skipped (not silently absent)`, ALLOWLIST.every((e) => fs.existsSync(path.join(DAEMON_ROOT, e.path))));
check(`no un-allowlisted detached:true-without-windowsHide site in assets/**/*.mjs or src/**/*.ts (found ${allViolations.length})`, allViolations.length === 0);
if (allViolations.length > 0) {
  for (const v of allViolations) console.log(`  VIOLATION  ${v}`);
  console.log("  Fix: add `windowsHide: true` alongside `detached: true` in the SAME options object, or");
  console.log("  add a reasoned ALLOWLIST entry above (file path relative to packages/daemon/) if this");
  console.log("  specific site must stay unmitigated (e.g. a GUI-app launch where hiding the window would");
  console.log("  be wrong) — never silence this guard without one.");
}

console.log(`\n${failures === 0 ? "✅" : "❌"} windows-detached-console-guard: ${failures} check(s) failed.`);
if (failures > 0) process.exit(1);
