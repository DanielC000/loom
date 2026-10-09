import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 82032b5c, coupled with the known residual 9a55fb90 (round 2, CR e31c5809) documented but did not
// close: `canonicalSiblingsFor` only ever scans `pendingUnresolvedQuarantines`, so a sibling absorbed
// DIRECTLY into an ACTIVE entry at RUNTIME (`enterMergeQuarantine`'s own `existing` branch, ~line 979) is
// invisible to it — clear-by-id on that entry hard-deletes it with zero ambiguity detection.
//
// TWO PRE-EXISTING, COUPLED DEFECTS, both reproduced on `HEAD` before any fix was written:
//   (A) STRAY WRITE — the `existing` branch's own durable write passed `targetKey=undefined`, so
//       `writeMergeQuarantineLatch` recomputed a FRESH (and, for a degraded occupant, WRONG)
//       `canonicalRepoLockKey(entry.repoPath)` instead of writing to the key(s) actually in `armedKeys`.
//       The union landed at an untracked, unreferenced key; the entry's OWN tracked file stayed STALE.
//   (B) MASKED HARD DELETE — clear-by-id on the union (the SAME `entry.repoPath` as `activeMatch.entry.repoPath`
//       by construction, so `clearMergeQuarantineByKey`'s own `clearingRepoPath` is the SAME tautology
//       9a55fb90 already named) hard-deletes the entry's own tracked file with NO ambiguity detection and
//       NO protection — proven here to RE-EXPOSE once (A) alone is fixed (the union then becomes the
//       entry's own COMPLETE, correctly-targeted durable copy — exactly what gets destroyed).
//
// THE FIX: (a) write to every key in `armedKeys` (never `targetKey=undefined`), keeping
// `skipDegradedOccupantGuard=true` (e1cb7d33: a raise must persist); (b) a new, PERSISTED
// `contributorRepoPaths` field records every genuinely different raiser folded in at runtime, read by a
// single shared predicate (`ambiguousIdentitiesFor`/`ambiguousIdentitiesForLatchId`) every refusal-text
// caller and clear-by-id itself now share — so clear-by-id fails closed instead of guessing.
//
// See docs/decisions/82032b5c-runtime-union-armed-key-and-contributor-provenance.md for the full repro
// (measured directly, not just argued) and the DoD narrowing (clear-by-path still proceeds + protects per
// c9114934; the residual — a protective copy minted from clear-by-path can still carry the ALREADY-cleared
// identity's own token — is accepted and asserted explicitly below, pending 398f476c's own full redesign).
//
// ROUND 2 (Code Review 82b5d95e on commit aa02ee8b) — five more findings in round 1's own fix, each
// reproduced against aa02ee8b first: (1, CRITICAL) the `existing` branch's rebuild never re-pointed X's
// own 883e29bc pending TWIN, so a later re-raise while still unresolvable durably rewrote FROM the stale
// twin, losing Y's token; (2, MAJOR) writing every armed key with the guard unconditionally skipped can
// overwrite a DIFFERENT unresolvable identity's only file when a dual-armed entry's secondary key
// coincides with it; (3, MAJOR) a partial token clear rewrote only ONE armed key, leaving a secondary
// key's file stale and resurrecting the cleared token on reboot; (4, Minor) the refusal text now hedges
// that a named contributor's own token may already be cleared (exact per-contributor pruning needs
// per-token provenance this field deliberately doesn't carry — see the field's own doc); (5, Minor) a
// PENDING entry carrying `contributorRepoPaths` now also fails closed on clear-by-id.
//
// ROUND 3 (Code Review 77e22256 on commit 4aee1942) — one MAJOR (blocking) plus two minors, each
// reproduced against 4aee1942 first: MAJOR — the refusal text named `clear-by-path` for a CONTRIBUTOR
// too, but the real route function (`clearMergeQuarantineByRecordedPath`) verifiably does nothing for
// one; the text now only names `clear-by-path` for an entry's own (or a sibling's own) stored repoPath,
// and names the project-resolved `/clear` route (verified to work) for a contributor instead, with a
// shared `remediationTextFor` helper so no refusal-text site can drift from the others again. MINOR A —
// `clearActiveEntryTokenAtKey`'s own bare per-key `.set()` ran before its "ownership guard", making that
// guard permanently dead code; both now route through `replaceEntryEverywhere` plus a shared
// `entryStillOwnsKey` predicate (used by the raise loop too). MINOR B — the pending-branch refusal now
// gets the same fix-4 hedge via the same shared helper.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file. Run with no args to spawn one child per scenario; a child reads
// `--scenario=<name>` off argv and runs only that one scenario inline, exiting non-zero on any failure.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-runtime-union-provenance.mjs
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
  "runtime-union-targets-armed-key",
  "clear-by-id-refuses-runtime-union",
  "refusal-text-names-both-identities-and-drops-bare-id",
  "clear-by-path-still-proceeds-and-protects",
  "contributor-provenance-persists-across-reboot",
  "protective-copy-carries-contributor-field",
  "ordinary-clear-by-id-unaffected",
  "multi-reboot-stability-after-refused-clear",
  // Round 2 (CR 82b5d95e on commit aa02ee8b) — five more findings, all reproduced against aa02ee8b first.
  "pending-twin-survives-reraise-while-unresolvable",
  "secondary-armed-key-never-overwrites-different-occupant",
  "partial-clear-syncs-every-armed-key",
  "pending-entry-with-contributors-refuses-clear-by-id",
  // Round 3 (CR 77e22256 on commit 4aee1942) — one MAJOR (blocking) plus two minors, all reproduced
  // against 4aee1942 first.
  "redirect-targets-named-in-refusal-text-actually-clear",
  "stale-armed-key-owned-by-different-entry-survives-partial-clear",
  // Round 5 (CR 14877941 on commit 0e81c24c) — MAJOR (blocking): the ambiguous refusal embeds q.reason
  // verbatim, and every real unconfirmedKillReason() raise ends by naming the single-identity /clear
  // route, reopening the text/action mismatch round 4 closed.
  "ambiguous-refusal-never-embeds-unconfirmed-kill-clear-route",
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
    ? "\n✅ ALL SCENARIOS PASS — a runtime union (enterMergeQuarantine's `existing` branch) writes to its "
      + "own armed key(s), carries contributor provenance durably, and clear-by-id fails closed on it."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 82032b5c.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqrup-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, enterMergeQuarantine, clearMergeQuarantine,
  clearMergeQuarantineLatchFile, assertRepoNotQuarantined, clearMergeQuarantineByToken,
  clearMergeQuarantineByRecordedPath, MERGE_QUARANTINE_DIR, unconfirmedKillReason,
  UNCONFIRMED_KILL_WINDOWS_GUIDANCE,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqrup@loom -c user.name=mqrup";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Manufactures the SAME X/Y fixture every scenario below builds on: X is a degraded occupant (unresolvable,
// `resolvedKey: Ky`) armed directly at Ky's own physical file; Y is a REAL, resolvable repo whose own
// canonical key genuinely IS Ky. Boots X alone (no Y file at all — Y has never raised yet), then raises Y
// for real via `enterMergeQuarantine`, which hits the `existing` branch (`activeQuarantines.get(Ky)`
// already holds X) — the exact runtime-union shape this card addresses, never the boot-time union
// `merge-quarantine-pass1-migrate-union.mjs`'s own X/Y fixtures exercise.
function buildRuntimeUnionFixture(tag) {
  const y = path.join(os.tmpdir(), `loom-mqrup-y-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: y });
  commitAll(y, "init", GIT_ID);
  const ky = canonicalRepoLockKey(y);

  const x = path.join(os.tmpdir(), `loom-mqrup-x-${tag}-never-exists-${freshSfx()}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
  fs.writeFileSync(xFile, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
    enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([x]);
  return { x, y, ky, xFile };
}

// Manufactures a DUAL-ARMED entry via the legacy "stale resolvedKey" shape PASS 1's own happy-path dual-arm
// branch recognizes: E is a REAL, resolvable repo whose OWN file lives at hash(K1).json (K1 = E's current
// canonical key — the filename matches, so no migration is needed), but the file's own stored
// `resolvedKey` is a SECOND, DIFFERENT key K2 — so PASS 1 arms E at BOTH K1 and K2 in-memory
// (`armedKeys: [K1, K2]`), with NO physical write to K2 at all (dual-arming is pure in-memory bookkeeping
// — see `armQuarantineKey`'s own doc). K2 is `canonicalRepoLockKey` of `w`, a path that never exists — the
// SAME "degraded, walked-up key" technique `buildRuntimeUnionFixture` already uses for X.
function buildDualArmFixture(tag) {
  const e = path.join(os.tmpdir(), `loom-mqrup-e-${tag}-${freshSfx()}`);
  fs.mkdirSync(e, { recursive: true });
  tmpDirs.push(e);
  fs.writeFileSync(path.join(e, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: e });
  commitAll(e, "init", GIT_ID);
  const k1 = canonicalRepoLockKey(e);

  const w = path.join(os.tmpdir(), `loom-mqrup-w-${tag}-never-exists-${freshSfx()}`);
  const k2 = canonicalRepoLockKey(w);

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const eFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
  fs.writeFileSync(eFile, JSON.stringify({
    repoPath: e, branch: "e-branch", reason: "E dual-armed via a legacy stale resolvedKey=K2",
    enteredAt: Date.now() - 60_000, tokens: ["e-token"], resolvedKey: k2,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([e]); // E alone this boot — K2 has no physical file yet (free)
  return { e, w, k1, k2, eFile, wFile: path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`) };
}

try {
  if (scenarioName === "runtime-union-targets-armed-key") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE FIX (half A) — the runtime union writes ONLY to armedKeys (Ky), never to a freshly-recomputed,
    // stray key. RED on pre-fix HEAD: a second, UNTRACKED file appears (hash of X's own walked-up key,
    // not in armedKeys) and Ky's own tracked file is left STALE (only x-token, missing y's token).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("targets-key");
    const filesBefore = new Set(fs.readdirSync(MERGE_QUARANTINE_DIR));

    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");

    const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR);
    const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
    check("*** THE FIX *** no NEW (stray) file appears anywhere else — the write targeted Ky's OWN already-armed key", newFiles.length === 0);
    const onDisk = JSON.parse(fs.readFileSync(xFile, "utf8"));
    check("*** THE FIX *** Ky's OWN tracked file durably carries x-token", onDisk.tokens.includes("x-token"));
    check("*** THE FIX *** Ky's OWN tracked file durably carries y's freshly-raised token", onDisk.tokens.length === 2);
    check("*** THE FIX *** Ky's OWN tracked file durably records contributorRepoPaths naming Y", Array.isArray(onDisk.contributorRepoPaths) && onDisk.contributorRepoPaths.includes(y));
    const active = activeMergeQuarantineFor(y);
    check("Y reads quarantined via the shared union (unaffected by the fix)", !!active && active.tokens.length === 2);
  } else if (scenarioName === "clear-by-id-refuses-runtime-union") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE FIX (half B) — clear-by-id on a runtime-union entry FAILS CLOSED instead of hard-deleting.
    // RED on pre-fix HEAD: clear-by-id succeeds (`ok:true`), Ky's file is deleted outright, with zero
    // ambiguity detection (canonicalSiblingsFor alone never sees a sibling absorbed this way).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("refuse");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");

    const result = clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** THE FIX *** clear-by-id on the runtime-union entry is REFUSED", result.ok === false);
    check("*** THE FIX *** the refusal names BOTH identities", result.ok === false && result.reason.includes(x) && result.reason.includes(y));
    check("*** THE FIX *** the refusal redirects to clear-by-path", result.ok === false && result.reason.includes("clear-by-path"));
    check("*** THE FIX *** Ky's file is UNTOUCHED — nothing was destroyed", fs.existsSync(xFile));
    check("X still reads quarantined (nothing changed)", !!activeMergeQuarantineFor(x));
    check("Y still reads quarantined (nothing changed)", !!activeMergeQuarantineFor(y));
  } else if (scenarioName === "refusal-text-names-both-identities-and-drops-bare-id") {
    // Mirrors 9a55fb90's own refusal-text assertion, for the NEW ambiguity shape: assertRepoNotQuarantined
    // must drop the bare-id shortcut and name only clear-by-path, via the SAME shared predicate clear-by-id
    // itself uses (ambiguousIdentitiesFor/ambiguousIdentitiesForLatchId) — one predicate, not two.
    const { x, y } = buildRuntimeUnionFixture("text");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");

    const textResult = assertRepoNotQuarantined(x);
    check("(precondition) x is refused", textResult.ok === false);
    check("*** THE FIX *** refusal text flags the id as ambiguous (names y)", textResult.ok === false && textResult.reason.includes("ambiguous") && textResult.reason.includes(y));
    check("*** THE FIX *** refusal text offers ONLY clear-by-path, never a bare {id} shortcut", textResult.ok === false && textResult.reason.includes("clear-by-path") && !/\{"id":/.test(textResult.reason));
  } else if (scenarioName === "clear-by-path-still-proceeds-and-protects") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // DoD narrowing (Lead-approved): clear-by-path is UNCHANGED by this card — it already discriminates
    // correctly (9a55fb90) and already protects the degraded occupant's content (c9114934), unconditionally.
    // ACCEPTED, DOCUMENTED RESIDUAL (asserted explicitly, not hidden): the protective copy this mints can
    // still carry the ALREADY-cleared identity's own token too, since this card's provenance field is not
    // itself enough to split a union's tokens back apart at clear time (that is 398f476c's own, larger
    // identity-model-redesign scope) — measured directly below, never merely argued.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("path");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");

    clearMergeQuarantine(y); // clear-by-path(y) — never ambiguous; discriminates by the SUPPLIED identity
    check("Ky's physical file IS deleted — clear-by-path still proceeds, unaffected by this card", !fs.existsSync(xFile));
    const protectiveFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("a protective copy for X was minted (c9114934's existing mechanism, unaffected)", protectiveFiles.length === 1);
    const protective = protectiveFiles[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, protectiveFiles[0]), "utf8")) : {};
    check("the protective copy carries X's own token", (protective.tokens ?? []).includes("x-token"));
    // ACCEPTED RESIDUAL — asserted, not hidden: Y's own (already-cleared) token still rides along.
    check("ACCEPTED RESIDUAL (pending 398f476c): the protective copy ALSO still carries Y's already-cleared token", (protective.tokens ?? []).length === 2);
    check("the protective copy carries contributorRepoPaths naming Y (provenance survives the protect-copy too)", Array.isArray(protective.contributorRepoPaths) && protective.contributorRepoPaths.includes(y));

    const reboot1 = await rebootSim();
    const found = reboot1.reenterMergeQuarantinesAtBoot([y, x]);
    check("Y is NOT reported as its own boot-return entry after reboot", !found.some((e) => e.repoPath === y));
    check("*** Y's OWN clear genuinely STICKS *** — Y's query is NOT blocked again after reboot (the protective copy carries no resolvedKey, per c9114934, so it never re-occupies Ky)", !reboot1.activeMergeQuarantineFor(y));
    check("X is still enforced after reboot (its own raise was never cleared)", !!reboot1.activeMergeQuarantineFor(x));
  } else if (scenarioName === "contributor-provenance-persists-across-reboot") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Lead's item (b).1 — contributorRepoPaths must be PERSISTED and read back at boot, or clear-by-id's
    // refusal silently stops working the moment the process restarts. RED without the boot-loader fix:
    // the field is dropped on parse-back, canonicalSiblings-style checks find nothing, and the SAME
    // clear-by-id that was correctly refused pre-reboot would wrongly succeed post-reboot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("reboot-persist");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
    check("(precondition) contributorRepoPaths is on-disk before any reboot", JSON.parse(fs.readFileSync(xFile, "utf8")).contributorRepoPaths?.includes(y));

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([y, x]);
    const afterReboot = reboot1.activeMergeQuarantineFor(x);
    check("*** THE FIX *** contributorRepoPaths survives the reboot, read straight off the latch file", afterReboot?.contributorRepoPaths?.includes(y));
    const clearResult = reboot1.clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** THE FIX *** clear-by-id STILL refuses after a reboot", clearResult.ok === false);
    check("Ky's file is still untouched after the reboot + refused clear", fs.existsSync(xFile));
  } else if (scenarioName === "protective-copy-carries-contributor-field") {
    // Lead's item (b).3 — a dedicated test that would catch a DROPPED field specifically at
    // protectDegradedOccupantBeforeDelete's own manual JSON whitelist (merge-quarantine.ts, the
    // hand-reconstructed `toPersist` object) — the one copy site a plain object-spread can never cover,
    // since it rebuilds the entry field-by-field from raw parsed JSON.
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("protective-field");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
    const onDiskBeforeClear = JSON.parse(fs.readFileSync(xFile, "utf8"));
    check("(precondition) the entry being protected carries contributorRepoPaths before the clear", Array.isArray(onDiskBeforeClear.contributorRepoPaths) && onDiskBeforeClear.contributorRepoPaths.includes(y));

    clearMergeQuarantine(y); // clear-by-path(y) — triggers protectDegradedOccupantBeforeDelete for X

    const protectiveFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("(precondition) exactly one protective copy was minted", protectiveFiles.length === 1);
    const protective = protectiveFiles[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, protectiveFiles[0]), "utf8")) : {};
    check("*** THE FIX *** protectDegradedOccupantBeforeDelete's own whitelist carries contributorRepoPaths forward onto the protective copy", Array.isArray(protective.contributorRepoPaths) && protective.contributorRepoPaths.includes(y));
  } else if (scenarioName === "ordinary-clear-by-id-unaffected") {
    // Negative control for the whole card: an ORDINARY, non-colliding, single-identity clear-by-id must
    // stay byte-identical — no refusal, no spurious ambiguity, confirming the widened predicate doesn't
    // over-fire on a plain repo with no runtime union at all.
    const solo = path.join(os.tmpdir(), `loom-mqrup-solo-${freshSfx()}`);
    fs.mkdirSync(solo, { recursive: true });
    tmpDirs.push(solo);
    fs.writeFileSync(path.join(solo, "README.md"), "# solo\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: solo });
    commitAll(solo, "init", GIT_ID);
    const token = enterMergeQuarantine(solo, "solo-branch", "solo's own genuine unconfirmed-kill reason");
    check("(precondition) solo token minted", typeof token === "string" && token.length > 0);
    const key = canonicalRepoLockKey(solo);
    const result = clearMergeQuarantineLatchFile(hashForKey(key));
    check("an ordinary, non-colliding clear-by-id still succeeds, unaffected by this card", result.ok === true);
    check("solo is no longer quarantined", !activeMergeQuarantineFor(solo));
  } else if (scenarioName === "multi-reboot-stability-after-refused-clear") {
    // A refused clear-by-id must never itself mint, mutate, or duplicate ANY file — stable file count
    // across multiple reboots, mirroring the existing in-memory-twin scenario's own stability check.
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("stability");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
    const filesBeforeRefusal = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length;
    const refused = clearMergeQuarantineLatchFile(hashForKey(ky));
    check("(precondition) the clear-by-id attempt was refused", refused.ok === false);
    check("a refused clear mints no new file", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length === filesBeforeRefusal);

    for (let i = 0; i < 2; i++) {
      const reboot = await rebootSim();
      const found = reboot.reenterMergeQuarantinesAtBoot([y, x]);
      const filesThisBoot = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length;
      check(`file count STABLE after reboot #${i + 1} (no duplicate/stray file minted)`, filesThisBoot === filesBeforeRefusal);
      check(`exactly ONE entry reported for X after reboot #${i + 1} (no double-report)`, found.filter((e) => e.repoPath === x).length === 1);
      check(`that entry still carries both tokens after reboot #${i + 1}`, found.find((e) => e.repoPath === x)?.tokens.length === 2);
    }
  } else if (scenarioName === "pending-twin-survives-reraise-while-unresolvable") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 1 (CRITICAL) — the `existing` branch's rebuild used a bare per-key `.set()`, never
    // `replaceEntryEverywhere`, so X's own 883e29bc PENDING TWIN (same object, by reference — established
    // at boot by `buildRuntimeUnionFixture`'s own degraded-divert) stayed pointed at the PRE-union object.
    // X then re-raising while STILL unresolvable hits `mergeTokenIntoPendingEntries`, which rebuilds FROM
    // that stale twin and durably REWRITES Ky's own file — losing Y's token and `contributorRepoPaths`
    // outright. RED on commit aa02ee8b.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("pending-twin");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
    const beforeReraise = JSON.parse(fs.readFileSync(xFile, "utf8"));
    check("(precondition) Ky's file carries both tokens + contributorRepoPaths before X re-raises", beforeReraise.tokens.length === 2 && !!beforeReraise.contributorRepoPaths?.includes(y));

    enterMergeQuarantine(x, "x-branch-2", "x's second raise while STILL unresolvable"); // hits the pending twin, if stale

    const afterReraise = JSON.parse(fs.readFileSync(xFile, "utf8"));
    check("*** THE FIX *** Ky's file STILL carries y's own token after X re-raises", afterReraise.tokens.includes(beforeReraise.tokens[1]));
    check("*** THE FIX *** Ky's file durably carries all 3 tokens (x-token, y's, x's 2nd)", afterReraise.tokens.length === 3);
    check("*** THE FIX *** Ky's file STILL carries contributorRepoPaths naming y", !!afterReraise.contributorRepoPaths?.includes(y));
    const clearResult = clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** THE FIX *** clear-by-id still refuses (contributorRepoPaths survived the re-raise)", clearResult.ok === false);
  } else if (scenarioName === "secondary-armed-key-never-overwrites-different-occupant") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 2 (MAJOR) — writing EVERY armed key with `skipDegradedOccupantGuard=true` can
    // overwrite a DIFFERENT, unresolvable identity's only durable copy: a dual-armed E's SECONDARY key
    // (`armedKeys[1]`, in-memory bookkeeping from a legacy stale-resolvedKey shape) is not proof that its
    // CURRENT physical file still belongs to E — here it genuinely belongs to W, an unrelated identity.
    // RED on commit aa02ee8b: skip=true unconditionally for every armed key overwrites W's file outright.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { e, w, k2, eFile, wFile } = buildDualArmFixture("collision");
    check("(precondition) K2 has no physical file yet (free)", !fs.existsSync(wFile));
    // W's own content now genuinely occupies K2's physical slot — unknown to this process's in-memory
    // state (W was never registered/processed this boot), exactly as a real coincidental key collision
    // would look from inside a live process.
    fs.writeFileSync(wFile, JSON.stringify({
      repoPath: w, branch: "w-branch", reason: "W's own genuine, unrelated quarantine",
      enteredAt: Date.now() - 30_000, tokens: ["w-token"], resolvedKey: k2,
    }, null, 2) + "\n");
    const wBefore = fs.readFileSync(wFile, "utf8");

    enterMergeQuarantine(e, "e-branch-2", "e's second raise"); // writes to BOTH k1 (primary) and k2 (secondary)

    check("*** THE FIX *** W's file is BYTE-IDENTICAL to before — the secondary-key write never touched it", fs.readFileSync(wFile, "utf8") === wBefore);
    const wContent = JSON.parse(fs.readFileSync(wFile, "utf8"));
    check("*** THE FIX *** W's file still names W as its own repoPath (not overwritten with E's identity)", wContent.repoPath === w);
    check("*** THE FIX *** W's own token survives on disk", wContent.tokens.includes("w-token"));
    check("E's own primary key still durably recorded E's second raise", JSON.parse(fs.readFileSync(eFile, "utf8")).tokens.length === 2);

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([e, w]);
    const wQueryAfterReboot = reboot1.activeMergeQuarantineFor(w);
    check("*** THE FIX *** W's own token is STILL enforced after reboot (findable via its own path query — never truly lost, whether reported under its own identity or a boot-time union with e)", !!wQueryAfterReboot && wQueryAfterReboot.tokens.includes("w-token"));
  } else if (scenarioName === "partial-clear-syncs-every-armed-key") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 3 (MAJOR) — `clearActiveEntryTokenAtKey`'s partial-clear branch durably rewrote ONLY
    // the ONE `key` it was called with, even though a raise now durably writes EVERY armed key — leaving
    // a SECONDARY armed key's file STALE (still carrying the just-cleared token), which resurrects it on
    // the next reboot via boot's own dual-arm/migrate consolidation. RED on commit aa02ee8b.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { e, k2, eFile, wFile: k2File } = buildDualArmFixture("partial-clear"); // K2 free — no collision needed for this one
    const t1 = enterMergeQuarantine(e, "e-branch-2", "e's second raise, token t1"); // writes union to BOTH k1 and k2
    check("(precondition) k1 AND k2 both durably carry t1 right after the raise", JSON.parse(fs.readFileSync(eFile, "utf8")).tokens.includes(t1) && JSON.parse(fs.readFileSync(k2File, "utf8")).tokens.includes(t1));

    clearMergeQuarantineByToken(e, t1); // partial clear — e-token remains outstanding

    check("*** THE FIX *** k1's file no longer carries t1", !JSON.parse(fs.readFileSync(eFile, "utf8")).tokens.includes(t1));
    check("*** THE FIX *** k2's file ALSO no longer carries t1 (the secondary key stayed in sync)", !JSON.parse(fs.readFileSync(k2File, "utf8")).tokens.includes(t1));

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([e]);
    const afterReboot = reboot1.activeMergeQuarantineFor(e);
    check("*** THE FIX *** t1 does NOT resurrect after reboot", !afterReboot.tokens.includes(t1));
    check("e-token still enforced after reboot", afterReboot.tokens.includes("e-token"));
  } else if (scenarioName === "pending-entry-with-contributors-refuses-clear-by-id") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 5 (Minor) — a PENDING entry can ALSO carry `contributorRepoPaths` (e.g. carried
    // forward by `protectDegradedOccupantBeforeDelete`'s own protective copy) — the pending branch of
    // clear-by-id never consulted this at all, so a bare id on such an entry would have hard-deleted it
    // with zero ambiguity detection, even though the refusal TEXT (for the entry it was copied FROM)
    // already knew better. RED on commit aa02ee8b.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { x, y, ky, xFile } = buildRuntimeUnionFixture("pending-contrib");
    enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
    clearMergeQuarantine(y); // clear-by-path(y) -> protectDegradedOccupantBeforeDelete mints a pending-divert for X

    const pendingFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("(precondition) exactly one protective pending-divert was minted", pendingFiles.length === 1);
    const pendingContent = pendingFiles[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, pendingFiles[0]), "utf8")) : {};
    check("(precondition) the pending entry carries contributorRepoPaths naming y", !!pendingContent.contributorRepoPaths?.includes(y));
    const pendingId = pendingFiles[0] ? createHash("sha256").update(pendingFiles[0]).digest("hex").slice(0, 24) : "";

    const result = clearMergeQuarantineLatchFile(pendingId);
    check("*** THE FIX *** clear-by-id on the PENDING entry fails closed (never hard-deletes)", result.ok === false);
    check("*** THE FIX *** the pending file is untouched", pendingFiles[0] ? fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingFiles[0])) : false);
  } else if (scenarioName === "redirect-targets-named-in-refusal-text-actually-clear") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 4 (Code Review `9e826040` on commit `c61be07f`) — round 3's own fix STILL named a route that
    // doesn't work in every branch: `/clear(contributor's projectId)` is a NO-OP for a PENDING entry
    // (`clearMergeQuarantineReporting` filters only by `directPathIdentity(entry.repoPath)`, so it never
    // even finds a pending entry's own contributor — measured directly, RED), and for an ACTIVE entry
    // with a RESOLVABLE X it lifts the WHOLE union including X's OWN still-outstanding unconfirmed-kill
    // token, with no warning attached to that sentence. Every round that named a branch-specific route
    // produced a NEW mismatch in some OTHER branch. LEAD'S RULING: name EXACTLY ONE route —
    // `clear-by-path` with the entry's own repoPath (or a listed sibling) — across EVERY branch, with an
    // explicit "lifts the whole entry, confirm no process running" caveat, and ONE flat line for
    // contributors ("clear-by-path with a contributor's own path does nothing"). This scenario drives
    // `clearMergeQuarantineByRecordedPath` (the REAL function behind that ONE route) for an ACTIVE and a
    // PENDING refusal, each with a RESOLVABLE X and a DEGRADED X — the full matrix the CR measured — and
    // asserts the text names NO `/clear` route anywhere. RED on commit c61be07f.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const assertRefusalNamesOnlyClearByPath = (refusal, x, tag) => {
      check(`(${tag}) clear-by-id refuses`, refusal.ok === false);
      if (refusal.ok !== false) return;
      check(`*** THE FIX (${tag}) *** the refusal does NOT name the /clear route anywhere`, !refusal.reason.includes("/internal/merge-quarantine/clear ") && !refusal.reason.includes("projectId"));
      const clearByPathMatch = refusal.reason.match(/clear-by-path with one of (\[.*?\])/);
      check(`(${tag}) the refusal's clear-by-path target list is parseable`, !!clearByPathMatch);
      const clearByPathTargets = clearByPathMatch ? JSON.parse(clearByPathMatch[1]) : [];
      check(`*** THE FIX (${tag}) *** clear-by-path targets include X (the entry's own repoPath)`, clearByPathTargets.includes(x));
      check(`*** THE FIX (${tag}) *** the text says clearing lifts the WHOLE entry (every contributor's token + X's own unconfirmed-kill quarantine)`, refusal.reason.includes("lifts the WHOLE entry") && refusal.reason.includes("outstanding unconfirmed-kill quarantine"));
      check(`*** THE FIX (${tag}) *** the text says to confirm no process is running under any listed path first`, refusal.reason.includes("confirm no process is still running"));
    };

    {
      // CASE 1 — ACTIVE refusal, RESOLVABLE X (X = a real repo's toplevel; Y = a subdir of it, no own
      // `.git` — same canonical key by `7673d096`'s own rule, so Y's raise hits the `existing` branch
      // and becomes a contributor while X stays resolvable throughout).
      const x = path.join(os.tmpdir(), `loom-mqrup-x-active-resolvable-${freshSfx()}`);
      const ySub = path.join(x, "subdir");
      fs.mkdirSync(ySub, { recursive: true });
      tmpDirs.push(x);
      fs.writeFileSync(path.join(x, "README.md"), "# x-active-resolvable\n");
      execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: x });
      commitAll(x, "init", GIT_ID);
      enterMergeQuarantine(x, "x-branch", "x's own genuine unconfirmed-kill reason"); // brand new
      enterMergeQuarantine(ySub, "y-branch", "y's own genuine unconfirmed-kill reason"); // existing branch -> contributor
      check("(precondition) x is resolvable", fs.existsSync(x));
      check("(precondition) ySub became a contributor", !!activeMergeQuarantineFor(x)?.contributorRepoPaths?.includes(ySub));
      // Round 5 TEST GAP (c) — non-vacuity: x must genuinely be BLOCKED before the clear below, or the
      // "reads clear afterward" checks prove nothing (it could have always read clear).
      check("(precondition, non-vacuity) x is BLOCKED before any clear", assertRepoNotQuarantined(x).ok === false);
      check("(precondition, non-vacuity) ySub is ALSO blocked before any clear", assertRepoNotQuarantined(ySub).ok === false);

      const refusal1 = clearMergeQuarantineLatchFile(hashForKey(canonicalRepoLockKey(x)));
      assertRefusalNamesOnlyClearByPath(refusal1, x, "active+resolvable (clear-by-id)");
      // Round 5 TEST GAP (a) — assertRepoNotQuarantined's OWN ambiguous refusal is a THIRD, separate
      // remediationTextFor call site (never only the clear-by-id refusal above) — drive the route IT
      // names too, in at least this active tier.
      const refusal1b = assertRepoNotQuarantined(x);
      assertRefusalNamesOnlyClearByPath(refusal1b, x, "active+resolvable (assertRepoNotQuarantined)");

      // Round 5 TEST GAP (b) — restore round 3's own "contributor path does nothing" assertion, dropped
      // entirely by round 4 along with the whole project-route-testing block it lived in, rather than
      // narrowed.
      const contributorClearAttempt1 = clearMergeQuarantineByRecordedPath(ySub);
      check("*** clear-by-path with a CONTRIBUTOR's own path does nothing (active+resolvable) ***", contributorClearAttempt1.wasQuarantined === false);
      check("(non-vacuity) x is STILL blocked after the no-op contributor clear attempt", assertRepoNotQuarantined(x).ok === false);

      const clearResult1 = clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (active+resolvable) *** clearMergeQuarantineByRecordedPath(x) actually lifts the block", clearResult1.wasQuarantined === true);
      check("*** THE FIX (active+resolvable) *** assertRepoNotQuarantined(x) reads clear afterward", assertRepoNotQuarantined(x).ok === true);
      check("*** THE FIX (active+resolvable) *** assertRepoNotQuarantined(ySub) ALSO reads clear afterward", assertRepoNotQuarantined(ySub).ok === true);
    }
    {
      // CASE 2 — ACTIVE refusal, DEGRADED X (the existing runtime-union fixture shape).
      const { x, y, ky, xFile } = buildRuntimeUnionFixture("active-degraded");
      enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
      check("(precondition, non-vacuity) x is BLOCKED before any clear", assertRepoNotQuarantined(x).ok === false);

      const refusal2 = clearMergeQuarantineLatchFile(hashForKey(ky));
      assertRefusalNamesOnlyClearByPath(refusal2, x, "active+degraded (clear-by-id)");
      // Round 5 TEST GAP (a) — same third call site, for the DEGRADED active tier too.
      const refusal2b = assertRepoNotQuarantined(x);
      assertRefusalNamesOnlyClearByPath(refusal2b, x, "active+degraded (assertRepoNotQuarantined)");
      const clearResult2 = clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (active+degraded) *** clearMergeQuarantineByRecordedPath(x) actually lifts the block", clearResult2.wasQuarantined === true);
      check("*** THE FIX (active+degraded) *** Ky's file is gone", !fs.existsSync(xFile));
      check("*** THE FIX (active+degraded) *** assertRepoNotQuarantined(x) reads clear afterward", assertRepoNotQuarantined(x).ok === true);
      check("*** THE FIX (active+degraded) *** assertRepoNotQuarantined(y) ALSO reads clear afterward", assertRepoNotQuarantined(y).ok === true);
    }
    {
      // CASE 3 — PENDING refusal, DEGRADED X (clear-by-path(y) triggers protectDegradedOccupantBeforeDelete,
      // diverting X's own content to a pending-divert carrying contributorRepoPaths — X is unresolvable
      // throughout, the only shape this protect mechanism can ever produce).
      const { x, y, ky, xFile } = buildRuntimeUnionFixture("pending-degraded");
      enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
      clearMergeQuarantine(y); // clear-by-path(y) -> protect -> pending divert for x
      const pendingFiles3 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      check("(precondition, pending+degraded) exactly one protective pending-divert was minted", pendingFiles3.length === 1);
      const pendingId3 = pendingFiles3[0] ? createHash("sha256").update(pendingFiles3[0]).digest("hex").slice(0, 24) : "";
      check("(precondition, non-vacuity) x is BLOCKED before any clear", assertRepoNotQuarantined(x).ok === false);

      const refusal3 = clearMergeQuarantineLatchFile(pendingId3);
      assertRefusalNamesOnlyClearByPath(refusal3, x, "pending+degraded");
      const clearResult3 = clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (pending+degraded) *** clearMergeQuarantineByRecordedPath(x) actually lifts the block", clearResult3.wasQuarantined === true);
      check("*** THE FIX (pending+degraded) *** assertRepoNotQuarantined(x) reads clear afterward", assertRepoNotQuarantined(x).ok === true);
    }
    {
      // CASE 4 — PENDING refusal, RESOLVABLE X: X is a REAL repo, temporarily REMOVED while the protect
      // mechanism fires (it only ever fires for an unresolvable occupant — see `remediationTextFor`'s
      // own doc), then RESTORED before the refusal/clear is driven — the one way a pending entry's own
      // contributor-carrying identity can genuinely be resolvable again.
      const x = path.join(os.tmpdir(), `loom-mqrup-x-pending-resolvable-${freshSfx()}`);
      fs.mkdirSync(x, { recursive: true });
      tmpDirs.push(x);
      fs.writeFileSync(path.join(x, "README.md"), "# x-pending-resolvable\n");
      execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: x });
      commitAll(x, "init", GIT_ID);
      const y = path.join(os.tmpdir(), `loom-mqrup-y-pending-resolvable-${freshSfx()}`);
      fs.mkdirSync(y, { recursive: true });
      tmpDirs.push(y);
      fs.writeFileSync(path.join(y, "README.md"), "# y-pending-resolvable\n");
      execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: y });
      commitAll(y, "init", GIT_ID);
      const ky4 = canonicalRepoLockKey(y);
      const parked4 = path.join(os.tmpdir(), `loom-mqrup-x-pending-resolvable-parked-${freshSfx()}`);
      fs.renameSync(x, parked4); // x unresolvable, matching the degraded-occupant shape protect needs
      const xFile4 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky4)}.json`);
      fs.writeFileSync(xFile4, JSON.stringify({
        repoPath: x, branch: "x-branch", reason: "x's manufactured resolvedKey collision with y",
        enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky4,
      }, null, 2) + "\n");
      reenterMergeQuarantinesAtBoot([x]);
      enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason");
      clearMergeQuarantine(y); // clear-by-path(y) -> protect (x still unresolvable here) -> pending divert
      fs.renameSync(parked4, x); // RESTORE x — resolvable again before the refusal/clear is driven
      check("(precondition, pending+resolvable) x is resolvable again", fs.existsSync(x));

      const pendingFiles4 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      // Non-vacuity, via the on-disk pending-divert itself rather than a live assertRepoNotQuarantined(x)
      // call: x is resolvable again here, so querying it would trigger activeMergeQuarantineFor's own
      // lazy-graduation side effect, promoting this pending entry to active and invalidating pendingId4
      // (computed from the PENDING file's own hash scheme) before the id-based clear below ever runs —
      // measured directly: adding that query here turns `clear-by-id refuses` false (nothing left to
      // match the pending-shaped id). The file's own presence is the non-mutating proof of a live block.
      check("(precondition, non-vacuity, pending+resolvable) exactly one protective pending-divert was minted", pendingFiles4.length === 1);
      const pendingId4 = pendingFiles4[0] ? createHash("sha256").update(pendingFiles4[0]).digest("hex").slice(0, 24) : "";

      const refusal4 = clearMergeQuarantineLatchFile(pendingId4);
      assertRefusalNamesOnlyClearByPath(refusal4, x, "pending+resolvable");
      const clearResult4 = clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (pending+resolvable) *** clearMergeQuarantineByRecordedPath(x) actually lifts the block", clearResult4.wasQuarantined === true);
      check("*** THE FIX (pending+resolvable) *** assertRepoNotQuarantined(x) reads clear afterward", assertRepoNotQuarantined(x).ok === true);
    }
  } else if (scenarioName === "stale-armed-key-owned-by-different-entry-survives-partial-clear") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3, MINOR A — `clearActiveEntryTokenAtKey`'s own bare per-key `activeQuarantines.set(k,
    // updated)` ran BEFORE the write loop's own "ownership guard", making that guard permanently dead
    // code (always true — the bare set had already made it so). Reproduced via TWO SEPARATE boot calls
    // in ONE process: E dual-arms [K1,K2] cleanly (boot #1, K2 free on disk); E's own file is then
    // removed and a GENUINELY SEPARATE, unresolvable W's own file is placed at K2's hash; a SECOND boot
    // call (registering only W — E's own file is gone, so boot never re-reads it) arms W alone at K2 in
    // a fresh, local `byRepoKey` that knows nothing of E's own K1 slot — a bare overwrite of K2's SHARED
    // `activeQuarantines` entry. E's own `armedKeys` STILL (stale) names K2. RED on commit 4aee1942: a
    // partial clear of E's own token set clobbers W's in-memory slot at K2 with E's own `updated` object.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const e = path.join(os.tmpdir(), `loom-mqrup-e-stale-${freshSfx()}`);
    fs.mkdirSync(e, { recursive: true });
    tmpDirs.push(e);
    fs.writeFileSync(path.join(e, "README.md"), "# e\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: e });
    commitAll(e, "init", GIT_ID);
    const k1 = canonicalRepoLockKey(e);

    const w = path.join(os.tmpdir(), `loom-mqrup-w-stale-never-exists-${freshSfx()}`);
    const k2 = canonicalRepoLockKey(w);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const eFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
    fs.writeFileSync(eFile, JSON.stringify({
      repoPath: e, branch: "e-branch", reason: "E dual-armed via a legacy stale resolvedKey=K2",
      enteredAt: Date.now() - 60_000, tokens: ["e-token"], resolvedKey: k2,
    }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([e]); // boot #1 — E dual-arms [k1,k2] cleanly, K2 free on disk
    check("(precondition) E dual-armed at k1 and k2 after boot #1", activeMergeQuarantineFor(e)?.armedKeys?.length === 2);

    // E's own file is superseded/gone — only THIS process's in-memory state still carries the stale
    // dual-arm claim on k2.
    fs.rmSync(eFile, { force: true });
    const wFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
    fs.writeFileSync(wFile, JSON.stringify({
      repoPath: w, branch: "w-branch", reason: "W's own genuine, unrelated quarantine",
      enteredAt: Date.now() - 30_000, tokens: ["w-token"], resolvedKey: k2,
    }, null, 2) + "\n");
    // boot #2 — SAME process, SAME activeQuarantines map; only w's file is found (e's own was removed) —
    // arms W alone at k2 via a FRESH local byRepoKey, bare-overwriting whatever boot #1 left at k2.
    reenterMergeQuarantinesAtBoot([w]);

    check("(precondition) E's OWN armedKeys STILL (stale) names k2", activeMergeQuarantineFor(e)?.armedKeys?.includes(k2));
    check("(precondition) k2 is now genuinely, separately W", activeMergeQuarantineFor(w)?.repoPath === w);

    const t2 = enterMergeQuarantine(e, "e-branch-2", "e's second raise, after the stale-key divergence");
    check("(precondition) W is unaffected by E's own second raise", activeMergeQuarantineFor(w)?.repoPath === w && !!activeMergeQuarantineFor(w)?.tokens.includes("w-token"));

    clearMergeQuarantineByToken(e, t2); // partial clear — e-token remains outstanding

    const wAfterClear = activeMergeQuarantineFor(w);
    check("*** THE FIX *** W's in-memory slot survives E's partial clear, unaffected", wAfterClear?.repoPath === w && !!wAfterClear?.tokens.includes("w-token"));
    const wFileAfterClear = JSON.parse(fs.readFileSync(wFile, "utf8"));
    check("*** THE FIX *** W's own file on disk is untouched", wFileAfterClear.repoPath === w && wFileAfterClear.tokens.includes("w-token"));
    const eAfterClear = activeMergeQuarantineFor(e);
    check("E's own token set correctly reduced by the partial clear", !!eAfterClear?.tokens.includes("e-token") && !eAfterClear?.tokens.includes(t2));
  } else if (scenarioName === "ambiguous-refusal-never-embeds-unconfirmed-kill-clear-route") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 5 MAJOR (blocking, CR 14877941 on commit 0e81c24c) — every REAL unconfirmedKillReason() raise
    // ends with UNCONFIRMED_KILL_WINDOWS_GUIDANCE, which ends by naming the single-identity /clear route.
    // assertRepoNotQuarantined's ambiguous branch embeds q.reason VERBATIM, so in production the
    // ambiguous refusal STILL named /clear right next to remediationTextFor's own single-route text —
    // reopening the exact text/action mismatch round 4 closed. RED on commit 0e81c24c (q.reason embedded
    // raw, no stripping).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const bareClearRoute = /merge-quarantine\/clear(?!-)/;

    // CASE A — a FRESH runtime raise, built via the REAL unconfirmedKillReason() helper (never a
    // hand-typed stand-in), on a resolvable X with a subdir contributor Y.
    {
      const x = path.join(os.tmpdir(), `loom-mqrup-x-route-clause-${freshSfx()}`);
      const ySub = path.join(x, "subdir");
      fs.mkdirSync(ySub, { recursive: true });
      tmpDirs.push(x);
      fs.writeFileSync(path.join(x, "README.md"), "# x-route-clause\n");
      execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: x });
      commitAll(x, "init", GIT_ID);
      enterMergeQuarantine(x, "x-branch", unconfirmedKillReason("x's own real kill failure"));
      enterMergeQuarantine(ySub, "y-branch", unconfirmedKillReason("y's own real kill failure"));
      check("(precondition, case A) ySub became a contributor", !!activeMergeQuarantineFor(x)?.contributorRepoPaths?.includes(ySub));
      check("(precondition, non-vacuity, case A) x is BLOCKED before any clear", assertRepoNotQuarantined(x).ok === false);
      check("(precondition, non-vacuity, case A) ySub is ALSO blocked before any clear", assertRepoNotQuarantined(ySub).ok === false);

      const refusalA = assertRepoNotQuarantined(x);
      check("(case A) assertRepoNotQuarantined(x) is refused", refusalA.ok === false);
      check("*** THE FIX (case A) *** the ambiguous refusal never names the bare /clear route", refusalA.ok === false && !bareClearRoute.test(refusalA.reason));
      check("(case A) the embedded reason's OWN diagnostic text survives (only the route clause was stripped)", refusalA.ok === false && refusalA.reason.includes("husky/lefthook/pre-commit"));
      const clearByPathMatchA = refusalA.ok === false ? refusalA.reason.match(/clear-by-path with one of (\[.*?\])/) : null;
      check("(case A) the refusal's clear-by-path target list is parseable", !!clearByPathMatchA);
      const clearByPathTargetsA = clearByPathMatchA ? JSON.parse(clearByPathMatchA[1]) : [];
      check("(case A) clear-by-path targets include x", clearByPathTargetsA.includes(x));

      // Round 3's own "contributor path does nothing" assertion, restored (round 4 dropped it entirely,
      // along with the whole project-route-testing block it lived in, rather than narrowing it).
      const contributorClearAttempt = clearMergeQuarantineByRecordedPath(ySub);
      check("*** clear-by-path with a CONTRIBUTOR's own path does nothing ***", contributorClearAttempt.wasQuarantined === false);
      check("(non-vacuity, case A) x is STILL blocked after the no-op contributor clear attempt", assertRepoNotQuarantined(x).ok === false);

      // Drives the route assertRepoNotQuarantined's OWN ambiguous refusal names (the third
      // remediationTextFor call site) — never only the route the clearMergeQuarantineLatchFile-driven
      // scenario above already exercises.
      const clearResultA = clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (case A) *** clear-by-path with the entry's own path actually lifts the block", clearResultA.wasQuarantined === true);
      check("(case A) assertRepoNotQuarantined(x) reads clear afterward", assertRepoNotQuarantined(x).ok === true);
      check("(case A) assertRepoNotQuarantined(ySub) ALSO reads clear afterward", assertRepoNotQuarantined(ySub).ok === true);
    }

    // CASE B — a LEGACY-SHAPED latch already on disk whose STORED reason already carries the real route
    // clause (as if written by a genuine unconfirmedKillReason() raise before this round's fix existed),
    // loaded via a real BOOT — never a fresh in-process raise — to prove the strip isn't somehow tied to
    // raise-time state.
    {
      const { x, y, ky, xFile } = buildRuntimeUnionFixture("route-clause-legacy");
      const legacyEntry = JSON.parse(fs.readFileSync(xFile, "utf8"));
      legacyEntry.reason = `x's manufactured kill failure — ${UNCONFIRMED_KILL_WINDOWS_GUIDANCE}`;
      fs.writeFileSync(xFile, JSON.stringify(legacyEntry, null, 2) + "\n");

      const reboot1 = await rebootSim();
      reboot1.reenterMergeQuarantinesAtBoot([x, y]);
      reboot1.enterMergeQuarantine(y, "y-branch", "y's own genuine unconfirmed-kill reason"); // hits `existing` -> contributor
      check("(precondition, case B) y became a contributor via the boot-loaded legacy entry", !!reboot1.activeMergeQuarantineFor(x)?.contributorRepoPaths?.includes(y));
      check("(precondition, non-vacuity, case B) x is BLOCKED before any clear", reboot1.assertRepoNotQuarantined(x).ok === false);

      const refusalB = reboot1.assertRepoNotQuarantined(x);
      check("(case B) assertRepoNotQuarantined(x) is refused", refusalB.ok === false);
      check("*** THE FIX (case B) *** a boot-loaded LEGACY reason's bare /clear route is ALSO stripped", refusalB.ok === false && !bareClearRoute.test(refusalB.reason));
      check("(case B) the legacy reason's OWN diagnostic text survives", refusalB.ok === false && refusalB.reason.includes("husky/lefthook/pre-commit"));

      const clearByPathMatchB = refusalB.ok === false ? refusalB.reason.match(/clear-by-path with one of (\[.*?\])/) : null;
      const clearByPathTargetsB = clearByPathMatchB ? JSON.parse(clearByPathMatchB[1]) : [];
      check("(case B) clear-by-path targets include x", clearByPathTargetsB.includes(x));
      const clearResultB = reboot1.clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (case B) *** clear-by-path with the entry's own path actually lifts the block", clearResultB.wasQuarantined === true);
      check("(case B) assertRepoNotQuarantined(x) reads clear afterward", reboot1.assertRepoNotQuarantined(x).ok === true);
      check("(case B) assertRepoNotQuarantined(y) ALSO reads clear afterward", reboot1.assertRepoNotQuarantined(y).ok === true);
    }
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? `\n✅ ${scenarioName}: ALL CHECKS PASS` : `\n❌ ${scenarioName}: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
