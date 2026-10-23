import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 9c681680 (triage note, gen 436, Code Reviewer 0d6d8001's review of b47cf261) —
// clearMergeQuarantineByKey's own tied-twin "reduce" branch called
// rewriteOrphanLatchFilesAfterPartialClear(updated, …) on its own writePendingDivertFile success — the
// STALE, pre-union `updated` local variable — while its sibling clearTokenFromPendingIndices passes
// `written.entry` (the ACTUAL write target) at its own equivalent call. After card b47cf261, memory holds
// `writtenTwin.entry`, not `updated` — so an orphan file reachable ONLY through writtenTwin.entry's own
// disk-unioned `orphanLatchFiles` (never present on `updated`, which is computed before any union) is
// never narrowed by this sweep, and keeps the just-dropped overlap token on disk. Tombstones are
// in-memory only, so after a restart a cleared token can re-arm from that stale orphan file (a DELAYED
// lift, never a false lift).
//
// Construction (mirrors merge-quarantine-2dd97aaa-item2-reduce-stale-mark-union.mjs's own "stale mark"
// technique): P (the tied pending twin) is injected PURELY in-memory with NO orphanLatchFiles field at
// all; P's own on-disk backing file is marked keptUnreadableLatchFiles (an outlived read-failure mark)
// and carries an EXTRA orphanLatchFiles:[F] reference that memory never had — writePendingDivertFile's
// own re-read-and-union branch folds F into writtenTwin.entry.orphanLatchFiles, which `updated` (the
// stale pre-union variable) never carries. F is a genuinely-owned, separate pending record (same
// identity), still holding the overlap token on disk.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-9c681680-reduce-branch-orphan-rewrite-target.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq9c681680-orph-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantine, reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot,
  markLatchFileUnreadableTestOnly, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
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
  const y = path.join(os.tmpdir(), `loom-mq9c681680-orph-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  return y;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("9c681680-reduce-branch-orphan-rewrite-target") — see header above.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s1");
  const k = canonicalRepoLockKey(y);
  const pSourceFile = "pending-9c681680-orph-s1-p-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);
  const orphanFile = "pending-9c681680-orph-s1-f-test.json";
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  parkWAt(k, y, "9c681680-orph-w1", ["s-token"]);

  // P, in-memory: tied to W via armedKeys overlap on k, holds {s-token, v-token} — NO orphanLatchFiles.
  const pEntryInMemory = { repoPath: y, branch: "9c681680-orph-p1-branch", reason: "9c681680-orph-p1: tied twin, no orphanLatchFiles in memory", tokens: ["s-token", "v-token"], armedKeys: [k], enteredAt: Date.now() - 5_000 };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntryInMemory, sourceFile: pSourceFile }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // P's own on-disk file, written AFTER boot settles (genuinely readable at clear time): SAME tokens, but
  // ALSO carries orphanLatchFiles:[F] — the extra reference memory never had.
  const pEntryOnDisk = { ...pEntryInMemory, orphanLatchFiles: [orphanFile] };
  fs.writeFileSync(pPath, JSON.stringify(pEntryOnDisk, null, 2) + "\n");

  // F: a genuinely-owned, separate pending record for the SAME identity y, still holding the overlap
  // token (s-token) on disk — exactly what a partial clear is supposed to narrow.
  fs.writeFileSync(orphanPath, JSON.stringify({
    repoPath: y, branch: "9c681680-orph-f-branch", reason: "9c681680-orph-f: folded orphan latch, still holds s-token", tokens: ["s-token"], enteredAt: Date.now() - 15_000,
  }, null, 2) + "\n");

  check("(precondition) W active with s-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s-token"));
  check("(precondition) P pending with s-token+v-token, armedKeys includes K, NO orphanLatchFiles in memory", listActiveMergeQuarantines().some((e) => e.tokens.includes("s-token") && e.tokens.includes("v-token") && e.armedKeys?.includes(k) && !(e.orphanLatchFiles ?? []).length));

  // The stale mark: outlived whatever earlier (unmodeled) read failure set it — P's own file is
  // genuinely readable, same identity, right now — the precondition writePendingDivertFile's own
  // re-read-and-union branch exists for.
  markLatchFileUnreadableTestOnly(pSourceFile);

  clearMergeQuarantine(y); // by-key route — reaches clearMergeQuarantineByKey's own reduce branch directly

  check("W is fully lifted (s-token gone from every surviving active entry)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s-token")));
  const fOnDiskAfter = (() => { try { return JSON.parse(fs.readFileSync(orphanPath, "utf8")); } catch { return null; } })();
  check("*** THE FIX *** F's own on-disk tokens no longer carry s-token (the sweep reached it via writtenTwin.entry's own disk-unioned orphanLatchFiles, never the stale pre-union `updated`)",
    !!fOnDiskAfter && !(fOnDiskAfter.tokens ?? []).includes("s-token"));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** s-token does NOT re-arm from F's own (now-narrowed) on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s-token")));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearMergeQuarantineByKey's reduce branch rewrites a folded orphan latch via "
    + "whatever writePendingDivertFile ACTUALLY wrote (writtenTwin.entry), never the stale pre-union "
    + "`updated` — an orphan file only the written twin's own disk-unioned orphanLatchFiles names is "
    + "correctly narrowed, not silently left stale."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 9c681680's triage-note finding.`);
process.exit(failures === 0 ? 0 : 1);
