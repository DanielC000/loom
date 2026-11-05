import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c53790a5 (from card 3d4467cf's 2nd Code Review). Pins the `keptContentRepoPaths.size === 0`
// clause of `clearMergeQuarantineByKey`'s durable-tombstone gate, ISOLATED from its `!anyReferencing` and
// `!anyKeptUnattributed` siblings (Scenario M5 in merge-quarantine-d2592cd5-reboot-between-clears.mjs is
// gated by `anyReferencing` alone, so dropping only this clause leaves it green).
//
// Shape (a genuine CONTENT-KEPT orphan, not a referencing one): X's armed entry lists an orphan latch file
// that names a foreign repoPath P = <repoA>/link. P does not exist yet, so its directPathIdentity is its
// own resolved string (never X's), while its canonical lock key walks up to repoA's toplevel, which an
// unrelated armed entry A already occupies. The orphan's token set is not covered by the clear (it holds
// X's token plus a foreign one), so it is foreign; arming it reports "already-enforced" (A blocks P's key)
// and classification finds no entry of P's OWN identity -> contentKept, blockedBy A. Nothing is
// referencing, nothing unattributed: `keptContentRepoPaths.size > 0` is the ONLY thing withholding the
// durable tombstone of X's token.
//
// Observable (readers only): after the clear, P becomes a directory link to X. A tombstone of X's token
// (the mutant) is then subtracted from the orphan's record at the next boot (the record now resolves to
// X's identity), so the booted entry for P would have lost X's token; the real code leaves the token on
// the surviving file, so the booted entry still holds it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-c53790a5-content-kept-tombstone-gate.mjs
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-mqc53790a5-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mergeQuarantineModuleHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, clearMergeQuarantineByRecordedPath, MERGE_QUARANTINE_DIR } = mod;
const GIT_ID = "-c user.email=mqc53790a5@loom -c user.name=mqc53790a5";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeResolvableRepo(tag) {
  const repo = mkdtempManaged(`loom-mqc53790a5-${tag}-`); // registered for guaranteed cleanup at creation
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mqc53790a5@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mqc53790a5"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function readTokensOnDisk(basename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, basename), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : undefined;
  } catch { return undefined; }
}
const sameTokenSet = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((t) => b.includes(t));
let bootCounter = 0;
async function rebootSim() { bootCounter++; return await import(`${mergeQuarantineModuleHref}?bc53790a5=${bootCounter}`); }

// Undo steps for state the registry cannot sweep (the repoA->repoX junction, the orphan latch file in the
// quarantine dir), run LIFO in `finally` so a throwing assertion still removes the junction.
const undo = [];
try {
  const repoA = makeResolvableRepo("a");
  const repoX = makeResolvableRepo("x");
  const tA = enterMergeQuarantine(repoA, "loom/c53790a5-a", "c53790a5: A's own entry");
  const tX = enterMergeQuarantine(repoX, "loom/c53790a5-x", "c53790a5: X's entry");

  const xFinal = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [tX]));
  check("(precondition) found X's armed latch file holding tX alone", typeof xFinal === "string");
  const orphanBasename = `${randomBytes(12).toString("hex")}.json`;
  const xRec = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, xFinal), "utf8"));
  xRec.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, xFinal), JSON.stringify(xRec));

  const rb1 = await rebootSim();
  rb1.reenterMergeQuarantinesAtBoot([repoA, repoX]);
  // Written AFTER the first boot: a boot would otherwise read this file as an ordinary latch and arm it.
  const linkP = path.join(repoA, "link"); // does NOT exist yet
  const foreignToken = randomUUID();
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename), JSON.stringify({
    repoPath: linkP, branch: "loom/c53790a5-p", reason: "foreign content-kept orphan",
    enteredAt: Date.now(), tokens: [tX, foreignToken],
  }));
  undo.push(() => fs.rmSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename), { force: true }));

  check("(precondition) A reads blocked after boot", rb1.stillBlockedEntryFor(repoA)?.tokens.includes(tA) === true);
  check("(precondition) X reads blocked after boot", rb1.stillBlockedEntryFor(repoX)?.tokens.includes(tX) === true);

  const clear = rb1.clearMergeQuarantineByRecordedPath(repoX);
  check("(precondition) the clear reports a kept latch", !!clear.latchKept);
  check("(precondition) the clear names the orphan as CONTENT-kept at P", Array.isArray(clear.contentKeptRepoPaths) && clear.contentKeptRepoPaths.includes(linkP));
  check("(precondition) the clear reports NO referencing co-occupant (isolates the content-kept clause)", !(clear.stillBlockedCoOccupants?.length > 0));
  check("(precondition) the clear reports NO referencingRepoPaths (anyReferencing is false)", !(clear.referencingRepoPaths?.length > 0));
  check("(precondition) the clear reports NO unattributed kept latch (anyKeptUnattributed is false)", !clear.unattributed);
  check("(precondition) X reads fully unblocked right after the clear", rb1.stillBlockedEntryFor(repoX) === undefined);
  check("(precondition) A is untouched", rb1.stillBlockedEntryFor(repoA)?.tokens.includes(tA) === true);
  check("(precondition, by content) the orphan survives on disk holding tX", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename)) && (readTokensOnDisk(orphanBasename) ?? []).includes(tX));

  // P now resolves to X: a directory link (junction on Windows) inside A's tree pointing at X.
  fs.symlinkSync(repoX, linkP, "junction");
  undo.push(() => fs.rmSync(linkP, { force: true, recursive: false })); // remove the LINK, never recurse into repoX

  const rb2 = await rebootSim();
  rb2.reenterMergeQuarantinesAtBoot([repoA, repoX]);
  const booted = rb2.listActiveMergeQuarantines().filter((e) => e.tokens.includes(foreignToken));
  check("(post-reboot precondition) the surviving orphan was booted as an entry", booted.length >= 1);
  check("*** PINS the content-kept clause of clearMergeQuarantineByKey's tombstone gate *** after a reboot the surviving orphan's entry still holds tX (no durable tombstone was written for a content-kept clear)",
    booted.some((e) => e.tokens.includes(tX)));
  check("(post-reboot) X's repo reads blocked via the surviving orphan's content", rb2.stillBlockedEntryFor(repoX)?.tokens.includes(tX) === true);
} finally {
  for (const fn of undo.reverse()) { try { fn(); } catch (e) { console.error(`[cleanup] ${e.message}`); } }
}

console.log(failures === 0 ? "\n✅ ALL CHECKS PASS" : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
