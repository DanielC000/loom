import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 535fd69d — follow-up to 2dd97aaa item 2. clearMergeQuarantineByKey's own tied-twin "reduce"
// branch was fixed (2dd97aaa) to pass `droppedTokens` into writePendingDivertFile, so a stale
// keptUnreadableLatchFiles mark's own re-read-and-union can never resurrect a token that SAME write just
// dropped. 2dd97aaa's own "broader finding" named two MORE writers sharing the identical shape, reached
// via clearMergeQuarantineByToken instead of clearMergeQuarantine:
//
// SCENARIO 1 — clearTokenFromPendingIndices's own "reduce" branch (the by-token pending pre-pass
// clearMergeQuarantineByToken runs BEFORE it clears any matching active entry). Its own
// tombstoneIfNotSurviving([token]) call does NOT protect the later writePendingDivertFile call: at the
// moment this pre-pass runs, the active entry W (not yet cleared — that happens in clearMergeQuarantineByToken's
// own SECOND phase) still holds `token` in memory, so the tombstone scan finds it "surviving" and never
// adds it to the global clearedTokens set at all.
//
// SCENARIO 2 — clearActiveEntryTokenAtKey's own dual-tracked-twin loop (ae79d492). Unlike scenario 1, this
// function's OWN tombstoneIfNotSurviving call runs AFTER replaceEntryEverywhere has already flipped BOTH
// tiers (active and any true 883e29bc dual-tracked pending twin) to the narrowed `updated` object, so in
// the simple single-token case the token IS genuinely tombstoned before this loop's own write. To
// reproduce the SAME structural gap (an in-memory sibling still holding the literal token value, so
// tombstoneIfNotSurviving's own "is this surviving ANYWHERE" scan returns a false negative), this
// scenario injects a wholly unrelated, independent ACTIVE entry Q (via setActiveQuarantineTestOnly,
// inserted into activeQuarantines AFTER X — Map iteration visits X first) that also carries the literal
// token string — the fixture-level technique already used throughout this module's own test suite (see e.g.
// 2dd97aaa item 2 CR Minor 2's z2-token scenario) to isolate one write site's own vulnerability from
// whatever happens to tombstone a token in the common case.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-535fd69d-bytoken-stale-mark-union.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq535fd69d-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantineByToken, reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot,
  markLatchFileUnreadableTestOnly, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
  setActiveQuarantineTestOnly,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function parkWAt(key, repoPath, tag, tokens) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
}

function freshY(tag) {
  const y = path.join(os.tmpdir(), `loom-mq535fd69d-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  return y;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("535fd69d-s1-clearTokenFromPendingIndices") — clearMergeQuarantineByToken's own by-token
// pending pre-pass (clearTokenFromPendingIndices's "reduce" branch) writes the narrowed pending entry
// BEFORE phase 2 clears the still-live active entry W that also holds `token` — the tombstone this
// branch calls never actually tombstones, so a stale keptUnreadableLatchFiles mark on P's own sourceFile
// lets writePendingDivertFile's re-read-and-union resurrect `token` from P's unchanged on-disk copy.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s1");
  const k = canonicalRepoLockKey(y);
  const q = freshY("s1-q");
  const pSourceFile = "pending-535fd69d-s1-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);

  parkWAt(k, y, "535fd69d-s1-w1", ["wa-token", "wc-token"]);

  // P: injected PURELY in-memory via the test-only seam first (mirrors 2dd97aaa item 2's own `injectP`),
  // then its real backing file is written AFTER boot's own directory scan already ran — so it exists and
  // is genuinely readable at clear time, matching what writePendingDivertFile's re-read will find.
  const pEntryOnDisk = { repoPath: q, branch: "535fd69d-s1-p1-branch", reason: "535fd69d-s1-p1: NOT a twin of W, just shares a token", tokens: ["wa-token", "p-token"], enteredAt: Date.now() - 5_000 };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntryOnDisk, sourceFile: pSourceFile }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  fs.writeFileSync(pPath, JSON.stringify(pEntryOnDisk, null, 2) + "\n");

  check("(precondition) W active with both wa-token and wc-token", listActiveMergeQuarantines().some((e) => e.tokens.includes("wa-token") && e.tokens.includes("wc-token")));
  check("(precondition) P pending with wa-token and its own private p-token, NOT a twin of W", listActiveMergeQuarantines().some((e) => e.repoPath === q && e.tokens.includes("wa-token") && e.tokens.includes("p-token")));

  // The stale mark: outlived whatever earlier (unmodeled) read failure set it — the file is genuinely
  // readable, same identity, right now.
  markLatchFileUnreadableTestOnly(pSourceFile);

  clearMergeQuarantineByToken(y, "wa-token");

  const pAfter = listActiveMergeQuarantines().find((e) => e.repoPath === q);
  check("*** THE BUG (if reproduced) *** in-memory P is reduced to EXACTLY {p-token}, wa-token does NOT come back via the union", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["p-token"]));
  check("*** THE BUG (if reproduced) *** on-disk P's sourceFile holds EXACTLY {p-token}, not a resurrected {p-token,wa-token}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(pPath, "utf8")).tokens.sort()) === JSON.stringify(["p-token"]); } catch { return false; }
  })());
  check("W is correctly reduced to {wc-token} (wa-token gone)", listActiveMergeQuarantines().some((e) => e.repoPath === y && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["wc-token"])));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y, q]);
  check("*** REBOOT *** wa-token does NOT come back from P's own resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.repoPath === q && e.tokens.includes("wa-token")));
  check("*** REBOOT *** p-token survives", rb.listActiveMergeQuarantines().some((e) => e.repoPath === q && e.tokens.includes("p-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("535fd69d-s2-clearActiveEntryTokenAtKey-dual-twin") — clearActiveEntryTokenAtKey's own
// dual-tracked-twin loop (ae79d492). Unlike scenario 1, this function's own tombstoneIfNotSurviving call
// runs AFTER replaceEntryEverywhere has already flipped the active/pending tiers for the entry BEING
// cleared — so in the simple single-entity case the token IS genuinely tombstoned before this loop's own
// write runs, and the gap cannot be observed. To isolate the SAME structural gap this write site shares
// (never consulting droppedTokens, only the global clearedTokens the tombstone call populates), inject an
// UNRELATED active entry Q (via setActiveQuarantineTestOnly, inserted into activeQuarantines AFTER X is
// armed — Map iteration visits X first) that independently also holds the literal token value and has
// NOT been cleared yet by the time clearActiveEntryTokenAtKey(k2, X, token) runs — a fixture-level
// isolation technique already used throughout this module's own test suite (e.g. 2dd97aaa item 2's CR
// Minor 2 scenario) to test one write site without depending on whatever happens to tombstone the token
// via some OTHER call in the common case.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = freshY("s2-w");
  const x = path.join(w, "gone-subdir"); // NEVER created — the degraded walk-up occupant
  const v = freshY("s2-v"); // a SEPARATE real repo path — just for a stable, distinct K2
  const k2 = canonicalRepoLockKey(v);
  const q = freshY("s2-q");
  const kq = canonicalRepoLockKey(q);

  const legacyPath = path.join(MERGE_QUARANTINE_DIR, `!legacy-535fd69d-s2-${freshSfx()}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    repoPath: x, branch: "535fd69d-s2-x-branch", reason: "535fd69d-s2: X's REAL reason — legacy-named, dual-tracked",
    enteredAt: Date.now() - 60_000, tokens: ["dx-ta", "dx-tb"], resolvedKey: k2,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, v, x]);
  check("(precondition) X is active at K2, carrying BOTH tokens", listActiveMergeQuarantines().some((e) => e.repoPath === x && e.tokens.includes("dx-ta") && e.tokens.includes("dx-tb")));

  // Q: inserted into activeQuarantines AFTER X — Map iteration order visits X's own key first, so Q is
  // still "surviving" (unprocessed) at the exact instant clearActiveEntryTokenAtKey(k2, X, "dx-ta") calls
  // its own tombstoneIfNotSurviving(["dx-ta"]).
  setActiveQuarantineTestOnly(kq, { repoPath: q, branch: "535fd69d-s2-q-branch", reason: "535fd69d-s2-q: unrelated, defeats tombstoning until its own turn", tokens: ["dx-ta", "q-token"], enteredAt: Date.now() - 1_000 });
  check("(precondition) Q (unrelated) also holds dx-ta, armed after X", listActiveMergeQuarantines().some((e) => e.repoPath === q && e.tokens.includes("dx-ta") && e.tokens.includes("q-token")));
  const legacyBefore = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  check("(precondition) X's legacy sourceFile still holds BOTH tokens on disk", legacyBefore.tokens.includes("dx-ta") && legacyBefore.tokens.includes("dx-tb"));

  // The stale mark on X's own dual-tracked twin sourceFile — genuinely readable, same identity, right now.
  markLatchFileUnreadableTestOnly(path.basename(legacyPath));

  clearMergeQuarantineByToken(x, "dx-ta");

  check("*** THE BUG (if reproduced) *** X is correctly reduced to {dx-tb} in-memory", listActiveMergeQuarantines().some((e) => e.repoPath === x && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["dx-tb"])));
  check("*** THE BUG (if reproduced) *** X's own legacy sourceFile holds EXACTLY {dx-tb}, not a resurrected {dx-ta,dx-tb}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(legacyPath, "utf8")).tokens.sort()) === JSON.stringify(["dx-tb"]); } catch { return false; }
  })());
  check("Q is correctly reduced to {q-token} too (dx-ta cleared process-wide)", listActiveMergeQuarantines().some((e) => e.repoPath === q && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["q-token"])));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([w, v, x, q]);
  check("*** REBOOT *** dx-ta does NOT come back on X from the legacy twin's resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.repoPath === x && e.tokens.includes("dx-ta")));
  check("*** REBOOT *** dx-tb survives on X", rb.listActiveMergeQuarantines().some((e) => e.repoPath === x && e.tokens.includes("dx-tb")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a stale keptUnreadableLatchFiles mark can never let writePendingDivertFile's "
    + "re-read-and-union resurrect a token clearTokenFromPendingIndices's own by-token pending pre-pass or "
    + "clearActiveEntryTokenAtKey's own dual-tracked-twin loop just dropped, even when tombstoneIfNotSurviving's "
    + "own 'surviving anywhere' scan does not actually tombstone it."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 535fd69d.`);
process.exit(failures === 0 ? 0 : 1);
