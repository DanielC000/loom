import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision a50faa55 — never assert "still blocked" in this file via activeMergeQuarantineFor: it lazily
// self-heals/rewrites the occupant's record as a side effect of being merely queried, which is exactly
// the mechanism this file reproduces. Use the pure, non-mutating stillBlockedEntryFor instead.
//
// Full mechanism + fix recorded under this same card id, in docs/decisions.
//
// SCENARIO (selfheal) — a RAISER's own self-healing read (assertRepoNotQuarantined, NOT the degraded occupant X
// itself) strands X's own full clear. Mirrors decision e0192ffb's / da7bf48e's own "rp" fixture (X is pure
// pending, unresolvable, at Kw's own final; teamA — a subdirectory of W that does not exist at boot —
// collapses onto the SAME canonical key Kw once created) up through the persistent double-fault raise
// (X's content kept self-owned at Kw's final, per 8d80b736/da7bf48e). The NEW step this card adds: instead
// of clearing X directly next, call `assertRepoNotQuarantined(w)` on the RAISER — a self-healing reader
// that re-resolves W/teamA's own pending/graduation state. `activeMergeQuarantineFor`'s own graduation
// branches (consumeMatchedPendingsIntoArmedEntry, both the "direct" sibling-absorb branch and the
// "pending-only" branch) arm the result into `activeQuarantines` UNCONDITIONALLY, in memory, regardless
// of whether the write to Kw's own physical final succeeds (decision d4b25feb: "enforcement for THIS
// process must not wait on disk I/O succeeding") — and here it canNOT succeed, because X's own content
// still exclusively, durably occupies that exact file (the degraded-occupant guard correctly refuses the
// overwrite, logging "this key's own physical file is a DIFFERENT, currently-unresolvable entry's own
// exclusive backing").
//
// THE BUG: `physicalOwnerRepoPaths` (consulted by `sweepOwnLatchFileUnlessOwnedElsewhere`, which a FULL
// LIFT of X's own last token calls on X's own sourceFile) credits teamA/W as a "physical owner" of that
// exact file purely because teamA/W is now ARMED at key Kw in `activeQuarantines` (and/or because teamA's
// own FRESH canonical key genuinely IS Kw, the `isFreshWriteTarget` branch) — with NO check that teamA/W's
// own content was ever actually, durably WRITTEN there. The refusal that correctly protected X's content
// during the self-heal is exactly what makes `physicalOwnerRepoPaths` wrongly believe teamA/W legitimately
// backs that file. So X's own full-lift clear (clearing its last token) sees `stillBlockedEntryFor(x) ===
// undefined` (looks fully cleared, in-process) while the PHYSICAL file at Kw's own final is left
// COMPLETELY UNTOUCHED — still holding X's pre-clear content (its last outstanding token). A real reboot's
// PASS 1b then re-arms that stale file, resurrecting X with the token that was supposedly cleared.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-a50faa55-raiser-selfheal-strands-occupant-clear.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-a50faa55-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=a50faa55@loom -c user.name=a50faa55";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-a50faa55-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# a50faa55 (${tag})\n`);
  execSync(`git init -q && git config user.email a50faa55@loom && git config user.name a50faa55`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function hashForKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Fails fs.renameSync ONLY when its SOURCE basename starts with `matchBase` — a genuine, fully-written
// tmp file (unlike fs.openSync injection, which never creates one at all), scoped precisely to ONE
// identity's own mint target so an unrelated write to a DIFFERENT identity/hash in the same call is never
// collaterally failed. PERSISTENT (never restored mid-call) — mirrors da7bf48e's own "rp" scenario.
function injectScopedRenameFailure(matchBase, code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = (src, dest) => {
    const base = path.basename(String(src));
    if (base.startsWith(matchBase)) {
      hits++;
      throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

let moduleImportCounter = 0;
async function freshMergeQuarantineModule() {
  moduleImportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleImportCounter}`);
}
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO (selfheal)
  // Card a50faa55: don't regress this scenario to X sharing W's own natural key (never reaches
  // protectOccupantContentBeforeDelete at all — see da7bf48e's own "Do not"); scope the rename-failure
  // injection to X's own EXACT pending-divert mint basename, never a bare "pending-" prefix (also faults
  // W's own divert and produces a confusing triple fault).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-a50faa55-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const kwHashFile = `${hashForKey(kw)}.json`;
  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, kwHashFile);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["a50faa55-x1", "a50faa55-x2"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["a50faa55-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject = injectScopedRenameFailure(xPendingBase);
  try {
    enterMergeQuarantine(w, "w-branch", "W raises for the first time while X occupies its key via teamA's graduation");
  } finally {
    inject.restore();
  }
  check("(positive control) X's OWN mint rename was selectively failed (a REAL tmp was written then failed to rename)", inject.hits() >= 1);

  const xPureAfterRaise = stillBlockedEntryFor(x);
  check("(precondition) X's own self-owned kept record survives the persistent double fault (pure read)",
    !!xPureAfterRaise && new Set(xPureAfterRaise.tokens ?? []).has("a50faa55-x1") && new Set(xPureAfterRaise.tokens ?? []).has("a50faa55-x2"));
  check("(precondition) X's own kept record still physically lives at Kw's own final",
    fs.existsSync(xAtKwPath) && JSON.parse(fs.readFileSync(xAtKwPath, "utf8")).repoPath === x);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE NEW STEP (a50faa55) — call assertRepoNotQuarantined on the RAISER (W), never on X. This is a
  // self-healing READ: it re-resolves W/teamA's own pending/graduation state via
  // activeMergeQuarantineFor's own consumeMatchedPendingsIntoArmedEntry, which ARMS the result into
  // activeQuarantines at Kw UNCONDITIONALLY (decision d4b25feb) even though the durable write to Kw's own
  // physical final is refused (X's content still exclusively, durably occupies it).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  const assertResult = assertRepoNotQuarantined(w);
  check("(precondition) assertRepoNotQuarantined(w) reports W still quarantined (its own pending token)", assertResult.ok === false);
  check("(precondition) X's own physical file at Kw's final is UNCHANGED by the raiser's own self-heal",
    fs.existsSync(xAtKwPath) && JSON.parse(fs.readFileSync(xAtKwPath, "utf8")).repoPath === x);
  const xPureAfterSelfHeal = stillBlockedEntryFor(x);
  check("(precondition) X's own pure-read record still survives, unaffected, after the raiser's self-heal",
    !!xPureAfterSelfHeal && new Set(xPureAfterSelfHeal.tokens ?? []).has("a50faa55-x1") && new Set(xPureAfterSelfHeal.tokens ?? []).has("a50faa55-x2"));

  // Fully lift X: clear a50faa55-x1 (partial), then a50faa55-x2 (the full lift).
  clearMergeQuarantineByToken(x, "a50faa55-x1");
  const afterPartial = fs.existsSync(xAtKwPath) ? JSON.parse(fs.readFileSync(xAtKwPath, "utf8")) : undefined;
  check("(sanity) the partial clear DID durably narrow Kw's own physical final to just x2",
    !!afterPartial && Array.isArray(afterPartial.tokens) && afterPartial.tokens.length === 1 && afterPartial.tokens[0] === "a50faa55-x2");

  clearMergeQuarantineByToken(x, "a50faa55-x2");
  const xPureAfterFullClear = stillBlockedEntryFor(x);
  check("(in-process) X reads as fully unblocked right after the full clear (pure read)", !xPureAfterFullClear);

  // *** THE BUG *** — the physical file at Kw's own final should now be GONE (or at least no longer
  // carry X's already-cleared token) once X has been fully lifted. The raiser's own earlier self-heal
  // left a BOGUS "physical owner" claim on this exact file (armed-in-memory, never durably written
  // there), so the full lift's own sweep (sweepOwnLatchFileUnlessOwnedElsewhere) wrongly treats it as
  // "owned elsewhere" and leaves it COMPLETELY UNTOUCHED — still holding X's last, supposedly-cleared
  // token.
  const stillOnDisk = fs.existsSync(xAtKwPath) ? JSON.parse(fs.readFileSync(xAtKwPath, "utf8")) : undefined;
  check("*** THE BUG (a50faa55) *** Kw's own physical final is NOT durably cleared of X's last token (expected: gone or token-free; observed: the raiser's own self-heal strands it)",
    !stillOnDisk || !(stillOnDisk.tokens ?? []).includes("a50faa55-x2"));

  // (b) teamA/W's OWN claim must survive X's clear untouched — its own real backing (the pending sources
  // tracked via orphanLatchFiles during the self-heal) was never what this fix excludes; only the BOGUS
  // claim to X's own physical file is excluded. teamA/W must still be blocked, by its own real token, and
  // its own pending source files must still be on disk.
  const teamAPureAfterXClear = stillBlockedEntryFor(teamA);
  check("(b) teamA/W stays blocked in-process after X's full clear (pure read)", !!teamAPureAfterXClear);
  check("(b) teamA/W's own original pending source survives on disk", fs.existsSync(staleTeamAPath));
  check("(b) W's own mustDivert pending source survives on disk", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(w))));

  // A real reboot: PASS 1b re-reads the stranded file and re-arms X with the token that was supposedly
  // cleared — a genuine, durable resurrection.
  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterBoot = rebooted.stillBlockedEntryFor(x);
  check("*** THE BUG (a50faa55, restart) *** X is NOT resurrected after a real reboot (pure read)", !xAfterBoot);
  check("(restart) if X is blocked at all it must be a real outstanding token — never fail-open", !xAfterBoot || (xAfterBoot.tokens ?? []).length > 0);

  // (b, restart) teamA/W must ALSO still be blocked after the SAME reboot — X's own resurrection-fix must
  // never collaterally un-block a genuinely different, still-outstanding identity.
  const teamAAfterBoot = rebooted.stillBlockedEntryFor(teamA);
  check("(b, restart) teamA/W stays blocked after a real reboot too (pure read)", !!teamAAfterBoot);

  if (xAfterBoot) for (const t of xAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(x, t);
  if (teamAAfterBoot) for (const t of teamAAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(teamA, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO (reverse) — same fixture shape as (selfheal), but the clear ORDER is reversed: teamA/W's own
  // tokens are cleared FIRST, while X is STILL fully blocked, then X is cleared last. Confirms the fix
  // doesn't depend on clearing the degraded occupant before the colliding raiser — both identities must
  // end up fully, correctly unblocked (in-process AND after a reboot), with no stray file left behind.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("rev-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-a50faa55-rev-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const kwHashFile = `${hashForKey(kw)}.json`;
  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, kwHashFile);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["a50faa55-rev-x1", "a50faa55-rev-x2"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["a50faa55-rev-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(reverse, precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject = injectScopedRenameFailure(xPendingBase);
  let wToken;
  try {
    wToken = enterMergeQuarantine(w, "w-branch", "W raises for the first time while X occupies its key via teamA's graduation");
  } finally {
    inject.restore();
  }
  check("(reverse, positive control) X's OWN mint rename was selectively failed", inject.hits() >= 1);

  assertRepoNotQuarantined(w); // the SAME self-healing read, arming teamA/W's union at Kw unwritten
  const xPureBeforeAnyClear = stillBlockedEntryFor(x);
  check("(reverse, precondition) X still fully blocked after the self-heal, both tokens outstanding (pure read)",
    !!xPureBeforeAnyClear && new Set(xPureBeforeAnyClear.tokens ?? []).has("a50faa55-rev-x1") && new Set(xPureBeforeAnyClear.tokens ?? []).has("a50faa55-rev-x2"));

  // Clear teamA/W's OWN tokens FIRST — X is still fully blocked throughout.
  clearMergeQuarantineByToken(teamA, "a50faa55-rev-teamA-token");
  clearMergeQuarantineByToken(w, wToken);
  const teamAPureAfterOwnClear = stillBlockedEntryFor(teamA);
  check("(reverse) teamA/W is fully unblocked after clearing its own tokens, in-process (pure read)", !teamAPureAfterOwnClear);

  const xPureAfterTeamAClear = stillBlockedEntryFor(x);
  check("(reverse) X is COMPLETELY UNAFFECTED by teamA/W's own clear — still fully blocked, both tokens (pure read)",
    !!xPureAfterTeamAClear && new Set(xPureAfterTeamAClear.tokens ?? []).has("a50faa55-rev-x1") && new Set(xPureAfterTeamAClear.tokens ?? []).has("a50faa55-rev-x2"));
  // teamA/W's own full lift frees Kw's own key — its own protect pass correctly RELOCATES X's foreign
  // content to a fresh latch first (pre-existing, unrelated machinery; see the "relocated 1 foreign
  // co-occupant" log line), so X's physical backing may no longer be at the ORIGINAL xAtKwPath. Scan
  // every latch for X's own content instead of asserting a fixed path.
  const xContentSomewhere = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n), "utf8")); } catch { return undefined; } })
    .find((c) => c?.repoPath === x);
  check("(reverse) X's own content is durably present SOMEWHERE on disk, unaffected by teamA/W's own clear (relocated or not)",
    !!xContentSomewhere && new Set(xContentSomewhere.tokens ?? []).has("a50faa55-rev-x1") && new Set(xContentSomewhere.tokens ?? []).has("a50faa55-rev-x2"));

  // NOW clear X's own tokens, last.
  clearMergeQuarantineByToken(x, "a50faa55-rev-x1");
  clearMergeQuarantineByToken(x, "a50faa55-rev-x2");
  const xPureAfterOwnClear = stillBlockedEntryFor(x);
  check("(reverse) X is fully unblocked after its own clear, in-process (pure read)", !xPureAfterOwnClear);

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterBoot = rebooted.stillBlockedEntryFor(x);
  const teamAAfterBoot = rebooted.stillBlockedEntryFor(teamA);
  check("(reverse, restart) X is NOT resurrected after a real reboot (pure read)", !xAfterBoot);
  check("(reverse, restart) teamA/W is NOT resurrected after a real reboot either (pure read)", !teamAAfterBoot);

  const strayAfterBoth = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.includes(hashForKey(kw)) || n.includes(".json.tmp-"));
  check("(reverse) no stray file (Kw's hash or any tmp residue) remains once BOTH identities are fully cleared", strayAfterBoth.length === 0);

  if (xAfterBoot) for (const t of xAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(x, t);
  if (teamAAfterBoot) for (const t of teamAAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(teamA, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO (placeholder) — the fix's own exclusion MUST fire even when the content occupying the key
  // is a PLACEHOLDER (boot's own synthetic degraded-occupied marker, `placeholder: true`), not only a
  // genuine occupant. A real near-miss found while verifying the fix: the FIRST draft (content-only, no
  // placeholder exemption) regressed `merge-quarantine-migrate-source-owner-durable.mjs`'s own "sub's own
  // latch file is KEPT regardless" parity scenarios — a SECOND draft added a placeholder exemption to fix
  // that, but Code Review `c00c15d0` found the exemption re-opened this SAME card's own resurrection: Y's
  // own cleared token survived on disk (kept "regardless" purely because teamA/W is armed-but-unwritten
  // there) and was re-armed on reboot. ROUND 2 drops the exemption: no surviving entry's own protection
  // (teamA/W's enforcement comes from `activeQuarantines` itself, d4b25feb) depends on it, and this
  // scenario now asserts the real property — teamA/W stays blocked AND Y is never resurrected — rather
  // than the file's own in-process survival, which is no longer a meaningful proxy either way.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("ph-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const y = path.join(os.tmpdir(), `loom-a50faa55-ph-y-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const kwHashFile = `${hashForKey(kw)}.json`;
  const yAtKwPath = path.join(MERGE_QUARANTINE_DIR, kwHashFile);
  // The ONE difference from scenario (selfheal): Y is a PLACEHOLDER (boot's own synthetic marker shape),
  // never a genuine occupant — mirrors `migrate-source-owner-durable.mjs`'s own corrupt-tmp placeholder.
  fs.writeFileSync(yAtKwPath, JSON.stringify({
    repoPath: y, branch: "(unknown — corrupt boot-time latch)", reason: "Y is a boot-synthetic placeholder, not a real occupant",
    enteredAt: Date.now() - 60_000, tokens: ["a50faa55-ph-y1"], placeholder: true,
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["a50faa55-ph-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, y]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(placeholder, precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const yPendingBase = pendingDivertFilenameForTest(y).replace(/\.json$/, "");
  const inject = injectScopedRenameFailure(yPendingBase);
  try {
    enterMergeQuarantine(w, "w-branch", "W raises while Y (a placeholder) occupies its key via teamA's graduation");
  } finally {
    inject.restore();
  }
  check("(placeholder, positive control) Y's OWN mint rename was selectively failed", inject.hits() >= 1);

  assertRepoNotQuarantined(w); // the SAME self-healing read — arms teamA/W's union at Kw, unwritten
  const teamAPureAfterSelfHeal = stillBlockedEntryFor(teamA);
  check("(placeholder, precondition) teamA/W is armed and blocked after the self-heal (pure read)", !!teamAPureAfterSelfHeal);

  // Fully clear Y's own (placeholder) token — the stale bookkeeping being lifted, mirroring X's own
  // full-lift clear in scenario (selfheal), but for a PLACEHOLDER occupant this time.
  clearMergeQuarantineByToken(y, "a50faa55-ph-y1");
  const yPureAfterClear = stillBlockedEntryFor(y);
  check("(placeholder) Y is fully unblocked after its own clear, in-process (pure read)", !yPureAfterClear);

  // *** THE FIX, ROUND 2 (a50faa55) *** — the placeholder exemption that used to keep Kw's own physical
  // final "regardless" is DROPPED (Code Review c00c15d0): keeping it fired this same card's own
  // resurrection whenever the occupant was a placeholder, stranding Y's own cleared token on disk. The
  // file's in-process survival is no longer asserted either way here — the real question, teamA/W's own
  // reservation AND Y's own clear both surviving a real reboot, is asserted below.
  const teamAPureAfterYClear = stillBlockedEntryFor(teamA);
  check("(placeholder) teamA/W stays blocked in-process after Y's own clear (pure read)", !!teamAPureAfterYClear);

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, y]);
  const teamAAfterBoot = rebooted.stillBlockedEntryFor(teamA);
  check("*** PARITY (placeholder), CONFIRMED *** teamA/W's own reservation survives a real reboot too (pure read)", !!teamAAfterBoot);
  const yAfterBoot = rebooted.stillBlockedEntryFor(y);
  check("*** THE FIX (a50faa55, placeholder), CONFIRMED *** Y is NOT resurrected after a real reboot (pure read) — its already-cleared token must never re-arm",
    !yAfterBoot);

  if (teamAAfterBoot) for (const t of teamAAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(teamA, t);
  if (yAfterBoot) for (const t of yAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(y, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO (placeholder-relocate) — card c02784b5. Same placeholder fixture, but clear every teamA and W
  // token while Y SURVIVES: Y's content is relocated from Kw's final to its own pending-<hash>.json
  // (protectOccupantContentBeforeDelete). The relocated record must keep `placeholder:true` — on disk, in
  // memory (listActiveMergeQuarantines), and identically after a reboot.
  //
  // Four variants (2x2): `inject` = Y's own pending mint is rename-failed at raise time, which makes the
  // relocation run protectOccupantContentBeforeDelete TWICE (the 2nd write unions against the 1st's on-disk
  // copy, so the on-disk READER re-supplies the flag); without it the relocation is a SINGLE write straight
  // from `toPersist`, which is the only shape that pins that site on its own. `legacy` = Y's file carries NO
  // `placeholder` key (branch text only) — only a flag derived via the shared predicate survives it, never a
  // hand-copied `parsed.placeholder === true`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const v of [
    { name: "double-write", inject: true, legacy: false },
    { name: "double-write, legacy branch-text-only", inject: true, legacy: true },
    { name: "single-write", inject: false, legacy: false },
    { name: "single-write, legacy branch-text-only", inject: false, legacy: true },
  ]) {
  const L = `placeholder-relocate: ${v.name}`;
  const w = makeToplevelRepo("phr-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const y = path.join(os.tmpdir(), `loom-a50faa55-phr-y-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, stillBlockedEntryFor, listActiveMergeQuarantines,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`), JSON.stringify({
    repoPath: y, branch: "(unknown — corrupt boot-time latch)", reason: "Y is a boot-synthetic placeholder, not a real occupant",
    enteredAt: Date.now() - 60_000, tokens: ["c02784b5-y1"], ...(v.legacy ? {} : { placeholder: true }),
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`), JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["c02784b5-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, y]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");

  const yPendingName = pendingDivertFilenameForTest(y);
  const inject = v.inject ? injectScopedRenameFailure(yPendingName.replace(/\.json$/, "")) : { restore() {}, hits: () => 0 };
  let wToken;
  try {
    wToken = enterMergeQuarantine(w, "w-branch", "W raises while Y (a placeholder) occupies its key via teamA's graduation");
  } finally {
    inject.restore();
  }
  if (v.inject) check(`(${L}, positive control) Y's OWN mint rename was selectively failed`, inject.hits() >= 1);
  assertRepoNotQuarantined(w);

  // Clear EVERY teamA and W token; Y's own token is never cleared.
  clearMergeQuarantineByToken(teamA, "c02784b5-teamA-token");
  clearMergeQuarantineByToken(w, wToken);
  check(`(${L}, precondition) teamA/W fully unblocked`, !stillBlockedEntryFor(teamA) && !stillBlockedEntryFor(w));
  check(`(${L}, precondition) Y survives, still blocked in-process (pure read)`, !!stillBlockedEntryFor(y));

  const yPendingPath = path.join(MERGE_QUARANTINE_DIR, yPendingName);
  const relocated = fs.existsSync(yPendingPath) ? JSON.parse(fs.readFileSync(yPendingPath, "utf8")) : undefined;
  check(`(${L}, precondition) Y's content was relocated to its own pending file`, !!relocated && relocated.repoPath === y);
  check(`*** THE FIX (c02784b5, ${L}) *** the relocated pending file keeps placeholder:true on disk`, relocated?.placeholder === true);
  const yInProcess = listActiveMergeQuarantines().filter((e) => e.repoPath === y);
  check(`*** THE FIX (c02784b5, ${L}) *** Y's in-process entry keeps placeholder:true (listActiveMergeQuarantines)`,
    yInProcess.length >= 1 && yInProcess.every((e) => e.placeholder === true));

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, y]);
  const yAfterBoot = rebooted.listActiveMergeQuarantines().filter((e) => e.repoPath === y);
  check(`(${L}, restart) Y stays blocked after a real reboot`, !!rebooted.stillBlockedEntryFor(y));
  check(`(${L}, restart) the post-reboot placeholder value matches the in-process value`,
    yAfterBoot.length >= 1 && yAfterBoot.every((e) => e.placeholder === true));

  for (const t of rebooted.stillBlockedEntryFor(y)?.tokens ?? []) rebooted.clearMergeQuarantineByToken(y, t);
  }
} finally {
  // Best-effort — real git repos under os.tmpdir(), never this test's own LOOM_HOME.
}

console.log(failures === 0
  ? "\n✅ ALL PASS"
  : `\n❌ ${failures} FAILURE(S) — card a50faa55's own resurrection reproduced: a RAISER's self-healing ` +
    "read (assertRepoNotQuarantined) arms an unwritten claim on a protected occupant's physical file, " +
    "stranding that occupant's own full clear and resurrecting it on reboot.");
process.exit(failures === 0 ? 0 : 1);
