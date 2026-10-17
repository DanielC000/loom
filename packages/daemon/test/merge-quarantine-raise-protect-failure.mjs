import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 8db913e2 — a RAISE (enterMergeQuarantine) could overwrite a kept occupant's physical file
// at its own key, in three shapes, all because the raise's own write sites skip the degraded-occupant
// guard (e1cb7d33: a raise must persist) with no FALLBACK protection of their own:
//
//   (1) `protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete`'s own `false`
//       return (a confirmed foreign occupant whose protective copy failed, or a non-ENOENT read failure
//       with nothing to copy aside from) was IGNORED — the guard-skipped write then overwrote the kept
//       occupant's file outright.
//   (2) Even a `true` ("none") return can be STALE: `final`'s basename can be marked
//       `keptUnreadableLatchFiles` from an EARLIER read failure (one that evicted the in-memory record
//       without creating a pending one), and a later raise of the SAME identity's own fresh, successful
//       read proves only that THIS read worked — not that nothing was lost from memory in between.
//   (3) A same-identity re-raise's rename SUCCEEDS but overwrites `final` without UNIONING whatever
//       token(s) were already outstanding there.
//
// THE FIX (`resolveRaiseOverwrite` / `divertRaiseEntry` in merge-quarantine.ts): every raise-side write
// call site now threads its own protect call's return (plus a re-check against
// `keptUnreadableLatchFiles`) into a divert-or-carry-forward decision — never a refusal (e1cb7d33 still
// holds: the raise always persists), but never a blind overwrite either. See
// docs/decisions/8db913e2-*.md.
//
// Shape (3)'s own dedicated fixture (a same-identity re-raise after a transient read failure, then a
// PARTIAL clear, then a reboot) lives in `round5-rename-unmarks` inside
// merge-quarantine-protect-read-failure.mjs (fixed by this same card) — not duplicated here.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-raise-protect-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqrpf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineReporting, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile, quarantineLatchFileIdsFor,
  clearMergeQuarantine, assertRepoNotQuarantined, ownedKeysIncluding,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

function contentIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqrpf@loom -c user.name=mqrpf";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqrpf-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-raise-protect-failure (${tag})\n`);
  execSync(`git init -q && git config user.email mqrpf@loom && git config user.name mqrpf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Fails EVERY read of `targetPath` (persistent — mirrors the card's own "left ON" wording for shape 1).
function injectPersistentReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let interceptCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      interceptCount++;
      throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => interceptCount };
}

// Fails ONLY the Nth read of `targetPath` — every other read (before and after) succeeds normally.
function injectReadFailureOnlyNth(targetPath, n, code = "EACCES") {
  const real = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (callCount === n) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

// Fails ONLY the read(s) of `targetPath` whose call-index is IN `indices` (1-based) — every other call
// (before, after, or not named) succeeds normally. Used for round 3's own k-th-read injection: a single
// `enterMergeQuarantine` call can read `final` more than once (its own protect call, its own
// `resolveRaiseOverwrite` re-check, its own fold-in) and this names exactly which of those fail.
function injectReadFailureAtCalls(targetPath, indices, code = "EACCES") {
  const real = fs.readFileSync;
  const idxSet = new Set(indices);
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (idxSet.has(callCount)) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

// Fails EVERY `fs.openSync` whose path starts with `prefix` (e.g. ENOSPC) — used for item dd34da46/3's
// own double-fault repro (the divert's own pending-divert write ALSO fails).
function injectOpenSyncFailureForPrefix(prefix, code = "ENOSPC") {
  const real = fs.openSync;
  let count = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(prefix)) {
      count++;
      throw Object.assign(new Error(`${code}: simulated disk-full`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.openSync = real; }, count: () => count };
}

// Fails EVERY `fs.unlinkSync` of exactly `targetPath` with `code` (e.g. EPERM/EBUSY) — used for the N4
// scenario (an unconfirmed unlink must leave the keep-mark, and so the tokens, untouched).
function injectUnlinkFailureForPath(targetPath, code = "EPERM") {
  const real = fs.unlinkSync;
  let count = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      count++;
      throw Object.assign(new Error(`${code}: simulated unlink failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; }, count: () => count };
}

// Mirrors merge-quarantine.ts's own `pendingDivertFilenameFor` (unexported) — a repoPath's deterministic
// pending-divert filename, hashed from its directPathIdentity (realpath, lowercased on win32).
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Mirrors merge-quarantine.ts's own `pendingDivertCollisionFilenameFor` (unexported) — same identity hash
// as pendingDivertFilenameForTest above, plus a `-collision-<8hex>` infix before `.json`.
function pendingDivertCollisionFilenameForTest(repoPath) {
  const base = pendingDivertFilenameForTest(repoPath).slice(0, -".json".length);
  return `${base}-collision-${randomUUID().replace(/-/g, "").slice(0, 8)}.json`;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SHAPE 1 ("fp:reraise") — a CONFIRMED foreign, unresolvable occupant (D) sits at R's own key, as a
  // PURE-PENDING (no `resolvedKey`) latch — so D is never armed directly into `activeQuarantines`, and
  // R's own raise reaches `enterMergeQuarantine`'s "no existing" region (the brand-new-entry write). The
  // read of D's own final is left persistently broken when R raises. Pre-fix: the guard-skipped primary
  // write renamed R's own content straight over D's, destroying D's token outright.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("s1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-s1"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(s1 precondition) D is a pure-pending occupant, NOT armed directly", (activeMergeQuarantineFor(d)?.armedKeys?.length ?? 0) === 0 && (activeMergeQuarantineFor(d)?.tokens ?? []).includes("d-token-s1"));
  check("(s1 precondition) R's own raise reaches the \"no existing\" region (nothing armed at R's own key yet)", activeMergeQuarantineFor(r) === undefined);

  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, D's final unreadable throughout");
  } finally {
    inject.restore();
  }
  check("(s1 positive control) the read was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (shape 1) *** D's own content is still physically present at `final`, byte-for-byte (never overwritten by R's guard-skipped write)", (contentIfExists(finalPath) ?? "").includes("d-token-s1"));
  check("*** THE FIX (shape 1) *** R's own raise still persists IN-PROCESS (diverted, not lost)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(rToken));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (shape 1, reboot) *** D's own token SURVIVES", freshTokens.has("d-token-s1"));
  check("*** THE FIX (shape 1, reboot) *** R's own token ALSO SURVIVES (the raise persisted, per e1cb7d33)", freshTokens.has(rToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SHAPE 1 (control) — identical fixture, NO injection: today's existing, already-established behavior
  // (D's content is durably protected and relocated, R's own write proceeds onto `final`) is unchanged.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("s1-ctrl-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-s1-ctrl"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, no injection");

  check("(s1 control) R's own write lands directly at `final` (today's existing, legitimate overwrite path)", (contentIfExists(finalPath) ?? "").includes(rToken));
  check("(s1 control) D's own token still survives (durably protected elsewhere before the overwrite)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-s1-ctrl"));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(s1 control, reboot) D's own token SURVIVES", freshTokens.has("d-token-s1-ctrl"));
  check("(s1 control, reboot) R's own token SURVIVES", freshTokens.has(rToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SHAPE 2 ("no-fault") — a transient (not persistent) read failure marks `final`'s basename kept and
  // evicts D's in-memory record (no pending record is ever created on an "unknown" read). D then becomes
  // resolvable and raises itself again — the SAME identity as the stale content physically at `final`,
  // so the re-check's own detector call reports "none" (nothing foreign). Pre-fix, that stale-but-true
  // "none" was trusted blindly and D's own ORIGINAL token (never reflected in memory) was lost the
  // instant the guard-skipped write succeeded. Measured directly against a reboot, immediately — no
  // intervening clear (the intervening-clear variant lives in round5-rename-unmarks).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("s2-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-s2"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject.restore();
  check("(s2 precondition) D's own file survives the marking clear", fs.existsSync(finalPath));

  fs.mkdirSync(d, { recursive: true });
  const t2 = enterMergeQuarantine(d, "d-branch-fresh", "D re-raises itself after the marking clear");
  check("*** THE FIX (shape 2) *** the re-raise carries the ORIGINAL token forward IN-PROCESS",
    new Set(activeMergeQuarantineFor(d)?.tokens ?? []).has("d-token-s2"));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (shape 2, reboot) *** D's own ORIGINAL token SURVIVES", freshTokens.has("d-token-s2"));
  check("*** THE FIX (shape 2, reboot) *** D's own FRESH token ALSO survives", freshTokens.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SHAPE 2 (control) — identical fixture, NO injection: D's own real token is protected via the
  // pre-existing, content-based pending mechanism (never via the keep-set), confirming the bug above is
  // specific to the read-failure path, not the scenario shape itself.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("s2-ctrl-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-s2-ctrl"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  clearMergeQuarantineReporting(r); // no injection — the read succeeds normally throughout

  fs.mkdirSync(d, { recursive: true });
  const t2 = enterMergeQuarantine(d, "d-branch-fresh", "D re-raises itself, no injection");

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(s2 control, reboot) D's own ORIGINAL token SURVIVES", freshTokens.has("d-token-s2-ctrl"));
  check("(s2 control, reboot) D's own FRESH token ALSO survives", freshTokens.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // EXISTING-BRANCH coverage — the SAME divert-or-carry-forward decision, wired at `enterMergeQuarantine`'s
  // OTHER raise-write site (the `existing`-truthy region, a SECOND raise absorbed into an already-armed
  // entry). D2 is armed directly at boot (its own `resolvedKey`), so R2's own raise over the SAME key
  // reaches `existing` truthy with `existing.repoPath !== repoPath` — exactly the shape
  // `protectUnincorporatedOccupantBeforeDelete`'s own token-overlap discriminator exists for.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r2 = makeToplevelRepo("s3-r2");
  const K2 = canonicalRepoLockKey(r2);
  const K2hash = createHash("sha256").update(K2).digest("hex").slice(0, 24);
  const d2 = path.join(r2, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${K2hash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d2, branch: "d2-branch", reason: "D2's own degraded entry, walked up to R2's own real key",
    enteredAt: Date.now(), tokens: ["d2-token-s3"], resolvedKey: K2,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(s3 precondition) D2 is `existing` at R2's own key", activeMergeQuarantineFor(r2)?.repoPath === d2);

  const inject = injectPersistentReadFailure(finalPath);
  let r2Token;
  try {
    r2Token = enterMergeQuarantine(r2, "r2-branch", "r2 raises into D2's already-armed existing entry, final unreadable throughout");
  } finally {
    inject.restore();
  }
  check("(s3 positive control) the read was actually attempted (and injected to fail)", inject.count() >= 1);

  const finalContentAfter = contentIfExists(finalPath) ?? "";
  check("*** THE FIX (existing-branch) *** `final`'s own ORIGINAL bytes are UNTOUCHED (still D2's content, never R2's)",
    finalContentAfter.includes("d2-token-s3") && !finalContentAfter.includes(r2Token));
  check("*** THE FIX (existing-branch) *** R2's own raise still persists IN-PROCESS (diverted, not lost)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r2Token));
  check("*** THE FIX (existing-branch) *** D2's own token is still tracked IN-PROCESS too", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d2-token-s3"));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (existing-branch, reboot) *** D2's own token SURVIVES", freshTokens.has("d2-token-s3"));
  check("*** THE FIX (existing-branch, reboot) *** R2's own token ALSO SURVIVES", freshTokens.has(r2Token));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (Code Review 96a39432, B1) — a DIVERTED raise's own LATER GRADUATION (reached via
  // `activeMergeQuarantineFor`'s lazy-graduation path, `skipDegradedOccupantGuard` FALSE — a graduation
  // is never a raise) reaches `writeMergeQuarantineLatch` too. Round 1's own union lived only inside
  // `enterMergeQuarantine` itself, so this DIFFERENT writer, reaching the SAME marked basename, renamed
  // over it with only the graduated entry's own in-memory tokens — losing whatever ORIG token only
  // `final`'s own bytes still held. THE FIX: the union now lives in `writeMergeQuarantineLatch`'s own
  // chokepoint, reached by every writer uniformly.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("b1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const origToken = "orig-token-b1";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Step 1: a TRANSIENT read failure marks `final`'s basename kept and evicts D's in-memory record (no
  // pending record is ever created on an "unknown" read).
  const inject1 = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject1.restore();
  check("(b1 precondition) D's own file survives the marking clear", fs.existsSync(finalPath));

  fs.mkdirSync(d, { recursive: true });

  // Step 2: D raises itself while EVERY read of `final` fails — the raise must DIVERT (shape 1/2's own
  // mechanism), never overwriting `final`.
  const inject2 = injectPersistentReadFailure(finalPath);
  let t2;
  try {
    t2 = enterMergeQuarantine(d, "d-branch-fresh", "D re-raises itself while final is still unreadable");
  } finally {
    inject2.restore();
  }
  check("(b1 precondition) D's own file still holds ORIG (the raise diverted, never overwrote it)", (contentIfExists(finalPath) ?? "").includes(origToken));

  // Step 3: reads are now restored. A later query for D triggers LAZY GRADUATION — the diverted pending
  // record (t2 only) is armed and durably written via `writeMergeQuarantineLatch` with
  // `skipDegradedOccupantGuard` FALSE. THE FIX: the chokepoint must union ORIG into this write.
  const graduated = activeMergeQuarantineFor(d);
  const graduatedTokens = new Set(graduated?.tokens ?? []);
  check("*** THE FIX (b1) *** graduation carries the ORIGINAL token forward IN-PROCESS", graduatedTokens.has(origToken) && graduatedTokens.has(t2));
  const finalAfterGraduation = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  const finalTokensAfterGraduation = new Set(finalAfterGraduation.tokens ?? []);
  check("*** THE FIX (b1) *** `final` itself now durably carries BOTH tokens", finalTokensAfterGraduation.has(origToken) && finalTokensAfterGraduation.has(t2));

  // Reboot — NO clear at all. Both tokens must survive.
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1, reboot) *** the ORIGINAL token SURVIVES the reboot", freshTokens.has(origToken));
  check("*** THE FIX (b1, reboot) *** the FRESH token ALSO survives the reboot", freshTokens.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (graduation variant, Code Review 96a39432) — `final` is STILL unreadable at the moment
  // graduation runs (never restored before the query). The PRE-EXISTING degraded-occupant guard
  // (`skipDegradedOccupantGuard` FALSE for a graduation) already refuses this write outright — never
  // reaching this card's own chokepoint union at all. ORIG's own bytes stay untouched; the diverted
  // pending record (t2) stays durably tracked via its own `orphanLatchFiles` fold. Both tokens must
  // survive a reboot once reads are restored.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("b1-grad-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const origToken = "orig-token-b1-grad";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject1 = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject1.restore();

  fs.mkdirSync(d, { recursive: true });

  // Left ON through BOTH the raise and the graduation query below — `contentIfExists` itself would also
  // be intercepted, so every verification read of `finalPath` happens AFTER `inject2.restore()`.
  const inject2 = injectPersistentReadFailure(finalPath);
  const t2 = enterMergeQuarantine(d, "d-branch-fresh", "D re-raises itself while final is still unreadable");
  // Graduation runs while `final` is STILL unreadable — the write must be REFUSED by the PRE-EXISTING
  // degraded-occupant guard (not this card's own chokepoint, which the guard refusal never even reaches).
  const graduated = activeMergeQuarantineFor(d);
  inject2.restore();
  check("(b1-grad) graduation still reports D active, in-process, from the diverted pending record alone", new Set(graduated?.tokens ?? []).has(t2));
  const finalAfterRefusedGraduation = contentIfExists(finalPath) ?? "";
  check("(b1-grad precondition) D's own file still holds ORIG (the raise diverted, never overwrote it)", finalAfterRefusedGraduation.includes(origToken));
  check("(b1-grad) `final` itself is UNCHANGED — the refused write never touched it",
    finalAfterRefusedGraduation.includes(origToken) && !finalAfterRefusedGraduation.includes(t2));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1-grad, reboot) *** the ORIGINAL token SURVIVES the reboot", freshTokens.has(origToken));
  check("*** THE FIX (b1-grad, reboot) *** the FRESH token ALSO survives the reboot", freshTokens.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Code Review 1da7261f, B1) — FAIL-CLOSED RESURRECTION. Round 2's chokepoint union could bring
  // a token BACK onto `final` after this process had already durably cleared it: a stale pre-clear copy
  // of `final`'s own bytes, read back by a LATER reconciliation, re-unioned the cleared token in.
  // THE FIX: `clearedTokens`, a process-wide tombstone of every token this process has deliberately
  // cleared, subtracted from every union of on-disk tokens. Also proves the tombstone survives a SECOND,
  // independent transient read failure (t4's own raise) — not just the one that exposed the bug.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("b1res-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);

  const t1 = enterMergeQuarantine(r, "r-branch", "r raises itself (t1)");
  const t2 = enterMergeQuarantine(r, "r-branch", "r raises itself again (t2)");
  const beforeT3 = contentIfExists(finalPath) ?? "";
  check("(b1-resurrection precondition) `final` holds t1+t2 before any failure", beforeT3.includes(t1) && beforeT3.includes(t2));

  // Fail reads #1 (the protect call) and #2 (resolveRaiseOverwrite's own re-check) of THIS raise — t3's
  // own write diverts, carrying t1+t2+t3 forward, and never touches `final`.
  const injectT3 = injectReadFailureAtCalls(finalPath, [1, 2]);
  const t3 = enterMergeQuarantine(r, "r-branch", "r raises itself again while final is unreadable (t3)");
  injectT3.restore();
  const finalAfterT3 = contentIfExists(finalPath) ?? "";
  check("(b1-resurrection) t3's raise diverted — `final` itself is UNCHANGED (still only t1+t2)",
    finalAfterT3.includes(t1) && finalAfterT3.includes(t2) && !finalAfterT3.includes(t3));
  const afterT3Tokens = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(b1-resurrection) t3's raise persists IN-PROCESS (diverted, not lost)", afterT3Tokens.has(t1) && afterT3Tokens.has(t2) && afterT3Tokens.has(t3));

  // Reads restored. clearByToken(r, t1) writes a reduced entry onto `final`'s own MARKED basename — THE
  // FIX must subtract t1 from `final`'s own on-disk tokens ([t1,t2]) rather than let the chokepoint's own
  // union resurrect it onto the freshly-written bytes.
  clearMergeQuarantineByToken(r, t1);
  const finalAfterClearT1 = contentIfExists(finalPath) ?? "";
  check("*** THE FIX (b1-resurrection) *** `final` durably EXCLUDES t1 after clearByToken(r, t1)", !finalAfterClearT1.includes(t1));
  check("(b1-resurrection) `final` still carries t2+t3 after clearByToken(r, t1)", finalAfterClearT1.includes(t2) && finalAfterClearT1.includes(t3));
  const afterClearT1Tokens = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1-resurrection) *** t1 is GONE in-process too — never resurrected", !afterClearT1Tokens.has(t1));

  // A SECOND, independent transient read failure, during a fresh t4 raise — the tombstone must survive
  // this too: t1 must never re-enter memory OR disk via this raise's own fold-in union.
  const injectT4 = injectReadFailureOnlyNth(finalPath, 1);
  const t4 = enterMergeQuarantine(r, "r-branch", "r raises itself again (t4)");
  injectT4.restore();
  const afterT4Tokens = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1-resurrection) *** t1 still never resurrected IN-PROCESS after a SECOND transient read failure", !afterT4Tokens.has(t1));
  check("(b1-resurrection) t2, t3, t4 all still present after t4's raise", afterT4Tokens.has(t2) && afterT4Tokens.has(t3) && afterT4Tokens.has(t4));
  const finalAfterT4 = contentIfExists(finalPath) ?? "";
  check("*** THE FIX (b1-resurrection) *** t1 still never resurrected ON DISK after a SECOND transient read failure", !finalAfterT4.includes(t1));

  // Clear every remaining token — R must be FULLY lifted, never left stuck on a resurrected t1.
  clearMergeQuarantineByToken(r, t2);
  clearMergeQuarantineByToken(r, t3);
  clearMergeQuarantineByToken(r, t4);
  // (other sections' own leftover tokens legitimately coexist in this same process — scope the check to
  // THIS repo's own tokens, never a bare global-emptiness assertion.)
  const afterClearAll = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1-resurrection) *** R is FULLY lifted after clearing t2, t3, t4 — never stuck on a resurrected t1",
    !afterClearAll.has(t1) && !afterClearAll.has(t2) && !afterClearAll.has(t3) && !afterClearAll.has(t4));
  check("(b1-resurrection) `final` itself is gone (fully unlinked, not left holding a resurrected t1)", !fs.existsSync(finalPath));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b1-resurrection, reboot) *** t1 is NOT resurrected after a reboot either", !freshTokens.has(t1));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Code Review 1da7261f, B2) — FAIL-OPEN: `foldInOnDiskTokensIfMarked` (the caller's own
  // reconciliation, before arming) and `writeMergeQuarantineLatch`'s own chokepoint used to each read
  // `final` SEPARATELY for the SAME write. A transient failure between the two could let disk and memory
  // diverge (ORIG surviving on disk but invisible in-process, so a later clear's own full lift destroyed
  // it); failing BOTH let the chokepoint overwrite blind, losing ORIG immediately. THE FIX: the caller's
  // own single fold-in read is now the ONLY read for that write (`reconciledAlready`), and an
  // "unreadable" result diverts the raise instead of ever reaching the chokepoint's own write at all.
  // Run twice — failing only read #3 (foldIn's own read) and failing reads #3 AND #4 (the pre-fix
  // chokepoint's own now-unreachable second read) — both must produce the SAME, fixed outcome.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const failPattern of [[3], [3, 4]]) {
  const tag = failPattern.length === 1 ? "b2-r3" : "b2-r3r4";
  const r = makeToplevelRepo(tag);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const origToken = `orig-token-${tag}`;

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject1 = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject1.restore();
  check(`(${tag} precondition) D's own file survives the marking clear`, fs.existsSync(finalPath));

  fs.mkdirSync(d, { recursive: true });

  // Reads #1 (protect) and #2 (resolveRaiseOverwrite) succeed; #3 is foldIn's own read (the discriminator
  // for this shape); #4 would have been the pre-fix chokepoint's own SEPARATE read — never reached post-fix.
  const injectRaise = injectReadFailureAtCalls(finalPath, failPattern);
  const t2 = enterMergeQuarantine(d, "d-branch-fresh", `D re-raises itself while read(s) ${failPattern.join("+")} of final fail`);
  injectRaise.restore();

  const finalAfterRaise = contentIfExists(finalPath) ?? "";
  check(`*** THE FIX (${tag}) *** \`final\` itself is UNTOUCHED — diverted, never overwritten blind`,
    finalAfterRaise.includes(origToken) && !finalAfterRaise.includes(t2));
  const inProcessAfterRaise = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check(`*** THE FIX (${tag}) *** t2's raise persists IN-PROCESS (diverted, not lost)`, inProcessAfterRaise.has(t2));

  // A later query graduates the diverted pending record — reads are restored, so ORIG correctly rejoins
  // (same mechanism the b1 scenario above already proves, for the SAME shared chokepoint).
  const graduated = activeMergeQuarantineFor(d);
  const graduatedTokens = new Set(graduated?.tokens ?? []);
  check(`*** THE FIX (${tag}) *** graduation carries the ORIGINAL token forward IN-PROCESS`, graduatedTokens.has(origToken) && graduatedTokens.has(t2));
  const finalAfterGraduation = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  const finalTokensAfterGraduation = new Set(finalAfterGraduation.tokens ?? []);
  check(`*** THE FIX (${tag}) *** \`final\` itself now durably carries BOTH tokens`, finalTokensAfterGraduation.has(origToken) && finalTokensAfterGraduation.has(t2));

  // clearByToken(D, t2) must lift ONLY t2 — ORIG must survive, in-process and across a reboot.
  clearMergeQuarantineByToken(d, t2);
  const stillActive = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check(`*** THE FIX (${tag}) *** ORIG survives clearByToken(D, t2) — never fail-open lost`, stillActive.has(origToken));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const freshTokens = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check(`*** THE FIX (${tag}, reboot) *** ORIG survives a reboot`, freshTokens.has(origToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 4 (Code Review 45de2406, BLOCKER 1, "round4-y") — round 3's own tombstone, inside
  // `deleteMergeQuarantineLatchByKey`'s successful-unlink branch, fired unconditionally on `finalProtectOk
  // === true` — but that covers BOTH "nothing foreign here" AND "a foreign occupant's content was
  // successfully copied aside and is STILL durably enforced" (d2582692's shape: a clear of R can find a
  // wholly foreign D sharing R's own degraded key, protect it by copying it aside, and unlink `final` —
  // "unlinked" here means "relocated", not "destroyed"). Tombstoning there resurrected a LATER read
  // failure into fail-open loss. THE FIX: tombstoning now happens ONLY in `tombstoneIfNotSurviving`,
  // called once at the end of each top-level clear — by then, a successful copy-aside's own fresh
  // pending record is already visible to that helper's own "no surviving record holds this" scan.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("round4-y-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const origToken = "orig-token-round4-y";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(round4-y precondition) orig armed at boot", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));

  // (1) Clear R — a DIFFERENT identity than D. Every read succeeds here: D is a FOREIGN occupant of R's
  // own degraded key, so it is protect-copied aside (a fresh pending record) before `final` is unlinked.
  clearMergeQuarantineReporting(r);
  check("*** THE FIX (round4-y) *** D's own orig is STILL quarantined in-process after clearing R (protected, never tombstoned)",
    new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));

  // (2) D remounts and graduates — `final` is rewritten with orig.
  fs.mkdirSync(d, { recursive: true });
  const graduatedY = activeMergeQuarantineFor(d);
  check("(round4-y) graduation carries orig", (graduatedY?.tokens ?? []).includes(origToken));
  check("(round4-y) final holds orig after graduation", (contentIfExists(finalPath) ?? "").includes(origToken));

  // (3) Clear R again — this time ONE read fails. `final` is KEPT (not unlinked) and marked; D's own
  // in-memory record is evicted regardless (63e49ee2's own accepted residual — see the decision record's
  // Round 4 "Accepted residual" note: this is NOT a bug this card fixes).
  const injectY = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  injectY.restore();
  check("(round4-y) final still holds orig on disk after the read-failure clear", (contentIfExists(finalPath) ?? "").includes(origToken));

  // (4) D re-raises itself, no failures this time — the fold-in must carry orig forward, never
  // tombstone it (round 3's own bug: `finalProtectOk` true at step (1) wrongly tombstoned it right then).
  const t2y = enterMergeQuarantine(d, "d-branch-fresh", "D re-raise after the read-failure clear");
  check("*** THE FIX (round4-y) *** orig survives D's re-raise IN-PROCESS", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));
  check("*** THE FIX (round4-y) *** orig survives D's re-raise ON DISK", (contentIfExists(finalPath) ?? "").includes(origToken));

  // clearByToken(D, t2) must lift ONLY the fresh token — D stays enforced via orig.
  clearMergeQuarantineByToken(d, t2y);
  check("*** THE FIX (round4-y) *** orig survives clearByToken(D, t2) — D stays enforced",
    new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));

  const freshY = await freshBootModule();
  freshY.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round4-y, reboot) *** orig survives a fresh-import reboot",
    new Set(freshY.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 4 (Code Review 45de2406, BLOCKER 2, "round4-x") — `consumeMatchedPendingsIntoArmedEntry`'s own
  // raise-divert branch ran AFTER its matched pendings were already spliced out of
  // `pendingUnresolvedQuarantines`. A SIBLING pending entry consumed alongside the raiser (a DIFFERENT
  // identity sharing the raiser's own canonical key, via `collectCrossTierSiblingIndices`) had nothing
  // left tracking its own `sourceFile` once diverted — orphaned on disk, re-arming after a reboot. THE
  // FIX (this round): fold every matched entry's own `sourceFile` into `armed.orphanLatchFiles` before
  // diverting, excluding only the divert's own likely target. The sibling's own `sourceFile` here
  // (`sibFile` below) is a FIXED, arbitrary literal — never derived from either identity's own hash — so
  // this is also the dedicated "distinct sourceFile" case (never relying on the same-identity-coincidence
  // the fix must not).
  //
  // @decision 6c04633d — SUPERSEDES this round's own merge-everything shape for a DIFFERENT identity: S
  // (identity ≠ D's own) is no longer folded into D's divert record at all — it is pushed straight back,
  // untouched, under its own identity (decision record, Follow-up 6c04633d). `sibFile` is a THIRD valid
  // state the check below now accounts for: live and correct, never an orphan, never gone.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("round4-x-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const s = path.join(r, "sib-subdir");
  const origToken = "orig-token-round4-x";
  const sibToken = "sib-token-round4-x";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  // A SIBLING pending entry — a DIFFERENT identity (S, not D) sharing R's own canonical key, with its
  // own DISTINCT sourceFile name (never derived from either D's or S's own identity hash).
  const sibFile = "pending-0123456789abcdef01234567.json";
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sibFile), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "S", enteredAt: Date.now() - 100000, tokens: [sibToken],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // A transient read failure marks `final`'s basename kept and evicts D's in-memory record.
  const injectX1 = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  injectX1.restore();

  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(s, { recursive: true });

  // D raises itself; ONLY the fold-in read (#3) fails — the raise diverts, consuming the sibling (via
  // `collectCrossTierSiblingIndices`, since both D and S now resolve to R's own canonical key) into it.
  const injectX2 = injectReadFailureAtCalls(finalPath, [3]);
  const t2x = enterMergeQuarantine(d, "d2", "D raise, foldIn read fails, consumes sibling");
  injectX2.restore();

  const filesAfterRaise = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const allEntriesX = listActiveMergeQuarantines();
  const referencedOrphansX = new Set(allEntriesX.flatMap((e) => e.orphanLatchFiles ?? []));
  // @decision 6c04633d (M3, Code Review `e8c78d98`) — tie the check to THIS exact file, captured at the
  // SAME pre-query snapshot as `filesAfterRaise`/`referencedOrphansX` above — `activeMergeQuarantineFor`
  // below is a QUERY whose own lazy-graduation tail can ITSELF trigger a (pre-existing, unchanged, out of
  // this card's scope) successful consolidation of D+S once reads succeed again, which would delete
  // `sibFile` out from under a check read any later than this.
  const sibFileContentAfterRaise = contentIfExists(path.join(MERGE_QUARANTINE_DIR, sibFile)) ?? "";
  check("(round4-x) t2 enforced in-process", new Set(allEntriesX.flatMap((q) => q.tokens ?? [])).has(t2x));
  check("(round4-x) d reported quarantined", !!activeMergeQuarantineFor(d));
  check("*** THE FIX (round4-x) *** the sibling's own sourceFile is NEVER an untracked orphan — gone, named in SOME entry's own orphanLatchFiles, or (6c04633d) still THIS exact file's own untouched bytes naming S and sibToken",
    !filesAfterRaise.includes(sibFile) || referencedOrphansX.has(sibFile) ||
    (sibFileContentAfterRaise.includes(sibToken) && sibFileContentAfterRaise.includes(path.basename(s))));

  // Clear every token in-process (orig is stranded, unreconciled, in `final`'s own untouched bytes
  // throughout this scenario — this call is a defensive no-op, exactly mirroring the card's own repro).
  clearMergeQuarantineByToken(d, t2x);
  clearMergeQuarantineByToken(s, sibToken);
  clearMergeQuarantineByToken(d, origToken);
  const leftTokensX = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(round4-x) in-process fully lifted of t2/sib", !leftTokensX.has(t2x) && !leftTokensX.has(sibToken));

  const freshX = await freshBootModule();
  freshX.reenterMergeQuarantinesAtBoot([]);
  const freshTokensX = new Set(freshX.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (round4-x) *** the sibling's token is NOT resurrected after a reboot (cleared in-process, never re-armed from an orphaned file)", !freshTokensX.has(sibToken));
  check("*** THE FIX (round4-x) *** t2 is NOT resurrected after a reboot", !freshTokensX.has(t2x));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CR4 of 8db913e2, finding 1 ("d6efbc9b-z3", ported from CR4's own scratch probe Z3, commit cb461f56) —
  // a BY-TOKEN release of the owner's LAST outstanding token, while `final`'s own read fails, must still
  // land: `clearActiveEntryTokenAtKey`'s last-token branch hands off entirely to
  // `clearMergeQuarantineByKey`, whose own `tombstoneIfNotSurviving` call is gated by condition (b) on
  // `touchedFinalBasenames` — a read failure there keeps `final` kept-and-marked and returns early,
  // WITHOUT tombstoning the token the owner just released. A later same-identity re-raise's own fold-in
  // then reads that still-marked, un-tombstoned basename back and resurrects the released token. THE FIX:
  // after `clearMergeQuarantineByKey` returns, tombstone `token` unconditionally (no touched list),
  // matching `clearTokenFromPendingIndices`' own last-token branch.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("d6efbc9b-z3");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);

  const t1 = enterMergeQuarantine(r, "r-branch", "r raises itself (t1, its only token)");
  check("(d6efbc9b-z3 precondition) `final` holds t1 before any failure", (contentIfExists(finalPath) ?? "").includes(t1));

  // Release t1 — R's ONLY outstanding token — while `final`'s own read fails: `clearActiveEntryTokenAtKey`'s
  // last-token branch keeps `final` (kept-and-marked), but the RELEASE of t1 must still take effect.
  const injectClear = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineByToken(r, t1);
  injectClear.restore();
  check("(d6efbc9b-z3 precondition) r is lifted IN-PROCESS after releasing its only token (measured via listActiveMergeQuarantines, never assertRepoNotQuarantined)", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t1));

  // A fresh, FULLY-SUCCESSFUL re-raise of the SAME identity — no injection here at all. Pre-fix: the
  // fold-in reads `final`'s own still-kept, still-marked bytes (which still physically hold t1, since the
  // read failure above only kept the file, never unlinked it) and re-unions the released t1 back in.
  const t2 = enterMergeQuarantine(r, "r-branch", "r re-raises itself (t2)");
  const tokensAfterT2 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (d6efbc9b-z3) *** released t1 is NOT resurrected by r's own re-raise, IN-PROCESS", !tokensAfterT2.has(t1));
  check("(d6efbc9b-z3) t2 itself is enforced", tokensAfterT2.has(t2));

  // Release t2 — R must be FULLY lifted, never left stuck on a resurrected, nobody-holds-it t1.
  clearMergeQuarantineByToken(r, t2);
  const tokensAfterT2Clear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (d6efbc9b-z3) *** r is FULLY lifted IN-PROCESS after releasing t2 — never stuck on a resurrected t1", !tokensAfterT2Clear.has(t1) && !tokensAfterT2Clear.has(t2));

  // Measure tokens after a reboot through a FRESH module import (never `assertRepoNotQuarantined`) — the
  // durable, on-disk proof that t1 was never resurrected and both tokens are genuinely gone.
  const freshZ3 = await freshBootModule();
  freshZ3.reenterMergeQuarantinesAtBoot([]);
  const freshTokensZ3 = new Set(freshZ3.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (d6efbc9b-z3, reboot) *** t1 is NOT resurrected after a reboot", !freshTokensZ3.has(t1));
  check("*** THE FIX (d6efbc9b-z3, reboot) *** t2 is NOT resurrected after a reboot either", !freshTokensZ3.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review of d6efbc9b, card 7a7e041b ("7a7e041b-p3") — `protectOccupantContentBeforeDelete`'s own
  // on-disk token read never subtracted `clearedTokens`, unlike its sibling reader
  // `reconcileMarkedBasenameBeforeWrite`. A degraded foreign occupant's already-released token could ride
  // back in via the copy-aside path a LATER raise's own protect call triggers. THE FIX: both readers now
  // go through the SAME shared `readSurvivingOnDiskTokens`, and the copy-aside is SKIPPED entirely
  // (nothing is persisted) when every real on-disk token has already been deliberately cleared.
  //
  // P3 below is the card's own repro, ported verbatim from its 8 numbered steps. By the time the
  // copy-aside runs, EVERY token physically on `final` (just t1, by then) has already been deliberately
  // cleared by this process — this IS the card's own "all-tokens-tombstoned" scenario.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("7a7e041b-p3");
  const subD = path.join(r, "sub-d");
  fs.mkdirSync(subD, { recursive: true });
  const Kr = canonicalRepoLockKey(r);
  check("(p3 precondition) sub-d shares R's own canonical key", canonicalRepoLockKey(subD) === Kr);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);

  // Steps 1-3: d1 raises sub-d; t1 raises R at the same key — the existing branch takes d1's own
  // identity (longest-outstanding raise wins), so `final` ends up {repoPath: sub-d, tokens: [d1, t1]}.
  const d1 = enterMergeQuarantine(subD, "d-branch", "sub-d raises itself (d1)");
  const t1 = enterMergeQuarantine(r, "r-branch", "r raises at the same key (existing branch)");
  check("(p3 precondition) final holds both d1 and t1", (contentIfExists(finalPath) ?? "").includes(d1) && (contentIfExists(finalPath) ?? "").includes(t1));

  // Step 4: clear d1 (a PARTIAL clear — t1 remains) — final now holds only t1.
  clearMergeQuarantineByToken(subD, d1);
  check("(p3 precondition) final holds only t1 after d1's partial clear", (contentIfExists(finalPath) ?? "").includes(t1) && !(contentIfExists(finalPath) ?? "").includes(d1));

  // Step 5: sub-d's own identity is now unresolvable.
  fs.rmSync(subD, { recursive: true, force: true });

  // Step 6: release t1 — the LAST remaining in-memory token on that entry — while `final`'s own read
  // fails: `clearMergeQuarantineByKey` keeps `final` (fail-closed), but d6efbc9b's own fix still
  // tombstones t1 unconditionally. R is lifted in-process.
  const injectClear = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineByToken(r, t1);
  injectClear.restore();
  check("(p3 precondition) r is lifted IN-PROCESS after releasing t1", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t1));

  // Steps 7-8: a fresh raise of R — no injection here at all. `final` still physically holds [t1] (kept,
  // fail-closed, by step 6), and sub-d's own identity is unresolvable, so this hits the "different,
  // still-unresolvable identity" branch and calls `protectOccupantContentBeforeDelete(final, subD, r)`.
  // Pre-fix: it copies [t1] aside into a BRAND-NEW pending sub-d record, resurrecting a token this
  // process already tombstoned.
  const t2 = enterMergeQuarantine(r, "r-branch", "r re-raises (t2)");
  const tokensAfterT2 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3) *** t1 is NOT resurrected by r's own re-raise's copy-aside", !tokensAfterT2.has(t1));
  check("(p3) t2 itself is enforced", tokensAfterT2.has(t2));
  check("*** THE FIX (p3) *** no brand-new sub-d pending record was minted for an already-fully-released occupant",
    !listActiveMergeQuarantines().some((q) => q.repoPath === subD));

  clearMergeQuarantineByToken(r, t2);
  const tokensAfterT2Clear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3) *** r is FULLY lifted IN-PROCESS — never stuck on a resurrected t1", !tokensAfterT2Clear.has(t1) && !tokensAfterT2Clear.has(t2));

  const freshP3 = await freshBootModule();
  freshP3.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP3 = new Set(freshP3.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3, reboot) *** t1 is NOT resurrected after a reboot", !freshTokensP3.has(t1));
  check("*** THE FIX (p3, reboot) *** t2 is NOT resurrected after a reboot either", !freshTokensP3.has(t2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 7a7e041b, MIXED SCENARIO ("7a7e041b-mixed") — `final` physically holds TWO tokens: one already
  // tombstoned (an unrelated, fully-cleared raise that happens to reuse the identical token string — the
  // tombstone set is keyed on the string alone, exactly like production), the other never cleared at
  // all. The fix must drop ONLY the tombstoned token from the copy-aside, never discard the still-
  // legitimately-outstanding survivor and never keep the dead one either.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("7a7e041b-mixed");
  const d = path.join(r, "gone-subdir"); // never created — a phantom, unresolvable occupant identity
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);

  // Mint a token via a wholly UNRELATED repo and fully clear it — this durably tombstones that exact
  // string in `clearedTokens`, with no connection at all to r/d/finalPath below.
  const scratch = makeToplevelRepo("7a7e041b-mixed-scratch");
  const deadTok = enterMergeQuarantine(scratch, "scratch-branch", "scratch raise — becomes the tombstoned token");
  clearMergeQuarantineByToken(scratch, deadTok);
  check("(mixed precondition) deadTok is lifted in-process (tombstoned)", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(deadTok));

  // Hand-write `final` directly (never loaded into THIS process's memory at all — d is never booted),
  // holding BOTH the already-tombstoned token and a genuinely fresh, never-cleared survivor.
  const keepTok = "mixed-keep-token-7a7e041b";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, holding a mixed token set",
    enteredAt: Date.now(), tokens: [keepTok, deadTok],
  }, null, 2) + "\n");
  check("(mixed precondition) final holds both tokens before r's raise", (contentIfExists(finalPath) ?? "").includes(keepTok) && (contentIfExists(finalPath) ?? "").includes(deadTok));

  // r raises itself: nothing is armed at Kr in this process (d was never booted), so this hits the
  // "no existing" / brand-new-entry region and calls protectOccupantContentBeforeDelete(final, d, r).
  const rTok = enterMergeQuarantine(r, "r-branch", "r raises over the mixed-token foreign occupant");
  const tokensAfterRaise = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (mixed) *** the tombstoned deadTok is dropped from the copy-aside, never resurrected", !tokensAfterRaise.has(deadTok));
  check("*** THE FIX (mixed) *** the still-owed keepTok SURVIVES the copy-aside", tokensAfterRaise.has(keepTok));
  check("(mixed) r's own raise is enforced too", tokensAfterRaise.has(rTok));

  // Reviewer finding 2 (5b55149b) — the Tests section previously claimed keepTok survives "in-process and
  // across a reboot," but every reboot check below ran AFTER keepTok was already cleared, so survival
  // across a reboot while still held was never actually asserted. Check it here, BEFORE any clear.
  const freshMixedPreClear = await freshBootModule();
  freshMixedPreClear.reenterMergeQuarantinesAtBoot([]);
  const mixedPreClearEntries = freshMixedPreClear.listActiveMergeQuarantines();
  check("*** THE FIX (mixed, reboot BEFORE any clear) *** keepTok survives a reboot, still held by d's own pending record",
    mixedPreClearEntries.some((q) => q.repoPath === d && (q.tokens ?? []).includes(keepTok)));
  check("(mixed, reboot before any clear) deadTok is NOT resurrected after that same reboot",
    !mixedPreClearEntries.some((q) => (q.tokens ?? []).includes(deadTok)));

  clearMergeQuarantineByToken(d, keepTok);
  clearMergeQuarantineByToken(r, rTok);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(mixed) everything lifts in-process once genuinely released", !tokensAfterClear.has(keepTok) && !tokensAfterClear.has(deadTok) && !tokensAfterClear.has(rTok));

  const freshMixed = await freshBootModule();
  freshMixed.reenterMergeQuarantinesAtBoot([]);
  const freshTokensMixed = new Set(freshMixed.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (mixed, reboot) *** deadTok is NOT resurrected after a reboot", !freshTokensMixed.has(deadTok));
  check("(mixed, reboot) keepTok/rTok also stay gone after a reboot (fully released)", !freshTokensMixed.has(keepTok) && !freshTokensMixed.has(rTok));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 5b55149b, REVIEWER PROBE B2 ("7a7e041b-b2") — `final` physically holds the LEGACY singular
  // `token` field with an EMPTY `tokens` array: `{tokens: [], token: "legacy-live-tok"}`.
  // `readSurvivingOnDiskTokens`'s own array-type guard treated an empty array as a VALID (if empty)
  // string array, so pre-fix it never fell through to the `token` fallback at all — the copy-aside then
  // minted a brand-new RANDOM token in place of the real legacy one, and the legacy token's own holder
  // could never clear it by token again. THE FIX: fall back to `token` whenever `tokens` is EMPTY *or*
  // missing, not just missing — keeping the clearedTokens subtraction unchanged.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("7a7e041b-b2");
  const d = path.join(r, "gone-subdir-b2"); // never created — a phantom, unresolvable occupant identity
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  const legacyTok = "legacy-live-tok-7a7e041b-b2";

  // Hand-write `final` directly in the LEGACY singular-`token` shape with an EMPTY `tokens` array — never
  // loaded into THIS process's memory at all (d is never booted).
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, legacy singular token field",
    enteredAt: Date.now(), tokens: [], token: legacyTok,
  }, null, 2) + "\n");
  check("(b2 precondition) final holds the legacy token with an empty tokens array", (contentIfExists(finalPath) ?? "").includes(legacyTok));

  // r raises itself: nothing is armed at Kr in this process (d was never booted), so this hits the
  // "no existing" / brand-new-entry region and calls protectOccupantContentBeforeDelete(final, d, r).
  const rTok = enterMergeQuarantine(r, "r-branch", "r raises over the legacy-token foreign occupant");
  const tokensAfterRaise = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b2) *** the legacy token survives the copy-aside, never replaced by a fresh random token",
    tokensAfterRaise.has(legacyTok));
  check("(b2) r's own raise is enforced too", tokensAfterRaise.has(rTok));

  const freshB2PreClear = await freshBootModule();
  freshB2PreClear.reenterMergeQuarantinesAtBoot([]);
  const b2PreClearEntries = freshB2PreClear.listActiveMergeQuarantines();
  check("*** THE FIX (b2, reboot BEFORE any clear) *** the legacy token survives a reboot, still held by d's own pending record",
    b2PreClearEntries.some((q) => q.repoPath === d && (q.tokens ?? []).includes(legacyTok)));

  // The legacy token must still be clearable BY TOKEN — not just present on disk.
  clearMergeQuarantineByToken(d, legacyTok);
  clearMergeQuarantineByToken(r, rTok);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b2) *** the legacy token lifts in-process once cleared BY TOKEN",
    !tokensAfterClear.has(legacyTok) && !tokensAfterClear.has(rTok));

  const freshB2 = await freshBootModule();
  freshB2.reenterMergeQuarantinesAtBoot([]);
  const freshTokensB2 = new Set(freshB2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (b2, reboot) *** the legacy token is NOT resurrected after a reboot", !freshTokensB2.has(legacyTok));
  check("(b2, reboot) r's own token stays gone after a reboot too", !freshTokensB2.has(rTok));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD dd34da46, ITEM 1 ("dd34da46-item1") — an existing-branch divert leaves `final`'s own
  // `keptUnreadableLatchFiles` mark in place (no rename ever lands on `final`). A LATER full clear of the
  // armed identity (`clearMergeQuarantineByRecordedPath`) used to keep `final` unconditionally because of
  // that stale mark alone, even though a fresh read — restored by the time the clear runs — proves every
  // token physically there is already one this exact clear is dropping. Pre-fix, the cleared token comes
  // back once after a reboot (PASS 1 re-reads the still-kept file, now readable again). THE FIX: when the
  // mark is the ONLY reason to keep, a fresh read proving full containment unlinks `final` and drops the
  // mark too (`markedFinalFullyCoveredByClear`).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r2 = makeToplevelRepo("item1-r2");
  const K2 = canonicalRepoLockKey(r2);
  const K2hash = createHash("sha256").update(K2).digest("hex").slice(0, 24);
  const d2 = path.join(r2, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${K2hash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d2, branch: "d2-branch", reason: "D2's own degraded entry, walked up to R2's own real key",
    enteredAt: Date.now(), tokens: ["d2-token-item1"], resolvedKey: K2,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(item1 precondition) D2 is `existing` at R2's own key", activeMergeQuarantineFor(r2)?.repoPath === d2);

  const inject = injectPersistentReadFailure(finalPath);
  let r2Token;
  try {
    r2Token = enterMergeQuarantine(r2, "r2-branch", "r2 raises into D2's already-armed existing entry, final unreadable throughout");
  } finally {
    inject.restore(); // the read failure was TRANSIENT — restored before the later clear below
  }
  check("(item1 precondition) `final` is untouched (still ONLY d2's token) right after the divert",
    (contentIfExists(finalPath) ?? "").includes("d2-token-item1") && !(contentIfExists(finalPath) ?? "").includes(r2Token));
  check("(item1 precondition) both tokens are tracked IN-PROCESS after the divert", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r2Token)
    && new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d2-token-item1"));

  // The LATER full clear — reads are restored, so this is a FRESH, successful read proving the mark is
  // stale: `final` still holds nothing but d2's own token, which this clear (of the SAME merged identity)
  // is already dropping.
  const clearResult = clearMergeQuarantineByRecordedPath(d2);
  check("(item1) the clear itself reports wasQuarantined", clearResult?.wasQuarantined === true);
  check("*** THE FIX (item1) *** `final` is UNLINKED, not kept on a stale mark", contentIfExists(finalPath) === null);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (item1) *** d2's own token is lifted IN-PROCESS", !tokensAfterClear.has("d2-token-item1"));
  check("*** THE FIX (item1) *** r2's own (merged) token is ALSO lifted IN-PROCESS", !tokensAfterClear.has(r2Token));

  const freshItem1 = await freshBootModule();
  freshItem1.reenterMergeQuarantinesAtBoot([]);
  const freshTokensItem1 = new Set(freshItem1.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (item1, reboot) *** d2's own token does NOT come back after a reboot", !freshTokensItem1.has("d2-token-item1"));
  check("*** THE FIX (item1, reboot) *** r2's own token does NOT come back after a reboot either", !freshTokensItem1.has(r2Token));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 N4 ("dd34da46-n4") — the item1 shape, but the unlink THAT fix's own fresh-content-proof
  // would otherwise license fails with EPERM/EBUSY. THE FIX (N4) classifies the unlink's own outcome and
  // drops the keep-mark ONLY on a confirmed success (or ENOENT) — never before attempting it — so an
  // EPERM-shaped failure must leave `final` physically on disk, the mark in place, and d2's own token
  // (the one actually backed by `final`'s own bytes) un-tombstoned: it survives a fresh-import reboot,
  // the documented "kept until reboot or a later successful read" residual (`63e49ee2`).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r2 = makeToplevelRepo("n4-r2");
  const K2 = canonicalRepoLockKey(r2);
  const K2hash = createHash("sha256").update(K2).digest("hex").slice(0, 24);
  const d2 = path.join(r2, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${K2hash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d2, branch: "d2-branch", reason: "D2's own degraded entry, walked up to R2's own real key",
    enteredAt: Date.now(), tokens: ["d2-token-n4"], resolvedKey: K2,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(n4 precondition) D2 is `existing` at R2's own key", activeMergeQuarantineFor(r2)?.repoPath === d2);

  const injectRead = injectPersistentReadFailure(finalPath);
  let r2Token;
  try {
    r2Token = enterMergeQuarantine(r2, "r2-branch", "r2 raises into D2's already-armed existing entry, final unreadable throughout");
  } finally {
    injectRead.restore(); // the read failure was TRANSIENT — restored before the clear below
  }
  check("(n4 precondition) `final` is untouched (still ONLY d2's token)",
    (contentIfExists(finalPath) ?? "").includes("d2-token-n4") && !(contentIfExists(finalPath) ?? "").includes(r2Token));
  const contentBeforeClear = contentIfExists(finalPath);

  // The LATER full clear — reads succeed (proving coverage, the same way item1's own clear does), but the
  // unlink that proof would otherwise license fails with EPERM.
  const injectUnlink = injectUnlinkFailureForPath(finalPath);
  let threw = false;
  let clearResult;
  try {
    clearResult = clearMergeQuarantineByRecordedPath(d2);
  } catch {
    threw = true;
  } finally {
    injectUnlink.restore();
  }
  check("*** THE FIX (n4) *** nothing throws even though the unlink fails", !threw);
  check("(n4) the injected unlink failure was actually attempted", injectUnlink.count() >= 1);
  check("*** THE FIX (n4) *** `final` is STILL on disk, byte-for-byte unchanged", contentIfExists(finalPath) === contentBeforeClear);
  check("(n4) the clear itself still reports wasQuarantined (it did real work — r2's own separate pending-divert record)", clearResult?.wasQuarantined === true);

  // r2's own token has a SEPARATE durable backing (the existing-branch divert's own pending-divert
  // record, never `final` itself) — the clear's own pending-sweep is unrelated to the failed unlink and
  // still runs, so r2's token IS genuinely, fully gone (unlike d2's, which is backed only by `final`).
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(n4) r2's own token (separately backed) is fully lifted IN-PROCESS", !tokensAfterClear.has(r2Token));

  const freshN4 = await freshBootModule();
  freshN4.reenterMergeQuarantinesAtBoot([]);
  const freshTokensN4 = new Set(freshN4.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (n4, reboot) *** d2's own token — backed only by the kept `final` — SURVIVES a reboot (the documented kept-until-reboot residual)", freshTokensN4.has("d2-token-n4"));
  check("(n4, reboot) r2's own (separately, successfully swept) token does NOT come back", !freshTokensN4.has(r2Token));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD dd34da46, ITEM 2 ("dd34da46-item2") — a shape-1 divert plus a QUERY (lazy graduation of R's own
  // pending entry) can leave R's only exposed latch id EQUAL to D's own physical file id (both still
  // coincidentally share the SAME filename hash, since R's own graduation write is itself REFUSED by the
  // pre-existing degraded-occupant guard — D's content genuinely, unresolvably occupies that exact
  // physical file). `clearMergeQuarantineLatchFile(id)` already refuses this as ambiguous — this is a
  // LOCK-IN regression test (verified during this card's own investigation that the refusal ALREADY
  // names both candidates and the clear-by-path remedy precisely; no code change was needed for this
  // item — see the decision record's own "Follow-up dd34da46" section for why full disambiguation isn't
  // safely achievable here: R's own claim at this id has NO durable physical backing at all, while D is
  // the confirmed physical owner, yet the id is exposed for BOTH).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("item2-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-item2"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    inject.restore();
  }

  // The QUERY that triggers lazy graduation of r's own pending entry — its own durable write is REFUSED
  // (the pre-existing degraded-occupant guard: D's content genuinely, unresolvably occupies this exact
  // physical file), but r is armed IN-MEMORY at this same key regardless (enforcement never waits on I/O).
  const rAfterQuery = activeMergeQuarantineFor(r);
  check("(item2 precondition) r's exposed id equals d's own physical file id",
    quarantineLatchFileIdsFor(rAfterQuery).includes(Krhash));

  const clearResult = clearMergeQuarantineLatchFile(Krhash);
  check("(item2) clear-by-id REFUSES rather than guessing which identity to clear", clearResult?.ok === false);
  check("(item2) the refusal names r's own repoPath", (clearResult?.reason ?? "").includes(r));
  check("(item2) the refusal names d's own repoPath", (clearResult?.reason ?? "").includes(d));
  check("(item2) the refusal names the clear-by-path remedy precisely", (clearResult?.reason ?? "").includes("/internal/merge-quarantine/clear-by-path")
    && (clearResult?.reason ?? "").includes(r) && (clearResult?.reason ?? "").includes(d));
  const tokensAfterRefusal = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(item2) NOTHING was actually cleared by the refused attempt — r's token still tracked", tokensAfterRefusal.has(rToken));
  check("(item2) NOTHING was actually cleared by the refused attempt — d's token still tracked", tokensAfterRefusal.has("d-token-item2"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD dd34da46, ITEM 3 ("dd34da46-item3") — a DOUBLE FAULT: a raise diverts (its own key's physical
  // final cannot be safely overwritten) AND the divert's own pending-divert write ALSO fails (e.g.
  // ENOSPC). Pre-fix: the raise is enforced IN-PROCESS ONLY and silently LOST after a reboot (no durable
  // trace survives anywhere). THE FIX: a best-effort SAFETY-TMP residue fallback
  // (`attemptDivertSafetyTmpFallback`/`writeSafetyTmpResidueAtHash`) — already recovered at boot by
  // `reenterMergeQuarantinesAtBoot`'s own pre-existing safety-tmp recovery pass — closes the gap.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("item3-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-item3"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const pendingFilename = pendingDivertFilenameForTest(r);
  const pendingPrefix = path.join(MERGE_QUARANTINE_DIR, pendingFilename);
  const injectRead = injectPersistentReadFailure(finalPath);
  const injectWrite = injectOpenSyncFailureForPrefix(pendingPrefix);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key; BOTH the read AND the divert's own pending write fail");
  } finally {
    injectRead.restore();
    injectWrite.restore();
  }
  check("(item3) the injected write failure was actually attempted", injectWrite.count() >= 1);
  check("(item3) r's raise still persists IN-PROCESS despite the double fault (e1cb7d33)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(rToken));
  check("(item3) the ORIGINAL pending-divert file was NEVER actually written (the injected failure held)", !fs.existsSync(pendingPrefix));

  // @decision 8db913e2 (Follow-up dd34da46, N3) — select by r's OWN hash prefix (quarantineHashFor(r) ===
  // Krhash, since r is fully resolvable), never a bare "any safety-tmp exists" — the shared
  // MERGE_QUARANTINE_DIR can already hold OTHER scenarios' own safety-tmp residues at this point in the
  // file, which would make a bare existence check pass vacuously regardless of whether THIS fallback ran.
  const safetyTmpFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${Krhash}.json.tmp-safety-`));
  check("*** THE FIX (item3) *** a SAFETY-TMP residue matching r's OWN key hash was written as a fallback", safetyTmpFiles.length > 0);
  check("*** THE FIX (item3) *** that specific safety-tmp residue's own content carries r's token", safetyTmpFiles.some((f) => (contentIfExists(path.join(MERGE_QUARANTINE_DIR, f)) ?? "").includes(rToken)));

  const freshItem3 = await freshBootModule();
  freshItem3.reenterMergeQuarantinesAtBoot([]);
  const freshTokensItem3 = new Set(freshItem3.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (item3, reboot) *** r's token SURVIVES a reboot via the safety-tmp fallback", freshTokensItem3.has(rToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 95ea8d3f ("95ea8d3f-p2d") — the dd34da46-item2 correction: following the refusal's own
  // clear-by-path remedy, `clearMergeQuarantineByRecordedPath(d)` LIFTS D in-process, but pre-fix never
  // durably persisted it — a stale `keptUnreadableLatchFiles` mark (left by R's own earlier read
  // failure, which has since fully resolved) short-circuited `sweepOwnLatchFileUnlessOwnedElsewhere`
  // before it ever re-checked D's own physical content, AND (once that mark check is fixed)
  // `physicalOwnerRepoPaths` separately reported R as an "owner" of this exact filename purely because
  // R is ARMED there in-memory — even though R's own write to it was refused and nothing of R's is
  // physically backed by this file at all. THE FIX: `sweepOwnLatchFileUnlessOwnedElsewhere` accepts an
  // optional `candidateTokens` and re-proves a marked file's coverage via the SAME content-containment
  // check `deleteMergeQuarantineLatchByKey` already uses (`markedFinalFullyCoveredByClear`); proven
  // coverage settles BOTH the mark and the ownership check in one step (a genuinely-written owner's own
  // tokens would already be on disk, breaking coverage).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p2d-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p2d"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    inject.restore();
  }
  // The QUERY that triggers lazy graduation of r's own pending entry (same precondition as item2's own
  // "shape-1 divert plus a query") — r is armed IN-MEMORY at d's own key, its own durable write refused.
  activeMergeQuarantineFor(r);

  const clearResult = clearMergeQuarantineByRecordedPath(d);
  check("(p2d) clear-by-path(d) reports success, no shared-latch warning", clearResult?.wasQuarantined === true && !clearResult?.latchKept);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p2d) d's token is lifted IN-PROCESS", !tokensAfterClear.has("d-token-p2d"));
  check("(p2d) r's own raise is UNAFFECTED by d's clear", tokensAfterClear.has(rToken));

  const freshP2d = await freshBootModule();
  freshP2d.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP2d = new Set(freshP2d.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p2d, reboot) *** d's token does NOT come back", !freshTokensP2d.has("d-token-p2d"));
  check("*** THE FIX (p2d, reboot) *** r's own raise SURVIVES (e1cb7d33) and is unaffected by d's clear", freshTokensP2d.has(rToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 95ea8d3f ("95ea8d3f-p2r") — CONTROL: the identical remedy applied to R (the raiser, never the
  // diverted occupant) already survived a reboot BEFORE this card's own fix — pins that this card did
  // not change R's own, already-correct clear-by-path behavior.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p2r-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p2r"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    inject.restore();
  }
  activeMergeQuarantineFor(r);

  const clearResult = clearMergeQuarantineByRecordedPath(r);
  check("(p2r control) clear-by-path(r) reports success", clearResult?.wasQuarantined === true);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p2r control) r's own token is lifted IN-PROCESS", !tokensAfterClear.has(rToken));
  check("(p2r control) d's own token is UNAFFECTED by r's clear", tokensAfterClear.has("d-token-p2r"));

  const freshP2r = await freshBootModule();
  freshP2r.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP2r = new Set(freshP2r.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p2r control, reboot) r's own token does NOT come back (already correct pre-fix)", !freshTokensP2r.has(rToken));
  check("(p2r control, reboot) d's own token SURVIVES, unaffected by r's clear", freshTokensP2r.has("d-token-p2r"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 95ea8d3f ("95ea8d3f-adversarial") — the SAME shape as p2d, but `final`'s own physical content
  // ALSO carries a token NOT covered by d's own in-memory candidate tokens (a still-owed token this
  // clear must never silently destroy). The fix's content-containment proof must correctly refuse to
  // settle the mark here, keeping `final` on disk exactly as the pre-existing fail-closed behavior did.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p2adv-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-adv"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectPersistentReadFailure(finalPath);
  try {
    enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    inject.restore();
  }
  activeMergeQuarantineFor(r);

  // `final`'s own physical bytes now ALSO carry a token not covered by d's own in-memory tokens (a
  // separate, still-owed token this clear must never destroy as collateral).
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-adv", "r-extra-token-adv"],
  }, null, 2) + "\n");

  clearMergeQuarantineByRecordedPath(d);
  check("(adversarial) final is KEPT on disk (coverage NOT proven — a real token is uncovered)", fs.existsSync(finalPath));
  check("(adversarial) final's own bytes are byte-for-byte unchanged", (contentIfExists(finalPath) ?? "").includes("r-extra-token-adv"));

  const freshAdv = await freshBootModule();
  freshAdv.reenterMergeQuarantinesAtBoot([]);
  const freshTokensAdv = new Set(freshAdv.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(adversarial, reboot) the still-owed token SURVIVES (never destroyed as collateral)", freshTokensAdv.has("r-extra-token-adv"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (Code Review c9af122d, CRITICAL FAIL-OPEN REGRESSION in d78087d4) — CARD 95ea8d3f
  // ("95ea8d3f-r2-shared") — the CR's own repro, ported verbatim. `d78087d4`'s own round-1 fix let a
  // proven-coverage override skip `physicalOwnerRepoPaths` ENTIRELY — including its pending-sourceFile
  // half. A corrupt/unparsable latch at ONE degraded hash can be diverted ONCE PER CLAIMANT (card
  // 882d6cff): d1 and d2 are two DISTINCT, genuinely-pending identities sharing ONE physical sourceFile,
  // with nothing in the file's own (unparseable) content to tell them apart. Clearing d1 alone used to
  // unlink the shared file outright, destroying d2's own only backing as collateral.
  //
  // THE FIX: `sweepOwnLatchFileUnlessOwnedElsewhere`'s proven-coverage override now ALSO checks
  // `survivingSharedClaimRepoPaths` (a surviving pending entry's own sourceFile, or any entry's
  // orphanLatchFiles) before ever bypassing the ownership check — never overridden by content coverage.
  // `markedFinalFullyCoveredByClear` also no longer counts corrupt/unparsable content as "covered".
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("r2shared-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d1 = path.join(r, "gone-a");
  const d2 = path.join(r, "gone-b");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, "{ this is not json");

  // Step 3: both d1, d2 unresolvable -> TWO pure-pending placeholders, both sourceFile=Krhash.json.
  reenterMergeQuarantinesAtBoot([d1, d2]);
  check("(r2-shared precondition) both d1 and d2 are pending, sharing the corrupt sourceFile",
    listActiveMergeQuarantines().filter((q) => q.repoPath === d1 || q.repoPath === d2).length === 2);
  const d1Token = listActiveMergeQuarantines().find((q) => q.repoPath === d1)?.tokens?.[0];
  const d2Token = listActiveMergeQuarantines().find((q) => q.repoPath === d2)?.tokens?.[0];
  check("(r2-shared precondition) d1's and d2's own tokens were captured", !!d1Token && !!d2Token);

  // Step 4: r raises over the shared corrupt key, unreadable throughout -> diverts to its OWN
  // pending-divert file (never touching `final`), and marks `final`'s basename kept-unreadable.
  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over the shared corrupt key, unreadable throughout");
  } finally {
    inject.restore(); // Step 5's own clear runs with reads restored
  }

  // Step 5: clear d1 by recorded path. *** THE FIX *** must keep `final` — d2 still needs it.
  const clearResult = clearMergeQuarantineByRecordedPath(d1);
  check("*** THE FIX (r2-shared) *** final is KEPT (d2's own surviving claim, never bypassed by coverage)", fs.existsSync(finalPath));
  // Note: `final` is CORRUPT, so `markedFinalFullyCoveredByClear` cannot prove coverage at all (Rule 2)
  // and this takes the early "mark not settled" return — kept, but with no repoPath to name (the nitpick-4
  // anyKeptUnattributed bucket), never the sharedClaimants-naming bucket (that's r2-ddpath's own shape,
  // reached through deleteMergeQuarantineLatchByKey's own UNCONDITIONAL survivingSharedClaimRepoPaths check).
  check("*** THE FIX (r2-shared) *** the clear reports latchKept (kept, even with no repoPath to name)", clearResult?.latchKept === true);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(r2-shared) d1's own token is lifted IN-PROCESS", !tokensAfterClear.has(d1Token));
  check("(r2-shared) d2's own token is UNAFFECTED by d1's clear", tokensAfterClear.has(d2Token));
  check("(r2-shared) r's own raise is unaffected", tokensAfterClear.has(rToken));

  // Step 6: fresh-import reboot, re-registering both d1 and d2. d2's own token is NOT expected to be
  // byte-identical across boots — it is a GENERIC placeholder (nothing usable was ever parsed), so each
  // boot mints a fresh randomUUID() to represent "still fail-closed quarantined here"; what matters is
  // that d2's own IDENTITY (and its physical backing) survives, never destroyed as collateral.
  const freshShared = await freshBootModule();
  freshShared.reenterMergeQuarantinesAtBoot([d1, d2]);
  const freshList = freshShared.listActiveMergeQuarantines();
  check("*** THE FIX (r2-shared, reboot) *** d2 SURVIVES the reboot (never destroyed as collateral)", freshList.some((q) => q.repoPath === d2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (Manager ruling point 3) — CARD 95ea8d3f ("95ea8d3f-r2-ddpath") — the SAME shared-corrupt-
  // latch, two-claimant shape as r2-shared above, but reached through `deleteMergeQuarantineLatchByKey`'s
  // own `provenCoverage` (the `dd34da46` path) instead of `sweepOwnLatchFileUnlessOwnedElsewhere`'s.
  //
  // d1 is made RESOLVABLE (a bare directory, no own `.git` — its canonicalRepoLockKey still walks up to
  // r's own real key) and then QUERIED while `final` is unreadable: the graduation write is REFUSED, but
  // (per the pre-existing "non-raise, unreadable -> arm unchanged, treat write as refused" rule) d1 is
  // armed IN-MEMORY anyway, with `armedKeys=[Kr]` — `final` itself is NEVER touched (still corrupt), and
  // its basename is marked kept-unreadable. d2 stays a separate, pure-pending placeholder sharing the
  // SAME sourceFile. Clearing d1 (now ACTIVE) reaches `clearMergeQuarantineByKey` ->
  // `deleteMergeQuarantineLatchByKey`, whose own `provenCoverage` (pre-fix: corrupt counted as "covered")
  // used to unlink `final` outright, destroying d2's only backing.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("r2ddpath-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d1 = path.join(r, "gone-a");
  const d2 = path.join(r, "gone-b");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, "{ this is not json");
  reenterMergeQuarantinesAtBoot([d1, d2]);
  const d2TokenDd = listActiveMergeQuarantines().find((q) => q.repoPath === d2)?.tokens?.[0];
  check("(r2-ddpath precondition) d2's own token was captured", !!d2TokenDd);

  fs.mkdirSync(d1, { recursive: true }); // bare dir, no own .git -> still walks up to Kr

  const injectDd = injectPersistentReadFailure(finalPath);
  let d1Active;
  try {
    d1Active = activeMergeQuarantineFor(d1); // graduation write refused, d1 armed anyway (armedKeys=[Kr])
  } finally {
    injectDd.restore();
  }
  check("(r2-ddpath precondition) d1 is now ACTIVE (armedKeys set)", (d1Active?.armedKeys ?? []).length > 0);
  check("(r2-ddpath precondition) final is still physically corrupt (write refused)", contentIfExists(finalPath) === "{ this is not json");

  const clearResultDd = clearMergeQuarantineByRecordedPath(d1);
  check("*** THE FIX (r2-ddpath) *** final is KEPT (d2's own surviving claim, never bypassed by deleteMergeQuarantineLatchByKey's own coverage)", fs.existsSync(finalPath));
  check("*** THE FIX (r2-ddpath) *** the clear reports latchKept, naming d2", clearResultDd?.latchKept === true && (clearResultDd?.referencingRepoPaths ?? []).includes(d2));
  const tokensAfterClearDd = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(r2-ddpath) d2's own token is UNAFFECTED by d1's clear", tokensAfterClearDd.has(d2TokenDd));

  // Remove the bare dir before rebooting — otherwise d1's own now-resolvable (but still-degraded) hash
  // would hijack boot's claimant grouping away from d2 entirely (an artifact of this live-process test,
  // not something this card's fix touches): `matchedRepo` wins over the unresolved-claimants list
  // unconditionally, so d1 "winning" the hash would mean d2 is never even considered as a claimant.
  fs.rmdirSync(d1);
  const freshDd = await freshBootModule();
  freshDd.reenterMergeQuarantinesAtBoot([d1, d2]);
  const freshListDd = freshDd.listActiveMergeQuarantines();
  // d2's own token is NOT expected to be byte-identical across boots (a generic placeholder mints a
  // fresh randomUUID() each boot — see r2-shared's own note above); its IDENTITY surviving is what matters.
  check("*** THE FIX (r2-ddpath, reboot) *** d2 SURVIVES the reboot", freshListDd.some((q) => q.repoPath === d2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (Manager ruling point 4, nitpick) — CARD 95ea8d3f ("95ea8d3f-r2-eperm") — an unconfirmed
  // unlink (EPERM/EBUSY) inside `sweepOwnLatchFileUnlessOwnedElsewhere`'s own proven-coverage branch must
  // surface as KEPT, never as plain success — the file is still physically there.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("r2eperm-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-eperm"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const injectRead = injectPersistentReadFailure(finalPath);
  let rTokenEperm;
  try {
    rTokenEperm = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    injectRead.restore();
  }

  // Proven-coverage would otherwise license the unlink (final genuinely holds only d's own token) — but
  // the unlink itself fails with EPERM.
  const injectUnlink = injectUnlinkFailureForPath(finalPath);
  let clearResultEperm;
  let threwEperm = false;
  try {
    clearResultEperm = clearMergeQuarantineByRecordedPath(d);
  } catch {
    threwEperm = true;
  } finally {
    injectUnlink.restore();
  }
  check("*** THE FIX (r2-eperm) *** nothing throws even though the unlink fails", !threwEperm);
  check("(r2-eperm) the injected unlink failure was actually attempted", injectUnlink.count() >= 1);
  check("*** THE FIX (r2-eperm) *** final is STILL on disk (unconfirmed unlink)", fs.existsSync(finalPath));
  check("*** THE FIX (r2-eperm) *** the clear surfaces latchKept — NEVER plain success — on an unconfirmed unlink",
    clearResultEperm?.latchKept === true);
  const freshEperm = await freshBootModule();
  freshEperm.reenterMergeQuarantinesAtBoot([]);
  const freshTokensEperm = new Set(freshEperm.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(r2-eperm, reboot) d's own token — backed only by the kept final — survives (unconfirmed unlink keeps the mark set)", freshTokensEperm.has("d-token-eperm"));
  check("(r2-eperm, reboot) r's own raise also survives", freshTokensEperm.has(rTokenEperm));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Code Review 4e500b66 of 8b9e3451, Major FAIL-CLOSED REGRESSION) — CARD 95ea8d3f
  // ("95ea8d3f-r3-orphanref") — the reviewer's own repro, ported verbatim. Round 2's own
  // `survivingSharedClaimRepoPaths` treated ANY entry's `orphanLatchFiles` naming a file as a veto — but
  // PASS 2's own "an unmatched orphan latch is broadcast onto EVERY registered repo's own
  // `orphanLatchFiles`" mechanism (so a human can eventually clear it) means A's own entry can list B's
  // physical file purely DEFENSIVELY, with NO genuine structural dependency on it at all — this is
  // exactly `9cabd143`'s own forbidden "another entry's orphanLatchFiles merely LISTING filename" shape.
  // THE FIX: an orphan hit counts ONLY when that SAME entry's own `sourceFile` ALSO equals `filename`
  // (a genuine self-reference) — A's own entry has no `sourceFile` pointing at B's file at all.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const A = makeToplevelRepo("r3orphanref-A");
  const B = makeToplevelRepo("r3orphanref-B");
  const KB = canonicalRepoLockKey(B);
  const KBhash = createHash("sha256").update(KB).digest("hex").slice(0, 24);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const bFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KBhash}.json`);
  // Step 1: corrupt content at B's own real hash.
  fs.writeFileSync(bFinalPath, "{not valid json");
  // Step 2: boot with ONLY A registered — A is unrelated to B's hash, so the corrupt file falls into
  // PASS 2's "no registered repo matches this hash" orphan bucket and gets broadcast into A's own
  // orphanLatchFiles (card 9a55fb90/882d6cff-era PASS 2, round 7 M2).
  reenterMergeQuarantinesAtBoot([A]);
  check("(r3-orphanref precondition) A's own entry now names B's file in its orphanLatchFiles",
    (listActiveMergeQuarantines().find((q) => q.repoPath === A)?.orphanLatchFiles ?? []).includes(`${KBhash}.json`));

  // Step 3: B raises for real — the corrupt content at KBhash.json is "nothing usable," so the write
  // proceeds and durably overwrites it with B's own real latch.
  const bToken = enterMergeQuarantine(B, "b-branch", "b raises for real");
  check("(r3-orphanref precondition) B's own real latch is now durably at KBhash.json",
    (contentIfExists(bFinalPath) ?? "").includes(bToken));

  // Step 4: clear B.
  const clearResultOrphanref = clearMergeQuarantineByRecordedPath(B);
  check("*** THE FIX (r3-orphanref) *** clearing B reports plain success — A's own broadcast orphan reference never vetoes it",
    clearResultOrphanref?.wasQuarantined === true && !clearResultOrphanref?.latchKept);
  check("*** THE FIX (r3-orphanref) *** B's own final is actually unlinked", !fs.existsSync(bFinalPath));
  check("(r3-orphanref) B's own token is lifted IN-PROCESS", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(bToken));

  // Step 5: fresh-import reboot, registering both A and B.
  const freshOrphanref = await freshBootModule();
  freshOrphanref.reenterMergeQuarantinesAtBoot([A, B]);
  const freshListOrphanref = freshOrphanref.listActiveMergeQuarantines();
  // This file runs MANY scenarios in one process, sharing one MERGE_QUARANTINE_DIR — by the time this
  // fresh-import reboot runs, some OTHER, wholly unrelated scenario's own leftover corrupt/safety-tmp
  // residue can ALREADY be sitting in that shared directory, and PASS 2's own broadcast mechanism (the
  // very thing this card's fix is about) attaches ANY such unmatched orphan onto EVERY registered repo —
  // including B, incidentally, for a reason that has nothing to do with B's own real quarantine. So
  // "does B show up at all" is not the discriminating check here (and would flake on shared test-file
  // pollution); "is B's OWN real raise durably gone" is — asserted directly via its own token.
  check("*** THE FIX (r3-orphanref, reboot) *** B's own real token does NOT come back", !new Set(freshListOrphanref.flatMap((q) => q.tokens ?? [])).has(bToken));
  const bAfterReboot = freshListOrphanref.find((q) => q.repoPath === B);
  check("(r3-orphanref, reboot) if B shows up at all, it is NOT backed by its own real latch data",
    !bAfterReboot || bAfterReboot.reason !== "b raises for real");
  check("(r3-orphanref, reboot) A's own fail-closed orphan placeholder is unaffected", freshListOrphanref.some((q) => q.repoPath === A));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 BLOCKER repro P3b (Code Review d42418af) — the SAME double fault as item3 above, but
  // followed by an IN-PROCESS clearByToken. Pre-fix (commit c5c17d17): attemptDivertSafetyTmpFallback
  // wrote the safety-tmp but never re-pointed the pushed pending record at it (selfReference:true only
  // lands in the BYTES, not in memory) — so the clear swept only the never-written pending-<hash> file
  // (a no-op) and left the safety-tmp an untracked orphan on disk; the token survives a reboot anyway.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p3b-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p3b"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const pendingFilename = pendingDivertFilenameForTest(r);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFilename);
  const injectRead = injectPersistentReadFailure(finalPath);
  const injectWrite = injectOpenSyncFailureForPrefix(pendingPath);
  let t;
  try {
    t = enterMergeQuarantine(r, "r-branch", "r raises over D's own key; BOTH the read AND the divert's own pending write fail");
  } finally {
    injectRead.restore();
    injectWrite.restore();
  }
  check("(p3b precondition) t persists IN-PROCESS after the double fault", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t));
  check("(p3b precondition) the ORIGINAL pending-divert file was NEVER actually written", !fs.existsSync(pendingPath));
  const safetyTmpFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${Krhash}.json.tmp-safety-`));
  check("(p3b precondition) a safety-tmp residue matching r's own key hash was written", safetyTmpFiles.length > 0);

  clearMergeQuarantineByToken(r, t);
  check("*** THE FIX (p3b) *** t is lifted IN-PROCESS", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t));
  check("*** THE FIX (p3b) *** the safety-tmp residue is actually SWEPT (never an untracked orphan) by the clear",
    !safetyTmpFiles.some((f) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, f))));

  const freshP3b = await freshBootModule();
  freshP3b.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP3b = new Set(freshP3b.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3b, reboot) *** t does NOT come back after a reboot", !freshTokensP3b.has(t));
  check("(p3b, reboot) d's own unrelated token still survives", freshTokensP3b.has("d-token-p3b"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 BLOCKER repro P3g (Code Review d42418af, the `merged` branch) — t1 diverts normally (its
  // own pending-divert file is actually written); t2's OWN divert then merges into t1's existing
  // pending record, but THAT rewrite fails. Pre-fix: the safety-tmp fallback wrote `[t1,t2]` to a NEW
  // file but never re-pointed the in-memory record at it — releasing both tokens in-process swept only
  // the STALE pending-<hash> file (still holding just t1, untouched by the failed rewrite) and left the
  // safety-tmp an untracked orphan; both tokens survive a reboot anyway.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p3g-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p3g"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const pendingFilename = pendingDivertFilenameForTest(r);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFilename);

  // t1 diverts NORMALLY — only the read fails; the pending-divert write itself succeeds.
  const injectRead1 = injectPersistentReadFailure(finalPath);
  let t1;
  try {
    t1 = enterMergeQuarantine(r, "r-branch", "r's first raise — diverts normally");
  } finally {
    injectRead1.restore();
  }
  check("(p3g precondition) t1 diverted normally — its own pending-divert file was actually written",
    fs.existsSync(pendingPath) && (contentIfExists(pendingPath) ?? "").includes(t1));

  // t2's OWN divert merges into t1's existing pending record — THIS rewrite fails.
  const injectRead2 = injectPersistentReadFailure(finalPath);
  const injectWrite2 = injectOpenSyncFailureForPrefix(pendingPath);
  let t2;
  try {
    t2 = enterMergeQuarantine(r, "r-branch", "r's second raise — merges into t1's pending record, whose rewrite fails");
  } finally {
    injectRead2.restore();
    injectWrite2.restore();
  }
  const tokensAfterT2 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p3g precondition) t2 persists IN-PROCESS, merged with t1", tokensAfterT2.has(t1) && tokensAfterT2.has(t2));
  const safetyTmpFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${Krhash}.json.tmp-safety-`));
  check("(p3g precondition) a safety-tmp residue matching r's own key hash was written for the failed merge", safetyTmpFiles.length > 0);

  clearMergeQuarantineByToken(r, t1);
  clearMergeQuarantineByToken(r, t2);
  const tokensAfterClear = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3g) *** t1 is lifted IN-PROCESS", !tokensAfterClear.has(t1));
  check("*** THE FIX (p3g) *** t2 is ALSO lifted IN-PROCESS", !tokensAfterClear.has(t2));
  check("*** THE FIX (p3g) *** the safety-tmp residue is actually SWEPT (never an untracked orphan) by the clears",
    !safetyTmpFiles.some((f) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, f))));

  const freshP3g = await freshBootModule();
  freshP3g.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP3g = new Set(freshP3g.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3g, reboot) *** t1 does NOT come back after a reboot", !freshTokensP3g.has(t1));
  check("*** THE FIX (p3g, reboot) *** t2 does NOT come back after a reboot either", !freshTokensP3g.has(t2));
  check("(p3g, reboot) d's own unrelated token still survives", freshTokensP3g.has("d-token-p3g"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Code Review 765f5453, Minor 1, "dd34da46-p3g-v1") — pins the `base.sourceFile` sweep
  // (`sweepOwnLatchFileUnlessOwnedElsewhere`) in `divertRaiseEntry`'s merge-into-existing-pending
  // fallback branch. The COMMITTED p3g scenario above releases BOTH tokens, which passes even WITHOUT
  // that sweep call — a full (last-token) clear's own `orphanFilesToSweep` loop (in what is now
  // `clearTokenFromPendingIndices`) already sweeps every `orphanLatchFiles` entry (which includes
  // `base.sourceFile`, folded in alongside the safety-tmp basename) once nothing remains outstanding.
  // A PARTIAL release — exactly this scenario — never reaches that loop at all. At the time this test was
  // written the partial-clear branch only rewrote `pending.sourceFile` (the safety-tmp) and never looked
  // at `orphanLatchFiles` at all; card `6c04633d` later added an OWNERSHIP-GATED orphan rewrite to that
  // same branch, but it only ever REWRITES a file it can positively confirm is this same entity's own —
  // it still never SWEEPS (deletes) one, so `base.sourceFile`'s own STALE bytes (still holding only t1,
  // never rewritten since that rewrite is what failed) still survive on disk, untracked, until the
  // explicit sweep at write time removes them.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p3g-v1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p3g-v1"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const pendingFilename = pendingDivertFilenameForTest(r);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFilename);

  // t1 diverts NORMALLY — only the read fails; the pending-divert write itself succeeds.
  const injectRead1 = injectPersistentReadFailure(finalPath);
  let t1;
  try {
    t1 = enterMergeQuarantine(r, "r-branch", "r's first raise — diverts normally");
  } finally {
    injectRead1.restore();
  }
  check("(p3g-v1 precondition) t1 diverted normally — its own pending-divert file was actually written",
    fs.existsSync(pendingPath) && (contentIfExists(pendingPath) ?? "").includes(t1));

  // t2's OWN divert merges into t1's existing pending record — THIS rewrite fails.
  const injectRead2 = injectPersistentReadFailure(finalPath);
  const injectWrite2 = injectOpenSyncFailureForPrefix(pendingPath);
  let t2;
  try {
    t2 = enterMergeQuarantine(r, "r-branch", "r's second raise — merges into t1's pending record, whose rewrite fails");
  } finally {
    injectRead2.restore();
    injectWrite2.restore();
  }
  const tokensAfterT2 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p3g-v1 precondition) t2 persists IN-PROCESS, merged with t1", tokensAfterT2.has(t1) && tokensAfterT2.has(t2));
  // The explicit sweep (the very call V1 exists to pin) runs PROACTIVELY, right when the safety-tmp
  // fallback succeeds during t2's own divert — well before any clear. On the fixed code this file is
  // already gone by this point; without the sweep it would still be sitting here, stale, until a full
  // (never a partial) release's own orphan-sweep loop happened to reach it — which this scenario's own
  // partial-release-only shape never triggers, which is exactly the gap this test pins.
  check("*** THE FIX (p3g-v1) *** the STALE original pending-divert file is ALREADY swept proactively (never left for a clear to find)", !fs.existsSync(pendingPath));

  // Release t1 ONLY — a PARTIAL clear, never reaching the full/last-token sweep loop.
  clearMergeQuarantineByToken(r, t1);
  const tokensAfterT1Release = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(p3g-v1) t1 is lifted IN-PROCESS", !tokensAfterT1Release.has(t1));
  check("*** THE FIX (p3g-v1) *** t2 is STILL enforced IN-PROCESS after releasing only t1", tokensAfterT1Release.has(t2));

  const freshP3gV1 = await freshBootModule();
  freshP3gV1.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP3gV1 = new Set(freshP3gV1.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3g-v1, reboot) *** t1 does NOT come back after a reboot", !freshTokensP3gV1.has(t1));
  check("*** THE FIX (p3g-v1, reboot) *** t2 is STILL enforced after a reboot", freshTokensP3gV1.has(t2));
  check("(p3g-v1, reboot) d's own unrelated token still survives", freshTokensP3gV1.has("d-token-p3g-v1"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, REPRO A — a surviving ACTIVE entry's token can still physically live in `final` with
  // NOTHING structural (no orphanLatchFiles/sourceFile) pointing at it from the CLEARER's own side: D
  // graduates to ACTIVE at ITS OWN key Kd (its graduation write there failed, so its only durable
  // backing stays at R's own key's physical file, Krhash.json, folded into D's own orphanLatchFiles). A
  // LATER clearMergeQuarantine(r), finding NOTHING armed at Kr at all (`entry` undefined), used to run
  // deleteMergeQuarantineLatchByKey with no token-overlap backstop whatsoever, unlinking Krhash.json
  // outright and losing d-token for good.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("carda-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-carda"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // A clear of r, with D's own pending-divert write failing — D is kept as a self-owned pending, with
  // sourceFile = Krhash.json (`final` itself, untouched).
  const dPendingFile = pendingDivertFilenameForTest(d);
  const dPendingPath = path.join(MERGE_QUARANTINE_DIR, dPendingFile);
  const injectWrite = injectOpenSyncFailureForPrefix(dPendingPath);
  try {
    clearMergeQuarantineReporting(r);
  } finally {
    injectWrite.restore();
  }
  check("(carda precondition) D is kept as a self-owned pending entry", listActiveMergeQuarantines().some((q) => q.repoPath === d));
  check("(carda precondition) final is untouched", (contentIfExists(finalPath) ?? "").includes("d-token-carda"));

  // Make r/gone-subdir its own real git repo — D becomes resolvable, at its OWN key Kd != Kr.
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), "# d\n");
  execSync(`git init -q && git config user.email mqrpf@loom && git config user.name mqrpf`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  const Kd = canonicalRepoLockKey(d);
  check("(carda precondition) D's own key now differs from R's", Kd !== Kr);

  // Query D — lazy graduation to ACTIVE at Kd, but the write there fails; D's only durable backing
  // stays at Krhash.json (folded into D's own orphanLatchFiles), and its pending twin is consumed.
  const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
  const kdFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);
  const injectKdWrite = injectOpenSyncFailureForPrefix(kdFinalPath);
  let dActive;
  try {
    dActive = activeMergeQuarantineFor(d);
  } finally {
    injectKdWrite.restore();
  }
  check("(carda precondition) D is now ACTIVE, armed at its own key", (dActive?.armedKeys ?? []).includes(Kd));
  check("(carda precondition) D's own orphanLatchFiles still names Krhash.json", (dActive?.orphanLatchFiles ?? []).includes(`${Krhash}.json`));
  check("(carda precondition) final is STILL physically untouched (Kd's own write failed)", (contentIfExists(finalPath) ?? "").includes("d-token-carda"));

  // r has NO quarantine of its own at Kr at all.
  const clearResultCardA = clearMergeQuarantine(r);
  check("*** THE FIX (carda) *** final SURVIVES — a surviving active entry (D) still holds its own token physically there", fs.existsSync(finalPath));
  check("*** THE FIX (carda) *** the clear reports latchKept, naming D", clearResultCardA?.latchKept === true && (clearResultCardA?.referencingRepoPaths ?? []).includes(d));
  check("(carda) d-token is STILL enforced in-process", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-carda"));

  // Fresh-import reboot — measure the TOKEN directly, never assertRepoNotQuarantined.
  const freshCardA = await freshBootModule();
  freshCardA.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (carda, reboot) *** d-token survives a fresh-import reboot", new Set(freshCardA.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-carda"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, REPRO B(a) — `mergeTokenIntoPendingEntries` unconditionally overwrote its own
  // `sourceFile` when merging a fresh token into a still-unresolvable repoPath's own pending entry —
  // never checking whether a DIFFERENT, surviving placeholder (882d6cff's shared-corrupt-latch shape)
  // also depends on that EXACT sourceFile. d1's own raise used to overwrite F with valid content for
  // d1 alone, destroying d2's only backing with no clear at all.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("cardba-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d1 = path.join(r, "gone-a");
  const d2 = path.join(r, "gone-b");

  // This file runs many scenarios sharing one MERGE_QUARANTINE_DIR — a 882d6cff shared-corrupt-latch
  // repro is sensitive to an unrelated, earlier scenario's own leftover orphan residue (PASS 2 broadcasts
  // any unmatched orphan onto every registered repo). Reset to a clean directory first, same pattern as
  // merge-quarantine-migrate-source-owner-durable.mjs's own hard reset.
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, "{ this is not json");

  // d1 and d2 both unresolvable -> TWO pure-pending placeholders, both sourceFile=Krhash.json.
  reenterMergeQuarantinesAtBoot([d1, d2]);
  check("(cardba precondition) both d1 and d2 are pending placeholders, sharing the corrupt sourceFile",
    listActiveMergeQuarantines().filter((q) => (q.repoPath === d1 || q.repoPath === d2) && q.placeholder).length === 2);

  // d1 raises while STILL unresolvable, no injection at all — the ordinary, un-mocked path
  // mergeTokenIntoPendingEntries takes.
  const t1Ba = enterMergeQuarantine(d1, "d1-branch", "d1 raises while still unresolvable, sharing F with d2");
  check("*** THE FIX (cardba) *** F's own corrupt content is UNCHANGED — d1's raise never overwrote it", contentIfExists(finalPath) === "{ this is not json");
  check("(cardba) d1's own raise still persists in-process", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t1Ba));

  // Fresh-import reboot — d2's own token is NOT expected byte-identical (a generic placeholder mints a
  // fresh randomUUID() per boot, since nothing usable was ever parsed); its own IDENTITY surviving,
  // never destroyed as collateral, is what this fix guarantees.
  const freshBa = await freshBootModule();
  freshBa.reenterMergeQuarantinesAtBoot([d1, d2]);
  check("*** THE FIX (cardba, reboot) *** d2 SURVIVES the reboot (never destroyed as collateral)", freshBa.listActiveMergeQuarantines().some((q) => q.repoPath === d2));
  // d1's own diverted raise persists too (e1cb7d33) — unlike d2's own generic placeholder, this is a
  // REAL write (divertRaiseEntry's own pending-divert file, genuine content) so t1Ba itself survives
  // byte-identically, never a freshly-minted stand-in.
  check("(cardba, reboot) d1's own diverted raise ALSO survives (e1cb7d33)", new Set(freshBa.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(t1Ba));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, REPRO B(b) — shape A above, continued: once D graduates to ACTIVE at its own key
  // (its graduation write there having failed, so its ONLY durable backing stays at R's own key's
  // physical file), a LATER fresh raise of R itself used to reach `differentUnresolvableOccupantRepoPathAt`'s
  // own "different identity, but currently RESOLVABLE -> none" shortcut and overwrite D's only
  // physical backing outright — losing d-token with no clear at all.
  //
  // THE FIX makes that branch content-aware: finding d-token still held by D's own surviving entry, it
  // classifies D as a genuine occupant to protect — `protectOccupantContentBeforeDelete` durably
  // relocates D's content to its own pending-divert file BEFORE r's write proceeds (the SAME
  // protect-then-overwrite pattern shape 1's own positive control already exercises) — never that
  // `final`'s bytes stay byte-for-byte unchanged; D's token is simply never lost.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("cardbb-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-cardbb"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const dPendingFileBb = pendingDivertFilenameForTest(d);
  const dPendingPathBb = path.join(MERGE_QUARANTINE_DIR, dPendingFileBb);
  const injectWriteBb = injectOpenSyncFailureForPrefix(dPendingPathBb);
  try {
    clearMergeQuarantineReporting(r);
  } finally {
    injectWriteBb.restore();
  }

  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), "# d\n");
  execSync(`git init -q && git config user.email mqrpf@loom && git config user.name mqrpf`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  const Kd = canonicalRepoLockKey(d);
  const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
  const kdFinalPathBb = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);
  const injectKdWriteBb = injectOpenSyncFailureForPrefix(kdFinalPathBb);
  try {
    activeMergeQuarantineFor(d);
  } finally {
    injectKdWriteBb.restore();
  }
  check("(cardbb precondition) final is STILL D's own content (Kd's own graduation write failed)", (contentIfExists(finalPath) ?? "").includes("d-token-cardbb"));

  // r raises fresh — NO injection at all. `differentUnresolvableOccupantRepoPathAt`'s own "different,
  // but currently resolvable identity" branch is reached (D is now resolvable).
  const rTokenBb = enterMergeQuarantine(r, "r-branch", "r raises fresh, no injection");
  const tokensAfterRaiseBb = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (cardbb) *** d-token is NEVER LOST — D's content was durably protected before r's write proceeded", tokensAfterRaiseBb.has("d-token-cardbb"));
  check("(cardbb) r's own raise persists too", tokensAfterRaiseBb.has(rTokenBb));

  const freshBb = await freshBootModule();
  freshBb.reenterMergeQuarantinesAtBoot([]);
  const freshTokensBb = new Set(freshBb.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (cardbb, reboot) *** d-token SURVIVES", freshTokensBb.has("d-token-cardbb"));
  check("*** THE FIX (cardbb, reboot) *** r's own raise ALSO survives (e1cb7d33)", freshTokensBb.has(rTokenBb));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, Code Review item 2 — corrects 95ea8d3f Round 3's own "the sweep-path structural
  // veto is DEFENSIVE-ONLY — structurally unreachable as the discriminating keep reason" claim: FALSE,
  // empirically. `markedFinalFullyCoveredByClear` treats an EMPTY on-disk token array as VACUOUSLY
  // "covered" — and valid, parseable JSON that is simply missing `repoPath`/`branch`/`reason` is ALSO
  // what PASS 1's own boot classification treats as "corrupt" (so d1/d2 still become genuine 882d6cff
  // placeholders) — so `sweepOwnLatchFileUnlessOwnedElsewhere`'s own proven-coverage branch CAN reach
  // `survivingSharedClaimRepoPaths`, and that veto IS what keeps the file, naming the surviving sibling.
  //
  // NO CODE CHANGE here — `survivingSharedClaimRepoPaths`/`markedFinalFullyCoveredByClear` are
  // PRE-EXISTING (card 95ea8d3f), untouched by this card. This scenario is GREEN on the parent too —
  // it pins already-correct behavior and corrects the record's own wrong claim about it, mirroring
  // `dd34da46-item2`'s own "no RED state exists to demonstrate since no source line changed" shape.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("crnit2-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d1 = path.join(r, "gone-a");
  const d2 = path.join(r, "gone-b");

  // Hard reset — same reason as cardba above: an unrelated scenario's own leftover orphan residue
  // would otherwise get broadcast onto d1/d2 by PASS 2, and this repro's own discriminating check
  // depends on `final`'s content being EXACTLY `{}` when the clear runs.
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, "{}"); // valid JSON, but missing repoPath/branch/reason/tokens

  reenterMergeQuarantinesAtBoot([d1, d2]);
  check("(crnit2 precondition) both d1 and d2 are pending placeholders, sharing the sourceFile",
    listActiveMergeQuarantines().filter((q) => (q.repoPath === d1 || q.repoPath === d2) && q.placeholder).length === 2);

  // r raises over the shared key while F is unreadable — marks F's basename kept-unreadable, then
  // diverts (never touching F); reads restore for the clear that follows.
  const injectNit2 = injectPersistentReadFailure(finalPath);
  try {
    enterMergeQuarantine(r, "r-branch", "r raises over the shared key, unreadable throughout");
  } finally {
    injectNit2.restore();
  }
  check("(crnit2 precondition) F's own content is still physically {} (never touched by r's divert)", contentIfExists(finalPath) === "{}");

  const clearResultNit2 = clearMergeQuarantineByRecordedPath(d1);
  check("(crnit2) final is KEPT", fs.existsSync(finalPath));
  // The discriminating check: `latchKept` with a NON-EMPTY referencingRepoPaths naming d2 can ONLY come
  // from `survivingSharedClaimRepoPaths`'s own placeholder-sourceFile veto (markedFinalFullyCoveredByClear
  // vacuously proves "coverage" for an empty on-disk token array, so provenCoverage alone would otherwise
  // have licensed the unlink) — never the generic, unattributed "could not be confirmed covered" bucket.
  // Pre-existing behavior (95ea8d3f) — passes identically on the parent, unaffected by this card.
  check("(crnit2) the sweep-path veto itself (not the generic unattributed-kept bucket) names d2",
    clearResultNit2?.latchKept === true && (clearResultNit2?.referencingRepoPaths ?? []).includes(d2));

  const freshNit2 = await freshBootModule();
  freshNit2.reenterMergeQuarantinesAtBoot([d1, d2]);
  check("(crnit2, reboot) d2 SURVIVES the reboot (never destroyed as collateral)", freshNit2.listActiveMergeQuarantines().some((q) => q.repoPath === d2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, Round 2 (Code Review 582ce5a9) — a two-path asymmetry: Round 1 relaxed
  // `differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ safe" shortcut, but
  // `resolveRaiseOverwrite`'s OWN independent slow-path re-read of the SAME shortcut (today's
  // `isRepoPathCurrentlyResolvable(parsed.repoPath)) return false`) was untouched — reachable on a
  // DOUBLE FAULT: the detector flags D (Round 1's own fix), but D's own protect-copy write ALSO fails,
  // so `protectOccupantContentBeforeDelete` keeps `final` as D's self-owned pending (no durable copy
  // elsewhere) and returns `false` — `resolveRaiseOverwrite` then re-reads `final` itself, sees D is
  // resolvable, and (pre-this-round) blindly proceeds, overwriting D's only physical backing anyway.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("p3-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-p3"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Repro A steps 1-5 (carda's own setup): D kept as a self-owned pending via a failed divert write,
  // then graduates to ACTIVE at its own key Kd (graduation write there ALSO fails).
  const dPendingFile = pendingDivertFilenameForTest(d);
  const dPendingPath = path.join(MERGE_QUARANTINE_DIR, dPendingFile);
  const injectWriteP3a = injectOpenSyncFailureForPrefix(dPendingPath);
  try {
    clearMergeQuarantineReporting(r);
  } finally {
    injectWriteP3a.restore();
  }
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), "# d\n");
  execSync(`git init -q && git config user.email mqrpf@loom && git config user.name mqrpf`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  const Kd = canonicalRepoLockKey(d);
  const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
  const kdFinalPathP3 = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);
  const injectKdWriteP3 = injectOpenSyncFailureForPrefix(kdFinalPathP3);
  try {
    activeMergeQuarantineFor(d);
  } finally {
    injectKdWriteP3.restore();
  }
  check("(p3 precondition) final is STILL D's own content (Kd's own graduation write failed)", (contentIfExists(finalPath) ?? "").includes("d-token-p3"));

  // Step 2: r raises while D's OWN protect-copy write ALSO fails (a double fault) — the detector flags
  // D (Round 1's own fix), but the copy-aside has nowhere durable to land, so `final` stays D's only
  // physical backing and `protectOk` comes back `false`.
  const injectDPendingP3 = injectOpenSyncFailureForPrefix(dPendingPath);
  let rTokenP3;
  try {
    rTokenP3 = enterMergeQuarantine(r, "r-branch", "r raises; D's own protect-copy write ALSO fails (double fault)");
  } finally {
    injectDPendingP3.restore();
  }
  check("*** THE FIX (p3) *** final is NEVER overwritten — D's own content survives byte-for-byte (double fault diverts, never proceeds)",
    (contentIfExists(finalPath) ?? "").includes("d-token-p3"));
  check("(p3) r's own raise persists too (diverted)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(rTokenP3));

  // Step 5: clear r — lifts r's own (diverted) raise; D's own self-owned pending keeps `final`.
  const clearResultP3 = clearMergeQuarantine(r);
  check("(p3) the clear reports latchKept, naming D", clearResultP3?.latchKept === true && (clearResultP3?.referencingRepoPaths ?? []).includes(d));

  // Step 6: fresh-import reboot — the card's own discriminating check: d-token survives, r's own
  // CLEARED token does NOT resurrect (it cleared cleanly on the parent commit too; this round's own
  // fix must not reopen that).
  const freshP3 = await freshBootModule();
  freshP3.reenterMergeQuarantinesAtBoot([]);
  const freshTokensP3 = new Set(freshP3.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (p3, reboot) *** d-token SURVIVES", freshTokensP3.has("d-token-p3"));
  check("*** THE FIX (p3, reboot) *** r's own CLEARED token does NOT resurrect", !freshTokensP3.has(rTokenP3));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 0dc514dc, Round 2 open question — a two-path SIDE EFFECT of Round 1's own content check:
  // `differentUnresolvableOccupantRepoPathAt`'s "resolvable ⇒ safe" branch is shared by
  // `wouldOverwriteDifferentUnresolvableOccupant` (a NON-raise writer's own degraded-occupant guard —
  // graduation, sibling-absorb) too, not just the raise-protect path Round 1 was scoped to. Without a
  // further check, a genuinely STALE leftover of an occupant that is ALREADY durably, independently
  // backed elsewhere (its own real key, properly migrated) would be wrongly flagged "occupant" purely
  // because its OLD, stale bytes still physically carry the SAME token its OWN current record holds —
  // refusing an unrelated entity's own legitimate graduation write at that stale leftover's key.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  // D: a separate, standalone real repo. Raise it fresh — writes successfully to its OWN key Kd.
  const d = makeToplevelRepo("openq-d");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  reenterMergeQuarantinesAtBoot([]);
  const dTokenOpenq = enterMergeQuarantine(d, "d-branch", "D raises fresh, no injection — writes properly to Kd");
  const Kd = canonicalRepoLockKey(d);
  const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
  check("(openq precondition) D's own proper backing exists at Kdhash.json",
    (contentIfExists(path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`)) ?? "").includes(dTokenOpenq));

  // R: a DIFFERENT real repo. E = R/gone-subdir (unresolvable, walks up to Kr).
  const r = makeToplevelRepo("openq-r");
  const e = path.join(r, "gone-subdir");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const krFinalPathOpenq = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);

  // A STALE leftover of D sitting at Kr — content names D, holding D's SAME real token, even though
  // D's own CURRENT, proper backing already lives at Kd.
  fs.writeFileSync(krFinalPathOpenq, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [dTokenOpenq],
  }, null, 2) + "\n");

  // E raises while unresolvable — merges/diverts to its own disjoint pending-divert file, never
  // touching Krhash.json.
  const eTokenOpenq = enterMergeQuarantine(e, "e-branch", "e raises while unresolvable");
  check("(openq precondition) Krhash.json is STILL D's own stale leftover (e's raise never touched it)",
    (contentIfExists(krFinalPathOpenq) ?? "").includes(dTokenOpenq));

  // Make E resolvable (its own canonical key becomes Kr) and query it — lazy graduation, with the
  // degraded-occupant guard ACTIVE (skipDegradedOccupantGuard=false, unlike a raise).
  fs.mkdirSync(e, { recursive: true });
  const eActiveOpenq = activeMergeQuarantineFor(e);
  // NOT discriminating — `armedKeys` is populated unconditionally once an entry is ARMED in-memory,
  // regardless of whether the durable write itself succeeded (e1cb7d33: enforcement for this process
  // must not wait on disk I/O) — this is ALSO non-empty on f89cfbd2, where the write is refused and
  // Krhash.json stays untouched. The actual content match below is the real discriminator.
  check("(openq) e is armed in-memory either way", (eActiveOpenq?.armedKeys ?? []).length > 0);
  check("*** THE FIX (openq) *** Krhash.json now holds e's OWN content (the write durably succeeded, not merely armed in-memory)",
    (contentIfExists(krFinalPathOpenq) ?? "").includes(eTokenOpenq));
  check("(openq) D's own token is unaffected throughout", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(dTokenOpenq));

  // Reboot leg (CR2 582ce5a9/a5b84e8e) — the real failure mode this round closes is a CLEARED-TOKEN
  // RESURRECTION after reboot, not merely a refused write: clear D's own token, then reboot, and
  // confirm it does NOT come back (D's own real backing at Kd is gone — correctly, it was cleared —
  // and the stale leftover at Kr no longer exists either, since e's write legitimately overwrote it).
  clearMergeQuarantineByToken(d, dTokenOpenq);
  check("(openq) D's own token is lifted in-process after clearByToken", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(dTokenOpenq));
  const freshOpenq = await freshBootModule();
  freshOpenq.reenterMergeQuarantinesAtBoot([]);
  const freshTokensOpenq = new Set(freshOpenq.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (openq, reboot) *** D's own CLEARED token does NOT resurrect", !freshTokensOpenq.has(dTokenOpenq));
  check("(openq, reboot) e's own raise SURVIVES", freshTokensOpenq.has(eTokenOpenq));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 25f6a7dc — from the CR of 5b55149b: THREE inline token parsers in merge-quarantine.ts still
  // bypassed readSurvivingOnDiskTokens and so lacked its `length > 0` legacy-fallback fix. Reachability
  // was roughly nil (no current writer emits `tokens: []`), but one of the three FAILS OPEN:
  //
  //   ("25f6a7dc-l1318") markedFinalFullyCoveredByClear (~L1318): `[].every(...)` is vacuously true, so a
  //   marked final holding a legacy token X not in candidateTokens read as "fully covered" — unlinking a
  //   file boot recovery would have re-armed with X. THE FIX routes the coverage proof through the shared
  //   reader's RAW array, testing each on-disk token against candidateTokens OR clearedTokens (a token
  //   already deliberately released earlier THIS process) — never `.surviving` alone.
  //
  // The other two FAIL CLOSED (a redundant protect copy-aside, never data loss) — but "redundant" can
  // still mint a bogus, durably-written pending record for an unrelated identity merely because it shares
  // a degraded key, which THEN independently resurrects a token after a reboot that was already safely,
  // correctly released under its real owner's own identity:
  //
  //   ("25f6a7dc-l751") unincorporatedOccupantRepoPathAt (~L751) — the CLEAR-side twin.
  //   ("25f6a7dc-l1856") resolveRaiseOverwrite's own "already incorporated" check (~L1856) — the RAISE-side twin.
  //
  // Two further scenarios pin that this fix does NOT disturb protectOccupantContentBeforeDelete's own
  // PRE-EXISTING (7a7e041b/5b55149b) tombstone-skip and no-token-fallback behavior, reached THROUGH the
  // now-fixed sites: ("25f6a7dc-tombstoned") and ("25f6a7dc-no-token").
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  // ---- 25f6a7dc-l1318 — the FAIL-OPEN repro, same shape as 95ea8d3f-adversarial but with the still-owed
  // extra token riding the LEGACY singular `token` field behind an EMPTY `tokens` array ----
  {
  const r = makeToplevelRepo("l1318-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-l1318"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectPersistentReadFailure(finalPath);
  try {
    enterMergeQuarantine(r, "r-branch", "r raises over D's own key, unreadable throughout");
  } finally {
    inject.restore();
  }
  activeMergeQuarantineFor(r);

  // `final`'s own physical bytes now carry a DIFFERENT, still-owed token — via the LEGACY singular
  // `token` field, with `tokens` rewritten to an EMPTY array — never covered by d's own in-memory
  // tokens (["d-token-l1318"]), and never tombstoned.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [], token: "legacy-extra-token-l1318",
  }, null, 2) + "\n");

  clearMergeQuarantineByRecordedPath(d);
  check("*** THE FIX (l1318) *** final is KEPT on disk (coverage NOT proven — the legacy token is uncovered)", fs.existsSync(finalPath));
  check("(l1318) final's own bytes are byte-for-byte unchanged", (contentIfExists(finalPath) ?? "").includes("legacy-extra-token-l1318"));

  const freshL1318 = await freshBootModule();
  freshL1318.reenterMergeQuarantinesAtBoot([]);
  const freshTokensL1318 = new Set(freshL1318.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (l1318, reboot) *** the legacy token SURVIVES (never destroyed as collateral by the vacuous-empty-array fail-open)",
    freshTokensL1318.has("legacy-extra-token-l1318"));
  }

  // ---- 25f6a7dc-l751 — unincorporatedOccupantRepoPathAt's own "already incorporated" check: a legacy
  // singular token that's already part of the CLEARER's own in-memory tokens, under a stale `repoPath`
  // naming an unrelated identity sharing the same degraded key ----
  {
  const r6 = makeToplevelRepo("l751-r6");
  const d6 = path.join(r6, "sub-d6"); // a REAL, resolvable subdirectory — shares r6's own key
  fs.mkdirSync(d6, { recursive: true });
  fs.writeFileSync(path.join(d6, "placeholder.txt"), "sub\n");
  commitAll(r6, "add sub-d6", GIT_ID);
  const Kr6 = canonicalRepoLockKey(r6);
  check("(l751 precondition) d6 shares r6's own key", canonicalRepoLockKey(d6) === Kr6);

  reenterMergeQuarantinesAtBoot([]);
  const tokA = enterMergeQuarantine(d6, "d6-branch", "d6 raises first — takes the existing-branch identity");
  check("(l751 precondition) d6 is armed `existing` at its own key", activeMergeQuarantineFor(d6)?.repoPath === d6);

  const Kr6hash = createHash("sha256").update(Kr6).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Kr6hash}.json`);
  const z6 = path.join(r6, "gone-z6"); // a DIFFERENT, unresolvable identity sharing the SAME key

  // A stale leftover: final's own `repoPath` now names z6 (not d6), but it STILL carries d6's own real
  // token (tokA) — via the LEGACY singular `token` field, with `tokens` rewritten to an EMPTY array.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z6, branch: "z6-branch", reason: "a stale leftover naming a different identity, holding tokA in legacy form",
    enteredAt: Date.now(), tokens: [], token: tokA,
  }, null, 2) + "\n");

  // r6 raises too — reaches the EXISTING branch (d6 already armed at this key); its own protect call
  // re-reads final, finds the "different identity" (z6) holding tokA in legacy form.
  const tokB = enterMergeQuarantine(r6, "r6-branch", "r6 raises into d6's existing entry");

  const z6PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(z6));
  check("*** THE FIX (l751) *** NO bogus pending-divert record is minted for z6 (tokA is already incorporated into d6's own entry)",
    !fs.existsSync(z6PendingPath));
  const tokensAfterRaiseL751 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(l751) d6's own union still carries both tokA and tokB", tokensAfterRaiseL751.has(tokA) && tokensAfterRaiseL751.has(tokB));

  clearMergeQuarantineByToken(d6, tokA);
  clearMergeQuarantineByToken(d6, tokB);
  const freshL751 = await freshBootModule();
  freshL751.reenterMergeQuarantinesAtBoot([]);
  const freshTokensL751 = new Set(freshL751.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (l751, reboot) *** tokA does NOT resurrect under z6's own bogus identity after a reboot", !freshTokensL751.has(tokA));
  }

  // ---- 25f6a7dc-l1856 — resolveRaiseOverwrite's own "already incorporated" check: the SAME shape as
  // l751, but reached via its own direct re-read (forced past the fast path by an UNRELATED transient
  // read failure classified "unknown" on the FIRST read of final, during the existing-branch's own
  // protectUnincorporatedOccupantBeforeDelete call) ----
  {
  const r7 = makeToplevelRepo("l1856-r7");
  const d7 = path.join(r7, "sub-d7");
  fs.mkdirSync(d7, { recursive: true });
  fs.writeFileSync(path.join(d7, "placeholder.txt"), "sub\n");
  commitAll(r7, "add sub-d7", GIT_ID);
  const Kr7 = canonicalRepoLockKey(r7);
  check("(l1856 precondition) d7 shares r7's own key", canonicalRepoLockKey(d7) === Kr7);

  reenterMergeQuarantinesAtBoot([]);
  const tokC = enterMergeQuarantine(d7, "d7-branch", "d7 raises first — takes the existing-branch identity");

  const Kr7hash = createHash("sha256").update(Kr7).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Kr7hash}.json`);
  const z7 = path.join(r7, "gone-z7");

  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z7, branch: "z7-branch", reason: "a stale leftover naming a different identity, holding tokC in legacy form",
    enteredAt: Date.now(), tokens: [], token: tokC,
  }, null, 2) + "\n");

  // Fail ONLY the FIRST read of final — protectUnincorporatedOccupantBeforeDelete's own read comes back
  // "unknown" (marking the basename kept, protectOk=false), forcing resolveRaiseOverwrite past its own
  // fast path into its OWN direct re-read, which succeeds (every read after the first).
  const injectL1856 = injectReadFailureOnlyNth(finalPath, 1);
  let tokD;
  try {
    tokD = enterMergeQuarantine(r7, "r7-branch", "r7 raises into d7's existing entry, first read of final fails");
  } finally {
    injectL1856.restore();
  }

  const z7PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(z7));
  check("*** THE FIX (l1856) *** NO bogus pending-divert record is minted for z7 (tokC is already incorporated into d7's own entry)",
    !fs.existsSync(z7PendingPath));
  const tokensAfterRaiseL1856 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(l1856) d7's own union still carries both tokC and tokD", tokensAfterRaiseL1856.has(tokC) && tokensAfterRaiseL1856.has(tokD));

  clearMergeQuarantineByToken(d7, tokC);
  clearMergeQuarantineByToken(d7, tokD);
  const freshL1856 = await freshBootModule();
  freshL1856.reenterMergeQuarantinesAtBoot([]);
  const freshTokensL1856 = new Set(freshL1856.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (l1856, reboot) *** tokC does NOT resurrect under z7's own bogus identity after a reboot", !freshTokensL1856.has(tokC));
  }

  // ---- 25f6a7dc-tombstoned — {tokens:[], token:X} with X ALREADY CLEARED (tombstoned): the overlap
  // check correctly does NOT exempt it (X isn't in the raiser's own tokens — it's a pin, not a
  // discriminator: protectOccupantContentBeforeDelete's own pre-existing 7a7e041b skip already handles
  // this downstream, with or without this card's fix) — asserts the copy-aside is skipped outright, as
  // fully tombstoned, never resurrected ----
  {
  const scratch8 = makeToplevelRepo("tombstoned-scratch8");
  const tombTok = enterMergeQuarantine(scratch8, "scratch-branch", "scratch raise — becomes the tombstoned token");
  clearMergeQuarantineByToken(scratch8, tombTok);
  check("(tombstoned precondition) tombTok is lifted in-process (tombstoned)", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tombTok));

  const r8 = makeToplevelRepo("tombstoned-r8");
  const d8 = path.join(r8, "sub-d8");
  fs.mkdirSync(d8, { recursive: true });
  fs.writeFileSync(path.join(d8, "placeholder.txt"), "sub\n");
  commitAll(r8, "add sub-d8", GIT_ID);
  const Kr8 = canonicalRepoLockKey(r8);
  reenterMergeQuarantinesAtBoot([]);
  const tokE = enterMergeQuarantine(d8, "d8-branch", "d8 raises first — takes the existing-branch identity");

  const Kr8hash = createHash("sha256").update(Kr8).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Kr8hash}.json`);
  const z8 = path.join(r8, "gone-z8");
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z8, branch: "z8-branch", reason: "a stale leftover naming a different identity, holding an ALREADY-TOMBSTONED legacy token",
    enteredAt: Date.now(), tokens: [], token: tombTok,
  }, null, 2) + "\n");

  const tokF = enterMergeQuarantine(r8, "r8-branch", "r8 raises into d8's existing entry");
  const z8PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(z8));
  check("(tombstoned) no pending record survives for z8 (every real on-disk token was already tombstoned — nothing to protect)",
    !fs.existsSync(z8PendingPath));
  check("(tombstoned) tombTok is never resurrected", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tombTok));
  check("(tombstoned) d8's own union carries tokE and tokF", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tokE)
    && new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tokF));

  clearMergeQuarantineByToken(d8, tokE);
  clearMergeQuarantineByToken(d8, tokF);
  const freshTomb = await freshBootModule();
  freshTomb.reenterMergeQuarantinesAtBoot([]);
  const freshTokensTomb = new Set(freshTomb.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(tombstoned, reboot) tombTok stays gone after a reboot", !freshTokensTomb.has(tombTok));
  }

  // ---- 25f6a7dc-no-token — {tokens:[]} with NO legacy token at all: readSurvivingOnDiskTokens' own raw
  // array stays genuinely empty (nothing to recover either way), so protectOccupantContentBeforeDelete's
  // pre-existing random-token fallback still fires — a pin that this card's fix does not disturb it ----
  {
  const r9 = makeToplevelRepo("no-token-r9");
  const d9 = path.join(r9, "sub-d9");
  fs.mkdirSync(d9, { recursive: true });
  fs.writeFileSync(path.join(d9, "placeholder.txt"), "sub\n");
  commitAll(r9, "add sub-d9", GIT_ID);
  const Kr9 = canonicalRepoLockKey(r9);
  reenterMergeQuarantinesAtBoot([]);
  const tokG = enterMergeQuarantine(d9, "d9-branch", "d9 raises first — takes the existing-branch identity");

  const Kr9hash = createHash("sha256").update(Kr9).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Kr9hash}.json`);
  const z9 = path.join(r9, "gone-z9");
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z9, branch: "z9-branch", reason: "a stale leftover naming a different identity, with an empty tokens array and NO legacy token field",
    enteredAt: Date.now(), tokens: [],
  }, null, 2) + "\n");

  const tokH = enterMergeQuarantine(r9, "r9-branch", "r9 raises into d9's existing entry");
  const z9PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(z9));
  check("(no-token) a pending record IS minted for z9 — its own repoPath/branch/reason are genuine content worth protecting, even with no real token",
    fs.existsSync(z9PendingPath));
  check("(no-token) that pending record carries a FRESH, freshly-minted token (never an empty tokens array)",
    (contentIfExists(z9PendingPath) ?? "").includes(z9.replace(/\\/g, "\\\\")));
  check("(no-token) d9's own union carries tokG and tokH, unaffected", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tokG)
    && new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tokH));

  clearMergeQuarantineByToken(d9, tokG);
  clearMergeQuarantineByToken(d9, tokH);
  }

  // ---- 25f6a7dc-probeA (Code Review 6dac0fe9 of 25f6a7dc, probe A) — the `|| clearedTokens.has(t)`
  // disjunct this card added to markedFinalFullyCoveredByClear doesn't only fix the empty-array legacy
  // shape — it ALSO changes coverage for an ORDINARY, non-empty on-disk `tokens` array that mixes a
  // STILL-OWED token (being cleared right now) with one that was ALREADY tombstoned earlier this process.
  // Without the disjunct, the stale tombstoned token alone keeps `final` on disk, fail-closed — and BOTH
  // tokens (the still-owed one AND the long-dead one) resurrect from `final`'s own stale bytes after a
  // reboot, even though neither is actually still outstanding anywhere.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const rA = makeToplevelRepo("probeA-r");
  const KrA = canonicalRepoLockKey(rA);
  const KrAhash = createHash("sha256").update(KrA).digest("hex").slice(0, 24);
  const dA = path.join(rA, "gone-subdir");

  // T: mint via a wholly UNRELATED scratch repo and fully clear it — tombstones this exact string in
  // `clearedTokens`, with no connection at all to rA/dA below.
  const scratchA = makeToplevelRepo("probeA-scratch");
  const tombTokA = enterMergeQuarantine(scratchA, "scratch-branch", "scratch raise — becomes the tombstoned token");
  clearMergeQuarantineByToken(scratchA, tombTokA);
  check("(probeA precondition) tombTokA is lifted in-process (tombstoned)", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(tombTokA));

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPathA = path.join(MERGE_QUARANTINE_DIR, `${KrAhash}.json`);
  fs.writeFileSync(finalPathA, JSON.stringify({
    repoPath: dA, branch: "dA-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["A-d"], resolvedKey: KrA,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(probeA precondition) dA is `existing` at rA's own key", activeMergeQuarantineFor(rA)?.repoPath === dA);

  const injectA = injectPersistentReadFailure(finalPathA);
  let rTokenA;
  try {
    rTokenA = enterMergeQuarantine(rA, "rA-branch", "rA raises into dA's already-armed existing entry, final unreadable throughout");
  } finally {
    injectA.restore(); // transient — restored before the clear below
  }
  check("(probeA precondition) final is untouched (still ONLY A-d) right after the divert",
    (contentIfExists(finalPathA) ?? "").includes("A-d") && !(contentIfExists(finalPathA) ?? "").includes(rTokenA));

  // final's own physical bytes now ALSO carry the already-tombstoned token, alongside the still-owed
  // one — a stale copy of what this exact slot held before T was released elsewhere, never rewritten
  // since (the normal write path never reaches this file while its basename stays marked).
  fs.writeFileSync(finalPathA, JSON.stringify({
    repoPath: dA, branch: "dA-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["A-d", tombTokA], resolvedKey: KrA,
  }, null, 2) + "\n");

  const clearResultA = clearMergeQuarantineByRecordedPath(dA);
  check("(probeA) the clear reports success", clearResultA?.wasQuarantined === true);
  check("*** THE FIX (probeA) *** final is UNLINKED (coverage proven: A-d is being cleared, T is already tombstoned)",
    contentIfExists(finalPathA) === null);
  const tokensAfterClearA = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(probeA) A-d is lifted IN-PROCESS", !tokensAfterClearA.has("A-d"));
  check("(probeA) rA's own (merged) token is ALSO lifted IN-PROCESS", !tokensAfterClearA.has(rTokenA));

  const freshA = await freshBootModule();
  freshA.reenterMergeQuarantinesAtBoot([]);
  const freshTokensA = new Set(freshA.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (probeA, reboot) *** A-d does NOT come back after a reboot", !freshTokensA.has("A-d"));
  check("*** THE FIX (probeA, reboot) *** rA's own token does NOT come back after a reboot", !freshTokensA.has(rTokenA));
  check("*** THE FIX (probeA, reboot) *** the already-tombstoned token does NOT resurrect either", !freshTokensA.has(tombTokA));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6c04633d ("6c04633d-z1", CR4 of 8db913e2, finding Z1, reviewer 4c732a8c, scratch probe
  // zz-cr4-probe.mjs commit cb461f56) — `consumeMatchedPendingsIntoArmedEntry`'s own raise-divert branch
  // unioned EVERY matched entry — the raiser's own AND every sibling sharing the canonical key — into ONE
  // divert record keyed to whichever matched entry `unionQuarantineEntries` judged OLDEST, an ARBITRARY
  // winner never guaranteed to be the raiser's own identity. `clearMergeQuarantineByToken` matches
  // PENDING entries by identity alone, so it could never reach the raiser's own tokens once folded under
  // a sibling's identity: the raiser stayed quarantined after every one of its own tokens was released,
  // including across a reboot. Setup: R raises twice (t1, t2 — t2's own raise diverts on a transient read
  // failure). A SIBLING S = R/sib-subdir has an OLDER pending entry (so it would win the old arbitrary
  // "oldest identity wins" union) and S exists on disk by the time R raises a third time (t3), whose own
  // fold-in read also fails — absorbing S via `collectCrossTierSiblingIndices`.
  //
  // MANAGER'S RULING: a divert union keeps the RAISER's own identity for the raiser's own tokens — never
  // fold one identity's tokens into a record keyed to a DIFFERENT identity; group matched entries by
  // identity and divert each identity separately. `clearMergeQuarantineByToken` ALSO now sweeps every
  // record — active and pending, any identity — still holding a given token, since a token is a
  // process-unique `randomUUID` and a match IS an exact identity of its own holder.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("6c04633d-z1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  const s = path.join(r, "sib-subdir");
  const sibToken = "sib-z-6c04633d-z1";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sibFile = "pending-0123456789abcdef01234567.json";
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sibFile), JSON.stringify({
    repoPath: s, branch: "sib-branch", reason: "S", enteredAt: Date.now() - 100000, tokens: [sibToken],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const t1z = enterMergeQuarantine(r, "r-branch", "r raises itself (t1)");
  const injectT2z = injectReadFailureAtCalls(finalPath, [1, 2]);
  const t2z = enterMergeQuarantine(r, "r-branch", "r raises again (t2), final unreadable, diverts");
  injectT2z.restore();

  // S now exists on disk — its own canonical key degrades (walks up) to Kr, a genuine sibling.
  fs.mkdirSync(s, { recursive: true });

  // Only the fold-in read inside consumeMatchedPendingsIntoArmedEntry's own sibling-absorb fails — the
  // exact shape that used to fold R's own tokens AND the sibling's into ONE record keyed to whichever
  // identity unionQuarantineEntries judged oldest (S, by construction above).
  const injectT3z = injectReadFailureAtCalls(finalPath, [4]);
  const t3z = enterMergeQuarantine(r, "r-branch", "r raises a third time (t3), absorbs the sibling");
  injectT3z.restore();

  const allEntriesZ1 = listActiveMergeQuarantines();
  const tokensAfterT3z = new Set(allEntriesZ1.flatMap((q) => q.tokens ?? []));
  check("(6c04633d-z1) t1/t2/t3 all enforced after the sibling-absorbing raise", [t1z, t2z, t3z].every((t) => tokensAfterT3z.has(t)));
  check("(6c04633d-z1) the sibling's own token is also still enforced", tokensAfterT3z.has(sibToken));
  check("*** THE FIX (6c04633d-z1) *** no record keyed to the sibling's own identity holds any of R's own tokens",
    !allEntriesZ1.some((e) => path.basename(e.repoPath) === "sib-subdir" && [t1z, t2z, t3z].some((t) => (e.tokens ?? []).includes(t))));

  // clearMergeQuarantineByToken must lift EVERY one of R's own tokens, whatever record currently holds
  // it — this is the card's own exact repro assertion (Z1's own token-by-token release, in order).
  clearMergeQuarantineByToken(r, t1z);
  const tokensAfterClearT1z = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (6c04633d-z1) *** t1 is gone IN-PROCESS after clearMergeQuarantineByToken(r, t1)", !tokensAfterClearT1z.has(t1z));
  const diskAfterClearT1z = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .map((f) => contentIfExists(path.join(MERGE_QUARANTINE_DIR, f)) ?? "").join("\n");
  check("*** THE FIX (6c04633d-z1) *** t1 is gone ON DISK too — no latch file still carries it", !diskAfterClearT1z.includes(t1z));

  clearMergeQuarantineByToken(r, t2z);
  clearMergeQuarantineByToken(r, t3z);
  clearMergeQuarantineByToken(s, sibToken);
  const tokensAfterAllClearsZ1 = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (6c04633d-z1) *** r is FULLY lifted in-process after releasing every one of its own tokens", !activeMergeQuarantineFor(r));
  check("(6c04633d-z1) none of r's tokens or the sibling's survive in-process", ![t1z, t2z, t3z, sibToken].some((t) => tokensAfterAllClearsZ1.has(t)));

  const freshZ1 = await freshBootModule();
  freshZ1.reenterMergeQuarantinesAtBoot([]);
  const freshTokensZ1 = new Set(freshZ1.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (6c04633d-z1, reboot) *** none of r's own tokens resurrect after a reboot", ![t1z, t2z, t3z].some((t) => freshTokensZ1.has(t)));
  check("*** THE FIX (6c04633d-z1, reboot) *** the sibling's own (already-cleared) token does not resurrect either", !freshTokensZ1.has(sibToken));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6c04633d ("6c04633d-a", CR4 of 8db913e2 finding (a)) — a PARTIAL by-token clear of a record
  // whose own `orphanLatchFiles` was folded from an absorbed SAME-IDENTITY pending entry never kept that
  // folded file's own physical bytes in sync with the reduced token set — generalizing the `ae79d492`
  // dual-tracked-twin rewrite (which only ever covered ONE reference-tracked pending twin) to every
  // folded orphan a record carries. D has a pre-existing, LEGACY-named pending entry (`ownFile`, never
  // `pendingDivertFilenameFor(d)`) holding its own token; a later raise (via the `existing`-branch's own
  // sibling-absorb, `collectCrossTierSiblingIndices`) folds it into the raiser's OWN record (SAME
  // identity, per the 6c04633d identity rule) and `ownFile` becomes a genuine, non-self-referencing
  // orphan. Releasing the exact token `ownFile` itself originally carried, via a PARTIAL clear (other
  // tokens remain outstanding), must rewrite `ownFile`'s own bytes too — or a reboot re-arms it from the
  // stale, never-updated copy still sitting there.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const d = path.join(makeToplevelRepo("6c04633d-a-r"), "gone-subdir");
  const r = path.dirname(d);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  const origToken = "orig-token-6c04633d-a";
  const ownExtraToken = "own-extra-token-6c04633d-a";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  // D's OWN pre-existing pending entry, under a DISTINCT, legacy filename (never
  // `pendingDivertFilenameFor(d)`) — sharing D's own identity, so a later raise's own consume-divert
  // folds it into ITS OWN record (never a different identity's, per the 6c04633d identity rule), and its
  // own file becomes a genuine, non-self-referencing orphan once folded.
  const ownFile = "pending-fedcbafedcbafedcbafedcba.json";
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, ownFile), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own pre-existing pending copy", enteredAt: Date.now() - 100000, tokens: [ownExtraToken],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const injectMarkA = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  injectMarkA.restore();

  fs.mkdirSync(d, { recursive: true });

  const injectFoldA = injectReadFailureAtCalls(finalPath, [3]);
  const t2a = enterMergeQuarantine(d, "d2", "D raise, foldIn read fails, merges its OWN pending copy");
  injectFoldA.restore();

  const entryA = listActiveMergeQuarantines().find((e) => (e.tokens ?? []).includes(ownExtraToken));
  check("(6c04633d-a precondition) D's own legacy pending token is merged into the raise's own record", !!entryA && (entryA.tokens ?? []).includes(t2a));
  check("(6c04633d-a precondition) the legacy file is folded into orphanLatchFiles, DISTINCT from its own divert target", (entryA?.orphanLatchFiles ?? []).includes(ownFile));
  check("(6c04633d-a precondition) the legacy file still exists on disk, UNCHANGED at fold time", (contentIfExists(path.join(MERGE_QUARANTINE_DIR, ownFile)) ?? "").includes(ownExtraToken));

  // Partial clear: release ownExtraToken — the EXACT token the orphan file `ownFile` itself originally
  // carried — while origToken/t2a remain outstanding (not the last token on the authoritative record).
  clearMergeQuarantineByToken(d, ownExtraToken);
  const ownFileContentAfter = contentIfExists(path.join(MERGE_QUARANTINE_DIR, ownFile)) ?? "";
  check("*** THE FIX (6c04633d-a) *** the folded orphan latch file's own bytes are rewritten to EXCLUDE the just-released token", !ownFileContentAfter.includes(ownExtraToken));

  const tokensAfterPartialA = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(6c04633d-a) ownExtraToken gone in-process, t2 still enforced", !tokensAfterPartialA.has(ownExtraToken) && tokensAfterPartialA.has(t2a));

  const freshA = await freshBootModule();
  freshA.reenterMergeQuarantinesAtBoot([]);
  const freshTokensA = new Set(freshA.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("*** THE FIX (6c04633d-a, reboot) *** the released ownExtraToken does NOT resurrect from the stale orphan file after a reboot", !freshTokensA.has(ownExtraToken));
  check("(6c04633d-a, reboot) the still-outstanding token(s) survive the reboot", freshTokensA.has(t2a) || freshTokensA.has(origToken));

  clearMergeQuarantineByToken(d, t2a);
  clearMergeQuarantineByToken(d, origToken);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review `e8c78d98` of commit `b49ab498`, B1 CRITICAL ("6c04633d-b1") — `rewriteOrphanLatchFilesAfterPartialClear`
  // blind-wrote the clearing entry's whole record into every EXISTING file its own `orphanLatchFiles`
  // named, checking only `existsSync`, never OWNERSHIP. `9cabd143` records that an orphan reference can
  // name a file that is now ANOTHER live entry's own latch — mirroring the `95ea8d3f-r3-orphanref` setup
  // (PASS 2's own "unmatched orphan broadcast onto every registered repo" mechanism), but reached via a
  // WRITE this time, not a wrongful unlink.
  //
  // Repro (the reviewer's own): a corrupt `<hashB>.json` exists; boot with [A] (A is fail-closed
  // quarantined, PASS 2 folds the unmatched orphan into A's own `orphanLatchFiles`); B raises for real,
  // so `<hashB>.json` becomes B's own live latch; A raises AGAIN (its own identity, a second token); a
  // PARTIAL clear of A's own just-added token reaches `rewriteOrphanLatchFilesAfterPartialClear`, which
  // (pre-fix) blind-writes A's own record into `<hashB>.json`, destroying B's real content.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const A = makeToplevelRepo("6c04633d-b1-A");
  const B = makeToplevelRepo("6c04633d-b1-B");
  const KB = canonicalRepoLockKey(B);
  const KBhash = createHash("sha256").update(KB).digest("hex").slice(0, 24);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const bFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KBhash}.json`);
  // Step 1: corrupt content at B's own real hash — matches NO registered repo's hash.
  fs.writeFileSync(bFinalPath, "{not valid json");
  // Step 2: boot with ONLY A registered — A is fail-closed quarantined (a corrupt, unmatched latch
  // forces every registered repo fail-closed) and PASS 2 folds the unmatched orphan into A's own
  // orphanLatchFiles (card 9a55fb90/882d6cff-era PASS 2, round 7 M2) — mirrors `95ea8d3f-r3-orphanref`.
  reenterMergeQuarantinesAtBoot([A]);
  const entryAAtBoot = listActiveMergeQuarantines().find((e) => e.repoPath === A);
  check("(6c04633d-b1 precondition) A is fail-closed quarantined at boot", !!entryAAtBoot && (entryAAtBoot.tokens ?? []).length > 0);
  check("(6c04633d-b1 precondition) A's own entry now names B's file in its orphanLatchFiles",
    (entryAAtBoot?.orphanLatchFiles ?? []).includes(`${KBhash}.json`));
  const failClosedTokenA = (entryAAtBoot?.tokens ?? [])[0];

  // Step 3: B raises for real — the corrupt content is "nothing usable," so the write proceeds and
  // durably overwrites `<hashB>.json` with B's own real latch.
  const bToken = enterMergeQuarantine(B, "b-branch", "b raises for real");
  check("(6c04633d-b1 precondition) B's own real latch is now durably at hashB.json",
    (contentIfExists(bFinalPath) ?? "").includes(bToken));

  // Step 4: A raises AGAIN (its own identity — reachable in production via a GitWriter op, which lacks
  // assertRepoNotQuarantined) — a SECOND token, so a later clear of just this one is a PARTIAL clear.
  const tA = enterMergeQuarantine(A, "a-branch", "a raises again, already quarantined");
  const tokensAAfterRaise = new Set(listActiveMergeQuarantines().find((e) => e.repoPath === A)?.tokens ?? []);
  check("(6c04633d-b1 precondition) A now holds BOTH its fail-closed token and the new tA", tokensAAfterRaise.has(failClosedTokenA) && tokensAAfterRaise.has(tA));

  // Step 5: partial clear of A's own tA (failClosedTokenA remains outstanding) — reaches
  // rewriteOrphanLatchFilesAfterPartialClear with hashB.json still folded into A's own orphanLatchFiles.
  clearMergeQuarantineByToken(A, tA);
  const bFinalContentAfterClear = contentIfExists(bFinalPath) ?? "";
  check("*** THE FIX (6c04633d-b1) *** hashB.json is NEVER overwritten with A's own record — B's real content survives byte-for-byte",
    bFinalContentAfterClear.includes(bToken) && !bFinalContentAfterClear.includes(path.basename(A)));
  check("(6c04633d-b1) A's own tA is lifted in-process; its fail-closed token remains outstanding",
    !new Set(listActiveMergeQuarantines().find((e) => e.repoPath === A)?.tokens ?? []).has(tA));

  // Step 6: fresh-process reboot, registering both A and B — B must stay quarantined (per the ruling: a
  // skipped, left-stale orphan rewrite is an accepted fail-CLOSED residual, never a silent un-quarantine).
  const freshB1 = await freshBootModule();
  freshB1.reenterMergeQuarantinesAtBoot([A, B]);
  const freshListB1 = freshB1.listActiveMergeQuarantines();
  check("*** THE FIX (6c04633d-b1, reboot) *** B stays quarantined after a fresh-process reboot (never silently lifted as a side effect of A's own clear)",
    freshListB1.some((e) => e.repoPath === B && (e.tokens ?? []).includes(bToken)));

  clearMergeQuarantineByToken(B, bToken);
  clearMergeQuarantineByToken(A, failClosedTokenA);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review `e8c78d98`, B1 (keptUnreadable variant, "6c04633d-b1-kept") — the SAME shape as
  // 6c04633d-b1, but `<hashB>.json`'s own basename is ALSO `keptUnreadableLatchFiles`-marked (via a
  // THROWAWAY raise on an unresolvable subdir of B, which degrades to B's own key and hits a transient
  // read failure) at the moment A's partial clear tries the orphan rewrite. NOTE (named, not glossed
  // over): this does NOT isolate the `keptUnreadableLatchFiles` check from the cross-identity content
  // check — B's own real content ALSO differs from A's identity here, so either check alone would skip
  // this write; both pass together, as a combined regression guard for the overall fail-closed outcome,
  // not a unit proof that the mark-check specifically is what fired.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const A = makeToplevelRepo("6c04633d-b1k-A");
  const B = makeToplevelRepo("6c04633d-b1k-B");
  const KB = canonicalRepoLockKey(B);
  const KBhash = createHash("sha256").update(KB).digest("hex").slice(0, 24);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const bFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KBhash}.json`);
  fs.writeFileSync(bFinalPath, "{not valid json");
  reenterMergeQuarantinesAtBoot([A]);
  const entryAAtBootK = listActiveMergeQuarantines().find((e) => e.repoPath === A);
  check("(6c04633d-b1-kept precondition) A's own entry names B's file in its orphanLatchFiles",
    (entryAAtBootK?.orphanLatchFiles ?? []).includes(`${KBhash}.json`));
  const failClosedTokenAK = (entryAAtBootK?.tokens ?? [])[0];

  const bToken = enterMergeQuarantine(B, "b-branch", "b raises for real");
  check("(6c04633d-b1-kept precondition) B's own real latch is now durably at hashB.json",
    (contentIfExists(bFinalPath) ?? "").includes(bToken));

  // A throwaway raise on an unresolvable subdir of B — degrades (walks up) to B's OWN canonical key — with
  // a transient read failure on hashB.json marks its basename `keptUnreadableLatchFiles` and diverts,
  // never touching B's own real content (the pre-existing, unchanged "existing"-branch divert path).
  const bSub = path.join(B, "throwaway-subdir");
  const injectKeptMark = injectReadFailureOnlyNth(bFinalPath, 1);
  const bSubToken = enterMergeQuarantine(bSub, "b-sub-branch", "throwaway raise to mark hashB.json kept-unreadable");
  injectKeptMark.restore();
  check("(6c04633d-b1-kept precondition) B's own real content at hashB.json is UNCHANGED by the throwaway raise",
    (contentIfExists(bFinalPath) ?? "").includes(bToken));

  const tAK = enterMergeQuarantine(A, "a-branch", "a raises again, already quarantined");
  clearMergeQuarantineByToken(A, tAK);
  const bFinalContentAfterClearK = contentIfExists(bFinalPath) ?? "";
  check("*** THE FIX (6c04633d-b1-kept) *** hashB.json is NEVER overwritten while its basename is keptUnreadableLatchFiles-marked",
    bFinalContentAfterClearK.includes(bToken) && !bFinalContentAfterClearK.includes(path.basename(A)));

  clearMergeQuarantineByToken(B, bToken);
  clearMergeQuarantineByToken(bSub, bSubToken);
  clearMergeQuarantineByToken(A, failClosedTokenAK);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 29fe2372 ("29fe2372") — `orphanRewriteOwnershipConfirmed` (6c04633d's own ownership gate) checked
  // same IDENTITY, never same ENTITY. `d4b25feb` round 2 established one identity can legitimately hold
  // TWO independent records at once (one active-only, one pending-only, disjoint tokens). When a
  // DIFFERENT, independent same-identity record's own `sourceFile` is named in the entry being partially
  // cleared's own `orphanLatchFiles`, the old identity-only gate wrongly confirmed ownership and blindly
  // overwrote that OTHER record's physical file — destroying its token with ZERO in-memory signal (its
  // own `pendingUnresolvedQuarantines` entry stays untouched, still reporting its token enforced, until a
  // reboot silently drops it with no clear ever issued for it). THE FIX adds two further layers:
  // `anotherLiveEntryOwnsFile` (no OTHER live entry object, active or pending, any identity, may still
  // depend on the file) and `orphanFileTokensAccountedForByUpdate` (every real on-disk token must already
  // be accounted for by `updated.tokens` plus the token this exact clear just dropped).
  //
  // Step 3 below (giving A's own file an `orphanLatchFiles` reference to P's own `sourceFile`) is a
  // HAND-EDIT that STANDS IN FOR the real production path — an "existing"-branch sibling-absorb whose own
  // durable write fails (`consumeMatchedPendingsIntoArmedEntry`'s own `else` branch, ~1321-1330).
  // EMPIRICALLY CHECKED (a standalone probe, reusing the SAME `injectOpenSyncFailureForPrefix` seam this
  // file already uses for shape 3/dd34da46/p3b/p3g): that real path instead CONSUMES the independent
  // pending record into ONE merged entity (safe — its own token is already accounted for by the merge),
  // never leaving two genuinely independent records sharing one orphan reference. Reaching that exact
  // shape through 100% production code additionally requires the separately-carded, still-unguarded
  // fresh-divert write (`divertRaiseEntry` ~1964-1966 / `enterMergeQuarantine` ~2206-2218,
  // `writePendingDivertFile` with no occupant read) — out of THIS card's own scope by Lead ruling.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("29fe2372-x");
  const Kx = canonicalRepoLockKey(x);
  const Kxhash = createHash("sha256").update(Kx).digest("hex").slice(0, 24);
  const xFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kxhash}.json`);
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);

  // Step 1-2: two raises of x WHILE resolvable -> active A, two tokens (so a later clear can be partial).
  const tA1 = enterMergeQuarantine(x, "a-branch", "29fe2372 raise 1, resolvable");
  const tA2 = enterMergeQuarantine(x, "a-branch", "29fe2372 raise 2, still resolvable (gives A a 2nd token)");
  // Step 3: x becomes unresolvable, then raises again -- per d4b25feb's own "existing lookup only runs
  // when verified" fix, this never looks at A at all; it creates a wholly INDEPENDENT pending entry P.
  fs.rmSync(x, { recursive: true, force: true });
  const tP = enterMergeQuarantine(x, "p-branch", "29fe2372 raise 3, unresolvable -> independent pending P");
  check("(29fe2372 precondition) two DISTINCT entry objects for x's identity (one active-only, one pending-only, per d4b25feb)",
    listActiveMergeQuarantines().filter((e) => e.repoPath === x).length === 2);
  check("(29fe2372 precondition) tA1/tA2/tP all enforced before the stand-in hand-edit", (() => {
    const t = new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
    return t.has(tA1) && t.has(tA2) && t.has(tP);
  })());

  // Stand-in hand-edit (see header comment) -- A's own durable file gains an orphanLatchFiles reference
  // to P's own, genuinely independent sourceFile.
  const aRaw = JSON.parse(contentIfExists(xFinalPath));
  aRaw.orphanLatchFiles = [pendingFile];
  fs.writeFileSync(xFinalPath, JSON.stringify(aRaw, null, 2) + "\n");

  const freshA = await freshBootModule();
  freshA.reenterMergeQuarantinesAtBoot([x]);
  check("(29fe2372 precondition, post-reboot) still two distinct entries for x, same tokens",
    freshA.listActiveMergeQuarantines().filter((e) => e.repoPath === x).length === 2);

  // Step 4: PARTIAL clear of A (tA2) -- tA1 remains outstanding. Reaches rewriteOrphanLatchFilesAfterPartialClear.
  freshA.clearMergeQuarantineByToken(x, tA2);
  const pendingContentAfterClear = contentIfExists(pendingPath) ?? "";
  check("*** THE FIX (29fe2372) *** P's own real token is NOT destroyed by A's wholly unrelated partial clear",
    pendingContentAfterClear.includes(tP));
  check("(29fe2372) A's own tA1 remains outstanding, tA2 is gone (the clear itself still worked)", (() => {
    const t = new Set(freshA.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
    return t.has(tA1) && !t.has(tA2);
  })());

  // Step 5: a SECOND fresh-process reboot, with NO clear of tP ever issued by anyone.
  const freshB = await freshBootModule();
  freshB.reenterMergeQuarantinesAtBoot([x]);
  const tokensAfterReboot2 = new Set(freshB.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (29fe2372, reboot) *** P's own token SURVIVES a fresh-process reboot, despite NEVER being cleared",
    tokensAfterReboot2.has(tP));
  check("(29fe2372, reboot) A's own remaining token also survives", tokensAfterReboot2.has(tA1));

  freshB.clearMergeQuarantineByToken(x, tP);
  freshB.clearMergeQuarantineByToken(x, tA1);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 29fe2372 ("29fe2372-isolate-b") -- an isolating case for LAYER (b) alone (content token-subset):
  // NOTHING in memory (active or pending) references the orphan file at all, so layer (a)
  // (`anotherLiveEntryOwnsFile`) finds nobody and would have PASSED on its own -- only layer (b)
  // (`orphanFileTokensAccountedForByUpdate`), reading a genuinely FOREIGN token physically sitting on
  // disk, can correctly refuse this rewrite. Ablation-verified: with layer (b) alone removed, this
  // scenario's own discriminating check goes RED (see the worker report for this card).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("29fe2372-isob-x");
  const Kx = canonicalRepoLockKey(x);
  const Kxhash = createHash("sha256").update(Kx).digest("hex").slice(0, 24);
  const xFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kxhash}.json`);
  const someFile = pendingDivertFilenameForTest(x);
  const somePath = path.join(MERGE_QUARANTINE_DIR, someFile);

  fs.rmSync(x, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(xFinalPath, JSON.stringify({
    repoPath: x, branch: "a-branch", reason: "29fe2372-isolate-b hand-built active entry",
    enteredAt: Date.now(), tokens: ["isob-tA1", "isob-tA2"], resolvedKey: canonicalRepoLockKey(x),
    orphanLatchFiles: [someFile],
  }, null, 2) + "\n");

  const freshIsoB = await freshBootModule();
  freshIsoB.reenterMergeQuarantinesAtBoot([x]);
  check("(29fe2372-isolate-b precondition) A is armed with both hand-built tokens and the orphan reference",
    freshIsoB.listActiveMergeQuarantines().some((e) => e.repoPath === x && (e.orphanLatchFiles ?? []).includes(someFile)));

  // Write someFile's content AFTER boot -- it was never classified by PASS1 at all, so NOTHING in
  // pendingUnresolvedQuarantines or activeQuarantines references it as its own backing (A's own
  // orphanLatchFiles reference above is a hand-built POINTER, not a second live OBJECT). Layer (a) finds
  // no SECOND entry object to disqualify this write.
  fs.writeFileSync(somePath, JSON.stringify({ repoPath: x, tokens: ["isob-foreign-token"] }, null, 2) + "\n");
  check("(29fe2372-isolate-b precondition) only ONE live entry object exists for x (no second, independent record)",
    freshIsoB.listActiveMergeQuarantines().filter((e) => e.repoPath === x).length === 1);

  freshIsoB.clearMergeQuarantineByToken(x, "isob-tA2");
  check("*** THE FIX (29fe2372-isolate-b), layer (b) alone discriminates *** the foreign token physically on disk is NOT destroyed",
    (contentIfExists(somePath) ?? "").includes("isob-foreign-token"));

  freshIsoB.clearMergeQuarantineByToken(x, "isob-tA1");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 29fe2372 ("29fe2372-isolate-a") -- an isolating case for LAYER (a) alone (object-reference
  // ownership): a GENUINE, LIVE, independent pending entry P2 (reconstructed at boot from its own valid,
  // if token-LESS, on-disk content) shares the orphan file as its own `sourceFile` -- layer (b)
  // (`orphanFileTokensAccountedForByUpdate`) finds ZERO real tokens there and would VACUOUSLY pass on its
  // own (nothing to object to); only layer (a) (`anotherLiveEntryOwnsFile`), which sees P2 is a genuinely
  // SEPARATE, surviving object, correctly refuses. Ablation-verified: with layer (a) alone removed, this
  // scenario's own discriminating check goes RED (see the worker report for this card).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("29fe2372-isoa-x");
  const Kx = canonicalRepoLockKey(x);
  const Kxhash = createHash("sha256").update(Kx).digest("hex").slice(0, 24);
  const xFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kxhash}.json`);
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);

  fs.rmSync(x, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(xFinalPath, JSON.stringify({
    repoPath: x, branch: "a-branch", reason: "29fe2372-isolate-a hand-built active entry",
    enteredAt: Date.now(), tokens: ["isoa-tA1", "isoa-tA2"], resolvedKey: canonicalRepoLockKey(x),
    orphanLatchFiles: [pendingFile],
  }, null, 2) + "\n");
  // A genuinely valid, if TOKEN-LESS, pending latch -- PASS1 reconstructs a real, live, independent P2
  // object from this at boot (not a drifted in-memory copy); its own on-disk content has nothing for a
  // pure content check to object to.
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: x, branch: "p2-branch", reason: "29fe2372-isolate-a token-less independent pending P2",
    enteredAt: Date.now(), tokens: [],
  }, null, 2) + "\n");

  const freshIsoA = await freshBootModule();
  freshIsoA.reenterMergeQuarantinesAtBoot([x]);
  const bootListIsoA = freshIsoA.listActiveMergeQuarantines();
  check("(29fe2372-isolate-a precondition) two distinct entries for x -- A (active) and P2 (pending, token-less)",
    bootListIsoA.filter((e) => e.repoPath === x).length === 2);
  // PASS1 mints an in-memory-only randomUUID() for a token-less pending latch (its own legacy fallback,
  // never durably written back) -- so the DISCRIMINATING check here is the file's own RAW on-disk bytes,
  // never the in-memory listing (which would now show a synthesized, non-empty token for P2 too).
  check("(29fe2372-isolate-a precondition) layer (b) alone would vacuously pass -- pendingFile's own ON-DISK bytes hold zero real tokens",
    (JSON.parse(contentIfExists(pendingPath)).tokens ?? []).length === 0);

  freshIsoA.clearMergeQuarantineByToken(x, "isoa-tA2");
  const pendingContentIsoA = contentIfExists(pendingPath) ?? "";
  check("*** THE FIX (29fe2372-isolate-a), layer (a) alone discriminates *** P2's own file is NOT overwritten with A's content",
    !pendingContentIsoA.includes("isoa-tA1"));
  check("(29fe2372-isolate-a) P2's own token-less record still independently survives (never swept as a side effect)",
    freshIsoA.listActiveMergeQuarantines().some((e) => e.repoPath === x && e.branch === "p2-branch"));

  freshIsoA.clearMergeQuarantineByToken(x, "isoa-tA1");
  freshIsoA.clearMergeQuarantineByRecordedPath(x); // P2 is token-less -- clearMergeQuarantineByToken can never match it.
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 ("8a79dd31-fresh-divert") -- SAME-IDENTITY UNION case, fixed by mintPendingDivert's own
  // reconcilePendingDivertTarget check (renamed by card 6451a749, which generalized it to a second caller).
  //
  // `enterMergeQuarantine`'s own direct unresolvable brand-new-divert branch (the `!verified` block) used
  // to call `writePendingDivertFile(pendingDivertFilenameFor(repoPath), fresh)` with ZERO read of whatever
  // currently occupies that deterministic filename first — `writePendingDivertFile`'s own jsdoc states
  // plainly it has "no degraded-occupant guard". If that file is currently another live record's own
  // latch for the SAME identity (e.g. a same-identity record's file left behind by a failed graduation
  // write, or a kept-unreadable file -- the card's own wording), its tokens were silently destroyed, with
  // no clear ever issued.
  //
  // The hand-crafted occupant file below STANDS IN for exactly that production shape: a pending-divert
  // record physically present at `pendingDivertFilenameFor(x)`, for x's OWN identity, that this PROCESS's
  // own in-memory `pendingUnresolvedQuarantines` has never scanned (no `reenterMergeQuarantinesAtBoot` call
  // for `x` ever ran in this process before the raise below) -- e.g. written by another mechanism/process
  // sharing `MERGE_QUARANTINE_DIR`, or surviving from before this process's own boot. `collectPendingIndices`
  // (used by both `enterMergeQuarantine`'s own `pendingIndices` lookup and `divertRaiseEntry`) matches ONLY
  // by object presence in `pendingUnresolvedQuarantines`, never by reading the directory, so this shape
  // reaches `indices.length === 0` / `pendingIndices.length === 0` exactly as a genuinely out-of-band file
  // would.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-fd-x");
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: x, branch: "occupant-branch", reason: "8a79dd31-fresh-divert hand-crafted occupant, never scanned by this process",
    enteredAt: Date.now(), tokens: ["8a79dd31-fd-occupant-token"],
  }, null, 2) + "\n");
  check("(8a79dd31-fresh-divert precondition) nothing in THIS process tracks x yet", activeMergeQuarantineFor(x) === undefined);

  fs.rmSync(x, { recursive: true, force: true }); // x is now unresolvable -> the `!verified` brand-new branch.
  const freshToken = enterMergeQuarantine(x, "new-branch", "8a79dd31-fresh-divert: fresh raise over a never-scanned occupant file");

  check("*** THE FIX (8a79dd31-fresh-divert) *** the occupant's own content SURVIVES byte-for-byte (same identity -> unioned, never overwritten)",
    (contentIfExists(pendingPath) ?? "").includes("8a79dd31-fd-occupant-token"));
  check("*** THE FIX (8a79dd31-fresh-divert) *** the UNION lands at the SAME primary filename, carrying BOTH tokens (one record, not a diverted-elsewhere pair)", (() => {
    const c = contentIfExists(pendingPath) ?? "";
    return c.includes("8a79dd31-fd-occupant-token") && c.includes(freshToken);
  })());
  check("(8a79dd31-fresh-divert) exactly ONE in-process entry for x, holding BOTH tokens", (() => {
    const entries = listActiveMergeQuarantines().filter((e) => e.repoPath === x);
    return entries.length === 1 && entries[0].tokens.includes("8a79dd31-fd-occupant-token") && entries[0].tokens.includes(freshToken);
  })());

  const freshFD = await freshBootModule();
  freshFD.reenterMergeQuarantinesAtBoot([x]);
  const tokensAfterRebootFD = new Set(freshFD.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (8a79dd31-fresh-divert, reboot) *** BOTH the occupant's token AND the fresh raise's own token survive a fresh-process reboot, as one record",
    tokensAfterRebootFD.has("8a79dd31-fd-occupant-token") && tokensAfterRebootFD.has(freshToken));

  freshFD.clearMergeQuarantineByToken(x, freshToken);
  freshFD.clearMergeQuarantineByToken(x, "8a79dd31-fd-occupant-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 ("8a79dd31-divert-raise-entry") -- the SAME same-identity-union fix, at the OTHER named
  // call site.
  //
  // `divertRaiseEntry`'s own `indices.length === 0` branch is reached a DIFFERENT way: via
  // `resolveRaiseOverwrite`'s `mustDivert` decision, for a repoPath that IS currently resolvable but whose
  // own canonical key's physical final cannot be safely read (forcing a divert rather than an overwrite of
  // `final` itself, per `e1cb7d33`/`8db913e2`). The defect under test here is NOT about `final`, which the
  // 8db913e2 card already protects; it is that `divertRaiseEntry` itself used to call
  // `writePendingDivertFile(pendingDivertFilenameFor(r.repoPath), entry)` with ZERO read of whatever
  // ALREADY occupies THAT (different, identity-keyed) deterministic path -- exactly the same unguarded
  // write as the fresh-divert branch above, just reached from the OTHER call site the card names (now the
  // SAME chokepoint, per Step A's consolidation).
  //
  // The hand-crafted occupant at `pendingDivertFilenameFor(r)` below stands in for the same production
  // shape as 8a79dd31-fresh-divert above: an independent, same-identity pending record this process has
  // never scanned into `pendingUnresolvedQuarantines` (d4b25feb round 2's own established "one identity,
  // two independent records" shape).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("8a79dd31-dre-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  const pendingFile = pendingDivertFilenameForTest(r);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: r, branch: "occupant-branch", reason: "8a79dd31-divert-raise-entry hand-crafted independent same-identity pending occupant",
    enteredAt: Date.now(), tokens: ["8a79dd31-dre-occupant-token"],
  }, null, 2) + "\n");

  // Force resolveRaiseOverwrite's mustDivert=true: r's own canonical final is persistently unreadable
  // (an "unknown" read failure, per 63e49ee2 -- never ENOENT, which would mean "nothing real, proceed").
  const inject = injectPersistentReadFailure(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "8a79dd31-divert-raise-entry: r raises, own key's final persistently unreadable -> mustDivert");
  } finally {
    inject.restore();
  }
  check("(8a79dd31-divert-raise-entry precondition) the read was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (8a79dd31-divert-raise-entry) *** the independent occupant's own content at r's own identity-keyed pending-divert path SURVIVES byte-for-byte (same identity -> unioned, never overwritten)",
    (contentIfExists(pendingPath) ?? "").includes("8a79dd31-dre-occupant-token"));
  check("*** THE FIX (8a79dd31-divert-raise-entry) *** the UNION lands at the SAME primary filename, carrying BOTH tokens", (() => {
    const c = contentIfExists(pendingPath) ?? "";
    return c.includes("8a79dd31-dre-occupant-token") && c.includes(rToken);
  })());

  const freshDRE = await freshBootModule();
  freshDRE.reenterMergeQuarantinesAtBoot([r]);
  const tokensAfterRebootDRE = new Set(freshDRE.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (8a79dd31-divert-raise-entry, reboot) *** BOTH the occupant's token AND r's own raised token survive a fresh-process reboot, as one record",
    tokensAfterRebootDRE.has("8a79dd31-dre-occupant-token") && tokensAfterRebootDRE.has(rToken));

  freshDRE.clearMergeQuarantineByToken(r, rToken);
  freshDRE.clearMergeQuarantineByToken(r, "8a79dd31-dre-occupant-token");
  freshDRE.clearMergeQuarantineByRecordedPath(r);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 ("8a79dd31-different-identity-diverts") -- a DIFFERENT, genuinely foreign identity
  // occupies the primary pending-divert filename (a true hash-of-identity collision stand-in — the
  // occupant's own `repoPath` differs from the raiser's). The fix must NEVER overwrite it and NEVER move
  // it; the raiser's own fresh entry is diverted to a distinct `pendingDivertCollisionFilenameFor` filename
  // instead, leaving the occupant's bytes exactly as they were.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-di-x");
  const foreign = makeToplevelRepo("8a79dd31-di-foreign");
  // Hand-craft the occupant file AT x's own deterministic pending-divert path, but naming a GENUINELY
  // DIFFERENT identity (`foreign`) as its own repoPath -- standing in for the vanishingly-rare true
  // sha256-identity collision this filename format is otherwise collision-proof against.
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "8a79dd31-different-identity-diverts hand-crafted FOREIGN occupant",
    enteredAt: Date.now(), tokens: ["8a79dd31-di-foreign-token"],
  }, null, 2) + "\n";
  fs.writeFileSync(pendingPath, foreignContentBefore);

  fs.rmSync(x, { recursive: true, force: true }); // x unresolvable -> the brand-new divert branch.
  const xToken = enterMergeQuarantine(x, "x-branch", "8a79dd31-different-identity-diverts: x raises over a GENUINELY FOREIGN occupant");

  check("*** THE FIX (8a79dd31-different-identity-diverts) *** the foreign occupant's own file is BYTE-IDENTICAL, never touched",
    contentIfExists(pendingPath) === foreignContentBefore);
  check("(8a79dd31-different-identity-diverts) x's own fresh raise still persists in-process (e1cb7d33 still holds)",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(xToken));
  const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== pendingFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(xToken));
  check("*** THE FIX (8a79dd31-different-identity-diverts) *** x's own entry landed at a DISTINCT collision-suffixed file, never at the occupant's own primary filename",
    collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile));

  const freshDI = await freshBootModule();
  freshDI.reenterMergeQuarantinesAtBoot([x, foreign]);
  const tokensAfterRebootDI = new Set(freshDI.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (8a79dd31-different-identity-diverts, reboot) *** BOTH x's own token AND the foreign occupant's own token survive a fresh-process reboot, as TWO SEPARATE records",
    tokensAfterRebootDI.has(xToken) && tokensAfterRebootDI.has("8a79dd31-di-foreign-token"));
  check("(8a79dd31-different-identity-diverts, reboot) TWO distinct entries, not one merged record", (() => {
    const entries = freshDI.listActiveMergeQuarantines();
    const xEntry = entries.find((e) => e.repoPath === x);
    const foreignEntry = entries.find((e) => e.repoPath === foreign);
    return !!xEntry && !!foreignEntry && xEntry !== foreignEntry;
  })());

  // LIFECYCLE: releasing x's own (last, only) token sweeps its own collision-suffixed file off disk —
  // never left behind as an untracked orphan.
  freshDI.clearMergeQuarantineByToken(x, xToken);
  check("*** THE FIX (8a79dd31-different-identity-diverts, lifecycle) *** clearing x's own token removes the -collision- file from disk",
    !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, collisionFile)));
  check("(8a79dd31-different-identity-diverts, lifecycle) the foreign occupant's own entry is UNAFFECTED by x's own clear (still enforced, by its own token)",
    (freshDI.activeMergeQuarantineFor(foreign)?.tokens ?? []).includes("8a79dd31-di-foreign-token"));

  freshDI.clearMergeQuarantineByToken(foreign, "8a79dd31-di-foreign-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 ("8a79dd31-unreadable-occupant-stays-byte-identical") -- the primary pending-divert
  // filename holds REAL bytes (a foreign identity's own latch) but every read of it fails persistently
  // (an "unknown" read failure, per 63e49ee2 -- a genuinely unreadable FILE, never ENOENT). The fix must
  // treat this exactly like a different-identity collision: never overwrite, never move -- divert the
  // raiser's own fresh entry to a distinct collision filename, leaving the unreadable occupant's own bytes
  // on disk completely untouched (readable again once the injection is restored).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-ur-x");
  const foreign = makeToplevelRepo("8a79dd31-ur-foreign");
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "8a79dd31-unreadable-occupant-stays-byte-identical hand-crafted occupant",
    enteredAt: Date.now(), tokens: ["8a79dd31-ur-foreign-token"],
  }, null, 2) + "\n";
  fs.writeFileSync(pendingPath, foreignContentBefore);

  fs.rmSync(x, { recursive: true, force: true }); // x unresolvable -> the brand-new divert branch.
  const inject = injectPersistentReadFailure(pendingPath);
  let xToken;
  try {
    xToken = enterMergeQuarantine(x, "x-branch", "8a79dd31-unreadable-occupant-stays-byte-identical: x raises, occupant's own file persistently unreadable");
  } finally {
    inject.restore();
  }
  check("(8a79dd31-unreadable-occupant-stays-byte-identical precondition) the read was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (8a79dd31-unreadable-occupant-stays-byte-identical) *** the occupant's own file is BYTE-IDENTICAL once readable again, never touched",
    contentIfExists(pendingPath) === foreignContentBefore);
  check("(8a79dd31-unreadable-occupant-stays-byte-identical) x's own fresh raise still persists in-process (e1cb7d33 still holds)",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(xToken));

  const freshUR = await freshBootModule();
  freshUR.reenterMergeQuarantinesAtBoot([x, foreign]);
  const tokensAfterRebootUR = new Set(freshUR.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (8a79dd31-unreadable-occupant-stays-byte-identical, reboot) *** BOTH x's own token AND the occupant's own token survive a fresh-process reboot",
    tokensAfterRebootUR.has(xToken) && tokensAfterRebootUR.has("8a79dd31-ur-foreign-token"));

  freshUR.clearMergeQuarantineByToken(x, xToken);
  freshUR.clearMergeQuarantineByToken(foreign, "8a79dd31-ur-foreign-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 (CR ddb58ffa) ("8a79dd31-corrupt-json-diverts") -- the primary pending-divert filename
  // holds genuinely UNPARSEABLE bytes (not valid JSON at all). `reconcilePendingDivertTarget`'s (renamed
  // by card 6451a749) own `JSON.parse` catch must treat this exactly like a different-identity occupant: cannot prove
  // safety, never overwrite, never move -- divert to a collision filename instead.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-cj-x");
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  const garbageBefore = "{ this is not valid JSON at all --- 8a79dd31-cj-garbage-marker\n";
  fs.writeFileSync(pendingPath, garbageBefore);

  fs.rmSync(x, { recursive: true, force: true });
  const xToken = enterMergeQuarantine(x, "x-branch", "8a79dd31-corrupt-json-diverts: x raises over unparseable garbage");

  check("*** THE FIX (8a79dd31-corrupt-json-diverts) *** the garbage bytes are BYTE-IDENTICAL, never touched",
    contentIfExists(pendingPath) === garbageBefore);
  check("(8a79dd31-corrupt-json-diverts) x's own fresh raise still persists in-process (e1cb7d33 still holds)",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(xToken));
  check("*** THE FIX (8a79dd31-corrupt-json-diverts) *** x's own entry landed at a DISTINCT collision-suffixed file", (() => {
    const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== pendingFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(xToken));
    return collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile);
  })());

  clearMergeQuarantineByToken(x, xToken);
  // Cleanup: this garbage file has no identity attached (genuinely unparseable) — nothing in the module
  // itself ever sweeps it, and leaving it behind would pollute a LATER scenario's own fresh boot scan of
  // this SAME shared MERGE_QUARANTINE_DIR as a spurious "orphan corrupt latch matching no registered repo".
  fs.rmSync(pendingPath, { force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 (CR ddb58ffa) ("8a79dd31-null-and-no-repopath-divert") -- two isolated shapes that both
  // pass JSON.parse but fail `reconcilePendingDivertTarget`'s (renamed by 6451a749) own `isReadableLatchRecord`/
  // `typeof parsed.repoPath === "string"` guard: the bare literal `null` (495fd320's own null-latch class),
  // and a syntactically valid object with no `repoPath` field at all. Both must divert, never overwrite.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const xNull = makeToplevelRepo("8a79dd31-nr-null-x");
  const pendingFileNull = pendingDivertFilenameForTest(xNull);
  const pendingPathNull = path.join(MERGE_QUARANTINE_DIR, pendingFileNull);
  fs.writeFileSync(pendingPathNull, "null\n");
  fs.rmSync(xNull, { recursive: true, force: true });
  const nullXToken = enterMergeQuarantine(xNull, "x-branch", "8a79dd31-null-and-no-repopath-divert: null-content occupant");
  check("*** THE FIX (8a79dd31-null-and-no-repopath-divert, null) *** the bare `null` bytes are BYTE-IDENTICAL, never touched",
    contentIfExists(pendingPathNull) === "null\n");
  check("(8a79dd31-null-and-no-repopath-divert, null) x's own raise still persists in-process", (() => {
    const t = new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
    return t.has(nullXToken);
  })());
  check("*** THE FIX (8a79dd31-null-and-no-repopath-divert, null) *** x's own entry landed at a DISTINCT collision-suffixed file", (() => {
    const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== pendingFileNull && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(nullXToken));
    return collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile);
  })());
  clearMergeQuarantineByToken(xNull, nullXToken);

  const xNoPath = makeToplevelRepo("8a79dd31-nr-nopath-x");
  const pendingFileNoPath = pendingDivertFilenameForTest(xNoPath);
  const pendingPathNoPath = path.join(MERGE_QUARANTINE_DIR, pendingFileNoPath);
  const noRepoPathBefore = JSON.stringify({ branch: "no-repopath-branch", reason: "8a79dd31-null-and-no-repopath-divert: a valid object with no repoPath field at all" }, null, 2) + "\n";
  fs.writeFileSync(pendingPathNoPath, noRepoPathBefore);
  fs.rmSync(xNoPath, { recursive: true, force: true });
  const noPathXToken = enterMergeQuarantine(xNoPath, "x-branch", "8a79dd31-null-and-no-repopath-divert: repoPath-less occupant");
  check("*** THE FIX (8a79dd31-null-and-no-repopath-divert, no-repoPath) *** the repoPath-less bytes are BYTE-IDENTICAL, never touched",
    contentIfExists(pendingPathNoPath) === noRepoPathBefore);
  check("(8a79dd31-null-and-no-repopath-divert, no-repoPath) x's own raise still persists in-process",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(noPathXToken));
  check("*** THE FIX (8a79dd31-null-and-no-repopath-divert, no-repoPath) *** x's own entry landed at a DISTINCT collision-suffixed file", (() => {
    const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== pendingFileNoPath && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(noPathXToken));
    return collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile);
  })());
  clearMergeQuarantineByToken(xNoPath, noPathXToken);
  // Cleanup: both garbage files have no identity attached (unparseable/identity-less) — same reason as
  // 8a79dd31-corrupt-json-diverts above; leaving them behind pollutes a LATER scenario's own boot scan.
  fs.rmSync(pendingPathNull, { force: true });
  fs.rmSync(pendingPathNoPath, { force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 (CR ddb58ffa) ("8a79dd31-eisdir-diverts") -- a DIRECTORY (never valid latch content in
  // this module) sits at the primary pending-divert path. Cheap to test directly: a directory can never be
  // read as latch JSON, so this must divert exactly like an unreadable file -- and, unlike the ACTIVE-final
  // EISDIR trap `8db913e2`'s own round 1 hit (where EISDIR means "nothing real, proceed"), a PENDING mint
  // target's own EISDIR is explicitly grouped with "never overwrite, never move" by this card's own ruling.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-ed-x");
  const pendingFile = pendingDivertFilenameForTest(x);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  fs.mkdirSync(pendingPath);

  fs.rmSync(x, { recursive: true, force: true });
  const xToken = enterMergeQuarantine(x, "x-branch", "8a79dd31-eisdir-diverts: x raises over a DIRECTORY at the primary path");

  check("*** THE FIX (8a79dd31-eisdir-diverts) *** the directory is left exactly as it was (never deleted, never replaced by a file)",
    fs.statSync(pendingPath).isDirectory());
  check("(8a79dd31-eisdir-diverts) x's own fresh raise still persists in-process (e1cb7d33 still holds)",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(xToken));
  check("*** THE FIX (8a79dd31-eisdir-diverts) *** x's own entry landed at a DISTINCT collision-suffixed file", (() => {
    const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== pendingFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(xToken));
    return collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile);
  })());

  clearMergeQuarantineByToken(x, xToken);
  fs.rmSync(pendingPath, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 8a79dd31 (CR ddb58ffa, real bug #1) ("8a79dd31-collision-tmp-residue-clearable-by-id") --
  // `pendingLatchIdFor` did not recognise a CRASH-LEFT torn-write residue of a collision filename
  // (`pending-<24hex>-collision-<8hex>.json.tmp-<pid>-<hex>` — `writePendingDivertFile`'s own tmp-then-
  // rename, interrupted before the rename). It fell through to the generic `.indexOf(".json")` cut,
  // producing a non-24-hex id that `clearMergeQuarantineLatchFile` then rejected outright as "invalid latch
  // id" — the latch could never be cleared by id at all. `PENDING_DIVERT_COLLISION_TMP_RE` fixes this by
  // hashing the whole basename, same posture as every other specially-shaped pending filename.
  //
  // The crash-left tmp is hand-crafted directly (standing in for a real process crash between
  // `writePendingDivertFile`'s own `fsyncSync`/`close` and `renameSync`) — recovered by PASS 1b's own
  // pre-existing, content-based "no resolvedKey, unresolvable" branch with ZERO code changes (the same
  // reason `PENDING_DIVERT_TMP_RE` needed none either).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = makeToplevelRepo("8a79dd31-ctr-x");
  const collisionFile = pendingDivertCollisionFilenameForTest(x);
  const crashTmpFile = `${collisionFile}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const crashTmpPath = path.join(MERGE_QUARANTINE_DIR, crashTmpFile);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(crashTmpPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "8a79dd31-collision-tmp-residue-clearable-by-id hand-crafted crash-left tmp",
    enteredAt: Date.now(), tokens: ["8a79dd31-ctr-token"],
  }, null, 2) + "\n");

  fs.rmSync(x, { recursive: true, force: true }); // x unresolvable -> PASS 1b defers it to pendingUnresolvedQuarantines.
  const freshCTR = await freshBootModule();
  freshCTR.reenterMergeQuarantinesAtBoot([x]);
  const recovered = freshCTR.activeMergeQuarantineFor(x);
  check("(8a79dd31-collision-tmp-residue-clearable-by-id precondition) PASS 1b recovered the crash-left tmp, token enforced",
    recovered !== undefined && recovered.tokens.includes("8a79dd31-ctr-token"));

  const ids = freshCTR.quarantineLatchFileIdsFor(recovered);
  check("*** THE FIX (8a79dd31-collision-tmp-residue-clearable-by-id) *** quarantineLatchFileIdsFor derives a valid 24-hex id (not the raw, non-hex basename)",
    ids.length === 1 && /^[0-9a-f]{24}$/.test(ids[0]));

  const clearResult = freshCTR.clearMergeQuarantineLatchFile(ids[0]);
  check("*** THE FIX (8a79dd31-collision-tmp-residue-clearable-by-id) *** clear-by-id succeeds (ok:true) rather than refusing as an invalid latch id",
    clearResult.ok === true);
  check("(8a79dd31-collision-tmp-residue-clearable-by-id) x is fully lifted after the clear", freshCTR.activeMergeQuarantineFor(x) === undefined);
  check("(8a79dd31-collision-tmp-residue-clearable-by-id) the crash-left tmp residue itself is swept off disk",
    !fs.existsSync(crashTmpPath));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 ("6451a749-never-scanned") -- CR ddb58ffa of 8a79dd31 found a THIRD writer of the
  // deterministic `pendingDivertFilenameFor(...)` path. `protectOccupantContentBeforeDelete` is reached
  // from `protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete` when a RAISE's
  // own guard-skipped write (e1cb7d33) is about to clobber a foreign/degraded occupant's physical `final`
  // -- its job is to copy that occupant's content aside, durably, to `pendingDivertFilenameFor
  // (occupantRepoPath)` before letting the write through. It used to trust ONLY the in-memory
  // `atFilenameIdx` lookup against `pendingUnresolvedQuarantines`, never reading whatever currently
  // occupies that deterministic filename ON DISK -- the exact 8a79dd31 bug shape, at the one call site
  // that card's own "Do not" section explicitly left unaudited (@decision 8db913e2, Follow-up 29fe2372's
  // own "Do not" section). THE FIX: it now routes through the SAME {@link reconcilePendingDivertTarget}
  // chokepoint {@link mintPendingDivert} uses (@decision 8db913e2, Follow-up 6451a749).
  //
  // Setup: D (a never-created subdir of R, unresolvable) sits at R's own key's physical `final` -- the
  // same "degraded occupant" shape SHAPE 1 (control, above) already exercises via this SAME call site. A
  // SEPARATE, independent same-identity record for D is hand-crafted directly at `pendingDivertFilenameFor
  // (d)` -- standing in for an earlier raise of D's own, diverted there, that this process's own
  // `pendingUnresolvedQuarantines` never scanned (no boot call for it ever ran) -- mirrors
  // 8a79dd31-fresh-divert/8a79dd31-divert-raise-entry's own "never scanned" setup, now for this THIRD
  // writer. R then raises (resolvable), reaching `enterMergeQuarantine`'s own "no existing" region's
  // `protectDegradedOccupantBeforeDelete` call, which finds D foreign at `final` and calls
  // `protectOccupantContentBeforeDelete`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("6451a749-ns-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir-6451a749-ns");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["6451a749-ns-current-token"],
  }, null, 2) + "\n");

  const occupantFile = pendingDivertFilenameForTest(d);
  const occupantPath = path.join(MERGE_QUARANTINE_DIR, occupantFile);
  const occupantContentBeforeNS = JSON.stringify({
    repoPath: d, branch: "d-earlier-branch", reason: "6451a749-never-scanned: D's own EARLIER, independent same-identity pending record, never scanned by this process",
    enteredAt: Date.now() - 100000, tokens: ["6451a749-ns-never-scanned-token"],
  }, null, 2) + "\n";
  fs.writeFileSync(occupantPath, occupantContentBeforeNS);
  check("(6451a749-never-scanned precondition) nothing in THIS process tracks the never-scanned token yet",
    !new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has("6451a749-ns-never-scanned-token"));

  const rToken = enterMergeQuarantine(r, "r-branch", "6451a749-never-scanned: r raises, triggering protectDegradedOccupantBeforeDelete for D");

  check("(6451a749-never-scanned) R's own write lands directly at `final` (the existing, legitimate-overwrite path, unaffected by this card)",
    (contentIfExists(finalPath) ?? "").includes(rToken));
  check("*** THE FIX (6451a749-never-scanned) *** the never-scanned occupant's own token SURVIVES byte-for-byte (same identity -> unioned by reconcilePendingDivertTarget, never overwritten)",
    (contentIfExists(occupantPath) ?? "").includes("6451a749-ns-never-scanned-token"));
  check("(6451a749-never-scanned) the never-scanned occupant's own PRE-EXISTING branch/reason survive the union too (not just tokens)",
    (contentIfExists(occupantPath) ?? "").includes("d-earlier-branch"));

  const freshNS = await freshBootModule();
  freshNS.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootNS = new Set(freshNS.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-never-scanned, reboot) *** BOTH the never-scanned occupant's own token AND R's own token survive a fresh-process reboot",
    tokensAfterRebootNS.has("6451a749-ns-never-scanned-token") && tokensAfterRebootNS.has(rToken));

  freshNS.clearMergeQuarantineByToken(r, rToken);
  freshNS.clearMergeQuarantineByToken(d, "6451a749-ns-current-token");
  freshNS.clearMergeQuarantineByToken(d, "6451a749-ns-never-scanned-token");
  freshNS.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 ("6451a749-collision-file") -- once an identity's own pending-divert record lives at a
  // `-collision-` file (8a79dd31's own fix: a genuinely different identity occupies the primary
  // `pendingDivertFilenameFor` slot, so a LATER raise diverts elsewhere rather than overwriting it),
  // `protectOccupantContentBeforeDelete`'s OLD primary-name-only lookup could never find that collision
  // record. When this SAME identity was LATER discovered as a foreign degraded occupant at some OTHER
  // key's `final`, protect's blind write to the PRIMARY filename destroyed the very occupant 8a79dd31's
  // own reconcile had specifically refused to touch there. THE FIX: the SAME shared
  // {@link reconcilePendingDivertTarget} chokepoint never overwrites a primary occupied by a different
  // identity (@decision 8db913e2, Follow-up 6451a749).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r2 = makeToplevelRepo("6451a749-cf-r2");
  const foreign = makeToplevelRepo("6451a749-cf-foreign");
  const d = path.join(r2, "gone-subdir-6451a749-cf");

  // Hand-craft a GENUINELY FOREIGN occupant at D's own primary pending-divert filename -- a true
  // hash-of-identity collision stand-in, same pattern as 8a79dd31-different-identity-diverts.
  const primaryFile = pendingDivertFilenameForTest(d);
  const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "6451a749-collision-file hand-crafted FOREIGN occupant at D's own primary pending-divert filename",
    enteredAt: Date.now(), tokens: ["6451a749-cf-foreign-token"],
  }, null, 2) + "\n";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(primaryPath, foreignContentBefore);

  // D raises directly -- unresolvable (never created), reaches the brand-new divert branch. 8a79dd31's
  // own fix diverts D's own fresh record to a DISTINCT collision filename, leaving the foreign occupant's
  // own primary file byte-untouched.
  const dToken1 = enterMergeQuarantine(d, "d-branch-1", "6451a749-collision-file: d raises over a GENUINELY FOREIGN occupant, diverts to a collision file");
  check("(6451a749-collision-file precondition) the foreign occupant's own primary file is byte-identical after D's own divert",
    contentIfExists(primaryPath) === foreignContentBefore);
  const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== primaryFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(dToken1));
  check("(6451a749-collision-file precondition) D's own record now lives at a DISTINCT collision-suffixed file, never the primary",
    collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile));

  // An EARLIER, INDEPENDENT same-identity record for D, hand-crafted directly at R2's own canonical key's
  // physical `final` -- standing in for an earlier raise of D's that happened to walk up to R2's own key
  // (the same "degraded occupant" shape every other scenario in this file uses; `d4b25feb`'s own
  // established "one identity, two independent records" shape covers D legitimately holding both this
  // AND the collision record above at once).
  const Kr2 = canonicalRepoLockKey(r2);
  const Kr2hash = createHash("sha256").update(Kr2).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Kr2hash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-earlier-branch", reason: "D's own EARLIER degraded entry, walked up to R2's own real key",
    enteredAt: Date.now() - 200000, tokens: ["6451a749-cf-earlier-token"],
  }, null, 2) + "\n");

  const r2Token = enterMergeQuarantine(r2, "r2-branch", "6451a749-collision-file: r2 raises, triggering protectDegradedOccupantBeforeDelete for D whose own record now lives at a collision file");

  check("(6451a749-collision-file) R2's own write lands directly at its own `final` (the existing, legitimate-overwrite path, unaffected by this card)",
    (contentIfExists(finalPath) ?? "").includes(r2Token));
  check("*** THE FIX (6451a749-collision-file) *** the foreign occupant's own file, which 8a79dd31's own reconcile specifically refused to touch, stays BYTE-IDENTICAL -- never overwritten by protectOccupantContentBeforeDelete",
    contentIfExists(primaryPath) === foreignContentBefore);
  // Note: the foreign occupant's own token was NEVER scanned into THIS process's own
  // `pendingUnresolvedQuarantines` (by design, matching the never-scanned-occupant shape) -- so it was
  // never going to appear in `listActiveMergeQuarantines()` (a purely in-memory read) either before or
  // after this card's own fix. The byte-identical check above, plus the reboot check below (which DOES
  // scan disk fresh), are what actually discriminate the fix -- not an in-process-only read here.

  const freshCF = await freshBootModule();
  freshCF.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootCF = new Set(freshCF.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-collision-file, reboot) *** the foreign occupant's own token SURVIVES a fresh-process reboot",
    tokensAfterRebootCF.has("6451a749-cf-foreign-token"));
  check("(6451a749-collision-file, reboot) D's own collision-file record and R2's own token both survive regardless",
    tokensAfterRebootCF.has(dToken1) && tokensAfterRebootCF.has(r2Token));

  freshCF.clearMergeQuarantineByToken(r2, r2Token);
  freshCF.clearMergeQuarantineByToken(d, dToken1);
  freshCF.clearMergeQuarantineByToken(d, "6451a749-cf-earlier-token");
  freshCF.clearMergeQuarantineByToken(foreign, "6451a749-cf-foreign-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 ("6451a749-collision-reuse") -- manager ruling: a REPEATED collision against the SAME
  // primary occupant, for the SAME identity, must UNION into the EXISTING collision file rather than
  // minting an unbounded number of fresh ones. Two independent degraded-occupant records for ONE identity
  // X (the SAME "one identity, two independent records" shape 6451a749-collision-file above already
  // uses), discovered via TWO separate resolvable repos' own clears, each reach
  // `protectOccupantContentBeforeDelete` -> `reconcilePendingDivertTarget`'s own disk-based
  // `findExistingSameIdentityCollisionFile` scan -- which never depends on in-memory bookkeeping, so this
  // is exercised identically whether or not the SAME process happened to track the first collision file.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = path.join(os.tmpdir(), `loom-mqrpf-6451a749-cr-x-nonexistent-${freshSfx()}`);
  const foreign = makeToplevelRepo("6451a749-cr-foreign");
  const primaryFile = pendingDivertFilenameForTest(x);
  const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "6451a749-collision-reuse hand-crafted FOREIGN occupant at X's own primary pending-divert filename",
    enteredAt: Date.now(), tokens: ["6451a749-cr-foreign-token"],
  }, null, 2) + "\n";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(primaryPath, foreignContentBefore);

  // FIRST independent degraded record for X, discovered via R1's own clear -- mints a fresh collision file.
  const r1 = makeToplevelRepo("6451a749-cr-r1");
  const Kr1 = canonicalRepoLockKey(r1);
  const Kr1hash = createHash("sha256").update(Kr1).digest("hex").slice(0, 24);
  const final1Path = path.join(MERGE_QUARANTINE_DIR, `${Kr1hash}.json`);
  fs.writeFileSync(final1Path, JSON.stringify({
    repoPath: x, branch: "x-branch-a", reason: "X's own FIRST degraded entry, walked up to R1's own real key",
    enteredAt: Date.now() - 300000, tokens: ["6451a749-cr-token-a"],
  }, null, 2) + "\n");
  const r1Token = enterMergeQuarantine(r1, "r1-branch", "6451a749-collision-reuse: r1 raises, X's first record diverts to a fresh collision file");
  const collisionFile1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== primaryFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes("6451a749-cr-token-a"));
  check("(6451a749-collision-reuse precondition) X's first record minted a DISTINCT collision-suffixed file",
    collisionFile1 !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile1));

  // SECOND, INDEPENDENT degraded record for the SAME identity X, discovered via R2's own clear -- must
  // UNION into collisionFile1, never mint a second collision file.
  const r2 = makeToplevelRepo("6451a749-cr-r2");
  const Kr2 = canonicalRepoLockKey(r2);
  const Kr2hash = createHash("sha256").update(Kr2).digest("hex").slice(0, 24);
  const final2Path = path.join(MERGE_QUARANTINE_DIR, `${Kr2hash}.json`);
  fs.writeFileSync(final2Path, JSON.stringify({
    repoPath: x, branch: "x-branch-b", reason: "X's own SECOND, independent degraded entry, walked up to R2's own real key",
    enteredAt: Date.now() - 100000, tokens: ["6451a749-cr-token-b"],
  }, null, 2) + "\n");
  const r2Token = enterMergeQuarantine(r2, "r2-branch", "6451a749-collision-reuse: r2 raises, X's second record must union into the EXISTING collision file");

  const collisionFilesForX = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${primaryFile.slice(0, -".json".length)}-collision-`) && f.endsWith(".json"));
  check("*** THE FIX (6451a749-collision-reuse) *** exactly ONE collision file exists for X's own identity -- never two",
    collisionFilesForX.length === 1 && collisionFilesForX[0] === collisionFile1);
  check("*** THE FIX (6451a749-collision-reuse) *** that ONE collision file carries BOTH independent tokens",
    (() => {
      const c = contentIfExists(path.join(MERGE_QUARANTINE_DIR, collisionFile1)) ?? "";
      return c.includes("6451a749-cr-token-a") && c.includes("6451a749-cr-token-b");
    })());
  check("(6451a749-collision-reuse) the foreign occupant's own primary file stays byte-identical throughout",
    contentIfExists(primaryPath) === foreignContentBefore);
  check("(6451a749-collision-reuse) both R1's and R2's own raises land directly at their OWN `final` (unaffected by this card)",
    (contentIfExists(final1Path) ?? "").includes(r1Token) && (contentIfExists(final2Path) ?? "").includes(r2Token));

  const freshCR = await freshBootModule();
  freshCR.reenterMergeQuarantinesAtBoot([foreign]);
  const tokensAfterRebootCR = new Set(freshCR.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-collision-reuse, reboot) *** BOTH of X's own tokens survive a fresh-process reboot, as ONE record",
    tokensAfterRebootCR.has("6451a749-cr-token-a") && tokensAfterRebootCR.has("6451a749-cr-token-b"));
  check("(6451a749-collision-reuse, reboot) the foreign occupant's own token also survives, unaffected",
    tokensAfterRebootCR.has("6451a749-cr-foreign-token"));

  freshCR.clearMergeQuarantineByToken(r1, r1Token);
  freshCR.clearMergeQuarantineByToken(r2, r2Token);
  freshCR.clearMergeQuarantineByToken(x, "6451a749-cr-token-a");
  freshCR.clearMergeQuarantineByToken(x, "6451a749-cr-token-b");
  freshCR.clearMergeQuarantineByToken(foreign, "6451a749-cr-foreign-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 (Code Review 45c8250c, CRITICAL, Round 2) -- a fail-OPEN regression in this card's own
  // Round 1 fix. protectOccupantContentBeforeDelete's new chokepoint union read ONLY the fresh disk
  // content at `filename`, then OVERWROTE the in-memory record at `atFilenameIdx` with that disk-only
  // result. An in-memory record can legitimately hold MORE tokens than its own physical backing file
  // RIGHT NOW -- an EARLIER durable write for the SAME identity already failed ("quarantined IN THIS
  // PROCESS ONLY": D's own SECOND raise, via `mergeTokenIntoPendingEntries`, has no safety-tmp fallback
  // at all -- a failed rewrite leaves `merged` enforced purely in memory, at its own pre-existing
  // `sourceFile`, with the physical file never touched). THE FIX (Round 2): also union the in-memory
  // record at `atFilenameIdx` (never `atFinalBasenameIdx` -- `c9114934` forbids only that one) ON TOP of
  // the disk-reconciled result, rather than letting the chokepoint's own disk read REPLACE it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const d = path.join(os.tmpdir(), `loom-mqrpf-6451a749-im-d-nonexistent-${freshSfx()}`);
  const pendingFile = pendingDivertFilenameForTest(d);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);

  const tD1 = enterMergeQuarantine(d, "d-branch-1", "6451a749-inmemory: D's first raise, mints a fresh pending-divert file");
  check("(6451a749-inmemory precondition) D's first token is durably on disk",
    (contentIfExists(pendingPath) ?? "").includes(tD1));

  // D raises AGAIN while every open of `pendingPath` (and its own write-tmp) fails. This reaches
  // `mergeTokenIntoPendingEntries` (D is still unresolvable, and its own first pending entry already
  // matches by identity) -- that function's own failed-write branch has NO safety-tmp fallback at all,
  // so `merged` (tD1+tD2) is pushed into `pendingUnresolvedQuarantines` regardless of the write's own
  // outcome, leaving it enforced IN MEMORY ONLY while the physical file still holds just tD1.
  const injectD = injectOpenSyncFailureForPrefix(pendingPath);
  let tD2;
  try {
    tD2 = enterMergeQuarantine(d, "d-branch-2", "6451a749-inmemory: D's second raise, the rewrite fails with no safety-tmp fallback");
  } finally {
    injectD.restore();
  }
  check("(6451a749-inmemory precondition) D's second token is tracked IN-PROCESS", (() => {
    const e = activeMergeQuarantineFor(d);
    return !!e && e.tokens.includes(tD1) && e.tokens.includes(tD2);
  })());
  check("(6451a749-inmemory precondition) D's second token did NOT reach disk (the failed rewrite is real, not vacuous)",
    !(contentIfExists(pendingPath) ?? "").includes(tD2));

  // D's own EARLIER, INDEPENDENT degraded record is discovered at R's own key (the same shape every
  // other scenario in this file uses) -- R raises, triggering protectOccupantContentBeforeDelete for D,
  // whose in-memory record (tD1+tD2) now outruns its own on-disk backing (tD1 only).
  const r = makeToplevelRepo("6451a749-im-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-earlier-branch", reason: "D's own EARLIER degraded entry, walked up to R's own real key",
    enteredAt: Date.now() - 300000, tokens: ["6451a749-im-current-token"],
  }, null, 2) + "\n");
  const rToken = enterMergeQuarantine(r, "r-branch", "6451a749-inmemory: r raises, triggering protectDegradedOccupantBeforeDelete for D");

  check("*** THE FIX (6451a749-inmemory) *** D's own second token (held in memory only before this raise) is now durably written to disk, never silently dropped",
    (contentIfExists(pendingPath) ?? "").includes(tD2));
  check("(6451a749-inmemory) D's first token AND the newly-discovered current token also survive the union",
    (() => {
      const c = contentIfExists(pendingPath) ?? "";
      return c.includes(tD1) && c.includes("6451a749-im-current-token");
    })());
  check("*** THE FIX (6451a749-inmemory) *** D's own second token is STILL tracked IN-PROCESS after the raise (never dropped by the re-point)",
    (activeMergeQuarantineFor(d)?.tokens ?? []).includes(tD2));

  const freshIM = await freshBootModule();
  freshIM.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootIM = new Set(freshIM.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-inmemory, reboot) *** D's own second token (previously held in memory only) survives a fresh-process reboot",
    tokensAfterRebootIM.has(tD2));
  check("(6451a749-inmemory, reboot) D's first token, D's own current token, and R's own token all survive too",
    tokensAfterRebootIM.has(tD1) && tokensAfterRebootIM.has("6451a749-im-current-token") && tokensAfterRebootIM.has(rToken));

  freshIM.clearMergeQuarantineByToken(d, tD1);
  freshIM.clearMergeQuarantineByToken(d, tD2);
  freshIM.clearMergeQuarantineByToken(d, "6451a749-im-current-token");
  freshIM.clearMergeQuarantineByToken(r, rToken);
  freshIM.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 (Code Review 45c8250c, Round 2, test gap) -- a COLLISION-TARGET variant of
  // `6451a749-inmemory` above: the SAME in-memory-outruns-disk shape, but D's own pending record lives at
  // a `-collision-` file (because a foreign identity occupies D's own PRIMARY slot) rather than the
  // primary filename itself. `atFilenameIdx`'s own fold must key off whatever `reconcilePendingDivertTarget`
  // ACTUALLY resolves to -- proving the fold is not accidentally scoped to the primary-filename case alone.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const d = path.join(os.tmpdir(), `loom-mqrpf-6451a749-imc-d-nonexistent-${freshSfx()}`);
  const foreign = makeToplevelRepo("6451a749-imc-foreign");
  const primaryFile = pendingDivertFilenameForTest(d);
  const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "6451a749-inmemory-collision hand-crafted FOREIGN occupant at D's own primary pending-divert filename",
    enteredAt: Date.now(), tokens: ["6451a749-imc-foreign-token"],
  }, null, 2) + "\n";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(primaryPath, foreignContentBefore);

  // D raises -- its own primary slot is occupied by a GENUINELY different identity, so this diverts to a
  // fresh collision file (8a79dd31's own rule), never the primary.
  const tD1 = enterMergeQuarantine(d, "d-branch-1", "6451a749-inmemory-collision: D's first raise, diverts to a fresh collision file");
  const collisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== primaryFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(tD1));
  check("(6451a749-inmemory-collision precondition) D's first record lives at a DISTINCT collision-suffixed file, never the primary",
    collisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(collisionFile));
  const collisionPath = path.join(MERGE_QUARANTINE_DIR, collisionFile);

  // D raises AGAIN while every open of its own COLLISION file (not the primary) fails -- the SAME
  // `mergeTokenIntoPendingEntries` shape as `6451a749-inmemory` above, just at a different physical name.
  const injectD = injectOpenSyncFailureForPrefix(collisionPath);
  let tD2;
  try {
    tD2 = enterMergeQuarantine(d, "d-branch-2", "6451a749-inmemory-collision: D's second raise, the collision-file rewrite fails with no safety-tmp fallback");
  } finally {
    injectD.restore();
  }
  check("(6451a749-inmemory-collision precondition) D's second token is tracked IN-PROCESS", (() => {
    const e = activeMergeQuarantineFor(d);
    return !!e && e.tokens.includes(tD1) && e.tokens.includes(tD2);
  })());
  check("(6451a749-inmemory-collision precondition) D's second token did NOT reach the collision file on disk (the failed rewrite is real, not vacuous)",
    !(contentIfExists(collisionPath) ?? "").includes(tD2));

  // D's own EARLIER, INDEPENDENT degraded record is discovered at R's own key -- R raises, triggering
  // protectOccupantContentBeforeDelete for D, whose in-memory record (tD1+tD2, at the COLLISION file) now
  // outruns that collision file's own on-disk backing (tD1 only). The primary is STILL occupied by
  // `foreign`, unchanged, so `reconcilePendingDivertTarget` must resolve back to the SAME collision file
  // (via `findExistingSameIdentityCollisionFile`) for the fold to even have something to key off.
  const r = makeToplevelRepo("6451a749-imc-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-earlier-branch", reason: "D's own EARLIER degraded entry, walked up to R's own real key",
    enteredAt: Date.now() - 300000, tokens: ["6451a749-imc-current-token"],
  }, null, 2) + "\n");
  const rToken = enterMergeQuarantine(r, "r-branch", "6451a749-inmemory-collision: r raises, triggering protectDegradedOccupantBeforeDelete for D");

  check("(6451a749-inmemory-collision) the foreign occupant's own primary file is byte-identical throughout",
    contentIfExists(primaryPath) === foreignContentBefore);
  check("*** THE FIX (6451a749-inmemory-collision) *** D's own second token (held in memory only, at the COLLISION file) is now durably written to disk, never silently dropped",
    (contentIfExists(collisionPath) ?? "").includes(tD2));
  check("(6451a749-inmemory-collision) D's first token AND the newly-discovered current token also survive the union",
    (() => {
      const c = contentIfExists(collisionPath) ?? "";
      return c.includes(tD1) && c.includes("6451a749-imc-current-token");
    })());
  check("*** THE FIX (6451a749-inmemory-collision) *** D's own second token is STILL tracked IN-PROCESS after the raise",
    (activeMergeQuarantineFor(d)?.tokens ?? []).includes(tD2));

  const freshIMC = await freshBootModule();
  freshIMC.reenterMergeQuarantinesAtBoot([foreign]);
  const tokensAfterRebootIMC = new Set(freshIMC.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-inmemory-collision, reboot) *** D's own second token (previously held in memory only at the collision file) survives a fresh-process reboot",
    tokensAfterRebootIMC.has(tD2));
  check("(6451a749-inmemory-collision, reboot) D's first token, D's own current token, R's own token, and the foreign occupant's own token all survive too",
    tokensAfterRebootIMC.has(tD1) && tokensAfterRebootIMC.has("6451a749-imc-current-token") && tokensAfterRebootIMC.has(rToken) && tokensAfterRebootIMC.has("6451a749-imc-foreign-token"));

  freshIMC.clearMergeQuarantineByToken(d, tD1);
  freshIMC.clearMergeQuarantineByToken(d, tD2);
  freshIMC.clearMergeQuarantineByToken(d, "6451a749-imc-current-token");
  freshIMC.clearMergeQuarantineByToken(r, rToken);
  freshIMC.clearMergeQuarantineByToken(foreign, "6451a749-imc-foreign-token");
  freshIMC.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 (Code Review 45c8250c, Minor #2) -- the double-fault `kept` fallback (the chosen write
  // ALSO fails) must carry TOKENS forward from the unioned `toWrite` (fail-closed), but must NEVER borrow
  // `orphanLatchFiles` from it: `toWrite` can list files belonging to WHATEVER OTHER record lives at
  // `filename` (the on-disk occupant, or a folded in-memory entry) -- `kept` is self-owned at
  // `finalBasename`, a DIFFERENT physical file, and a later clear of `kept` must never sweep a file that
  // other record still legitimately references. `orphanLatchFiles` is scoped to `toPersist` instead --
  // `final`'s own content, which genuinely belongs to `kept`'s own lineage.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const d = path.join(os.tmpdir(), `loom-mqrpf-6451a749-of-d-nonexistent-${freshSfx()}`);
  const pendingFile = pendingDivertFilenameForTest(d);
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingFile);
  const foreignOrphanRef = "6451a749-of-foreign-orphan-ref.json";
  const foreignOrphanPath = path.join(MERGE_QUARANTINE_DIR, foreignOrphanRef);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // A dummy file standing in for content some OTHER, still-live record genuinely owns -- never created
  // or owned by this scenario's own D/R identities.
  fs.writeFileSync(foreignOrphanPath, "not D's own content\n");

  // D's own PRE-EXISTING pending-divert record already carries an orphan reference of its OWN (standing
  // in for an earlier, legitimate sibling-absorb) -- this is what `toWrite`'s own disk-union would pull
  // forward, and what `kept` must NOT inherit.
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: d, branch: "d-prior-branch", reason: "6451a749-double-fault-orphan-scope: D's own prior pending record, carrying an orphan reference",
    enteredAt: Date.now() - 100000, tokens: ["6451a749-of-prior-token"], orphanLatchFiles: [foreignOrphanRef],
  }, null, 2) + "\n");

  const r = makeToplevelRepo("6451a749-of-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-current-branch", reason: "D's own CURRENT degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["6451a749-of-current-token"],
  }, null, 2) + "\n");

  // Force the chosen write (to `pendingPath`, the SAME primary filename) to fail -- the double fault.
  const injectOF = injectOpenSyncFailureForPrefix(pendingPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "6451a749-double-fault-orphan-scope: r raises, protect's own chosen write fails");
  } finally {
    injectOF.restore();
  }
  check("(6451a749-double-fault-orphan-scope precondition) the write was actually attempted (and injected to fail)", injectOF.count() >= 1);

  const kept = activeMergeQuarantineFor(d);
  check("*** THE FIX (6451a749-double-fault-orphan-scope) *** `kept` carries BOTH tokens forward (fail-closed)",
    !!kept && kept.tokens.includes("6451a749-of-prior-token") && kept.tokens.includes("6451a749-of-current-token"));
  check("*** THE FIX (6451a749-double-fault-orphan-scope) *** `kept` does NOT borrow the foreign orphan reference it never owned",
    !!kept && !(kept.orphanLatchFiles ?? []).includes(foreignOrphanRef));
  check("(6451a749-double-fault-orphan-scope) `kept` DOES self-reference `final`'s own basename",
    !!kept && (kept.orphanLatchFiles ?? []).includes(path.basename(finalPath)));
  check("(6451a749-double-fault-orphan-scope) the foreign orphan file itself is untouched on disk (never swept, never owned)",
    contentIfExists(foreignOrphanPath) === "not D's own content\n");
  check("(6451a749-double-fault-orphan-scope) r's own raise still persists in-process despite the double fault",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(rToken));

  // Drive the actual HARM this pin exists to prevent, not just the field shape above: clearing `kept`'s
  // own LAST token reaches `clearTokenFromPendingIndices`'s own last-token branch, which sweeps every
  // file listed in THAT entry's own `orphanLatchFiles` that nothing else references
  // (`sweepOrphanLatchFileIfUnreferenced`). If `kept` wrongly inherited the foreign reference (the
  // reverted shape this pin guards against), this sweep is what would actually delete the foreign file
  // -- the field-shape checks above cannot see that on their own; this is Control B's own discriminator.
  clearMergeQuarantineByToken(d, "6451a749-of-prior-token"); // partial clear -- one token remains, no sweep yet
  clearMergeQuarantineByToken(d, "6451a749-of-current-token"); // the LAST token -- triggers the orphan sweep
  check("*** THE FIX (6451a749-double-fault-orphan-scope) *** clearing `kept`'s own LAST token does NOT sweep the foreign orphan file it never owned",
    fs.existsSync(foreignOrphanPath));

  clearMergeQuarantineByToken(r, rToken);
  fs.rmSync(foreignOrphanPath, { force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 (Code Review 45c8250c, Minor #3a) -- pin the MINT path's own collision reuse
  // (`mintPendingDivert` -> `reconcilePendingDivertTarget` -> `findExistingSameIdentityCollisionFile`).
  // The earlier `6451a749-collision-reuse` scenario above exercises this ONLY via
  // `protectOccupantContentBeforeDelete`; this scenario drives it via a fresh RAISE instead, mirroring
  // 8a79dd31-fresh-divert's own "never scanned" setup for the COLLISION file specifically.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = path.join(os.tmpdir(), `loom-mqrpf-6451a749-mr-x-nonexistent-${freshSfx()}`);
  const foreign = makeToplevelRepo("6451a749-mr-foreign");
  const primaryFile = pendingDivertFilenameForTest(x);
  const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
  const foreignContentBefore = JSON.stringify({
    repoPath: foreign, branch: "foreign-branch", reason: "6451a749-mint-reuse hand-crafted FOREIGN occupant at X's own primary pending-divert filename",
    enteredAt: Date.now(), tokens: ["6451a749-mr-foreign-token"],
  }, null, 2) + "\n";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(primaryPath, foreignContentBefore);

  // A collision file for X's OWN identity, hand-crafted directly -- standing in for an earlier mint by a
  // DIFFERENT process, never scanned into THIS process's own pendingUnresolvedQuarantines.
  const existingCollisionFile = pendingDivertCollisionFilenameForTest(x);
  const existingCollisionPath = path.join(MERGE_QUARANTINE_DIR, existingCollisionFile);
  fs.writeFileSync(existingCollisionPath, JSON.stringify({
    repoPath: x, branch: "x-earlier-branch", reason: "6451a749-mint-reuse: X's own earlier collision record, never scanned by this process",
    enteredAt: Date.now() - 100000, tokens: ["6451a749-mr-existing-token"],
  }, null, 2) + "\n");

  // X raises directly -- unresolvable, never scanned anywhere -> reaches `mintPendingDivert` via
  // `enterMergeQuarantine`'s own brand-new-unresolvable branch (NOT `protectOccupantContentBeforeDelete`).
  const xToken = enterMergeQuarantine(x, "x-branch", "6451a749-mint-reuse: x raises, must UNION into the EXISTING collision file via the mint path");

  check("*** THE FIX (6451a749-mint-reuse) *** the foreign occupant's own primary file is byte-identical, never touched",
    contentIfExists(primaryPath) === foreignContentBefore);
  const collisionFilesForX = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${primaryFile.slice(0, -".json".length)}-collision-`) && f.endsWith(".json"));
  check("*** THE FIX (6451a749-mint-reuse) *** exactly ONE collision file exists for X's own identity -- the EXISTING one, never a second",
    collisionFilesForX.length === 1 && collisionFilesForX[0] === existingCollisionFile);
  check("*** THE FIX (6451a749-mint-reuse) *** that file carries BOTH the earlier and the fresh token",
    (() => {
      const c = contentIfExists(existingCollisionPath) ?? "";
      return c.includes("6451a749-mr-existing-token") && c.includes(xToken);
    })());

  const freshMR = await freshBootModule();
  freshMR.reenterMergeQuarantinesAtBoot([foreign]);
  const tokensAfterRebootMR = new Set(freshMR.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (6451a749-mint-reuse, reboot) *** BOTH of X's own tokens survive a fresh-process reboot, as ONE record",
    tokensAfterRebootMR.has("6451a749-mr-existing-token") && tokensAfterRebootMR.has(xToken));

  freshMR.clearMergeQuarantineByToken(x, "6451a749-mr-existing-token");
  freshMR.clearMergeQuarantineByToken(x, xToken);
  freshMR.clearMergeQuarantineByToken(foreign, "6451a749-mr-foreign-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 6451a749 (Code Review 45c8250c, Minor #3b) -- a NEGATIVE CONTROL for the mint-reuse scan above:
  // 8a79dd31's own "different identity -> fresh collision file, never overwrite/reuse" rule must still
  // hold when `findExistingSameIdentityCollisionFile`'s OWN scan finds a collision-suffixed file sitting
  // at X's own deterministic prefix, but whose CONTENT names a GENUINELY DIFFERENT identity (a true
  // hash-of-identity collision stand-in, same pattern 8a79dd31-different-identity-diverts already uses at
  // the primary slot -- here it's the COLLISION slot instead). The scan must SKIP it (content mismatch)
  // and mint a brand-new collision file for X, never reuse or touch the mismatched one.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const x = path.join(os.tmpdir(), `loom-mqrpf-6451a749-mrn-x-nonexistent-${freshSfx()}`);
  const foreign1 = makeToplevelRepo("6451a749-mrn-foreign1");
  const foreign2 = makeToplevelRepo("6451a749-mrn-foreign2");
  const primaryFile = pendingDivertFilenameForTest(x);
  const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
  const foreign1ContentBefore = JSON.stringify({
    repoPath: foreign1, branch: "foreign1-branch", reason: "6451a749-mint-reuse-negative hand-crafted FOREIGN occupant at X's own primary filename",
    enteredAt: Date.now(), tokens: ["6451a749-mrn-foreign1-token"],
  }, null, 2) + "\n";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(primaryPath, foreign1ContentBefore);

  // A collision-suffixed file sitting at X's OWN deterministic prefix, but its content names a WHOLLY
  // DIFFERENT identity (foreign2) -- the true-hash-of-identity-collision stand-in, now at the collision
  // slot rather than the primary one.
  const mismatchedCollisionFile = pendingDivertCollisionFilenameForTest(x);
  const mismatchedCollisionPath = path.join(MERGE_QUARANTINE_DIR, mismatchedCollisionFile);
  const foreign2ContentBefore = JSON.stringify({
    repoPath: foreign2, branch: "foreign2-branch", reason: "6451a749-mint-reuse-negative hand-crafted FOREIGN occupant AT X's own collision-prefixed filename",
    enteredAt: Date.now(), tokens: ["6451a749-mrn-foreign2-token"],
  }, null, 2) + "\n";
  fs.writeFileSync(mismatchedCollisionPath, foreign2ContentBefore);

  const xToken = enterMergeQuarantine(x, "x-branch", "6451a749-mint-reuse-negative: x raises, the collision-slot occupant is a content mismatch -> must mint fresh");

  check("(6451a749-mint-reuse-negative) foreign1's own primary file is byte-identical, never touched",
    contentIfExists(primaryPath) === foreign1ContentBefore);
  check("*** THE FIX (6451a749-mint-reuse-negative) *** the content-mismatched collision-slot occupant (foreign2) is byte-identical, NEVER reused or touched",
    contentIfExists(mismatchedCollisionPath) === foreign2ContentBefore);
  const freshCollisionFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f !== primaryFile && f !== mismatchedCollisionFile && contentIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.includes(xToken));
  check("*** THE FIX (6451a749-mint-reuse-negative) *** x's own entry landed at a DISTINCT, BRAND-NEW collision file -- never the mismatched one",
    freshCollisionFile !== undefined && /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/.test(freshCollisionFile));

  const freshMRN = await freshBootModule();
  freshMRN.reenterMergeQuarantinesAtBoot([foreign1, foreign2]);
  const tokensAfterRebootMRN = new Set(freshMRN.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("(6451a749-mint-reuse-negative, reboot) ALL THREE tokens survive, as three separate records",
    tokensAfterRebootMRN.has(xToken) && tokensAfterRebootMRN.has("6451a749-mrn-foreign1-token") && tokensAfterRebootMRN.has("6451a749-mrn-foreign2-token"));

  freshMRN.clearMergeQuarantineByToken(x, xToken);
  freshMRN.clearMergeQuarantineByToken(foreign1, "6451a749-mrn-foreign1-token");
  freshMRN.clearMergeQuarantineByToken(foreign2, "6451a749-mrn-foreign2-token");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 37452ddd ("37452ddd-twin-repoint") -- protectOccupantContentBeforeDelete's own re-point of
  // pendingUnresolvedQuarantines[atFilenameIdx] used to reassign that array slot directly, never through
  // replaceEntryEverywhere -- unlike mergeTokenIntoPendingEntries (@decision 64283e06), which already
  // knows a matched pending entry can be an 883e29bc boot-diverted TWIN (the SAME object reference ALSO
  // armed in activeQuarantines). Setup: TWO independent on-disk latch files for one unresolvable identity
  // D, both recording resolvedKey=Ks (S's own canonical key) -- one at the ordinary hash-named final
  // (Kshash.json), one at D's own deterministic pending-divert filename. PASS 1 scans every .json file by
  // CONTENT (filename-agnostic), so both resolve to the same degraded identity at the same resolvedKey;
  // armKeyUnlessDegradedCollision's same-identity union (plus its own degradedDivertsToFlush rebind)
  // converges both onto ONE merged object -- armed in activeQuarantines[Ks] AND present in
  // pendingUnresolvedQuarantines TWICE (once per sourceFile): this IS the twin. A THIRD, unrelated
  // occupant file for D is written directly to R's own key (never scanned into this process), and R
  // raises -- reaching protectOccupantContentBeforeDelete via the "no existing" front door, which finds
  // the twin at atFilenameIdx (sourceFile === D's own pending-divert path). THE FIX: route the re-point
  // through replaceEntryEverywhere, exactly like mergeTokenIntoPendingEntries (@decision 8db913e2,
  // Follow-up 37452ddd).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("37452ddd-tr-s");
  const Ks = canonicalRepoLockKey(s);
  const Kshash = createHash("sha256").update(Ks).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-37452ddd-tr-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KsFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kshash}.json`);
  fs.writeFileSync(KsFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "37452ddd-twin-repoint: D degraded, walked up to S's own key",
    enteredAt: Date.now(), tokens: ["37452ddd-tr-tok-b"], resolvedKey: Ks,
  }, null, 2) + "\n");

  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d));
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: d, branch: "d-branch-earlier", reason: "37452ddd-twin-repoint: D's own earlier record, also resolvedKey=S's key",
    enteredAt: Date.now() - 100000, tokens: ["37452ddd-tr-tok-c"], resolvedKey: Ks,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);

  check("(37452ddd-twin-repoint precondition) the TWIN exists: D armed at S's own key with both tokens unioned",
    (() => {
      const direct = activeMergeQuarantineFor(s);
      return !!direct && direct.repoPath === d && new Set(direct.tokens).has("37452ddd-tr-tok-b") && new Set(direct.tokens).has("37452ddd-tr-tok-c");
    })());

  const r = makeToplevelRepo("37452ddd-tr-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch-2", reason: "37452ddd-twin-repoint: D's own SECOND, independent degraded occupant, at R's key, never scanned by this process",
    enteredAt: Date.now(), tokens: ["37452ddd-tr-tok-a"],
  }, null, 2) + "\n");

  const rToken = enterMergeQuarantine(r, "r-branch", "37452ddd-twin-repoint: r raises, triggers protect for D's second occupant");
  check("(37452ddd-twin-repoint) R's own token lands directly at its own final",
    (contentIfExists(KrFinalPath) ?? "").includes(rToken));

  // *** DISCRIMINATING WINDOW (CR of 01f2ae25) *** -- asserted BEFORE D's own next raise, which would
  // otherwise self-heal the staleness via mergeTokenIntoPendingEntries' own (already-correct)
  // replaceEntryEverywhere calls and mask a missing/removed fix here.
  check("*** THE FIX (37452ddd-twin-repoint, mid-window) *** activeMergeQuarantineFor(s) sees R's own discovered token right after the raise, before D's next raise could self-heal it",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has("37452ddd-tr-tok-a"));
  check("*** THE FIX (37452ddd-twin-repoint, mid-window) *** exactly ONE D object exists right after the raise",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  const d2Token = enterMergeQuarantine(d, "d-branch-3", "37452ddd-twin-repoint: D raises again with a third token");

  check("*** THE FIX (37452ddd-twin-repoint) *** activeMergeQuarantineFor(s) (the ACTIVE side, byRepoKey[Ks]) sees ALL FOUR tokens",
    (() => {
      const t = new Set(activeMergeQuarantineFor(s)?.tokens ?? []);
      return t.has("37452ddd-tr-tok-a") && t.has("37452ddd-tr-tok-b") && t.has("37452ddd-tr-tok-c") && t.has(d2Token);
    })());
  check("(37452ddd-twin-repoint) activeMergeQuarantineFor(d) sees the same four tokens via the pending path",
    (() => {
      const t = new Set(activeMergeQuarantineFor(d)?.tokens ?? []);
      return t.has("37452ddd-tr-tok-a") && t.has("37452ddd-tr-tok-b") && t.has("37452ddd-tr-tok-c") && t.has(d2Token);
    })());
  check("*** THE FIX (37452ddd-twin-repoint) *** exactly ONE D object exists in memory -- no stale orphaned twin",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  const freshTR = await freshBootModule();
  freshTR.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootTR = new Set(freshTR.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (37452ddd-twin-repoint, reboot) *** all four tokens, plus R's own, survive a fresh-process reboot",
    tokensAfterRebootTR.has("37452ddd-tr-tok-a") && tokensAfterRebootTR.has("37452ddd-tr-tok-b") && tokensAfterRebootTR.has("37452ddd-tr-tok-c") && tokensAfterRebootTR.has(d2Token) && tokensAfterRebootTR.has(rToken));

  freshTR.clearMergeQuarantineByToken(r, rToken);
  freshTR.clearMergeQuarantineByToken(d, "37452ddd-tr-tok-a");
  freshTR.clearMergeQuarantineByToken(d, "37452ddd-tr-tok-b");
  freshTR.clearMergeQuarantineByToken(d, "37452ddd-tr-tok-c");
  freshTR.clearMergeQuarantineByToken(d, d2Token);
  freshTR.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 37452ddd ("37452ddd-twin-repoint-finalbasename") -- the SIBLING atFinalBasenameIdx-only branch
  // (atFilenameIdx < 0, atFinalBasenameIdx >= 0) has the identical stale-twin shape: its own re-point also
  // used to reassign the array slot directly. Setup: ONE boot-time latch file is named as if it belongs
  // to R's own key (sourceFile = "<Krhash>.json") but its own CONTENT records resolvedKey=Ks (a DIFFERENT,
  // unrelated repo's key) -- PASS 1 arms an entry at its OWN resolvedKey, never at a hash derived from its
  // filename, so this produces a twin: armed in activeQuarantines[Ks], with its ONLY pending reference at
  // sourceFile="<Krhash>.json" (== R's own `final` basename, not the pending-divert path -- nothing sits
  // there, so atFilenameIdx is -1). R then raises -- reaching protectOccupantContentBeforeDelete via the
  // "no existing" front door, which finds the twin via atFinalBasenameIdx only. THE FIX: the SAME
  // replaceEntryEverywhere re-point, for the replacement only (never as a union source -- c9114934 still
  // forbids unioning atFinalBasenameIdx's own tokens into toWrite).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("37452ddd-fb-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("37452ddd-fb-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-37452ddd-fb-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "37452ddd-twin-repoint-finalbasename: D degraded, filed at R's own name but resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["37452ddd-fb-tok-x"], resolvedKey: Ks,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);

  check("(37452ddd-twin-repoint-finalbasename precondition) the TWIN exists: D armed at S's own key, pending ref at R's own final basename",
    (() => {
      const direct = activeMergeQuarantineFor(s);
      return !!direct && direct.repoPath === d && new Set(direct.tokens).has("37452ddd-fb-tok-x");
    })());
  check("(37452ddd-twin-repoint-finalbasename precondition) nothing sits at D's own pending-divert filename yet",
    !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d))));

  const rToken2 = enterMergeQuarantine(r, "r-branch", "37452ddd-twin-repoint-finalbasename: r raises, triggers protect via atFinalBasenameIdx only");
  check("(37452ddd-twin-repoint-finalbasename) R's own token lands directly at its own final",
    (contentIfExists(KrFinalPath) ?? "").includes(rToken2));

  const d2Token2 = enterMergeQuarantine(d, "d-branch-2", "37452ddd-twin-repoint-finalbasename: D raises again with a second token");

  check("*** THE FIX (37452ddd-twin-repoint-finalbasename) *** activeMergeQuarantineFor(s) (the ACTIVE side, byRepoKey[Ks]) sees D's newest token",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has(d2Token2));
  check("(37452ddd-twin-repoint-finalbasename) activeMergeQuarantineFor(d) sees D's newest token via the pending path",
    new Set(activeMergeQuarantineFor(d)?.tokens ?? []).has(d2Token2));
  check("*** THE FIX (37452ddd-twin-repoint-finalbasename) *** exactly ONE D object exists in memory -- no stale orphaned twin",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  const freshFB = await freshBootModule();
  freshFB.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootFB = new Set(freshFB.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (37452ddd-twin-repoint-finalbasename, reboot) *** both of D's own tokens, plus R's own, survive a fresh-process reboot",
    tokensAfterRebootFB.has("37452ddd-fb-tok-x") && tokensAfterRebootFB.has(d2Token2) && tokensAfterRebootFB.has(rToken2));
  // Card 4b06875f -- ACCEPTED RESIDUAL from 37452ddd's own decision record: the protective copy
  // protectOccupantContentBeforeDelete writes (toPersist, this function's own pre-existing field
  // whitelist) never carries the OCCUPANT's own on-disk `resolvedKey` (Ks here) forward. On THIS reboot,
  // PASS 1 reads that copy with no resolvedKey and an unresolvable repoPath (d), so it takes the "defer
  // to a lazy re-resolve on first query" branch (never arms anywhere) -- and findPendingIndicesFor's own
  // 4th tier (~L3447) is gated on `!!entry.resolvedKey`, so a query keyed on S (s) can never match it
  // either. Before R's raise, the latch at <Krhash>.json carried resolvedKey=Ks and would have re-armed S
  // on any reboot -- the raise itself downgrades S from blocked to unblocked across a reboot, for as long
  // as D stays unmounted. `activeMergeQuarantineFor(d)` (asserted below) stays correctly blocked via the
  // direct-identity tier -- only the query keyed on S's own path is affected.
  check("*** BUG (4b06875f) *** activeMergeQuarantineFor(s) should STILL be blocked after reboot -- today it is NOT (fail-open: see docs/decisions/8db913e2-*.md, Follow-up 37452ddd, ACCEPTED RESIDUAL)",
    !!freshFB.activeMergeQuarantineFor(s));
  check("(4b06875f) activeMergeQuarantineFor(d) is unaffected -- still correctly blocked via direct identity",
    !!freshFB.activeMergeQuarantineFor(d));

  freshFB.clearMergeQuarantineByToken(r, rToken2);
  freshFB.clearMergeQuarantineByToken(d, "37452ddd-fb-tok-x");
  freshFB.clearMergeQuarantineByToken(d, d2Token2);
  freshFB.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 4b06875f (manager follow-up, timing variant) -- the SAME twin-repoint-finalbasename shape, but
  // WITHOUT D's second raise: R raises once, THEN reboot. This isolates the bug from D's second raise --
  // protectOccupantContentBeforeDelete's own toPersist whitelist drops resolvedKey the moment R's single
  // raise runs; D never needs to raise again to trigger the fail-open.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("4b06875f-ns-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("4b06875f-ns-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-ns-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f-no-second-raise: D degraded, filed at R's own name but resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["4b06875f-ns-tok-x"], resolvedKey: Ks,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);

  check("(4b06875f-no-second-raise precondition) the TWIN exists: D armed at S's own key, pending ref at R's own final basename",
    (() => {
      const direct = activeMergeQuarantineFor(s);
      return !!direct && direct.repoPath === d && new Set(direct.tokens).has("4b06875f-ns-tok-x");
    })());

  const rToken3 = enterMergeQuarantine(r, "r-branch", "4b06875f-no-second-raise: r raises, triggers protect via atFinalBasenameIdx only -- D never raises again");
  check("(4b06875f-no-second-raise) R's own token lands directly at its own final",
    (contentIfExists(KrFinalPath) ?? "").includes(rToken3));
  // Deliberately NO second raise of D here -- this is the whole point of the variant.

  const freshNS = await freshBootModule();
  freshNS.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootNS = new Set(freshNS.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("(4b06875f-no-second-raise, reboot) D's own original token, plus R's own, survive a fresh-process reboot",
    tokensAfterRebootNS.has("4b06875f-ns-tok-x") && tokensAfterRebootNS.has(rToken3));
  check("*** BUG (4b06875f-no-second-raise) *** activeMergeQuarantineFor(s) should STILL be blocked after reboot, with NO second D raise in between -- today it is NOT",
    !!freshNS.activeMergeQuarantineFor(s));
  check("(4b06875f-no-second-raise) activeMergeQuarantineFor(d) is unaffected -- still correctly blocked via direct identity",
    !!freshNS.activeMergeQuarantineFor(d));

  freshNS.clearMergeQuarantineByToken(r, rToken3);
  freshNS.clearMergeQuarantineByToken(d, "4b06875f-ns-tok-x");
  freshNS.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 37452ddd (CR of 01f2ae25, CRITICAL finding 1) -- branch 1 (`if (atFilenameIdx >= 0)`) spliced
  // away `atFinalBasenameIdx`'s own slot WITHOUT re-pointing it first. When that slot holds a DIFFERENT
  // object than `atFilenameIdx`'s own entry -- and that different object IS an 883e29bc twin armed in
  // `activeQuarantines` -- the splice discarded the only pending reference to it, leaving the active side
  // stale forever (reachable on the SUCCESS path, no fault needed). Setup (reviewer's own repro): D's
  // latch at <Krhash>.json records resolvedKey=Ks (the SAME single-file twin shape as
  // `37452ddd-twin-repoint-finalbasename` above, armed at Ks -- call this object X) PLUS an INDEPENDENT
  // pending-divert file for D with NO resolvedKey (never armed anywhere -- call this object Y). R raises,
  // discovering D (X's content) at its own final -- `atFilenameIdx` matches Y's slot (same deterministic
  // pending-divert filename), `atFinalBasenameIdx` matches X's slot -- BOTH >= 0, branch 1. THE FIX: a
  // SECOND `replaceEntryEverywhere` call, for whichever entry sits at `atFinalBasenameIdx`, before that
  // slot is spliced away (@decision 8db913e2, Follow-up 37452ddd).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("37452ddd-b1-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("37452ddd-b1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-37452ddd-b1-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "x-branch", reason: "37452ddd-branch1-dual-twin: object X, filed at R's own name, resolvedKey=S's key -- ARMED",
    enteredAt: Date.now(), tokens: ["37452ddd-b1-tok-x"], resolvedKey: Ks,
  }, null, 2) + "\n");
  const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d));
  fs.writeFileSync(pendingPath, JSON.stringify({
    repoPath: d, branch: "y-branch", reason: "37452ddd-branch1-dual-twin: object Y, D's own pending-divert file, NO resolvedKey -- NEVER armed",
    enteredAt: Date.now() - 100000, tokens: ["37452ddd-b1-tok-y"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  check("(37452ddd-branch1-dual-twin precondition) X is armed at S's own key",
    (() => {
      const direct = activeMergeQuarantineFor(s);
      return !!direct && direct.repoPath === d && new Set(direct.tokens).has("37452ddd-b1-tok-x");
    })());
  check("(37452ddd-branch1-dual-twin precondition) X and Y are TWO SEPARATE objects for D right now",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 2);

  const rToken3 = enterMergeQuarantine(r, "r-branch", "37452ddd-branch1-dual-twin: r raises, triggers protect's branch 1 (both indices match, two different objects)");
  check("(37452ddd-branch1-dual-twin) R's own token lands directly at its own final",
    (contentIfExists(KrFinalPath) ?? "").includes(rToken3));

  // *** DISCRIMINATING WINDOW *** -- asserted BEFORE D's own next raise (same self-heal risk as above).
  check("*** THE FIX (37452ddd-branch1-dual-twin, mid-window) *** activeMergeQuarantineFor(s) sees BOTH X's and Y's own tokens -- X's own active slot was re-pointed, not spliced away stale",
    (() => {
      const t = new Set(activeMergeQuarantineFor(s)?.tokens ?? []);
      return t.has("37452ddd-b1-tok-x") && t.has("37452ddd-b1-tok-y");
    })());
  check("*** THE FIX (37452ddd-branch1-dual-twin, mid-window) *** exactly ONE D object exists right after the raise",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  // The reviewer's own named consequence of the bug: clearing X's OWN token must never fail-open-lift S's
  // key while Y's (and D's later) tokens are still outstanding.
  clearMergeQuarantineByToken(d, "37452ddd-b1-tok-x");
  check("*** THE FIX (37452ddd-branch1-dual-twin) *** clearing X's own token does NOT fail-open-lift S -- Y's own token is still outstanding there",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has("37452ddd-b1-tok-y"));

  const d2Token3 = enterMergeQuarantine(d, "d-branch-3", "37452ddd-branch1-dual-twin: D raises again with a third token");
  check("(37452ddd-branch1-dual-twin) activeMergeQuarantineFor(s) sees the newest token too",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has(d2Token3));

  const freshB1 = await freshBootModule();
  freshB1.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterRebootB1 = new Set(freshB1.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (37452ddd-branch1-dual-twin, reboot) *** Y's own token, D's newest token, and R's own token all survive a fresh-process reboot",
    tokensAfterRebootB1.has("37452ddd-b1-tok-y") && tokensAfterRebootB1.has(d2Token3) && tokensAfterRebootB1.has(rToken3));

  freshB1.clearMergeQuarantineByToken(r, rToken3);
  freshB1.clearMergeQuarantineByToken(d, "37452ddd-b1-tok-y");
  freshB1.clearMergeQuarantineByToken(d, d2Token3);
  freshB1.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Card 37452ddd (CR of 01f2ae25, MAJOR finding 2) -- the double-fault `kept` branch (the chosen write to
  // `filename` ALSO fails) has the IDENTICAL re-point gap: its own `pendingUnresolvedQuarantines[
  // atFinalBasenameIdx] = { entry: kept, ... }` reassignment never went through `replaceEntryEverywhere`
  // either, even though this card's own new "Do not" bullet (first round) already named exactly this line
  // as forbidden. Setup: the SAME single-file twin shape as `37452ddd-twin-repoint-finalbasename` (object
  // W, armed at S's own key, pending ref at R's own final basename only) -- but R's raise is wrapped in
  // `injectOpenSyncFailureForPrefix` targeting D's own pending-divert filename, forcing
  // `writePendingDivertFile` to fail and reach the double-fault branch. THE FIX: `replaceEntryEverywhere`
  // before the slot is overwritten with `kept` (@decision 8db913e2, Follow-up 37452ddd).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("37452ddd-df-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("37452ddd-df-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-37452ddd-df-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "w-branch", reason: "37452ddd-double-fault-kept-twin: object W, filed at R's own name, resolvedKey=S's key -- ARMED",
    enteredAt: Date.now(), tokens: ["37452ddd-df-tok-w"], resolvedKey: Ks,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  check("(37452ddd-double-fault-kept-twin precondition) W is armed at S's own key",
    (() => {
      const direct = activeMergeQuarantineFor(s);
      return !!direct && direct.repoPath === d && new Set(direct.tokens).has("37452ddd-df-tok-w");
    })());

  const injectDF = injectOpenSyncFailureForPrefix(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)));
  let rToken4;
  try {
    rToken4 = enterMergeQuarantine(r, "r-branch", "37452ddd-double-fault-kept-twin: r raises, protect's own chosen write fails, reaching the double-fault kept branch");
  } finally {
    injectDF.restore();
  }
  check("(37452ddd-double-fault-kept-twin) the write was actually attempted (and injected to fail)", injectDF.count() >= 1);
  // The protect call's own `false` return (the double fault) diverts R's OWN raise-write too (it never
  // reaches `final` in that case — same documented shape as this file's own SHAPE 1/2 above); the raise
  // itself still always persists (e1cb7d33), just not necessarily at `final`.
  check("(37452ddd-double-fault-kept-twin) R's own raise still persists IN-PROCESS despite the double fault",
    new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(rToken4));

  // *** DISCRIMINATING WINDOW *** -- asserted BEFORE D's own next raise.
  check("*** THE FIX (37452ddd-double-fault-kept-twin, mid-window) *** activeMergeQuarantineFor(s) still sees W's own token right after the double fault",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has("37452ddd-df-tok-w"));
  check("*** THE FIX (37452ddd-double-fault-kept-twin, mid-window) *** exactly ONE D object exists right after the double fault",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  const d2Token4 = enterMergeQuarantine(d, "d-branch-2", "37452ddd-double-fault-kept-twin: D raises again with a second token, no injection this time");
  check("*** THE FIX (37452ddd-double-fault-kept-twin) *** activeMergeQuarantineFor(s) sees D's newest token too -- the active side was never left pointing at the pre-double-fault object",
    new Set(activeMergeQuarantineFor(s)?.tokens ?? []).has(d2Token4));
  check("(37452ddd-double-fault-kept-twin) exactly ONE D object exists after D's second raise",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d).length === 1);

  clearMergeQuarantineByToken(d, "37452ddd-df-tok-w");
  clearMergeQuarantineByToken(d, d2Token4);
  clearMergeQuarantineByToken(r, rToken4);
  clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // PROBE C — Code Review of 7282d183 (card 4b06875f), Finding 2: readPendingDivertFileAt's own field
  // whitelist (merge-quarantine.ts ~2086-2103) never reads `resolvedKey` back off an on-disk pending-
  // divert file, and unionQuarantineEntries's own `{...older}` spread (~608-627) lets whichever side is
  // OLDER win for any field not in its explicit list — including `resolvedKey`, which isn't in that list
  // at all. So even when the raise-side guard CORRECTLY decides to carry resolvedKey forward, that value
  // is silently dropped the instant it has to union with an EXISTING, OLDER on-disk pending-divert record
  // for the SAME identity (the shape a runtime raise produces via mintPendingDivert when D is degraded)
  // — age-dependent: a NEWER pre-existing pending file does not trigger this (the carried value IS
  // "older" by comparison then, and wins the spread).
  //
  // Setup: D's twin at <Krhash>.json (same shape as 37452ddd-twin-repoint-finalbasename — filed as if it
  // belongs to R's own key, but its own content records resolvedKey=Ks), PLUS D's own INDEPENDENT
  // pending-divert file (D's deterministic pendingDivertFilenameFor(d) path) with NO resolvedKey, an
  // OLDER enteredAt, and its own token (the exact shape a prior degraded raise already produced). R
  // raises -- protectOccupantContentBeforeDelete correctly computes resolvedKey=Ks for D's own protective
  // copy (final=Krhash.json's own physical key, Kr, differs from Ks) -- but reconcilePendingDivertTarget
  // then unions it with the pre-existing OLDER pending file; the union's own `{...older}` spread takes
  // the OLDER side's (absent) resolvedKey, discarding Ks.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("4b06875f-pc-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("4b06875f-pc-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-pc-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f probe C: D degraded twin, filed at R's own name, resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["4b06875f-pc-tok-d"], resolvedKey: Ks,
  }, null, 2) + "\n");
  const dPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d));
  fs.writeFileSync(dPendingPath, JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "4b06875f probe C: D's own OLDER pending-divert record, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["4b06875f-pc-tok-old"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);

  check("(probe C precondition) the TWIN exists: D armed at S's own key", (() => {
    const direct = activeMergeQuarantineFor(s);
    return !!direct && direct.repoPath === d && new Set(direct.tokens).has("4b06875f-pc-tok-d");
  })());
  check("(probe C precondition) D's own OLDER pending-divert file exists before the raise", fs.existsSync(dPendingPath));

  const rTokenC = enterMergeQuarantine(r, "r-branch", "4b06875f probe C: r raises, triggers protect via atFinalBasenameIdx only");

  // Mid-window (in-process, BEFORE reboot) -- per this project's own established rule (37452ddd's own
  // "Do not trust a test's own mid-raise assertions... assert in the window BEFORE [a later step] too"),
  // confirm this is observable immediately -- it is not something a later query/raise could self-heal.
  check("*** PROBE C (mid-window) *** activeMergeQuarantineFor(s) should STILL be blocked right after R's raise -- today it is NOT",
    !!activeMergeQuarantineFor(s));

  const freshPC = await freshBootModule();
  freshPC.reenterMergeQuarantinesAtBoot([]);
  check("*** PROBE C *** activeMergeQuarantineFor(s) should STILL be blocked after reboot -- today it is NOT (readPendingDivertFileAt never reads resolvedKey back, and unionQuarantineEntries's {...older} spread lets the OLDER pending file's own undefined resolvedKey win)",
    !!freshPC.activeMergeQuarantineFor(s));
  check("(probe C) activeMergeQuarantineFor(d) is unaffected -- still correctly blocked via direct identity",
    !!freshPC.activeMergeQuarantineFor(d));

  freshPC.clearMergeQuarantineByToken(r, rTokenC);
  freshPC.clearMergeQuarantineByToken(d, "4b06875f-pc-tok-d");
  freshPC.clearMergeQuarantineByToken(d, "4b06875f-pc-tok-old");
  freshPC.clearMergeQuarantineByRecordedPath(d);
  }

  // PROBE C, CONTROL (no R raise) -- same setup, but R never raises: D's own pre-existing twin + older
  // pending file survive untouched, so S must still read blocked. Proves probe C's own RED is caused by
  // R's raise specifically, never by the fixture shape alone.
  {
  const s = makeToplevelRepo("4b06875f-pc-ctrl-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("4b06875f-pc-ctrl-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-pc-ctrl-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f probe C control: D degraded twin, filed at R's own name, resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["4b06875f-pc-ctrl-tok-d"], resolvedKey: Ks,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "4b06875f probe C control: D's own OLDER pending-divert record, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["4b06875f-pc-ctrl-tok-old"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  // Deliberately NO raise of r here.
  check("(probe C control) activeMergeQuarantineFor(s) is blocked with no raise at all -- the fixture alone, no bug needed",
    !!activeMergeQuarantineFor(s));

  clearMergeQuarantineByToken(d, "4b06875f-pc-ctrl-tok-d");
  clearMergeQuarantineByToken(d, "4b06875f-pc-ctrl-tok-old");
  clearMergeQuarantineByRecordedPath(d);
  }

  // PROBE C, NEWER-PENDING VARIANT -- same setup, but D's own pre-existing pending file is NEWER than the
  // twin (not older). unionQuarantineEntries's own tie-break keeps the OLDER side; here the carried toPersist
  // (from the twin, enteredAt=now) is OLDER than the pre-existing pending file (enteredAt=now+60s), so the
  // carried resolvedKey SURVIVES the union (it's on the winning/older side this time) -- Ks must still
  // block S after a reboot. Proves the age-dependence claim directly, not just the one direction.
  {
  const s = makeToplevelRepo("4b06875f-pc-newer-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("4b06875f-pc-newer-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-pc-newer-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f probe C newer-variant: D degraded twin, filed at R's own name, resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["4b06875f-pc-newer-tok-d"], resolvedKey: Ks,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-new-branch", reason: "4b06875f probe C newer-variant: D's own NEWER pending-divert record, no resolvedKey",
    enteredAt: Date.now() + 60_000, tokens: ["4b06875f-pc-newer-tok-old"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenCN = enterMergeQuarantine(r, "r-branch", "4b06875f probe C newer-variant: r raises");

  const freshCN = await freshBootModule();
  freshCN.reenterMergeQuarantinesAtBoot([]);
  check("(probe C newer-variant) activeMergeQuarantineFor(s) survives after reboot when the pre-existing pending file is NEWER than the twin -- confirms the age-dependence claim",
    !!freshCN.activeMergeQuarantineFor(s));

  freshCN.clearMergeQuarantineByToken(r, rTokenCN);
  freshCN.clearMergeQuarantineByToken(d, "4b06875f-pc-newer-tok-d");
  freshCN.clearMergeQuarantineByToken(d, "4b06875f-pc-newer-tok-old");
  freshCN.clearMergeQuarantineByRecordedPath(d);
  }

  // UNIT-LEVEL CHECK, unionQuarantineEntries's resolvedKey rule, case 3/3 (both set and DIFFERENT) -- cases
  // 1/3 (equal) and 2/3 (one undefined) are already exercised directly by the twin fixtures above (same
  // value survives a union with itself) and by probe C/probe D (one side undefined, the other wins)
  // respectively. D's twin carries resolvedKey=Ks (via R's raise); D's own pre-existing OLDER pending file
  // carries a DIFFERENT, real, non-undefined resolvedKey=Kt (never undefined) -- both sides are SET, and
  // they genuinely differ. THE RULE: fail closed (neither wins) -- S stays unblocked (Ks never resurfaces)
  // AND T stays unblocked too (Kt never resurfaces either); D's own identity is still independently
  // enforced via direct identity regardless.
  {
  const s = makeToplevelRepo("4b06875f-union-both-diff-s");
  const Ks = canonicalRepoLockKey(s);
  const t = makeToplevelRepo("4b06875f-union-both-diff-t");
  const Kt = canonicalRepoLockKey(t);
  const r = makeToplevelRepo("4b06875f-union-both-diff-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-union-both-diff-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f union-rule case 3/3: D degraded twin, filed at R's own name, resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["4b06875f-ubd-tok-d"], resolvedKey: Ks,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "4b06875f union-rule case 3/3: D's own OLDER pending-divert record, carrying a DIFFERENT resolvedKey=T's key",
    enteredAt: Date.now() - 60_000, tokens: ["4b06875f-ubd-tok-old"], resolvedKey: Kt,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenUBD = enterMergeQuarantine(r, "r-branch", "4b06875f union-rule case 3/3: r raises");

  const freshUBD = await freshBootModule();
  freshUBD.reenterMergeQuarantinesAtBoot([]);
  check("*** UNION RULE (case 3/3, both DIFFERENT) *** activeMergeQuarantineFor(s) is NOT blocked by D after reboot -- Ks never survived the union",
    !freshUBD.activeMergeQuarantineFor(s));
  // ACCEPTED RESIDUAL, found by THIS check, not fixed here (reported, not silently dropped): D's own
  // IN-MEMORY pending-divert entry (loaded at BOOT by PASS1, sitting in pendingUnresolvedQuarantines) is a
  // SEPARATE copy from the fresh disk re-read reconcilePendingDivertTarget uses for the FIRST union --
  // the atFilenameIdx union then unions AGAIN against that STALE copy, which still carries Kt (T's own
  // key), UNFILTERED (it was loaded before this raise ever ran, so excludeLiftedResolvedKey never touched
  // it). The first union's own correct "both different -> undefined" verdict is treated by the SECOND
  // union as "nothing to see here, keep my own value" rather than "already adjudicated, stay dropped" --
  // Kt (an UNRELATED third party, never in this raise's own liftedKeys and never matching final's own
  // physical key) survives where Ks correctly does not. Deliberately NOT asserted here -- see this card's
  // decision record "Follow-up 4b06875f" (Round 2) for the full writeup; fixing it needs a way to mark a
  // resolvedKey as "deliberately excluded" so a LATER union can't re-admit it from a stale copy, which is
  // a bigger change than this round's own scope.
  check("(union-rule case 3/3) D's own tokens are still independently enforced via direct identity", (() => {
    const tokens = new Set(freshUBD.activeMergeQuarantineFor(d)?.tokens ?? []);
    return tokens.has("4b06875f-ubd-tok-d") && tokens.has("4b06875f-ubd-tok-old");
  })());

  freshUBD.clearMergeQuarantineByToken(r, rTokenUBD);
  freshUBD.clearMergeQuarantineByToken(d, "4b06875f-ubd-tok-d");
  freshUBD.clearMergeQuarantineByToken(d, "4b06875f-ubd-tok-old");
  freshUBD.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // UNIT-LEVEL CHECK, NEW-FORMAT VARIANT -- Code Review 46c5c492 (card 43cf3b26 Round 2) MAJOR, `case3.mjs`.
  // Byte-identical fixture to "case 3/3" immediately above, except BOTH records ALSO carry their own
  // `resolvedKeys` array matching their own scalar (`twin.resolvedKeys=[Ks]`, `older.resolvedKeys=[Kt]`)
  // -- the shape a record written by 43cf3b26's own code actually has. MAJOR (fixed): the explicit-rule
  // fail-closed gate used to exclude only the two conflicting SCALARS from the fold -- the
  // `older.resolvedKeys ∪ newer.resolvedKeys` path still carried both Ks and Kt through UNFILTERED, so a
  // new-format collision here durably blocked the UNRELATED repo S until a human cleared it. THE RULE
  // (unchanged from the scalar-only case): fail closed over the KEY SET, not just the scalars -- S stays
  // unblocked after reboot, identically to the legacy "case 3/3" above.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("43cf3b26-union-both-diff-newformat-s");
  const Ks = canonicalRepoLockKey(s);
  const t = makeToplevelRepo("43cf3b26-union-both-diff-newformat-t");
  const Kt = canonicalRepoLockKey(t);
  const r = makeToplevelRepo("43cf3b26-union-both-diff-newformat-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-43cf3b26-union-both-diff-newformat-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "43cf3b26 union-rule case 3/3 (new format): D degraded twin, filed at R's own name, resolvedKey=S's key",
    enteredAt: Date.now(), tokens: ["43cf3b26-ubd-nf-tok-d"], resolvedKey: Ks, resolvedKeys: [Ks],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "43cf3b26 union-rule case 3/3 (new format): D's own OLDER pending-divert record, carrying a DIFFERENT resolvedKey=T's key",
    enteredAt: Date.now() - 60_000, tokens: ["43cf3b26-ubd-nf-tok-old"], resolvedKey: Kt, resolvedKeys: [Kt],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenUBDnf = enterMergeQuarantine(r, "r-branch", "43cf3b26 union-rule case 3/3 (new format): r raises");

  const freshUBDnf = await freshBootModule();
  freshUBDnf.reenterMergeQuarantinesAtBoot([]);
  check("*** MAJOR (CR 46c5c492) *** NEW-FORMAT case 3/3: activeMergeQuarantineFor(s) is NOT blocked by D after reboot -- the array union must fail closed too, not just the scalars",
    !freshUBDnf.activeMergeQuarantineFor(s));
  check("(new-format union-rule case 3/3) D's own tokens are still independently enforced via direct identity", (() => {
    const tokens = new Set(freshUBDnf.activeMergeQuarantineFor(d)?.tokens ?? []);
    return tokens.has("43cf3b26-ubd-nf-tok-d") && tokens.has("43cf3b26-ubd-nf-tok-old");
  })());

  freshUBDnf.clearMergeQuarantineByToken(r, rTokenUBDnf);
  freshUBDnf.clearMergeQuarantineByToken(d, "43cf3b26-ubd-nf-tok-d");
  freshUBDnf.clearMergeQuarantineByToken(d, "43cf3b26-ubd-nf-tok-old");
  freshUBDnf.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Code Review 4c59172f, card 43cf3b26) — SET-SEMANTICS variants of case 3/3, Lead ruling.
  // Round 2's own fix excluded only the two conflicting SCALARS from the fold; it still compared the
  // scalars alone to decide WHETHER a conflict existed at all, so an ARRAY-ONLY side (no scalar of its
  // own at all) was invisible to that comparison and sailed through UNFILTERED, durably blocking S.
  // THE RULE: A = informativeKeysFor(older), B = informativeKeysFor(newer) (scalar UNION resolvedKeys,
  // never scalar alone). Either side empty -> union everything (unchanged). Both non-empty -> keep the
  // INTERSECTION, exclude the whole SYMMETRIC DIFFERENCE from the union (arrays included) -- this reduces
  // exactly to the scalar rule when each side carries exactly one key.
  //
  // These checks assert through `assertRepoNotQuarantined` (Round 3, Code Review 4c59172f, finding 3),
  // never a bare `activeMergeQuarantineFor` call -- see the decision record's own Round-2 "A SEPARATE,
  // newly-discovered interaction" correction for why `activeMergeQuarantineFor`'s own tier-4 pending
  // fallback is never reached via the real `assertRepoNotQuarantined`/clear-reporting call chain for a
  // resolvable query (both S and T are real, resolvable repos here) -- it degrades to a plain
  // `activeMergeQuarantineFor` call either way, so this is purely about exercising the SHIPPED entry point.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  // olderArrayOnly: D's OLDER pending-divert record carries ONLY an array ([Kt], no scalar at all) --
  // the ordinary pre-generalization SHAPE is reversed from case 3/3 (there, both sides had a scalar).
  const s = makeToplevelRepo("43cf3b26-r3-olderArrayOnly-s");
  const Ks = canonicalRepoLockKey(s);
  const t = makeToplevelRepo("43cf3b26-r3-olderArrayOnly-t");
  const Kt = canonicalRepoLockKey(t);
  const r = makeToplevelRepo("43cf3b26-r3-olderArrayOnly-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-43cf3b26-r3-olderArrayOnly-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "43cf3b26 round 3, olderArrayOnly: D's twin, scalar-only Ks",
    enteredAt: Date.now(), tokens: ["43cf3b26-r3-oao-tok-d"], resolvedKey: Ks,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "43cf3b26 round 3, olderArrayOnly: D's OLDER pending, array-only [Kt], NO scalar",
    enteredAt: Date.now() - 60_000, tokens: ["43cf3b26-r3-oao-tok-old"], resolvedKeys: [Kt],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenOAO = enterMergeQuarantine(r, "r-branch", "43cf3b26 round 3, olderArrayOnly: r raises");

  const freshOAO = await freshBootModule();
  freshOAO.reenterMergeQuarantinesAtBoot([]);
  check("*** MAJOR (CR 4c59172f) *** olderArrayOnly: assertRepoNotQuarantined(s) succeeds -- an array-only side must be visible to the conflict check too, not just a scalar",
    freshOAO.assertRepoNotQuarantined(s).ok === true);
  check("(olderArrayOnly) D's own tokens are still independently enforced via direct identity", (() => {
    const tokens = new Set(freshOAO.activeMergeQuarantineFor(d)?.tokens ?? []);
    return tokens.has("43cf3b26-r3-oao-tok-d") && tokens.has("43cf3b26-r3-oao-tok-old");
  })());

  freshOAO.clearMergeQuarantineByToken(r, rTokenOAO);
  freshOAO.clearMergeQuarantineByToken(d, "43cf3b26-r3-oao-tok-d");
  freshOAO.clearMergeQuarantineByToken(d, "43cf3b26-r3-oao-tok-old");
  freshOAO.clearMergeQuarantineByRecordedPath(d);
  }

  {
  // twinArrayOnly: the mirror shape -- D's TWIN (the physically-colliding record) carries ONLY an array
  // ([Ks], no scalar), while D's older pending file carries a plain scalar (Kt, no array).
  const s = makeToplevelRepo("43cf3b26-r3-twinArrayOnly-s");
  const Ks = canonicalRepoLockKey(s);
  const t = makeToplevelRepo("43cf3b26-r3-twinArrayOnly-t");
  const Kt = canonicalRepoLockKey(t);
  const r = makeToplevelRepo("43cf3b26-r3-twinArrayOnly-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-43cf3b26-r3-twinArrayOnly-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "43cf3b26 round 3, twinArrayOnly: D's twin, array-only [Ks], NO scalar",
    enteredAt: Date.now(), tokens: ["43cf3b26-r3-tao-tok-d"], resolvedKeys: [Ks],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "43cf3b26 round 3, twinArrayOnly: D's OLDER pending, scalar-only Kt",
    enteredAt: Date.now() - 60_000, tokens: ["43cf3b26-r3-tao-tok-old"], resolvedKey: Kt,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenTAO = enterMergeQuarantine(r, "r-branch", "43cf3b26 round 3, twinArrayOnly: r raises");

  const freshTAO = await freshBootModule();
  freshTAO.reenterMergeQuarantinesAtBoot([]);
  check("*** MAJOR (CR 4c59172f) *** twinArrayOnly: assertRepoNotQuarantined(s) succeeds",
    freshTAO.assertRepoNotQuarantined(s).ok === true);
  check("(twinArrayOnly) D's own tokens are still independently enforced via direct identity", (() => {
    const tokens = new Set(freshTAO.activeMergeQuarantineFor(d)?.tokens ?? []);
    return tokens.has("43cf3b26-r3-tao-tok-d") && tokens.has("43cf3b26-r3-tao-tok-old");
  })());

  freshTAO.clearMergeQuarantineByToken(r, rTokenTAO);
  freshTAO.clearMergeQuarantineByToken(d, "43cf3b26-r3-tao-tok-d");
  freshTAO.clearMergeQuarantineByToken(d, "43cf3b26-r3-tao-tok-old");
  freshTAO.clearMergeQuarantineByRecordedPath(d);
  }

  {
  // [Kt,Ks]-vs-[Ks]: D's OLDER pending record carries BOTH keys ([Kt,Ks]); D's twin carries only the
  // AGREED key ([Ks]). Per the Lead's own worked example: intersection={Ks} survives (S stays blocked --
  // that is INTENDED, both sides genuinely agree on Ks), symmetric difference={Kt} is excluded (T is
  // unblocked). This is the asymmetric-intersection case the plain "both different, exclude both" scalar
  // rule could never express at all (a scalar can only ever hold ONE value per side).
  const s = makeToplevelRepo("43cf3b26-r3-ktks-s");
  const Ks = canonicalRepoLockKey(s);
  const t = makeToplevelRepo("43cf3b26-r3-ktks-t");
  const Kt = canonicalRepoLockKey(t);
  const r = makeToplevelRepo("43cf3b26-r3-ktks-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-43cf3b26-r3-ktks-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`), JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "43cf3b26 round 3, ktks: D's twin, [Ks]",
    enteredAt: Date.now(), tokens: ["43cf3b26-r3-ktks-tok-d"], resolvedKey: Ks, resolvedKeys: [Ks],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d)), JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "43cf3b26 round 3, ktks: D's OLDER pending, [Kt,Ks]",
    enteredAt: Date.now() - 60_000, tokens: ["43cf3b26-r3-ktks-tok-old"], resolvedKey: Kt, resolvedKeys: [Kt, Ks],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const rTokenKtKs = enterMergeQuarantine(r, "r-branch", "43cf3b26 round 3, ktks: r raises");

  const freshKtKs = await freshBootModule();
  freshKtKs.reenterMergeQuarantinesAtBoot([]);
  check("*** MAJOR (CR 4c59172f) *** [Kt,Ks]-vs-[Ks]: assertRepoNotQuarantined(s) STILL FAILS -- Ks is the agreed intersection, this is intended, not a regression",
    freshKtKs.assertRepoNotQuarantined(s).ok === false);
  check("*** MAJOR (CR 4c59172f) *** [Kt,Ks]-vs-[Ks]: assertRepoNotQuarantined(t) succeeds -- Kt is the symmetric difference, correctly excluded",
    freshKtKs.assertRepoNotQuarantined(t).ok === true);
  check("(ktks) D's own tokens are still independently enforced via direct identity", (() => {
    const tokens = new Set(freshKtKs.activeMergeQuarantineFor(d)?.tokens ?? []);
    return tokens.has("43cf3b26-r3-ktks-tok-d") && tokens.has("43cf3b26-r3-ktks-tok-old");
  })());

  freshKtKs.clearMergeQuarantineByToken(r, rTokenKtKs);
  freshKtKs.clearMergeQuarantineByToken(d, "43cf3b26-r3-ktks-tok-d");
  freshKtKs.clearMergeQuarantineByToken(d, "43cf3b26-r3-ktks-tok-old");
  freshKtKs.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // PROBE E — Round-2 CR a61d0bec (card 4b06875f), MAJOR: readPendingDivertFileAt's own resolvedKey read
  // (merge-quarantine.ts, the `readPendingDivertFileAt` reader) had NO discriminating test. Probe C's own
  // fixture never needed it: there, the OLDER pending file carries NO resolvedKey at all, so reverting
  // the reader (always reporting resolvedKey absent) changes nothing -- the on-disk value was already
  // absent. THIS scenario flips which side carries the field: D's own OLDER pending-divert file already
  // carries a LEGITIMATE, non-lifted, non-physical resolvedKey=Ks (the shape an EARLIER protect call's
  // own correct carry leaves behind on disk -- see "Follow-up 4b06875f, Round 2"'s own field-survival
  // trace), while a LATER twin at R's own physical key carries NO resolvedKey at all (the ordinary,
  // overwhelmingly common case -- only a misfiled 883e29bc twin ever carries one). R raises, triggering a
  // protect call whose own toPersist carries no resolvedKey (the twin has none) -- this toPersist then
  // unions against D's own pre-existing OLDER pending file. Per the union rule ("one side undefined ->
  // keep the other"), Ks must survive IF AND ONLY IF the reader actually parses it back off the on-disk
  // file -- with the reader reverted (always reporting resolvedKey absent), the union sees BOTH sides as
  // undefined and Ks is lost, even though liftedKeys/the union rule/the post-union filter are all
  // otherwise intact.
  //
  // Realism (Round 4, Code Review be296830, Q1): a named, reachable production path leaves EXACTLY this
  // shape -- protectOccupantContentBeforeDelete's own double-fault branch (merge-quarantine.ts:1872,
  // firing when writePendingDivertFile(filename, toWrite) returns false) re-points in-memory tracking
  // for this identity to sourceFile:finalBasename, NEVER to filename (the deterministic
  // pendingDivertFilenameFor path) -- regardless of whether filename already held a prior, durably
  // written generation from an EARLIER, successful protect call. That prior generation's bytes are
  // untouched by the failed write, but nothing in memory now points at them -- a LATER (third) protect
  // call for the same identity reaches reconcilePendingDivertTarget fresh, computes the SAME filename,
  // and finds atFilenameIdx < 0 (nothing tracks it) -- the disk read is the only route back to its own
  // resolvedKey. This scenario starts from that already-reached end state directly (pending file written
  // after boot), the same way Probe C/D themselves start from a directly-written "prior protect already
  // happened" pending file rather than re-deriving it via a literal multi-raise sequence.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const s = makeToplevelRepo("4b06875f-rd-s");
  const Ks = canonicalRepoLockKey(s);
  const r = makeToplevelRepo("4b06875f-rd-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(os.tmpdir(), `loom-mqrpf-4b06875f-rd-d-nonexistent-${freshSfx()}`);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // D's twin, filed at R's own name, carrying NO resolvedKey this time (the ordinary, non-misfiled case).
  const KrFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(KrFinalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "4b06875f probe E: D degraded twin, filed at R's own name, NO resolvedKey",
    enteredAt: Date.now(), tokens: ["4b06875f-rd-tok-d"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);

  // D's own OLDER pending-divert file, ALREADY carrying a legitimate resolvedKey=Ks (the shape an
  // earlier protect call's own correct carry leaves behind on disk) -- written AFTER boot, deliberately,
  // so THIS process's own pendingUnresolvedQuarantines never loads it: the only way its resolvedKey can
  // reach the raise-side union below is a FRESH disk read via readPendingDivertFileAt at reconcile time.
  // Writing it before boot (Probe C/D's own pattern) would let PASS 1's own untouched boot-time reader
  // load it into memory first, and the atFilenameIdx in-memory union would then rescue resolvedKey
  // regardless of whether readPendingDivertFileAt itself works -- the exact "two bugs cancel out" trap
  // this card's own decision record already names for Probe C's pre-round-2 state.
  const dPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d));
  fs.writeFileSync(dPendingPath, JSON.stringify({
    repoPath: d, branch: "d-old-branch", reason: "4b06875f probe E: D's own OLDER pending-divert record, already carrying a legitimate resolvedKey=Ks",
    enteredAt: Date.now() - 60_000, tokens: ["4b06875f-rd-tok-old"], resolvedKey: Ks,
  }, null, 2) + "\n");
  check("(probe E precondition) D's own OLDER pending-divert file exists before the raise", fs.existsSync(dPendingPath));

  const rTokenE = enterMergeQuarantine(r, "r-branch", "4b06875f probe E: r raises, triggers protect via atFinalBasenameIdx only");

  const freshE = await freshBootModule();
  freshE.reenterMergeQuarantinesAtBoot([]);
  check("*** PROBE E *** activeMergeQuarantineFor(s) should STILL be blocked after reboot -- the reader must parse resolvedKey back off D's own pre-existing pending file, or the union sees both sides as undefined and Ks is lost",
    !!freshE.activeMergeQuarantineFor(s));
  check("(probe E) activeMergeQuarantineFor(d) is unaffected -- still correctly blocked via direct identity",
    !!freshE.activeMergeQuarantineFor(d));

  freshE.clearMergeQuarantineByToken(r, rTokenE);
  freshE.clearMergeQuarantineByToken(d, "4b06875f-rd-tok-d");
  freshE.clearMergeQuarantineByToken(d, "4b06875f-rd-tok-old");
  freshE.clearMergeQuarantineByRecordedPath(d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 050a4428, MEMORY-ONLY-KEY GUARD — a genuinely reachable production TRIPLE FAULT (an
  // existing-branch divert of a dual-armed entry whose own pending-divert write AND safety-tmp fallback
  // BOTH fail) leaves a surviving `pendingUnresolvedQuarantines` entry that is MEMORY-ONLY — disk never
  // had its content at all, so this is NOT a stale-vs-disk disagreement, it is the SOLE durable-ish copy.
  // `resolvedKey` is not decorative: per 4b06875f/883e29bc it IS the post-reboot enforcement for a
  // dual-armed twin's own secondary key. A later, same-identity `protectOccupantContentBeforeDelete`
  // call whose OWN freshly-read content carries no resolvedKey of its own (so the FIRST, disk-reconciled
  // union has no informative keys at all) must still let the SECOND union carry this memory-only key
  // forward — rejecting it purely because the disk side is empty would be a NEW fail-open, not a fix.
  //
  // STEP 1 (establish the triple fault): d3 is dual-armed [K3 (its own degraded, walked-up physical
  // slot — a never-existing subdirectory of r3), Kw3 (a genuinely distinct real repo's key, via d3's own
  // legacy `resolvedKey` field)] after boot. r3 raises into d3's already-armed `existing` slot at K3;
  // `final`'s own read is injected to fail persistently, forcing `mustDivert`; BOTH the divert's own
  // primary pending-divert write and its safety-tmp fallback are injected to fail too (the genuine
  // triple fault — `quarantineHashFor(d3)` degrades to K3 itself, since d3's nearest real ancestor is
  // r3, so the safety-tmp's own target collides with `final`'s own hash, matching the real production
  // mechanics exactly, not a contrived shape).
  //
  // STEP 2 (exercise the SECOND union): completely independently, y3 raises fresh. BEFORE that raise,
  // d3's OWN identity is planted, with ordinary, successfully-readable, NO-resolvedKey content, at y3's
  // own write target (`Ky3hash.json`) — simulating d3 later being found degraded-occupying a SECOND,
  // unrelated key, with nothing special about this one. y3's own raise reaches
  // `protectDegradedOccupantBeforeDelete` -> `protectOccupantContentBeforeDelete` for d3 (genuinely
  // foreign to y3, genuinely unresolvable) with NO injection active at all — the read succeeds, toPersist
  // carries no resolvedKey (nothing to exclude, genuinely never had one), so the FIRST (disk-reconciled)
  // union's own informative-key set is empty by construction. `reconcilePendingDivertTarget` then reads
  // d3's own deterministic pending-divert filename fresh from disk — ENOENT, confirming step 1's own
  // triple fault never reached disk — and the SECOND union against the step-1 memory-only entry is the
  // ONLY place Kw3 can come from.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r3 = makeToplevelRepo("050a-mem-only-r3");
  const K3 = canonicalRepoLockKey(r3);
  const K3hash = createHash("sha256").update(K3).digest("hex").slice(0, 24);
  const w3 = makeToplevelRepo("050a-mem-only-w3");
  const Kw3 = canonicalRepoLockKey(w3);
  if (createHash("sha256").update(Kw3).digest("hex").slice(0, 24) === K3hash) throw new Error("050a4428-mem-only: Kw3 collided with K3 — re-run");
  const d3 = path.join(r3, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const K3FinalPath = path.join(MERGE_QUARANTINE_DIR, `${K3hash}.json`);
  fs.writeFileSync(K3FinalPath, JSON.stringify({
    repoPath: d3, branch: "d3-branch", reason: "d3 dual-armed: own physical slot K3, legacy resolvedKey=Kw3",
    enteredAt: Date.now(), tokens: ["d3-token-orig"], resolvedKey: Kw3,
  }, null, 2) + "\n");
  // Deliberately NOT registering r3/w3 — must reach d163aef5's own collision-resolution path.
  reenterMergeQuarantinesAtBoot([]);
  check("(050a-mem-only precondition) d3 is `existing` at r3's own key K3", activeMergeQuarantineFor(r3)?.repoPath === d3);
  check("(050a-mem-only precondition) d3 is dual-armed at BOTH K3 and Kw3", (() => {
    const keys = new Set(activeMergeQuarantineFor(r3)?.armedKeys ?? []);
    return keys.has(K3) && keys.has(Kw3);
  })());
  check("(050a-mem-only precondition) w3 is already blocked too, via d3's own dual-arm", activeMergeQuarantineFor(w3)?.repoPath === d3);

  const d3PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d3));
  const injectRead = injectPersistentReadFailure(K3FinalPath);
  const injectWritePending = injectOpenSyncFailureForPrefix(d3PendingPath);
  const injectWriteSafety = injectOpenSyncFailureForPrefix(K3FinalPath);
  let r3Token;
  try {
    r3Token = enterMergeQuarantine(r3, "r3-branch", "r3 raises into d3's dual-armed existing entry; final unreadable, BOTH divert writes fail (triple fault)");
  } finally {
    injectWriteSafety.restore();
    injectWritePending.restore();
    injectRead.restore();
  }
  check("(050a-mem-only) the read failure was actually attempted", injectRead.count() >= 1);
  check("(050a-mem-only) the primary pending-divert write failure was actually attempted", injectWritePending.count() >= 1);
  check("(050a-mem-only) the safety-tmp fallback write failure was ALSO actually attempted (the genuine triple fault)", injectWriteSafety.count() >= 1);
  check("*** STEP 1 *** d3's own pending-divert file was NEVER actually written to disk", !fs.existsSync(d3PendingPath));
  check("*** STEP 1 *** no safety-tmp residue for d3/K3 was written either", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${K3hash}.json.tmp-safety-`)).length === 0);
  check("*** STEP 1 *** r3's own raise still persists IN-PROCESS despite the triple fault (e1cb7d33)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r3Token));
  // (sanity, NOT hazard-discriminating on its own) — w3 is still blocked here, but ONLY because
  // `activeQuarantines` was never evicted from step 1's own boot-time dual-arm, and K3's own ORIGINAL
  // physical file (never touched by the divert) STILL independently carries resolvedKey=Kw3 too — this
  // passes identically whether or not the SECOND union (the thing under test) carries Kw3 forward. The
  // real proof is the protective copy's own resolvedKey (below) and the POST-REBOOT check once K3's own
  // redundant copy is gone.
  check("(sanity) w3 is still blocked right after the triple fault", assertRepoNotQuarantined(w3).ok === false);

  // STEP 2 — independent raiser y3; d3 is found degraded-occupying y3's OWN write target, with ordinary,
  // successfully-readable, no-resolvedKey content. No injection active.
  const y3 = makeToplevelRepo("050a-mem-only-y3");
  const Ky3 = canonicalRepoLockKey(y3);
  const Ky3hash = createHash("sha256").update(Ky3).digest("hex").slice(0, 24);
  if (Ky3hash === K3hash || Ky3hash === createHash("sha256").update(Kw3).digest("hex").slice(0, 24)) throw new Error("050a4428-mem-only: Ky3 collided — re-run");
  const Ky3FinalPath = path.join(MERGE_QUARANTINE_DIR, `${Ky3hash}.json`);
  fs.writeFileSync(Ky3FinalPath, JSON.stringify({
    repoPath: d3, branch: "d3-branch-2", reason: "d3 degraded-occupying a SECOND, unrelated key, ordinary content, no resolvedKey",
    enteredAt: Date.now(), tokens: ["d3-token-step2"],
  }, null, 2) + "\n");

  const y3Token = enterMergeQuarantine(y3, "y3-branch", "y3 raises fresh; d3 is found degraded-occupying y3's own key, no injection");
  check("(050a-mem-only step 2 precondition) y3's own raise proceeded (protect succeeded, no divert needed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(y3Token));

  const d3ProtectiveFile = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .map((f) => ({ f, parsed: (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })() }))
    .find((e) => e.parsed?.repoPath === d3 && (e.parsed?.tokens ?? []).includes("d3-token-step2"));
  check("(050a-mem-only step 2 precondition) a protective copy for d3 was durably minted this time", !!d3ProtectiveFile);
  check("*** CARD 050a4428 *** d3's protective copy carries Kw3 — the memory-only key from step 1's triple fault, carried forward by the SECOND union, NEVER rejected just because the first union had no opinion",
    d3ProtectiveFile?.parsed.resolvedKey === Kw3);
  // (sanity, NOT hazard-discriminating on its own — same caveat as STEP 1's own immediate check above)
  check("(sanity) w3 is still blocked immediately after step 2", assertRepoNotQuarantined(w3).ok === false);

  // Remove K3's own ORIGINAL physical file now — it is a genuinely redundant, independent source of
  // Kw3 that step 1's own divert never touched (the divert, by design, never writes to `final`); nothing
  // about this card's own mechanism depends on it surviving, and leaving it in place would let it alone
  // re-arm Kw3 at the next boot regardless of what the pending-divert file carries, masking the very
  // thing this reboot check exists to prove. This is NOT the rejected "manufacture the premise
  // out-of-band" technique (an `fs.rmSync` standing in for an unreachable stale-vs-disk disagreement) —
  // the triple-fault premise above is already fully, genuinely established by real production code; this
  // step only removes an unrelated confound so the reboot check actually isolates the mechanism under
  // test, the SAME way `rebootSim`-style fixtures throughout this module scope what each boot sees.
  fs.rmSync(K3FinalPath);
  check("(precondition) K3's own original file is genuinely gone before the reboot", !fs.existsSync(K3FinalPath));

  const freshMemOnly = await freshBootModule();
  freshMemOnly.reenterMergeQuarantinesAtBoot([]);
  check("*** CARD 050a4428 (reboot) *** w3 (Kw3's own real repo) STAYS BLOCKED after a reboot, with K3's own redundant copy gone — the SECOND union's own write genuinely carried Kw3 forward and persisted it",
    freshMemOnly.assertRepoNotQuarantined(w3).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD d524d1c4, RESOLVEDKEY SURVIVES A MERGE-BRANCH DIVERT — divertRaiseEntry's merge branch
  // (indices.length > 0) used to build `merged` as `{...base.entry, ...}`, which NEVER read the
  // incoming raise's own resolvedKey/resolvedKeys at all — an ORDINARY single read fault (no triple
  // fault needed, unlike the MEMORY-ONLY-KEY GUARD above), reproduced via a production sequence with
  // zero out-of-band mutation to establish the premise: d4 is dual-armed [K4,Kw4] (its own physical slot
  // K4, legacy resolvedKey=Kw4); y4 (a totally independent raiser) finds d4 degraded-occupying y4's own
  // key, with ordinary, successfully-readable, no-resolvedKey content, minting a genuinely
  // reference-distinct pending record for d4's identity; r4 then raises AGAIN into d4's dual-armed
  // `existing` entry, final unreadable (ONE fault, the write itself succeeds normally) — the merge
  // branch runs, and pre-fix dropped Kw4 from the written record entirely.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r4 = makeToplevelRepo("d524d1c4-r4");
  const K4 = canonicalRepoLockKey(r4);
  const K4hash = createHash("sha256").update(K4).digest("hex").slice(0, 24);
  const w4 = makeToplevelRepo("d524d1c4-w4");
  const Kw4 = canonicalRepoLockKey(w4);
  if (createHash("sha256").update(Kw4).digest("hex").slice(0, 24) === K4hash) throw new Error("d524d1c4: Kw4 collided with K4 — re-run");
  const d4 = path.join(r4, "gone-subdir4");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const K4FinalPath = path.join(MERGE_QUARANTINE_DIR, `${K4hash}.json`);
  fs.writeFileSync(K4FinalPath, JSON.stringify({
    repoPath: d4, branch: "d4-branch", reason: "d4 dual-armed: own physical slot K4, legacy resolvedKey=Kw4",
    enteredAt: Date.now(), tokens: ["d4-token-orig"], resolvedKey: Kw4,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(d524d1c4 precondition) d4 is `existing` at r4's own key K4", activeMergeQuarantineFor(r4)?.repoPath === d4);
  check("(d524d1c4 precondition) d4 is dual-armed at BOTH K4 and Kw4", (() => {
    const keys = new Set(activeMergeQuarantineFor(r4)?.armedKeys ?? []);
    return keys.has(K4) && keys.has(Kw4);
  })());

  // An independent raiser y4 finds d4 degraded-occupying ITS OWN key, ordinary no-resolvedKey content,
  // NO injection — mints a genuinely reference-distinct pending record for d4's identity (EXACTLY the
  // MEMORY-ONLY-KEY GUARD's own Step 2 shape above, but under ordinary, non-triple-fault conditions).
  const y4 = makeToplevelRepo("d524d1c4-y4");
  const Ky4 = canonicalRepoLockKey(y4);
  const Ky4hash = createHash("sha256").update(Ky4).digest("hex").slice(0, 24);
  if (Ky4hash === K4hash || Ky4hash === createHash("sha256").update(Kw4).digest("hex").slice(0, 24)) throw new Error("d524d1c4: Ky4 collided — re-run");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Ky4hash}.json`), JSON.stringify({
    repoPath: d4, branch: "d4-branch-2", reason: "d4 degraded-occupying a SECOND, unrelated key, ordinary content, no resolvedKey",
    enteredAt: Date.now(), tokens: ["d4-token-step2"],
  }, null, 2) + "\n");
  const y4Token = enterMergeQuarantine(y4, "y4-branch", "y4 raises fresh; d4 is found degraded-occupying y4's own key, no injection");
  check("(d524d1c4 precondition) y4's own raise proceeded", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(y4Token));

  const d4PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d4));
  check("(d524d1c4 precondition) a protective pending copy for d4 was durably minted at d4's OWN deterministic filename", fs.existsSync(d4PendingPath));
  const d4PendingBefore = JSON.parse(fs.readFileSync(d4PendingPath, "utf8"));
  check("(d524d1c4 precondition) that protective copy carries NO resolvedKey of its own", d4PendingBefore.resolvedKey === undefined);

  // r4 raises AGAIN — enterMergeQuarantine's `existing` branch — forcing ONE ordinary read fault on d4's
  // own `final` (NOT a triple fault: the divert's own write below is left to succeed normally).
  const injectRead = injectPersistentReadFailure(K4FinalPath);
  let r4Token;
  try {
    r4Token = enterMergeQuarantine(r4, "r4-branch", "r4 raises again into d4's dual-armed existing entry; final unreadable, ORDINARY single fault");
  } finally {
    injectRead.restore();
  }
  check("(d524d1c4) the read failure was actually attempted", injectRead.count() >= 1);
  check("(d524d1c4) r4's own raise still persists IN-PROCESS despite the divert", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r4Token));

  const d4PendingAfter = JSON.parse(fs.readFileSync(d4PendingPath, "utf8"));
  check("*** CARD d524d1c4 *** the merge branch's own write carries Kw4 forward — the INCOMING raise's own dual-armed resolvedKey, never dropped just because the pre-existing pending record had none",
    d4PendingAfter.resolvedKey === Kw4 || (d4PendingAfter.resolvedKeys ?? []).includes(Kw4));
  check("(sanity) w4 is still blocked right after the merge divert (in-process)", assertRepoNotQuarantined(w4).ok === false);

  // Direct final-file removal as the isolation step — SAME technique, and SAME justification, as the
  // MEMORY-ONLY-KEY GUARD scenario above: K4's own original physical file is a genuinely redundant,
  // independent source of Kw4 that the divert never touched (divertRaiseEntry never writes to `final`);
  // the premise itself needed ZERO out-of-band mutation (both d4's dual-arm and the independent pending
  // record came from real production code paths above) — this step only removes an unrelated confound
  // so the reboot check below isolates the mechanism actually under test, never a substitute for it.
  fs.rmSync(K4FinalPath);
  check("(d524d1c4 precondition) K4's own original file is genuinely gone before the reboot", !fs.existsSync(K4FinalPath));

  const freshD524 = await freshBootModule();
  freshD524.reenterMergeQuarantinesAtBoot([]);
  check("*** CARD d524d1c4 (reboot) *** w4 (Kw4's own real repo) STAYS BLOCKED after a reboot, with K4's own redundant copy gone — the merge branch's own write genuinely carried Kw4 forward and persisted it",
    freshD524.assertRepoNotQuarantined(w4).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD bfc9356e — A PARTIAL clearMergeQuarantineByToken ON A DUAL-TRACKED TWIN LEAVES THE UNION
  // CORRECTLY ACTIVE AND AMBIGUOUS; A FULL CLEAR (every contributor's own token) RESOLVES IT CLEANLY.
  // Investigate-first finding: the SAME d524d1c4 fixture shape leaves the active entry a UNION of THREE
  // outstanding tokens by the time its own merge-branch divert runs (d6's own original, an independent
  // raiser y6's own token folded in as a contributor, and r6's own fresh re-raise token). Worker
  // 721c1123 called clearMergeQuarantineByToken(d6, "<d6's original token>") expecting a full reset and
  // instead saw the latch file persist (content rewritten, NOT removed — correct: 2 tokens remained) plus
  // assertRepoNotQuarantined's own pre-existing ambiguous-collision refusal (unrelated to the clear call
  // itself — the union already had >1 contributor before any clear ever ran). Verdict: correct
  // fail-closed behaviour, not a bug. See docs/decisions/8db913e2-*.md, "Follow-up bfc9356e".
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r6 = makeToplevelRepo("bfc9356e-r6");
  const K6 = canonicalRepoLockKey(r6);
  const K6hash = createHash("sha256").update(K6).digest("hex").slice(0, 24);
  const w6 = makeToplevelRepo("bfc9356e-w6");
  const Kw6 = canonicalRepoLockKey(w6);
  if (createHash("sha256").update(Kw6).digest("hex").slice(0, 24) === K6hash) throw new Error("bfc9356e: Kw6 collided with K6 — re-run");
  const d6 = path.join(r6, "gone-subdir6");

  const K6FinalPath = path.join(MERGE_QUARANTINE_DIR, `${K6hash}.json`);
  fs.writeFileSync(K6FinalPath, JSON.stringify({
    repoPath: d6, branch: "d6-branch", reason: "d6 dual-armed: own physical slot K6, legacy resolvedKey=Kw6",
    enteredAt: Date.now(), tokens: ["d6-token-orig"], resolvedKey: Kw6,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("*** CARD bfc9356e *** (precondition) d6 is dual-armed at BOTH K6 and Kw6", (() => {
    const keys = new Set(activeMergeQuarantineFor(r6)?.armedKeys ?? []);
    return keys.has(K6) && keys.has(Kw6);
  })());

  const y6 = makeToplevelRepo("bfc9356e-y6");
  const Ky6 = canonicalRepoLockKey(y6);
  const Ky6hash = createHash("sha256").update(Ky6).digest("hex").slice(0, 24);
  if (Ky6hash === K6hash || Ky6hash === createHash("sha256").update(Kw6).digest("hex").slice(0, 24)) throw new Error("bfc9356e: Ky6 collided — re-run");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Ky6hash}.json`), JSON.stringify({
    repoPath: d6, branch: "d6-branch-2", reason: "d6 degraded-occupying a SECOND, unrelated key, ordinary content, no resolvedKey",
    enteredAt: Date.now(), tokens: ["d6-token-step2"],
  }, null, 2) + "\n");
  const y6Token = enterMergeQuarantine(y6, "y6-branch", "y6 raises fresh; d6 is found degraded-occupying y6's own key, no injection");
  check("*** CARD bfc9356e *** (precondition) y6's own raise proceeded", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(y6Token));

  const d6PendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d6));
  check("*** CARD bfc9356e *** (precondition) a protective pending copy for d6 was durably minted", fs.existsSync(d6PendingPath));

  const injectRead6 = injectPersistentReadFailure(K6FinalPath);
  let r6Token;
  try {
    r6Token = enterMergeQuarantine(r6, "r6-branch", "r6 raises again into d6's dual-armed existing entry; final unreadable, ORDINARY single fault");
  } finally {
    injectRead6.restore();
  }
  check("*** CARD bfc9356e *** (precondition) r6's own raise still persists IN-PROCESS despite the divert", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r6Token));

  const d6Entry = activeMergeQuarantineFor(r6);
  check("*** CARD bfc9356e *** (precondition) the union now holds all THREE outstanding tokens", (() => {
    const tokens = new Set(d6Entry?.tokens ?? []);
    return tokens.has("d6-token-orig") && tokens.has("d6-token-step2") && tokens.has(r6Token) && tokens.size === 3;
  })());

  // ---- THE ACTUAL CALL UNDER INVESTIGATION: a PARTIAL by-token clear of d6's ORIGINAL token ----
  clearMergeQuarantineByToken(d6, "d6-token-orig");

  const afterPartial = activeMergeQuarantineFor(r6);
  check("*** CARD bfc9356e *** partial clear: the entry stays ACTIVE (not fully lifted)", !!afterPartial);
  check("*** CARD bfc9356e *** partial clear: exactly 2 tokens remain outstanding (d6-token-step2 + r6's own)", (afterPartial?.tokens ?? []).length === 2);
  check("*** CARD bfc9356e *** partial clear: K6's own final file still exists (correctly NOT removed — other tokens remain)", fs.existsSync(K6FinalPath));
  check("*** CARD bfc9356e *** partial clear: K6's own final file content no longer lists the cleared token", !(JSON.parse(fs.readFileSync(K6FinalPath, "utf8")).tokens ?? []).includes("d6-token-orig"));

  const w6Blocked = assertRepoNotQuarantined(w6);
  const r6Blocked = assertRepoNotQuarantined(r6);
  check("*** CARD bfc9356e *** partial clear: w6 (Kw6's own real repo) STAYS BLOCKED", w6Blocked.ok === false);
  check("*** CARD bfc9356e *** partial clear: r6 STAYS BLOCKED", r6Blocked.ok === false);
  // This IS the refusal 721c1123 originally described as an "unconfirmed-kill identity collision" — the
  // reason text embeds both an "unconfirmed-kill" clause (the outstanding-quarantine wording) and an
  // ambiguous/"collide" clause naming the other folded-in contributor identity; not a different refusal.
  check("*** CARD bfc9356e *** partial clear: the refusal reason is the 'unconfirmed-kill identity collision' 721c1123 described",
    w6Blocked.ok === false && /unconfirmed-kill/.test(w6Blocked.reason) && /ambiguous/.test(w6Blocked.reason) && /collide/.test(w6Blocked.reason));

  // ---- FULL CLEAR: every genuinely-outstanding contributor's own token ----
  for (const t of afterPartial?.tokens ?? []) {
    clearMergeQuarantineByToken(d6, t);
  }
  check("*** CARD bfc9356e *** full clear: the entry is fully lifted", activeMergeQuarantineFor(r6) === undefined);
  check("*** CARD bfc9356e *** full clear: K6's own final file is gone", !fs.existsSync(K6FinalPath));
  check("*** CARD bfc9356e *** full clear: d6's own pending-divert twin is gone too", !fs.existsSync(d6PendingPath));
  check("*** CARD bfc9356e *** full clear: w6 is NOW unblocked", assertRepoNotQuarantined(w6).ok === true);
  check("*** CARD bfc9356e *** full clear: r6 is NOW unblocked", assertRepoNotQuarantined(r6).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD d524d1c4, NO-KEY-DROPPED MATRIX — 3 matched pending entries (varying scalar/array shapes) plus
  // the incoming raise, DISAGREEING scalars. Exercises divertRaiseEntry's merge branch with
  // indices.length === 3 (never just 1, unlike the scenario above) by seeding three independent,
  // reference-distinct pending-divert files for the SAME unresolvable identity directly (the established
  // boot-time fixture technique — PASS 1 processes every `.json` file in the directory independently and
  // pushes each unresolvable/no-real-key one to `pendingUnresolvedQuarantines` on its own, with no
  // cross-file dedup by repoPath). M1 carries a scalar only; M2 an array only; M3 carries no key at all;
  // the incoming raise (via d5's own dual-armed `existing`) carries a scalar that DISAGREES with M1's.
  // Expected: the output's informative-key set is the union of every input's (minus nothing — see
  // below), and the scalar is dropped to `undefined` on disagreement while every key still survives in
  // `resolvedKeys`.
  //
  // M1/M2/M3's own keys are DELIBERATELY DISJOINT (Y, Z, no key — never a shared key across any two of
  // them): boot's own PRE-EXISTING, correct secondary-key-arming (`armQuarantineKey`/
  // `unionQuarantineEntries`, unrelated to this card) already unions any two degraded-divert entries
  // that happen to share an informative key, at ARM time, before divertRaiseEntry ever sees them — a
  // first draft of this fixture gave M2 `resolvedKeys:[Z,Y]` (deliberately overlapping M1's own Y) and
  // that boot-time union silently collapsed M1+M2 into ONE shared object, leaving only 2 genuinely
  // distinct matched entries where 3 were intended — caught by the `(precondition) M1 and M2 remain
  // genuinely distinct` check below, which would have failed loudly instead of silently testing a
  // smaller matrix than documented. Disjoint keys are what make `indices.length === 3` actually mean
  // three INDEPENDENT inputs reaching divertRaiseEntry's own merge logic, not boot's.
  //
  // `excludeLiftedResolvedKey`/`excludeLiftedResolvedKeys` are DELIBERATELY not exercised/applied here:
  // this path never touches `final` (divertRaiseEntry's own doc), so neither exclusion's premise (a
  // protective copy read from `final`, about to be superseded by THIS operation's own fresh write to
  // that same `final`) ever arises — there is nothing to subtract.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r5 = makeToplevelRepo("d524d1c4-matrix-r5");
  const K5 = canonicalRepoLockKey(r5);
  const K5hash = createHash("sha256").update(K5).digest("hex").slice(0, 24);
  const yKeyRepo = makeToplevelRepo("d524d1c4-matrix-Y");
  const Y = canonicalRepoLockKey(yKeyRepo);
  const zKeyRepo = makeToplevelRepo("d524d1c4-matrix-Z");
  const Z = canonicalRepoLockKey(zKeyRepo);
  const wKeyRepo = makeToplevelRepo("d524d1c4-matrix-W");
  const W = canonicalRepoLockKey(wKeyRepo);
  const allHashes = [K5hash, Y, Z, W].map((k) => createHash("sha256").update(k).digest("hex").slice(0, 24));
  if (new Set(allHashes).size !== allHashes.length) throw new Error("d524d1c4-matrix: a hash collided among K5/Y/Z/W — re-run");
  const d5 = path.join(r5, "gone-subdir5");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // d5's own `final` — dual-armed with the INCOMING raise's own scalar resolvedKey = W.
  const K5FinalPath = path.join(MERGE_QUARANTINE_DIR, `${K5hash}.json`);
  fs.writeFileSync(K5FinalPath, JSON.stringify({
    repoPath: d5, branch: "d524d1c4-matrix-d5-branch", reason: "d5 dual-armed: own physical slot K5, legacy resolvedKey=W",
    enteredAt: Date.now(), tokens: ["d524d1c4-matrix-d5-token-orig"], resolvedKey: W,
  }, null, 2) + "\n");
  // M1 — scalar only (resolvedKey=Y), earliest enteredAt (becomes `base`).
  const m1Path = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m1Path, JSON.stringify({
    repoPath: d5, branch: "d524d1c4-matrix-m1-branch", reason: "d524d1c4 matrix M1: scalar only",
    enteredAt: 1000, tokens: ["d524d1c4-matrix-m1-token"], resolvedKey: Y,
  }, null, 2) + "\n");
  // M2 — array only (resolvedKeys=[Z], DISJOINT from M1's own Y — see the header comment above).
  const m2Path = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m2Path, JSON.stringify({
    repoPath: d5, branch: "d524d1c4-matrix-m2-branch", reason: "d524d1c4 matrix M2: array only",
    enteredAt: 2000, tokens: ["d524d1c4-matrix-m2-token"], resolvedKeys: [Z],
  }, null, 2) + "\n");
  // M3 — no key at all.
  const m3Path = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m3Path, JSON.stringify({
    repoPath: d5, branch: "d524d1c4-matrix-m3-branch", reason: "d524d1c4 matrix M3: no key",
    enteredAt: 3000, tokens: ["d524d1c4-matrix-m3-token"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(d524d1c4 matrix precondition) d5 is `existing` at r5's own key K5, dual-armed at W too", (() => {
    const e = activeMergeQuarantineFor(r5);
    const keys = new Set(e?.armedKeys ?? []);
    return e?.repoPath === d5 && keys.has(K5) && keys.has(W);
  })());
  check("(d524d1c4 matrix precondition) all three M1/M2/M3 landed as SEPARATE pending entries for d5's identity",
    [m1Path, m2Path, m3Path].every((p) => fs.existsSync(p)));
  // CR 3555435b: boot's own arm-time union (when it fires) happens IN MEMORY only and never rewrites
  // either source file — reading m1Path/m2Path's own on-disk bytes here would pass identically whether
  // or not they were actually unioned, so it can't catch the collapse it documents. Assert IN-MEMORY
  // distinctness instead, via `listActiveMergeQuarantines()` (the same accessor the CR used to observe
  // the collapse): confirm there are two SEPARATE live entries for d5, one carrying ONLY M1's own token
  // and one carrying ONLY M2's own token — if boot had unioned them, a single entry would carry BOTH.
  check("(d524d1c4 matrix precondition) M1 and M2 remain genuinely distinct in-memory entries after boot (disjoint keys: boot's own secondary-key arming never unions them together before the divert)", (() => {
    const d5Entries = listActiveMergeQuarantines().filter((e) => e.repoPath === d5);
    const hasM1Alone = d5Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "d524d1c4-matrix-m1-token");
    const hasM2Alone = d5Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "d524d1c4-matrix-m2-token");
    return hasM1Alone && hasM2Alone;
  })());

  const injectRead5 = injectPersistentReadFailure(K5FinalPath);
  let r5Token;
  try {
    r5Token = enterMergeQuarantine(r5, "r5-branch", "d524d1c4 matrix: r5 raises again into d5's dual-armed existing entry; final unreadable, ordinary single fault");
  } finally {
    injectRead5.restore();
  }
  check("(d524d1c4 matrix) the read failure was actually attempted", injectRead5.count() >= 1);

  // M1 (earliest enteredAt) is `base` — the merged record lands at M1's own sourceFile.
  const mergedAfter = JSON.parse(fs.readFileSync(m1Path, "utf8"));
  const informativeAfter = new Set([
    ...(mergedAfter.resolvedKey !== undefined ? [mergedAfter.resolvedKey] : []),
    ...(mergedAfter.resolvedKeys ?? []),
  ]);
  check("*** CARD d524d1c4 (matrix) *** the output's informative-key set is >= the union of every input's own informative keys (Y from M1, Z from M2, W from the incoming raise) — minus nothing, since no lifted-key exclusion applies on this path",
    informativeAfter.has(Y) && informativeAfter.has(Z) && informativeAfter.has(W));
  check("*** CARD d524d1c4 (matrix) *** the scalar resolvedKey is left undefined on disagreement (M1's Y != the incoming raise's W), NOT arbitrarily picked from one side",
    mergedAfter.resolvedKey === undefined);
  check("(d524d1c4 matrix) M2's and M3's own sourceFiles were folded into the merged entry's orphanLatchFiles, never left dangling",
    (mergedAfter.orphanLatchFiles ?? []).includes(path.basename(m2Path)) && (mergedAfter.orphanLatchFiles ?? []).includes(path.basename(m3Path)));

  // Remove K5's own redundant final, AND M2's/M3's own still-physically-present original files — ALL
  // genuinely redundant, independent sources the divert's own write never touched (divertRaiseEntry only
  // ever rewrites `base.sourceFile`, i.e. m1Path; `others` — M2, M3 — are folded into the merged entry's
  // `orphanLatchFiles` but their own ORIGINAL bytes are never swept). CR 3555435b: without this removal,
  // Z would trivially re-arm from M2's own surviving orphan file (still carrying `resolvedKeys:[Z]`
  // unchanged) rather than from the merged record, so its reboot check would not discriminate the fix at
  // all. Removing it makes Z (and W, already isolated via K5FinalPath's own removal) genuinely depend on
  // the merged record at m1Path. Y stays a SANITY check regardless of this removal — it is `base`/M1's
  // OWN scalar, which even the ORIGINAL, buggy `{...base.entry}` spread always kept unconditionally
  // (base's own fields were never the ones this card's bug dropped); verified empirically via
  // `negative-control --ref HEAD~2` against the pre-fix source: Z and W's own reboot checks go RED,
  // Y's does not — see the check's own label below.
  fs.rmSync(K5FinalPath);
  fs.rmSync(m2Path);
  fs.rmSync(m3Path);
  check("(d524d1c4 matrix precondition) K5's, M2's, and M3's own original files are ALL genuinely gone before the reboot — the merged record at m1Path is the SOLE surviving source",
    !fs.existsSync(K5FinalPath) && !fs.existsSync(m2Path) && !fs.existsSync(m3Path));
  const freshMatrix = await freshBootModule();
  freshMatrix.reenterMergeQuarantinesAtBoot([]);
  check("(sanity, NOT hazard-discriminating — Y is base/M1's own key, always kept even by the pre-fix code; see the comment above) Y's own real repo STAYS BLOCKED after a reboot (resolvedKeys-only re-arm)", freshMatrix.assertRepoNotQuarantined(yKeyRepo).ok === false);
  check("*** CARD d524d1c4 (matrix, reboot) *** Z's own real repo STAYS BLOCKED after a reboot — the SOLE surviving source is the merged record's own resolvedKeys array (resolvedKeys-only re-arm)", freshMatrix.assertRepoNotQuarantined(zKeyRepo).ok === false);
  check("*** CARD d524d1c4 (matrix, reboot) *** W's own real repo STAYS BLOCKED after a reboot — the SOLE surviving source is the merged record's own resolvedKeys array (resolvedKeys-only re-arm)", freshMatrix.assertRepoNotQuarantined(wKeyRepo).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD d524d1c4, SCALAR KEPT WHEN EVERY INFORMATIVE INPUT AGREES — NOT a repro of this card's own bug
  // (it passes on main too, by construction: with a single matched entry that IS `base`, the original
  // buggy `{...base.entry}` spread trivially keeps that entry's own scalar regardless of this card's
  // fix). This instead guards against a DIFFERENT, hypothetical regression — some future change that
  // drops the scalar to `undefined` any time a union occurs at all, even when every informative input
  // agrees on the same key — which the matrix scenario above cannot catch (it only ever disagrees).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r6 = makeToplevelRepo("d524d1c4-agree-r6");
  const K6 = canonicalRepoLockKey(r6);
  const K6hash = createHash("sha256").update(K6).digest("hex").slice(0, 24);
  const yKeyRepo6 = makeToplevelRepo("d524d1c4-agree-Y6");
  const Y6 = canonicalRepoLockKey(yKeyRepo6);
  if (createHash("sha256").update(Y6).digest("hex").slice(0, 24) === K6hash) throw new Error("d524d1c4-agree: Y6 collided with K6 — re-run");
  const d6 = path.join(r6, "gone-subdir6");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const K6FinalPath = path.join(MERGE_QUARANTINE_DIR, `${K6hash}.json`);
  fs.writeFileSync(K6FinalPath, JSON.stringify({
    repoPath: d6, branch: "d524d1c4-agree-d6-branch", reason: "d6 dual-armed: own physical slot K6, legacy resolvedKey=Y6",
    enteredAt: Date.now(), tokens: ["d524d1c4-agree-d6-token-orig"], resolvedKey: Y6,
  }, null, 2) + "\n");
  const m6Path = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m6Path, JSON.stringify({
    repoPath: d6, branch: "d524d1c4-agree-m6-branch", reason: "d524d1c4 agree M6: SAME scalar resolvedKey=Y6 as the incoming raise's own dual-arm",
    enteredAt: Date.now(), tokens: ["d524d1c4-agree-m6-token"], resolvedKey: Y6,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(d524d1c4 agree precondition) d6 is `existing` at r6's own key K6, dual-armed at Y6 too", (() => {
    const e = activeMergeQuarantineFor(r6);
    const keys = new Set(e?.armedKeys ?? []);
    return e?.repoPath === d6 && keys.has(K6) && keys.has(Y6);
  })());

  const injectRead6 = injectPersistentReadFailure(K6FinalPath);
  try {
    enterMergeQuarantine(r6, "r6-branch", "d524d1c4 agree: r6 raises again into d6's dual-armed existing entry; final unreadable");
  } finally {
    injectRead6.restore();
  }
  const mergedAfter6 = JSON.parse(fs.readFileSync(m6Path, "utf8"));
  check("*** CARD d524d1c4 (agree) *** the scalar resolvedKey is KEPT (not needlessly dropped to undefined) when every informative input agrees",
    mergedAfter6.resolvedKey === Y6);
  check("(d524d1c4 agree) resolvedKeys still carries Y6 too (informativeKeysFor is a union, never scalar-xor-array)",
    (mergedAfter6.resolvedKeys ?? []).includes(Y6));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 00fd29d7, MERGETOKENINTOPENDINGENTRIES DROPS A SIBLING'S RESOLVEDKEYS, MADE DURABLE BY A LATER
  // PARTIAL CLEAR — mergeTokenIntoPendingEntries (the `!verified` twin of divertRaiseEntry's own merge
  // branch, d524d1c4) built `merged` as `{...base.entry, tokens, orphanLatchFiles, contributorRepoPaths,
  // provenanceUnknown, provenanceTracked}` — NEVER reading resolvedKey/resolvedKeys from ANY matched
  // entry at all. d7 = r7/gone-subdir7 is genuinely unresolvable (r7 exists, the subdir does not); M1 (no
  // key, enteredAt 1000) and M2 (resolvedKeys=[Z7], enteredAt 2000) are two independent pending-divert
  // records for d7's own identity. A fresh raise on d7 (still unresolvable) takes enterMergeQuarantine's
  // own `!verified` branch straight into mergeTokenIntoPendingEntries (never divertRaiseEntry — that
  // branch is reached only via the `existing`/`verified` write-fault paths) — pre-fix, the merged record
  // (written at M1's own sourceFile, M1 being the earliest-enteredAt `base`) drops Z7 entirely. A later
  // PARTIAL clear of M1's own token then makes the drop DURABLE: rewriteOrphanLatchFilesAfterPartialClear
  // overwrites M2's own folded orphan file with the SAME key-less merged content — so a reboot afterward
  // unblocks Z7's own real repo even though m2-token was never cleared.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r7 = makeToplevelRepo("00fd29d7-r7");
  const d7 = path.join(r7, "gone-subdir7");
  const zRepo7 = makeToplevelRepo("00fd29d7-Z7");
  const Z7 = canonicalRepoLockKey(zRepo7);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // M1 — no key at all, earliest enteredAt (becomes `base`, keeps its own sourceFile as the merge target).
  const m1Path7 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m1Path7, JSON.stringify({
    repoPath: d7, branch: "00fd29d7-m1-branch", reason: "00fd29d7 M1: no key",
    enteredAt: 1000, tokens: ["00fd29d7-m1-token"],
  }, null, 2) + "\n");
  // M2 — resolvedKeys=[Z7], later enteredAt (becomes `others`, folded into the merged entry's orphanLatchFiles).
  const m2Path7 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m2Path7, JSON.stringify({
    repoPath: d7, branch: "00fd29d7-m2-branch", reason: "00fd29d7 M2: resolvedKeys=[Z7]",
    enteredAt: 2000, tokens: ["00fd29d7-m2-token"], resolvedKeys: [Z7],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(00fd29d7 precondition) Z7's own real repo is blocked right after boot (from M2's own file)", assertRepoNotQuarantined(zRepo7).ok === false);
  check("(00fd29d7 precondition) M1 and M2 remain genuinely distinct pending entries for d7's identity after boot", (() => {
    const d7Entries = listActiveMergeQuarantines().filter((e) => e.repoPath === d7);
    const hasM1Alone = d7Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "00fd29d7-m1-token");
    const hasM2Alone = d7Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "00fd29d7-m2-token");
    return hasM1Alone && hasM2Alone;
  })());

  const r7Token = enterMergeQuarantine(d7, "r7-branch", "00fd29d7: a fresh raise on d7, still unresolvable — routes into mergeTokenIntoPendingEntries");
  check("(00fd29d7) the raise's own token persists in-process", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(r7Token));

  const mergedAfter7 = JSON.parse(fs.readFileSync(m1Path7, "utf8"));
  check("*** CARD 00fd29d7 *** mergeTokenIntoPendingEntries' own merged record carries M2's own resolvedKeys (Z7) forward, never dropped just because `base` (M1) had none",
    (mergedAfter7.resolvedKeys ?? []).includes(Z7));
  check("(00fd29d7) M2's own sourceFile was folded into the merged entry's orphanLatchFiles, never left dangling",
    (mergedAfter7.orphanLatchFiles ?? []).includes(path.basename(m2Path7)));
  check("(sanity) Z7 is still blocked right after the merge (in-process)", assertRepoNotQuarantined(zRepo7).ok === false);

  // The partial clear that makes a pre-fix drop DURABLE: clearing M1's own token leaves the raise's own
  // token (and M2's own) still outstanding — NOT the last token — so this is the partial-clear branch of
  // clearTokenFromPendingIndices, which durably rewrites M1's own sourceFile AND (via
  // rewriteOrphanLatchFilesAfterPartialClear) folds the SAME reduced content into M2's own orphan file.
  clearMergeQuarantineByToken(d7, "00fd29d7-m1-token");
  const m1After7 = JSON.parse(fs.readFileSync(m1Path7, "utf8"));
  check("(00fd29d7) M1's own token is genuinely gone after the partial clear", !(m1After7.tokens ?? []).includes("00fd29d7-m1-token"));
  const m2After7 = JSON.parse(fs.readFileSync(m2Path7, "utf8"));
  check("(00fd29d7 precondition) the partial clear actually rewrote M2's own orphan file with the SAME reduced content (never left stale) — the mechanism this card's own durability hazard depends on",
    JSON.stringify((m2After7.tokens ?? []).slice().sort()) === JSON.stringify((m1After7.tokens ?? []).slice().sort()));
  check("*** CARD 00fd29d7 *** the partially-cleared record (both M1's own file AND M2's own rewritten orphan copy) STILL carries Z7 forward after the clear",
    (m1After7.resolvedKeys ?? []).includes(Z7) && (m2After7.resolvedKeys ?? []).includes(Z7));

  const fresh00fd = await freshBootModule();
  fresh00fd.reenterMergeQuarantinesAtBoot([]);
  check("*** CARD 00fd29d7 (reboot) *** Z7's own real repo STAYS BLOCKED after a reboot, even though m2-token was never cleared — the fix's own union survives both the partial clear and the reboot",
    fresh00fd.assertRepoNotQuarantined(zRepo7).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 3d27c045, MERGETOKENINTOPENDINGENTRIES DROPS armedKeys, ORPHANING A BOOT-DIVERTED TWIN'S OTHER
  // KEY FOREVER — mergeTokenIntoPendingEntries (the SAME `!verified` merge branch 00fd29d7 fixed for
  // resolvedKey/resolvedKeys above) built `merged` with NO `armedKeys` field at all, even though a
  // matched entry can be an 883e29bc boot-diverted TWIN (armed in activeQuarantines under its own
  // resolvedKey(s), per @decision 64283e06's own replaceEntryEverywhere re-point). d9 = r9/gone-subdir9
  // is genuinely unresolvable; M1 (no key, enteredAt 1000, becomes `base`), M2 (resolvedKeys=[Z9],
  // enteredAt 2000) and M3 (resolvedKeys=[W9], enteredAt 3000) are three independent pending-divert
  // records for d9's own identity — M2 and M3 each graduate into a genuine 883e29bc twin at boot (armed
  // in activeQuarantines at their own resolvedKey). A fresh raise on d9 (still unresolvable) merges all
  // three via mergeTokenIntoPendingEntries — pre-fix, the merged record's own `armedKeys` is dropped
  // entirely even though it now sits in activeQuarantines at BOTH Z9 and W9 (replaceEntryEverywhere
  // re-points by VALUE, so the in-memory slots stay consistent regardless — the drop is invisible until
  // something walks "every key this entry is armed under" via `entry.armedKeys` itself, which several
  // clear-path helpers fall back to `[key]` — the ONE key already in hand — when it's empty):
  // `clearMergeQuarantineByKey`'s own `keysToLift` (merge-quarantine.ts) is exactly such a helper. Clearing
  // EVERY outstanding token (t1, t2, t3, the raise token) therefore lifts only ONE of Z9/W9 — whichever
  // key `clearMergeQuarantineByToken`'s own Map iteration happens to visit first — and leaves the OTHER
  // stuck, armed forever in-process, holding a stale, should-be-empty token set with no pending reference
  // left to recover it on a later query; a REBOOT then makes it WORSE, not better — see the decision
  // record's own "Why this is a DURABLE, cross-reboot loss" section. A PARTIAL clear (only two of the four
  // tokens) is also pinned below, both in-process and after a reboot, so a future regression in the
  // OPPOSITE direction (over-lifting on a partial clear) goes red too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r9 = makeToplevelRepo("3d27c045-r9");
  const d9 = path.join(r9, "gone-subdir9");
  const zRepo9 = makeToplevelRepo("3d27c045-Z9");
  const wRepo9 = makeToplevelRepo("3d27c045-W9");
  const Z9 = canonicalRepoLockKey(zRepo9);
  const W9 = canonicalRepoLockKey(wRepo9);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // M1 — no key at all, earliest enteredAt (becomes `base`, keeps its own sourceFile as the merge target).
  const m1Path9 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m1Path9, JSON.stringify({
    repoPath: d9, branch: "3d27c045-m1-branch", reason: "3d27c045 M1: no key",
    enteredAt: 1000, tokens: ["3d27c045-m1-token"],
  }, null, 2) + "\n");
  // M2 — resolvedKeys=[Z9]: graduates into an 883e29bc twin armed at Z9.
  const m2Path9 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m2Path9, JSON.stringify({
    repoPath: d9, branch: "3d27c045-m2-branch", reason: "3d27c045 M2: resolvedKeys=[Z9]",
    enteredAt: 2000, tokens: ["3d27c045-m2-token"], resolvedKeys: [Z9],
  }, null, 2) + "\n");
  // M3 — resolvedKeys=[W9]: graduates into an 883e29bc twin armed at W9.
  const m3Path9 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m3Path9, JSON.stringify({
    repoPath: d9, branch: "3d27c045-m3-branch", reason: "3d27c045 M3: resolvedKeys=[W9]",
    enteredAt: 3000, tokens: ["3d27c045-m3-token"], resolvedKeys: [W9],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  check("(3d27c045 precondition) Z9's own real repo is blocked right after boot (M2's own twin arm)", assertRepoNotQuarantined(zRepo9).ok === false);
  check("(3d27c045 precondition) W9's own real repo is blocked right after boot (M3's own twin arm)", assertRepoNotQuarantined(wRepo9).ok === false);
  check("(3d27c045 precondition) M2 is a genuine 883e29bc twin — armed in activeQuarantines at Z9, with its own armedKeys naming Z9",
    (activeMergeQuarantineFor(zRepo9)?.armedKeys ?? []).includes(Z9));
  check("(3d27c045 precondition) M3 is a genuine 883e29bc twin — armed in activeQuarantines at W9, with its own armedKeys naming W9",
    (activeMergeQuarantineFor(wRepo9)?.armedKeys ?? []).includes(W9));
  check("(3d27c045 precondition) M1, M2 and M3 remain genuinely distinct pending entries for d9's identity after boot", (() => {
    const d9Entries = listActiveMergeQuarantines().filter((e) => e.repoPath === d9);
    return d9Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "3d27c045-m1-token")
      && d9Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "3d27c045-m2-token")
      && d9Entries.some((e) => e.tokens.length === 1 && e.tokens[0] === "3d27c045-m3-token");
  })());

  const raiseToken9 = enterMergeQuarantine(d9, "3d27c045-raise-branch", "3d27c045: a fresh raise on d9, still unresolvable — routes into mergeTokenIntoPendingEntries, merging all three twins");

  check("*** CARD 3d27c045 *** the merged entry's own armedKeys carries BOTH twins' keys forward (Z9 and W9), never dropped just because `base` (M1) was never armed anywhere",
    (() => {
      const merged = activeMergeQuarantineFor(zRepo9);
      return merged !== undefined && merged === activeMergeQuarantineFor(wRepo9)
        && (merged.armedKeys ?? []).includes(Z9) && (merged.armedKeys ?? []).includes(W9);
    })());
  check("(sanity) Z9 and W9 are still blocked right after the merge (in-process)",
    assertRepoNotQuarantined(zRepo9).ok === false && assertRepoNotQuarantined(wRepo9).ok === false);

  // A PARTIAL clear (only two of the four outstanding tokens) must never OVER-lift either key — the
  // opposite failure from this card's own bug. Pinned so a future regression in the OTHER direction
  // (lifting too much on a partial clear) goes red too, not just the under-lift this card fixes.
  clearMergeQuarantineByToken(d9, "3d27c045-m2-token");
  clearMergeQuarantineByToken(d9, "3d27c045-m3-token");
  check("*** CARD 3d27c045 (partial clear) *** Z9 and W9 BOTH stay blocked in-process after clearing only m2/m3 — the merged entry still correctly owns both keys with two tokens (m1, raise) still outstanding",
    assertRepoNotQuarantined(zRepo9).ok === false && assertRepoNotQuarantined(wRepo9).ok === false);
  const freshPartial9 = await freshBootModule();
  freshPartial9.reenterMergeQuarantinesAtBoot([]);
  check("*** CARD 3d27c045 (partial clear, reboot) *** Z9 and W9 BOTH stay blocked after a reboot too — a partial clear must never under- OR over-lift either key",
    freshPartial9.assertRepoNotQuarantined(zRepo9).ok === false && freshPartial9.assertRepoNotQuarantined(wRepo9).ok === false);

  // The DoD's own "clears EVERY token" scenario: the remaining two partial clears (tokens still
  // outstanding after the first) followed by the fourth, LAST clear (a genuine full lift of the merged entry).
  clearMergeQuarantineByToken(d9, "3d27c045-m1-token");
  clearMergeQuarantineByToken(d9, raiseToken9);

  check("*** CARD 3d27c045 (in-process) *** Z9's own real repo is NO LONGER blocked after every token is cleared",
    assertRepoNotQuarantined(zRepo9).ok === true);
  check("*** CARD 3d27c045 (in-process) *** W9's own real repo is NO LONGER blocked after every token is cleared",
    assertRepoNotQuarantined(wRepo9).ok === true);
  check("*** CARD 3d27c045 (in-process) *** no stale entry for d9's identity survives the full clear (neither pending nor an orphaned active arm)",
    listActiveMergeQuarantines().filter((e) => e.repoPath === d9).length === 0);

  const fresh3d27c045 = await freshBootModule();
  fresh3d27c045.reenterMergeQuarantinesAtBoot([]);
  check("*** CARD 3d27c045 (reboot) *** Z9's own real repo is NOT re-blocked after a reboot — nothing durable survives naming an already-cleared token",
    fresh3d27c045.assertRepoNotQuarantined(zRepo9).ok === true);
  check("*** CARD 3d27c045 (reboot) *** W9's own real repo is NOT re-blocked after a reboot — nothing durable survives naming an already-cleared token",
    fresh3d27c045.assertRepoNotQuarantined(wRepo9).ok === true);
  }

  // CARD 3152ec90, CLEARMERGEQUARANTINEBYKEY'S OWN keysToLift LIFTS AN UNRELATED RAISE'S LIVE MAP SLOT —
  // Code Review 7c48d35c of this card's own 3d27c045 fix: `clearMergeQuarantineByKey`'s `keysToLift`
  // (merge-quarantine.ts) deletes EVERY key in `entry.armedKeys` from `activeQuarantines` unconditionally,
  // never gated by `entryStillOwnsKey` the way its own pending-sibling loop two screens down already is.
  // Once a boot-diverted twin's OWN armedKeys goes stale (the freed key gets reused by a totally
  // unrelated, later raise U), clearing the STALE entry's tokens deletes U's own live map slot — U is
  // NOT fail-open (deleteMergeQuarantineLatchByKey's own protect-before-delete chokepoint re-homes U's
  // content into a pending-divert record, and activeMergeQuarantineFor's lazy-graduation re-arms it on
  // the very next query — a deliberate but INCIDENTAL rescue, not designed for this bug), but the map
  // slot itself is destroyed and rebuilt for no reason. THE FIX: `keysToLift`'s non-`key` members are now
  // filtered through `entryStillOwnsKey` first, mirroring the existing pending-sibling gate; U's own slot
  // is never touched at all. The SAME gate is also applied to `quarantineLatchFileIdsFor` (a stale
  // armedKeys member would otherwise hand out U's own latch id as if it belonged to d9) and to
  // `clearMergeQuarantineByRecordedPath`'s own `activeLiftedKeys` (its own exclusion-set union feeding
  // `excludeLiftedResolvedKey` downstream) — see the decision record's own "Follow-up 3152ec90" for why
  // the latter was NOT independently reproduced as fail-open, and was fixed anyway (narrowing only).
  {
  const r9c = makeToplevelRepo("3152ec90-r9");
  const d9c = path.join(r9c, "gone-subdir9c");
  const zRepoC = makeToplevelRepo("3152ec90-Z");
  const wRepoC = makeToplevelRepo("3152ec90-W");
  const Zc = canonicalRepoLockKey(zRepoC);
  const Wc = canonicalRepoLockKey(wRepoC);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const m1PathC = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m1PathC, JSON.stringify({
    repoPath: d9c, branch: "3152ec90-m1-branch", reason: "3152ec90 M1: no key",
    enteredAt: 1000, tokens: ["3152ec90-m1-token"],
  }, null, 2) + "\n");
  const m2PathC = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m2PathC, JSON.stringify({
    repoPath: d9c, branch: "3152ec90-m2-branch", reason: "3152ec90 M2: resolvedKeys=[Z]",
    enteredAt: 2000, tokens: ["3152ec90-m2-token"], resolvedKeys: [Zc],
  }, null, 2) + "\n");
  const m3PathC = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m3PathC, JSON.stringify({
    repoPath: d9c, branch: "3152ec90-m3-branch", reason: "3152ec90 M3: resolvedKeys=[W]",
    enteredAt: 3000, tokens: ["3152ec90-m3-token"], resolvedKeys: [Wc],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(3152ec90 precondition) Zc's own real repo is blocked right after boot (M2's own twin arm)", assertRepoNotQuarantined(zRepoC).ok === false);

  // Step 2: clearMergeQuarantine(zRepoC) lifts Z's twin arm (M2's own); M2's pending record survives
  // (clearMergeQuarantine is addressed by zRepoC's OWN identity, never d9c's) with its stale armedKeys=[Z].
  clearMergeQuarantine(zRepoC);
  check("(3152ec90 step 2) Zc is NOT quarantined right after its own clear", assertRepoNotQuarantined(zRepoC).ok === true);

  // Step 3: an unrelated raise U on zRepoC arms Z (reusing the freed key).
  const uToken152 = enterMergeQuarantine(zRepoC, "3152ec90-U-branch", "3152ec90: unrelated raise U on zRepoC reusing the freed key Z");
  check("(3152ec90 step 3) Zc IS quarantined by U right after U's raise", assertRepoNotQuarantined(zRepoC).ok === false);

  // Step 4: a d9c raise merges the twins (M1+M2+M3) via mergeTokenIntoPendingEntries, giving
  // armedKeys=[Z,W] with Z stale (U now genuinely owns Z, not d9c).
  const raiseToken152 = enterMergeQuarantine(d9c, "3152ec90-d9-raise-branch", "3152ec90: d9c raise merging M1/M2/M3 twins");
  const d9cMerged = activeMergeQuarantineFor(d9c);
  check("(3152ec90 step 4) d9c's merged entry carries armedKeys [Z,W] (Z stale)", (d9cMerged?.armedKeys ?? []).includes(Zc) && (d9cMerged?.armedKeys ?? []).includes(Wc));

  // *** CARD 3152ec90 (quarantineLatchFileIdsFor) *** the listing for d9c must never name U's own latch
  // id — U's own id (from its OWN, correctly-owned entry) must not appear among d9c's ids.
  const uOwnId152 = quarantineLatchFileIdsFor(activeMergeQuarantineFor(zRepoC))[0];
  check("*** CARD 3152ec90 (quarantineLatchFileIdsFor) *** d9c's own listed ids do NOT name U's own latch id",
    !quarantineLatchFileIdsFor(d9cMerged).includes(uOwnId152));

  // Step 5: clear EVERY d9c token (m1, m2, m3, raise) — the LAST clear hits clearMergeQuarantineByKey
  // with entry.armedKeys=[Z,W]; pre-fix, the unconditional delete wiped U's live map slot at Z.
  clearMergeQuarantineByToken(d9c, "3152ec90-m1-token");
  clearMergeQuarantineByToken(d9c, "3152ec90-m2-token");
  clearMergeQuarantineByToken(d9c, "3152ec90-m3-token");
  clearMergeQuarantineByToken(d9c, raiseToken152);

  check("(3152ec90 step 5) d9c itself is fully cleared", assertRepoNotQuarantined(d9c).ok === true);

  // *** CARD 3152ec90 (THE KEY ASSERTION) *** immediately after the clear, BEFORE any query of zRepoC
  // (which would trigger activeMergeQuarantineFor's own lazy-graduation re-arm and mask the defect), U's
  // own entry (found by its token) must STILL carry armedKeys including Z — i.e. the fix means U's own
  // map slot was never touched at all, not merely that it gets rescued afterward.
  const uRaw152 = listActiveMergeQuarantines().find((e) => e.tokens.includes(uToken152));
  check("*** CARD 3152ec90 (THE FIX) *** U's own entry still carries armedKeys including Z immediately after the clear, untouched",
    !!uRaw152 && (uRaw152.armedKeys ?? []).includes(Zc));
  // And the dir-state corollary: U's own final `<hash>.json` is still in place, never renamed to a
  // pending-divert name — the protect-and-rehome dance never fires at all once Z is never touched.
  check("*** CARD 3152ec90 (THE FIX, dir state) *** U's own final latch file is still in place, never diverted to pending-*",
    fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${uOwnId152}.json`)));

  check("(3152ec90, sanity) Zc (U) is still blocked in-process — U's own token is still outstanding",
    assertRepoNotQuarantined(zRepoC).ok === false);

  const fresh152 = await freshBootModule();
  fresh152.reenterMergeQuarantinesAtBoot([]);
  check("(3152ec90, reboot) Zc (U) is still blocked after a reboot", fresh152.assertRepoNotQuarantined(zRepoC).ok === false);
  check("(3152ec90, reboot) d9c stays clear after reboot (not resurrected)", fresh152.assertRepoNotQuarantined(d9c).ok === true);

  fresh152.clearMergeQuarantineByToken(zRepoC, uToken152);
  check("*** CARD 3152ec90 (U's own token still clears it) *** Zc unblocked after clearing U's real token post-reboot",
    fresh152.assertRepoNotQuarantined(zRepoC).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // CARD 78fccd3f, item 1 — `enterMergeQuarantine`'s existing-branch raise built `liftedKeys` as a bare,
  // UNFILTERED `[key, ...entry.armedKeys]`, re-including a stale armedKeys member `entryStillOwnsKey`
  // would reject (the over-include direction `3152ec90` already fixed for `keysToLift`). `liftedKeys`
  // feeds ONLY `excludeLiftedResolvedKey(s)`, so over-inclusion there is FAIL-OPEN. An honest repro
  // attempt (worker_report, this card) found no constructible scenario where this site's own protect
  // call reaches a REAL on-disk foreign occupant to exercise the exclusion on — narrowing-only here,
  // fail-open NOT reproduced. THE FIX: this site now calls the new shared `ownedKeysIncluding(key, entry)`
  // helper (mirrors `keysToLift`'s own filter), tested DIRECTLY below (the end-to-end protective-copy
  // path can't discriminate filtered from unfiltered here, since nothing is ever written either way).
  //
  // `deleteMergeQuarantineLatchByKey`'s own former DEFAULT (used when no override narrows it) was a
  // SEPARATE, genuinely reproduced CRITICAL regression — CR of this commit: its one caller
  // (`clearMergeQuarantineByKey`'s own primary `keysToLift` loop) deletes every lifted key from
  // `activeQuarantines` BEFORE calling it, so re-deriving `liftedKeys` from `entry.armedKeys` against
  // that ALREADY-EMPTIED map made `entryStillOwnsKey` reject every other key, re-blocking an
  // already-cleared repo after a reboot. Fixed by passing `keysToLift` (computed before the deletes) as
  // an explicit override and REMOVING the default entirely — see
  // `78fccd3f-dual-arm-clear-route-resurrection` in merge-quarantine-runtime-union-provenance.mjs.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r10 = makeToplevelRepo("78fccd3f-r10");
  const d10 = path.join(r10, "gone-subdir10");
  const zRepo10 = makeToplevelRepo("78fccd3f-Z");
  const wRepo10 = makeToplevelRepo("78fccd3f-W");
  const Z10 = canonicalRepoLockKey(zRepo10);
  const W10 = canonicalRepoLockKey(wRepo10);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const m1Path10 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m1Path10, JSON.stringify({
    repoPath: d10, branch: "78fccd3f-m1-branch", reason: "78fccd3f M1: no key",
    enteredAt: 1000, tokens: ["78fccd3f-m1-token"],
  }, null, 2) + "\n");
  const m2Path10 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m2Path10, JSON.stringify({
    repoPath: d10, branch: "78fccd3f-m2-branch", reason: "78fccd3f M2: resolvedKeys=[Z]",
    enteredAt: 2000, tokens: ["78fccd3f-m2-token"], resolvedKeys: [Z10],
  }, null, 2) + "\n");
  const m3Path10 = path.join(MERGE_QUARANTINE_DIR, `pending-${randomUUID().replace(/-/g, "").slice(0, 24)}.json`);
  fs.writeFileSync(m3Path10, JSON.stringify({
    repoPath: d10, branch: "78fccd3f-m3-branch", reason: "78fccd3f M3: resolvedKeys=[W]",
    enteredAt: 3000, tokens: ["78fccd3f-m3-token"], resolvedKeys: [W10],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Free Z10 and let an unrelated raise U reuse it — Z10 is now STALE relative to d10's own eventual twin.
  clearMergeQuarantine(zRepo10);
  const u10Token = enterMergeQuarantine(zRepo10, "78fccd3f-U-branch", "78fccd3f: unrelated raise U reusing freed Z10");
  check("(78fccd3f precondition) Z10 is now owned by U, not d10", assertRepoNotQuarantined(zRepo10).ok === false);

  // d10 raise merges M1+M2+M3 -> entry armedKeys=[Z10(stale), W10(owned)].
  const d10RaiseToken = enterMergeQuarantine(d10, "78fccd3f-d10-raise-branch", "78fccd3f: d10 raise merging M1/M2/M3 twins");
  const entry10 = activeMergeQuarantineFor(d10);
  check("(78fccd3f precondition) d10's merged entry armedKeys includes both Z10 (stale) and W10 (owned)",
    (entry10?.armedKeys ?? []).includes(Z10) && (entry10?.armedKeys ?? []).includes(W10));
  check("(78fccd3f precondition) Z10 is genuinely stale relative to d10's own entry (entryStillOwnsKey's own premise)",
    activeMergeQuarantineFor(zRepo10) !== entry10);

  // *** CARD 78fccd3f *** THE HELPER ITSELF: W10 (still owned) survives; Z10 (stale) is excluded — even
  // though entry10.armedKeys itself still names both.
  const owned10 = ownedKeysIncluding(W10, entry10);
  check("*** CARD 78fccd3f *** ownedKeysIncluding(W10, entry) excludes the stale Z10 member",
    !owned10.includes(Z10));
  check("*** CARD 78fccd3f *** ownedKeysIncluding(W10, entry) still includes W10 itself",
    owned10.includes(W10));
  check("*** CARD 78fccd3f *** ownedKeysIncluding(W10, entry) returns EXACTLY [W10] here — nothing else",
    owned10.length === 1 && owned10[0] === W10);
  // Degrade case: an undefined entry is just [key], never a crash.
  check("*** CARD 78fccd3f *** ownedKeysIncluding(key, undefined) degrades to [key]",
    JSON.stringify(ownedKeysIncluding(W10, undefined)) === JSON.stringify([W10]));

  // Sanity: a entry's OWN currently-genuinely-owned secondary key is kept (this is NOT over-narrowing).
  check("(78fccd3f sanity) W10 itself is still blocked (never touched by the checks above)",
    assertRepoNotQuarantined(wRepo10).ok === false);
  check("(78fccd3f sanity) U's own Z10 arm is untouched by the checks above",
    assertRepoNotQuarantined(zRepo10).ok === false);

  // Clean up this scenario's own outstanding tokens so later serial runs of this file see a clean slate.
  clearMergeQuarantineByToken(zRepo10, u10Token);
  clearMergeQuarantineByToken(d10, "78fccd3f-m1-token");
  clearMergeQuarantineByToken(d10, "78fccd3f-m2-token");
  clearMergeQuarantineByToken(d10, "78fccd3f-m3-token");
  clearMergeQuarantineByToken(d10, d10RaiseToken);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a raise (enterMergeQuarantine) no longer overwrites a kept occupant's physical file " +
    "at its own key: a protect call's own `false` return now diverts the raise to a pending-divert " +
    "record instead of proceeding (shape 1); a MARKED-but-\"none\" re-check carries the on-disk occupant's " +
    "own token forward rather than trusting a stale verdict (shape 2); and the SAME decision is wired at " +
    "`enterMergeQuarantine`'s OTHER raise-write site (the `existing`-truthy region). The raise itself " +
    "still always persists (e1cb7d33) — only WHERE it persists differs when `final` cannot be safely " +
    "written to. Shape 3 (a same-identity re-raise's successful rename losing an outstanding token) is " +
    "covered by `round5-rename-unmarks` in merge-quarantine-protect-read-failure.mjs. " +
    "ROUND 2 (Code Review 96a39432, B1): the token carry-forward is now `writeMergeQuarantineLatch`'s own " +
    "chokepoint (`reconcileMarkedBasenameBeforeWrite`), reached by EVERY writer — a diverted raise's own " +
    "later lazy-graduation (skipDegradedOccupantGuard FALSE) no longer loses the ORIGINAL token physically " +
    "sitting at `final`, in-process and across a reboot with no clear at all (b1). When `final` is STILL " +
    "unreadable at graduation time, the pre-existing degraded-occupant guard already refuses that write " +
    "outright — both tokens still survive a reboot via the diverted pending record's own durability (the " +
    "graduation variant). " +
    "ROUND 3 (Code Review 1da7261f, B1/B2): a process-wide `clearedTokens` tombstone, subtracted from " +
    "every on-disk-token union, stops a stale pre-clear copy of `final` from resurrecting a token this " +
    "process already durably cleared — including across a SECOND, independent transient read failure " +
    "(b1-resurrection). The caller's own fold-in read is now the ONLY read for its own write " +
    "(`reconciledAlready`) rather than a second, independent chokepoint read of the same file for the " +
    "same write; an `\"unreadable\"` result diverts the raise instead of ever reaching a blind overwrite " +
    "(b2-r3 / b2-r3r4). " +
    "ROUND 4 (Code Review 45de2406): tombstoning now lives EXCLUSIVELY in `tombstoneIfNotSurviving`, " +
    "called once at the end of every top-level clear, after its own mutations are already visible — " +
    "never at a bare key-occupancy lookup (round4-y: a clear that successfully protect-copies a FOREIGN " +
    "occupant's content aside must never tombstone it, since the content survives, relocated) and never " +
    "while a touched final is still marked read-failure-kept (round4-y's own later step: the ACCEPTED " +
    "kept-until-reboot residual). `consumeMatchedPendingsIntoArmedEntry`'s own raise-divert branch now " +
    "folds every matched entry's own sourceFile into the diverted entry's orphanLatchFiles before " +
    "diverting, so a SIBLING pending entry consumed alongside the raiser is never silently orphaned on " +
    "disk (round4-x). " +
    "FOLLOW-UP (CR4 of 8db913e2, finding 1, card d6efbc9b): a BY-TOKEN release of the owner's LAST " +
    "outstanding token now tombstones that token unconditionally even when the delegated " +
    "`clearMergeQuarantineByKey` call keeps `final` (read-failure-kept) and so skips its own tombstone — " +
    "the owner's release of a token and the fate of the physical final are two separate facts (d6efbc9b-z3). " +
    "FOLLOW-UP (CR of d6efbc9b, card 7a7e041b): `protectOccupantContentBeforeDelete`'s own copy-aside " +
    "now reads on-disk tokens through the SAME shared, clearedTokens-subtracting reader " +
    "`reconcileMarkedBasenameBeforeWrite` already used, so the two can never drift apart again — a " +
    "degraded occupant whose every on-disk token is already tombstoned is copied aside NOT AT ALL (p3), " +
    "and one whose on-disk tokens are a genuine mix of tombstoned and still-owed carries forward only the " +
    "survivor (mixed). " +
    "FOLLOW-UP (CR ddb58ffa of 8a79dd31, card 6451a749): `protectOccupantContentBeforeDelete` was a THIRD " +
    "writer of the deterministic pending-divert path with no occupant-aware disk read at all — its own " +
    "union source was ONLY the in-memory `pendingUnresolvedQuarantines` lookup, so an on-disk same-identity " +
    "occupant this process never scanned was silently destroyed (never-scanned), and once an identity's " +
    "record lived at a `-collision-` file, its primary-name-only write overwrote the very foreign occupant " +
    "8a79dd31's own reconcile had refused to touch (collision-file). THE FIX: both `mintPendingDivert` and " +
    "`protectOccupantContentBeforeDelete` now route through ONE generalized chokepoint " +
    "(`reconcilePendingDivertTarget`), whose same-identity union carries tokens AND orphanLatchFiles/" +
    "contributorRepoPaths/provenanceUnknown/provenanceTracked forward (via `unionQuarantineEntries` " +
    "itself, never a token-only re-implementation), and which unions a repeated collision into an EXISTING " +
    "same-identity collision file rather than minting an unbounded number of fresh ones (collision-reuse). " +
    "FOLLOW-UP (card d524d1c4): divertRaiseEntry's own merge branch (indices.length > 0) used to build " +
    "`merged` by spreading ONLY `base.entry`, silently dropping the incoming raise's own resolvedKey/" +
    "resolvedKeys (and every OTHER matched entry's) — a real post-reboot fail-open for a dual-armed " +
    "twin's own secondary key, reproduced via an ORDINARY single fault (no triple fault needed). THE FIX: " +
    "the merge branch now unions every informative key (scalar UNION array) across ALL matched entries " +
    "plus the incoming raise, keeping the scalar only when every input that carries one agrees."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
