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
import { isDeepStrictEqual } from "node:util";
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
  "secondary-armed-key-never-overwrites-different-occupant-e-first",
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
  // Card 96e6aa58 (round 4 item 5 of THIS card's own decision record, carded separately) —
  // `consumeMatchedPendingsIntoArmedEntry`'s own bare per-key `.set()` (the SAME bug class MINOR A fixed
  // for `clearActiveEntryTokenAtKey`), reached via the sibling-absorb raise path instead of a partial
  // clear. See docs/decisions/96e6aa58-consume-matched-pendings-ownership-gate.md.
  "stale-armed-key-survives-sibling-absorb-raise",
  // Card 96e6aa58, round 2 (CR b166c6e6) — the round-1 fix gated a non-anchor key ONLY against `extra`,
  // so the NO-`extra` graduation path (a bare pending twin, no cross-tier absorb) left its own stale
  // secondary key pointed at the spliced-out twin object instead of the union.
  "no-extra-graduation-repoints-twin-slot",
  // Code Review of 7282d183 (card 4b06875f), Finding 1 — the physical-hash discriminator asks the wrong
  // question (see the scenario's own comment below for the full repro).
  "4b06875f-dual-arm-clear-resurrection",
  // Code Review Round 2 (card 4b06875f), Finding 2 — the post-union filter: a correctly-excluded
  // resolvedKey can still be reintroduced by a union against an older on-disk pending record.
  "4b06875f-post-union-filter-clear-sticks",
  // Round-2 Code Review a61d0bec (card 4b06875f) CRITICAL — Round 2's own EXPLICIT resolvedKey union
  // rule, applied GLOBALLY (via armQuarantineKey), drops a legacy dual-arm's own secondary key the
  // instant a boot-time MIGRATE union collides with it — a REPRODUCED fail-open a plain `{...older}`
  // rule never had. See the scenario's own comment below for the full repro.
  "4b06875f-migrate-union-drops-dual-arm",
  // Card 48bda567 — the OPPOSITE age order of the scenario above (the migrating latch OLDER than Y's
  // own dual-arm), left deliberately unfixed/unasserted by 4b06875f's own Round 3. PRE-EXISTING fail-open
  // under the plain `{...older}` legacy rule itself (predates 4b06875f entirely) — see the scenario's own
  // comment below for the full repro.
  "48bda567-migrate-union-drops-dual-arm-b-older",
  // Card 48bda567's own required NO-FIRE discrimination: both sides carry DIFFERENT, genuinely
  // informative resolvedKeys at the union's own `key` — the correction must not engage at all, and the
  // result must be byte-for-byte the plain legacy union. A REGRESSION PIN (not discrimination evidence —
  // see the scenario's own comment) against `armQuarantineKey` itself (via its test-only pass-through),
  // rather than a real boot fixture, because card 1e739f4a's own masking tmp-promotion self-stamp makes
  // this reachable shape unobservable through a real boot today.
  "48bda567-no-fire-both-sides-informative-and-different",
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
  UNCONFIRMED_KILL_WINDOWS_GUIDANCE, listActiveMergeQuarantines, armQuarantineKeyTestOnly,
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

function pendingDivertFilenameFor(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
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
// `orderHint` ("w-first" | "e-first" | undefined) forces WHICH of eFile/wFile's own hash-named filename
// sorts first in `fs.readdirSync` — since boot-time PASS 1 processes files in readdir order, and
// armKeyUnlessDegradedCollision's own behavior differs by which side is already in `byRepoKey` when the
// other arrives (card d163aef5), both orders must be independently, deterministically testable rather
// than left to filename-hash luck. Regenerating `w` (never touches disk — it never exists) is free;
// regenerating `e` would mean a fresh `git init`, so only `w` is retried. The retry count needed is NOT
// ~50/50 per attempt — comparing hex-digest STRINGS lexicographically means the hit rate depends on
// `k1Hash`'s own numeric position (close to 0% or 100% if it happens to sit near either extreme), so the
// cap is generous rather than assuming a coin flip.
function buildDualArmFixture(tag, orderHint) {
  const e = path.join(os.tmpdir(), `loom-mqrup-e-${tag}-${freshSfx()}`);
  fs.mkdirSync(e, { recursive: true });
  tmpDirs.push(e);
  fs.writeFileSync(path.join(e, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: e });
  commitAll(e, "init", GIT_ID);
  const k1 = canonicalRepoLockKey(e);
  const k1Hash = hashForKey(k1);

  let w, k2, k2Hash;
  for (let attempt = 0; ; attempt++) {
    w = path.join(os.tmpdir(), `loom-mqrup-w-${tag}-never-exists-${freshSfx()}`);
    k2 = canonicalRepoLockKey(w);
    k2Hash = hashForKey(k2);
    if (!orderHint) break;
    const wSortsFirst = k2Hash < k1Hash;
    if ((orderHint === "w-first") === wSortsFirst) break;
    if (attempt > 200_000) throw new Error(`buildDualArmFixture: could not force order=${orderHint} after 200,000 attempts`);
  }

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
  } else if (scenarioName === "secondary-armed-key-never-overwrites-different-occupant" || scenarioName === "secondary-armed-key-never-overwrites-different-occupant-e-first") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 2 (MAJOR) — writing EVERY armed key with `skipDegradedOccupantGuard=true` can
    // overwrite a DIFFERENT, unresolvable identity's only durable copy: a dual-armed E's SECONDARY key
    // (`armedKeys[1]`, in-memory bookkeeping from a legacy stale-resolvedKey shape) is not proof that its
    // CURRENT physical file still belongs to E — here it genuinely belongs to W, an unrelated identity.
    // RED on commit aa02ee8b: skip=true unconditionally for every armed key overwrites W's file outright.
    //
    // CARD d163aef5 (round 4 here) — the runtime-write half above was already correctly protected; the
    // REBOOT half below used to accept TWO outcomes ("W's own token is STILL enforced after reboot —
    // findable via its own path query — never truly lost, whether reported under its own identity OR a
    // boot-time union with e"). The "union with e" half of that OR was ITSELF an instance of this card's
    // own bug: reverting to pre-d163aef5 main and querying `activeMergeQuarantineFor(e)` directly (E's
    // OWN, genuinely verified, primary key) returns `['e-token','w-token']` — W's degraded token leaking
    // into E's own identity, 15/15 runs — never checked by this scenario before, since it only ever
    // queried W, which happened to hit the SAME contaminated union and so looked "findable" either way.
    // There is now exactly ONE correct outcome, true regardless of boot processing order (both orders are
    // driven explicitly here, via `buildDualArmFixture`'s own `orderHint`): E's own query carries ONLY
    // e-token, and W survives as its OWN independent, standalone entry — never merged, never lost.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const orderHint = scenarioName.endsWith("-e-first") ? "e-first" : "w-first";
    const { e, w, k2, eFile, wFile } = buildDualArmFixture("collision", orderHint);
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

    const eQueryAfterReboot = reboot1.activeMergeQuarantineFor(e);
    // E genuinely carries TWO of its OWN tokens (e-token from the fixture's initial raise, plus the
    // random token enterMergeQuarantine minted for "e's second raise" above) — `length === 2` mirrors
    // the precondition check two lines above this block, not a new expectation. The actual assertion is
    // that NEITHER is w-token: E's own identity must never absorb W's.
    check(`*** THE FIX (card d163aef5, order=${orderHint}) *** E's own query carries ONLY its own two tokens — never contaminated by W's degraded token`, !!eQueryAfterReboot && eQueryAfterReboot.tokens.length === 2 && eQueryAfterReboot.tokens.includes("e-token") && !eQueryAfterReboot.tokens.includes("w-token"));

    const wQueryAfterReboot = reboot1.activeMergeQuarantineFor(w);
    check(`*** THE FIX (card d163aef5, order=${orderHint}) *** W's own query returns its OWN standalone entry, with ONLY its own token — never merged with E's`, !!wQueryAfterReboot && wQueryAfterReboot.tokens.length === 1 && wQueryAfterReboot.tokens.includes("w-token"));
    check(`(order=${orderHint}) W's own standalone entry still names ITS OWN repoPath`, wQueryAfterReboot?.repoPath === w);

    // Code Review, SHOULD-FIX 3 — also assert through the PRODUCTION path (assertRepoNotQuarantined),
    // not only the internal activeMergeQuarantineFor.
    const assertEAfterReboot = reboot1.assertRepoNotQuarantined(e);
    check(`(production path, order=${orderHint}) assertRepoNotQuarantined(e) never names W's reason`, assertEAfterReboot.ok === false && !assertEAfterReboot.reason.includes("W's own genuine"));
    check(`(production path, order=${orderHint}) assertRepoNotQuarantined(w) is ALSO blocked`, reboot1.assertRepoNotQuarantined(w).ok === false);

    // A SECOND reboot — W must stay quarantined DURABLY, not just as an in-process artifact of the first.
    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([e, w]);
    const wAfterReboot2 = reboot2.activeMergeQuarantineFor(w);
    check(`(order=${orderHint}, 2nd reboot) W is STILL quarantined, with ONLY its own token`, !!wAfterReboot2 && wAfterReboot2.tokens.length === 1 && wAfterReboot2.tokens.includes("w-token"));
    const eAfterReboot2 = reboot2.activeMergeQuarantineFor(e);
    check(`(order=${orderHint}, 2nd reboot) E is STILL clean, with its own two tokens and none of W's`, !!eAfterReboot2 && eAfterReboot2.tokens.length === 2 && eAfterReboot2.tokens.includes("e-token") && !eAfterReboot2.tokens.includes("w-token"));
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
  } else if (scenarioName === "stale-armed-key-survives-sibling-absorb-raise") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 96e6aa58 — `consumeMatchedPendingsIntoArmedEntry`'s own bare `for (const k of armedKeys)
    // activeQuarantines.set(k, armed)` (THREE sites) bypassed ownership entirely — reached via the
    // sibling-absorb raise path (`enterMergeQuarantine`'s `existing` branch, when a genuine cross-tier
    // sibling is pending at the SAME key). SUB-CASE (a): a dual-armed E's stale secondary key (K2) has
    // since been reclaimed by a genuinely DIFFERENT, unresolvable entry W — the bare loop clobbers W's
    // in-memory slot. Reproduced via a DOUBLE-BOOT construction (same technique as round 3 MINOR A's own
    // `stale-armed-key-owned-by-different-entry-survives-partial-clear`) — this is the only way to reach
    // the stale-key state TODAY; it proves the guard, not that this exact state is reachable within a
    // single production process's lifetime (production never reboots twice in-process).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    {
      const { e, w, k1, k2, eFile, wFile } = buildDualArmFixture("sibling-absorb");
      check("(precondition) E dual-armed at k1 and k2 after boot #1", activeMergeQuarantineFor(e)?.armedKeys?.length === 2);

      // E's own file is superseded/gone — only THIS process's in-memory state still carries the stale
      // dual-arm claim on k2 (mirrors the round-3 MINOR A construction exactly).
      fs.rmSync(eFile, { force: true });
      fs.writeFileSync(wFile, JSON.stringify({
        repoPath: w, branch: "w-branch", reason: "W's own genuine, unrelated quarantine",
        enteredAt: Date.now() - 30_000, tokens: ["w-token"], resolvedKey: k2,
      }, null, 2) + "\n");
      reenterMergeQuarantinesAtBoot([w]); // boot #2 — SAME process; arms W alone at k2, bare-overwriting whatever boot #1 left there
      check("(precondition) E's OWN armedKeys STILL (stale) names k2", activeMergeQuarantineFor(e)?.armedKeys?.includes(k2));
      check("(precondition) k2 is now genuinely, separately W", activeMergeQuarantineFor(w)?.repoPath === w);

      // NOW a genuine cross-tier SIBLING of E (a plain subdir, no own `.git` — collapses onto E's own
      // canonical key k1 once resolvable) goes pending via a THIRD boot call, parked away at that instant
      // (same technique as merge-quarantine-cross-tier-sibling-absorb.mjs's own scenario 4).
      const sibling = path.join(e, `sib-${freshSfx()}`);
      fs.mkdirSync(sibling, { recursive: true });
      const oldHashForPath = (p) => hashForKey(process.platform === "win32" ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashForPath(sibling)}.json`), JSON.stringify({
        repoPath: sibling, branch: "sib-branch", reason: "sibling's own pending raise, same canonical key as E",
        enteredAt: Date.now(), tokens: ["sib-token"],
      }, null, 2) + "\n");
      const parkedSibling = path.join(os.tmpdir(), `loom-mqrup-parked-sib-${freshSfx()}`);
      fs.renameSync(sibling, parkedSibling);
      reenterMergeQuarantinesAtBoot([sibling]); // boot #3 — sibling unresolvable right now, diverts to pending
      fs.renameSync(parkedSibling, sibling);
      check("(precondition) sibling shares E's own canonical key once resolvable", canonicalRepoLockKey(sibling) === k1);

      const wBytesBeforeRaise = fs.readFileSync(wFile, "utf8");
      const t2 = enterMergeQuarantine(e, "e-branch-2", "e's second raise, triggering the sibling absorb"); // THE RAISE — hits `existing`, absorbs the sibling via consumeMatchedPendingsIntoArmedEntry(extra=entry, armedKeys=[k1,k2])

      const activeE = activeMergeQuarantineFor(e);
      check("(sanity) the sibling absorb itself still functions — E's union carries all 3 tokens", !!activeE && ["e-token", t2, "sib-token"].every((t) => activeE.tokens.includes(t)));

      const wAfterRaise = activeMergeQuarantineFor(w);
      check("*** THE FIX *** W's in-memory slot survives the sibling-absorb raise, unaffected", wAfterRaise?.repoPath === w);
      check("*** THE FIX *** W's own token survives in memory", !!wAfterRaise?.tokens.includes("w-token"));
      const wTextAfterRaise = assertRepoNotQuarantined(w);
      check("*** THE FIX *** W's own query text still names W, not E/the sibling", wTextAfterRaise.ok === false && wTextAfterRaise.reason.includes(w) && !wTextAfterRaise.reason.includes(e));
      check("*** THE FIX *** W's own file on disk is byte-identical — never touched (this function only ever durably writes `key`)", fs.readFileSync(wFile, "utf8") === wBytesBeforeRaise);

      const reboot1 = await rebootSim();
      reboot1.reenterMergeQuarantinesAtBoot([e, w, sibling]);
      const wAfterReboot = reboot1.activeMergeQuarantineFor(w);
      check("*** restart survival *** W's own quarantine is STILL resolvable, correctly, after a reboot", wAfterReboot?.repoPath === w && !!wAfterReboot?.tokens.includes("w-token"));
      const eAfterReboot = reboot1.activeMergeQuarantineFor(e);
      check("*** restart survival *** E's own union (with the sibling absorbed) is ALSO still correctly resolvable after a reboot", !!eAfterReboot && ["e-token", t2, "sib-token"].every((t) => eAfterReboot.tokens.includes(t)));
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SUB-CASE (b) — the round-3 re-CR's "different object, same identity" occupant shape: a secondary
    // armed key's CURRENT occupant shares `extra`'s own `directPathIdentity` but is NOT the same object
    // reference (so a bare `replaceEntryEverywhere(extra, armed)` scan alone would miss it — this is
    // exactly why the fix also gates on `entryStillOwnsKey`, not reference equality alone).
    //
    // Built from the SAME "883e29bc boot-diverted twin" mechanism this file's own `buildRuntimeUnionFixture`
    // already relies on (never a new, unprecedented construction): E2's own latch, re-processed by PASS 1
    // while E2 is unresolvable, re-arms a FRESH object at K2 (its own recorded `resolvedKey`) and — per
    // that same mechanism — pushes a PENDING reference to THAT fresh object for lazy re-resolve once E2
    // becomes resolvable again. K1's own (unrelated, boot-#1) slot is untouched by this second boot pass —
    // confirmed directly below via `listActiveMergeQuarantines`, never merely assumed. The absorb this
    // sub-case exercises is then triggered by an ORDINARY QUERY (`activeMergeQuarantineFor`'s own `direct`
    // fast-path absorb, `extra=direct`) rather than a raise — a DIFFERENT caller of the SAME
    // `consumeMatchedPendingsIntoArmedEntry` chokepoint than sub-case (a)'s raise-triggered absorb, for
    // caller diversity. Confirmed EMPIRICALLY (not merely argued) via a throwaway scratch repro before
    // writing this scenario.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    {
      const { e: e2, w: w2, k1: k1b, k2: k2b, eFile: e2File, wFile: k2bFile } = buildDualArmFixture("same-identity-reversed");
      fs.rmSync(e2File, { force: true }); // E2's own primary file is gone — only this process's in-memory k1b slot still carries boot #1's object
      const parkedE2 = path.join(os.tmpdir(), `loom-mqrup-parked-e2-${freshSfx()}`);
      fs.renameSync(e2, parkedE2);
      fs.writeFileSync(k2bFile, JSON.stringify({
        repoPath: e2, branch: "e2-same-identity-at-k2", reason: "manufactured different object, same identity as e2",
        enteredAt: Date.now() - 30_000, tokens: ["k2-legacy-token"], resolvedKey: k2b,
      }, null, 2) + "\n");
      reenterMergeQuarantinesAtBoot([]); // boot #2 — e2 unresolvable right now; arms a FRESH object at k2b + pushes its own boot-diverted twin, leaving k1b's own slot untouched
      fs.renameSync(parkedE2, e2);

      const beforeQuery = listActiveMergeQuarantines().filter((q) => q.repoPath === e2);
      check("(precondition) k1 and k2 hold TWO DIFFERENT objects sharing e2's own identity, before any query", beforeQuery.length === 2 && beforeQuery[0] !== beforeQuery[1]);

      const afterQuery = activeMergeQuarantineFor(e2); // THE QUERY — triggers the `direct` fast-path absorb (extra = k1b's own object)
      check("(sanity) the absorb itself still functions — the union carries both tokens", !!afterQuery && ["e-token", "k2-legacy-token"].every((t) => afterQuery.tokens.includes(t)));

      const k2bProxy = activeMergeQuarantineFor(w2); // w2's own path has always hashed to k2b — a window onto that slot (isKeyVerifiedFor fails for it, so this never itself re-triggers an absorb)
      check("*** THE FIX *** the SAME-IDENTITY-different-object slot IS re-pointed to the union (never skipped)", k2bProxy === afterQuery);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SUB-CASE (c) — round 2 (CR b166c6e6), item 3: a DIFFERENT-IDENTITY matched sibling (not `extra`)
    // that is ITSELF a boot-diverted twin, carrying its OWN stale secondary key K3. Gating only against
    // `extra` (round 1's own fix) would skip K3 — the anchor set must include every matched entry, not
    // only `extra`. E here is a plain, single-key raise (never dual-armed itself), isolating this case to
    // the sibling's OWN secondary key.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    {
      const e3 = path.join(os.tmpdir(), `loom-mqrup-e3-${freshSfx()}`);
      fs.mkdirSync(e3, { recursive: true });
      tmpDirs.push(e3);
      fs.writeFileSync(path.join(e3, "README.md"), "# e3\n");
      execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: e3 });
      commitAll(e3, "init", GIT_ID);
      const k1c = canonicalRepoLockKey(e3);
      const t1c = enterMergeQuarantine(e3, "e3-branch-1", "e3's own brand-new raise — no pending/dual-arm involved");
      check("(precondition) e3 is armed singly at k1 (not dual-armed)", activeMergeQuarantineFor(e3)?.armedKeys?.length === 1);

      // The SIBLING: a plain subdir of e3 (collapses onto k1c once resolvable), itself a boot-diverted twin
      // — its own latch is filed under its own direct-path hash but records resolvedKey=k3 (a genuinely
      // different key), while parked/unresolvable at boot time, so PASS 1 arms it at k3 and pushes a twin.
      const sibling3 = path.join(e3, `sib3-${freshSfx()}`);
      fs.mkdirSync(sibling3, { recursive: true });
      const w3 = path.join(os.tmpdir(), `loom-mqrup-w3-never-exists-${freshSfx()}`);
      const k3 = canonicalRepoLockKey(w3);
      const oldHashForSibling3 = hashForKey(process.platform === "win32" ? fs.realpathSync.native(sibling3).toLowerCase() : fs.realpathSync.native(sibling3));
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashForSibling3}.json`), JSON.stringify({
        repoPath: sibling3, branch: "sib3-branch", reason: "sibling3's own dual-armed latch, resolvedKey=k3",
        enteredAt: Date.now(), tokens: ["sib3-token"], resolvedKey: k3,
      }, null, 2) + "\n");
      const parkedSibling3 = path.join(os.tmpdir(), `loom-mqrup-parked-sib3-${freshSfx()}`);
      fs.renameSync(sibling3, parkedSibling3);
      reenterMergeQuarantinesAtBoot([]); // sibling3 unresolvable right now — arms at k3, pushes its own boot-diverted twin
      fs.renameSync(parkedSibling3, sibling3);
      check("(precondition) sibling3 shares e3's own canonical key once resolvable", canonicalRepoLockKey(sibling3) === k1c);

      const t2c = enterMergeQuarantine(e3, "e3-branch-2", "e3's second raise, triggering the sibling-twin absorb"); // hits `existing`, absorbs sibling3's twin (extra=rebuilt-e3, matched=[sibling3's twin])
      const finalE3 = activeMergeQuarantineFor(e3);
      check("(sanity) the union carries all 3 tokens", !!finalE3 && [t1c, t2c, "sib3-token"].every((t) => finalE3.tokens.includes(t)));

      const k3Proxy = activeMergeQuarantineFor(w3);
      check("*** THE FIX (round 2) *** the DIFFERENT-IDENTITY sibling-twin's OWN stale secondary key (k3) is ALSO re-pointed to the union (never skipped just because it isn't `extra`'s own)", k3Proxy === finalE3);
    }
  } else if (scenarioName === "no-extra-graduation-repoints-twin-slot") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 96e6aa58, ROUND 2 (CR b166c6e6) — the round-1 fix (`stale-armed-key-survives-sibling-absorb-
    // raise`) gated a non-anchor key ONLY against `extra` — but `extra` is `undefined` on the NO-extra
    // graduation path (`activeMergeQuarantineFor`'s own lazy-graduation tail, when nothing is armed yet at
    // `key`). A bare pending twin (armed SINGLY at its own `resolvedKey` K2, with a pending reference
    // pushed, by reference, for lazy re-resolve at its real key K1 — PASS 1's own degraded-divert branch,
    // `degradedDivertsToFlush`/`flushDegradedDiverts`) graduates via exactly this path once its path
    // resolves again. The round-1 fix skipped K2 outright (no `extra` to check ownership against) AND
    // `replaceEntryEverywhere` had nothing to re-point either (it was only ever called for `extra`) — so
    // K2 kept pointing at the now-spliced-out twin object forever, producing a DOUBLE report for the same
    // logical identity. RED on commit b7fff0f4 (the round-1 fix).
    //
    // E must be NESTED inside a surviving ancestor R (own `.git`, never touched) for this — a plain
    // TOPLEVEL repo's own degraded (unresolvable) fallback key is IDENTICAL to its own real key (both
    // reduce to "this path, no further walk needed"), so parking a toplevel repo alone never trips PASS
    // 1's `freshHash !== hash` migrate/divert branch at all (confirmed empirically via a throwaway scratch
    // repro before writing this scenario — an earlier draft used a bare toplevel E and was vacuous,
    // passing on BOTH b7fff0f4 and this fix because it never reached the degraded-divert branch).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const r = path.join(os.tmpdir(), `loom-mqrup-r-notwin-${freshSfx()}`);
    const e = path.join(r, "nested");
    fs.mkdirSync(e, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# r\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: r });
    commitAll(r, "init r", GIT_ID);
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: e });
    fs.writeFileSync(path.join(e, "README.md"), "# e nested\n");
    commitAll(e, "init e", GIT_ID);
    const k1 = canonicalRepoLockKey(e); // E's own REAL key, while E is its own toplevel

    const w = path.join(os.tmpdir(), `loom-mqrup-w-notwin-never-exists-${freshSfx()}`);
    const k2 = canonicalRepoLockKey(w); // a genuinely different key

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const eFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
    fs.writeFileSync(eFile, JSON.stringify({
      repoPath: e, branch: "e-branch", reason: "E's own latch, filed at k1 but recorded resolvedKey=k2",
      enteredAt: Date.now() - 60_000, tokens: ["e-token"], resolvedKey: k2,
    }, null, 2) + "\n");
    const parkedE = path.join(os.tmpdir(), `loom-mqrup-parked-notwin-${freshSfx()}`);
    fs.renameSync(e, parkedE); // E vanishes entirely; R (its own parent, own `.git`) survives — the walk now degrades to R's key, not E's own
    reenterMergeQuarantinesAtBoot([]); // e unresolvable THIS boot (and only this boot) — arms SINGLY at k2, pushes a pending twin for k1
    fs.renameSync(parkedE, e);

    const before = listActiveMergeQuarantines().filter((q) => q.repoPath === e);
    check("(precondition) exactly one entry for e before any query, armed SINGLY at k2 — NOTHING yet at k1", before.length === 1 && before[0].armedKeys?.length === 1 && before[0].armedKeys[0] === k2);

    const graduated = activeMergeQuarantineFor(e); // THE QUERY — `direct` is undefined at k1, so this is the NO-extra graduation path
    check("(sanity) graduation carries e's own token", !!graduated && graduated.tokens.includes("e-token"));

    const k2Proxy = activeMergeQuarantineFor(w); // w's own path has always hashed to k2 — a window onto that slot
    check("*** THE FIX (round 2) *** k2's slot IS re-pointed to the SAME union object (never left stale)", k2Proxy === graduated);

    const afterList = listActiveMergeQuarantines().filter((q) => q.repoPath === e);
    check("*** THE FIX (round 2) *** e is listed exactly ONCE after graduation (no stale-twin double-report)", afterList.length === 1);
  } else if (scenarioName === "4b06875f-dual-arm-clear-resurrection") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // PROBE B — Code Review of 7282d183 (card 4b06875f), Finding 1: the physical-hash discriminator
    // ("does the occupant's resolvedKey equal the key `final` is physically filed under RIGHT NOW") asks
    // the WRONG question — it only ever compares against the ONE key the CURRENT protect call happens to
    // be touching, never against the FULL set of keys the clear/raise operation is itself lifting.
    //
    // Setup: Y is dual-armed via the legacy stale-resolvedKey shape (mirrors buildDualArmFixture) — Y's
    // own REAL physical file lives at hash(Ky), its own stored `resolvedKey` field (a stale legacy
    // dual-arm marker) is K2 (W's own REAL canonical key — never a bare nonexistent path, or X's own
    // degenerate "no git root found" fallback could coincidentally equal it, collapsing this probe back
    // into the ordinary single-arm shape). X is a DIFFERENT, degraded, wholly unrelated identity,
    // physically filed AT hash(K2), with X's OWN resolvedKey recorded as Ky — the OTHER half of Y's own
    // dual-arm, never the specific key any one protect call is touching.
    //
    // A RAISE (not a clear) is the clean reproduction: raising W itself (W's own canonical key IS K2)
    // reaches `enterMergeQuarantine`'s `existing` branch (`activeQuarantines.get(K2)` already holds Y,
    // dual-armed there) — a SINGLE `protectUnincorporatedOccupantBeforeDelete` call, with
    // final=quarantinePathForKey(K2)=hash(K2).json=X's own physical file. (A CLEAR of Y was tried first
    // and rejected for this probe — `deleteMergeQuarantineLatchByKey` reaches X's SAME content via TWO
    // independent protect-call sites at once in that shape, and Finding 2's own reader/union gap then
    // happens to erase the wrongly-carried key before it could be observed — a confound, not a fix; see
    // the Round-2 report for the full trace. The raise side has no such second call site.)
    //
    // X's own resolvedKey (Ky) differs from hash(K2)'s own physical key (K2), so the Round-1 guard CARRIES
    // Ky forward into X's own protective copy — even though Ky is EXACTLY the OTHER key Y (the entry
    // actually being protected FROM, via `existing`) is itself armed under. Asserted directly on the
    // WRITTEN FIELD, mid-window, right after the raise — no reboot needed to observe the wrong decision.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqrup-4b-b-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# 4b06875f-dual-arm-clear-resurrection\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);

    const x = path.join(os.tmpdir(), `loom-mqrup-4b-b-x-never-exists-${freshSfx()}`);
    const w = path.join(os.tmpdir(), `loom-mqrup-4b-b-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# 4b06875f-dual-arm-clear-resurrection (w)\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const k2 = canonicalRepoLockKey(w);
    const k2Hash = hashForKey(k2);
    if (k2Hash === kyHash) throw new Error("4b06875f-dual-arm-clear-resurrection: k2 collided with ky — re-run");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const yFile = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`);
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K2",
      enteredAt: Date.now() - 60_000, tokens: ["y-token"], resolvedKey: k2,
    }, null, 2) + "\n");
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${k2Hash}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded, physically at K2, resolvedKey points back at Y's own OTHER armed key",
      enteredAt: Date.now() - 30_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    // Deliberately NOT registering y/w — this must reach d163aef5's own collision-resolution path, never
    // the "backed by a registered repo: legitimate same-toplevel union" shortcut.
    reenterMergeQuarantinesAtBoot([]);

    check("(precondition) Y is dual-armed — direct query at Y's own path sees Y", activeMergeQuarantineFor(y)?.repoPath === y);
    check("(precondition) Y's own armedKeys includes BOTH Ky and K2", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => e.repoPath === y);
      const keys = new Set(yEntry?.armedKeys ?? []);
      return keys.has(ky) && keys.has(k2);
    })());
    check("(precondition) querying W's own path (== K2) sees Y directly, confirming Y occupies K2", activeMergeQuarantineFor(w)?.repoPath === y);
    check("(precondition) X's own physical file is untouched before the raise", fs.readFileSync(xFile, "utf8").includes("x-token"));

    enterMergeQuarantine(w, "w-branch", "w's own genuine unconfirmed-kill reason");

    // Find X's own protective copy by identity, never by "the one new file" (MERGE_QUARANTINE_DIR is
    // shared for this whole scenario run) — mirrors this file's own db0a9db0-era non-vacuity discipline.
    const xProtectiveFile = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => ({ f, parsed: (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })() }))
      .find((e) => e.parsed?.repoPath === x);
    check("(precondition) a protective copy for X was minted", !!xProtectiveFile);
    check("(precondition) the protective copy carries X's own token", !!xProtectiveFile?.parsed.tokens?.includes("x-token"));
    check("*** PROBE B *** the protective copy should NOT carry resolvedKey=Ky — Ky is Y's OWN other armed key, the very entry this protect call is protecting X FROM — today it WRONGLY does",
      xProtectiveFile?.parsed.resolvedKey !== ky);
  } else if (scenarioName === "4b06875f-post-union-filter-clear-sticks") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // PROBE D — manager's own Round-2 design-checkpoint scenario (card 4b06875f): Finding 2's residual,
    // closed by the post-union filter. Combines probe B's dual-arm shape with probe C's pre-existing
    // older-pending-file shape, since BOTH are required to reach the exact union this filter protects:
    //
    // S is dual-armed [Ks, Kr] (legacy stale-resolvedKey shape, S's own real file at hash(Ks)). D is
    // degraded, physically AT hash(Kr) — S's own SECOND armed key — with D's OWN resolvedKey = Ks (S's
    // PRIMARY key). D ALSO has a PRE-EXISTING, OLDER pending-divert file that ALREADY carries
    // resolvedKey=Ks (simulating an earlier, separate, legitimate carry — e.g. from a prior raise this
    // scenario doesn't need to construct explicitly, since D's own on-disk record is the durable truth
    // either way).
    //
    // R raises at Kr (R's own canonical key) — hits S's `existing` branch (S dual-armed there).
    // `liftedKeys = S.armedKeys = {Ks, Kr}` correctly excludes Ks PRE-union (Ks is one of the SAME dual-
    // armed entry's own keys) — `toPersist.resolvedKey = undefined`, exactly as Finding 1's own fix
    // intends. But `reconcilePendingDivertTarget` then unions this `toPersist` against D's own PRE-
    // EXISTING, OLDER pending-divert file, which already carries resolvedKey=Ks — `unionQuarantineEntries`'s
    // own rule ("one side undefined → keep the other") then lets Ks SURVIVE the union, reintroducing
    // exactly what the pre-union exclusion just correctly excluded. THE FIX: re-apply the SAME exclusion
    // to whatever the union produces, before it's written.
    //
    // Then S clears its OWN quarantine (clearMergeQuarantine) — lifting both of its own armed keys. If
    // the wrongly-reintroduced Ks survived onto disk, nothing currently occupies Ks after S's clear, so a
    // reboot re-arms D there unopposed — S's OWN clear is violated: it reads unblocked in-process, right
    // after the clear, but is blocked AGAIN after a reboot. With the post-union filter, Ks never survives
    // the union in the first place, so S's clear genuinely sticks across a reboot, and D's own identity
    // (its own tokens) stays independently enforced throughout via direct identity, with no resolvedKey
    // needed for that query.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const s = path.join(os.tmpdir(), `loom-mqrup-4b-d-s-${freshSfx()}`);
    fs.mkdirSync(s, { recursive: true });
    tmpDirs.push(s);
    fs.writeFileSync(path.join(s, "README.md"), "# 4b06875f-post-union-filter-clear-sticks\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: s });
    commitAll(s, "init", GIT_ID);
    const ks = canonicalRepoLockKey(s);
    const ksHash = hashForKey(ks);

    const r = path.join(os.tmpdir(), `loom-mqrup-4b-d-r-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# 4b06875f-post-union-filter-clear-sticks (r)\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const kr = canonicalRepoLockKey(r);
    const krHash = hashForKey(kr);
    if (krHash === ksHash) throw new Error("4b06875f-post-union-filter-clear-sticks: kr collided with ks — re-run");

    const d = path.join(os.tmpdir(), `loom-mqrup-4b-d-d-never-exists-${freshSfx()}`);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // S's own real file, dual-armed via legacy stale resolvedKey=Kr.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${ksHash}.json`), JSON.stringify({
      repoPath: s, branch: "s-branch", reason: "S dual-armed via legacy stale resolvedKey=Kr",
      enteredAt: Date.now() - 90_000, tokens: ["4b06875f-pd-tok-s"], resolvedKey: kr,
    }, null, 2) + "\n");
    // D physically at hash(Kr) — S's own SECOND armed key — resolvedKey points back at S's own primary key Ks.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${krHash}.json`), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D degraded at Kr, resolvedKey points at S's own primary key Ks",
      enteredAt: Date.now() - 60_000, tokens: ["4b06875f-pd-tok-d-orig"], resolvedKey: ks,
    }, null, 2) + "\n");
    // D's own PRE-EXISTING OLDER pending-divert file, already carrying resolvedKey=Ks.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameFor(d)), JSON.stringify({
      repoPath: d, branch: "d-old-branch", reason: "D's own OLDER pending-divert record, already carrying resolvedKey=Ks",
      enteredAt: Date.now() - 120_000, tokens: ["4b06875f-pd-tok-d-old"], resolvedKey: ks,
    }, null, 2) + "\n");

    // Deliberately NOT registering s/r — must reach d163aef5's own collision-resolution path.
    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) S is dual-armed at [Ks, Kr]", (() => {
      const sEntry = listActiveMergeQuarantines().find((e) => e.repoPath === s);
      const keys = new Set(sEntry?.armedKeys ?? []);
      return keys.has(ks) && keys.has(kr);
    })());

    enterMergeQuarantine(r, "r-branch", "r raises, hits S's existing branch at Kr");

    const dProtectiveFile = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => ({ f, parsed: (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })() }))
      .find((e) => e.parsed?.repoPath === d);
    check("(precondition) a protective copy for D was minted, unioning both of D's own tokens", (() => {
      const tokens = new Set(dProtectiveFile?.parsed.tokens ?? []);
      return tokens.has("4b06875f-pd-tok-d-orig") && tokens.has("4b06875f-pd-tok-d-old");
    })());
    check("*** THE FIX (pre-union) *** D's protective copy does NOT carry resolvedKey=Ks right after the raise",
      dProtectiveFile?.parsed.resolvedKey !== ks);

    clearMergeQuarantine(s);
    check("(mid-window) assertRepoNotQuarantined(s) reads unblocked right after S's own clear", assertRepoNotQuarantined(s).ok === true);

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("*** PROBE D *** assertRepoNotQuarantined(s) stays unblocked after a reboot — S's own clear genuinely sticks",
      fresh.assertRepoNotQuarantined(s).ok === true);
    check("(probe D) D's own tokens are still independently enforced via direct identity", (() => {
      const dAfter = fresh.activeMergeQuarantineFor(d);
      const tokens = new Set(dAfter?.tokens ?? []);
      return tokens.has("4b06875f-pd-tok-d-orig") && tokens.has("4b06875f-pd-tok-d-old");
    })());
  } else if (scenarioName === "4b06875f-migrate-union-drops-dual-arm") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-2 CR a61d0bec (card 4b06875f) CRITICAL — Round 2's own EXPLICIT resolvedKey union rule
    // ("equal -> keep; one undefined -> keep the other; both SET and DIFFERENT -> undefined") leaked
    // from the two protect/pending-divert call sites it was designed for into `armQuarantineKey` — the
    // SAME chokepoint every boot-time dual-arm AND migrate-consolidation union reaches.
    //
    // Y is dual-armed via the legacy stale-resolvedKey shape (mirrors buildDualArmFixture): Y's own real
    // physical file lives at hash(Ky), its own stored `resolvedKey` field is Kw (W's own real canonical
    // key). A SEPARATE latch, physically filed under a STALE key (Kold, never Y's own), with repoPath =
    // Y's OWN subdirectory (so its CURRENT canonical key resolves to Ky too), triggers PASS 1's own
    // MIGRATE branch — which stamps its own in-memory resolvedKey to Ky (its own currentKey) and then
    // falls through to the SAME primary-arm code as every ordinary file, unioning it into whatever
    // already occupies Ky (Y's own dual-armed entry). That union's two operands now carry
    // resolvedKey=Kw (Y's own legacy field) and resolvedKey=Ky (the migrate branch's own stamp) — SET
    // and DIFFERENT. The explicit rule's own "both different -> undefined" branch (correct for the
    // protect/divert case it was designed for) drops Kw outright here — W, which Kw's own dual-arm
    // exists to block, reads UNBLOCKED after a reboot.
    //
    // Y's own enteredAt is deliberately OLDER than the migrating latch's — the "A-older" order the Lead
    // decision names. Under the SCOPED (legacy) rule this fix restores for `armQuarantineKey`, the older
    // side's resolvedKey (Kw) wins unconditionally, regardless of readdir order, so W stays blocked. The
    // OPPOSITE order (the migrating latch older than Y) is a pre-existing, separately-carded fail-open
    // (board card 48bda567) — deliberately NOT fixed or asserted here.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqrup-4b-crit-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# 4b06875f-migrate-union-drops-dual-arm\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);

    const w = path.join(os.tmpdir(), `loom-mqrup-4b-crit-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# 4b06875f-migrate-union-drops-dual-arm (w)\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const kwHash = hashForKey(kw);
    if (kwHash === kyHash) throw new Error("4b06875f-migrate-union-drops-dual-arm: kw collided with ky — re-run");

    const ySub = path.join(y, "sub");
    fs.mkdirSync(ySub, { recursive: true });
    const kySub = canonicalRepoLockKey(ySub);
    if (kySub !== ky) throw new Error("4b06875f-migrate-union-drops-dual-arm: y's own subdirectory did not resolve to y's own key — fixture assumption broken");

    const kold = `stale-pre-migration-key-${freshSfx()}`;
    const koldHash = hashForKey(kold);
    if (koldHash === kyHash) throw new Error("4b06875f-migrate-union-drops-dual-arm: kold collided with ky — re-run");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // Latch A — Y's own real, correctly-named file, dual-armed via a legacy stale resolvedKey=Kw.
    // enteredAt is deliberately OLDER than latch B's below (the A-older order this scenario asserts).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`), JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=Kw",
      enteredAt: Date.now() - 120_000, tokens: ["a1", "a2"], resolvedKey: kw,
    }, null, 2) + "\n");
    // Latch B — a STALE-key-filed latch for Y's own subdirectory, migrating to Ky this boot.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${koldHash}.json`), JSON.stringify({
      repoPath: ySub, branch: "b-branch", reason: "a pre-rename latch for y's own subdirectory, filed under a stale key",
      enteredAt: Date.now(), tokens: ["b1"],
    }, null, 2) + "\n");

    // Deliberately NOT registering y/w — must reach d163aef5's own collision-resolution path.
    reenterMergeQuarantinesAtBoot([]);

    check("(precondition) boot-0 dual-arms Y at BOTH Ky and Kw", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => e.repoPath === y);
      const keys = new Set(yEntry?.armedKeys ?? []);
      return keys.has(ky) && keys.has(kw);
    })());
    check("(precondition) boot-0: W is already blocked, directly, via Y's own dual-arm", activeMergeQuarantineFor(w)?.repoPath === y);

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("*** CRITICAL (round-2 CR a61d0bec) *** W stays blocked after a PLAIN REBOOT (A-older order) — the migrate union must never drop Y's own legacy dual-arm",
      fresh.activeMergeQuarantineFor(w)?.repoPath === y);
    const refusal = fresh.assertRepoNotQuarantined(y);
    check("(refusal text) assertRepoNotQuarantined(y) still names W in its refusal text (db0a9db0 guidance)",
      refusal.ok === false && typeof refusal.reason === "string" && refusal.reason.toLowerCase().includes(w.toLowerCase()));
  } else if (scenarioName === "48bda567-migrate-union-drops-dual-arm-b-older") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Board card 48bda567 — the OPPOSITE age order of "4b06875f-migrate-union-drops-dual-arm" above.
    // IDENTICAL fixture shape (Y dual-armed via the legacy stale-resolvedKey shape, a stale-key-filed
    // latch for Y's own subdirectory migrating to Ky this boot), but latch B (the migrating one) is now
    // deliberately OLDER than latch A (Y's own dual-arm) — the order 4b06875f's Round 3 explicitly left
    // unfixed and unasserted (see this project's own decision record, "Follow-up 4b06875f, Round 3":
    // "The OPPOSITE age order ... is a PRE-EXISTING, separately-carded fail-open under the LEGACY rule
    // too (board card 48bda567) — deliberately not fixed or asserted by this scenario.").
    //
    // This is a fail-open under the plain `{...older}` LEGACY union rule itself — it predates 4b06875f
    // entirely and is NOT caused by the explicit-rule scoping fix. `unionQuarantineEntries`'s legacy rule
    // (merge-quarantine.ts:634, `!options?.explicitResolvedKeyRule` branch) takes `older.resolvedKey`
    // unconditionally. When B (the migrate branch) is older, `older` is B, whose own `resolvedKey` was
    // JUST stamped to `currentKey` (Ky) by the migrate branch (merge-quarantine.ts:4487,
    // `entry = { ...entry, resolvedKey: currentKey }`) — a SELF-REFERENTIAL, uninformative value (it
    // equals the very key the union is being armed at). The union's own `resolvedKey` field becomes Ky,
    // discarding Y's own genuine secondary key Kw outright, even though `armedKeys` itself is STILL
    // correctly `[Ky, Kw]` in memory this boot (verified below — the in-memory dual-arm is NOT what's
    // broken). The migrate-write pass (merge-quarantine.ts:5122 PHASE 1a) then durably persists exactly
    // this union object — Ky's own file on disk ends up with `resolvedKey: Ky` (self-referential) instead
    // of `resolvedKey: Kw`. On the NEXT boot, PASS 1 reads Ky's file, sees `entry.resolvedKey ===
    // currentKey` (both Ky), so the "secondArm" branch (merge-quarantine.ts:4535,
    // `entry.resolvedKey && entry.resolvedKey !== currentKey`) never fires — Kw is never re-armed, and W
    // reads fully UNBLOCKED.
    //
    // Measured directly (not just reasoned) against this project's own compiled module on commit
    // 72ba0598 (main, post-4b06875f): at boot-0 (in-process, no reboot needed to observe this),
    // `activeMergeQuarantineFor(w)` already returns an entry whose own `repoPath` is Y's SUBDIRECTORY
    // (ySub), not Y itself — a side effect of the SAME legacy `{...older}` spread also carrying
    // `repoPath`/`branch`/`reason`/`enteredAt` from the older (B) side, by this function's own documented
    // design ("keep the EARLIER identity ... mirroring enterMergeQuarantine's own 'longest-outstanding,
    // still-unresolved raise' rule" — merge-quarantine.ts:598-602). That part is NOT itself the bug this
    // card targets (board card 398f476c owns the broader "a union can only represent one identity at a
    // time" shape) — this scenario does not assert on `repoPath` at all, only on the two symptoms the
    // card's own DoD names: W staying blocked after a REBOOT, and the refusal text naming W.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqrup-48b-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# 48bda567-migrate-union-drops-dual-arm-b-older\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);

    const w = path.join(os.tmpdir(), `loom-mqrup-48b-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# 48bda567-migrate-union-drops-dual-arm-b-older (w)\n");
    execSync(`git init -q && git config user.email mqrup@loom && git config user.name mqrup`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const kwHash = hashForKey(kw);
    if (kwHash === kyHash) throw new Error("48bda567-migrate-union-drops-dual-arm-b-older: kw collided with ky — re-run");

    const ySub = path.join(y, "sub");
    fs.mkdirSync(ySub, { recursive: true });
    const kySub = canonicalRepoLockKey(ySub);
    if (kySub !== ky) throw new Error("48bda567-migrate-union-drops-dual-arm-b-older: y's own subdirectory did not resolve to y's own key — fixture assumption broken");

    const kold = `stale-pre-migration-key-${freshSfx()}`;
    const koldHash = hashForKey(kold);
    if (koldHash === kyHash) throw new Error("48bda567-migrate-union-drops-dual-arm-b-older: kold collided with ky — re-run");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // Latch A — Y's own real, correctly-named file, dual-armed via a legacy stale resolvedKey=Kw.
    // enteredAt is now NEWER than latch B's below — the "B-older" order this scenario asserts.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`), JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=Kw",
      enteredAt: Date.now(), tokens: ["a1", "a2"], resolvedKey: kw,
    }, null, 2) + "\n");
    // Latch B — a STALE-key-filed latch for Y's own subdirectory, migrating to Ky this boot.
    // enteredAt is deliberately OLDER than latch A's above.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${koldHash}.json`), JSON.stringify({
      repoPath: ySub, branch: "b-branch", reason: "a pre-rename latch for y's own subdirectory, filed under a stale key",
      enteredAt: Date.now() - 120_000, tokens: ["b1"],
    }, null, 2) + "\n");

    // Deliberately NOT registering y/w — must reach d163aef5's own collision-resolution path.
    reenterMergeQuarantinesAtBoot([]);

    check("(precondition) boot-0 dual-arms Y at BOTH Ky and Kw (armedKeys is correct in-memory this boot — the bug is NOT here)", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(ky));
      const keys = new Set(yEntry?.armedKeys ?? []);
      return keys.has(ky) && keys.has(kw);
    })());

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    // `repoPath` is NOT the right thing to assert on here — the SAME legacy `{...older}` spread that
    // drops `resolvedKey` also carries `repoPath` from whichever side is older (merge-quarantine.ts's own
    // documented "keep the EARLIER identity" rule), so in THIS (B-older) order the union's own `repoPath`
    // legitimately becomes Y's own subdirectory, not Y itself — a separate, accepted, 398f476c-owned
    // shape (see the comment above), not this card's bug. Assert on the dual-arm's own `armedKeys`
    // instead: W staying blocked means the SAME entry that answers for Y also answers for W.
    const wEntryAfterReboot = fresh.activeMergeQuarantineFor(w);
    check("*** CARD 48bda567 (B-older order) *** W stays blocked after a PLAIN REBOOT — the migrate union must never drop Y's own legacy dual-arm, regardless of which side is older",
      !!wEntryAfterReboot && (wEntryAfterReboot.armedKeys ?? []).includes(ky) && (wEntryAfterReboot.armedKeys ?? []).includes(kw));
    check("(and it is genuinely Y's OWN dual-arm, not a different entry) querying Y returns the SAME object as querying W",
      fresh.activeMergeQuarantineFor(y) === wEntryAfterReboot);
    const refusal = fresh.assertRepoNotQuarantined(y);
    check("*** CARD 48bda567 (B-older order) *** assertRepoNotQuarantined(y) names W in its refusal text (db0a9db0 guidance)",
      refusal.ok === false && typeof refusal.reason === "string" && refusal.reason.toLowerCase().includes(w.toLowerCase()));
  } else if (scenarioName === "48bda567-no-fire-both-sides-informative-and-different") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card 48bda567's own required NO-FIRE discrimination: a union where BOTH `prior.resolvedKey` and
    // `entry.resolvedKey` are defined, genuinely DIFFERENT from the union's own `key`, AND different from
    // EACH OTHER. CR 31ba43b4 found this shape IS reachable through a real call site (corrected from an
    // earlier draft of this comment that wrongly called it unreachable): a secondary-arm caller passes
    // the PRIMARY arm's own RESULT as `entry`, not the raw parsed entry — if that primary arm itself
    // unioned with an older `prior`, the result's own `resolvedKey` can already differ from the raw
    // entry's own field used as `key`. PASS 1b also primary-arms every tmp residue at its own
    // `currentKey`, so a `.json` + `.tmp` pair (or two tmps) sharing one hash can collide there with two
    // independently-informative keys. Card `1e739f4a` owns fixing the actual outcome once a LATER,
    // unconditional tmp-promotion self-stamp (currently masking it) is itself fixed.
    //
    // This scenario is therefore a REGRESSION PIN on the correction's own outer guard
    // (`merged.resolvedKey === key`), NOT discrimination evidence that the shape can't occur: it passes
    // just as well with the correction removed entirely, and with the outer guard itself deleted too — a
    // genuinely different-and-informative `entry.resolvedKey`/`prior.resolvedKey` pair makes the plain
    // legacy `{...older}` result never equal `key` in the first place, so nothing downstream of that
    // guard is ever reached regardless of whether the guard exists. It is still exercised directly
    // against `armQuarantineKey` itself (via its test-only pass-through) rather than through a real boot
    // fixture, because 1e739f4a's own masking self-stamp makes this exact shape unobservable through a
    // real boot TODAY — not because the shape itself is unreachable.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const key = "shared-key-nofire";
    const kA = "informative-key-a";
    const kB = "informative-key-b";
    if (kA === kB || kA === key || kB === key) throw new Error("48bda567-no-fire: fixture keys must be pairwise distinct");

    const prior = {
      repoPath: "C:\\nofire\\prior-repo", branch: "prior-branch", reason: "prior reason",
      enteredAt: Date.now() - 60_000, tokens: ["prior-token"], resolvedKey: kA, armedKeys: ["prior-own-key", key],
    };
    const entry = {
      repoPath: "C:\\nofire\\entry-repo", branch: "entry-branch", reason: "entry reason",
      enteredAt: Date.now(), tokens: ["entry-token"], resolvedKey: kB,
    };

    // The expected LEGACY result, computed BY HAND — replicating `unionQuarantineEntries`'s own
    // `{...older}` spread (prior is older here: smaller `enteredAt`, neither is a placeholder) plus
    // `armQuarantineKey`'s own `armedKeys` fold — NEVER by calling the function under test, or this would
    // only assert "whatever it returns, it returns" rather than discriminating a real regression.
    const expectedLegacy = {
      ...prior,
      tokens: [...new Set([...prior.tokens, ...entry.tokens])],
      // `unionQuarantineEntries` always sets these as explicit own properties (even when `undefined`) —
      // match that exactly, or a deep-equal check would see extra keys on the real result that this
      // hand-built comparison object never had and fail for a reason unrelated to the correction.
      orphanLatchFiles: undefined,
      armedKeys: [...new Set([...(prior.armedKeys ?? []), key])],
      contributorRepoPaths: undefined,
      provenanceUnknown: undefined,
      provenanceTracked: undefined,
      // @decision 8db913e2 (Follow-up 43cf3b26) — `unionQuarantineEntries` now ALSO folds each side's own
      // scalar `resolvedKey` into `resolvedKeys` (never gated on the correction above, purely additive) —
      // prior's kA then entry's kB, in that order (see `unionResolvedKeysRetaining`'s own doc).
      resolvedKeys: [prior.resolvedKey, entry.resolvedKey],
    };

    const byRepoKey = new Map([[key, prior]]);
    const actual = armQuarantineKeyTestOnly(byRepoKey, key, entry);

    check("(precondition) the fixture's own resolvedKeys are genuinely different from `key` AND from each other",
      prior.resolvedKey !== key && entry.resolvedKey !== key && prior.resolvedKey !== entry.resolvedKey);
    check("*** NO-FIRE *** the correction must NOT engage — the result is byte-for-byte the plain legacy union",
      isDeepStrictEqual(actual, expectedLegacy));
    check("*** NO-FIRE *** resolvedKey specifically stays the OLDER side's value (kA), untouched by the correction",
      actual.resolvedKey === kA);
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
