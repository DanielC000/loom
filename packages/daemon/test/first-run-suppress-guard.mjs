import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs text scan below, no Db used
// STANDING GUARD (card 2365cc22) — every packages/daemon/test/*.mjs that spawns a REAL `dist/index.js`
// daemon (`spawn(process.execPath, [...])` whose argument list names both "dist" and "index.js" — the
// two forms the real corpus uses: `path.join(__dirname, "..", "dist", "index.js")` and
// `path.resolve("packages/daemon/dist/index.js")`) must also set `LOOM_SUPPRESS_FIRST_RUN_LAUNCH` in
// that SAME spawn's own env object.
//
// WHY: a fresh LOOM_HOME with zero ordinary projects — true for every one of these tests until it
// seeds its own first project, moments after boot — is exactly the condition `setup/first-run.ts`'s
// `maybeAutoLaunchSetup` checks to auto-launch a REAL Setup Assistant session (a genuine `claude.exe`
// spawn, a real model turn, real wall-clock cost) on every daemon boot, unconditionally, unless this
// env var is set. MEASURED LIVE (card 2365cc22 checkpoint, against board-consistency.mjs, unmodified,
// before this fix): a real claude.exe (role "setup", agent "Platform") spawned and lived ~29s during an
// ordinary run, with the daemon's own boot log reading `[boot] first-run: auto-launched Setup Assistant`
// — invisible to every one of these tests' own assertions, since none of them look for it.
//
// A per-spawn-site check, not a per-file one: `packages/daemon/scripts/test-daemon.mjs`'s own child env
// (the harness that runs each test FILE under the gate) ALSO sets this centrally, so the GATE path is
// covered for free via `...process.env` — but every one of these files is also documented to run
// directly (`node test/<name>.mjs`, outside that harness), where no such inheritance exists. This guard
// enforces the EXPLICIT per-file side of that defense-in-depth, independent of the central backstop.
//
// ALLOWLIST (explicit, commented — never a blanket NOT_HERMETIC exemption): a file whose own point is to
// deliberately exercise the real first-run auto-launch spawn would legitimately need to NOT suppress it.
// Empty today — no such file exists yet (verified: grepped every real-daemon-spawning file for
// "firstRun"/"first-run"/"Setup Assistant"; none reference it). Add a file here ONLY after confirming
// its whole purpose is testing that exact spawn, with a comment naming the card.
//
// SECOND, RELATED CHECK (card c75006c2, DoD-2) — same site detector, a DIFFERENT belt-and-suspenders
// precondition: every real-daemon-spawn site found above must ALSO redirect `claudeJsonPath()`'s target
// (`process.env.CLAUDE_CONFIG_DIR`, or BOTH `process.env.HOME`+`process.env.USERPROFILE`) textually
// BEFORE that spawn. WHY A SEPARATE BELT: the SUPPRESS flag above closes the live trigger (the daemon
// never calls maybeAutoLaunchSetup -> ensureTrusted at all), but this is the backstop for IF that flag is
// ever removed/regresses — `ensureTrusted` fires INSIDE the spawned daemon's own process, one level
// further removed than ensure-trusted-config-dir-redirect-guard.mjs's own (A)/(B) triggers can see (that
// guard's documented gap (iii): a test that never calls `ensureTrusted`/`.spawn(` ITSELF, only spawns the
// real daemon that does). REDIRECT_EXEMPT below is this check's OWN allowlist, distinct from
// FIRST_RUN_LAUNCH_TEST_ALLOWLIST above: board-consistency.mjs and skills-e2e.mjs each intentionally spawn
// ONE real, authenticated `claude` session as their actual test subject — forcing this redirect onto them
// breaks that real spawn (MEASURED, card c75006c2: a freshly-redirected, un-onboarded CLAUDE_CONFIG_DIR
// makes the real `claude` CLI itself get stuck in its OWN first-run before it ever reaches a ready state —
// SessionStart never fires, board-consistency.mjs's agent never produced its SAW= marker within its own
// 150s timeout, while the unmodified file passes cleanly). Each already carries its OWN documented,
// surgical, single-entry add/remove around the real ~/.claude.json instead (same contract
// ensure-trusted-config-dir-redirect-guard.mjs's NOT_HERMETIC exemption describes, for the same reason);
// LOOM_SUPPRESS_FIRST_RUN_LAUNCH is their real protection. Add a file to REDIRECT_EXEMPT only after
// confirming that same shape: a real, intentional, credentialed claude spawn plus its own cleanup.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const FIRST_RUN_LAUNCH_TEST_ALLOWLIST = new Set([
  // (currently empty — see header)
]);

// See header's "SECOND, RELATED CHECK" for why this is a separate allowlist from the one above.
const CLAUDE_CONFIG_DIR_REDIRECT_EXEMPT = new Set([
  "board-consistency.mjs",
  "skills-e2e.mjs",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

// Index of the character matching `text[openIdx]` (one of `{`, `[`, `(`), skipping over string/template
// literal bodies so a stray bracket character inside a quoted value never desyncs the depth count.
function matchingBracket(text, openIdx) {
  const open = text[openIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : open === "(" ? ")" : null;
  if (!close) return -1;
  let depth = 0, inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Finds every `spawn(process.execPath, [...], {...})` site in `text` whose argument array references
// BOTH "dist" and "index.js" (the real daemon entry point) — never just "spawn(process.execPath" alone,
// which this corpus also uses for dozens of unrelated helper/fixture/self-test spawns. Returns each
// site's 1-based line number, its raw argument-array text, and its raw options-object text (empty
// string if the call has no trailing object literal at all).
function findRealDaemonSpawnSites(text) {
  const sites = [];
  const callRe = /spawn\(\s*process\.execPath\s*,\s*\[/g;
  let m;
  while ((m = callRe.exec(text)) !== null) {
    const arrOpenIdx = text.indexOf("[", m.index);
    const arrCloseIdx = matchingBracket(text, arrOpenIdx);
    if (arrCloseIdx === -1) continue;
    const argsText = text.slice(arrOpenIdx, arrCloseIdx + 1);
    const looksLikeRealDaemon = /dist/.test(argsText) && /index\.js/.test(argsText);
    if (!looksLikeRealDaemon) continue;
    let j = arrCloseIdx + 1;
    while (j < text.length && /[\s,]/.test(text[j])) j++;
    let optsText = "";
    if (text[j] === "{") {
      const optsCloseIdx = matchingBracket(text, j);
      if (optsCloseIdx !== -1) optsText = text.slice(j, optsCloseIdx + 1);
    }
    const lineNo = text.slice(0, m.index).split("\n").length;
    sites.push({ lineNo, argsText, optsText });
  }
  return sites;
}

// Mirrors ensure-trusted-config-dir-redirect-guard.mjs's own CLAUDE_CONFIG_DIR_SET_RE/HOME_SET_RE/
// USERPROFILE_SET_RE (read there for the full rationale) — duplicated locally rather than imported
// because that file is a standalone runnable guard with its own top-level process.exit(), unsafe to
// import as a module (no `invokedDirectly`-style guard, unlike fixed-wait-witness-guard.mjs).
const CLAUDE_CONFIG_DIR_SET_RE = /\bprocess\.env\.CLAUDE_CONFIG_DIR\s*=(?!=)/;
const HOME_SET_RE = /\bprocess\.env\.HOME\s*=(?!=)/;
const USERPROFILE_SET_RE = /\bprocess\.env\.USERPROFILE\s*=(?!=)/;

/** 0-based index of the first line in `text` carrying a CLAUDE_CONFIG_DIR (or HOME+USERPROFILE pair)
 *  redirect assignment, or -1 if none. A comment line (its trimmed text starting with `//` or `*`) is
 *  BLANKED, never dropped, so line numbers stay 1:1 with the raw text findRealDaemonSpawnSites already
 *  scans — a narrower, line-prefix-only exclusion than the shared stripComments() helper (which drops
 *  lines, shifting indices). Named gap: a `/* ... *\/` block comment spanning multiple lines is not
 *  tracked, so a redirect mentioned inside one could false-pass; none of this corpus's real files do
 *  that (hand-verified, card c75006c2). */
function firstRedirectLineIndex(text) {
  const lines = text.split("\n").map((l) => (/^\s*(\/\/|\*)/.test(l) ? "" : l));
  let cfgDir = -1, home = -1, userProfile = -1;
  for (let i = 0; i < lines.length; i++) {
    if (cfgDir < 0 && CLAUDE_CONFIG_DIR_SET_RE.test(lines[i])) cfgDir = i;
    if (home < 0 && HOME_SET_RE.test(lines[i])) home = i;
    if (userProfile < 0 && USERPROFILE_SET_RE.test(lines[i])) userProfile = i;
  }
  const homePair = home >= 0 && userProfile >= 0 ? Math.max(home, userProfile) : -1;
  if (cfgDir >= 0 && homePair >= 0) return Math.min(cfgDir, homePair);
  if (cfgDir >= 0) return cfgDir;
  return homePair;
}

/** True iff `text` redirects CLAUDE_CONFIG_DIR (or HOME+USERPROFILE) strictly before `site.lineNo`
 *  (1-based, as returned by findRealDaemonSpawnSites). */
function hasRedirectBeforeSite(text, site) {
  const redirectLine0 = firstRedirectLineIndex(text);
  return redirectLine0 >= 0 && redirectLine0 < site.lineNo - 1;
}

// ── Prove the detector can FAIL before trusting any zero it reports on the real corpus (standing
// verification posture): a synthetic specimen shaped exactly like the real incident, RED before the
// fix, GREEN after — then a negative control proving the "dist" + "index.js" requirement is load-bearing
// (an unrelated spawn of the SAME process.execPath binary must never be mistaken for a real daemon spawn). ──
const SPECIMEN_NO_FLAG = 'const daemon = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {\n  env: { ...process.env, LOOM_HOME: LOOM, LOOM_PORT: String(PORT) },\n  stdio: "ignore",\n});';
const SPECIMEN_WITH_FLAG = 'const daemon = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {\n  env: { ...process.env, LOOM_HOME: LOOM, LOOM_PORT: String(PORT), LOOM_SUPPRESS_FIRST_RUN_LAUNCH: "1" },\n  stdio: "ignore",\n});';
const SPECIMEN_UNRELATED_SPAWN = 'const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 999999)"], { stdio: "ignore" });';

const specimenNoFlagSites = findRealDaemonSpawnSites(SPECIMEN_NO_FLAG);
check("sanity (RED specimen): detector finds the planted real-daemon-spawn site missing the flag (found 1 site, flagged missing)",
  specimenNoFlagSites.length === 1 && !specimenNoFlagSites[0].optsText.includes("LOOM_SUPPRESS_FIRST_RUN_LAUNCH"));

const specimenWithFlagSites = findRealDaemonSpawnSites(SPECIMEN_WITH_FLAG);
check("sanity (GREEN specimen): the SAME shape with the flag present is correctly recognized as fixed",
  specimenWithFlagSites.length === 1 && specimenWithFlagSites[0].optsText.includes("LOOM_SUPPRESS_FIRST_RUN_LAUNCH"));

const unrelatedSites = findRealDaemonSpawnSites(SPECIMEN_UNRELATED_SPAWN);
check("negative control: an unrelated process.execPath spawn (no \"dist\"/\"index.js\") is never mistaken for a real daemon spawn (found " + unrelatedSites.length + ")",
  unrelatedSites.length === 0);

// ── Same specimen family, for the SECOND check (CLAUDE_CONFIG_DIR/HOME+USERPROFILE redirect) ──
check("sanity (RED specimen, redirect check): SPECIMEN_NO_FLAG has no redirect anywhere, so it is flagged",
  specimenNoFlagSites.length === 1 && !hasRedirectBeforeSite(SPECIMEN_NO_FLAG, specimenNoFlagSites[0]));

const SPECIMEN_REDIRECT_BEFORE = 'process.env.CLAUDE_CONFIG_DIR = cfgDir;\n' + SPECIMEN_WITH_FLAG;
const specimenRedirectBeforeSites = findRealDaemonSpawnSites(SPECIMEN_REDIRECT_BEFORE);
check("sanity (GREEN specimen, redirect check): CLAUDE_CONFIG_DIR set BEFORE the spawn is correctly recognized as fixed",
  specimenRedirectBeforeSites.length === 1 && hasRedirectBeforeSite(SPECIMEN_REDIRECT_BEFORE, specimenRedirectBeforeSites[0]));

const SPECIMEN_REDIRECT_AFTER = SPECIMEN_WITH_FLAG + '\nprocess.env.CLAUDE_CONFIG_DIR = cfgDir;';
const specimenRedirectAfterSites = findRealDaemonSpawnSites(SPECIMEN_REDIRECT_AFTER);
check("sanity (order matters, redirect check): CLAUDE_CONFIG_DIR set AFTER the spawn is still flagged",
  specimenRedirectAfterSites.length === 1 && !hasRedirectBeforeSite(SPECIMEN_REDIRECT_AFTER, specimenRedirectAfterSites[0]));

const SPECIMEN_REDIRECT_HOME_PAIR_BEFORE = 'process.env.HOME = h;\nprocess.env.USERPROFILE = h;\n' + SPECIMEN_WITH_FLAG;
const specimenRedirectHomePairSites = findRealDaemonSpawnSites(SPECIMEN_REDIRECT_HOME_PAIR_BEFORE);
check("sanity (HOME+USERPROFILE pair, redirect check): the pair BEFORE the spawn is recognized as fixed too (not just CLAUDE_CONFIG_DIR)",
  specimenRedirectHomePairSites.length === 1 && hasRedirectBeforeSite(SPECIMEN_REDIRECT_HOME_PAIR_BEFORE, specimenRedirectHomePairSites[0]));

const SPECIMEN_REDIRECT_HOME_ONLY = 'process.env.HOME = h;\n' + SPECIMEN_WITH_FLAG;
const specimenRedirectHomeOnlySites = findRealDaemonSpawnSites(SPECIMEN_REDIRECT_HOME_ONLY);
check("sanity (HOME alone, redirect check): HOME without USERPROFILE is NOT enough (both required for the pair form)",
  specimenRedirectHomeOnlySites.length === 1 && !hasRedirectBeforeSite(SPECIMEN_REDIRECT_HOME_ONLY, specimenRedirectHomeOnlySites[0]));

const SPECIMEN_REDIRECT_IN_COMMENT = '// process.env.CLAUDE_CONFIG_DIR = cfgDir;\n' + SPECIMEN_WITH_FLAG;
const specimenRedirectInCommentSites = findRealDaemonSpawnSites(SPECIMEN_REDIRECT_IN_COMMENT);
check("sanity (commented-out redirect, redirect check): a redirect assignment inside a // comment line is never mistaken for a real one",
  specimenRedirectInCommentSites.length === 1 && !hasRedirectBeforeSite(SPECIMEN_REDIRECT_IN_COMMENT, specimenRedirectInCommentSites[0]));

// ── Real-corpus RED→GREEN control (DoD-2, card c75006c2): the ACTUAL profiles-rest.mjs content from
// before/at the fix commit 76878a24 (card 042a4312) — not a synthetic reconstruction — must flip exactly
// as the fix intends: RED on the parent revision (no redirect at all), GREEN at 76878a24 itself (the
// redirect landed). Best-effort: a shallow clone without this history reports a clearly-labelled SKIP
// rather than a false failure, mirroring fixed-wait-witness-guard-selftest.mjs's own posture. ──
{
  const TARGET = "packages/daemon/test/profiles-rest.mjs";
  let preFix = null, postFix = null;
  try {
    preFix = execFileSync("git", ["show", `76878a24^:${TARGET}`], { cwd: REPO_ROOT, encoding: "utf8" });
    postFix = execFileSync("git", ["show", `76878a24:${TARGET}`], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch (e) {
    check(`Real-corpus RED→GREEN control: SKIPPED — could not \`git show 76878a24[^]:${TARGET}\` in this checkout (${e.message}); not a claim either way`, true);
  }
  if (preFix !== null && postFix !== null) {
    const preSites = findRealDaemonSpawnSites(preFix);
    check("RED control: 76878a24^'s profiles-rest.mjs (before the fix) has exactly one real-daemon-spawn site",
      preSites.length === 1);
    if (preSites.length === 1) {
      check("RED control: 76878a24^ (before the fix) has NO redirect before the spawn — flagged",
        !hasRedirectBeforeSite(preFix, preSites[0]));
    }
    const postSites = findRealDaemonSpawnSites(postFix);
    check("GREEN control: 76878a24's profiles-rest.mjs (the fix itself) has exactly one real-daemon-spawn site",
      postSites.length === 1);
    if (postSites.length === 1) {
      check("GREEN control: 76878a24 (the fix itself) has the redirect BEFORE the spawn — clean",
        hasRedirectBeforeSite(postFix, postSites[0]));
    }
  }
}

// ── Real corpus scan ──
const files = walkTestFiles();
const violations = [];
const redirectViolations = [];
let sitesSeen = 0;
let redirectSitesSeen = 0;

for (const file of files) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const sites = findRealDaemonSpawnSites(text);
  if (sites.length === 0) continue;
  sitesSeen += sites.length;
  if (!FIRST_RUN_LAUNCH_TEST_ALLOWLIST.has(file)) {
    for (const site of sites) {
      if (!site.optsText.includes("LOOM_SUPPRESS_FIRST_RUN_LAUNCH")) {
        violations.push({ file, lineNo: site.lineNo });
      }
    }
  }
  if (!CLAUDE_CONFIG_DIR_REDIRECT_EXEMPT.has(file)) {
    redirectSitesSeen += sites.length;
    for (const site of sites) {
      if (!hasRedirectBeforeSite(text, site)) {
        redirectViolations.push({ file, lineNo: site.lineNo });
      }
    }
  }
}

// Population sanity — the real corpus must contain at least one genuine real-daemon-spawn site (as of
// card 2365cc22: mgmt-surface.mjs, platform-scope.mjs, profiles-rest.mjs, scheduler.mjs,
// board-consistency.mjs, skills-e2e.mjs). A zero here would mean the scan silently matched nothing in
// the real corpus — the same "vacuous zero" trap every other guard in this file's sibling list checks
// for. Deliberately NOT asserting an exact count (a future file legitimately adding or removing a real
// spawn site would otherwise rot this number the same way CLAUDE.md warns against for any hand-derived
// corpus count) — only that the detector's real-world yield is nonzero.
check(`sanity: the real corpus has at least one genuine real-daemon-spawn site (found ${sitesSeen} across ${files.length} files — a zero here would mean this scan is vacuously matching nothing real)`,
  sitesSeen > 0);

check(`every real-daemon-spawn site sets LOOM_SUPPRESS_FIRST_RUN_LAUNCH in that spawn's own env (found ${violations.length} violation(s); ${FIRST_RUN_LAUNCH_TEST_ALLOWLIST.size} allowlisted)`,
  violations.length === 0);
for (const v of violations) console.log(`  MISSING-FIRST-RUN-SUPPRESS  ${v.file}:${v.lineNo}`);

// Population sanity for the SECOND check (card c75006c2) — same reasoning as above, scoped to the
// files this check actually applies to (outside CLAUDE_CONFIG_DIR_REDIRECT_EXEMPT).
check(`sanity: the real corpus has at least one genuine real-daemon-spawn site outside the redirect exemption (found ${redirectSitesSeen} across ${files.length - CLAUDE_CONFIG_DIR_REDIRECT_EXEMPT.size} eligible files)`,
  redirectSitesSeen > 0);

check(`every non-exempt real-daemon-spawn site redirects CLAUDE_CONFIG_DIR (or HOME+USERPROFILE) BEFORE that spawn, so ensureTrusted firing inside the spawned daemon can never reach the owner's real ~/.claude.json (found ${redirectViolations.length} violation(s); ${CLAUDE_CONFIG_DIR_REDIRECT_EXEMPT.size} exempted)`,
  redirectViolations.length === 0);
for (const v of redirectViolations) console.log(`  MISSING-CLAUDE-CONFIG-DIR-REDIRECT  ${v.file}:${v.lineNo}`);

console.log(failures === 0
  ? "\n✅ ALL PASS — every real dist/index.js spawn in packages/daemon/test/*.mjs sets LOOM_SUPPRESS_FIRST_RUN_LAUNCH (so the real Setup Assistant first-run auto-launch can never fire a real claude spawn under an ordinary test run), and every non-exempt one also redirects CLAUDE_CONFIG_DIR/HOME+USERPROFILE before spawning (so even a regressed suppress flag could never reach the owner's real ~/.claude.json)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
