import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 495fd320, from Code Review 9d6dc6b8 of card 29fe2372 — a merge-quarantine latch (or
// orphan-reference) file whose content is the bare JSON literal `null` makes
// quarantineFileRepoPathIdentity/orphanFileTokensAccountedForByUpdate (git/merge-quarantine.ts) throw a
// TypeError reading `.repoPath`/`.tokens` off `null` — both doc themselves as "never throws"/fail-closed.
// `JSON.parse("null")` succeeds and returns `null`; every parse site in this module already guards the
// PARSE call itself, but nothing guarded the very next property read.
//
// The throw surfaces from inside `rewriteOrphanLatchFilesAfterPartialClear`, called from BOTH
// `clearActiveEntryTokenAtKey` and `clearTokenFromPendingIndices`, both reached from
// `clearMergeQuarantineByToken` — and `clearMergeQuarantineByToken` is itself invoked from
// `onTreeDeathSettled` callbacks inside `git/bounded.ts`'s `void (async () => {...})()` IIFEs, where an
// uncaught throw becomes an unhandled rejection and the bounded git promise never settles at all
// (git/bounded.test fixes the OTHER half of that; this file covers the merge-quarantine.ts half).
//
// THE FIX: both helpers (plus every other post-JSON.parse property read in this module) now route
// through a shared `isReadableLatchRecord` guard that rejects any non-object parse result — `null`
// (the only one that actually THROWS on property access) plus, incidentally, a bare scalar
// (number/string/boolean, which was already safe to property-access, never a throw risk) — treating
// either exactly like corrupt/unparsable JSON: fail-closed, never throw. The scalar rejection is a REAL,
// separate behavior change (not just a byproduct of the null-crash fix) at exactly two sites that read
// on-disk tokens with no OTHER check ahead of it (`markedFinalFullyCoveredByClear`,
// `orphanFileTokensAccountedForByUpdate` — see each one's own `@decision 8db913e2 (Follow-up 495fd320)` doc note): a bare
// scalar there used to be read as vacuously covered/accounted-for (fail-OPEN, via an empty token array's
// own `.every(...)`) and is now "cannot prove this" (fail-CLOSED) — strictly safer, not a regression.
// Every OTHER guarded site already had its own `typeof parsed.repoPath === "string"` check ahead of any
// token read, which a scalar already failed identically before this guard existed, so those sites see no
// behavior change at all. An array or `{}` passes this guard unchanged everywhere, pre- and post-fix —
// this file's own repro and control both use plain objects throughout and exercise none of this; see
// merge-quarantine.ts's own `isReadableLatchRecord` doc for the full reasoning, not restated here.
//
// REPRO: R raises t1, t2 (one entry, two outstanding tokens). R's own final latch file is hand-edited to
// fold in TWO orphan references: oNull (poisoned with the bare literal `null`, AFTER the fresh boot — a
// boot-time read of R's own FINAL never touches an orphan reference's own content at all) and oValid (a
// genuinely foldable sibling of R's own — same identity, tokens a subset of R's own). A PARTIAL clear of
// t2 (t1 remains outstanding) must:
//   1. NOT throw.
//   2. Leave the quarantine fail-closed — R is still actively quarantined by t1.
//   3. Still durably reduce oValid's own on-disk tokens to [t1] — proving oNull's own poison never
//      aborts the rest of the orphan-rewrite loop (oNull is listed FIRST, so a pre-fix throw there is
//      exactly what would have blocked oValid from ever being reached).
//   4. Leave oNull itself untouched (ownership can never be positively confirmed for unreadable content).
//
// See docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md, Follow-up 495fd320.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-null-latch-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqnlg-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqnlg@loom -c user.name=mqnlg";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqnlg-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-null-latch-guard (${tag})\n`);
  execSync(`git init -q && git config user.email mqnlg@loom && git config user.name mqnlg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE REPRO — card 495fd320.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("repro");
  const t1 = enterMergeQuarantine(r, "r-branch", "r raises itself (t1)");
  const t2 = enterMergeQuarantine(r, "r-branch", "r raises itself again (t2)");
  check("(repro precondition) R carries both tokens before any clear", new Set([t1, t2]).size === 2);

  const finalHash = quarantineLatchIdFor(r);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${finalHash}.json`);
  const sfx = freshSfx();
  const oNullName = `495fd320-onull-${sfx}.json`;
  const oValidName = `495fd320-ovalid-${sfx}.json`;
  const oNullPath = path.join(MERGE_QUARANTINE_DIR, oNullName);
  const oValidPath = path.join(MERGE_QUARANTINE_DIR, oValidName);

  // Hand-edit the final to fold in both orphan references — oNull FIRST, so a pre-fix throw there is
  // exactly what blocks oValid from ever being reached.
  const finalBefore = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  fs.writeFileSync(finalPath, JSON.stringify({ ...finalBefore, orphanLatchFiles: [oNullName, oValidName] }, null, 2) + "\n");

  // Fresh boot — PASS 1 re-reads R's own final (now carrying both orphan references) cleanly. Neither
  // orphan file exists on disk yet at this point, so PASS 1's own directory scan (which treats every
  // EXISTING `*.json` file as an independent latch candidate to migrate/arm) never sees either one —
  // both are created only AFTER the boot, below, exactly like the card's own repro sequence.
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([r]);

  // ONLY AFTER the boot: poison oNull with the bare JSON literal `null` — valid JSON, so PASS 1's own
  // fail-closed corrupt-latch handling (which only ever reads a FINAL's own content, never an orphan
  // reference's) never gets a chance to see it either way. oValid is a genuinely foldable sibling of
  // R's own (same identity, tokens a subset of R's own) — created post-boot for the same reason.
  fs.writeFileSync(oNullPath, "null");
  fs.writeFileSync(oValidPath, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "a genuinely foldable sibling orphan of R's own",
    enteredAt: Date.now(), tokens: [t1, t2],
  }, null, 2) + "\n");

  let threw = null;
  try {
    fresh.clearMergeQuarantineByToken(r, t2);
  } catch (e) {
    threw = e;
  }
  check("*** THE FIX *** clearMergeQuarantineByToken does not throw on a null-content orphan latch file", threw === null);
  if (threw) console.log(`  (threw: ${(threw && threw.message) || threw})`);

  const afterClear = fresh.activeMergeQuarantineFor(r);
  check("(repro) the quarantine stays fail-closed — t1 is still outstanding after the partial clear", (afterClear?.tokens ?? []).includes(t1));
  check("(repro) t2 itself is gone from the surviving entry", !(afterClear?.tokens ?? []).includes(t2));

  check("(repro) oNull's own content is left untouched (ownership could never be positively confirmed)", fs.readFileSync(oNullPath, "utf8") === "null");

  const oValidAfter = JSON.parse(fs.readFileSync(oValidPath, "utf8"));
  check(
    "*** THE FIX *** oValid — a DIFFERENT orphan reference on the SAME record — still gets durably rewritten to the reduced token set, proving oNull's own poison never aborts the rest of the loop",
    Array.isArray(oValidAfter.tokens) && oValidAfter.tokens.includes(t1) && !oValidAfter.tokens.includes(t2),
  );
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // NEGATIVE CONTROL — the SAME fixture shape, but oNull holds genuinely CORRUPT (unparsable) JSON
  // instead of the valid-but-null literal. This is the pre-existing, already-fail-closed case
  // (JSON.parse itself throws and is already caught) — must behave identically to the repro above,
  // proving the new guard doesn't change behavior for the case that already worked.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  // Isolate from scenario 1's own leftover (deliberately untouched, fail-closed) orphan residue — a
  // stale latch file from a DIFFERENT, unrelated repo sitting in the same directory is not this
  // scenario's concern, and a shared MERGE_QUARANTINE_DIR would otherwise fold it into this scenario's
  // own fresh boot as an unrelated orphan reference.
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  const r = makeToplevelRepo("control");
  const t1 = enterMergeQuarantine(r, "r-branch", "r raises itself (t1)");
  const t2 = enterMergeQuarantine(r, "r-branch", "r raises itself again (t2)");

  const finalHash = quarantineLatchIdFor(r);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${finalHash}.json`);
  const oCorruptName = `495fd320-ocorrupt-${freshSfx()}.json`;
  const oCorruptPath = path.join(MERGE_QUARANTINE_DIR, oCorruptName);

  const finalBefore = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  fs.writeFileSync(finalPath, JSON.stringify({ ...finalBefore, orphanLatchFiles: [oCorruptName] }, null, 2) + "\n");

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([r]);

  fs.writeFileSync(oCorruptPath, "{ not valid json at all");

  let threw = null;
  try {
    fresh.clearMergeQuarantineByToken(r, t2);
  } catch (e) {
    threw = e;
  }
  check("(control) genuinely corrupt (unparsable) orphan content already did not throw, pre- or post-fix", threw === null);

  const afterClear = fresh.activeMergeQuarantineFor(r);
  check("(control) the quarantine stays fail-closed — t1 is still outstanding", (afterClear?.tokens ?? []).includes(t1));
  check("(control) oCorrupt's own content is left untouched", fs.readFileSync(oCorruptPath, "utf8") === "{ not valid json at all");
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
