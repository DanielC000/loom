import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59f4ebe8, probe Q1 — the first fixture where `removeWriteFailed` (clearTokenFromPendingIndices's
// "remove" branch) is the SOLE guard against durably tombstoning a token whose final still holds it.
//
// d2592cd5's scenario P8 is triple-masked: `removeWriteFailed`, the decide-time physical re-scan, and the
// push-time `nonFailureOk` all withhold it. The last two share one blind spot: they exclude every basename
// `trackedBasenamesForIdentity` reports, and a same-identity, NON-placeholder pending entry (Q2) whose
// `sourceFile` IS the failed final's basename makes that final "tracked". Q2 is not a surviving shared
// claimant (`survivingSharedClaimRepoPaths` counts only placeholders / self-referencing entries), so the
// final's unlink is still attempted — and fails. Only `removeWriteFailed` is then left to withhold.
// The Q1 variant is the RED/GREEN discriminator (mutant: drop `removeWriteFailed`'s fold); the P8 variant
// (no Q2) stays safe under that same mutant and is kept as the contrast.
// Run: 1) pnpm build, 2) node test/merge-quarantine-59f4ebe8-remove-write-failed-sole-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq59f4-q-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mod = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly, listPendingMergeQuarantinesTestOnly, clearTokenFromPendingIndicesTestOnly, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;
fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function scenario(label, withQ2) {
  const w = mkdtempManaged(`loom-mq59f4q-${label}-`);
  fs.writeFileSync(path.join(w, "README.md"), "x\n");
  execFileSync("git", ["init", "-q"], { cwd: w });
  execFileSync("git", ["config", "user.email", "mq59f4@loom"], { cwd: w });
  execFileSync("git", ["config", "user.name", "mq59f4"], { cwd: w });
  commitAll(w, "init", "-c user.email=mq59f4@loom -c user.name=mq59f4");
  const Kw = canonicalRepoLockKey(w);
  const s = `tok-59f4ebe8-${label}-s`;
  // Q: the drifted ACTIVE occupant of Kw (P8's key-drift shape), so P's plan is "remove" with ownedArmedKeys=[Kw].
  setActiveQuarantineTestOnly(Kw, { repoPath: w, branch: "q-branch", reason: "Q (drifted occupant of Kw)", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] });
  const kwFinal = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kw).digest("hex").slice(0, 24)}.json`);
  fs.writeFileSync(kwFinal, JSON.stringify({ repoPath: w, branch: "q-branch", reason: "Q", tokens: [s], enteredAt: Date.now() }, null, 2) + "\n");
  const pSource = `pending-59f4ebe8-${label}-p.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "P (pending, names Kw)", enteredAt: Date.now(), tokens: [s], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntry, pSource);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSource), JSON.stringify({ repoPath: w, branch: "p-branch", reason: pEntry.reason, tokens: [s], enteredAt: pEntry.enteredAt }, null, 2) + "\n");
  if (withQ2) {
    // The degraded-divert shape: same identity, NON-placeholder, tokens disjoint from `s`, sourceFile == Kw's final.
    pushPendingQuarantineTestOnly({ repoPath: w, branch: "q2-branch", reason: "Q2 (non-placeholder pending claiming Kw's final)", enteredAt: Date.now(), tokens: [`tok-59f4ebe8-${label}-other`] }, path.basename(kwFinal));
  }
  const idx = listPendingMergeQuarantinesTestOnly().findIndex((p) => p.sourceFile === pSource);
  const real = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (p === kwFinal) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
    return real(p, ...rest);
  };
  try { clearTokenFromPendingIndicesTestOnly([idx], s); } finally { fs.unlinkSync = real; }
  check(`(${label}) precondition: P was found and Kw's final unlink was forced to fail`, idx !== -1 && hits === 1);
  check(`(${label}) precondition, by content: Kw's final still physically holds s`, fs.readFileSync(kwFinal, "utf8").includes(s));
  return { s };
}

const p8 = scenario("p8", false);
check("(p8) s is NOT durably tombstoned (triple-masked; contrast)", !tombstoned(p8.s));
const q1 = scenario("q1", true);
check("*** Q1 *** s is NOT durably tombstoned — removeWriteFailed alone withholds it (the blind scan cannot)", !tombstoned(q1.s));

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
