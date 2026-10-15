// Board card 8bff3cae — PASS 1's own `.json` migrate branch (merge-quarantine.ts, search
// "@decision 8db913e2 (Follow-up 8bff3cae)") unconditionally stamped `entry.resolvedKey = currentKey`,
// discarding whatever informative key the scalar already carried, with nothing folding it into
// `entry.resolvedKeys` first. Flagged (not reproduced) by `8db913e2`'s own "Follow-up 1e739f4a" Do-not
// section as a THIRD near-identical arbitration site; investigated and reproduced hermetically by this
// card's own worker (INVESTIGATE-FIRST, before any source edit; see the task's own `worker_report`
// history), then fixed on manager direction. See docs/decisions/8db913e2-raise-diverts-instead-of-
// overwriting-a-kept-occupant.md's own "Follow-up 8bff3cae" section for the full narrative.
//
// TWO INDEPENDENT fail-opens, both closed by the SAME fix (fold forward BEFORE the scalar overwrite,
// via the shared isInformativeKey/unionResolvedKeysRetaining/hashToRepo primitives — no new mechanism):
//
// (A) LEGACY SCALAR-ONLY DUAL-ARM — a record written by pre-43cf3b26 code (no `resolvedKeys` field at
//     all) already carries an informative scalar `resolvedKey` (a genuine cross-repo dual-arm, the
//     4b06875f/48bda567 shape). PASS 1's migrate branch overwrote the scalar with `currentKey`,
//     discarding the dual-arm key with no array to fall back on — the witness repo it names goes
//     unblocked on the SAME boot the migrate runs, and stays unblocked (`legacy-scalar-dual-arm`).
// (B) SHARED-ANCESTOR-KEY SIBLING — a plain subdir (no `.git` of its own) collapses onto its parent
//     repo's own canonical key (7673d096) and raises ITS OWN quarantine there — so the parent repo's own
//     enforcement is, in practice, backed by that one physical file. If the subdir LATER gets its own
//     `.git` (its canonical key diverges), PASS 1's migrate branch moved that file away with no check
//     for whether the STALE key it's abandoning still names a different, currently-registered,
//     resolvable repo — the parent repo, whose own identity never changed at all, goes unblocked the
//     moment the unrelated sibling's key happens to diverge (`shared-ancestor-sibling-survives-divergence`).
//
// CONTROL (`current-format-pin`): the SAME legacy shape (A), but with `resolvedKeys` ALREADY populated
// with the dual-arm key (i.e. a record already written by 43cf3b26-generation code) — this must ALREADY
// be green before this card's fix (43cf3b26's own write chokepoint already handles it) and stays green
// after, proving the fix is additive and does not change the already-correct path.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
useOwnLoomHome("loom-mqp1mrk8bff3cae-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, assertRepoNotQuarantined, clearMergeQuarantine, clearMergeQuarantineReporting, enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqp1mrk8bff3cae@loom -c user.name=mqp1mrk8bff3cae";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A fresh, cache-busted re-import of the compiled module in THIS SAME process — a REBOOT-SIM, never an
// actual OS process restart. See merge-quarantine-pass1-migrate-union.mjs's own header for the same note.
let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mqHref}?b=${bootReimportCounter}`);
}

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqp1mrk8bff3cae-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqp1mrk8bff3cae@loom && git config user.name mqp1mrk8bff3cae`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A) legacy-scalar-dual-arm — X migrates; its scalar resolvedKey=K2 (Y's own real key) is the ONLY
  // carrier (no resolvedKeys array) — the exact shape a pre-43cf3b26 write would have persisted.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const x = makeRepo("legacy-x");
    const y = makeRepo("legacy-y"); // the witness W
    const k2 = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const staleFile = path.join(MERGE_QUARANTINE_DIR, `stale-legacy-x-${freshSfx()}.json`);
    fs.writeFileSync(staleFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own pre-43cf3b26 legacy dual-arm with Y",
      enteredAt: Date.now() - 60_000, tokens: ["token-x"],
      resolvedKey: k2, // informative, cross-repo — NO resolvedKeys array (legacy shape)
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([x, y]);
    check("(legacy-scalar-dual-arm) X blocked on the SAME boot the migrate runs", assertRepoNotQuarantined(x).ok === false);
    check("*** THE FIX *** (legacy-scalar-dual-arm) Y (witness W) STILL blocked on the SAME boot — no same-boot loss", assertRepoNotQuarantined(y).ok === false);

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([x, y]);
    check("(legacy-scalar-dual-arm) X blocked after reboot 1", reboot1.assertRepoNotQuarantined(x).ok === false);
    check("*** THE FIX *** (legacy-scalar-dual-arm) Y (witness W) blocked after reboot 1 — durable, not just in-process", reboot1.assertRepoNotQuarantined(y).ok === false);

    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([x, y]);
    check("(legacy-scalar-dual-arm) X blocked after reboot 2", reboot2.assertRepoNotQuarantined(x).ok === false);
    check("*** THE FIX *** (legacy-scalar-dual-arm) Y (witness W) blocked after reboot 2", reboot2.assertRepoNotQuarantined(y).ok === false);

    reboot2.clearMergeQuarantine(x);
    reboot2.clearMergeQuarantine(y);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (control, PIN) current-format-pin — SAME shape, but resolvedKeys ALREADY carries K2 (a record
  // already written by 43cf3b26-generation code). Must be green BEFORE this card's fix too — proves the
  // fix below is additive, never a behavior change to the already-correct array path.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const x = makeRepo("pin-x");
    const y = makeRepo("pin-y");
    const k2 = canonicalRepoLockKey(y);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const staleFile = path.join(MERGE_QUARANTINE_DIR, `stale-pin-x-${freshSfx()}.json`);
    fs.writeFileSync(staleFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own POST-43cf3b26 dual-arm with Y (plural array populated)",
      enteredAt: Date.now() - 60_000, tokens: ["token-x"],
      resolvedKey: k2, resolvedKeys: [k2],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([x, y]);
    check("(PIN current-format) X blocked", assertRepoNotQuarantined(x).ok === false);
    check("(PIN current-format) Y (witness) blocked — already correct pre-fix, must stay correct", assertRepoNotQuarantined(y).ok === false);

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([x, y]);
    check("(PIN current-format) Y (witness) blocked after a reboot", reboot1.assertRepoNotQuarantined(y).ok === false);

    reboot1.clearMergeQuarantine(x);
    reboot1.clearMergeQuarantine(y);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B) shared-ancestor-sibling-survives-divergence — R is a real repo; teamA is a plain subdir of R (no
  // own .git), so canonicalRepoLockKey(teamA) collapses onto R's own key Kr (7673d096). teamA raises its
  // OWN quarantine while in that state — physically filed at hash(Kr).json, i.e. R's own backing file.
  // teamA THEN gets its own `.git` (its key diverges to Ksub) — PASS 1's migrate branch moves that file
  // to hash(Ksub).json. R's OWN identity never changed; it must stay blocked throughout.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("shared-r");
    const teamA = path.join(r, "teamA");
    fs.mkdirSync(teamA, { recursive: true });
    const kr = canonicalRepoLockKey(r);
    check("(precondition) teamA collapses onto R's own key before it has its own .git", canonicalRepoLockKey(teamA) === kr);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const krFile = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(kr).digest("hex").slice(0, 24)}.json`);
    fs.writeFileSync(krFile, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's quarantine, raised while a plain subdir of R",
      enteredAt: Date.now() - 60_000, tokens: ["token-teamA"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([r, teamA]);
    check("(precondition, boot 0) R blocked via the shared key Kr before any migrate", assertRepoNotQuarantined(r).ok === false);
    check("(precondition, boot 0) teamA blocked too (same key)", assertRepoNotQuarantined(teamA).ok === false);

    // NOW give teamA its own .git — its canonical key diverges from R's.
    execSync(`git init -q && git config user.email mqp1mrk8bff3cae@loom && git config user.name mqp1mrk8bff3cae`, { cwd: teamA });
    fs.writeFileSync(path.join(teamA, "x.txt"), "x\n");
    commitAll(teamA, "init", GIT_ID);
    const ksub = canonicalRepoLockKey(teamA);
    check("(precondition) teamA's key genuinely diverged from Kr after getting its own .git", ksub !== kr);

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([r, teamA]);
    check("*** THE FIX *** (shared-ancestor-sibling) R STILL blocked after teamA's own migrate — the shared key's enforcement survives the sibling's divergence", reboot1.assertRepoNotQuarantined(r).ok === false);
    check("(shared-ancestor-sibling) teamA blocked under its own new key too", reboot1.assertRepoNotQuarantined(teamA).ok === false);

    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([r, teamA]);
    check("*** THE FIX *** (shared-ancestor-sibling) R STILL blocked after a second reboot — durable, not just in-process", reboot2.assertRepoNotQuarantined(r).ok === false);
    check("(shared-ancestor-sibling) teamA STILL blocked after a second reboot", reboot2.assertRepoNotQuarantined(teamA).ok === false);

    reboot2.clearMergeQuarantine(r);
    reboot2.clearMergeQuarantine(teamA);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (CR 0b975d2a, BLOCKING) legacy-tier-match-never-blocks-unrelated-repo — named for the `hashToRepo`
  // LEGACY tier this exercises (NOT "ancestor tier", which is `ancestorHashToRepo`, a different
  // mechanism entirely). X = T/sub (plain subdir of T, a real repo) raises a quarantine while collapsed
  // onto T's own key Kt. T THEN stops being a repo (its own .git removed) and X gets its own .git
  // instead — X's record migrates away from Kt. `hash` (Kt) now ALSO matches T via `hashToRepo`'s LEGACY
  // tier (T's own raw path, unconditionally indexed) — but T's CURRENT (freshly re-walked) key is Kp
  // (T's own ancestor P's key), NOT Kt. The pre-fix bug queued Kp anyway (trusting the legacy-tier match
  // without re-verifying its hash), durably blocking the UNRELATED ancestor repo P. P must never be
  // blocked by this; X must still be blocked by its own record.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("probe1-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqp1mrk8bff3cae@loom && git config user.name mqp1mrk8bff3cae`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const x = path.join(t, "sub");
    fs.mkdirSync(x, { recursive: true });
    check("(precondition) X collapses onto T's own key before X has its own .git", canonicalRepoLockKey(x) === canonicalRepoLockKey(t));

    reenterMergeQuarantinesAtBoot([p, t, x]);
    enterMergeQuarantine(x, "x-branch", "X real raise while plain subdir of T");
    check("(precondition) X's own raise lands exactly one file", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length === 1);
    check("(precondition, pre-restructure) P is NOT blocked", assertRepoNotQuarantined(p).ok === true);

    // Restructure: T stops being its own repo; X becomes its own repo instead.
    fs.rmSync(path.join(t, ".git"), { recursive: true, force: true });
    execSync(`git init -q && git config user.email mqp1mrk8bff3cae@loom && git config user.name mqp1mrk8bff3cae`, { cwd: x });
    check("(precondition) T now collapses onto P's own key", canonicalRepoLockKey(t) === canonicalRepoLockKey(p));
    check("(precondition) X now has its own, distinct key", canonicalRepoLockKey(x) !== canonicalRepoLockKey(t));

    let last;
    for (let i = 1; i <= 3; i++) {
      last = await rebootSim();
      last.reenterMergeQuarantinesAtBoot([p, t, x]);
      check(`*** THE FIX (CR 0b975d2a) *** boot${i}: P stays UNblocked (never the ancestor's own key)`, last.assertRepoNotQuarantined(p).ok === true);
      check(`boot${i}: X stays blocked by its own record`, last.assertRepoNotQuarantined(x).ok === false);
      check(`boot${i}: T itself is not blocked`, last.assertRepoNotQuarantined(t).ok === true);
    }
    // @decision 8db913e2 (Follow-up 8bff3cae, CR 0b975d2a round 2) — `clearMergeQuarantine` returns void;
    // asserting on a bare truthy/falsy read of it is VACUOUS (always passes, even if P WAS blocked).
    // `clearMergeQuarantineReporting` re-resolves P fresh, both before and after the clear, so its
    // `wasQuarantined` genuinely reflects whether P was blocked going into this call.
    const clearResult = last.clearMergeQuarantineReporting(p);
    check("*** THE FIX (legacy-tier-match) *** clearing P reports it was NEVER quarantined in the first place", clearResult.wasQuarantined === false);
    check("(no collateral) clearing P never lifts X's own, genuine quarantine", last.assertRepoNotQuarantined(x).ok === false);
    last.clearMergeQuarantine(x);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (realistic shape, SOURCE (a) ONLY — CR 0b975d2a round 2 correction) realistic-raise-source-a-retention
  // — a real `enterMergeQuarantine` raise on a plain subdir (self-stamping `resolvedKey` to the shared
  // ancestor key, the way a genuine unconfirmed-kill would), never a manufactured `.json` final. This
  // NEVER reaches source (b) at all: the migrating record's OWN self-stamped scalar is what keeps R
  // blocked (source (a), the Lead's own intentional/fail-closed retention — see the decision record's
  // "Repro 2" closing paragraph) — it stays green with the hash-equality check (source (b)) disabled
  // entirely, since nothing here ever reaches `hashToRepo.get(hash)` with a MISS worth guarding. This is
  // a REALISTIC-RECORD-SHAPE regression pin for (a), not a test of (b)'s own over-filter direction — the
  // hand-crafted `shared-ancestor-sibling-survives-divergence` scenario above is what actually exercises
  // (b) (its own stale file carries NO self-stamped scalar at all, so only (b) can retain anything).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("realistic-r");
    const a = path.join(r, "teamA");
    fs.mkdirSync(a, { recursive: true });
    reenterMergeQuarantinesAtBoot([r, a]);
    enterMergeQuarantine(a, "a-branch", "teamA real raise");
    execSync(`git init -q`, { cwd: a });

    let last;
    for (let i = 1; i <= 2; i++) {
      last = await rebootSim();
      last.reenterMergeQuarantinesAtBoot([r, a]);
      check(`*** THE FIX (source a, realistic raise) *** boot${i}: teamA (A) stays blocked`, last.assertRepoNotQuarantined(a).ok === false);
      check(`*** THE FIX (source a, realistic raise) *** boot${i}: R (the shared-ancestor sibling) stays blocked too — via A's OWN self-stamped scalar, never source (b)`, last.assertRepoNotQuarantined(r).ok === false);
    }
    last.clearMergeQuarantine(r);
    last.clearMergeQuarantine(a);
  }

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — PASS 1's own .json migrate branch folds forward every informative key it is "
      + "about to overwrite (an existing cross-repo dual-arm scalar, and a still-live sibling sharing its "
      + "OLD own key), surviving same-boot and reboot-sim, while the already-correct current-format path "
      + "stays unchanged; AND never arms a stale LEGACY-tier hashToRepo match whose freshly-recomputed key "
      + "no longer actually hashes to the migrating file's own stale filename (CR 0b975d2a); AND the "
      + "realistic end-to-end raise's own shared-ancestor retention is source (a) alone, never (b)."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 8bff3cae.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
