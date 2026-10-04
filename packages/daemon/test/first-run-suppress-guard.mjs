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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIRST_RUN_LAUNCH_TEST_ALLOWLIST = new Set([
  // (currently empty — see header)
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

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

// ── Real corpus scan ──
const files = walkTestFiles();
const violations = [];
let sitesSeen = 0;

for (const file of files) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const sites = findRealDaemonSpawnSites(text);
  if (sites.length === 0) continue;
  sitesSeen += sites.length;
  if (FIRST_RUN_LAUNCH_TEST_ALLOWLIST.has(file)) continue;
  for (const site of sites) {
    if (!site.optsText.includes("LOOM_SUPPRESS_FIRST_RUN_LAUNCH")) {
      violations.push({ file, lineNo: site.lineNo });
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

console.log(failures === 0
  ? "\n✅ ALL PASS — every real dist/index.js spawn in packages/daemon/test/*.mjs sets LOOM_SUPPRESS_FIRST_RUN_LAUNCH, so the real Setup Assistant first-run auto-launch can never fire a real claude spawn under an ordinary test run."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
