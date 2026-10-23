import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 6be6c9ff — Code Review 3e2c79c5 of 0faffa95 (425f97cd), SF1: a multi-key active twin's OTHER
// armed key(s) were never covered when clearing a token. Modeled directly on
// merge-quarantine-0faffa95-active-twin-defer-to-phase2.mjs's own construction (M processed first, clears
// its armed key k, protectOccupantContentBeforeDelete's own both-indices branch re-points EVERY
// activeQuarantines slot that pointed at the twin T2 onto written.entry), with ONE structural change: T2
// is armed at TWO keys (kTwin, kTwin2 — a real shape, see 54054c01/3d27c045), each with its own REAL
// on-disk physical latch file, instead of 0faffa95's single kTwin.
//
// Mechanism (pre-fix): `written.entry.armedKeys` is NEVER unioned with the twin's own `armedKeys` (its
// only sources are `toPersist`/`oldAtFilename`, @decision c9114934/cd5a3cf9) — so after
// `replaceEntryEverywhere` re-points BOTH kTwin and kTwin2 onto it, `written.entry` carries NO armedKeys
// of its own. `clearMergeQuarantineByToken`'s own activeQuarantines walk dedupes by entry reference, so
// only the FIRST key Map-iteration lands on reaches `clearActiveEntryTokenAtKey`, whose own
// `armedKeysForEntry` fallback (`entry.armedKeys?.length ? entry.armedKeys : [key]`) then collapses to
// that ONE key — the twin's OTHER key is never visited, for either REDUCE (its physical latch keeps the
// cleared token; a restart resurrects it) or REMOVE (it stays mapped in-memory to an entry that still
// holds the token — fail-closed, the 3d27c045 bug shape, not merely a restart-resurrection defect).
//
// Fix: `armedKeysForEntry` (clearActiveEntryTokenAtKey) and `keysToLift` (clearMergeQuarantineByKey) both
// now derive their candidate key set via the shared `liveArmedKeys(key, entry)` helper — a UNION of
// `entry.armedKeys`, a fresh live scan of `activeQuarantines` for every key `k` where
// `activeQuarantines.get(k) === entry`, and `key` itself — never `entry.armedKeys` alone. See
// @decision 8db913e2 ("armedKeys — left unfixed (Lead ruling)") for why a UNION-never-replace live scan
// is the ruling's own endorsed alternative to copying a replaced object's own stale list forward.
//
// SF2 (Code Review 2029fcf5 of this card): the third fix site — enterMergeQuarantine's existing-branch
// raise, which stamps liveArmedKeys onto `baseEntry` — had no test of its own, so reverting JUST that
// site stayed green. `runRaiseScenario` below closes that gap: a REAL `enterMergeQuarantine` raise onto
// an existing multi-key twin (armedKeys deliberately empty, the post-re-point `written.entry` shape),
// asserting the SECOND armed key's own physical latch GAINS the newly raised token, then a clear.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-6be6c9ff-multikey-twin-armed-keys.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-mq6be6c9ff-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByToken, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
  reenterMergeQuarantinesAtBoot, enterMergeQuarantine,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=mq6be6c9ff@loom -c user.name=mq6be6c9ff";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

// Mirrors the real module's own private pendingDivertFilenameFor.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// A REAL, resolvable toplevel repo — `enterMergeQuarantine`'s own `existing` branch only fires when
// `isRepoPathCurrentlyResolvable(repoPath)` is true, unlike the clear-side scenarios above (which never
// call the real raise entry point and so can use a deliberately unresolvable `-never-` path instead).
function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq6be6c9ff-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# 6be6c9ff SF2 raise fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

async function runScenario(name, { expectReduce }) {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mq6be6c9ff-${name}-T-never-${sfx}`);
  const M = path.join(os.tmpdir(), `loom-mq6be6c9ff-${name}-M-never-${sfx}`);
  const k = `mq6be6c9ff-${name}-k-${sfx}`;
  const kTwin = `mq6be6c9ff-${name}-kTwin-${sfx}`;
  const kTwin2 = `mq6be6c9ff-${name}-kTwin2-${sfx}`;
  const finalBasenameForK = `${hashKey(k)}.json`;
  const finalBasenameForKTwin = `${hashKey(kTwin)}.json`;
  const finalBasenameForKTwin2 = `${hashKey(kTwin2)}.json`;
  const tCanonicalName = pendingDivertFilenameForTest(T);
  // Scenario-scoped token literal — the module-global `clearedTokens` tombstone set is NEVER reset
  // between scenarios sharing one process/module instance; a shared literal would let an EARLIER
  // scenario's own tombstone silently short-circuit a LATER scenario's protect call (0faffa95's own
  // tombstone lesson). Every OTHER identity (T/M/k/kTwin/kTwin2) is already scoped by `sfx`.
  const token = `token-${name}`;
  const survivorToken = `disk-survivor-token-${name}`;
  const twinPrivateToken = `twin-private-token-${name}`;
  // REDUCE: disk holds `token` PLUS a survivor -> union produces a non-empty remainder (reduce).
  // REMOVE: disk holds ONLY `token` -> union produces an empty remainder (full remove).
  const diskTokens = expectReduce ? [token, survivorToken] : [token];

  // T2: MULTI-KEY active twin — armed at [kTwin, kTwin2], the real shape per 54054c01/3d27c045.
  const t2Entry = {
    repoPath: T, branch: "t2-twin-branch", reason: `6be6c9ff ${name}: active twin, same identity as T, armed at [kTwin, kTwin2]`,
    enteredAt: Date.now(), tokens: [twinPrivateToken], armedKeys: [kTwin, kTwin2],
  };

  // pendingUnresolvedQuarantines order:
  //   0: T  — clear target, canonical pending-divert name (atFilenameIdx match)
  //   1: M  — real clear target, tokens=[token], armedKeys=[k] (processed first)
  //   2: T2 — ACTIVE TWIN, same identity as T, squatting k's own physical latch basename (atFinalBasenameIdx match)
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: T, branch: "t-branch", reason: `6be6c9ff ${name}: T's own record, at its own canonical pending-divert name`, enteredAt: Date.now(), tokens: [token] }, sourceFile: tCanonicalName },
    { entry: { repoPath: M, branch: "m-branch", reason: `6be6c9ff ${name}: real clear target (M), processed first`, enteredAt: Date.now(), tokens: [token], armedKeys: [k] }, sourceFile: `pending-6be6c9ff-${name}-m-test.json` },
    { entry: t2Entry, sourceFile: finalBasenameForK },
  ]);

  // occupantM: twin-by-identity (not by reference) at k — mirrors 0faffa95/3315b08a's own occupantMid
  // technique so M itself stays out of activeMatches.
  setActiveQuarantineTestOnly(k, { repoPath: M, branch: "occupant-m-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: [token] });
  // T2 IS an active twin BY REFERENCE at BOTH of its armed keys.
  setActiveQuarantineTestOnly(kTwin, t2Entry);
  setActiveQuarantineTestOnly(kTwin2, t2Entry);

  // k's own REAL on-disk file — T's own identity's content, read by protectOccupantContentBeforeDelete
  // when M's own armed key k is cleared.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForK), JSON.stringify({
    repoPath: T, branch: "t-disk-branch", reason: `6be6c9ff ${name}: T's own real on-disk content at k`, enteredAt: Date.now(), tokens: diskTokens,
  }, null, 2) + "\n");

  // kTwin's own REAL on-disk physical latch file (what T2 is supposedly durably backed by).
  const kTwinLatchPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKTwin);
  fs.writeFileSync(kTwinLatchPath, JSON.stringify({
    repoPath: T, branch: "t2-twin-branch", reason: `6be6c9ff ${name}: T2's own durable latch at kTwin, pre-clear`, enteredAt: Date.now(), tokens: [token, twinPrivateToken],
  }, null, 2) + "\n");

  // kTwin2's own REAL on-disk physical latch file — the SECOND armed key, the gap this card closes.
  const kTwin2LatchPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKTwin2);
  fs.writeFileSync(kTwin2LatchPath, JSON.stringify({
    repoPath: T, branch: "t2-twin-branch", reason: `6be6c9ff ${name}: T2's own durable latch at kTwin2, pre-clear`, enteredAt: Date.now(), tokens: [token, twinPrivateToken],
  }, null, 2) + "\n");

  check(`(precondition ${name}) T reads blocked before the clear`, !assertRepoNotQuarantined(T).ok);
  check(`(precondition ${name}) M reads blocked before the clear`, !assertRepoNotQuarantined(M).ok);

  // THE CLEAR under test.
  clearMergeQuarantineByToken(M, token);

  check(`*** ${name} *** M is fully lifted`, assertRepoNotQuarantined(M).ok);

  const activeAfter = listActiveMergeQuarantines();
  const tEntriesAfter = activeAfter.filter((e) => e.repoPath === T);
  check(`*** ${name} *** no in-memory T entry still carries 'token'`, !tEntriesAfter.some((e) => e.tokens.includes(token)));

  // ON DISK — never trust memory alone (a-control-inherits-the-equivalence-you-assumed-building-it):
  let kTwinLatchAfter = null;
  try { kTwinLatchAfter = JSON.parse(fs.readFileSync(kTwinLatchPath, "utf8")); } catch { /* removed or unreadable */ }
  let kTwin2LatchAfter = null;
  try { kTwin2LatchAfter = JSON.parse(fs.readFileSync(kTwin2LatchPath, "utf8")); } catch { /* removed or unreadable */ }

  if (expectReduce) {
    check(`*** ${name} *** kTwin's own PHYSICAL latch file no longer carries 'token'`, !!kTwinLatchAfter && !(kTwinLatchAfter.tokens ?? []).includes(token));
    check(`*** ${name} *** kTwin2's own PHYSICAL latch file no longer carries 'token' (CARD 6be6c9ff'S OWN GAP — the second armed key)`, !!kTwin2LatchAfter && !(kTwin2LatchAfter.tokens ?? []).includes(token));
    check(`*** ${name} *** kTwin's own PHYSICAL latch file still carries the surviving token`, !!kTwinLatchAfter && (kTwinLatchAfter.tokens ?? []).includes(survivorToken));
    check(`*** ${name} *** kTwin2's own PHYSICAL latch file still carries the surviving token`, !!kTwin2LatchAfter && (kTwin2LatchAfter.tokens ?? []).includes(survivorToken));

    // T's own stranded pending slot — 0faffa95's own dual-tracked-twin loop (clearActiveEntryTokenAtKey)
    // is what durably rewrites it; assert ON DISK, not just that the in-memory entry looks clean.
    const tOnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, tCanonicalName), "utf8")); } catch { return null; } })();
    check(`*** ${name} *** T's own pending-slot file was ALSO durably rewritten (no 'token', surviving token survives)`, !!tOnDisk && !(tOnDisk.tokens ?? []).includes(token) && (tOnDisk.tokens ?? []).includes(survivorToken));
    check(`*** ${name} *** T is still correctly blocked (the surviving token is genuinely outstanding)`, !assertRepoNotQuarantined(T).ok);

    // SIMULATED RESTART — re-import fresh and re-scan; `token` must not resurrect anywhere.
    const rb = await rebootSim();
    rb.reenterMergeQuarantinesAtBoot([T, M]);
    const tAfterReboot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === T);
    check(`*** REBOOT ${name} *** no entry for T carries 'token' after a simulated restart (CARD 6be6c9ff'S OWN GAP)`, !tAfterReboot.some((e) => e.tokens.includes(token)));
    check(`*** REBOOT ${name} *** T is still blocked by the surviving token after the restart`, tAfterReboot.some((e) => e.tokens.includes(survivorToken)));
  } else {
    // IN-PROCESS, before any restart — the 3d27c045-shaped fail-closed stuck-repo check this card's own
    // probe found: pre-fix, T stays blocked here EVEN WITHOUT a restart.
    check(`*** ${name} *** T is fully unquarantined (nothing survives anywhere for T's identity)`, assertRepoNotQuarantined(T).ok && !listActiveMergeQuarantines().some((e) => e.repoPath === T));
    check(`*** ${name} *** kTwin's own PHYSICAL latch file was unlinked`, kTwinLatchAfter === null);
    check(`*** ${name} *** kTwin2's own PHYSICAL latch file was unlinked (CARD 6be6c9ff'S OWN GAP — the second armed key)`, kTwin2LatchAfter === null);

    const rb = await rebootSim();
    rb.reenterMergeQuarantinesAtBoot([T, M]);
    check(`*** REBOOT ${name} *** T stays fully unquarantined after a simulated restart (CARD 6be6c9ff'S OWN GAP)`, !rb.listActiveMergeQuarantines().some((e) => e.repoPath === T));
  }
}

// SF2 — enterMergeQuarantine's existing-branch raise: a raise onto an already-armed multi-key twin whose
// armedKeys is EMPTY (the post-re-point written.entry shape), asserting the SECOND armed key's own
// physical latch GAINS the newly raised token, then clearing that token and asserting K2's latch is
// correctly rewritten too.
async function runRaiseScenario() {
  const R = makeToplevelRepo("raise");
  const K = canonicalRepoLockKey(R);
  const K2 = `mq6be6c9ff-raise-K2-${freshSfx()}`;
  const priorToken = `sf2-prior-token-${freshSfx()}`;

  // `existing`: armed at BOTH K and K2 by reference, with EMPTY armedKeys — exactly the shape
  // `protectOccupantContentBeforeDelete`'s own re-point produces for `written.entry` (c9114934/cd5a3cf9).
  const existing = {
    repoPath: R, branch: "pre-raise-branch", reason: "6be6c9ff SF2: protect re-pointed this twin at [K, K2] with empty armedKeys",
    enteredAt: Date.now(), tokens: [priorToken], armedKeys: [],
  };
  setActiveQuarantineTestOnly(K, existing);
  setActiveQuarantineTestOnly(K2, existing);

  // K2's own REAL, pre-existing on-disk physical latch — holding only the prior token, same identity (R).
  const k2LatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K2)}.json`);
  fs.writeFileSync(k2LatchPath, JSON.stringify({
    repoPath: R, branch: "pre-raise-branch", reason: "6be6c9ff SF2: K2's own pre-existing latch, prior token only",
    enteredAt: Date.now(), tokens: [priorToken],
  }, null, 2) + "\n");

  // THE RAISE under test — a REAL enterMergeQuarantine call, hitting the `existing` branch (K resolves).
  const newToken = enterMergeQuarantine(R, "raise-branch", "6be6c9ff SF2: raise onto the existing multi-key twin");

  const k2AfterRaise = JSON.parse(fs.readFileSync(k2LatchPath, "utf8"));
  check("*** SF2 RAISE *** K2's own PHYSICAL latch GAINS the newly raised token", (k2AfterRaise.tokens ?? []).includes(newToken));
  check("*** SF2 RAISE *** K2's own PHYSICAL latch still carries the prior token", (k2AfterRaise.tokens ?? []).includes(priorToken));

  // THE CLEAR — lift the newly raised token only (REDUCE; priorToken survives) — and confirm K2's own
  // latch, now correctly tracked post-raise, is rewritten too (exercises the full raise-then-clear
  // round trip through the REAL enterMergeQuarantine/clearMergeQuarantineByToken entry points).
  clearMergeQuarantineByToken(R, newToken);
  const k2AfterClear = JSON.parse(fs.readFileSync(k2LatchPath, "utf8"));
  check("*** SF2 CLEAR *** K2's own PHYSICAL latch no longer carries the cleared token", !(k2AfterClear.tokens ?? []).includes(newToken));
  check("*** SF2 CLEAR *** K2's own PHYSICAL latch still carries the prior (surviving) token", (k2AfterClear.tokens ?? []).includes(priorToken));
}

await runScenario("REDUCE", { expectReduce: true });
await runScenario("REMOVE", { expectReduce: false });
await runRaiseScenario();

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — every armed key of a multi-key active twin is covered when clearing a token "
    + "(derived via liveArmedKeys's live-occupancy union, never entry.armedKeys alone)."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 6be6c9ff's multi-key-twin hazard.`);
process.exit(failures === 0 ? 0 : 1);
