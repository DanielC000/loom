import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 2dd97aaa item 2 — clearMergeQuarantineByKey's own tied-twin "reduce" branch writes the
// narrowed `updated` entry (overlapTokens dropped) via writePendingDivertFile BEFORE this function's own
// single, deferred tombstone call. If the pending twin's own `sourceFile` is marked
// keptUnreadableLatchFiles (a stale mark outliving an earlier resolved read failure — 702b4241 round 7's
// own re-read-and-union branch exists for exactly this), writePendingDivertFile re-reads the file fresh
// and, finding it readable again under the SAME identity, unions its ON-DISK tokens into the write —
// which still include the just-lifted overlapTokens, since nothing has rewritten that file yet. The
// written entry (and the in-memory `p.entry` writePendingDivertFile hands back) ends up holding the
// overlap token AGAIN, even though this same clear just dropped it specifically because the active entry
// at `key` already covers it and is being fully lifted — silently re-arming a token this clear believed
// it was releasing.
//
// Uses markLatchFileUnreadableTestOnly (added for this card) to construct the "mark outlived the failure"
// precondition directly, since a genuine, portable, non-ENOENT OS-level read failure is not reproducible
// across this test's own matrix (Windows has no POSIX chmod).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-2dd97aaa-item2-reduce-stale-mark-union.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq2dd97aaa-i2-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantine, reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot,
  markLatchFileUnreadableTestOnly, listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
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
  const y = path.join(os.tmpdir(), `loom-mq2dd97aaa-i2-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  return y;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("2dd97aaa-item2-stale-mark-union-resurrects-overlap-token") — the reduce branch's own
// writePendingDivertFile call hits a STALE keptUnreadableLatchFiles mark on P's own sourceFile, which is
// genuinely readable (same identity) by the time this clear runs. The union must never bring the
// just-dropped overlap token back.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s1");
  const k = canonicalRepoLockKey(y);
  const pSourceFile = "pending-2dd97aaa-i2-s1-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);

  parkWAt(k, y, "2dd97aaa-i2-w1", ["s1-token"]);

  // P: injected PURELY in-memory via the test-only seam first (mirrors 64119847's own `injectP` — no
  // real file on disk yet, so boot's own directory scan never independently discovers/migrates it).
  const pEntryOnDisk = { repoPath: y, branch: "2dd97aaa-i2-p1-branch", reason: "2dd97aaa-i2-p1: tied twin", tokens: ["s1-token", "v1-token"], enteredAt: Date.now() - 5_000 };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: { ...pEntryOnDisk, armedKeys: [k] }, sourceFile: pSourceFile }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // NOW write P's own real backing file, AFTER boot's own directory scan already ran (mirrors the
  // dual-tracked-twin pattern's own "F" file, written after boot settles) — so it exists and is
  // genuinely readable at clear time, matching what writePendingDivertFile's re-read will find.
  fs.writeFileSync(pPath, JSON.stringify(pEntryOnDisk, null, 2) + "\n");

  check("(precondition) W active with s1-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s1-token"));
  check("(precondition) P pending with both tokens, armedKeys includes K", listActiveMergeQuarantines().some((e) => e.tokens.includes("s1-token") && e.tokens.includes("v1-token") && e.armedKeys?.includes(k)));

  // The stale mark: outlived whatever earlier (unmodeled) read failure set it — the file is genuinely
  // readable, same identity, right now.
  markLatchFileUnreadableTestOnly(pSourceFile);

  clearMergeQuarantine(y); // by-key route — ONE call, never passes through clearTokenFromPendingIndices's own by-token pending pre-pass

  const pAfter = listActiveMergeQuarantines().find((e) => e.armedKeys?.includes(k) || e.tokens.includes("v1-token"));
  check("*** THE BUG (if reproduced) *** in-memory P is reduced to EXACTLY {v1-token}, s1-token does NOT come back via the union", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v1-token"]));
  check("*** THE BUG (if reproduced) *** on-disk P's sourceFile holds EXACTLY {v1-token}, not a resurrected {s1-token,v1-token}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(pPath, "utf8")).tokens.sort()) === JSON.stringify(["v1-token"]); } catch { return false; }
  })());
  check("W is fully lifted (s1-token gone)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s1-token")));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** s1-token does NOT come back from P's own resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s1-token")));
  check("*** REBOOT *** v1-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v1-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("2dd97aaa-item2-stale-mark-union-resurrects-non-overlap-entry-token", CR Minor 2) — the
// active entry W being fully lifted carries TWO tokens (s2-token, z2-token). The tied pending twin P's
// own IN-MEMORY tokens only overlap W on s2-token (z2-token was already dropped from P's memory by an
// earlier, unmodeled reduce whose durable write never landed) — but P's STALE on-disk copy still holds
// z2-token too. `overlapTokens` alone (the reduce branch's own in-memory intersection) would compute
// {s2-token} and never filter z2-token out of the union, resurrecting it. `droppedTokens` must be the
// FULL active entry's token set ({s2-token, z2-token}), not just the narrower in-memory overlap.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s2");
  const k = canonicalRepoLockKey(y);
  const pSourceFile = "pending-2dd97aaa-i2-s2-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);

  parkWAt(k, y, "2dd97aaa-i2-s2-w1", ["s2-token", "z2-token"]);

  // P in-memory: only s2-token overlaps W; z2-token already gone from memory.
  const pEntryInMemory = { repoPath: y, branch: "2dd97aaa-i2-s2-p1-branch", reason: "2dd97aaa-i2-s2-p1: tied twin", tokens: ["s2-token", "v2-token"], enteredAt: Date.now() - 5_000 };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: { ...pEntryInMemory, armedKeys: [k] }, sourceFile: pSourceFile }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // P's own on-disk file is STALE relative to memory: still carries z2-token (the earlier reduce that
  // dropped it from memory never durably persisted) alongside s2-token and v2-token.
  const pEntryOnDisk = { ...pEntryInMemory, tokens: ["s2-token", "v2-token", "z2-token"] };
  fs.writeFileSync(pPath, JSON.stringify(pEntryOnDisk, null, 2) + "\n");

  check("(precondition) W active with both s2-token and z2-token", listActiveMergeQuarantines().some((e) => e.tokens.includes("s2-token") && e.tokens.includes("z2-token")));
  check("(precondition) P pending in-memory overlaps W on s2-token only (not z2-token)", listActiveMergeQuarantines().some((e) => e.tokens.includes("s2-token") && e.tokens.includes("v2-token") && !e.tokens.includes("z2-token") && e.armedKeys?.includes(k)));

  markLatchFileUnreadableTestOnly(pSourceFile);

  clearMergeQuarantine(y); // by-key route

  const pAfter = listActiveMergeQuarantines().find((e) => e.armedKeys?.includes(k) || e.tokens.includes("v2-token"));
  check("*** THE BUG (if reproduced) *** in-memory P is reduced to EXACTLY {v2-token} — z2-token (from the stale on-disk copy) does NOT resurrect", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v2-token"]));
  check("*** THE BUG (if reproduced) *** on-disk P's sourceFile holds EXACTLY {v2-token}, never a resurrected {s2-token,v2-token,z2-token} or {v2-token,z2-token}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(pPath, "utf8")).tokens.sort()) === JSON.stringify(["v2-token"]); } catch { return false; }
  })());
  check("W is fully lifted (both s2-token and z2-token gone)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s2-token") || e.tokens.includes("z2-token")));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** neither s2-token nor z2-token come back from P's own resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s2-token") || e.tokens.includes("z2-token")));
  check("*** REBOOT *** v2-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v2-token")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a stale keptUnreadableLatchFiles mark on a tied pending twin's own sourceFile "
    + "never lets writePendingDivertFile's re-read-and-union resurrect an overlap token this clear just dropped, "
    + "nor any OTHER token of the entry being fully lifted that the twin's stale on-disk copy still carries."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 2dd97aaa item 2.`);
process.exit(failures === 0 ? 0 : 1);
