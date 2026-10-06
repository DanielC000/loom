import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 882d6cff (folds in ed74603b) — from the 5b40376c Code Review (reviewer 95807a3b,
// 2026-10-06). THREE boot-reentry sites in `reenterMergeQuarantinesAtBoot` trusted
// `canonicalRepoLockKey(X)` for an UNRESOLVABLE X — which DEGRADES (walks up) to an ancestor key Kr a
// genuinely resolvable sibling T also occupies — and wrote/folded at that degraded key instead of X's own
// identity:
//
// SITE A (PASS 1's matched-corrupt `.json` self-heal, also ed74603b — the SAME site): wrote the BARE
// placeholder entry directly to `quarantinePathFor(X)` (degraded -> Kr), overwriting T's genuine final.
// Fixed by deferring the self-heal into the SAME post-read write pass 4480b077 introduced for migrated
// sources: when X is unresolvable, never arm/write at the degraded key at all — divert straight to
// `pendingUnresolvedQuarantines`, keyed by the corrupt file's own identity, and leave the file AS WRITTEN
// (never an overwrite-in-place helper for an unverifiable path — Lead directive). When X IS resolvable,
// fold into `migratedSourcesByKey` so the eventual write carries the TRUE UNION, never the bare
// placeholder, and honours `degradedOccupiedKeys` for free (no changes to that pass needed).
//
// SITE B (`hashToRepo` construction): indexed an unresolvable path's own DEGRADED fresh hash alongside
// its (never-degraded) legacy hash as a single winner — making corrupt-latch attribution to a key TWO
// unrelated paths both map to REGISTRATION-ORDER-DEPENDENT. Round 2 fixed the ORDER-DEPENDENCE with
// PRECEDENCE (resolvable fresh always wins; unresolvable fresh only where unclaimed) rather than a bare
// drop — a drop broke the legitimate case of an unresolvable, subdir-bound path whose degraded walk IS
// its own true toplevel key, with no resolvable claimant at all (`site-b-unresolvable-true-toplevel-key-
// still-attributes`). Round 3 then found precedence alone still picks ONE winner among MULTIPLE
// unresolvable claimants sharing one degraded hash, fail-opening every claimant but the first
// (`site-b-multiple-unresolvable-claimants-order-a` / `-order-b`) — fixed by keeping the FULL SET of
// unresolvable claimants per hash and diverting one pending entry per claimant, never a single winner.
//
// SITE C (the deferred-corrupt-tmp loop, 5b40376c's twin): X's only evidence (a corrupt tmp, which PASSES
// 5b40376c's resolvability gate precisely because X is unresolvable) was folded into a DIFFERENT,
// resolvable sibling's own "safe to delete" unlink list purely because `canonicalRepoLockKey(X)` degraded
// to that sibling's key — unlinked the instant that sibling's own union write succeeded. Fixed with the
// same resolvability gate as Site A: never recompute/arm at the degraded key; keep the tmp untouched and
// divert to pending instead.
//
// See docs/decisions/882d6cff-pass1-degraded-key-writes-three-sites.md for the full repro + design
// rationale, including the Site-97cff6db input-population disclosure.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver:
// run with no args to spawn one child per scenario; a child reads `--scenario=<name>` off argv.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-pass1-degraded-key-writes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "item1-final-self-heal-writes-union",
  "item2-hashToRepo-order-RTX",
  "item2-hashToRepo-order-RXT",
  "item3-deferred-tmp-kept-when-unresolvable",
  "clear-while-parked-no-resurrect",
  "remount-converges-and-stays-stable",
  "stays-parked-stable-across-reboots",
  "site-a-basename-matches-target-self-heals-in-place",
  "site-b-unresolvable-true-toplevel-key-still-attributes",
  "site-a-resolvable-degraded-occupied-fold-only",
  "site-b-multiple-unresolvable-claimants-order-a",
  "site-b-multiple-unresolvable-claimants-order-b",
  "site-c-multiple-unresolvable-claimants-tmp-shape",
  "site-b-remount-one-claimant-no-collateral-damage",
  "clear-one-claimant-reports-kept-and-reasserts-on-restart",
  "clear-remount-unmount-both-claimants-durable-via-latch-id",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], { env: envWithoutLoomHome, stdio: "inherit" });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\n✅ ALL SCENARIOS PASS — Sites A/B/C never write/arm at a degraded, walked-up key; a resolvable "
      + "corrupt match still self-heals (via the deferred union write), and a diverted pending entry is "
      + "clearable, converges on remount, and stays stable (no accumulation) while parked."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 882d6cff / ed74603b.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqpdkw-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
  listActiveMergeQuarantines, clearMergeQuarantine, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqpdkw@loom -c user.name=mqpdkw";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the pre-7673d096 direct-identity key algorithm by hand — same technique as the sibling
// repro files (merge-quarantine-pass1-degraded-union-guard.mjs's own `oldHashFor`).
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function freshHashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
// Safe read for an assertion that may legitimately find its target GONE on an unfixed parent (e.g. a
// migrate-delete the parent's own bug triggers) — returns null on ENOENT instead of throwing, so a
// regression surfaces as a clean FAILED assertion, never an uncaught exception that aborts the scenario.
function tryReadFile(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// R (a repo) with X = R/nested (its OWN SEPARATE repo, own `.git`) and T = R/teamA (a plain subdir, no
// `.git` of its own — collapses onto R's own key). Same shape as
// merge-quarantine-pass1-degraded-union-guard.mjs's own `makeRepoWithNestedRepoAndSubdir`.
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqpdkw-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "nested");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-pass1-degraded-key-writes (${tag})\n`);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested own repo (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

// R alone with X = R/nested (no T sibling) — for scenarios that only need X's own clearability/
// convergence, isolated from any sibling-collision mechanics.
function makeRepoWithNestedRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqpdkw-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-pass1-degraded-key-writes (${tag})\n`);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested own repo (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested };
}

// Y (a real repo, deliberately never ITSELF registered) with W1 = Y/a and W2 = Y/b, BOTH absent at
// boot (never created) — two genuinely different unresolvable registered paths that both degrade to
// the SAME walked-up key Ky. Z is a wholly unrelated, real, resolvable, registered repo.
function makeYWithTwoAbsentSubdirsAndZ(tag) {
  const y = path.join(os.tmpdir(), `loom-mqpdkw-y-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# site-b multi-claimant Y (${tag})\n`);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: y });
  commitAll(y, "init", GIT_ID);
  const w1 = path.join(y, "a"); // W1 — deliberately NEVER created
  const w2 = path.join(y, "b"); // W2 — deliberately NEVER created

  const z = path.join(os.tmpdir(), `loom-mqpdkw-z-${tag}-${freshSfx()}`);
  fs.mkdirSync(z, { recursive: true });
  tmpDirs.push(z);
  fs.writeFileSync(path.join(z, "README.md"), `# site-b multi-claimant Z (${tag})\n`);
  execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: z });
  commitAll(z, "init", GIT_ID);

  return { y, w1, w2, z };
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "item1-final-self-heal-writes-union") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ITEM 1 (+ ed74603b fold-in). T's real final sits directly at sha(Kr).json. X's corrupt final sits
    // at X's own legacy hash (matches X via legacy-hash lookup while X is unresolvable). Pre-fix, this
    // overwrote T's final with X's bare placeholder. Fixed: X's corrupt match is diverted to pending
    // (never arms/writes at the degraded Kr), so T's final is never even looked at by X's processing.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("i1");
    const Kr = canonicalRepoLockKey(repo);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kr)}.json`);
    const tContent = JSON.stringify({ repoPath: subdir, branch: "t-branch", reason: "T's own genuine final", enteredAt: Date.now(), tokens: ["t-token"] }, null, 2) + "\n";
    fs.writeFileSync(rFinalPath, tContent);
    const xCorruptPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`);
    fs.writeFileSync(xCorruptPath, "{");

    const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-i1-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is unresolvable", !fs.existsSync(nested));
    check("(precondition) T's real final exists with t-token", fs.readFileSync(rFinalPath, "utf8") === tContent);

    reenterMergeQuarantinesAtBoot([repo, nested, subdir]);

    check("*** THE FIX *** T's own final file is BYTE-IDENTICAL after boot — never touched by X's degraded match", fs.readFileSync(rFinalPath, "utf8") === tContent);
    check("*** THE FIX *** X's own corrupt file is left AS WRITTEN (never overwritten at the degraded key)", fs.readFileSync(xCorruptPath, "utf8") === "{");
    const activeT = activeMergeQuarantineFor(subdir);
    check("(boot) T reads quarantined with ONLY its own token", !!activeT && (activeT.tokens ?? []).length === 1 && activeT.tokens.includes("t-token"));
    const activeR = activeMergeQuarantineFor(repo);
    check("(boot) R reads quarantined via T (same key), never via X", !!activeR && activeR.tokens.length === 1 && activeR.tokens.includes("t-token"));
    const xPending = listActiveMergeQuarantines().find((q) => q.repoPath === nested);
    check("(boot) X's OWN diverted pending entry is separately listed, placeholder, no t-token", !!xPending && xPending.placeholder === true && !(xPending.tokens ?? []).includes("t-token"));

    // RESTART — same parked state — T must survive DURABLY, not just in-process.
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    check("(restart) T's final is STILL byte-identical", fs.readFileSync(rFinalPath, "utf8") === tContent);
    const activeTAfterRestart = fresh1.activeMergeQuarantineFor(subdir);
    check("(restart) T's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeTAfterRestart && activeTAfterRestart.tokens.length === 1 && activeTAfterRestart.tokens.includes("t-token"));

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "item2-hashToRepo-order-RTX" || scenarioName === "item2-hashToRepo-order-RXT") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ITEM 2. T's OWN final is corrupt (named at T's fresh hash sha(Kr).json). X (unresolvable) used to
    // ALSO degrade to hash(Kr) in `hashToRepo` via its own fresh-hash registration — last-writer-wins.
    // Fixed: X's unresolvable fresh hash is never indexed, so attribution is order-INDEPENDENT — always T.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("i2");
    const Kr = canonicalRepoLockKey(repo);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kr)}.json`);
    fs.writeFileSync(corruptPath, "not json");

    const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-i2-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is unresolvable", !fs.existsSync(nested));

    const order = scenarioName === "item2-hashToRepo-order-RTX" ? [repo, subdir, nested] : [repo, nested, subdir];
    reenterMergeQuarantinesAtBoot(order);

    const activeAtKr = activeMergeQuarantineFor(repo);
    check(`*** THE FIX *** order=${JSON.stringify(order.map((p) => path.basename(p)))} still attributes the corrupt final to T, never X`, activeAtKr?.repoPath === subdir);
    check("the recovered entry carries T's own tokens", !!activeAtKr && (activeAtKr.tokens ?? []).length >= 0);

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "item3-deferred-tmp-kept-when-unresolvable") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ITEM 3 (5b40376c's twin). T's real clean final at sha(Kr).json. X's ONLY evidence is a corrupt tmp
    // residue at X's own legacy hash (passes 5b40376c's resolvability gate since X is unresolvable).
    // Pre-fix, this got folded into T's own "safe to delete" list and unlinked once T's union write
    // succeeded. Fixed: the tmp is kept untouched and X's identity is diverted to pending instead.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("i3");
    const Kr = canonicalRepoLockKey(repo);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kr)}.json`);
    const tContent = JSON.stringify({ repoPath: subdir, branch: "t-branch", reason: "T's own clean, real final", enteredAt: Date.now(), tokens: ["t-token"] }, null, 2) + "\n";
    fs.writeFileSync(rFinalPath, tContent);

    const xLegacyHash = oldHashFor(nested);
    const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-i3-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const xTmpPath = path.join(MERGE_QUARANTINE_DIR, `${xLegacyHash}.json.tmp-999-feedbead`);
    fs.writeFileSync(xTmpPath, ""); // corrupt/unparsable tmp — X's ONLY evidence
    check("(precondition) X is unresolvable", !fs.existsSync(nested));
    check("(precondition) X's corrupt tmp residue exists", fs.existsSync(xTmpPath));

    reenterMergeQuarantinesAtBoot([repo, nested, subdir]);

    check("*** THE FIX *** X's corrupt tmp residue SURVIVES (never folded/unlinked as T's stale residue)", fs.existsSync(xTmpPath));
    check("*** THE FIX *** T's own final file is BYTE-IDENTICAL after boot", fs.readFileSync(rFinalPath, "utf8") === tContent);
    const activeT = activeMergeQuarantineFor(subdir);
    check("(boot) T reads quarantined with ONLY its own token", !!activeT && activeT.tokens.length === 1 && activeT.tokens.includes("t-token"));
    const xPending = listActiveMergeQuarantines().find((q) => q.repoPath === nested);
    check("(boot) X's OWN diverted pending entry is separately listed, placeholder, no t-token", !!xPending && xPending.placeholder === true && !(xPending.tokens ?? []).includes("t-token"));

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    check("(restart) X's tmp residue STILL survives", fs.existsSync(xTmpPath));
    check("(restart) T's final file is STILL byte-identical", fs.readFileSync(rFinalPath, "utf8") === tContent);

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "clear-while-parked-no-resurrect") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONDITION 1(a) — a human clear (by repo path, and separately by latch-file id) while X is parked
    // must lift its diverted-pending entry, and the clear must NOT resurrect on a later reboot-sim.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    {
      const { repo, nested } = makeRepoWithNestedRepo("cwp-path");
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const xCorruptPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`);
      fs.writeFileSync(xCorruptPath, "{");
      const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-cwp-path-${freshSfx()}`);
      fs.renameSync(nested, parkedX);

      reenterMergeQuarantinesAtBoot([repo, nested]);
      check("(clear-by-path precondition) X's diverted pending entry exists", !!listActiveMergeQuarantines().find((q) => q.repoPath === nested));

      clearMergeQuarantine(nested); // clear BY REPO PATH while unresolvable
      check("*** THE FIX *** clear-by-path lifts X's diverted entry", !listActiveMergeQuarantines().find((q) => q.repoPath === nested));
      check("(clear-by-path) the corrupt source file is swept too", !fs.existsSync(xCorruptPath));

      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([repo, nested]);
      check("*** NO RESURRECTION *** a reboot-sim after clear-by-path finds NOTHING for X", !fresh.listActiveMergeQuarantines().find((q) => q.repoPath === nested));
      fs.rmSync(repo, { recursive: true, force: true });
    }
    {
      const { repo, nested } = makeRepoWithNestedRepo("cwp-latch");
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const latchHash = oldHashFor(nested);
      const xCorruptPath = path.join(MERGE_QUARANTINE_DIR, `${latchHash}.json`);
      fs.writeFileSync(xCorruptPath, "{");
      const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-cwp-latch-${freshSfx()}`);
      fs.renameSync(nested, parkedX);

      const fresh0 = await freshBootModule();
      fresh0.reenterMergeQuarantinesAtBoot([repo, nested]);
      check("(clear-by-latch precondition) X's diverted pending entry exists", !!fresh0.listActiveMergeQuarantines().find((q) => q.repoPath === nested));

      const result = fresh0.clearMergeQuarantineLatchFile(latchHash); // clear BY LATCH-FILE id
      check("*** THE FIX *** clear-by-latch-id reports ok + wasQuarantined", result.ok === true && result.wasQuarantined === true);
      check("*** THE FIX *** clear-by-latch-id lifts X's diverted entry", !fresh0.listActiveMergeQuarantines().find((q) => q.repoPath === nested));
      check("(clear-by-latch) the corrupt source file is swept too", !fs.existsSync(xCorruptPath));

      const fresh1 = await freshBootModule();
      fresh1.reenterMergeQuarantinesAtBoot([repo, nested]);
      check("*** NO RESURRECTION *** a reboot-sim after clear-by-latch-id finds NOTHING for X", !fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === nested));
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } else if (scenarioName === "remount-converges-and-stays-stable") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONDITION 1(b) — X remounted: the pending entry graduates under Kx, X's corrupt file is consumed/
    // cleaned up in place (its legacy hash equals its own fresh hash — X is its own git toplevel), and
    // T is byte-identical throughout. Also folds in part of 1(c): stable across a FURTHER reboot-sim.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("rc");
    const Kr = canonicalRepoLockKey(repo);
    const Kx = canonicalRepoLockKey(nested);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kr)}.json`);
    const tContent = JSON.stringify({ repoPath: subdir, branch: "t-branch", reason: "T's own genuine final", enteredAt: Date.now(), tokens: ["t-token"] }, null, 2) + "\n";
    fs.writeFileSync(rFinalPath, tContent);
    const xLegacyHash = oldHashFor(nested);
    check("(precondition) X's legacy hash equals its own fresh hash (X is its own git toplevel)", xLegacyHash === freshHashForKey(Kx));
    const xPath = path.join(MERGE_QUARANTINE_DIR, `${xLegacyHash}.json`);
    fs.writeFileSync(xPath, "{");

    const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-rc-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 1 — X parked
    // Reads below use tryReadFile (never a bare readFileSync) — on an unfixed parent, Site A's own bug
    // can DELETE T's final (via the migrate-delete pass, once X remounts) or leave X's own file in an
    // unexpected state; a missing file must surface as a clean FAILED assertion, never an uncaught ENOENT
    // that aborts the whole scenario before the remaining checks even run.
    check("(boot 1) T's final is byte-identical", tryReadFile(rFinalPath) === tContent);
    check("(boot 1) X's corrupt file is left AS WRITTEN (still corrupt)", tryReadFile(xPath) === "{");

    fs.renameSync(parkedX, nested); // REMOUNT X
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 2 — X now resolvable

    check("*** CONVERGENCE *** X's corrupt file is CONSUMED in place (self-healed, no longer corrupt)", (() => {
      const raw = tryReadFile(xPath);
      if (raw === null) return false;
      try { return JSON.parse(raw).repoPath === nested; } catch { return false; }
    })());
    check("*** CONVERGENCE *** no NEW file was created for X (same single file, now valid)", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(xLegacyHash)).length === 1);
    const activeXAfter = fresh1.activeMergeQuarantineFor(nested);
    check("*** CONVERGENCE *** X's own quarantine is reachable, genuinely re-keyed at Kx", !!activeXAfter && canonicalRepoLockKey(activeXAfter.repoPath) === Kx);
    check("*** CONVERGENCE *** T's final is STILL byte-identical — never touched by X's convergence", tryReadFile(rFinalPath) === tContent);
    const filesAfterBoot2 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();

    // A further reboot-sim must be STABLE — no further accumulation now that X has converged.
    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 3
    const filesAfterBoot3 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("*** STABLE *** no new/removed files between boot 2 and boot 3", JSON.stringify(filesAfterBoot2) === JSON.stringify(filesAfterBoot3));
    check("(boot 3) T's final is STILL byte-identical", tryReadFile(rFinalPath) === tContent);
  } else if (scenarioName === "stays-parked-stable-across-reboots") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONDITION 1(c) — X stays parked across SEVERAL reboot-sims (never remounted, never cleared): the
    // state is stable, with no accumulation and no new files, and T stays byte-identical throughout.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("spsar");
    const Kr = canonicalRepoLockKey(repo);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kr)}.json`);
    const tContent = JSON.stringify({ repoPath: subdir, branch: "t-branch", reason: "T's own clean, real final", enteredAt: Date.now(), tokens: ["t-token"] }, null, 2) + "\n";
    fs.writeFileSync(rFinalPath, tContent);
    const xLegacyHash = oldHashFor(nested);
    const parkedX = path.join(os.tmpdir(), `loom-mqpdkw-parked-spsar-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const xTmpPath = path.join(MERGE_QUARANTINE_DIR, `${xLegacyHash}.json.tmp-999-feedbead`);
    fs.writeFileSync(xTmpPath, "");

    reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 1
    const filesAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("(boot 1) T byte-identical, X's tmp survives", fs.readFileSync(rFinalPath, "utf8") === tContent && fs.existsSync(xTmpPath));

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 2 — still parked
    const filesAfterBoot2 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("*** STABLE *** no new/removed files between boot 1 and boot 2 (still parked)", JSON.stringify(filesAfterBoot1) === JSON.stringify(filesAfterBoot2));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 3 — still parked
    const filesAfterBoot3 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("*** STABLE *** no new/removed files between boot 2 and boot 3 (still parked)", JSON.stringify(filesAfterBoot2) === JSON.stringify(filesAfterBoot3));
    check("(boot 3) T is STILL byte-identical", fs.readFileSync(rFinalPath, "utf8") === tContent);
    check("(boot 3) X's tmp STILL survives, unchanged", fs.existsSync(xTmpPath));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "site-a-basename-matches-target-self-heals-in-place") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONDITION 2 — Site A's RESOLVABLE branch: when the corrupt file's own basename IS the key's write
    // target (freshHash === hash — no legacy/fresh mismatch), the union write must OVERWRITE it in place
    // (the self-heal) and never DELETE it afterward (the "also a write target" protection in the
    // existing migrate-delete pass must correctly treat this as a no-op, not data loss).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqpdkw-repo-sab-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# site-a-basename-matches-target\n");
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const K = canonicalRepoLockKey(repo);
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(K)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(finalPath, "{"); // corrupt, named EXACTLY at its own fresh hash — resolvable repo
    check("(precondition) R is resolvable", fs.existsSync(repo));
    check("(precondition) the corrupt final sits at R's own fresh-hash path", fs.existsSync(finalPath));

    reenterMergeQuarantinesAtBoot([repo]);

    check("*** THE FIX *** the file still exists — never deleted (the basename-matches-target protection held)", fs.existsSync(finalPath));
    const onDisk = (() => { try { return JSON.parse(fs.readFileSync(finalPath, "utf8")); } catch { return null; } })();
    check("*** THE FIX *** the file was SELF-HEALED in place — now valid JSON naming this repo", onDisk?.repoPath === repo && onDisk?.placeholder === true);
    const active = activeMergeQuarantineFor(repo);
    check("(boot) the repo reads quarantined via the self-healed placeholder", !!active && active.placeholder === true);

    // A further reboot-sim must be stable too — the self-healed placeholder is now a CLEAN parse of a
    // placeholder shape, so it must not be mistaken for a clean REAL latch, and must not accumulate.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo]);
    const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.includes(freshHashForKey(K)));
    check("(restart) still exactly one file for this key — no accumulation", filesAfter.length === 1);
  } else if (scenarioName === "site-b-unresolvable-true-toplevel-key-still-attributes") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 2, MAJOR — dropping an unresolvable path's fresh hash unconditionally assumed it
    // was ALWAYS a degraded stand-in for some resolvable sibling. False for a subdir-bound project whose
    // subdir is absent: the walk lands on its OWN TRUE toplevel key. X = Y/sub (absent at boot), Y a REAL
    // repo but NOT itself registered, Z an unrelated REGISTERED repo. X's corrupt latch (named at Y's own
    // key — exactly what X's degraded walk produces) must still attribute to X — never fall through to
    // the orphan sweep, which would fail-close EVERY registered repo, including the wholly unrelated Z.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqpdkw-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# site-b Y (never registered)\n");
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const Ky = canonicalRepoLockKey(y);
    const x = path.join(y, "sub"); // X = Y/sub — deliberately NEVER created (absent at boot)
    check("(precondition) X is genuinely absent", !fs.existsSync(x));

    const z = path.join(os.tmpdir(), `loom-mqpdkw-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# site-b Z (unrelated, registered)\n");
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: z });
    commitAll(z, "init", GIT_ID);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // X's degraded walk-up (no ancestor .git of its own) lands EXACTLY here — Y's own real key.
    const xCorruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(xCorruptPath, "{");

    reenterMergeQuarantinesAtBoot([x, z]); // Y deliberately NOT registered

    check("*** THE FIX *** Z is NOT quarantined (never falls through to the fail-closed-every-repo orphan sweep)", activeMergeQuarantineFor(z) === undefined);
    const xEntry = listActiveMergeQuarantines().find((q) => q.repoPath === x);
    check("*** THE FIX *** X's own corrupt latch still attributes to X (never an unmatched orphan)", !!xEntry && xEntry.placeholder === true);
    check("(sanity) X's own diverted entry never names Z's identity", !!xEntry && xEntry.repoPath !== z);
  } else if (scenarioName === "site-a-resolvable-degraded-occupied-fold-only") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 2, item 5 — Site A's RESOLVABLE branch feeds `migratedSourcesByKey`, which the
    // pre-existing write-then-delete pass already gates on `degradedOccupiedKeys`: when a DIFFERENT,
    // still-unresolvable entry's own TRUSTED resolvedKey already durably occupies the exact key E's
    // corrupt match resolves to, the write must be SKIPPED entirely (fold only — E's corrupt source is
    // folded into the occupant's own orphanLatchFiles, never written, never deleted) — never silently
    // overwrite the degraded occupant's only durable backing file.
    //
    // D is a manufactured latch for a path that NEVER EXISTS, with `resolvedKey` deliberately set to a
    // REAL, resolvable repo E's own true key Ke — the same manufactured-collision technique
    // merge-quarantine-pass1-degraded-union-guard.mjs's own `direct-verified-guard` scenario uses. E ALSO
    // carries its own corrupt FINAL, named at its own fresh hash — Site A's resolvable branch.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const e = path.join(os.tmpdir(), `loom-mqpdkw-e-${freshSfx()}`);
    fs.mkdirSync(e, { recursive: true });
    tmpDirs.push(e);
    fs.writeFileSync(path.join(e, "README.md"), "# site-a fold-only E\n");
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: e });
    commitAll(e, "init", GIT_ID);
    const Ke = canonicalRepoLockKey(e);

    const d = path.join(os.tmpdir(), `loom-mqpdkw-d-never-exists-${freshSfx()}`); // deliberately never created
    check("(precondition) D never exists at all", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const dHash = createHash("sha256").update(d).digest("hex").slice(0, 24); // any filename works — content-matched
    const dLatchPath = path.join(MERGE_QUARANTINE_DIR, `${dHash}.json`);
    const dContent = JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own prior raise, resolvedKey manufactured to collide with E",
      enteredAt: Date.now() - 60_000, tokens: ["d-token"], resolvedKey: Ke,
    }, null, 2) + "\n";
    fs.writeFileSync(dLatchPath, dContent);

    const eCorruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ke)}.json`);
    fs.writeFileSync(eCorruptPath, "{");

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); realWarn(...args); };
    try {
      reenterMergeQuarantinesAtBoot([e, d]);
    } finally {
      console.warn = realWarn;
    }

    check("*** FOLD ONLY *** D's own backing file is byte-identical — never overwritten", fs.readFileSync(dLatchPath, "utf8") === dContent);
    check("*** FOLD ONLY *** E's corrupt source file is UNTOUCHED — never self-healed, never deleted (the write was skipped)", fs.readFileSync(eCorruptPath, "utf8") === "{");
    check("*** FOLD ONLY *** the degraded-occupied fold warning fired for this key", warnings.some((w) => w.includes("ALSO occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey")));
    const activeE = activeMergeQuarantineFor(e);
    check("(in-memory) E still reads quarantined via the union (D's identity + both tokens) despite the skipped write", !!activeE && (activeE.tokens ?? []).includes("d-token"));
  } else if (scenarioName === "site-b-multiple-unresolvable-claimants-order-a" || scenarioName === "site-b-multiple-unresolvable-claimants-order-b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 3, MAJOR — round 2's precedence fix still picks ONE winner among MULTIPLE
    // unresolvable paths sharing one degraded hash (first-registered wins in the `!hashToRepo.has(h)`
    // guard), fail-OPENING every claimant but the first. W1 = Y/a and W2 = Y/b, BOTH absent, BOTH
    // registered; Y a real repo but NOT itself registered; Z unrelated, registered, resolvable. A
    // corrupt latch at sha(Ky) (exactly what EITHER W1's or W2's degraded walk produces) must attribute
    // to BOTH W1 and W2 — never just whichever happened to register first — and Z must never be swept.
    // Two registration orders, same outcome both ways (round 2's own order-dependence does not reopen).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, w1, w2, z } = makeYWithTwoAbsentSubdirsAndZ(scenarioName.endsWith("order-a") ? "mcA" : "mcB");
    const Ky = canonicalRepoLockKey(y);
    check("(precondition) W1 and W2 are both absent", !fs.existsSync(w1) && !fs.existsSync(w2));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");

    const order = scenarioName.endsWith("order-a") ? [w1, w2, z] : [w2, w1, z];
    reenterMergeQuarantinesAtBoot(order); // Y deliberately NOT registered

    check("*** THE FIX *** Z is NOT quarantined (never falls through to the fail-closed-every-repo sweep)", activeMergeQuarantineFor(z) === undefined);
    const w1Entry = listActiveMergeQuarantines().find((q) => q.repoPath === w1);
    const w2Entry = listActiveMergeQuarantines().find((q) => q.repoPath === w2);
    check(`*** THE FIX *** W1 is quarantined regardless of registration order — identity (${scenarioName})`, !!w1Entry && w1Entry.placeholder === true);
    check(`*** THE FIX *** W2 is ALSO quarantined — never fail-open just for registering second — identity (${scenarioName})`, !!w2Entry && w2Entry.placeholder === true);
    // Round 4, m2 (Code Review 5339b48f) — identity (listActiveMergeQuarantines) is not enough on its
    // own; a real caller BLOCKS on `activeMergeQuarantineFor`, so assert ENFORCEMENT for both directly.
    const activeW1 = activeMergeQuarantineFor(w1);
    const activeW2 = activeMergeQuarantineFor(w2);
    check(`*** ENFORCEMENT *** activeMergeQuarantineFor(W1) blocks W1 directly (${scenarioName})`, !!activeW1 && activeW1.placeholder === true);
    check(`*** ENFORCEMENT *** activeMergeQuarantineFor(W2) blocks W2 directly (${scenarioName})`, !!activeW2 && activeW2.placeholder === true);
  } else if (scenarioName === "site-c-multiple-unresolvable-claimants-tmp-shape") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 3 — the SAME multi-claimant repro, but via Site C's own corrupt-TMP divert
    // (5b40376c's twin) rather than Site A's corrupt-final divert: W1 and W2's ONLY evidence is a
    // single shared corrupt tmp residue at sha(Ky).json.tmp-<pid>, passing 5b40376c's resolvability
    // gate precisely because neither W1 nor W2 is resolvable. Both must still end up quarantined.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, w1, w2, z } = makeYWithTwoAbsentSubdirsAndZ("mcC");
    const Ky = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json.tmp-999-feedbead`);
    fs.writeFileSync(corruptTmpPath, ""); // corrupt/unparsable — W1/W2's ONLY shared evidence

    reenterMergeQuarantinesAtBoot([w1, w2, z]);

    check("*** THE FIX *** Z is NOT quarantined", activeMergeQuarantineFor(z) === undefined);
    const w1Entry = listActiveMergeQuarantines().find((q) => q.repoPath === w1);
    const w2Entry = listActiveMergeQuarantines().find((q) => q.repoPath === w2);
    check("*** THE FIX *** W1 is quarantined via the shared corrupt tmp — identity", !!w1Entry && w1Entry.placeholder === true);
    check("*** THE FIX *** W2 is ALSO quarantined via the SAME shared corrupt tmp — identity", !!w2Entry && w2Entry.placeholder === true);
    // Round 4, m2 — enforcement, not just identity.
    const activeW1 = activeMergeQuarantineFor(w1);
    const activeW2 = activeMergeQuarantineFor(w2);
    check("*** ENFORCEMENT *** activeMergeQuarantineFor(W1) blocks W1 directly", !!activeW1 && activeW1.placeholder === true);
    check("*** ENFORCEMENT *** activeMergeQuarantineFor(W2) blocks W2 directly", !!activeW2 && activeW2.placeholder === true);
    check("*** THE FIX *** the shared tmp itself survives (neither claimant's divert deletes it)", fs.existsSync(corruptTmpPath));
  } else if (scenarioName === "site-b-remount-one-claimant-no-collateral-damage") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 3 — "remount one claimant in-process ⇒ it stays quarantined", PLUS the residual
    // this card's own multi-claimant fix introduces: two pending entries can now share ONE physical
    // sourceFile. When W1 remounts and GRADUATES (a durable write to its own TRUE key), the pre-existing
    // `deleteSourceLatchIfSuperseded` must NOT delete that shared sourceFile while W2's own, still-
    // pending entry still needs it — verified in-process AND durably, across a restart-sim.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, w1, w2, z } = makeYWithTwoAbsentSubdirsAndZ("remount");
    const Ky = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");

    reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("(precondition) both W1 and W2 are quarantined before remount",
      !!listActiveMergeQuarantines().find((q) => q.repoPath === w1) && !!listActiveMergeQuarantines().find((q) => q.repoPath === w2));

    // Remount W1 IN-PROCESS — a real repo now, with its OWN true key, distinct from the degraded Ky.
    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1 remounted\n");
    commitAll(w1, "init", GIT_ID);
    const Kw1 = canonicalRepoLockKey(w1);
    check("(precondition) W1's true key differs from the degraded Ky", Kw1 !== Ky);

    const activeW1 = activeMergeQuarantineFor(w1); // THE QUERY THAT GRADUATES W1
    check("*** W1 GRADUATES *** W1 still reads quarantined after remount + query", !!activeW1 && activeW1.placeholder === true);
    check("*** W1 GRADUATES *** W1 is genuinely re-keyed at its own true key", !!activeW1 && canonicalRepoLockKey(activeW1.repoPath) === Kw1);

    const activeW2 = listActiveMergeQuarantines().find((q) => q.repoPath === w2);
    check("*** NO COLLATERAL DAMAGE *** W2 is STILL quarantined, in-process, after W1's own graduation", !!activeW2 && activeW2.placeholder === true);

    // DURABILITY — a restart-sim (fresh module instance) proves W2's shared evidence file was never
    // deleted by W1's own graduation write (the exact hazard `deleteSourceLatchIfSuperseded`'s new
    // sibling-ownership check closes) — W2 must still load back from disk, not just survive in-memory.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([w1, w2, z]);
    const activeW2AfterRestart = fresh.listActiveMergeQuarantines().find((q) => q.repoPath === w2);
    check("*** DURABLE *** W2's quarantine SURVIVES a restart — its shared evidence file was never deleted", !!activeW2AfterRestart && activeW2AfterRestart.placeholder === true);
    const activeW1AfterRestart = fresh.activeMergeQuarantineFor(w1);
    check("(restart) W1 (still resolvable) still reads quarantined, genuinely re-keyed at its own true key", !!activeW1AfterRestart && canonicalRepoLockKey(activeW1AfterRestart.repoPath) === Kw1);
  } else if (scenarioName === "clear-one-claimant-reports-kept-and-reasserts-on-restart") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 4, M1, direction (a) — Lead ruling: a human clear of ONE claimant of a shared
    // latch is EXPECTED to re-arm on restart while a sibling still shares the file (the durable
    // per-claimant "tombstone" is a separate, deferred card) — but it must SAY SO plainly, not report a
    // bare, misleadingly-clean success. Pins: clearing W2 alone reports `latchKept`/`referencingRepoPaths`
    // naming W1; the shared file survives; BOTH W1 and W2 re-divert on a restart-sim (never just W1, and
    // never a false "W2 stayed cleared"); clearing the SHARED LATCH BY ID afterward is the durable escape
    // — it lifts BOTH durably, confirmed stable across a FURTHER restart-sim.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, w1, w2 } = makeYWithTwoAbsentSubdirsAndZ("clr1");
    const Ky = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");
    const sharedId = path.basename(corruptPath, ".json");

    reenterMergeQuarantinesAtBoot([w1, w2]);
    check("(precondition) both W1 and W2 are quarantined", !!activeMergeQuarantineFor(w1) && !!activeMergeQuarantineFor(w2));

    // Clear W2 alone, by path.
    const clearResult = clearMergeQuarantine(w2);
    check("*** M1 *** clearing W2 alone reports latchKept:true", clearResult?.latchKept === true);
    check("*** M1 *** the report names W1 as the remaining referencing claimant", Array.isArray(clearResult?.referencingRepoPaths) && clearResult.referencingRepoPaths.includes(w1));
    check("*** M1 *** the shared latch file survives on disk (W1 still needs it)", fs.existsSync(corruptPath));
    check("(in-process) W1 is unaffected", !!activeMergeQuarantineFor(w1));

    // RESTART-SIM — documented, expected behaviour: BOTH re-divert (never just W1; never a false "W2
    // stayed cleared" — the shared file alone is what boot reads, with no per-claimant memory of W2's
    // own explicit clear, by design — see the decision record for why this is direction (a), not a bug).
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, w2]);
    check("*** DOCUMENTED BEHAVIOUR *** W1 re-diverts on restart", !!fresh1.activeMergeQuarantineFor(w1));
    check("*** DOCUMENTED BEHAVIOUR *** W2 ALSO re-diverts on restart (clearing one claimant alone does not survive a restart)", !!fresh1.activeMergeQuarantineFor(w2));

    // THE DURABLE ESCAPE — clear the shared latch BY ID instead.
    const latchResult = fresh1.clearMergeQuarantineLatchFile(sharedId);
    check("*** DURABLE ESCAPE *** clear-by-latch-id reports ok, not kept", latchResult.ok === true && !latchResult.latchKept);
    check("*** DURABLE ESCAPE *** the response names BOTH lifted repoPaths", latchResult.liftedRepoPaths?.length === 2 && latchResult.liftedRepoPaths.includes(w1) && latchResult.liftedRepoPaths.includes(w2));
    check("*** DURABLE ESCAPE *** the shared file is actually gone", !fs.existsSync(corruptPath));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, w2]);
    check("*** DURABLE ESCAPE, CONFIRMED *** neither W1 nor W2 resurrects after a FURTHER restart", !fresh2.activeMergeQuarantineFor(w1) && !fresh2.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "clear-remount-unmount-both-claimants-durable-via-latch-id") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review round 4, M1 — the SECOND failure path: W1 graduates (remount + query), unmounts AGAIN,
    // then both claimants are cleared in-process — but pre-round-4, the shared file survived BOTH clears
    // (`physicalOwnerRepoPaths`'s own fresh-recompute check falsely "protected" it via W1's reverted-to-
    // unresolvable graduated entry, whose degraded key coincidentally collides with the shared one) and
    // both resurrected on restart. Verifies the latch-id clear IS a genuine durable escape in this shape
    // too, post-fix.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, w1, w2 } = makeYWithTwoAbsentSubdirsAndZ("clr2");
    const Ky = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");
    const sharedId = path.basename(corruptPath, ".json");

    reenterMergeQuarantinesAtBoot([w1, w2]);

    // Remount W1, graduate via query, then unmount it again.
    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqpdkw@loom && git config user.name mqpdkw`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1 remounted\n");
    commitAll(w1, "init", GIT_ID);
    const activeW1 = activeMergeQuarantineFor(w1); // graduates
    check("(precondition) W1 graduated to its own true key", !!activeW1 && canonicalRepoLockKey(activeW1.repoPath) !== Ky);
    const parkedW1 = path.join(os.tmpdir(), `loom-mqpdkw-parked-w1-clr2-${freshSfx()}`);
    fs.renameSync(w1, parkedW1);
    check("(precondition) W1 is unresolvable again", !fs.existsSync(w1));

    // THE DURABLE ESCAPE FIRST — clear the shared latch by id while W1's OWN (now-stale, reverted-to-
    // unresolvable) active entry still sits in memory at its own true key.
    const latchResult = clearMergeQuarantineLatchFile(sharedId);
    check("*** THE FIX *** clear-by-latch-id is NOT falsely blocked by W1's own stale, reverted entry", latchResult.ok === true && !latchResult.latchKept);
    check("*** THE FIX *** the response names W2 as lifted (W1's OWN entry is separate — its own file, not this one)", latchResult.liftedRepoPaths?.includes(w2));
    check("*** THE FIX *** the shared file is actually gone", !fs.existsSync(corruptPath));

    // Clear W1's own (separate) graduated entry too, by path.
    clearMergeQuarantine(w1);
    check("(in-process) nothing remains for either claimant", !listActiveMergeQuarantines().some((q) => q.repoPath === w1 || q.repoPath === w2));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([w1, w2]);
    check("*** DURABLE, CONFIRMED *** neither W1 nor W2 resurrects after a restart", !fresh.activeMergeQuarantineFor(w1) && !fresh.activeMergeQuarantineFor(w2));
    check("*** DURABLE, CONFIRMED *** no files remain under the quarantine dir", fs.readdirSync(MERGE_QUARANTINE_DIR).length === 0);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? "\n[scenario] all checks passed" : `\n[scenario] ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
