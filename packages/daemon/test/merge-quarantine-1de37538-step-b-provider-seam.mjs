import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 1de37538 — Step B now shares PASS 1's own registered-identity predicates via a late-bound,
// LIVE-called provider (setRegisteredRepoPathsProvider) instead of having no access at all. See the
// decision record for the gap this closes and why a provider seam, not threading the list everywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1de375-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq1de375@loom -c user.name=mq1de375";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq1de375-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-1de37538 (${tag})\n`);
  execSync(`git init -q && git config user.email mq1de375@loom && git config user.name mq1de375`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 1dd00dca's/028837ad's/5d0820c7's own test files: fold `orphanBasename` into
// `repoPath`'s own on-disk final JSON BEFORE `orphanBasename` itself exists.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule, extra = {}) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

// Directly edit a raised repo's OWN latch file to ALSO carry a `resolvedKey` naming a THIRD party's
// key — simulating "this entry already holds a secondary, non-fresh claim at another repo's key" (e.g.
// from a prior repo-move) the same way `foldOrphanRefIntoOwnFinal` simulates a pre-existing orphan
// reference. Never a hand-set DERIVED field on an in-memory object — the write goes through a REAL
// reboot afterward, which is what actually constructs the dual-arm from these bytes.
function setResolvedKeyOnOwnFinal(repoPath, resolvedKey, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.resolvedKey = resolvedKey;
  fs.writeFileSync(finalPath, JSON.stringify(record));
}

/**
 * Runs the card's own named shape — U dual-armed [keyU, keyV] (V a registered, resolvable repo, never
 * itself raised — purely a filesystem fact), A the clearer, T an UNRESOLVABLE ghost whose own
 * resolvedKey is keyV — entirely via REAL boots and REAL raises/clears (never a hand-set derived field).
 * `providerFn` (or `undefined` to leave the provider genuinely unset on every module instance involved)
 * is applied via `setRegisteredRepoPathsProvider` right after each fresh module import, mirroring how
 * index.ts wires it once at real boot. Returns the in-process `provenanceUnknown` value Step B produces
 * at keyV once T's union lands, plus the three repos' own paths (so a caller can independently reboot
 * against the SAME on-disk bytes afterward).
 */
async function runMainTestInProcess(providerFn) {
  const V = makeRepo("v");
  const keyV = canonicalRepoLockKey(V);
  const U = makeRepo("u");
  const A = makeRepo("a");
  const applyProvider = (m) => { if (providerFn) m.setRegisteredRepoPathsProvider(providerFn); };

  const mod = await freshBootModule();
  applyProvider(mod);
  const tU = mod.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (1de37538 main shape)");
  setResolvedKeyOnOwnFinal(U, keyV, mod);

  const booted = await freshBootModule();
  applyProvider(booted);
  booted.reenterMergeQuarantinesAtBoot([U, V]);
  const uDualArm = booted.stillBlockedEntryFor(V);
  check("U's secondary arm at keyV landed at boot — V's own key occupied before T ever appears", uDualArm !== undefined && uDualArm.repoPath === U);

  const tA = booted.enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1de37538 clearer)");
  const orphanBasename = foldOrphanRefIntoOwnFinal(A, booted);

  // CRITICAL (5d0820c7's own test file "Do not" list): a clearer's in-memory entry needs a REAL
  // read-from-disk cycle to pick up an orphanLatchFiles edit written directly to disk, or Step B
  // silently never fires. Reboot again before writing T's content and clearing.
  const booted2 = await freshBootModule();
  applyProvider(booted2);
  booted2.reenterMergeQuarantinesAtBoot([U, V, A]);

  const T = path.join(os.tmpdir(), `loom-mq1de375-t-never-exists-UNRELATED-${freshSfx()}`);
  const tF = randomUUID();
  writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1de37538, unresolvable ghost colliding with U's secondary claim)", [tF], booted2, { resolvedKey: keyV });

  booted2.clearMergeQuarantineByToken(A, tA);

  const vEntry = booted2.stillBlockedEntryFor(V);
  check("occupant at keyV carries BOTH U's own token and T's foreign token in-process (the union actually happened, not a no-op)", !!vEntry && vEntry.tokens.includes(tU) && vEntry.tokens.includes(tF));
  return { inProcessProvenanceUnknown: !!vEntry?.provenanceUnknown, U, V, A };
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (a) PROVIDER-UNSET — nobody calls setRegisteredRepoPathsProvider: Step B must behave byte-
  // identically to before this card (in-process stays false) even though a REAL reboot against the
  // identical on-disk bytes (explicit registeredRepoPaths, independent of the provider) DOES set it —
  // this is the gap the card found, still present whenever the provider is never wired.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { inProcessProvenanceUnknown, U, V, A } = await runMainTestInProcess(undefined);
    check("(UNSET) in-process provenanceUnknown stays FALSE — today's pre-1de37538 behavior is pinned when the provider is never wired", inProcessProvenanceUnknown === false);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U, V, A]);
    const rebootEntry = fresh.stillBlockedEntryFor(V);
    check("(UNSET) a REAL reboot against the SAME on-disk bytes, with registeredRepoPaths passed explicitly (independent of any provider), still sets provenanceUnknown TRUE — confirms the in-process/reboot gap this card names is still reachable whenever the provider isn't wired", !!rebootEntry?.provenanceUnknown === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (b) PROVIDER-SET, V included — Step B now shares PASS 1's own predicate via the live provider: in-
  // process must equal what a real reboot (passed the identical roster explicitly) produces. Both legs
  // are independently, freshly computed — never one asserted equal to a hand-set expectation alone.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  {
    const V = makeRepo("v2");
    const keyV = canonicalRepoLockKey(V);
    const U = makeRepo("u2");
    const A = makeRepo("a2");
    const providerFn = () => [U, V, A];

    const mod = await freshBootModule();
    mod.setRegisteredRepoPathsProvider(providerFn);
    const tU = mod.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (1de37538 set-included)");
    setResolvedKeyOnOwnFinal(U, keyV, mod);

    const booted = await freshBootModule();
    booted.setRegisteredRepoPathsProvider(providerFn);
    booted.reenterMergeQuarantinesAtBoot([U, V]);
    check("(SET-INCLUDED) U's secondary arm at keyV landed at boot", booted.stillBlockedEntryFor(V)?.repoPath === U);

    const tA = booted.enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1de37538 set-included clearer)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, booted);

    const booted2 = await freshBootModule();
    booted2.setRegisteredRepoPathsProvider(providerFn);
    booted2.reenterMergeQuarantinesAtBoot([U, V, A]);

    const T = path.join(os.tmpdir(), `loom-mq1de375-t2-never-exists-UNRELATED-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1de37538 set-included)", [tF], booted2, { resolvedKey: keyV });
    booted2.clearMergeQuarantineByToken(A, tA);

    const inProcessEntry = booted2.stillBlockedEntryFor(V);
    check("(SET-INCLUDED) occupant at keyV carries both tokens in-process", !!inProcessEntry && inProcessEntry.tokens.includes(tU) && inProcessEntry.tokens.includes(tF));
    const inProcessValue = !!inProcessEntry?.provenanceUnknown;

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U, V, A]);
    const rebootEntry = fresh.stillBlockedEntryFor(V);
    const rebootValue = !!rebootEntry?.provenanceUnknown;

    console.log(`(SET-INCLUDED) in-process=${inProcessValue} reboot=${rebootValue}`);
    check("(SET-INCLUDED) in-process provenanceUnknown is TRUE", inProcessValue === true);
    check("(SET-INCLUDED) *** THE FIX *** in-process === reboot (both TRUE) — Step B now matches PASS 1 for this shape", inProcessValue === rebootValue && rebootValue === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (c) NEGATIVE CONTROL — provider SET but V deliberately excluded from its returned list: both legs
  // must read FALSE, isolating V's registeredRepoPaths membership as the deciding variable (not some
  // other side effect of wiring a provider at all).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  {
    const V = makeRepo("v3");
    const keyV = canonicalRepoLockKey(V);
    const U = makeRepo("u3");
    const A = makeRepo("a3");
    const providerFn = () => [U, A]; // V deliberately omitted

    const mod = await freshBootModule();
    mod.setRegisteredRepoPathsProvider(providerFn);
    const tU = mod.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (1de37538 negative control)");
    setResolvedKeyOnOwnFinal(U, keyV, mod);

    const booted = await freshBootModule();
    booted.setRegisteredRepoPathsProvider(providerFn);
    booted.reenterMergeQuarantinesAtBoot([U, V]);
    check("(NEGATIVE CONTROL) U's secondary arm at keyV landed at boot", booted.stillBlockedEntryFor(V)?.repoPath === U);

    const tA = booted.enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1de37538 negative control clearer)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, booted);

    const booted2 = await freshBootModule();
    booted2.setRegisteredRepoPathsProvider(providerFn);
    booted2.reenterMergeQuarantinesAtBoot([U, V, A]);

    const T = path.join(os.tmpdir(), `loom-mq1de375-t3-never-exists-UNRELATED-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1de37538 negative control)", [tF], booted2, { resolvedKey: keyV });
    booted2.clearMergeQuarantineByToken(A, tA);

    const inProcessEntry = booted2.stillBlockedEntryFor(V);
    check("(NEGATIVE CONTROL) occupant at keyV carries both tokens in-process", !!inProcessEntry && inProcessEntry.tokens.includes(tU) && inProcessEntry.tokens.includes(tF));
    const inProcessValue = !!inProcessEntry?.provenanceUnknown;

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U, A]); // V deliberately omitted here too
    const rebootEntry = fresh.stillBlockedEntryFor(V);
    const rebootValue = !!rebootEntry?.provenanceUnknown;

    console.log(`(NEGATIVE CONTROL) in-process=${inProcessValue} reboot=${rebootValue}`);
    check("(NEGATIVE CONTROL) in-process provenanceUnknown is FALSE when V is excluded from the provider's own list", inProcessValue === false);
    check("(NEGATIVE CONTROL) reboot provenanceUnknown is ALSO FALSE when V is excluded — both legs agree, isolating registeredRepoPaths membership as the deciding variable", rebootValue === false);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // PROVIDER-THROWS — if the set provider throws, Step B must fail TOWARD today's behavior (treat it
  // as "no registered repos known this call") and never crash or propagate the throw.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  {
    const V = makeRepo("v4");
    const keyV = canonicalRepoLockKey(V);
    const U = makeRepo("u4");
    const A = makeRepo("a4");
    const throwingProvider = () => { throw new Error("1de37538 test: provider deliberately throws"); };

    const mod = await freshBootModule();
    mod.setRegisteredRepoPathsProvider(throwingProvider);
    const tU = mod.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (1de37538 provider-throws)");
    setResolvedKeyOnOwnFinal(U, keyV, mod);

    const booted = await freshBootModule();
    booted.setRegisteredRepoPathsProvider(throwingProvider);
    booted.reenterMergeQuarantinesAtBoot([U, V]);

    const tA = booted.enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1de37538 provider-throws clearer)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, booted);

    const booted2 = await freshBootModule();
    booted2.setRegisteredRepoPathsProvider(throwingProvider);
    booted2.reenterMergeQuarantinesAtBoot([U, V, A]);

    const T = path.join(os.tmpdir(), `loom-mq1de375-t4-never-exists-UNRELATED-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1de37538 provider-throws)", [tF], booted2, { resolvedKey: keyV });

    let threw = false;
    let inProcessEntry;
    try {
      booted2.clearMergeQuarantineByToken(A, tA);
      inProcessEntry = booted2.stillBlockedEntryFor(V);
    } catch {
      threw = true;
    }
    check("(PROVIDER-THROWS) the throwing provider never propagates out of the clear — Step B fails toward today's behavior instead of crashing", threw === false);
    check("(PROVIDER-THROWS) the union itself still lands (both tokens present) despite the throwing provider", !!inProcessEntry && inProcessEntry.tokens.includes(tU) && inProcessEntry.tokens.includes(tF));
    check("(PROVIDER-THROWS) provenanceUnknown stays FALSE — a throw is treated as 'no registered repos known', never as a stricter refusal", !!inProcessEntry?.provenanceUnknown === false);
  }
} finally {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
}
process.exit(failures === 0 ? 0 : 1);
