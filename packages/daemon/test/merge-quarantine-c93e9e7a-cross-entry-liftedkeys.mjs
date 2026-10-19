import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c93e9e7a — two same-identity pending quarantine twins (P1, P2) can both be armed at a key
// Kb that lies OUTSIDE the active entry's own `keysToLift` (or outside any single active anchor's own
// armed set at all). Before this fix, each of `clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`'s
// own pending filter, and `clearMergeQuarantineByRecordedPath`'s own matchedPending loop recomputed a
// per-entry `ownedArmedKeys`/`liftedKeysForEntry` via `entryStillOwnsKey` against the LIVE
// `activeQuarantines` map — read AFTER an earlier-processed, same-identity twin's own iteration had
// already deleted Kb from that map. The later twin's own narrower (wrongly Kb-excluding) exclusion set
// then let a foreign occupant X — physically co-located at the twin's OWN other, genuinely-owned key —
// wrongly RETAIN `resolvedKey: Kb` in its own protective copy, even though Kb was genuinely lifted by
// THIS SAME clear() call (just via the FIRST twin's own processing). Across a reboot that registers the
// innocent third-party repo whose own canonical key IS Kb, this wrongly RE-QUARANTINES it.
//
// THE FIX (`merge-quarantine.ts`, decision 8db913e2's own Follow-up c93e9e7a): each of the three sites
// now computes its own complete lifted-key union `L` ONCE, before ANY delete in that call — every tied
// pending twin's own reduce-or-remove decision (token-set based, so it never needs live map state) and,
// for every twin that will be FULLY REMOVED, its pre-delete-snapshot-owned armed keys — and threads that
// SAME `L` into every protect/exclude call the clear subsequently makes, including the ACTIVE entry's own
// `keysToLift` loop (round-2 MAJOR 2 below) and, for `clearMergeQuarantineByRecordedPath`, into every
// `clearMergeQuarantineByKey` call it delegates to (LOOP 3 below), so the outer, broader union composes
// with each delegated call's own narrower one rather than being silently recomputed away.
//
// SCENARIOS:
//   twin-twin-by-key            — clearMergeQuarantine (the by-key route; W at K, P1/P2 sharing Kb,
//                                  P2's own second key K2b holds foreign X with resolvedKey=Kb).
//   twin-twin-by-key-control    — SAME shape, but only ONE twin (no earlier twin corrupts the live
//                                  check) — X correctly excludes resolvedKey=Kb even pre-fix.
//   twin-twin-by-recorded-path  — SAME shape via clearMergeQuarantineByRecordedPath (the broad human
//                                  route). Proves the route reaches the fixed clearMergeQuarantineByKey
//                                  correctly end to end. Does NOT isolate this function's OWN "thread L
//                                  into each delegated call" contribution — a pending twin tied via
//                                  subsetOfClearedTokens is ALSO handled by clearMergeQuarantineByKey's
//                                  own internal pre-pass regardless of whether the outer function's own
//                                  threading runs. See `recorded-path-threading-pin` below for the
//                                  construction that DOES isolate it (round-2 CR `89aa6630`).
//   twin-twin-by-token          — SAME shape via clearMergeQuarantineByToken, full-clear-via-active-entry
//                                  delegation (W itself carries the shared token).
//   twin-twin-by-latch-id       — SAME shape via clearMergeQuarantineLatchFile (delegates to
//                                  clearMergeQuarantineByKey by resolved map key — decision c0be9bf9).
//   pure-pending-by-token       — clearTokenFromPendingIndices's OWN standalone shape: a REAL active
//                                  entry O (never pLo/pHi themselves) owns Kb/K2b, so pLo/pHi are PURE
//                                  PENDING and reach `clearTokenFromPendingIndices` directly via
//                                  `nonTwinPendingIndices` (round-2 CR `89aa6630` construction — the
//                                  original version of this scenario armed the twins themselves, which
//                                  routed them through clearActiveEntryTokenAtKey instead and never
//                                  reached this function at all).
//   recorded-path-threading-pin — BLOCKING per round-2 CR: isolates clearMergeQuarantineByRecordedPath's
//                                  own "thread L into each delegated call" as independently necessary. W
//                                  (armed only at K) and P (pending, DISJOINT tokens, its own active match
//                                  at Kq) are untied to each other, so only the OUTER L (scanning every
//                                  matched active entry before delegation) carries Kq into W's own
//                                  delegated clear, where foreign X physically sits at final(K).
//   active-loop-sees-pending    — round-2 MAJOR 2: the clear targets K2b DIRECTLY (where foreign X
//                                  physically sits) — X is discovered by the ACTIVE entry's own
//                                  `keysToLift` loop, which runs BEFORE the pending filter even starts;
//                                  the active loop's own `L` must already include Kb.
//   no-over-unblock-control     — a wholly separate identity (Z3, never tied to this clear at all) must
//                                  survive completely untouched — the union must never widen beyond what
//                                  the tied twins' own armedKeys actually name.
//   reduced-twin-untouched      — a 64119847-shaped reduced twin (holds a token outside the active
//                                  entry's own set) contributes NOTHING to `L` — its own shared key stays
//                                  armed, and nothing is wrongly unblocked.
//   round3-two-distinct-foreign — the round-3 WIP's own regression guard: TWO DISTINCT foreign occupants
//                                  (Z1, Z2), each with its OWN disjoint tokens and its OWN resolvedKey=Kb,
//                                  must EACH independently keep its own enforcement (via its own tokens)
//                                  across a reboot — neither may ever let the other's own resolvedKey
//                                  exclusion cross-contaminate its own, and no PASS-1 union may ever let
//                                  one unblock the other.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "twin-twin-by-key",
  "twin-twin-by-key-control",
  "twin-twin-by-recorded-path",
  "twin-twin-by-token",
  "twin-twin-by-latch-id",
  "pure-pending-by-token",
  "recorded-path-threading-pin",
  "active-loop-sees-pending",
  "no-over-unblock-control",
  "reduced-twin-untouched",
  "round3-two-distinct-foreign",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with its own fresh LOOM_HOME.
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
    ? "\n✅ ALL SCENARIOS PASS"
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card c93e9e7a.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqc93e-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineByToken, clearMergeQuarantineByRecordedPath,
  clearMergeQuarantineByKey, clearMergeQuarantineLatchFile,
  reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot, setActiveQuarantineTestOnly,
  listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const GIT_ID = "git -c user.email=mqc93e@loom -c user.name=mqc93e";

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function commitAll(dir, msg) {
  fs.writeFileSync(path.join(dir, "README.md"), `# ${msg}\n`);
  execSync(`git init -q`, { cwd: dir });
  execSync(`${GIT_ID} add -A && ${GIT_ID} commit -q -m "${msg}"`, { cwd: dir });
}

function injectPending(repoPath, tag, tokens, armedKeys, sourceFile) {
  const entry = { repoPath, branch: `${tag}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens, armedKeys };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: sourceFile ?? `pending-${tag}-test.json` }]);
  return entry;
}

function parkWAt(key, repoPath, tag, tokens) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
}

function writeForeignAt(key, repoPath, tag, tokens, resolvedKey) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: foreign, physically co-located`,
    enteredAt: Date.now() - 30_000, tokens, resolvedKey,
  }, null, 2) + "\n");
}

function findProtective(repoPath) {
  return fs.readdirSync(MERGE_QUARANTINE_DIR)
    .map((f) => ({ f, parsed: (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })() }))
    .filter((e) => e.parsed?.repoPath === repoPath);
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

/** Builds the core "two twins sharing Kb" fixture: W active at a real resolvable repo `w`'s own key K
 *  (tokens=["w-token"]). P1 pending (repoPath=w, tokens=["w-token"] — subset of W's own, ties via
 *  subsetOfClearedTokens), armedKeys=[Kb], directly armed at Kb (occupant===P1.entry). P2 pending
 *  (repoPath=w, tokens=["w-token"] too), armedKeys=[Kb, K2b] — a STALE claim on Kb (P1 is the real
 *  current occupant there) plus its own genuinely-owned second key K2b. X: a foreign, unresolvable
 *  occupant physically at hash(K2b), resolvedKey=Kb. `twinCount:1` omits P1 entirely (P2 then directly
 *  owns BOTH Kb and K2b itself) — the negative control isolating the two-twin interaction as the cause. */
function buildTwinFixture(tag, { twinCount = 2 } = {}) {
  const w = path.join(os.tmpdir(), `loom-mqc93e-${tag}-w-${freshSfx()}`);
  fs.mkdirSync(w, { recursive: true });
  commitAll(w, `c93e9e7a-${tag}-w`);
  const K = canonicalRepoLockKey(w);

  const z = path.join(os.tmpdir(), `loom-mqc93e-${tag}-z-${freshSfx()}`);
  fs.mkdirSync(z, { recursive: true });
  commitAll(z, `c93e9e7a-${tag}-z`);
  const Kb = canonicalRepoLockKey(z);

  const K2b = `c93e-${tag}-k2b-${freshSfx()}`;
  if (K2b === K || K2b === Kb) throw new Error("K2b collided with K/Kb — re-run");

  const x = path.join(os.tmpdir(), `loom-mqc93e-${tag}-x-never-exists-${freshSfx()}`);

  parkWAt(K, w, `c93e-${tag}-w`, ["w-token"]);
  reenterMergeQuarantinesAtBootTestOnly([w], []);

  // Inject every pending twin BEFORE writing X's own foreign file or arming anything via
  // `setActiveQuarantineTestOnly` — `reenterMergeQuarantinesAtBootTestOnly` re-scans the WHOLE
  // MERGE_QUARANTINE_DIR on every call (not just this fixture's own files), so a boot call issued AFTER
  // X's file already exists on disk re-discovers and re-arms it at Kb each time, silently clobbering an
  // earlier `setActiveQuarantineTestOnly` override. Writing X's file, and arming everything via
  // `setActiveQuarantineTestOnly`, only AFTER every boot call in this fixture is done means nothing can
  // ever re-scan and undo it.
  //
  // P1 is injected FIRST, P2 SECOND — `pendingUnresolvedQuarantines`'s own array/iteration order then
  // processes P1 before P2, so P1 (armed ONLY at Kb) deletes Kb first; P2 (armed at Kb AND K2b) is
  // processed second and must still recognise Kb as lifted even though, by then, nothing in the live
  // map owns it any more — this is the exact order the bug needs to manifest. Injecting them in the
  // OPPOSITE order (P2 first) masks the bug entirely: P2's own ownedArmedKeys would then be computed
  // BEFORE anything is deleted, so it would correctly include Kb regardless of the fix under test.
  let p1Entry;
  if (twinCount === 2) {
    p1Entry = injectPending(w, `c93e-${tag}-p1`, ["w-token"], [Kb], `pending-c93e-${tag}-p1-test.json`);
  }
  const p2Entry = injectPending(w, `c93e-${tag}-p2`, ["w-token"], [Kb, K2b], `pending-c93e-${tag}-p2-test.json`);

  writeForeignAt(K2b, x, "x", ["x-token"], Kb);

  if (twinCount === 2) {
    setActiveQuarantineTestOnly(Kb, p1Entry);
  } else {
    setActiveQuarantineTestOnly(Kb, p2Entry);
  }
  setActiveQuarantineTestOnly(K2b, p2Entry);

  return { w, z, K, Kb, K2b, x };
}

/** Asserts the twin fixture's post-clear invariant: X's protective copy excludes resolvedKey=Kb (Kb was
 *  genuinely lifted by this same call), and a reboot registering z (whose own canonical key IS Kb) never
 *  wrongly re-quarantines it. `expectBug:true` (used only by the control) asserts the OPPOSITE polarity
 *  is what a correct implementation produces either way — never used to assert a bug is PRESENT. */
async function assertTwinFixtureCleared({ w, z, Kb, x }, label) {
  check(`${label}: w is unblocked right after its own clear`, assertRepoNotQuarantined(w).ok === true);
  const xFiles = findProtective(x);
  check(`${label}: a protective copy for X exists`, xFiles.length > 0);
  check(`${label}: X's protective copy does NOT carry resolvedKey=Kb`, xFiles.every((e) => e.parsed?.resolvedKey !== Kb));
  const reboot = await rebootSim();
  reboot.reenterMergeQuarantinesAtBoot([w, z]);
  check(`${label} (reboot): z (own key IS Kb) stays unblocked`, reboot.assertRepoNotQuarantined(z).ok === true);
  check(`${label} (reboot): w stays unblocked`, reboot.assertRepoNotQuarantined(w).ok === true);
}

try {
  if (scenarioName === "twin-twin-by-key") {
    const fx = buildTwinFixture("tk");
    clearMergeQuarantine(fx.w);
    await assertTwinFixtureCleared(fx, "by-key");
  } else if (scenarioName === "twin-twin-by-key-control") {
    const fx = buildTwinFixture("tkc", { twinCount: 1 });
    clearMergeQuarantine(fx.w);
    await assertTwinFixtureCleared(fx, "*** CONTROL *** by-key, one twin only");
  } else if (scenarioName === "twin-twin-by-recorded-path") {
    const fx = buildTwinFixture("trp");
    clearMergeQuarantineByRecordedPath(fx.w);
    await assertTwinFixtureCleared(fx, "by-recorded-path (LOOP 3)");
  } else if (scenarioName === "twin-twin-by-token") {
    const fx = buildTwinFixture("tt");
    clearMergeQuarantineByToken(fx.w, "w-token"); // W's only token -> full clear, delegates to clearMergeQuarantineByKey
    await assertTwinFixtureCleared(fx, "by-token (full clear via active entry)");
  } else if (scenarioName === "twin-twin-by-latch-id") {
    const fx = buildTwinFixture("tli");
    const id = hashForKey(fx.K);
    const result = clearMergeQuarantineLatchFile(id);
    check("by-latch-id: clearMergeQuarantineLatchFile reports ok", result?.ok === true);
    await assertTwinFixtureCleared(fx, "by-latch-id");
  } else if (scenarioName === "pure-pending-by-token") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // clearTokenFromPendingIndices's OWN standalone shape, isolated from clearActiveEntryTokenAtKey/
    // clearMergeQuarantineByKey entirely (round-2 CR construction — the original version of this scenario
    // armed pLo/pHi THEMSELVES via setActiveQuarantineTestOnly, which made them their own `activeMatches`
    // and routed them through clearActiveEntryTokenAtKey -> clearMergeQuarantineByKey instead; they never
    // reached clearTokenFromPendingIndices at all, so that version never exercised this fix).
    //
    // O: a REAL ACTIVE entry (never pending), tokens=["shared-token"], armed at BOTH Kb and K2b — it is
    // what pLo/pHi's own `entryStillOwnsKey` subset check actually reads as the "occupant" at each key.
    // pLo (armedKeys=[Kb,K2b]) and pHi (armedKeys=[Kb]) are PURE PENDING — never separately armed — so
    // `clearMergeQuarantineByToken`'s own `activeMatches` set never contains them; both reach
    // `nonTwinPendingIndices` -> `clearTokenFromPendingIndices` directly. pLo is injected FIRST, pHi
    // SECOND, so the function's own DESCENDING processing order visits pHi (the higher index) first —
    // pHi fully removes and deletes Kb; pLo (processed second) must still recognise Kb as already lifted
    // by this SAME call when protecting X at K2b, or it wrongly retains resolvedKey=Kb there.
    //
    // `clearMergeQuarantineByToken` runs `clearTokenFromPendingIndices` BEFORE its own active-entry loop,
    // so by the time O would otherwise be found there, its own Kb/K2b slots are already gone (evicted as
    // a side effect of pLo/pHi's own structurally-tied ownership) — O is never separately delegated, so
    // nothing downstream can retroactively fix a defect in clearTokenFromPendingIndices's own handling.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-ppt-w-never-exists-${freshSfx()}`);
    const z = path.join(os.tmpdir(), `loom-mqc93e-ppt-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    commitAll(z, "c93e9e7a-ppt-z");
    const Kb = canonicalRepoLockKey(z);
    const K2b = `c93e-ppt-k2b-${freshSfx()}`;
    if (K2b === Kb) throw new Error("K2b collided — re-run");
    const x = path.join(os.tmpdir(), `loom-mqc93e-ppt-x-never-exists-${freshSfx()}`);

    // Inject BOTH twins before writing X's own foreign file or arming O — see buildTwinFixture's own doc
    // comment for why a boot call issued after X's file exists would re-discover and re-arm it.
    const pLoEntry = injectPending(w, "c93e-ppt-plo", ["shared-token"], [Kb, K2b], "pending-c93e-ppt-plo-test.json");
    const pHiEntry = injectPending(w, "c93e-ppt-phi", ["shared-token"], [Kb], "pending-c93e-ppt-phi-test.json");
    writeForeignAt(K2b, x, "x", ["x-token"], Kb);
    const oEntry = { repoPath: w, branch: "c93e-ppt-o-branch", reason: "c93e-ppt-o: real active entry", enteredAt: Date.now() - 20_000, tokens: ["shared-token"], armedKeys: [Kb, K2b], resolvedKey: Kb };
    setActiveQuarantineTestOnly(Kb, oEntry);
    setActiveQuarantineTestOnly(K2b, oEntry);

    check("(precondition) O, pLo, pHi are three distinct objects sharing the token", listActiveMergeQuarantines().filter((e) => e.tokens.includes("shared-token")).length === 3);
    check("(precondition) only O (never pLo/pHi) carries a resolvedKey — they are pure pending, never their own active match", listActiveMergeQuarantines().filter((e) => e.tokens.includes("shared-token") && e.resolvedKey !== undefined).length === 1);
    check("(precondition) X's own file carries resolvedKey=Kb before the clear", (() => {
      const raw = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(K2b)}.json`), "utf8"));
      return raw.resolvedKey === Kb;
    })());

    clearMergeQuarantineByToken(w, "shared-token");

    const xFiles = findProtective(x);
    check("pure-pending-by-token: a protective copy for X exists", xFiles.length > 0);
    check("pure-pending-by-token: X's protective copy does NOT carry resolvedKey=Kb", xFiles.every((e) => e.parsed?.resolvedKey !== Kb));
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([z]);
    check("pure-pending-by-token (reboot): z stays unblocked", reboot.assertRepoNotQuarantined(z).ok === true);
  } else if (scenarioName === "recorded-path-threading-pin") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // BLOCKING (round-2 CR `89aa6630`) — pins `clearMergeQuarantineByRecordedPath`'s own threading of its
    // outer `L` into each delegated `clearMergeQuarantineByKey` call as INDEPENDENTLY NECESSARY (unlike
    // `twin-twin-by-recorded-path` above, which the CR showed is vacuous for this purpose).
    //
    // W: a REAL ACTIVE entry (plain in-memory object, never a real on-disk file of its own), armed ONLY
    // at K = canonicalRepoLockKey(w), tokens=["w-token"]. Its OWN physical latch file final(K) instead
    // holds FOREIGN, unresolvable X (tokens=["x-token"], resolvedKey=Kq) — a degraded co-location, same
    // shape every other scenario in this file uses. P: PENDING, same identity w, DISJOINT tokens
    // (["p-token"] — never ties to W at all, via subset or orphan-ref), armed at Kq = canonicalRepoLockKey(zq)
    // for a REAL repo zq — it is its OWN active match, structurally unrelated to W.
    //
    // `clearMergeQuarantineByRecordedPath(w)`'s own `matched` scan finds BOTH W (at K) and P (at Kq) as
    // separate matched active entries (same identity). Delegating `clearMergeQuarantineByKey(K, w)` for
    // W: P is untied (disjoint tokens, no shared key/orphan-ref), so THAT delegated call's own internal
    // pre-pass computes a narrow L={K} — Kq is invisible to it. The ONLY way Kq ever reaches this specific
    // delegated call is via the OUTER `activeLiftedKeys`/`L` (built by scanning every matched active entry,
    // including P, BEFORE delegation) threaded in as `externalLiftedKeys`. When W's own `keysToLift` loop
    // then protects X (found at final(K)), excluding Kq from X's own resolvedKey depends ENTIRELY on that
    // threading — removing the `, L` argument at the delegated call site turns this scenario RED.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-rpt-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    commitAll(w, "c93e9e7a-rpt-w");
    const K = canonicalRepoLockKey(w);
    const zq = path.join(os.tmpdir(), `loom-mqc93e-rpt-zq-${freshSfx()}`);
    fs.mkdirSync(zq, { recursive: true });
    commitAll(zq, "c93e9e7a-rpt-zq");
    const Kq = canonicalRepoLockKey(zq);
    if (Kq === K) throw new Error("Kq collided with K — re-run");
    const x = path.join(os.tmpdir(), `loom-mqc93e-rpt-x-never-exists-${freshSfx()}`);

    // Inject P before writing X's own foreign file or arming W/P — see buildTwinFixture's own doc
    // comment for why a boot call issued after a foreign file exists would re-discover and re-arm it.
    const pEntry = injectPending(w, "c93e-rpt-p", ["p-token"], [Kq], "pending-c93e-rpt-p-test.json");
    writeForeignAt(K, x, "x", ["x-token"], Kq);
    const wEntry = { repoPath: w, branch: "c93e-rpt-w-branch", reason: "c93e-rpt-w: real active entry, armed only at K", enteredAt: Date.now() - 20_000, tokens: ["w-token"], armedKeys: [K] };
    setActiveQuarantineTestOnly(K, wEntry);
    setActiveQuarantineTestOnly(Kq, pEntry);

    check("(precondition) W and P are two SEPARATE matched active entries", listActiveMergeQuarantines().filter((e) => e.repoPath === w).length === 2);
    check("(precondition) X's own file (at final(K)) carries resolvedKey=Kq before the clear", (() => {
      const raw = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(K)}.json`), "utf8"));
      return raw.resolvedKey === Kq;
    })());

    clearMergeQuarantineByRecordedPath(w);

    check("recorded-path-threading-pin: w is unblocked right after its own clear", assertRepoNotQuarantined(w).ok === true);
    const xFiles = findProtective(x);
    check("recorded-path-threading-pin: a protective copy for X exists", xFiles.length > 0);
    check("recorded-path-threading-pin: X's protective copy does NOT carry resolvedKey=Kq", xFiles.every((e) => e.parsed?.resolvedKey !== Kq));
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([w, zq]);
    check("recorded-path-threading-pin (reboot): zq (own key IS Kq) stays unblocked", reboot.assertRepoNotQuarantined(zq).ok === true);
    check("recorded-path-threading-pin (reboot): w stays unblocked", reboot.assertRepoNotQuarantined(w).ok === true);
  } else if (scenarioName === "active-loop-sees-pending") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // round-2 MAJOR 2 (Q2 from the manager's kickoff): a SEPARATE active entry W (armed ONLY at K2b, its
    // own single key) is cleared DIRECTLY via K2b — the key X physically sits at. P2 (pending, SAME
    // identity as W, tied via subsetOfClearedTokens) owns Kb ALONE (never K2b — W itself occupies K2b,
    // not P2) so the ACTIVE entry's own `keysToLift` (just [K2b]) can never include Kb on its own; only
    // the pre-pass's union with the TIED PENDING TWIN's own owned keys puts Kb into `L` at all. The
    // active loop's protect call for K2b runs BEFORE the pending filter even starts, so if that loop's
    // own `L` were computed from `keysToLift` alone (the pre-fix shape), it would miss Kb entirely —
    // independent of the pending-filter fix (whose own scenarios never reach the ACTIVE loop at all).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-als-w-never-exists-${freshSfx()}`);
    const z = path.join(os.tmpdir(), `loom-mqc93e-als-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    commitAll(z, "c93e9e7a-als-z");
    const Kb = canonicalRepoLockKey(z);
    const K2b = `c93e-als-k2b-${freshSfx()}`;
    if (K2b === Kb) throw new Error("K2b collided — re-run");
    const x = path.join(os.tmpdir(), `loom-mqc93e-als-x-never-exists-${freshSfx()}`);

    const p2Entry = injectPending(w, "c93e-als-p2", ["w-token"], [Kb], "pending-c93e-als-p2-test.json");
    const wActiveEntry = { repoPath: w, branch: "c93e-als-w-branch", reason: "c93e-als-w: active, armed only at K2b", enteredAt: Date.now() - 20_000, tokens: ["w-token"], armedKeys: [K2b] };

    writeForeignAt(K2b, x, "x", ["x-token"], Kb);
    setActiveQuarantineTestOnly(Kb, p2Entry);
    setActiveQuarantineTestOnly(K2b, wActiveEntry); // W, NOT P2, is K2b's own active occupant

    clearMergeQuarantineByKey(K2b, w); // clears via K2b DIRECTLY — W's own key, where X physically sits

    const xFiles = findProtective(x);
    check("active-loop-sees-pending: a protective copy for X exists", xFiles.length > 0);
    check("active-loop-sees-pending: X's protective copy does NOT carry resolvedKey=Kb", xFiles.every((e) => e.parsed?.resolvedKey !== Kb));
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([z]);
    check("active-loop-sees-pending (reboot): z stays unblocked", reboot.assertRepoNotQuarantined(z).ok === true);
  } else if (scenarioName === "no-over-unblock-control") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Z3: a WHOLLY SEPARATE identity (never w), its own resolvedKey=Kd — a key never named in ANY tied
    // twin's own armedKeys. Must survive this clear completely untouched: not merely its own resolvedKey,
    // its very existence — it fails the outer identity gate before "tied" is even evaluated.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-noou-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    commitAll(w, "c93e9e7a-noou-w");
    const K = canonicalRepoLockKey(w);
    const Kd = `c93e-noou-kd-${freshSfx()}`;
    const z3 = path.join(os.tmpdir(), `loom-mqc93e-noou-z3-never-exists-${freshSfx()}`);

    parkWAt(K, w, "c93e-noou-w", ["w-token"]);
    reenterMergeQuarantinesAtBootTestOnly([w], []);

    const z3SourceFile = "pending-c93e-noou-z3.json";
    const z3Entry = { repoPath: z3, branch: "z3-branch", reason: "z3: wholly separate identity", enteredAt: Date.now() - 40_000, tokens: ["z3-token"], resolvedKey: Kd };
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, z3SourceFile), JSON.stringify(z3Entry, null, 2) + "\n");
    reenterMergeQuarantinesAtBootTestOnly([], [{ entry: z3Entry, sourceFile: z3SourceFile }]);

    check("(precondition) Z3 is its own separate pending entry, resolvedKey=Kd", listActiveMergeQuarantines().some((e) => e.branch === "z3-branch" && e.resolvedKey === Kd));

    clearMergeQuarantine(w);

    const z3Still = listActiveMergeQuarantines().find((e) => e.branch === "z3-branch");
    check("no-over-unblock: Z3 still exists, completely untouched", !!z3Still);
    check("no-over-unblock: Z3's own resolvedKey=Kd survives — Kd was never lifted by this call", z3Still?.resolvedKey === Kd);
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([]);
    check("no-over-unblock (reboot): Z3 is still reported quarantined", !!reboot.activeMergeQuarantineFor(z3));
  } else if (scenarioName === "reduced-twin-untouched") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // 64119847 interaction: P-reduce (tied via orphan-file ref, holds "v-token" OUTSIDE W's own tokens)
    // must REDUCE, not fully remove — keeping its own armed key(s) untouched. P-remove (directly armed at
    // the shared key Kb, tokens subset of W's own) is the one that actually lifts Kb. Kb must NOT enter
    // `L` via P-reduce (it contributes nothing, per the manager's own instruction #1), and nothing is
    // wrongly unblocked — in particular Kc (P-reduce's own OTHER armed key) must stay armed throughout.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-rtu-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    commitAll(w, "c93e9e7a-rtu-w");
    const K = canonicalRepoLockKey(w);
    const Kb = `c93e-rtu-kb-${freshSfx()}`;
    const Kc = `c93e-rtu-kc-${freshSfx()}`;
    const pReduceSourceFile = "pending-c93e-rtu-preduce-test.json";

    // W's own real file, written with orphanLatchFiles naming P-reduce's own sourceFile UP FRONT, so a
    // single boot call arms W with the tie already in place.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(K)}.json`), JSON.stringify({
      repoPath: w, branch: "c93e-rtu-w-branch", reason: "c93e-rtu-w: real latch", tokens: ["w-token"],
      enteredAt: Date.now() - 20_000, orphanLatchFiles: [pReduceSourceFile],
    }, null, 2) + "\n");
    const pReduceEntry = {
      repoPath: w, branch: "c93e-rtu-preduce-branch", reason: "c93e-rtu-preduce: injected pending",
      enteredAt: Date.now() - 5_000, tokens: ["w-token", "v-token"], armedKeys: [Kc],
    };
    reenterMergeQuarantinesAtBootTestOnly([w], [{ entry: pReduceEntry, sourceFile: pReduceSourceFile }]);
    setActiveQuarantineTestOnly(Kc, pReduceEntry);

    // P-remove: injected AFTER boot (so it never collides with W's own file above), directly armed at Kb
    // (occupant === itself), tokens subset of W's own -> full removal.
    const pRemoveEntry = injectPending(w, "c93e-rtu-premove", ["w-token"], [Kb], "pending-c93e-rtu-premove-test.json");
    setActiveQuarantineTestOnly(Kb, pRemoveEntry);

    check("(precondition) W active with w-token only, orphanLatchFiles names P-reduce", listActiveMergeQuarantines().some((e) => e.repoPath === w && e.tokens.length === 1 && e.tokens[0] === "w-token" && e.orphanLatchFiles?.includes(pReduceSourceFile)));
    check("(precondition) P-reduce pending with both tokens, armed at Kc", listActiveMergeQuarantines().some((e) => e.tokens.includes("v-token") && (e.armedKeys ?? []).includes(Kc)));

    clearMergeQuarantine(w);

    // @decision 64119847 — w is STILL blocked: P-reduce shares w's own identity and still carries
    // v-token, so `assertRepoNotQuarantined` correctly reports it quarantined via P-reduce's own survival
    // — this is the reduce contract working as intended, never a sign K/Kc themselves are still armed.
    check("reduced-twin: w is STILL quarantined (P-reduce's own outstanding v-token)", assertRepoNotQuarantined(w).ok === false);
    const pReduceAfter = listActiveMergeQuarantines().find((e) => e.tokens.includes("v-token"));
    check("reduced-twin: P-reduce survives with its own outstanding v-token", !!pReduceAfter);
    check("reduced-twin: P-reduce's own armedKeys (Kc) is left untouched", !!pReduceAfter?.armedKeys?.includes(Kc));

    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([w]);
    const pReduceAfterReboot = reboot.listActiveMergeQuarantines().find((e) => e.tokens.includes("v-token"));
    check("reduced-twin (reboot): P-reduce's own v-token survives a reboot too", !!pReduceAfterReboot);
    check("reduced-twin (reboot): P-reduce's own armedKeys (Kc) survives a reboot too", !!pReduceAfterReboot?.armedKeys?.includes(Kc));
  } else if (scenarioName === "round3-two-distinct-foreign") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE ROUND-3 REGRESSION GUARD. TWO DISTINCT foreign occupants Z1 (at K2b1) and Z2 (at K2b2), each
    // with its OWN disjoint token and its OWN resolvedKey=Kb, co-located with TWO SEPARATE pending twins
    // P1 (armedKeys=[Kb,K2b1]) and P2 (armedKeys=[Kb,K2b2]) sharing Kb (P1 directly armed there). Both Z1
    // and Z2 must have resolvedKey=Kb correctly stripped from their own protective copies (Kb is
    // genuinely lifted) AND each must independently remain quarantined (via its own distinct token) after
    // a reboot — the round-3 WIP's own "finalize at the end" design let a cross-identity PASS-1 union
    // wrongly UNBLOCK one of them; this design (an up-front, per-call `L`, never a deferred global
    // finalize) must not.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqc93e-r3-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    commitAll(w, "c93e9e7a-r3-w");
    const K = canonicalRepoLockKey(w);
    const z = path.join(os.tmpdir(), `loom-mqc93e-r3-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    commitAll(z, "c93e9e7a-r3-z");
    const Kb = canonicalRepoLockKey(z);
    const K2b1 = `c93e-r3-k2b1-${freshSfx()}`;
    const K2b2 = `c93e-r3-k2b2-${freshSfx()}`;
    if (new Set([K, Kb, K2b1, K2b2]).size !== 4) throw new Error("key collision — re-run");

    const z1 = path.join(os.tmpdir(), `loom-mqc93e-r3-z1-never-exists-${freshSfx()}`);
    const z2 = path.join(os.tmpdir(), `loom-mqc93e-r3-z2-never-exists-${freshSfx()}`);

    parkWAt(K, w, "c93e-r3-w", ["w-token"]);
    reenterMergeQuarantinesAtBootTestOnly([w], []);

    // Inject BOTH twins before writing either foreign file or arming anything — see buildTwinFixture's
    // own doc comment for why a boot call issued after a foreign file exists would re-discover/re-arm it.
    const p1Entry = injectPending(w, "c93e-r3-p1", ["w-token"], [Kb, K2b1], "pending-c93e-r3-p1-test.json");
    const p2Entry = injectPending(w, "c93e-r3-p2", ["w-token"], [Kb, K2b2], "pending-c93e-r3-p2-test.json");
    writeForeignAt(K2b1, z1, "z1", ["z1-token"], Kb);
    writeForeignAt(K2b2, z2, "z2", ["z2-token"], Kb);
    setActiveQuarantineTestOnly(Kb, p1Entry);
    setActiveQuarantineTestOnly(K2b1, p1Entry);
    setActiveQuarantineTestOnly(K2b2, p2Entry);

    clearMergeQuarantine(w);

    const z1Files = findProtective(z1);
    const z2Files = findProtective(z2);
    check("round3: a protective copy for Z1 exists", z1Files.length > 0);
    check("round3: a protective copy for Z2 exists", z2Files.length > 0);
    check("round3: Z1's protective copy does NOT carry resolvedKey=Kb", z1Files.every((e) => e.parsed?.resolvedKey !== Kb));
    check("round3: Z2's protective copy does NOT carry resolvedKey=Kb", z2Files.every((e) => e.parsed?.resolvedKey !== Kb));
    check("round3: Z1's own token survives (not destroyed)", z1Files.some((e) => e.parsed?.tokens?.includes("z1-token")));
    check("round3: Z2's own token survives (not destroyed)", z2Files.some((e) => e.parsed?.tokens?.includes("z2-token")));

    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([w, z]);
    check("round3 (reboot): z (own key IS Kb) stays unblocked", reboot.assertRepoNotQuarantined(z).ok === true);
    check("round3 (reboot): Z1 is STILL independently quarantined (own token, never unblocked)", !!reboot.activeMergeQuarantineFor(z1));
    check("round3 (reboot): Z2 is STILL independently quarantined (own token, never unblocked)", !!reboot.activeMergeQuarantineFor(z2));
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} catch (e) {
  console.error("SCENARIO ERROR", e);
  failures++;
}

console.log(failures === 0 ? `\n✅ ${scenarioName}: all checks passed` : `\n❌ ${scenarioName}: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
