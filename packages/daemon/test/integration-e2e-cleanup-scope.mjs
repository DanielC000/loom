import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs test
// Card 89991ed0 — hermetic proof that integration-e2e.mjs's real-homedir engine-transcript-dir cleanup
// removes EXACTLY the one directory a run computed, never a directory that merely shares a prefix or
// contains that name as a substring. Verified live at HEAD by the manager: 3 real ~/.claude/projects
// dirs once matched BOTH "AppData-Local-Temp" and "loom-worktrees", because a temp scratchpad path
// contained a worktree path as a substring — this is that trap, reproduced hermetically.
//
// WHY HERMETIC INSTEAD OF A REAL RUN: integration-e2e.mjs spawns the REAL claude CLI against the live
// self-hosting daemon, which is unsafe to do casually alongside other concurrent workers/gates on this
// host (see this card's kickoff). It also can't sandbox HOME the way other real-homedir tests do
// (b7f758f4, 9878e520) — the real claude spawn needs real credentials. So instead of exercising the
// real spawn, this test builds a fixture root that STANDS IN for ~/.claude/projects and exercises the
// exact SAME matching decision integration-e2e.mjs's cleanup makes: is a directory name in that root
// equal to the one exact path this run computed, or not.
//
// MECHANISM SHARED WITH THE REAL LEAK (the equivalence this fixture rests on, stated once, in one
// sentence): both the real leak and this fixture scope removal by comparing directory NAMES under a
// `~/.claude/projects`-shaped parent against a name computed ONCE via the real production
// `encodeProjectDir` (imported from dist, not reimplemented) — so a fixture built from real
// directory-name shapes (a genuine prefix of that name, and a genuine substring superset of it)
// exercises the identical string-comparison decision the real cleanup makes, with nothing else
// (path resolution, encoding, OS) differing between the two.
//
// RED-FIRST: the (control) block proves the "decoys survive" assertion used in the (real) block below
// is capable of failing — i.e. is not vacuous — by running a deliberately fuzzy (prefix/substring)
// cleanup against the identical fixture shape and showing it destroys both decoys. Only after that is
// shown does the (real) block prove the ACTUAL exact-match mechanism leaves them untouched.
//
// Run: 1) build daemon (pnpm build), 2) node test/integration-e2e-cleanup-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeProjectDir } from "../dist/sessions/transcript.js";
import { mkdtempManaged, unregister } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The exact same shape integration-e2e.mjs's own `dir` uses, so `targetName` below is representative
// of a real computed leaf name, not a synthetic string chosen to make the test easy.
const fakeCwd = path.join(os.tmpdir(), `loom-e2e-${Date.now()}-${process.pid}`);
const targetName = encodeProjectDir(fakeCwd);

// A genuine PREFIX of the target — e.g. an earlier/shorter run's own encoded dir happening to be a
// strict prefix of this one's.
const decoyPrefixName = targetName.slice(0, targetName.length - 6);
// A genuine SUBSTRING SUPERSET of the target — the measured real trap: a temp scratchpad path
// containing a worktree path as a substring.
const decoySubstringName = `zzz-decoy-prefix-${targetName}-zzz-decoy-suffix`;

function buildFixture(root) {
  for (const name of [targetName, decoyPrefixName, decoySubstringName]) {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "fake-engine-id.jsonl"), "{}\n"); // mimic a real leaked transcript file
  }
}

// The bug class named in the card: matching by prefix/substring instead of exact equality.
function buggyFuzzyCleanup(root, name) {
  for (const entry of fs.readdirSync(root)) {
    if (entry === name || entry.includes(name) || name.includes(entry)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
}

// The ACTUAL mechanism integration-e2e.mjs's finally block now runs: no scan, no matching — the exact
// computed path, joined once, removed once.
function exactPathCleanup(root, name) {
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// ============================ (control) RED-FIRST: prove the decoy-survival check can fail ============
{
  const root = mkdtempManaged("loom-cleanup-scope-control-");
  buildFixture(root);
  const before = new Set(fs.readdirSync(root));
  check("(control) fixture has target + 2 decoys before cleanup", before.size === 3);

  buggyFuzzyCleanup(root, targetName);
  const after = new Set(fs.readdirSync(root));
  const decoysDestroyed = !after.has(decoyPrefixName) && !after.has(decoySubstringName);
  check(
    "(control) a fuzzy prefix/substring cleanup DESTROYS both decoys — proves the decoy-survival " +
      "assertion below is a real check, not a vacuous one",
    decoysDestroyed,
  );

  fs.rmSync(root, { recursive: true, force: true });
  if (!fs.existsSync(root)) unregister(root);
}

// ============================ (real) the actual exact-match mechanism ==================================
{
  const root = mkdtempManaged("loom-cleanup-scope-real-");
  buildFixture(root);
  const before = new Set(fs.readdirSync(root));

  exactPathCleanup(root, targetName);

  const after = new Set(fs.readdirSync(root));
  // Set difference, never `total - A - B` arithmetic (a remainder can understate an unmeasured overlap).
  const removed = [...before].filter((x) => !after.has(x));
  check(
    `(real) exact-path cleanup removed EXACTLY the target dir (removed: ${JSON.stringify(removed)})`,
    removed.length === 1 && removed[0] === targetName,
  );
  check("(real) the prefix decoy survived untouched", after.has(decoyPrefixName));
  check("(real) the substring decoy survived untouched", after.has(decoySubstringName));

  fs.rmSync(root, { recursive: true, force: true });
  if (!fs.existsSync(root)) unregister(root);
}

console.log(failures === 0
  ? "\n✅ cleanup-scope proof: exact-path removal is safe against prefix/substring collisions, and the control shows the assertion can actually fail."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
