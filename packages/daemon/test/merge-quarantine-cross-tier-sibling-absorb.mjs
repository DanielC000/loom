import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 8a1bc2ef (from Code Reviewer 638ee0bc's review of 188b145f, item 1) — CROSS-TIER STRANDING.
//
// Two SEPARATE registered repo paths bound to ONE physical repo (card 7673d096 — e.g. a project at a
// repo's toplevel `R` and another at one of its subdirs `R/teamA`) collapse onto the SAME canonical key
// once both resolve, but each keeps its OWN `directPathIdentity`. `activeMergeQuarantineFor`'s three-tier
// match cascade (and `enterMergeQuarantine`'s own, narrower identity-only match) matches a pending entry
// by IDENTITY, never by key — so once ONE of the two siblings' own pending entry graduates/arms a key,
// nothing ever goes back and looks for the OTHER sibling's own still-pending entry sharing that exact
// key. This card closes that gap at all FOUR places an entry becomes armed/returned under a key:
//
//  SITE 1 — `activeMergeQuarantineFor`'s `direct` fast path (an already-armed entry; a query for the
//           other sibling used to return that `direct` object as-is, never re-checking pending at all).
//  SITE 2 — `activeMergeQuarantineFor`'s lazy-graduation tail (the ORIGINAL card 188b145f shape, now
//           generalized: the winning tier's own identity match graduates, but a sibling at a DIFFERENT
//           identity sharing the same key was left stuck in `pendingUnresolvedQuarantines` forever).
//  SITE 3 — `enterMergeQuarantine`'s `existing` branch (key already armed; a fresh raise merely appends a
//           token and never looks at `pendingUnresolvedQuarantines` either).
//  SITE 4 — `enterMergeQuarantine`'s pending-merge branch (and its "brand new entry" fallthrough): a raise
//           directly on a repo with NO pending entry of its OWN, while a sibling's own pending entry
//           shares the same key, used to strand that sibling exactly like the other three sites.
//
// All four route through the ONE shared `consumeMatchedPendingsIntoArmedEntry` helper — the new
// `collectCrossTierSiblingIndices` only SELECTS the extra indices (the same tier-3 predicate
// `activeMergeQuarantineFor`'s own cascade already trusted for graduation); there is no second
// splice/union copy anywhere. SCENARIO 5 is a cross-key negative control: two pending entries for
// genuinely UNRELATED repos (different canonical keys) must never be cross-absorbed into one.
//
// Every scenario ends with a fresh-module RESTART assertion, same technique as the sibling repro files.
//
// See docs/decisions/8a1bc2ef-cross-tier-sibling-pending-absorb.md, docs/decisions/188b145f-*.md, and
// docs/decisions/7673d096 (referenced from this module's own header doc) for the sibling-collapse shape.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-cross-tier-sibling-absorb.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqcts-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineByKey, activeMergeQuarantineFor, enterMergeQuarantine,
  reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqcts@loom -c user.name=mqcts";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the OLD (pre-7673d096) key algorithm by hand — same technique as the sibling repro files.
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// A repo with a subdir — two SEPARATE registered-repo paths (`repo`, `subdir`) that collapse onto ONE
// canonical key once both resolve (card 7673d096), same shape as the sibling repro files.
function makeRepoWithSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqcts-repo-${tag}-${freshSfx()}`);
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-cross-tier-sibling-absorb (${tag})\n`);
  execSync(`git init -q && git config user.email mqcts@loom && git config user.name mqcts`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, subdir };
}

// R (a repo) with X = R/nested (its OWN SEPARATE repo, its own `.git`) and T = R/teamA (a plain subdir,
// no `.git` of its own — collapses onto R's key like `makeRepoWithSubdir`'s subdir). X is genuinely a
// DIFFERENT physical repo from R — it has its own real canonical key while resolvable — but once X itself
// becomes UNRESOLVABLE, `canonicalRepoLockKey(X)` degrades by walking up to the nearest EXISTING ancestor
// with a `.git`, landing on R's own (card 8a1bc2ef, round 2 — the Code Review repro).
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqcts-nested-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "nested");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-cross-tier-sibling-absorb nested (${tag})\n`);
  execSync(`git init -q && git config user.email mqcts@loom && git config user.name mqcts`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqcts@loom && git config user.name mqcts`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested own repo (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

// `mod` is either the top-level import (same module instance) or a `freshBootModule()` reimport — either
// way, `listActiveMergeQuarantines` is the SAME shape; `canonicalRepoLockKey` (resolving IDENTITY, not
// module instance) is intentionally the top-level one in every case, since a key is a pure function of
// the repoPath string, not of which module instance computed it.
function listingCountForKey(mod, expectedKey) {
  return mod.listActiveMergeQuarantines().filter((q) => {
    try { return canonicalRepoLockKey(q.repoPath) === expectedKey; } catch { return false; }
  }).length;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 (SITE 2 — lazy-graduation tail) — both R (toplevel) and R/teamA (subdir) have their OWN
  // pending entry from an earlier boot (neither armed yet). Querying via the SUBDIR graduates it at tier
  // 1 (its own identity) — THE FIX: R's own sibling pending entry, a DIFFERENT identity sharing the same
  // key, must be absorbed in the SAME step, not left stranded behind the now-armed key.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo, subdir } = makeRepoWithSubdir("s1");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(repo)}.json`), JSON.stringify({
    repoPath: repo, branch: "s1-r-branch", reason: "s1 R's own pending raise", enteredAt: Date.now() - 60_000, tokens: ["s1-r-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
    repoPath: subdir, branch: "s1-sub-branch", reason: "s1 subdir's own pending raise", enteredAt: Date.now(), tokens: ["s1-sub-token"],
  }, null, 2) + "\n");

  const parkedRepo = path.join(os.tmpdir(), `loom-mqcts-parked-s1-${freshSfx()}`);
  fs.renameSync(repo, parkedRepo);
  const found = reenterMergeQuarantinesAtBoot([repo, subdir]);
  check("(s1 precondition) boot sees both as pending", found.length === 2);
  fs.renameSync(parkedRepo, repo);

  const key = canonicalRepoLockKey(subdir);
  check("(s1 precondition) repo and subdir share one canonical key", canonicalRepoLockKey(repo) === key);
  check("(s1 precondition) both pending entries listed, by key", listingCountForKey({ listActiveMergeQuarantines }, key) === 2);

  const activeSub = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY, via the subdir's own identity
  check("(s1 graduation) subdir reads as quarantined", !!activeSub);
  check("(s1 graduation) subdir's own token present", (activeSub?.tokens ?? []).includes("s1-sub-token"));
  check("(s1 graduation) THE FIX: R's own SIBLING token is absorbed in the SAME step", (activeSub?.tokens ?? []).includes("s1-r-token"));
  check("(s1 graduation) exactly ONE listing after absorption, nothing left dangling", listingCountForKey({ listActiveMergeQuarantines }, key) === 1);

  const activeR = activeMergeQuarantineFor(repo); // a later query via R's OWN identity — same armed object
  check("(s1 second query) querying via R now also sees both tokens (same armed entry)", (activeR?.tokens ?? []).includes("s1-r-token") && (activeR?.tokens ?? []).includes("s1-sub-token"));

  const fresh1 = await freshBootModule();
  fresh1.reenterMergeQuarantinesAtBoot([repo, subdir]);
  const activeAfterRestart = fresh1.activeMergeQuarantineFor(subdir);
  check("(s1 restart) NO LOSS: both tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes("s1-r-token") && (activeAfterRestart?.tokens ?? []).includes("s1-sub-token"));
  check("(s1 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountForKey(fresh1, key) === 1);

  try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 (SITE 1 — `direct` fast path) — R has NO pending entry of its own; a fresh, ordinary raise
  // arms R directly (no pending involved at all). THE SUBDIR separately carries its OWN pending entry
  // from an earlier boot. Querying the subdir hits `activeQuarantines.get(key)` (R's armed entry) BEFORE
  // ever reaching the pending cascade — THE FIX: absorb the subdir's own sibling pending entry into the
  // already-armed entry right there, at the fast path, rather than returning it as-is forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo, subdir } = makeRepoWithSubdir("s2");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const key = canonicalRepoLockKey(repo);
  check("(s2 precondition) repo and subdir share one canonical key", canonicalRepoLockKey(subdir) === key);

  // R is raised FIRST, BEFORE the subdir's own pending entry exists — isolates this scenario to the
  // `direct` fast path alone: this raise hits the genuine "brand new entry" branch (site 4 never sees a
  // sibling here, since none exists yet), so ONLY site 1's own absorb (tested below) can be responsible
  // for whatever this scenario's own assertions find.
  const freshToken = enterMergeQuarantine(repo, "s2-r-branch", "s2 R's own brand-new raise — no pending involved");
  check("(s2 precondition) R is now armed directly (no pending touched)", !!activeMergeQuarantineFor(repo));

  // NOW the subdir's own pending entry appears — as if a separate, later boot-time scan discovered a
  // leftover latch file for it (independent of R's already-armed, in-process state above).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
    repoPath: subdir, branch: "s2-sub-branch", reason: "s2 subdir's own pending raise", enteredAt: Date.now(), tokens: ["s2-sub-token"],
  }, null, 2) + "\n");
  const parkedSub = path.join(os.tmpdir(), `loom-mqcts-parked-s2-${freshSfx()}`);
  fs.renameSync(subdir, parkedSub);
  reenterMergeQuarantinesAtBoot([subdir]);
  fs.renameSync(parkedSub, subdir);
  check("(s2 precondition) subdir's own pending entry is UNTOUCHED so far", listingCountForKey({ listActiveMergeQuarantines }, key) === 2);

  const activeSub = activeMergeQuarantineFor(subdir); // THE `direct` FAST PATH QUERY
  check("(s2 direct-path query) subdir reads as quarantined via R's armed entry", !!activeSub);
  check("(s2 direct-path query) R's own fresh token is present", (activeSub?.tokens ?? []).includes(freshToken));
  check("(s2 direct-path query) THE FIX: subdir's own SIBLING token is absorbed", (activeSub?.tokens ?? []).includes("s2-sub-token"));
  check("(s2 direct-path query) exactly ONE listing after absorption", listingCountForKey({ listActiveMergeQuarantines }, key) === 1);

  const fresh2 = await freshBootModule();
  fresh2.reenterMergeQuarantinesAtBoot([repo, subdir]);
  const activeAfterRestart = fresh2.activeMergeQuarantineFor(repo);
  check("(s2 restart) NO LOSS: both tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes(freshToken) && (activeAfterRestart?.tokens ?? []).includes("s2-sub-token"));
  check("(s2 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountForKey(fresh2, key) === 1);

  try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 (SITE 4 — `enterMergeQuarantine`'s pending-merge branch / "brand new entry" fallthrough) —
  // R has NO pending entry of its own (and nothing armed yet); the SUBDIR carries its OWN pending entry.
  // A RAISE directly on R (never a query) used to fall straight to the "brand new entry" branch, which
  // never looked at `pendingUnresolvedQuarantines` at all — THE FIX: absorb the subdir's own sibling
  // pending entry into this fresh raise too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo, subdir } = makeRepoWithSubdir("s3");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
    repoPath: subdir, branch: "s3-sub-branch", reason: "s3 subdir's own pending raise", enteredAt: Date.now(), tokens: ["s3-sub-token"],
  }, null, 2) + "\n");
  const parkedSub = path.join(os.tmpdir(), `loom-mqcts-parked-s3-${freshSfx()}`);
  fs.renameSync(subdir, parkedSub);
  reenterMergeQuarantinesAtBoot([subdir]);
  fs.renameSync(parkedSub, subdir);

  const key = canonicalRepoLockKey(repo);
  const freshToken = enterMergeQuarantine(repo, "s3-r-branch", "s3 R's raise — R has no pending of its own, only its sibling does"); // THE RAISE
  const activeR = activeMergeQuarantineFor(repo);
  check("(s3 raise) R reads as quarantined with its own fresh token", !!activeR && (activeR.tokens ?? []).includes(freshToken));
  check("(s3 raise) THE FIX: subdir's own SIBLING token is absorbed into this fresh raise", (activeR?.tokens ?? []).includes("s3-sub-token"));
  check("(s3 raise) exactly ONE listing after absorption", listingCountForKey({ listActiveMergeQuarantines }, key) === 1);

  const fresh3 = await freshBootModule();
  fresh3.reenterMergeQuarantinesAtBoot([repo, subdir]);
  const activeAfterRestart = fresh3.activeMergeQuarantineFor(repo);
  check("(s3 restart) NO LOSS: both tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes(freshToken) && (activeAfterRestart?.tokens ?? []).includes("s3-sub-token"));
  check("(s3 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountForKey(fresh3, key) === 1);

  try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 (SITE 3 — `enterMergeQuarantine`'s `existing` branch) — the SUBDIR carries its OWN pending
  // entry; R is raised TWICE — the FIRST raise arms R directly (brand new entry, no pending involved);
  // the SECOND raise hits the `existing` branch (key already armed), which pre-fix only appended a token
  // and never looked at `pendingUnresolvedQuarantines` at all. THE FIX: absorb the subdir's own sibling
  // pending entry into that SECOND raise too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo, subdir } = makeRepoWithSubdir("s4");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const key = canonicalRepoLockKey(repo);
  // R's FIRST raise, BEFORE the subdir's own pending entry exists — isolates this scenario to the
  // `existing` branch alone: site 4 never sees a sibling on this first raise (none exists yet).
  const token1 = enterMergeQuarantine(repo, "s4-r-branch-1", "s4 R's FIRST raise — brand new entry, no pending touched");
  check("(s4 precondition) R is armed after the first raise", !!activeMergeQuarantineFor(repo));

  // NOW the subdir's own pending entry appears, independent of R's already-armed in-process state.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
    repoPath: subdir, branch: "s4-sub-branch", reason: "s4 subdir's own pending raise", enteredAt: Date.now(), tokens: ["s4-sub-token"],
  }, null, 2) + "\n");
  const parkedSub = path.join(os.tmpdir(), `loom-mqcts-parked-s4-${freshSfx()}`);
  fs.renameSync(subdir, parkedSub);
  reenterMergeQuarantinesAtBoot([subdir]);
  fs.renameSync(parkedSub, subdir);
  check("(s4 precondition) subdir's own pending entry is UNTOUCHED so far", listingCountForKey({ listActiveMergeQuarantines }, key) === 2);

  const token2 = enterMergeQuarantine(repo, "s4-r-branch-2 (ignored — existing wins)", "s4 R's SECOND raise — hits the EXISTING branch"); // THE EXISTING-BRANCH RAISE
  const activeR = activeMergeQuarantineFor(repo);
  check("(s4 existing-branch raise) both of R's own tokens are present", (activeR?.tokens ?? []).includes(token1) && (activeR?.tokens ?? []).includes(token2));
  check("(s4 existing-branch raise) THE FIX: subdir's own SIBLING token is absorbed", (activeR?.tokens ?? []).includes("s4-sub-token"));
  check("(s4 existing-branch raise) exactly ONE listing after absorption", listingCountForKey({ listActiveMergeQuarantines }, key) === 1);

  const fresh4 = await freshBootModule();
  fresh4.reenterMergeQuarantinesAtBoot([repo, subdir]);
  const activeAfterRestart = fresh4.activeMergeQuarantineFor(repo);
  check("(s4 restart) NO LOSS: all three tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes(token1) && (activeAfterRestart?.tokens ?? []).includes(token2) && (activeAfterRestart?.tokens ?? []).includes("s4-sub-token"));
  check("(s4 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountForKey(fresh4, key) === 1);

  try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 5 — CROSS-KEY NEGATIVE CONTROL: two pending entries for genuinely UNRELATED repos (different
  // canonical keys, by construction — two separate physical git repos) must NEVER be cross-absorbed, no
  // matter which of the four sites is exercised. Proves the fix matches by KEY equality, never casts a
  // wider net (e.g. "any pending entry at all").
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo: repoA, subdir: subdirA } = makeRepoWithSubdir("s5a");
  const { repo: repoB } = makeRepoWithSubdir("s5b"); // a WHOLLY unrelated repo — different canonical key
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdirA)}.json`), JSON.stringify({
    repoPath: subdirA, branch: "s5-suba-branch", reason: "s5 repoA's own subdir pending raise", enteredAt: Date.now(), tokens: ["s5-suba-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(repoB)}.json`), JSON.stringify({
    repoPath: repoB, branch: "s5-b-branch", reason: "s5 repoB's own pending raise — WHOLLY unrelated to repoA", enteredAt: Date.now(), tokens: ["s5-b-token"],
  }, null, 2) + "\n");

  const parkedSubA = path.join(os.tmpdir(), `loom-mqcts-parked-s5a-${freshSfx()}`);
  const parkedB = path.join(os.tmpdir(), `loom-mqcts-parked-s5b-${freshSfx()}`);
  fs.renameSync(subdirA, parkedSubA);
  fs.renameSync(repoB, parkedB);
  reenterMergeQuarantinesAtBoot([subdirA, repoB]);
  fs.renameSync(parkedSubA, subdirA);
  fs.renameSync(parkedB, repoB);

  const keyA = canonicalRepoLockKey(repoA);
  const keyB = canonicalRepoLockKey(repoB);
  check("(s5 precondition) repoA and repoB have genuinely DIFFERENT canonical keys", keyA !== keyB);

  const freshTokenA = enterMergeQuarantine(repoA, "s5-a-branch", "s5 repoA's own brand-new raise");
  const activeA = activeMergeQuarantineFor(repoA);
  check("(s5 repoA raise) repoA reads as quarantined with its own fresh token", !!activeA && (activeA.tokens ?? []).includes(freshTokenA));
  check("(s5 repoA raise) THE FIX still absorbs its OWN sibling (subdirA, same key)", (activeA?.tokens ?? []).includes("s5-suba-token"));
  check("(s5 NEGATIVE CONTROL) repoB's token was NEVER pulled in — different key, never cross-absorbed", !(activeA?.tokens ?? []).includes("s5-b-token"));

  const activeB = activeMergeQuarantineFor(repoB); // repoB must still graduate correctly, on its own, untouched
  check("(s5 repoB graduation) repoB reads as quarantined with ONLY its own token", !!activeB && (activeB.tokens ?? []).length === 1 && activeB.tokens.includes("s5-b-token"));

  const fresh5 = await freshBootModule();
  fresh5.reenterMergeQuarantinesAtBoot([repoA, subdirA, repoB]);
  const freshActiveA = fresh5.activeMergeQuarantineFor(repoA);
  const freshActiveB = fresh5.activeMergeQuarantineFor(repoB);
  check("(s5 restart) repoA's tokens survive, still isolated from repoB's", (freshActiveA?.tokens ?? []).includes(freshTokenA) && (freshActiveA?.tokens ?? []).includes("s5-suba-token") && !(freshActiveA?.tokens ?? []).includes("s5-b-token"));
  check("(s5 restart) repoB's own token survives, still isolated", (freshActiveB?.tokens ?? []).length === 1 && freshActiveB.tokens.includes("s5-b-token"));

  try { clearMergeQuarantine(repoA); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdirA); } catch { /* best-effort */ }
  try { clearMergeQuarantine(repoB); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 6 (round 2, Code Review) — NESTED-REPO DEGRADED-KEY NEGATIVE CONTROL. R is a repo; X = R/nested
  // is its OWN SEPARATE repo (own `.git`, own real key Kx); T = R/teamA is a plain subdir of R (collapses
  // onto R's own key, like every other sibling in this file). At boot, BOTH X and T are unresolvable: X
  // has a recorded `resolvedKey` (Kx), so PASS 1 dual-arms it under BOTH its degraded, walked-up key
  // (which lands on R's OWN real key, since X's nearest existing ancestor once X itself vanishes is R) AND
  // Kx. T, a pre-upgrade latch with no `resolvedKey`, goes genuinely pending.
  //
  // T then becomes resolvable again WHILE X IS STILL UNMOUNTED. A query for R hits `activeQuarantines.get(
  // Rkey)` — X's dual-armed entry — truthy. THE BUG (round 1): nothing checked whether X itself was ever
  // VERIFIED to be at that key; `collectCrossTierSiblingIndices` only checks the SIBLING (T) resolves
  // there, so T's genuinely separate, still-pending quarantine was silently merged into X's entry (an
  // entry that is NOT verified to be R, or anything, right now) and its own pending record destroyed. A
  // human then clearing X (by its own recorded Kx) would silently lift T's genuine quarantine too — and it
  // would STAY lifted after a restart, since T's own durable record was already gone.
  //
  // THE FIX: absorption into an already-armed receiver (`direct` at site 1, `existing`+token at site 3)
  // now requires the receiver itself to be `isKeyVerifiedFor` — currently resolvable AND its own fresh
  // `canonicalRepoLockKey` recompute equals the key in question. X fails that check (still unresolvable),
  // so T is left untouched, genuinely independent, and survives X's own later clear intact.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("s6");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const Kx = canonicalRepoLockKey(nested); // X's own TRUE key, captured while X still resolves
  const Kr = canonicalRepoLockKey(repo); // R's own real key — what X's degraded walk-up will land on

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
    repoPath: nested, branch: "s6-x-branch", reason: "s6 X's own prior raise, recorded under its TRUE key",
    enteredAt: Date.now() - 60_000, tokens: ["s6-x-token"], resolvedKey: Kx,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
    repoPath: subdir, branch: "s6-t-branch", reason: "s6 T's own pending raise — a pre-upgrade latch, no resolvedKey",
    enteredAt: Date.now(), tokens: ["s6-t-token"],
  }, null, 2) + "\n");

  const parkedX = path.join(os.tmpdir(), `loom-mqcts-parked-s6x-${freshSfx()}`);
  const parkedT = path.join(os.tmpdir(), `loom-mqcts-parked-s6t-${freshSfx()}`);
  fs.renameSync(nested, parkedX);
  fs.renameSync(subdir, parkedT);
  reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // BOTH X and T are missing at this boot
  check("(s6 precondition) both X (dual-armed) and T (pending) are represented under R's own key", listingCountForKey({ listActiveMergeQuarantines }, Kr) === 2);

  // T returns; X stays UNMOUNTED — the exact ordering the repro needs.
  fs.renameSync(parkedT, subdir);
  check("(s6 precondition) X is still genuinely unresolvable", !fs.existsSync(nested));

  const activeR = activeMergeQuarantineFor(repo); // THE QUERY THAT USED TO TRIGGER THE BUG
  check("(s6 R query) R reads as quarantined via X's dual-armed entry", !!activeR && (activeR.tokens ?? []).includes("s6-x-token"));
  check("(s6 R query) THE FIX: T's own token is NEVER absorbed into X's unverified entry", !(activeR?.tokens ?? []).includes("s6-t-token"));
  check("(s6 R query) THE FIX: T's own pending record SURVIVES, independent of X's entry", listingCountForKey({ listActiveMergeQuarantines }, Kr) === 2);
  const tEntryAfterRQuery = listActiveMergeQuarantines().find((q) => q.repoPath === subdir);
  check("(s6 R query) T's own entry still carries EXACTLY its own token, unmerged", !!tEntryAfterRQuery && (tEntryAfterRQuery.tokens ?? []).length === 1 && tEntryAfterRQuery.tokens.includes("s6-t-token"));

  // A human now clears X specifically, by its OWN recorded key Kx (lifts every key X is armed under).
  clearMergeQuarantineByKey(Kx, nested);
  check("(s6 clear X by Kx) THE REGRESSION THIS PREVENTS: T's quarantine SURVIVES clearing X", listingCountForKey({ listActiveMergeQuarantines }, Kr) === 1);
  const activeTAfterXCleared = activeMergeQuarantineFor(subdir); // T now resolves on its own, X's shadow is gone
  check("(s6 clear X by Kx) T now genuinely graduates on its own, with ONLY its own token", !!activeTAfterXCleared && (activeTAfterXCleared.tokens ?? []).length === 1 && activeTAfterXCleared.tokens.includes("s6-t-token"));

  // RESTART ASSERTION — X must stay cleared (genuinely lifted); T must survive the restart, untouched.
  fs.renameSync(parkedX, nested); // restore X to disk so cleanup/teardown doesn't leak a parked dir
  const fresh6 = await freshBootModule();
  fresh6.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
  check("(s6 restart) X stays cleared — genuinely lifted, never resurrected", !fresh6.activeMergeQuarantineFor(nested) || (fresh6.activeMergeQuarantineFor(nested)?.tokens ?? []).every((t) => t !== "s6-x-token"));
  const activeTAfterRestart = fresh6.activeMergeQuarantineFor(subdir);
  check("(s6 restart) T's quarantine SURVIVES the restart with only its own token", !!activeTAfterRestart && (activeTAfterRestart.tokens ?? []).length === 1 && activeTAfterRestart.tokens.includes("s6-t-token"));

  try { clearMergeQuarantine(nested); } catch { /* best-effort */ }
  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — all four sites that can arm/return an entry under a canonical key (the `direct` fast "
    + "path, the lazy-graduation tail, enterMergeQuarantine's `existing` branch, and its pending-merge "
    + "branch) now absorb a SIBLING pending entry sharing that exact key (card 7673d096's toplevel/subdir "
    + "collapse), routed through the ONE shared consumeMatchedPendingsIntoArmedEntry helper — matching "
    + "stays by KEY equality, never a wider net, every effect survives a fresh-module restart."
  : `\n❌ ${failures} FAILURE(S) — reproduces board card 8a1bc2ef, item 1.`);
process.exit(failures === 0 ? 0 : 1);
