import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 0bc6305a — pins the clear-side empty-array-to-undefined normalization; never revert it to
// the old per-field `[]`-on-empty shape without re-reading the consumer census in the decision record.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-0bc6305a-clear-side-empty-array-normalization.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq0bc6305a-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { reconcileClearedEntryIfPlaceholderTestOnly, PLACEHOLDER_BRANCH_UNREADABLE } =
  await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const FIXED_ENTERED_AT = 1700000000000;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mq0bc6305a-"));

function writeDiskRecord(fields) {
  const p = path.join(tmpDir, `disk-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(fields, null, 2) + "\n");
  return p;
}

try {
  const repoPath = path.join(tmpDir, "fake-repo"); // never resolved — directPathIdentity falls back to path.resolve for a non-existent path, consistently, for both sides

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — both sides EMPTY/absent: the shared helper must return `undefined`, never `[]`.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const diskPath = writeDiskRecord({
      repoPath, branch: "real-branch", reason: "real-reason", enteredAt: FIXED_ENTERED_AT, tokens: ["tok-fixed"],
      // no orphanLatchFiles/contributorRepoPaths at all — reingested side is `undefined` for both.
    });
    const entry = {
      repoPath, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "placeholder", enteredAt: FIXED_ENTERED_AT,
      tokens: ["tok-fixed"], placeholder: true,
      orphanLatchFiles: [], contributorRepoPaths: [], // DEFINED EMPTY arrays — the exact shape boot produces
    };
    const result = reconcileClearedEntryIfPlaceholderTestOnly(entry, diskPath);
    check("*** THE FIX (0bc6305a) *** orphanLatchFiles collapses to undefined, never a defined []", result.orphanLatchFiles === undefined);
    check("*** THE FIX (0bc6305a) *** contributorRepoPaths collapses to undefined, never a defined []", result.contributorRepoPaths === undefined);
    check("(sanity) the reconcile genuinely ran (no longer placeholder-shaped)", result.placeholder !== true);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 (negative control) — a GENUINELY non-empty union must still survive as a real array,
  // proving SCENARIO 1's `undefined` isn't just this function always returning `undefined`.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const diskPath = writeDiskRecord({
      repoPath, branch: "real-branch-2", reason: "real-reason-2", enteredAt: FIXED_ENTERED_AT, tokens: ["tok-fixed-2"],
      orphanLatchFiles: ["residue-from-disk.json"],
    });
    const entry = {
      repoPath, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "placeholder", enteredAt: FIXED_ENTERED_AT,
      tokens: ["tok-fixed-2"], placeholder: true,
      orphanLatchFiles: ["residue-in-memory.json"], contributorRepoPaths: ["/some/other/repo-0bc6305a"],
    };
    const result = reconcileClearedEntryIfPlaceholderTestOnly(entry, diskPath);
    check("(negative control) orphanLatchFiles is a real, non-empty, BOTH-SIDES-unioned array", (result.orphanLatchFiles ?? []).length === 2
      && (result.orphanLatchFiles ?? []).includes("residue-from-disk.json") && (result.orphanLatchFiles ?? []).includes("residue-in-memory.json"));
    check("(negative control) contributorRepoPaths carries the in-memory-only fold forward (disk never had it)", (result.contributorRepoPaths ?? []).includes("/some/other/repo-0bc6305a"));
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — mixed: entry's own field is a defined-empty `[]`, disk carries real content. The
  // union must still surface disk's content (an empty array on one side must never short-circuit the
  // union itself — only the FINAL, post-union emptiness decides undefined-vs-array).
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const diskPath = writeDiskRecord({
      repoPath, branch: "real-branch-3", reason: "real-reason-3", enteredAt: FIXED_ENTERED_AT, tokens: ["tok-fixed-3"],
      contributorRepoPaths: ["/some/foreign/repo-scenario3"],
    });
    const entry = {
      repoPath, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "placeholder", enteredAt: FIXED_ENTERED_AT,
      tokens: ["tok-fixed-3"], placeholder: true,
      orphanLatchFiles: [], contributorRepoPaths: [],
    };
    const result = reconcileClearedEntryIfPlaceholderTestOnly(entry, diskPath);
    check("(mixed) an in-memory defined-empty [] never short-circuits the union away from disk's own content", (result.contributorRepoPaths ?? []).includes("/some/foreign/repo-scenario3"));
    check("(mixed) orphanLatchFiles still correctly collapses to undefined (both sides genuinely empty)", result.orphanLatchFiles === undefined);
  }

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — card 0bc6305a's shared helper normalizes an empty orphanLatchFiles/contributorRepoPaths union to undefined (never a defined []), for the clear-side twin, pinned going forward."
    : `\n❌ ${failures} CHECK(S) FAILED.`);
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

process.exit(failures === 0 ? 0 : 1);
