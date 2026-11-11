import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5fa6069e -- a THIRD unverified raise over a boot-diverted TWIN (armed at Ks AND pending) plus an
// INDEPENDENT same-identity pending entry matches BOTH in `mergeTokenIntoPendingEntries`. The merged record
// is written to the earliest entry's file; pre-fix the absorbed entry's OWN file stayed on disk, so the next
// boot re-read it as a second overlapping object (`assertQuarantineIdentityInvariantTestOnly` ok:false).
//
//   pendingNewer: the twin (Ks.json) is older => it is the base; the absorbed pending-<hash>.json is UNOWNED
//                 => it must be unlinked (one durable record).
//   pendingOlder: the pending is older => it is the base; the absorbed file is the twin's OWN armed-key latch
//                 (Ks.json) => it is OWNED and must be KEPT (9cabd143); a stale subset that fails closed and
//                 re-unions at reboot (named, accepted residue -- see docs/decisions/5fa6069e-*.md).
//
// Controls: a kept-marked absorbed file, a foreign-identity occupant, an absorbed file holding a token the
// merge does not carry, and a failed durable write all KEEP the absorbed file.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-5fa6069e-third-raise-absorbed-file.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq5fa-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq5fa@loom -c user.name=mq5fa";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const sha24 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);

let importCounter = 0;
const freshModule = async () => import(`${mergeQuarantineModuleHref}?b=${++importCounter}`);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${sha24(identity)}.json`;
}

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq5fa-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq5fa@loom && git config user.name mq5fa`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

/** Boots the twin + independent-pending shape for a NONEXISTENT (unresolvable) D. */
async function setup(tag, order) {
  const mod = await freshModule();
  const { MERGE_QUARANTINE_DIR } = mod;
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const s = makeToplevelRepo(`${tag}-s`);
  const Ks = canonicalRepoLockKey(s);
  const d = path.join(os.tmpdir(), `loom-mq5fa-${tag}-d-nonexistent-${freshSfx()}`);
  const now = Date.now();
  const tTwin = order === "pendingOlder" ? now : now - 100000;
  const tPend = order === "pendingOlder" ? now - 100000 : now;
  const twinFile = `${sha24(Ks)}.json`;
  const pendFile = pendingDivertFilenameForTest(d);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twinFile), JSON.stringify({
    repoPath: d, branch: "twin", reason: `${tag} twin`, enteredAt: tTwin, tokens: ["tok-A"], resolvedKey: Ks,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendFile), JSON.stringify({
    repoPath: d, branch: "indep", reason: `${tag} independent pending`, enteredAt: tPend, tokens: ["tok-B"],
  }, null, 2) + "\n");
  mod.reenterMergeQuarantinesAtBoot([]);
  return { mod, MERGE_QUARANTINE_DIR, s, Ks, d, twinFile, pendFile };
}

const filesOnDisk = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

async function reboot() {
  const mod2 = await freshModule();
  mod2.reenterMergeQuarantinesAtBoot([]);
  return mod2;
}

function silenced(fn) {
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

try {
  // ── pendingNewer: the absorbed file is UNOWNED => exactly one durable record ─────────────────────
  {
    const ctx = await setup("newer", "pendingNewer");
    const { mod, MERGE_QUARANTINE_DIR: dir } = ctx;
    check("(newer precondition) boot armed the twin and kept two files", filesOnDisk(dir).length === 2);
    const newTok = silenced(() => mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    const files = filesOnDisk(dir);
    check("(newer) exactly ONE durable record after the third raise", files.length === 1 && files[0] === ctx.twinFile);
    const rec = readJson(dir, ctx.twinFile);
    check("(newer) the surviving record carries all three tokens", ["tok-A", "tok-B", newTok].every((t) => rec.tokens.includes(t)));
    const act = mod.activeMergeQuarantineFor(ctx.s);
    check("(newer) active object keeps armedKeys and resolvedKey", !!act && (act.armedKeys?.length ?? 0) >= 1 && act.resolvedKey === ctx.Ks);
    check("(newer) in-process invariant ok", mod.assertQuarantineIdentityInvariantTestOnly().ok);
    const mod2 = await reboot();
    const inv = mod2.assertQuarantineIdentityInvariantTestOnly();
    check(`(newer) REBOOT invariant ok (${inv.violations.join("; ")})`, inv.ok);
    const act2 = mod2.activeMergeQuarantineFor(ctx.s);
    check("(newer) after reboot: all tokens enforced, armedKeys/resolvedKey retained",
      !!act2 && ["tok-A", "tok-B", newTok].every((t) => act2.tokens.includes(t)) && (act2.armedKeys?.length ?? 0) >= 1 && act2.resolvedKey === ctx.Ks);
  }

  // ── pendingOlder: the absorbed file is the twin's OWN armed-key latch => OWNED => KEPT ───────────
  {
    const ctx = await setup("older", "pendingOlder");
    const { mod, MERGE_QUARANTINE_DIR: dir } = ctx;
    const twinBytesBefore = fs.readFileSync(path.join(dir, ctx.twinFile));
    const newTok = silenced(() => mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    const files = filesOnDisk(dir);
    check("(older) the owned armed-key file (twin) is KEPT", files.includes(ctx.twinFile));
    check("(older) the kept twin file's bytes are UNCHANGED (the stale tok-A subset, named accepted residue)",
      files.includes(ctx.twinFile) && fs.readFileSync(path.join(dir, ctx.twinFile)).equals(twinBytesBefore) && JSON.stringify(readJson(dir, ctx.twinFile).tokens) === JSON.stringify(["tok-A"]));
    check("(older) the merged record lives in the pending file", readJson(dir, ctx.pendFile).tokens.includes(newTok));
    const act = mod.activeMergeQuarantineFor(ctx.s);
    check("(older) active object keeps armedKeys and resolvedKey (the card's undefined claim does not reproduce)",
      !!act && (act.armedKeys?.length ?? 0) >= 1 && act.resolvedKey === ctx.Ks && act.tokens.includes(newTok));
    const mod2 = await reboot();
    const inv = mod2.assertQuarantineIdentityInvariantTestOnly();
    check(`(older) REBOOT invariant ok (${inv.violations.join("; ")})`, inv.ok);
    const act2 = mod2.activeMergeQuarantineFor(ctx.s);
    check("(older) after reboot: all tokens enforced, armedKeys/resolvedKey retained",
      !!act2 && ["tok-A", "tok-B", newTok].every((t) => act2.tokens.includes(t)) && (act2.armedKeys?.length ?? 0) >= 1 && act2.resolvedKey === ctx.Ks);
  }

  // ── controls: anything unprovable KEEPS the absorbed (pendingNewer's unowned) file ───────────────
  {
    const ctx = await setup("marked", "pendingNewer");
    ctx.mod.markLatchFileUnreadableTestOnly(ctx.pendFile);
    silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    check("(control: kept-marked absorbed file) retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }
  {
    const ctx = await setup("foreign", "pendingNewer");
    const other = path.join(os.tmpdir(), `loom-mq5fa-foreign-nonexistent-${freshSfx()}`);
    fs.writeFileSync(path.join(ctx.MERGE_QUARANTINE_DIR, ctx.pendFile), JSON.stringify({
      repoPath: other, branch: "x", reason: "foreign occupant", enteredAt: Date.now(), tokens: ["tok-B"],
    }, null, 2) + "\n");
    silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    const kept = filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile);
    check("(control: foreign-identity occupant) retained, bytes untouched", kept && readJson(ctx.MERGE_QUARANTINE_DIR, ctx.pendFile).repoPath === other);
  }
  {
    const ctx = await setup("uncovered", "pendingNewer");
    const rec = readJson(ctx.MERGE_QUARANTINE_DIR, ctx.pendFile);
    fs.writeFileSync(path.join(ctx.MERGE_QUARANTINE_DIR, ctx.pendFile), JSON.stringify({ ...rec, tokens: [...rec.tokens, "tok-extra-on-disk-only"] }, null, 2) + "\n");
    silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    check("(control: on-disk token the merge does not carry) retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }
  {
    const ctx = await setup("writefail", "pendingNewer");
    const target = path.join(ctx.MERGE_QUARANTINE_DIR, ctx.twinFile);
    const realRename = fs.renameSync;
    // Fail the durable write of the merged record onto its base file (Ks.json): the write goes through a rename.
    fs.renameSync = (from, to, ...rest) => {
      if (typeof to === "string" && to === target) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      return realRename(from, to, ...rest);
    };
    const errors = [];
    const realErr = console.error;
    console.error = (...a) => { errors.push(a.join(" ")); };
    const realLog = console.log; const realWarn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"); } finally { fs.renameSync = realRename; console.error = realErr; console.log = realLog; console.warn = realWarn; }
    check("(control: failed durable write) the write-failure branch actually ran", errors.some((e) => e.includes("durable pending-divert latch ALSO failed")));
    check("(control: failed durable write) the absorbed file is retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }

  // Reads of `absorbedPath` made AFTER the merged record (>= 3 tokens) has been durably written to the twin file
  // are the sweep's own; `replace(mergedRecord)` returns what that read should see, or throws.
  const interceptSweepRead = (ctx, replace) => {
    const absorbedPath = path.join(ctx.MERGE_QUARANTINE_DIR, ctx.pendFile);
    const twinPath = path.join(ctx.MERGE_QUARANTINE_DIR, ctx.twinFile);
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (typeof p === "string" && p === absorbedPath) {
        let merged; try { merged = JSON.parse(realRead(twinPath, "utf8")); } catch { merged = undefined; }
        if (merged && Array.isArray(merged.tokens) && merged.tokens.length >= 3) return replace(merged);
      }
      return realRead(p, ...rest);
    };
    return () => { fs.readFileSync = realRead; };
  };
  {
    // (63e49ee2) a NON-ENOENT read failure of the absorbed file proves nothing about its content: keep it.
    const ctx = await setup("readfail", "pendingNewer");
    const restore = interceptSweepRead(ctx, () => { throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); });
    try { silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise")); } finally { restore(); }
    check("(control: non-ENOENT read failure) the absorbed file is retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }
  {
    // Only the merged record can hold the FRESH raise's token: an absorbed file reading as carrying it is kept.
    const ctx = await setup("freshtok", "pendingNewer");
    const restore = interceptSweepRead(ctx, (merged) => JSON.stringify({ repoPath: ctx.d, branch: "x", reason: "carries the fresh token", enteredAt: Date.now(), tokens: ["tok-B", merged.tokens.find((t) => t !== "tok-A" && t !== "tok-B")] }));
    try { silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise")); } finally { restore(); }
    check("(control: absorbed file carrying the fresh raise's token) retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }
  {
    // An absorbed name that is a DIFFERENT surviving pending entry's own sourceFile is owned by it: keep.
    const ctx = await setup("sharedname", "pendingNewer");
    ctx.mod.pushPendingQuarantineTestOnly({
      repoPath: path.join(os.tmpdir(), `loom-mq5fa-other-nonexistent-${freshSfx()}`), branch: "o", reason: "different surviving pending entry",
      enteredAt: Date.now(), tokens: ["tok-other"],
    }, ctx.pendFile);
    silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    check("(control: absorbed name owned by a different surviving pending entry) retained", filesOnDisk(ctx.MERGE_QUARANTINE_DIR).includes(ctx.pendFile));
  }
  if (process.platform === "win32") {
    // win32 filenames are case-insensitive: an absorbed entry whose sourceFile is a case-variant of the merged
    // record's own file IS that file; sweeping it would delete the merged record.
    const ctx = await setup("casevariant", "pendingNewer");
    const base = path.join(ctx.MERGE_QUARANTINE_DIR, ctx.twinFile);
    const rec = readJson(ctx.MERGE_QUARANTINE_DIR, ctx.twinFile);
    const variant = ctx.twinFile.toUpperCase().replace(".JSON", ".json");
    ctx.mod.pushPendingQuarantineTestOnly({ ...rec, enteredAt: rec.enteredAt + 1, tokens: ["tok-A"] }, variant);
    const newTok = silenced(() => ctx.mod.enterMergeQuarantine(ctx.d, "c", "third raise"));
    check("(control: win32 case-variant of the merged record's own file) the merged record survives", fs.existsSync(base) && readJson(ctx.MERGE_QUARANTINE_DIR, ctx.twinFile).tokens.includes(newTok));
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
