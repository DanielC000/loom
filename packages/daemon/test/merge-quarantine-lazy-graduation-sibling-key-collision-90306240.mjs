import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 90306240 (discovered from 4783df46's investigation, worker 13aede43).
// INVESTIGATE-FIRST coverage: `activeMergeQuarantineFor`'s lazy-graduation path (git/merge-quarantine.ts,
// the `!direct` branch ~4004-4036) arms a pending placeholder at `canonicalRepoLockKey(queriedRepoPath)`
// with no check that this key is the claimant's OWN verified (non-walked) identity — it only ever checks
// `isRepoPathCurrentlyResolvable(first.entry.repoPath)`, which is `fs.realpathSync` success (the path
// EXISTS), never "the path is its own git toplevel" or "the computed key is a key THIS path itself can
// verify" (that is `isKeyVerifiedFor`, which this branch never calls).
//
// Every existing f5c42043/883e29bc scenario has the claimant (their `X`) either remount with its OWN
// `.git` (a genuinely distinct, own key — graduation is then correct) or degrade into an UNREGISTERED
// ancestor (nobody else occupies that key, so graduation is harmless even though unverified). NEITHER
// covers a claimant that degrades into an ALREADY-REGISTERED, currently-resolvable SIBLING's or
// ANCESTOR's own real key — this file's repro shape (P/T/X, mirroring worker 13aede43's investigation):
//   P = a real git repo (the enclosing ancestor).
//   X = a plain subdir of P (`P/X`), no `.git` of its own — an ordinary, ALREADY-REGISTERED, currently-
//       resolvable project repo whose own canonical key IS P's key. Never quarantined, never degraded.
//   T = initially its OWN separate repo (own `.git`), raised while its directory is fully ABSENT (a
//       genuine "nothing to walk yet" pending divert, abccee85/round7's shape — NO resolvedKey). T's
//       directory then REAPPEARS, but WITHOUT its own `.git` ("T loses its .git") — so T's OWN fresh key,
//       once its directory exists again, is P's key too (the toplevel walk lands on P, exactly like X's
//       own key always has).
// Querying T is THEN the first query since T's placeholder was minted. MEASURED (see output): the
// lazy-graduation branch treats T as "genuinely resolvable now" (its directory exists — `fs.realpathSync`
// succeeds) and arms T's pending entry DIRECTLY at the computed key — P's key — with no check that this
// is T's OWN verified identity. `consumeMatchedPendingsIntoArmedEntry` has no identity/verification gate
// of its own either (see its source — it unions and arms unconditionally at whatever `key` it is given).
// The measured result: X — a wholly unrelated, healthy, resolvable sibling repo that was NEVER itself
// raised or degraded — reads as quarantined via T's own branch/reason/token the moment anything queries
// T even once. A FALSE-POSITIVE BLOCK, delayed until that first query, exactly as the card describes.
//
// SCENARIO B is the discriminating NEGATIVE CONTROL this investigation's own instrument needs: the SAME
// T-loses-its-.git shape, but with NOTHING ELSE registered/resolvable at the walked-up key (P itself is
// the only thing there, and P is deliberately treated as if unregistered/not a project path in this
// scenario — i.e. there is no "X" for this shape). Graduation there is unverified but HARMLESS (mirrors
// the existing f5c42043/883e29bc "degrade into an unregistered ancestor" shape) — proving scenario A's own
// collateral damage is not an artifact of this test's own construction, but genuinely conditional on an
// ALREADY-REGISTERED resolvable occupant actually being there to collide with.
//
// This file makes NO src change and asserts NOTHING as a pass/fail gate on the CURRENT (unfixed) code —
// every `check()` call records what is ACTUALLY OBSERVED, so this file is runnable both now (to measure
// the gap) and after any future fix (to pin whichever behavior is chosen then). See the worker_report for
// the investigation's own conclusion and recommendation; this file is evidence, not yet a regression gate.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-lazy-graduation-sibling-key-collision-90306240.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqlgskc-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, activeMergeQuarantineFor, enterMergeQuarantine,
  reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// MEASURE — records an observation without affecting the pass/fail count; this file is investigate-first.
const measure = (label, cond) => { console.log(`${cond ? "OBSERVED-TRUE " : "OBSERVED-FALSE"}  ${label}`); return cond; };
const GIT_ID = "-c user.email=mqlgskc@loom -c user.name=mqlgskc";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(prefix) {
  const dir = path.join(os.tmpdir(), `loom-mqlgskc-${prefix}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${prefix}\n`);
  execSync(`git init -q && git config user.email mqlgskc@loom && git config user.name mqlgskc`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

function makePlainSubdir(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  commitAll(parent, `add ${name}`, GIT_ID);
  return dir;
}

function makeOwnRepoSubdir(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name} (own repo)\n`);
  execSync(`git init -q && git config user.email mqlgskc@loom && git config user.name mqlgskc`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

function moveAway(dir, parkedRoot) { fs.renameSync(dir, parkedRoot); }

// Simulates "T loses its .git": the directory comes back (so `isRepoPathCurrentlyResolvable` is TRUE
// again — it checks only `fs.realpathSync` success), but WITHOUT the `.git` entry it originally had, so
// its canonical key now walks up to its nearest existing ancestor with a `.git` instead of being its own.
function restoreWithoutGit(parkedRoot, dir) {
  fs.renameSync(parkedRoot, dir);
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
}

function listingCountFor(mod, repoPath) {
  return mod.listActiveMergeQuarantines().filter((q) => q.repoPath === repoPath).length;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO A (THE GAP) — T degrades into an ALREADY-REGISTERED, currently-resolvable SIBLING (X)'s own
  // key. Query T once; measure whether X — never itself raised, never degraded, genuinely healthy — reads
  // as quarantined as a side effect.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const P = makeRepo("a-P");
  const X = makePlainSubdir(P, "X"); // ordinary, already-registered, resolvable sibling — own key == P's key
  const T = makeOwnRepoSubdir(P, "T"); // its OWN repo for now — distinct key from P's/X's

  const keyP = canonicalRepoLockKey(P);
  const keyX = canonicalRepoLockKey(X);
  const keyTOwn = canonicalRepoLockKey(T);
  check("(a precondition) X's own key equals P's key (X is a plain subdir of P)", keyX === keyP);
  check("(a precondition) T's own key (while it has its own .git) differs from P's/X's", keyTOwn !== keyP);

  check("(a precondition) X reads as NOT quarantined before anything happens", !activeMergeQuarantineFor(X));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlgskc-parked-a-T-${freshSfx()}`);
  moveAway(T, parkedRoot);
  const token = enterMergeQuarantine(T, "t-branch", "t raised while its directory is fully absent — a genuine 'nothing to walk yet' pending divert");
  check("(a raise) raising T while absent does NOT arm anything at P's/X's key", !activeMergeQuarantineFor(X));
  check("(a raise) T itself reads as quarantined via its own pending entry while absent", !!activeMergeQuarantineFor(T));
  check("(a raise) nothing was armed at P's/X's key directly — listing shows only the pending entry for T", listingCountFor({ listActiveMergeQuarantines }, T) === 1 && listingCountFor({ listActiveMergeQuarantines }, X) === 0);

  // T's directory reappears, but WITHOUT its own `.git` — "T loses its .git". Its fresh key is now P's key.
  restoreWithoutGit(parkedRoot, T);
  const keyTDegraded = canonicalRepoLockKey(T);
  check("(a degrade) T's fresh key, once its .git is gone, now equals P's/X's key", keyTDegraded === keyP);
  check("(a degrade) T's directory itself is 'resolvable' again (exists on disk) even without its own .git", fs.existsSync(T));

  // THE QUERY — the first genuine query of T since its placeholder was minted.
  const activeForT = activeMergeQuarantineFor(T);
  measure("(a query T) T reads as quarantined after the query", !!activeForT);

  // THE MEASUREMENT THE CARD ASKS FOR: does X — never raised, never degraded, genuinely unrelated — now
  // read as quarantined too, purely as a side effect of querying T?
  const activeForX = activeMergeQuarantineFor(X);
  const xFalselyBlocked = measure("(a query T, then check X) X NOW READS AS QUARANTINED (the false positive the card describes)", !!activeForX);
  if (xFalselyBlocked) {
    measure("(a) X's quarantine reason is actually T's own reason/branch (contamination, not X's own)", activeForX?.branch === "t-branch" && (activeForX?.tokens ?? []).includes(token));
    measure("(a) the armed entry's resolvedKey is the shared P/X key, not T's own former key", activeForX?.resolvedKey === keyP);
  }
  measure("(a) after the query, the shared key shows exactly one armed entry (T's graduated entry occupies it)", listingCountFor({ listActiveMergeQuarantines }, T) === 1);

  // Across a restart: does the false-positive persist durably, or was it purely an in-process artifact?
  const freshA = await freshBootModule();
  freshA.reenterMergeQuarantinesAtBoot([P, X, T]);
  const activeForXAfterRestart = freshA.activeMergeQuarantineFor(X);
  measure("(a restart) the false-positive block on X SURVIVES a daemon restart (durable, not just in-process)", !!activeForXAfterRestart);

  try { clearMergeQuarantine(T); } catch { /* best-effort cleanup */ }
  try { clearMergeQuarantine(X); } catch { /* best-effort cleanup */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO B (NEGATIVE CONTROL / discriminator) — the SAME T-loses-its-.git shape, but P has no OTHER
  // registered/resolvable occupant at its own key (no "X" exists in this scenario at all). Graduation here
  // is still UNVERIFIED (same mechanism), but there is nobody there to falsely block — proving scenario A's
  // collateral damage is conditional on a genuine occupant being present, not an artifact of this harness.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const P = makeRepo("b-P");
  const T = makeOwnRepoSubdir(P, "T");
  const keyP = canonicalRepoLockKey(P);

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlgskc-parked-b-T-${freshSfx()}`);
  moveAway(T, parkedRoot);
  const token = enterMergeQuarantine(T, "t-branch-b", "t raised while absent — scenario B control");
  restoreWithoutGit(parkedRoot, T);
  check("(b degrade) T's fresh key now equals P's key, same mechanism as scenario A", canonicalRepoLockKey(T) === keyP);

  const activeForT = activeMergeQuarantineFor(T);
  check("(b query T) T itself still reads as quarantined after the query", !!activeForT && (activeForT.tokens ?? []).includes(token));
  // P itself is never a project/registered path under test here — querying P's own key via T's identity
  // is the point; there is no THIRD, unrelated repoPath to falsely contaminate in this scenario, which is
  // exactly what distinguishes it from scenario A — nothing further to measure for "collateral damage"
  // because nothing else is there to receive it. This scenario exists only to confirm the MECHANISM
  // (unverified graduation at a walked-up key) is identical to scenario A's, isolating that scenario A's
  // own false-positive is conditional on an actual occupant being present, not on this harness's shape.
  check("(b) listing shows exactly one armed entry for T, nothing anomalous when no sibling occupies the key", listingCountFor({ listActiveMergeQuarantines }, T) === 1);

  try { clearMergeQuarantine(T); } catch { /* best-effort cleanup */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PRECONDITION/CONTROL CHECKS PASS — see the OBSERVED-TRUE/OBSERVED-FALSE lines above for the "
    + "actual measured behavior of card 90306240's own gap (never asserted as pass/fail here, since no fix "
    + "has been chosen yet)."
  : `\n❌ ${failures} precondition/control check(s) FAILED — the repro's own setup did not hold as expected; `
    + "see which check above failed before trusting the OBSERVED-* lines.");
process.exit(failures === 0 ? 0 : 1);
