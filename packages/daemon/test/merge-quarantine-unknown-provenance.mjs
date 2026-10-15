import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card db0a9db0 — the boarded follow-up 82032b5c round 2 named ("pre-round-2 stray union files may
// already exist on disk from when round 1's own fix was live in production — a separate card"), widened
// to every PRE-82032b5c (pre-commit-48aeb324) daemon: that daemon's own `enterMergeQuarantine` `existing`
// branch (commit 60c8052c, lines 953-987) + `writeMergeQuarantineLatch` (same commit, lines 465-489)
// could durably write a runtime union to a FRESHLY-recomputed, untracked key instead of the key actually
// in `armedKeys` (defect A, docs/decisions/82032b5c-*.md) — for a degraded (unresolvable) occupant, with
// NO `contributorRepoPaths` field at all (it didn't exist yet). A CURRENT daemon that boots against such
// a stray file dual-arms it with NO contributor info, so `clearMergeQuarantineLatchFile`'s own
// `ambiguousIdentitiesFor` check sees zero ambiguity — a bare clear-by-id silently lifts a SECOND
// identity's own still-outstanding unconfirmed-kill token with no disclosure anywhere in the refusal
// text or the clear result. Reproduced directly (a hermetic scratch fixture, never committed) before any
// fix was written — see docs/decisions/db0a9db0-*.md for the full repro and the condition's derivation.
//
// THE FIX: `detectUnknownProvenance` (merge-quarantine.ts) marks an entry `provenanceUnknown: true`
// (PERSISTED, STICKY) at every boot-time parse site (PASS 1, PASS 1b tmp recovery, safety-tmp recovery)
// when it finds EXACTLY this shape — `resolvedKey` set and `!== currentKey`, the entry unresolvable,
// `freshHash === hash` (sitting at its own walked-up key), `tokens.length > 1`, and no
// `contributorRepoPaths` — and `ambiguousIdentitiesFor`/`totalAmbiguousCount` now treat it as ambiguous,
// so clear-by-id refuses rather than guessing. FAIL CLOSED is the Lead's own ruling (ambiguousCount>0 on
// this shape): a benign legacy same-identity multi-raise (no second repo ever actually involved) matches
// the SAME on-disk shape and is an ACCEPTED FALSE POSITIVE — it loses the clear-by-id shortcut too
// (clear-by-path still works), strictly cheaper than silently lifting a different repo's own token.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file. Run with no args to spawn one child per scenario; a child reads
// `--scenario=<name>` off argv and runs only that one scenario inline, exiting non-zero on any failure.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-unknown-provenance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  // (a) the exact repro: RED on main (clear-by-id silently lifts Y), GREEN after (refused, both still
  // enforced, then clear-by-path(X) lifts both).
  "stray-union-marked-and-fails-closed-then-clear-by-path-lifts-both",
  // (b) a benign legacy same-identity multi-raise (no second repo ever involved) matches the SAME shape
  // and is marked too — the accepted false positive. Still clearable by path; costs nothing to the
  // bystander repo whose key it happens to be dual-armed under.
  "benign-same-identity-legacy-multi-raise-accepted-false-positive",
  // (c) a single-token legacy file structurally cannot be a union — unaffected.
  "single-token-legacy-file-unaffected",
  // (d) a POST-fix file carrying `contributorRepoPaths` already names its contributor — unaffected by
  // this card's own new mechanism (the pre-existing 82032b5c path still drives it).
  "post-fix-contributor-union-unaffected",
  // (e) restart persistence: a partial clear (one of two tokens) durably rewrites the entry with
  // `provenanceUnknown` now literally in its on-disk bytes; a FRESH boot against that rewritten file
  // reads it back via the sticky carry-forward (not re-derivation) and clear-by-id still refuses.
  "partial-clear-persists-marker-and-survives-restart",
  // ROUND 2 (CR c8e6bc09) — round 1's own detection gated on resolvability, so a migrate-branch boot (the
  // stray entry's own repoPath had since become resolvable) rewrote `resolvedKey` and armed it UNMARKED —
  // RED on commit b8b6167a. (f) reproduces exactly that: a stray union, then `git init` turns X resolvable
  // on a LATER boot, and clear-by-id must still refuse (and Y must still be reachable/enforced) — then
  // clear-by-path lifts both.
  "round2-migrate-branch-fails-closed-then-clear-by-path-lifts-both",
  // (g) the round-2 PRECISION GUARD: a CURRENT-format dual-armed same-identity multi-raise (written WITH
  // `provenanceTracked`, sitting at a secondary key the way `consumeMatchedPendingsIntoArmedEntry` can
  // legitimately produce) must NEVER be marked — behaves exactly as on `main`.
  "current-format-dual-arm-with-provenance-tracked-unaffected",
  // (h) pin EACH carry-forward site with its own one-site DIST mutation, so dropping any one of them
  // goes RED — mirrors the CR's own verification technique.
  "carry-forward-sites-pinned-via-dist-mutation",
  // (i) the PENDING-tier refusal (no active match at all) — drives `clearMergeQuarantineByRecordedPath`,
  // the REAL function behind the route its own remediation text names.
  "pending-tier-refusal-drives-real-clear-by-path-route",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with LOOM_HOME stripped from its env so
  // `useOwnLoomHome` (called inside the child) mints a genuinely fresh one.
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], {
        env: envWithoutLoomHome, stdio: "inherit",
      });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\n✅ ALL SCENARIOS PASS — a pre-82032b5c stray-union latch is marked provenanceUnknown at boot and "
      + "clear-by-id fails closed on it, never silently lifting a second identity's own token."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card db0a9db0.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqup-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, reenterMergeQuarantinesAtBootTestOnly, activeMergeQuarantineFor,
  enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineLatchFile,
  clearMergeQuarantineByRecordedPath, clearMergeQuarantineByToken,
  assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqup@loom -c user.name=mqup";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// @decision db0a9db0 (round 3, CR) — the real `packages/daemon/dist/` is SHARED: the merge gate runs
// test files concurrently (LOOM_GATE_TEST_CONCURRENCY), every one importing the SAME compiled module, and
// a gate timeout SIGKILLs the child before any `finally` can run. Round 2's own `withDistMutation`
// mutated that REAL shared file in place — a sibling lane could have silently run against mutated code,
// and a killed child could have left the mutation in `main`'s own dist for every later run (including the
// live daemon's own next restart). NEVER mutate the real dist in a committed test. Instead: copy the
// SMALL, fully-enumerated import closure `merge-quarantine.js` actually needs (verified by reading its
// own `^import` lines, transitively, until every leaf has none) into a FRESH `os.tmpdir()` directory,
// mutate ONLY that copy, and import the copy — the real files are never opened for writing at all.
const DIST_ROOT = path.join(__dirname, "..", "dist");
// Closure, enumerated by hand from each file's own `^import` lines (never re-derive this by grepping a
// different pattern later — re-read the imports yourself if `merge-quarantine.js`'s own import graph ever
// changes): merge-quarantine.js -> repo-lock.js (same dir) + ../paths.js; repo-lock.js -> merge-quarantine.js
// (circular, already covered); paths.js -> ./pty/resolve-bin.js + ./pty/claude-dirname.js (both node:*-only
// leaves, zero further relative imports).
const CLOSURE_RELATIVE_FILES = [
  "paths.js",
  path.join("pty", "resolve-bin.js"),
  path.join("pty", "claude-dirname.js"),
  path.join("git", "repo-lock.js"),
  path.join("git", "merge-quarantine.js"),
];
const REAL_MERGE_QUARANTINE_PATH = path.join(DIST_ROOT, "git", "merge-quarantine.js");
const hashFile = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// Captured BEFORE any mutation-scenario code runs, so the end-of-scenario check below can catch an
// accidental write from ANY cause, not just a bug in this helper's own copy logic.
const REAL_MERGE_QUARANTINE_HASH_BEFORE = hashFile(REAL_MERGE_QUARANTINE_PATH);

/**
 * ONE-SITE DIST MUTATION, on a throwaway COPY of the minimal import closure — never the real,
 * shared `packages/daemon/dist/`. Copies `CLOSURE_RELATIVE_FILES` into a fresh `os.tmpdir()` directory
 * (preserving their relative structure, so their own untouched `./`/`../` import specifiers still
 * resolve correctly), mutates ONLY the copy of `merge-quarantine.js`, imports THAT copy, and hands the
 * resulting module to `fn`. Always deletes the copy afterward, even if `fn` throws. Throws (never
 * silently no-ops) if `find` doesn't occur EXACTLY once in the copy, so a stale/drifted snippet fails
 * loudly instead of mutating the wrong site or nothing at all.
 */
async function withDistMutation(find, replace, fn) {
  const tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mqup-distcopy-"));
  tmpDirs.push(tmpDistDir);
  try {
    for (const rel of CLOSURE_RELATIVE_FILES) {
      const dest = path.join(tmpDistDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(DIST_ROOT, rel), dest);
    }
    const copyMqPath = path.join(tmpDistDir, "git", "merge-quarantine.js");
    const original = fs.readFileSync(copyMqPath, "utf8");
    const occurrences = original.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`withDistMutation: expected EXACTLY 1 occurrence of the given find-text in the merge-quarantine.js COPY, found ${occurrences}`);
    }
    fs.writeFileSync(copyMqPath, original.replace(find, replace));
    const mutatedModule = await import(pathToFileURL(copyMqPath).href);
    return await fn(mutatedModule);
  } finally {
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
    check("(byte-identical guard) the REAL dist/git/merge-quarantine.js was never written", hashFile(REAL_MERGE_QUARANTINE_PATH) === REAL_MERGE_QUARANTINE_HASH_BEFORE);
  }
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRealRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqup-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

// Writes a latch JSON EXACTLY as 60c8052c's own `writeMergeQuarantineLatch` would have (persisted
// fields only — no `armedKeys`, no `contributorRepoPaths`, no `provenanceUnknown`: none of those three
// fields existed, or were ever populated, in that pre-fix shape) at the given target hash.
function writePreFixLatch(targetHash, { repoPath, branch, reason, enteredAt, tokens, resolvedKey }) {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const file = path.join(MERGE_QUARANTINE_DIR, `${targetHash}.json`);
  fs.writeFileSync(file, JSON.stringify({ repoPath, branch, reason, enteredAt, tokens, resolvedKey }, null, 2) + "\n");
  return file;
}

try {
  if (scenarioName === "stray-union-marked-and-fails-closed-then-clear-by-path-lifts-both") {
    // X unresolvable (never exists), Y a REAL resolvable repo whose own canonicalRepoLockKey IS Ky — the
    // exact 82032b5c shape. Two files, matching defect (A) exactly: Ky's own tracked file (STALE, only
    // X's original token) and the STRAY file at hash(canonicalRepoLockKey(X)) (the untracked key
    // `writeMergeQuarantineLatch(entry, true, undefined, true)` recomputed — see 60c8052c lines 465-489),
    // carrying the FULL union with no contributor marker at all.
    const y = makeRealRepo("a-y");
    const ky = canonicalRepoLockKey(y);
    const x = path.join(os.tmpdir(), `loom-mqup-a-x-never-exists-${freshSfx()}`);
    const enteredAt = Date.now() - 120_000;
    const kyFile = writePreFixLatch(hashForKey(ky), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token"], resolvedKey: ky,
    });
    const strayKey = canonicalRepoLockKey(x);
    check("(precondition) X's own fresh walked-up key differs from Ky — this IS the stray shape", strayKey !== ky);
    const strayFile = writePreFixLatch(hashForKey(strayKey), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token", "y-token"], resolvedKey: ky,
    });

    reenterMergeQuarantinesAtBoot([x, y]);

    const qx = activeMergeQuarantineFor(x);
    check("*** THE FIX *** the dual-armed union is marked provenanceUnknown", qx?.provenanceUnknown === true);
    check("(precondition) the union really does carry both tokens", qx?.tokens.includes("x-token") && qx?.tokens.includes("y-token"));
    check("(precondition) X reads quarantined before any clear", assertRepoNotQuarantined(x).ok === false);
    check("(precondition) Y reads quarantined before any clear (blocked by X's own degraded occupation)", assertRepoNotQuarantined(y).ok === false);

    const bareId = hashForKey(ky);
    const clearResult = clearMergeQuarantineLatchFile(bareId);
    check("*** THE FIX *** clear-by-id REFUSES (ambiguous) instead of silently lifting Y's own token", clearResult.ok === false);
    check("*** THE FIX *** the refusal names the incomplete-provenance reason", clearResult.ok === false && clearResult.reason.includes("provenance is incomplete"));
    check("*** THE FIX *** the refusal names clear-by-path, never a bare clear shortcut", clearResult.ok === false && clearResult.reason.includes("clear-by-path"));
    check("*** THE FIX *** X still reads quarantined after the refused clear", assertRepoNotQuarantined(x).ok === false);
    check("*** THE FIX *** Y still reads quarantined after the refused clear — NOT silently lifted", assertRepoNotQuarantined(y).ok === false);
    check("*** THE FIX *** neither physical file was touched by the refused clear", fs.existsSync(kyFile) && fs.existsSync(strayFile));

    // Drive the REAL route the refusal text actually names (lesson 144: never trust the text alone).
    const pathClear = clearMergeQuarantineByRecordedPath(x);
    check("*** clear-by-path (the route the refusal names) actually lifts the whole entry", pathClear.wasQuarantined === true);
    check("*** after clear-by-path, X reads clear", assertRepoNotQuarantined(x).ok === true);
    check("*** after clear-by-path, Y ALSO reads clear (its own token rode along, exactly as the text warned)", assertRepoNotQuarantined(y).ok === true);
  } else if (scenarioName === "benign-same-identity-legacy-multi-raise-accepted-false-positive") {
    // X unresolvable, raised twice under itself (NO second repo ever involved) — but it still matches the
    // exact on-disk SHAPE defect (A) produces: dual-armed, multiple tokens, resolvedKey mismatched. Z is
    // a real, resolvable repo whose key X's own `resolvedKey` happens to name (X used to be nested under
    // Z, long gone) — never raised itself, but blocked anyway by X's own pre-existing dual-arm mechanics
    // (883e29bc — unrelated to, and unchanged by, this card): a degraded occupant's dual-arm at its own
    // `resolvedKey` blocks WHOEVER owns that key, exactly like scenario (a)'s Y.
    const z = makeRealRepo("b-z");
    const kz = canonicalRepoLockKey(z);
    const x = path.join(os.tmpdir(), `loom-mqup-b-x-never-exists-${freshSfx()}`);
    const strayKey = canonicalRepoLockKey(x);
    check("(precondition) X's own fresh walked-up key differs from Kz", strayKey !== kz);
    writePreFixLatch(hashForKey(strayKey), {
      repoPath: x, branch: "x-branch", reason: "X raised twice, by itself — no Z involvement, ever",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-1", "x-token-2"], resolvedKey: kz,
    });

    reenterMergeQuarantinesAtBoot([x, z]);

    const qx = activeMergeQuarantineFor(x);
    check("*** ACCEPTED FALSE POSITIVE *** the benign same-identity entry is ALSO marked provenanceUnknown", qx?.provenanceUnknown === true);
    check("(pre-existing, unrelated to this card) Z is blocked by X's own dual-arm, same as scenario (a)'s Y", assertRepoNotQuarantined(z).ok === false);

    const clearResult = clearMergeQuarantineLatchFile(hashForKey(kz));
    check("*** ACCEPTED FALSE POSITIVE *** clear-by-id refuses anyway (cannot tell benign from real)", clearResult.ok === false);
    const pathClear = clearMergeQuarantineByRecordedPath(x);
    check("*** clear-by-path still works — the false positive costs exactly one redirected clear ***", pathClear.wasQuarantined === true);
    check("X reads clear after clear-by-path", assertRepoNotQuarantined(x).ok === true);
    check("Z ALSO reads clear after clear-by-path(X) — it was never its own, separate quarantine", assertRepoNotQuarantined(z).ok === true);
  } else if (scenarioName === "single-token-legacy-file-unaffected") {
    // The exact same shape as the benign scenario above, but with ONE token — structurally cannot be a
    // union (one raise mints exactly one token), so detectUnknownProvenance must never mark it.
    const z = makeRealRepo("c-z");
    const kz = canonicalRepoLockKey(z);
    const x = path.join(os.tmpdir(), `loom-mqup-c-x-never-exists-${freshSfx()}`);
    const strayKey = canonicalRepoLockKey(x);
    writePreFixLatch(hashForKey(strayKey), {
      repoPath: x, branch: "x-branch", reason: "X raised exactly once",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-1"], resolvedKey: kz,
    });

    reenterMergeQuarantinesAtBoot([x, z]);

    const qx = activeMergeQuarantineFor(x);
    check("*** UNAFFECTED *** a single-token legacy entry is NEVER marked provenanceUnknown", !qx?.provenanceUnknown);
    const clearResult = clearMergeQuarantineLatchFile(hashForKey(kz));
    check("*** UNAFFECTED *** clear-by-id still succeeds unambiguously, exactly as before this card", clearResult.ok === true);
  } else if (scenarioName === "post-fix-contributor-union-unaffected") {
    // The PRE-EXISTING 82032b5c mechanism (contributorRepoPaths), driven through the REAL (current,
    // fixed) enterMergeQuarantine — must stay byte-for-byte unaffected by this card's own new mechanism.
    const y = makeRealRepo("d-y");
    const ky = canonicalRepoLockKey(y);
    const x = path.join(os.tmpdir(), `loom-mqup-d-x-never-exists-${freshSfx()}`);
    writePreFixLatch(hashForKey(ky), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    });
    reenterMergeQuarantinesAtBoot([x]);
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");

    const qx = activeMergeQuarantineFor(x);
    check("*** UNAFFECTED *** a REAL post-fix runtime union is never marked provenanceUnknown", !qx?.provenanceUnknown);
    check("*** UNAFFECTED *** it still carries contributorRepoPaths naming Y, via the pre-existing mechanism", !!qx?.contributorRepoPaths?.includes(y));
    const clearResult = clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** UNAFFECTED *** clear-by-id still refuses, citing Y BY NAME (the pre-existing 82032b5c text)", clearResult.ok === false && clearResult.reason.includes(y));
  } else if (scenarioName === "partial-clear-persists-marker-and-survives-restart") {
    const y = makeRealRepo("e-y");
    const ky = canonicalRepoLockKey(y);
    const x = path.join(os.tmpdir(), `loom-mqup-e-x-never-exists-${freshSfx()}`);
    const enteredAt = Date.now() - 120_000;
    const kyFile = writePreFixLatch(hashForKey(ky), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token"], resolvedKey: ky,
    });
    const strayKey = canonicalRepoLockKey(x);
    const strayFile = writePreFixLatch(hashForKey(strayKey), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token", "y-token"], resolvedKey: ky,
    });

    reenterMergeQuarantinesAtBoot([x, y]);
    check("(precondition) marked after first boot", activeMergeQuarantineFor(x)?.provenanceUnknown === true);
    check("(precondition) neither physical file carries the marker YET — in-memory only after boot", !fs.readFileSync(kyFile, "utf8").includes("provenanceUnknown") && !fs.readFileSync(strayFile, "utf8").includes("provenanceUnknown"));

    // A PARTIAL clear (one of two tokens) durably rewrites every armed key — this is the write path that
    // actually puts the marker on disk, byte-for-byte, for the first time.
    clearMergeQuarantineByToken(y, "y-token");
    check("*** the partial clear left X's own token still outstanding ***", activeMergeQuarantineFor(x)?.tokens?.length === 1 && activeMergeQuarantineFor(x)?.tokens?.includes("x-token"));
    check("*** THE FIX *** the partial-clear rewrite PERSISTS provenanceUnknown to BOTH physical files", fs.readFileSync(kyFile, "utf8").includes('"provenanceUnknown": true') && fs.readFileSync(strayFile, "utf8").includes('"provenanceUnknown": true'));

    // Simulate a FRESH boot (a genuinely separate module instance, re-reading these now-rewritten files
    // from scratch) — this time the marker is read back via the sticky carry-forward of a REAL persisted
    // field, not re-derived from the structural shape.
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([x, y]);
    check("*** RESTART PERSISTENCE *** a fresh boot reads the marker back from disk", reboot.activeMergeQuarantineFor(x)?.provenanceUnknown === true);
    const afterReboot = reboot.clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** RESTART PERSISTENCE *** clear-by-id still refuses after the restart", afterReboot.ok === false);
  } else if (scenarioName === "round2-migrate-branch-fails-closed-then-clear-by-path-lifts-both") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2 BLOCKER (CR c8e6bc09) — round 1's own detectUnknownProvenance gated on `resolvableNow`,
    // and was called ONLY at the dual-arm fallthrough. The exact SAME stray-union fixture as scenario
    // (a), but X becomes resolvable (`git init`) before the SECOND boot — on that boot, PASS 1's own
    // `freshHash !== hash && resolvableNow` MIGRATE branch runs for X's STALE (Ky) file, and (round 1)
    // detection never fired for the stray file either, since it gated on resolvability. RED on b8b6167a.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRealRepo("f-y");
    const ky = canonicalRepoLockKey(y);
    const x = path.join(os.tmpdir(), `loom-mqup-f-x-never-exists-${freshSfx()}`);
    tmpDirs.push(x); // not yet created — registered now so cleanup covers it once git-init'd below
    const enteredAt = Date.now() - 120_000;
    const xFreshKeyBefore = canonicalRepoLockKey(x);
    check("(precondition) X's own fresh walked-up key differs from Ky — this IS the stray shape", xFreshKeyBefore !== ky);
    writePreFixLatch(hashForKey(ky), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token"], resolvedKey: ky,
    });
    writePreFixLatch(hashForKey(xFreshKeyBefore), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token", "y-token"], resolvedKey: ky,
    });

    reenterMergeQuarantinesAtBoot([x, y]);
    check("(precondition) marked after the first (X still unresolvable) boot", activeMergeQuarantineFor(x)?.provenanceUnknown === true);

    // X becomes resolvable — the exact round-2 blocker trigger.
    fs.mkdirSync(x, { recursive: true });
    fs.writeFileSync(path.join(x, "README.md"), "# x\n");
    execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: x });
    commitAll(x, "init", GIT_ID);

    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([x, y]);
    const qx = reboot.activeMergeQuarantineFor(x);
    check("*** THE FIX (round 2) *** still marked provenanceUnknown after X becomes resolvable and migrates", qx?.provenanceUnknown === true);
    check("*** THE FIX (round 2) *** X itself still reads quarantined", reboot.assertRepoNotQuarantined(x).ok === false);
    check("*** THE FIX (round 2) *** Y is still reachable/enforced (its own key is still one of the armed keys)", reboot.assertRepoNotQuarantined(y).ok === false);

    const idToClear = hashForKey(ky);
    const clearResult = reboot.clearMergeQuarantineLatchFile(idToClear);
    check("*** THE FIX (round 2) *** clear-by-id REFUSES even though X is now resolvable and migrated", clearResult.ok === false);
    check("*** THE FIX (round 2) *** Y still reads quarantined after the refused clear — NOT silently lifted", reboot.assertRepoNotQuarantined(y).ok === false);

    const pathClear = reboot.clearMergeQuarantineByRecordedPath(x);
    check("*** clear-by-path (the route the refusal names) actually lifts the whole entry ***", pathClear.wasQuarantined === true);
    check("*** after clear-by-path, X reads clear ***", reboot.assertRepoNotQuarantined(x).ok === true);
    check("*** after clear-by-path, Y ALSO reads clear ***", reboot.assertRepoNotQuarantined(y).ok === true);
  } else if (scenarioName === "current-format-dual-arm-with-provenance-tracked-unaffected") {
    // The round-2 PRECISION GUARD: mirrors the sibling file's own `buildDualArmFixture` shape EXACTLY (E
    // resolvable, dual-armed at K1 with a stale secondary `resolvedKey` K2 that physically has no file of
    // its own) — but hand-written WITH `provenanceTracked: true`, simulating a file the CURRENT
    // (post-round-2) code already wrote. Without the precision guard, this shape (hash !==
    // quarantineHashForKey(resolvedKey), multi-token, no contributorRepoPaths) would be newly marked —
    // a regression for a CURRENT, legitimate dual-arm that never touched the legacy defect at all.
    const e = makeRealRepo("g-e");
    const k1 = canonicalRepoLockKey(e);
    const w = path.join(os.tmpdir(), `loom-mqup-g-w-never-exists-${freshSfx()}`);
    const k2 = canonicalRepoLockKey(w);
    check("(precondition) K1 and K2 genuinely differ", k1 !== k2);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const eFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
    fs.writeFileSync(eFile, JSON.stringify({
      repoPath: e, branch: "e-branch", reason: "E dual-armed via a legacy stale resolvedKey=K2, CURRENT format",
      enteredAt: Date.now() - 60_000, tokens: ["e-token-1", "e-token-2"], resolvedKey: k2,
      provenanceTracked: true,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([e]);
    const qe = activeMergeQuarantineFor(e);
    check("(precondition) it really is dual-armed at both K1 and K2", !!qe?.armedKeys?.includes(k1) && !!qe?.armedKeys?.includes(k2));
    check("*** PRECISION GUARD *** a current-format (provenanceTracked) dual-arm is NEVER marked provenanceUnknown", !qe?.provenanceUnknown);

    const clearResult = clearMergeQuarantineLatchFile(hashForKey(k1));
    check("*** PRECISION GUARD *** clear-by-id still succeeds unambiguously — behaves exactly as on main", clearResult.ok === true);
  } else if (scenarioName === "carry-forward-sites-pinned-via-dist-mutation") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Pins EACH carry-forward site with its own one-site DIST mutation (mirrors the CR's own technique):
    // temporarily disable JUST that site in the REAL compiled module, confirm the expected marking is
    // LOST under the mutation, confirm it is PRESENT again once restored. Six sites, per the CR:
    // unionQuarantineEntries' OR (both directions), protectDegradedOccupantBeforeDelete's whitelist,
    // PASS 1b's parse+detection, safety-tmp's parse+detection, and mergeTokenIntoPendingEntries' OR.
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    // --- (1)+(2) unionQuarantineEntries' OR, BOTH directions ------------------------------------------
    // Two sibling subdirs of ONE real repo (the 7673d096 "collapse" shape — both RESOLVABLE, so both
    // migrate and collapse onto ONE key via the deferred write-union) — one hand-written WITH
    // `provenanceUnknown: true` already set (simulating a real, sticky, persisted marker), the other
    // without. Direction 1: the OLDER file carries it. Direction 2: the NEWER file carries it.
    const buildCollapseFixture = (tag, olderHasIt) => {
      const repo = path.join(os.tmpdir(), `loom-mqup-h-collapse-${tag}-${freshSfx()}`);
      const teamA = path.join(repo, "teamA");
      const teamB = path.join(repo, "teamB");
      fs.mkdirSync(teamA, { recursive: true });
      fs.mkdirSync(teamB, { recursive: true });
      tmpDirs.push(repo);
      fs.writeFileSync(path.join(teamA, "a.txt"), "team a\n");
      fs.writeFileSync(path.join(teamB, "b.txt"), "team b\n");
      execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: repo });
      commitAll(repo, "init", GIT_ID);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const olderEntry = { repoPath: teamA, branch: "older-branch", reason: `collapse-${tag}-older`, enteredAt: Date.now() - 60_000, tokens: ["token-older"], ...(olderHasIt ? { provenanceUnknown: true } : {}) };
      const newerEntry = { repoPath: teamB, branch: "newer-branch", reason: `collapse-${tag}-newer`, enteredAt: Date.now(), tokens: ["token-newer"], ...(!olderHasIt ? { provenanceUnknown: true } : {}) };
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-${tag}-a.json`), JSON.stringify(olderEntry));
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-${tag}-b.json`), JSON.stringify(newerEntry));
      return { teamA, teamB };
    };
    const UNION_OR_LINE = "const provenanceUnknown = older.provenanceUnknown || newer.provenanceUnknown ? true : undefined;";
    {
      const { teamA } = buildCollapseFixture("dir1-baseline", true);
      reenterMergeQuarantinesAtBoot([teamA]);
      check("(1a baseline, unmutated) older-has-it collapse carries provenanceUnknown", activeMergeQuarantineFor(teamA)?.provenanceUnknown === true);
    }
    await withDistMutation(UNION_OR_LINE, "const provenanceUnknown = newer.provenanceUnknown ? true : undefined;", async (m) => {
      const { teamA } = buildCollapseFixture("dir1-mutated", true);
      m.reenterMergeQuarantinesAtBoot([teamA]);
      check("*** PINNED (1) *** dropping the OLDER side of the OR loses an older-only marker — caught", !m.activeMergeQuarantineFor(teamA)?.provenanceUnknown);
    });
    {
      const { teamB } = buildCollapseFixture("dir2-baseline", false);
      reenterMergeQuarantinesAtBoot([teamB]);
      check("(2a baseline, unmutated) newer-has-it collapse carries provenanceUnknown", activeMergeQuarantineFor(teamB)?.provenanceUnknown === true);
    }
    await withDistMutation(UNION_OR_LINE, "const provenanceUnknown = older.provenanceUnknown ? true : undefined;", async (m) => {
      const { teamB } = buildCollapseFixture("dir2-mutated", false);
      m.reenterMergeQuarantinesAtBoot([teamB]);
      check("*** PINNED (2) *** dropping the NEWER side of the OR loses a newer-only marker — caught", !m.activeMergeQuarantineFor(teamB)?.provenanceUnknown);
    });

    // --- (3) protectDegradedOccupantBeforeDelete's own whitelist --------------------------------------
    const buildProtectFixture = (tag) => {
      const y3 = makeRealRepo(`h3-y-${tag}`);
      const ky3 = canonicalRepoLockKey(y3);
      const x3 = path.join(os.tmpdir(), `loom-mqup-h3-x-${tag}-never-exists-${freshSfx()}`);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky3)}.json`), JSON.stringify({
        repoPath: x3, branch: "x-branch", reason: `X's manufactured collision with Y (h3-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky3, provenanceUnknown: true,
      }, null, 2) + "\n");
      return { x3, y3 };
    };
    // @decision db0a9db0 (round 4, MAJOR fix) — select the protective copy by X3's own IDENTITY
    // (repoPath === x3), never by "exactly one pending-*.json file in the shared directory": the
    // baseline sub-check below never cleans up its own pending file (MERGE_QUARANTINE_DIR is shared
    // across this whole scenario's single LOOM_HOME), so the MUTATED run's own directory listing can
    // contain TWO pending files — the baseline's leftover plus this run's own — making
    // `protectiveFiles.length !== 1` true regardless of whether the real mutation did anything, which
    // made every downstream check pass VACUOUSLY (round-2's own no-op-mutation audit proved this: with a
    // temporary no-op replacement in place of the real mutation, this sub-check still "passed").
    const runProtectAndReadCopy = async (m, x3, y3) => {
      m.reenterMergeQuarantinesAtBoot([x3]);
      m.enterMergeQuarantine(y3, "y-branch", "y's own genuine unconfirmed-kill reason");
      m.clearMergeQuarantine(y3); // triggers protectDegradedOccupantBeforeDelete for X's own content
      const protectiveFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      const matches = protectiveFiles
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })
        .filter((parsed) => parsed?.repoPath === x3);
      // Non-vacuity, asserted here so BOTH call sites (baseline and mutated) get it for free: exactly one
      // match for X3's own identity — never zero (the protect call silently didn't run or didn't write),
      // never more than one (an identity mixup with a leftover file from an earlier sub-check).
      check("(precondition) exactly one protective copy was found for X3's own identity — not zero, not more than one", matches.length === 1);
      return matches[0];
    };
    {
      const { x3, y3 } = buildProtectFixture("baseline");
      const protective = await runProtectAndReadCopy(await rebootSim(), x3, y3);
      check("(3a baseline, unmutated) the protective copy carries provenanceUnknown forward", protective?.provenanceUnknown === true);
    }
    // Card 6451a749 renamed/moved the line that used to follow this block (`const filename =
    // pendingDivertFilenameFor(occupantRepoPath);`, now `const finalBasename = path.basename(final);`,
    // with the filename/toWrite derivation itself moved into the shared `reconcilePendingDivertTarget`
    // chokepoint) — the anchor below is updated to match, same disambiguating-suffix technique as before.
    // Card 4b06875f added a `resolvedKey` field (with its own two-line comment) between
    // `provenanceTracked` and the closing `};` — the anchor below is extended to match, same
    // disambiguating-suffix technique as the 6451a749 update noted above. Card 43cf3b26 added a
    // `resolvedKeys` field right after `resolvedKey` — extended again, same technique.
    const PROTECT_WHITELIST_LINE = "provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,\n        // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.\n        provenanceTracked: parsed.provenanceTracked === true ? true : undefined,\n        // @decision 8db913e2 (Follow-up 4b06875f) — see the guard computed just above; `undefined` here is the pre-existing,\n        // unchanged behavior for every self-consistently-filed (collision) occupant.\n        resolvedKey: resolvedKeyToCarry,\n        resolvedKeys: resolvedKeysToCarry,\n    };\n    const finalBasename = path.basename(final);";
    await withDistMutation(PROTECT_WHITELIST_LINE,
      "provenanceUnknown: undefined, provenanceTracked: undefined, resolvedKey: resolvedKeyToCarry, resolvedKeys: resolvedKeysToCarry };\n    const finalBasename = path.basename(final);", async (m) => {
        const { x3, y3 } = buildProtectFixture("mutated");
        const protective = await runProtectAndReadCopy(m, x3, y3);
        check("*** PINNED (3) *** dropping the whitelist's own carry-forward loses it in the protective copy — caught", protective?.provenanceUnknown !== true);
      });

    // --- (4) PASS 1b's own parse + detection -----------------------------------------------------------
    const buildPass1bFixture = (tag) => {
      const y4 = makeRealRepo(`h4-y-${tag}`);
      const ky4 = canonicalRepoLockKey(y4);
      const x4 = path.join(os.tmpdir(), `loom-mqup-h4-x-${tag}-never-exists-${freshSfx()}`);
      const xKey4 = canonicalRepoLockKey(x4);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(xKey4)}.json.tmp-99999-abcdef12`), JSON.stringify({
        repoPath: x4, branch: "x-branch", reason: `stray union via a PASS1b tmp residue (h4-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token-h4", "y-token-h4"], resolvedKey: ky4,
      }, null, 2) + "\n");
      return { x4, y4 };
    };
    {
      const { x4, y4 } = buildPass1bFixture("baseline");
      reenterMergeQuarantinesAtBoot([x4, y4]);
      check("(4a baseline, unmutated) a PASS1b-sourced stray tmp is marked provenanceUnknown", activeMergeQuarantineFor(x4)?.provenanceUnknown === true);
    }
    const PASS1B_DETECT_BLOCK = "// @decision db0a9db0 (round 2) — detect UNCONDITIONALLY, before any branch below, mirroring PASS 1's\n            // own ordering fix; see detectUnknownProvenance's own doc.\n            if (detectUnknownProvenance(entry, hash)) {";
    await withDistMutation(PASS1B_DETECT_BLOCK,
      PASS1B_DETECT_BLOCK.replace("if (detectUnknownProvenance(entry, hash)) {", "if (false) {"), async (m) => {
        const { x4, y4 } = buildPass1bFixture("mutated");
        m.reenterMergeQuarantinesAtBoot([x4, y4]);
        check("*** PINNED (4) *** disabling PASS 1b's own detection call loses the marker — caught", !m.activeMergeQuarantineFor(x4)?.provenanceUnknown);
      });

    // --- (5) safety-tmp recovery's own parse + detection -----------------------------------------------
    const buildSafetyTmpFixture = (tag) => {
      const y5 = makeRealRepo(`h5-y-${tag}`);
      const ky5 = canonicalRepoLockKey(y5);
      const x5 = path.join(os.tmpdir(), `loom-mqup-h5-x-${tag}-never-exists-${freshSfx()}`);
      const xKey5 = canonicalRepoLockKey(x5);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(xKey5)}.json.tmp-safety-88888-deadbeef12`), JSON.stringify({
        repoPath: x5, branch: "x-branch", reason: `stray union via a safety-tmp residue (h5-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token-h5", "y-token-h5"], resolvedKey: ky5,
      }, null, 2) + "\n");
      return { x5, y5 };
    };
    {
      const { x5, y5 } = buildSafetyTmpFixture("baseline");
      reenterMergeQuarantinesAtBoot([x5, y5]);
      check("(5a baseline, unmutated) a safety-tmp-sourced stray residue is marked provenanceUnknown", activeMergeQuarantineFor(x5)?.provenanceUnknown === true);
    }
    const SAFETYTMP_DETECT_BLOCK = "// @decision db0a9db0 (round 2) — detect UNCONDITIONALLY, before any branch below, mirroring PASS 1/\n            // 1b's own ordering fix; see detectUnknownProvenance's own doc.\n            if (detectUnknownProvenance(entry, hash)) {";
    await withDistMutation(SAFETYTMP_DETECT_BLOCK,
      SAFETYTMP_DETECT_BLOCK.replace("if (detectUnknownProvenance(entry, hash)) {", "if (false) {"), async (m) => {
        const { x5, y5 } = buildSafetyTmpFixture("mutated");
        m.reenterMergeQuarantinesAtBoot([x5, y5]);
        check("*** PINNED (5) *** disabling safety-tmp's own detection call loses the marker — caught", !m.activeMergeQuarantineFor(x5)?.provenanceUnknown);
      });

    // --- (6) mergeTokenIntoPendingEntries' own cross-matched OR ----------------------------------------
    // TWO separate pending sources for the SAME unresolvable identity X — both via the "no resolvedKey,
    // unresolvable" early-pending branch (so neither is `base` by virtue of being the ONLY matched entry).
    // The LATER-entered one (never `base`, since base is chosen by EARLIEST enteredAt) carries the marker
    // — proving the cross-matched OR reaches beyond a bare `...base.entry` spread.
    const buildMergePendingFixture = (tag) => {
      const x6 = path.join(os.tmpdir(), `loom-mqup-h6-x-${tag}-never-exists-${freshSfx()}`);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `h6-${tag}-a-${freshSfx()}.json`), JSON.stringify({
        repoPath: x6, branch: "x-branch-a", reason: `h6-${tag}-source-a (base, older, no marker)`,
        enteredAt: Date.now() - 120_000, tokens: ["x-token-h6-a"],
      }, null, 2) + "\n");
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `h6-${tag}-b-${freshSfx()}.json`), JSON.stringify({
        repoPath: x6, branch: "x-branch-b", reason: `h6-${tag}-source-b (non-base, newer, CARRIES the marker)`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token-h6-b"], provenanceUnknown: true,
      }, null, 2) + "\n");
      return x6;
    };
    {
      const x6 = buildMergePendingFixture("baseline");
      reenterMergeQuarantinesAtBoot([x6]);
      enterMergeQuarantine(x6, "x-branch-fresh", "a fresh raise merging into both pending sources");
      check("(6a baseline, unmutated) the merged pending entry carries provenanceUnknown from the non-base source", activeMergeQuarantineFor(x6)?.provenanceUnknown === true);
    }
    const MERGE_PENDING_OR_LINE = "const provenanceUnknown = matched.some((p) => p.entry.provenanceUnknown) ? true : undefined;";
    await withDistMutation(MERGE_PENDING_OR_LINE, "const provenanceUnknown = base.entry.provenanceUnknown ? true : undefined;", async (m) => {
      const x6 = buildMergePendingFixture("mutated");
      m.reenterMergeQuarantinesAtBoot([x6]);
      m.enterMergeQuarantine(x6, "x-branch-fresh", "a fresh raise merging into both pending sources");
      check("*** PINNED (6) *** narrowing the OR to `base` alone loses a non-base marker — caught", !m.activeMergeQuarantineFor(x6)?.provenanceUnknown);
    });

    // @decision db0a9db0 (round 4) — (1)-(6) above pin provenanceUnknown's own carry-forward at every
    // site. provenanceTracked's carry (the PRECISION GUARD) was pinned ONLY at PASS 1's own parse,
    // indirectly, via scenario (g) — never at its OWN remaining sites. (7)-(11) below close that gap,
    // mirroring (g)'s own CURRENT-format (provenanceTracked:true) dual-arm shape at each site in turn.

    // --- (7) PASS 1b's own parse+detection — same dual-arm precision-guard shape as scenario (g), but
    // reached via a `.json.tmp-<pid>-<hex>` residue instead of a `.json` final -----------------------
    const buildPass1bTrackedFixture = (tag) => {
      const e7 = makeRealRepo(`h7-e-${tag}`);
      const k1_7 = canonicalRepoLockKey(e7);
      const w7 = path.join(os.tmpdir(), `loom-mqup-h7-w-${tag}-never-exists-${freshSfx()}`);
      const k2_7 = canonicalRepoLockKey(w7);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1_7)}.json.tmp-77777-abcdef12`), JSON.stringify({
        repoPath: e7, branch: "e-branch", reason: `current-format dual-arm via a PASS1b tmp residue (h7-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["e-token-h7-1", "e-token-h7-2"], resolvedKey: k2_7,
        provenanceTracked: true,
      }, null, 2) + "\n");
      return { e7, k1_7, k2_7 };
    };
    {
      const { e7, k1_7, k2_7 } = buildPass1bTrackedFixture("baseline");
      reenterMergeQuarantinesAtBoot([e7]);
      const qe7 = activeMergeQuarantineFor(e7);
      check("(7a precondition, unmutated) dual-armed at both K1 and K2 via a PASS1b tmp residue", !!qe7?.armedKeys?.includes(k1_7) && !!qe7?.armedKeys?.includes(k2_7));
      check("(7a baseline, unmutated) a current-format PASS1b tmp-residue dual-arm is NEVER marked provenanceUnknown", !qe7?.provenanceUnknown);
    }
    // NOTE: the `withDistMutation` find-text below must match the COMPILED dist's own indentation
    // (16 spaces at this nesting level), never the TS source's — tsc's emitter does not preserve the
    // source's own indentation width.
    const PASS1B_TRACKED_CARRY = "// @decision db0a9db0 — same carry-forward, same reason, for a tmp-residue recovery.\n                provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,\n                // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.\n                provenanceTracked: parsed.provenanceTracked === true ? true : undefined,";
    await withDistMutation(PASS1B_TRACKED_CARRY,
      PASS1B_TRACKED_CARRY.replace("provenanceTracked: parsed.provenanceTracked === true ? true : undefined,", "provenanceTracked: undefined,"), async (m) => {
        const { e7 } = buildPass1bTrackedFixture("mutated");
        m.reenterMergeQuarantinesAtBoot([e7]);
        check("*** PINNED (7) *** dropping PASS1b's own provenanceTracked carry WRONGLY marks a current-format dual-arm — caught", m.activeMergeQuarantineFor(e7)?.provenanceUnknown === true);
      });

    // --- (8) safety-tmp recovery's own parse+detection — same shape, via a `.json.tmp-safety-` residue -
    const buildSafetyTmpTrackedFixture = (tag) => {
      const e8 = makeRealRepo(`h8-e-${tag}`);
      const k1_8 = canonicalRepoLockKey(e8);
      const w8 = path.join(os.tmpdir(), `loom-mqup-h8-w-${tag}-never-exists-${freshSfx()}`);
      const k2_8 = canonicalRepoLockKey(w8);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1_8)}.json.tmp-safety-88888-abcdef12`), JSON.stringify({
        repoPath: e8, branch: "e-branch", reason: `current-format dual-arm via a safety-tmp residue (h8-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["e-token-h8-1", "e-token-h8-2"], resolvedKey: k2_8,
        provenanceTracked: true,
      }, null, 2) + "\n");
      return { e8, k1_8, k2_8 };
    };
    {
      const { e8, k1_8, k2_8 } = buildSafetyTmpTrackedFixture("baseline");
      reenterMergeQuarantinesAtBoot([e8]);
      const qe8 = activeMergeQuarantineFor(e8);
      check("(8a precondition, unmutated) dual-armed at both K1 and K2 via a safety-tmp residue", !!qe8?.armedKeys?.includes(k1_8) && !!qe8?.armedKeys?.includes(k2_8));
      check("(8a baseline, unmutated) a current-format safety-tmp-residue dual-arm is NEVER marked provenanceUnknown", !qe8?.provenanceUnknown);
    }
    const SAFETYTMP_TRACKED_CARRY = "// @decision db0a9db0 — same carry-forward, same reason, for a safety-tmp recovery.\n                provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,\n                // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.\n                provenanceTracked: parsed.provenanceTracked === true ? true : undefined,";
    await withDistMutation(SAFETYTMP_TRACKED_CARRY,
      SAFETYTMP_TRACKED_CARRY.replace("provenanceTracked: parsed.provenanceTracked === true ? true : undefined,", "provenanceTracked: undefined,"), async (m) => {
        const { e8 } = buildSafetyTmpTrackedFixture("mutated");
        m.reenterMergeQuarantinesAtBoot([e8]);
        check("*** PINNED (8) *** dropping safety-tmp's own provenanceTracked carry WRONGLY marks a current-format dual-arm — caught", m.activeMergeQuarantineFor(e8)?.provenanceUnknown === true);
      });

    // --- (9) unionQuarantineEntries' OR — the precision-guard field, via the SAME 7673d096 "collapse"
    // shape (1)/(2) above use for provenanceUnknown. A direct field check, mirroring (1)/(2)'s own style:
    // the merged/collapsed entry's own resolvedKey always equals its own post-migrate physical key (so it
    // can never itself BE marked provenanceUnknown — collapse is structurally exempt from that), but the
    // union's own OR is still the only thing carrying provenanceTracked into the merged in-memory object,
    // and dropping it is still real, observable data loss. ------------------------------------------------
    const buildCollapseTrackedFixture = (tag, olderHasIt) => {
      const repo = path.join(os.tmpdir(), `loom-mqup-h9-collapse-${tag}-${freshSfx()}`);
      const teamA = path.join(repo, "teamA");
      const teamB = path.join(repo, "teamB");
      fs.mkdirSync(teamA, { recursive: true });
      fs.mkdirSync(teamB, { recursive: true });
      tmpDirs.push(repo);
      fs.writeFileSync(path.join(teamA, "a.txt"), "team a\n");
      fs.writeFileSync(path.join(teamB, "b.txt"), "team b\n");
      execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: repo });
      commitAll(repo, "init", GIT_ID);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const olderEntry = { repoPath: teamA, branch: "older-branch", reason: `collapse-tracked-${tag}-older`, enteredAt: Date.now() - 60_000, tokens: ["token-older-h9"], ...(olderHasIt ? { provenanceTracked: true } : {}) };
      const newerEntry = { repoPath: teamB, branch: "newer-branch", reason: `collapse-tracked-${tag}-newer`, enteredAt: Date.now(), tokens: ["token-newer-h9"], ...(!olderHasIt ? { provenanceTracked: true } : {}) };
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-tracked-${tag}-a.json`), JSON.stringify(olderEntry));
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-tracked-${tag}-b.json`), JSON.stringify(newerEntry));
      return { teamA, teamB };
    };
    {
      const { teamA } = buildCollapseTrackedFixture("dir9-baseline", true);
      reenterMergeQuarantinesAtBoot([teamA]);
      check("(9a baseline, unmutated) older-has-it collapse carries provenanceTracked", activeMergeQuarantineFor(teamA)?.provenanceTracked === true);
    }
    const UNION_OR_LINE_TRACKED = "const provenanceTracked = older.provenanceTracked || newer.provenanceTracked ? true : undefined;";
    await withDistMutation(UNION_OR_LINE_TRACKED, "const provenanceTracked = newer.provenanceTracked ? true : undefined;", async (m) => {
      const { teamA } = buildCollapseTrackedFixture("dir9-mutated", true);
      m.reenterMergeQuarantinesAtBoot([teamA]);
      check("*** PINNED (9) *** dropping the OLDER side of the provenanceTracked OR loses an older-only marker — caught", !m.activeMergeQuarantineFor(teamA)?.provenanceTracked);
    });

    // --- (10) protectDegradedOccupantBeforeDelete's own whitelist — the precision-guard field, ISOLATED
    // from provenanceUnknown's own carry (pin (3) above mutates BOTH fields at once; this pin isolates
    // JUST provenanceTracked's own line, so a future edit that keeps provenanceUnknown's carry intact but
    // breaks ONLY provenanceTracked's is still caught by something). ---------------------------------------
    const buildProtectTrackedFixture = (tag) => {
      const y10 = makeRealRepo(`h10-y-${tag}`);
      const ky10 = canonicalRepoLockKey(y10);
      const x10 = path.join(os.tmpdir(), `loom-mqup-h10-x-${tag}-never-exists-${freshSfx()}`);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky10)}.json`), JSON.stringify({
        repoPath: x10, branch: "x-branch", reason: `X's manufactured collision with Y, CURRENT format (h10-${tag})`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token-h10-1", "x-token-h10-2"], resolvedKey: ky10, provenanceTracked: true,
      }, null, 2) + "\n");
      return { x10, y10 };
    };
    const runProtectTrackedAndReadCopy = async (m, x10, y10) => {
      m.reenterMergeQuarantinesAtBoot([x10]);
      m.enterMergeQuarantine(y10, "y-branch", "y's own genuine unconfirmed-kill reason");
      m.clearMergeQuarantine(y10); // triggers protectDegradedOccupantBeforeDelete for X's own content
      const protectiveFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      const matches = protectiveFiles
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })
        .filter((parsed) => parsed?.repoPath === x10);
      check("(precondition) exactly one protective copy was found for X10's own identity — not zero, not more than one", matches.length === 1);
      return matches[0];
    };
    {
      const { x10, y10 } = buildProtectTrackedFixture("baseline");
      const protective = await runProtectTrackedAndReadCopy(await rebootSim(), x10, y10);
      check("(10a baseline, unmutated) the protective copy carries provenanceTracked forward", protective?.provenanceTracked === true);
    }
    const PROTECT_WHITELIST_TRACKED_LINE = "// @decision db0a9db0 — same carry-forward, same reason, for this explicit field whitelist.\n        provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,\n        // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.\n        provenanceTracked: parsed.provenanceTracked === true ? true : undefined,";
    await withDistMutation(PROTECT_WHITELIST_TRACKED_LINE,
      PROTECT_WHITELIST_TRACKED_LINE.replace("provenanceTracked: parsed.provenanceTracked === true ? true : undefined,", "provenanceTracked: undefined,"), async (m) => {
        const { x10, y10 } = buildProtectTrackedFixture("mutated");
        const protective = await runProtectTrackedAndReadCopy(m, x10, y10);
        check("*** PINNED (10) *** dropping ONLY the whitelist's own provenanceTracked carry loses it in the protective copy — caught", protective?.provenanceTracked !== true);
      });

    // --- (11) mergeTokenIntoPendingEntries' own cross-matched OR — the precision-guard field -----------
    const buildMergePendingTrackedFixture = (tag) => {
      const x11 = path.join(os.tmpdir(), `loom-mqup-h11-x-${tag}-never-exists-${freshSfx()}`);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `h11-${tag}-a-${freshSfx()}.json`), JSON.stringify({
        repoPath: x11, branch: "x-branch-a", reason: `h11-${tag}-source-a (base, older, no marker)`,
        enteredAt: Date.now() - 120_000, tokens: ["x-token-h11-a"],
      }, null, 2) + "\n");
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `h11-${tag}-b-${freshSfx()}.json`), JSON.stringify({
        repoPath: x11, branch: "x-branch-b", reason: `h11-${tag}-source-b (non-base, newer, CARRIES the marker)`,
        enteredAt: Date.now() - 60_000, tokens: ["x-token-h11-b"], provenanceTracked: true,
      }, null, 2) + "\n");
      return x11;
    };
    {
      const x11 = buildMergePendingTrackedFixture("baseline");
      reenterMergeQuarantinesAtBoot([x11]);
      enterMergeQuarantine(x11, "x-branch-fresh", "a fresh raise merging into both pending sources");
      check("(11a baseline, unmutated) the merged pending entry carries provenanceTracked from the non-base source", activeMergeQuarantineFor(x11)?.provenanceTracked === true);
    }
    const MERGE_PENDING_OR_LINE_TRACKED = "const provenanceTracked = matched.some((p) => p.entry.provenanceTracked) ? true : undefined;";
    await withDistMutation(MERGE_PENDING_OR_LINE_TRACKED, "const provenanceTracked = base.entry.provenanceTracked ? true : undefined;", async (m) => {
      const x11 = buildMergePendingTrackedFixture("mutated");
      m.reenterMergeQuarantinesAtBoot([x11]);
      m.enterMergeQuarantine(x11, "x-branch-fresh", "a fresh raise merging into both pending sources");
      check("*** PINNED (11) *** narrowing the provenanceTracked OR to `base` alone loses a non-base marker — caught", !m.activeMergeQuarantineFor(x11)?.provenanceTracked);
    });
  } else if (scenarioName === "pending-tier-refusal-drives-real-clear-by-path-route") {
    // The PENDING-tier branch of clearMergeQuarantineLatchFile (no ACTIVE match at all) — constructed
    // directly via the test-only injection seam, mirroring a protectDegradedOccupantBeforeDelete-style
    // protective copy (no resolvedKey, per that whitelist's own doc) under a `pending-<hex>.json`-shaped
    // sourceFile so its id can never collide with any active entry's own armedKeys-derived id.
    const x = path.join(os.tmpdir(), `loom-mqup-i-x-never-exists-${freshSfx()}`);
    const sourceFile = `pending-${createHash("sha256").update(`db0a9db0-pending-tier-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    const injected = {
      entry: {
        repoPath: x, branch: "x-branch", reason: "a protected, unresolvable occupant's own content",
        enteredAt: Date.now() - 60_000, tokens: ["x-token-i1", "x-token-i2"], provenanceUnknown: true,
      },
      sourceFile,
    };
    const id = createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);
    reenterMergeQuarantinesAtBootTestOnly([x], [injected]);

    check("(precondition) nothing is ACTIVE for X — this is a genuinely pending-only match", assertRepoNotQuarantined(x).ok === false);
    const clearResult = clearMergeQuarantineLatchFile(id);
    check("*** THE FIX *** the pending-tier refusal fires (no active match at all)", clearResult.ok === false);
    check("*** THE FIX *** the refusal text is grammatical (no broken noun-phrase splice)", clearResult.ok === false && !clearResult.reason.includes("token set carries this entry's own provenance"));
    check("*** THE FIX *** the refusal names the incomplete-provenance reason", clearResult.ok === false && clearResult.reason.includes("provenance is incomplete"));
    check("*** THE FIX *** the refusal names clear-by-path, never a bare clear shortcut", clearResult.ok === false && clearResult.reason.includes("clear-by-path"));

    // Drive the REAL function behind the route the refusal names (lesson 144).
    const pathClear = clearMergeQuarantineByRecordedPath(x);
    check("*** clear-by-path (the route the refusal names) actually lifts the pending entry ***", pathClear.wasQuarantined === true);
    check("*** after clear-by-path, X reads clear ***", assertRepoNotQuarantined(x).ok === true);
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? `\n✅ scenario ${scenarioName}: all checks passed` : `\n❌ scenario ${scenarioName}: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
