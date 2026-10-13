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
import { createHash } from "node:crypto";
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
  // FIX: fold every matched entry's own `sourceFile` into `armed.orphanLatchFiles` before diverting,
  // excluding only the divert's own likely target. The sibling's own `sourceFile` here (`sibFile` below)
  // is a FIXED, arbitrary literal — never derived from either identity's own hash — so this is also the
  // dedicated "distinct sourceFile" case (never relying on the same-identity-coincidence the fix must not).
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
  check("(round4-x) t2 enforced in-process", new Set(allEntriesX.flatMap((q) => q.tokens ?? [])).has(t2x));
  check("(round4-x) d reported quarantined", !!activeMergeQuarantineFor(d));
  check("*** THE FIX (round4-x) *** the sibling's own sourceFile is NEVER an untracked orphan — gone, or named in SOME entry's own orphanLatchFiles",
    !filesAfterRaise.includes(sibFile) || referencedOrphansX.has(sibFile));

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
  // matching `clearPendingEntryByToken`'s own last-token branch.
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
    "the owner's release of a token and the fate of the physical final are two separate facts (d6efbc9b-z3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
