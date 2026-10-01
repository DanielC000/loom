import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 37310431, round 2) — round 1's LOOM_HOME write-deny unioned the static registry
// (`paths.ts#LOOM_HOME_WRITE_DENY_REGISTRY`) with a live `readdirSync` pass, so ANY new LOOM_HOME-rooted
// path was automatically caught. Round 2 drops the readdir pass (it broke the Platform/Setup homes' own
// legitimate LOOM_HOME-rooted note writes — see docs/decisions/37310431-loom-home-write-deny.md) — so a
// NEW `path.join(LOOM_HOME, …)` / `path.resolve(LOOM_HOME, …)` call site now reaches NEITHER the deny nor
// any acknowledgement unless something catches it. This guard is that something.
//
// WHAT THIS ASSERTS — source-TEXT, comment-stripped: every `packages/daemon/src/**/*.ts` file, PLUS
// (delta security review) every `.mjs` file under the repo-root `bin/`/`scripts/` and
// `packages/daemon/scripts/` directories, is scanned for a `path.join(LOOM_HOME, …)` /
// `path.resolve(LOOM_HOME, …)` (or the `LOOM_HOME_REAL` variant) call site. For each one found, the
// LEADING run of string-literal arguments (stopping at the first non-literal arg, e.g. a variable like
// `projectId`) is joined into a relative path. That derived path must be covered by ONE of:
//   (a) `LOOM_HOME_WRITE_DENY_REGISTRY` or `LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY` — an EXACT match,
//       or (for a `kind:"dir"` entry) the derived path is that entry's relPath or a path UNDER it; or
//   (b) `ALLOWLIST` below — the small, explicit set of paths that must NEVER be denied (scratch,
//       workspaces, runs — see the registries' own docs for why).
// A call site whose first arg is NOT a string literal at all (every segment dynamic) is SKIPPED — there
// is nothing to check (the registry's own `ruleFor(path.join(LOOM_HOME_REAL, entry.relPath), …)` call in
// loom-home-deny.ts is exactly this shape: `entry.relPath` is a property read, not a literal).
//
// GAPS, NAMED (this does NOT cover) — delta security review widened this list; read it fully, a path
// constructed through any of these never reaches either registry OR this guard:
//  (i)   a path built via `${LOOM_HOME}/…` template-literal interpolation, or any other construction that
//        isn't a direct `path.join`/`path.resolve` call with `LOOM_HOME`/`LOOM_HOME_REAL` as the first
//        argument (none exist in the TypeScript corpus as of this card — see its own report).
//  (ii)  a call spanning a nested-parenthesis argument (e.g. a function call inside the arg list) would
//        truncate early at the first `)` — not present in the real corpus today (verified by hand).
//  (iii) a comment describing the LITERAL text of a call (e.g. "`path.join(LOOM_HOME, "codescape")`
//        verbatim") IS matched by the regex, but comment-stripping removes it before the regex ever
//        runs — handled, not a blind spot, but worth naming since an earlier manual grep for this card's
//        own investigation found exactly one such comment (codescape/drift-notice.ts).
//  (iv)  ⚠️ LOOM_HOME PASSED AS A PARAMETER, not the literal identifier — the single biggest named gap.
//        `update/check.ts`'s `readPersistedChannel(loomHome, …)`, `bin/update-config.mjs`'s
//        `channelConfigPath(loomHome)`, and `bin/loom.mjs`'s `pidFilePath()`/`loopbackSecretPath()`/the
//        `logsDir` local (all via a `loomHome()` ACCESSOR, not the constant) all construct a LOOM_HOME-
//        rooted path this regex can never see, because the token in the call is a parameter/local name,
//        never `LOOM_HOME`/`LOOM_HOME_REAL` itself. `daemon.pid` and `update-config.json` are registered
//        in the registry BY HAND for exactly this reason — see their own registry comments.
//  (v)   ⚠️ ALIAS CONSTANTS — `platform/seed.ts`'s `PLATFORM_HOME_PATH` and `setup/seed.ts`'s
//        `SETUP_HOME_PATH` are each assigned `= LOOM_HOME` directly (not a `path.join` call, so nothing
//        to scan today), but a FUTURE `path.join(PLATFORM_HOME_PATH, …)` call would construct a real
//        LOOM_HOME-rooted path this guard would never see, since it only recognizes the two literal
//        identifiers named above, never a transitive alias.
//  (vi)  `bin/**` and `scripts/**` (repo-root) and `packages/daemon/scripts/**` ARE now scanned (widened
//        by the delta review, `.mjs` files, not just `packages/daemon/src/**/*.ts`) — but gap (iv) above
//        means this widening catches `scripts/daemon-supervisor.mjs`'s LITERAL `LOOM_HOME` call sites
//        while STILL missing every `bin/**` call site, which all go through the `loomHome()` accessor.
//  (vii) `bin/service.mjs`'s `path.join(loomHome, "service")` (another `loomHome()`-parameter instance
//        of gap (iv)) is DELIBERATELY left unregistered, not just unscanned — the XML artifact it writes
//        there is rewritten immediately before `schtasks`/`launchctl` consumes it (see that call site),
//        so there's no persistent window where a planted file could matter the way a secret or an
//        instruction file would. Judged low-risk and left out on purpose; not a TODO.
//  (viii) `leadingLiteralPath` (below) only recognizes a `"..."`/`'...'` quoted literal — a BACKTICK
//        template literal with no `${` interpolation (e.g. `` path.join(LOOM_HOME, `codescape`) ``,
//        textually identical in meaning to the quoted form) is treated as non-literal and the whole call
//        is skipped. Not present anywhere in the real corpus today (checked by hand); named here rather
//        than fixed, since fixing it costs more than the risk it closes while the corpus stays this way.
// This guard's own source is excluded from the scan (its prose/fixtures mention the patterns).
//
// Needs the registry's own DATA (not just its source text), so — unlike most of its purely-textual
// siblings — this one DOES need a build first: 1) build (turbo builds shared first),
// 2) node packages/daemon/test/loom-home-write-deny-registry-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TEST_DIR, "..", "src");
const REPO_ROOT = path.join(TEST_DIR, "..", "..", "..");
const BIN_DIR = path.join(REPO_ROOT, "bin");
const REPO_SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const DAEMON_SCRIPTS_DIR = path.join(TEST_DIR, "..", "scripts");
const SELF = path.basename(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Paths that must NEVER be denied — see LOOM_HOME_WRITE_DENY_REGISTRY's own doc in paths.ts for why.
// "reports" was WRONGLY allowlisted here in an earlier pass (reasoned, incorrectly, as a Platform Lead
// note dir) — Code Review caught it: scripts/daemon-supervisor.mjs's REPORTS_DIR is Node's own
// `--report-directory` for fatal-error/uncaught-exception reports (crash forensics, same class as
// crash.log), and CLAUDE.md never actually mentions a `reports/` note path. It is now a registry entry
// (`LOOM_HOME_WRITE_DENY_REGISTRY`, paths.ts), denied like every other sensitive path — removed from
// this allowlist for exactly that reason.
const ALLOWLIST = new Set(["workspaces", "runs", path.posix.join("tmp", "scratch")]);

const CALL_RE = /\bpath\.(?:join|resolve)\(\s*LOOM_HOME(?:_REAL)?\s*,\s*([^)]*)\)/g;

/** Leading run of string-literal args in a comma-split arg list, joined with "/"; "" if the FIRST arg is
 *  already non-literal (nothing to check — see this file's own header). */
function leadingLiteralPath(argsText) {
  const parts = argsText.split(",").map((s) => s.trim());
  const literals = [];
  for (const p of parts) {
    const m = /^(["'])((?:[^\\]|\\.)*)\1$/.exec(p);
    if (!m) break;
    literals.push(m[2]);
  }
  return literals.join("/");
}

/** @returns {string[]} every derived relPath found in `raw` (comment-stripped first). */
export function findLoomHomeRootedPaths(raw) {
  const t = stripComments(raw);
  const found = [];
  for (const m of t.matchAll(CALL_RE)) {
    const rel = leadingLiteralPath(m[1]);
    if (rel) found.push(rel);
  }
  return found;
}

/** Is `relPath` covered by the registry or the allowlist? */
export function isCovered(relPath, registry, allowlist) {
  const norm = relPath.replace(/\\/g, "/");
  if (allowlist.has(norm)) return true;
  for (const entry of registry) {
    const r = entry.relPath.replace(/\\/g, "/");
    if (norm === r) return true;
    if (entry.kind === "dir" && norm.startsWith(`${r}/`)) return true;
  }
  return false;
}

// ── (self) the scanner can FAIL (RED demo on known-bad text) and is quiet on known-good text ──────────
const SAMPLE_REGISTRY = [{ relPath: "loom.db", kind: "file" }, { relPath: "python", kind: "dir" }];
const SAMPLE_ALLOWLIST = new Set(["workspaces"]);

check("(self) a registered FILE exact match is covered", isCovered("loom.db", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));
check("(self) a path NESTED under a registered DIR is covered", isCovered("python/venv", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));
check("(self) a registered DIR's own bare relPath is covered (not just its children)", isCovered("python", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));
check("(self) an allowlisted path is covered even though it's in neither registry entry", isCovered("workspaces", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));
check("(self) an UNREGISTERED, UNALLOWLISTED path is NOT covered (the RED demo)", !isCovered("some-new-sensitive-thing", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));
check("(self) a sibling FILE sharing a prefix with a registered dir name is NOT covered by accident", !isCovered("python-other", SAMPLE_REGISTRY, SAMPLE_ALLOWLIST));

check("(self) finds a simple single-literal call", findLoomHomeRootedPaths('export const X = path.join(LOOM_HOME, "loom.db");').length === 1
  && findLoomHomeRootedPaths('export const X = path.join(LOOM_HOME, "loom.db");')[0] === "loom.db");
check("(self) finds a multi-literal call and joins with /", findLoomHomeRootedPaths('path.join(LOOM_HOME, "tmp", "settings")')[0] === "tmp/settings");
check("(self) truncates at the first non-literal arg (dynamic projectId)", findLoomHomeRootedPaths('path.join(LOOM_HOME, "archives", projectId)')[0] === "archives");
check("(self) a call whose FIRST arg is already dynamic yields NOTHING to check", findLoomHomeRootedPaths("path.join(LOOM_HOME_REAL, entry.relPath)").length === 0);
check("(self) path.resolve(LOOM_HOME, …) is matched too, not just path.join", findLoomHomeRootedPaths('path.resolve(LOOM_HOME, "archives")')[0] === "archives");
check("(self) a call mentioned only in a comment is NOT matched (comment-stripped first)", findLoomHomeRootedPaths('// path.join(LOOM_HOME, "some-new-thing") verbatim\nconst a = 1;').length === 0);
check("(self) a bare path.resolve(LOOM_HOME) with no comma (resolving the root itself) is NOT matched", findLoomHomeRootedPaths("path.resolve(LOOM_HOME)").length === 0);

// ── the real corpus: walk each root, scan each file matching its extension predicate, check every
// derived path. Widened by the delta security review to also cover bin/ and scripts/ (both repo-root
// and packages/daemon/scripts) — `.mjs`, since none of those are TypeScript. ─────────────────────────
function walk(dir, extPredicate, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; } // a root that doesn't exist (e.g. a stripped-down checkout) degrades to "nothing found there", never throws
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, extPredicate, out);
    else if (extPredicate(e.name)) out.push(p);
  }
  return out;
}
const isTs = (name) => name.endsWith(".ts") && !name.endsWith(".d.ts");
const isMjs = (name) => name.endsWith(".mjs");

const { LOOM_HOME_WRITE_DENY_REGISTRY, LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY } = await import("../dist/paths.js");
const COMBINED_REGISTRY = [...LOOM_HOME_WRITE_DENY_REGISTRY, ...LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY];

const ROOTS = [
  [SRC_DIR, isTs],
  [BIN_DIR, isMjs],
  [REPO_SCRIPTS_DIR, isMjs],
  [DAEMON_SCRIPTS_DIR, isMjs],
];

let totalFound = 0;
const offenders = [];
for (const [root, extPredicate] of ROOTS) {
  for (const abs of walk(root, extPredicate)) {
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
    if (path.basename(abs) === SELF) continue; // never actually true (this file isn't under any scanned root), kept for symmetry with sibling guards
    const raw = fs.readFileSync(abs, "utf8");
    for (const derived of findLoomHomeRootedPaths(raw)) {
      totalFound++;
      if (!isCovered(derived, COMBINED_REGISTRY, ALLOWLIST)) offenders.push(`${rel} -> "${derived}"`);
    }
  }
}

// Population sanity: the scan must actually have SEEN real LOOM_HOME-rooted call sites, or a broken
// CALL_RE would turn this whole guard vacuously green (paired with the (self) controls above, which
// prove the predicate itself works).
check(`(population) the scan saw real LOOM_HOME-rooted path.join/path.resolve call sites across every scanned root (${totalFound} found)`, totalFound >= 35);
check(`every LOOM_HOME-rooted path constructed across every scanned root is covered by a registry or the allowlist${offenders.length ? ` — OFFENDERS: ${offenders.join(", ")} (add a LOOM_HOME_WRITE_DENY_REGISTRY/LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY entry in paths.ts if sensitive, or an ALLOWLIST entry here if it's a legitimate note/working path)` : ""}`,
  offenders.length === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
