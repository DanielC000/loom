import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 0faffa95 — Code Review d7eaad3d of 3315b08a (bdf747fc): clearTokenFromPendingIndices' own
// re-resolve-by-identity fallback (3315b08a) can re-resolve `live` onto an entry that is ALSO an ACTIVE
// TWIN protectOccupantContentBeforeDelete's own BOTH-INDICES branch just re-pointed — that branch calls
// replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename, written.entry) for the twin's own key,
// but the armedKeys union feeding written.entry is gated to atFilenameIdx alone (@decision
// c9114934/cd5a3cf9), so the twin's own armedKeys never join it. clearTokenFromPendingIndices' re-derived
// plan is sourced purely from live.entry.armedKeys, so the twin's key is invisible to it, even though
// activeQuarantines now genuinely points that key at live.entry.
//
// Construction: T (clear target, canonical pending slot, tokens=[token]) + M (real clear target,
// armedKeys=[k], tokens=[token], twin-by-identity-not-reference at k so it stays out of activeMatches,
// mirroring 3315b08a's own occupantMid technique) + T2 (ACTIVE TWIN: same identity as T, sourceFile = k's
// own hashed latch basename, armedKeys=[kTwin], and activeQuarantines.get(kTwin) === T2.entry BY
// REFERENCE). k's own on-disk content holds T's identity (varied below to toggle remove-vs-reduce).
//
// Processing order (descending): M (processed first) self-splices cleanly, then its own armed-key
// cleanup reaches deleteMergeQuarantineLatchByKey(k, ...) -> protectOccupantContentBeforeDelete, which
// finds T (atFilenameIdx) AND T2 (atFinalBasenameIdx) BOTH sharing T's identity -> the BOTH-INDICES
// branch re-points kTwin onto written.entry and SPLICES T2's own pending slot. Processing T next: its
// original wrapper is detached (ASSIGNed over) -> re-resolves by identity (3315b08a) to the slot now
// holding written.entry, which is ALSO activeQuarantines.get(kTwin).
//
// SCENARIO REDUCE: k's on-disk content = [token, "disk-survivor-token"] -> union produces a non-empty
// remainder -> REDUCE. PRE-FIX: in-memory state is correct (activeQuarantines correctly re-points kTwin,
// token correctly dropped) but kTwin's own on-disk latch is NEVER rewritten, and phase 2
// (clearActiveEntryTokenAtKey's own walk in clearMergeQuarantineByToken) never visits it either, because
// by the time phase 2 runs the in-memory entry no longer carries `token`. POST-FIX: the re-resolve branch
// defers entirely to phase 2 the moment it discovers live.entry is an active twin, and phase 2's own
// dual-tracked-twin loop durably rewrites BOTH kTwin's own latch AND T's own stranded pending slot.
//
// SCENARIO REMOVE: k's on-disk content = [token] only -> union produces an empty remainder -> REMOVE.
// SAFE even pre-fix (phase 2 backstops it, since the remove branch never mutates live.entry.tokens
// itself) — included here as the REMOVE-side regression guard, with the CORRECTED invariant: T is fully
// unquarantined and kTwin's own physical latch file is unlinked.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-0faffa95-active-twin-defer-to-phase2.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq0faffa95-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByToken, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
  reenterMergeQuarantinesAtBoot,
} = await import(mergeQuarantineModuleHref);

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

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

async function runScenario(name, { expectReduce }) {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mq0faffa95-${name}-T-never-${sfx}`);
  const M = path.join(os.tmpdir(), `loom-mq0faffa95-${name}-M-never-${sfx}`);
  const k = `mq0faffa95-${name}-k-${sfx}`;
  const kTwin = `mq0faffa95-${name}-kTwin-${sfx}`;
  const finalBasenameForK = `${hashKey(k)}.json`;
  const finalBasenameForKTwin = `${hashKey(kTwin)}.json`;
  const tCanonicalName = pendingDivertFilenameForTest(T);
  // Scenario-scoped token literal — the module-global `clearedTokens` tombstone set is NEVER reset
  // between scenarios sharing one process/module instance; reusing the same literal token string across
  // scenarios would make an EARLIER scenario's own tombstone of it silently short-circuit a LATER
  // scenario's protect call (readSurvivingOnDiskTokens' own already-cleared filter), with no error and no
  // log either way — exactly as invisible as the hazard this whole test exists to catch. Every OTHER
  // identity (T/M/k/kTwin) is already scoped by `sfx`; the token string needs the same discipline.
  const token = `token-${name}`;
  const survivorToken = `disk-survivor-token-${name}`;
  const twinPrivateToken = `twin-private-token-${name}`;
  // REDUCE: disk holds `token` PLUS a survivor -> union produces a non-empty remainder (reduce).
  // REMOVE: disk holds ONLY `token` -> union produces an empty remainder (full remove).
  const diskTokens = expectReduce ? [token, survivorToken] : [token];

  const t2Entry = {
    repoPath: T, branch: "t2-twin-branch", reason: `0faffa95 ${name}: active twin, same identity as T, armed at kTwin`,
    enteredAt: Date.now(), tokens: [twinPrivateToken], armedKeys: [kTwin],
  };

  // pendingUnresolvedQuarantines order (indices 0..2):
  //   0: T  — our clear target, at its own canonical pending-divert name (atFilenameIdx match)
  //   1: M  — real clear target, tokens=[token] only (full "remove"), armedKeys=[k]
  //   2: T2 — ACTIVE TWIN, same identity as T, squatting k's own physical latch basename (atFinalBasenameIdx match)
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: T, branch: "t-branch", reason: `0faffa95 ${name}: T's own record, at its own canonical pending-divert name`, enteredAt: Date.now(), tokens: [token] }, sourceFile: tCanonicalName },
    { entry: { repoPath: M, branch: "m-branch", reason: `0faffa95 ${name}: real clear target (M), processed first`, enteredAt: Date.now(), tokens: [token], armedKeys: [k] }, sourceFile: `pending-0faffa95-${name}-m-test.json` },
    { entry: t2Entry, sourceFile: finalBasenameForK },
  ]);

  // occupantM: twin-by-identity (not by reference) at k — mirrors 3315b08a's own occupantMid technique
  // so M itself stays out of activeMatches (never excluded from nonTwinPendingIndices before this loop
  // even starts — 64283e06's own "today unreachable" precondition for clearMergeQuarantineByToken).
  setActiveQuarantineTestOnly(k, { repoPath: M, branch: "occupant-m-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: [token] });
  // T2 IS an active twin BY REFERENCE: the exact same object sits in pendingUnresolvedQuarantines[2].entry
  // and as activeQuarantines.get(kTwin) — this is the shape protect's both-indices branch must re-point.
  setActiveQuarantineTestOnly(kTwin, t2Entry);

  // k's own REAL on-disk file — T's own identity's content, read by protectOccupantContentBeforeDelete
  // when M's own armed key k is cleared.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForK), JSON.stringify({
    repoPath: T, branch: "t-disk-branch", reason: `0faffa95 ${name}: T's own real on-disk content at k`, enteredAt: Date.now(), tokens: diskTokens,
  }, null, 2) + "\n");

  // kTwin's own REAL on-disk physical latch file (what T2 is supposedly durably backed by).
  const kTwinLatchPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKTwin);
  fs.writeFileSync(kTwinLatchPath, JSON.stringify({
    repoPath: T, branch: "t2-twin-branch", reason: `0faffa95 ${name}: T2's own durable latch at kTwin, pre-clear`, enteredAt: Date.now(), tokens: [token, twinPrivateToken],
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

  if (expectReduce) {
    check(`*** ${name} *** kTwin's own PHYSICAL latch file no longer carries 'token' (the bug, if unfixed, FAILS this)`, !!kTwinLatchAfter && !(kTwinLatchAfter.tokens ?? []).includes(token));
    check(`*** ${name} *** kTwin's own PHYSICAL latch file still carries the surviving token (the surviving token is never dropped)`, !!kTwinLatchAfter && (kTwinLatchAfter.tokens ?? []).includes(survivorToken));
    // T's own stranded pending slot — @decision ae79d492's dual-tracked-twin loop (clearActiveEntryTokenAtKey)
    // is the thing that durably rewrites it, since this fix defers ENTIRELY to phase 2; assert this ON
    // DISK, not just that the in-memory entry looks clean.
    const tOnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, tCanonicalName), "utf8")); } catch { return null; } })();
    check(`*** ${name} *** T's own pending-slot file was ALSO durably rewritten (no 'token', surviving token survives)`, !!tOnDisk && !(tOnDisk.tokens ?? []).includes(token) && (tOnDisk.tokens ?? []).includes(survivorToken));
    check(`*** ${name} *** T is still correctly blocked (the surviving token is genuinely outstanding)`, !assertRepoNotQuarantined(T).ok);

    // SIMULATED RESTART — re-import fresh and re-scan; `token` must not resurrect anywhere.
    const rb = await rebootSim();
    rb.reenterMergeQuarantinesAtBoot([T, M]);
    const tAfterReboot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === T);
    check(`*** REBOOT ${name} *** no entry for T carries 'token' after a simulated restart`, !tAfterReboot.some((e) => e.tokens.includes(token)));
    check(`*** REBOOT ${name} *** T is still blocked by the surviving token after the restart`, tAfterReboot.some((e) => e.tokens.includes(survivorToken)));
  } else {
    check(`*** ${name} *** T is fully unquarantined (nothing survives anywhere for T's identity)`, assertRepoNotQuarantined(T).ok && !listActiveMergeQuarantines().some((e) => e.repoPath === T));
    check(`*** ${name} *** kTwin's own PHYSICAL latch file was unlinked (phase 2 fully lifted it)`, kTwinLatchAfter === null);

    const rb = await rebootSim();
    rb.reenterMergeQuarantinesAtBoot([T, M]);
    check(`*** REBOOT ${name} *** T stays fully unquarantined after a simulated restart`, !rb.listActiveMergeQuarantines().some((e) => e.repoPath === T));
  }
}

await runScenario("REDUCE", { expectReduce: true });
await runScenario("REMOVE", { expectReduce: false });

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearTokenFromPendingIndices defers a re-resolved ACTIVE TWIN entirely to "
    + "clearActiveEntryTokenAtKey (phase 2), which durably rewrites both the twin's own latch and the "
    + "stranded target's own pending slot, instead of deriving an armedKeys-incomplete plan that leaves "
    + "the twin's own durable state stale."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 0faffa95's active-twin hazard.`);
process.exit(failures === 0 ? 0 : 1);
