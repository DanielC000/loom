// Card 35dff468: `checkVaultRepoTripleContainment` (card 5ba4412d/f45821a2) refuses a network/device-form
// vaultPath (UNC, a DOS device path `\\.\...`, or the NT native namespace prefix `\??\...`) at every
// create/update WRITE site — but that check runs only on create/update, never again later. `commitVault`
// (the actual git-init/commit chokepoint `vault/writer.ts`'s writeVaultFile/createVaultFile/deleteVaultFile
// call DIRECTLY with a project's raw, stored vaultPath — no containment re-check, no versioner in between)
// had no check of its own for this family before this card — only `isOperationalVaultDir`. See
// docs/decisions/35dff468-vault-boot-and-commit-refuse-device-form-vaultpath.md.
//
// HERMETIC: own temp LOOM_HOME (mirrors vault-operational-dir-refusal.mjs's own fixture shape). Proves:
//   (a) commitVault itself refuses a device-form vaultPath (UNC) — the chokepoint every caller reaches —
//       and never git-inits/commits the real directory it names, regardless of what else happens to it;
//   (b) writeVaultFile/createVaultFile/deleteVaultFile never COMMIT a device-form vaultPath (no .git ever
//       created at the real target) — NOTE, found empirically while writing this test: the underlying
//       file WRITE for writeVaultFile/createVaultFile is NOT blocked by this fix, and genuinely lands on
//       disk for a UNC-spelled target — `resolveInVault`'s own `path.resolve`/fs calls run BEFORE
//       `commitAndReportOutcome`/`commitVault` ever sees the path, and Windows' own fs layer resolves a
//       `\\host\share\...` admin-share path to a real location just fine. This card's fix is scoped to the
//       git-touching chokepoint (never reaching `git init`/`commit`), not to Node's own `fs` calls — see
//       the decision record's "Where this fires" section for why `resolveVaultGitTarget` (read-only, never
//       mutates) was deliberately left out of this card's scope for the same reason in reverse;
//   (c) the DOS-device and NT-native-namespace forms are refused by commitVault the same way, not just UNC;
//   (d) NEGATIVE CONTROL: an ordinary, non-device-form vaultPath pointing at the EXACT SAME real directory
//       is completely unaffected — proves the refusal discriminates on the vaultPath's SPELLING, not on
//       anything about the target directory itself;
//   (e) REGRESSION: the one exempt member of the family (the extended-length LOCAL form, `\\?\<drive>:\...`)
//       never trips THIS card's new check — confirmed by asserting the new warning text never fires for it,
//       not by asserting commitVault successfully commits via it: a SEPARATE, pre-existing quirk (found
//       empirically — git's own `rev-parse --show-toplevel` normalizes away the `\\?\` prefix, so the raw
//       vaultPath string no longer string-matches the discovered root, misclassifying it as
//       "externally managed") already makes commitVault silently no-op for this form, with or without this
//       card's change, and fixing that quirk is out of this card's scope.
// Run after build: node test/vault-device-form-write-path-refusal.mjs
import { requireHermeticEnv } from "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const fixtureRoot = mkdtempManaged("loom-vdf-refusal-");
const home = path.join(fixtureRoot, "home");
const loomHomePath = path.join(home, ".loom");
fs.mkdirSync(loomHomePath, { recursive: true });
process.env.LOOM_HOME = loomHomePath;
requireHermeticEnv(); // confirms LOOM_HOME is the temp dir just established above, never the real ~/.loom

const { writeVaultFile, createVaultFile, deleteVaultFile } = await import("../dist/vault/writer.js");
const { commitVault } = await import("../dist/vault/versioner.js");
const { isUnsafeToCanonicalize } = await import("../dist/projects/vault-path.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email loom-test@example.com");
  git(dir, "config user.name loom-test");
}

// A REAL local directory, so the device-form candidates below name an ACTUAL filesystem location — proves
// the refusal is a deliberate spelling-based decision, never an accident of "nothing's there anyway".
const realVault = path.join(fixtureRoot, "real-vault");
fs.mkdirSync(realVault, { recursive: true });
const driveMatch = realVault.match(/^([A-Za-z]):(.*)$/);

if (!driveMatch) {
  console.log("SKIP  entire suite (fixture root is not drive-letter-rooted — device-form candidates below need a real drive letter to build from)");
} else {
  const [, drive, rest] = driveMatch;
  const uncCandidate = `\\\\localhost\\${drive}$${rest}`; // UNC admin-share alias of the SAME real dir
  const dosDeviceCandidate = `\\\\.\\${drive}:${rest}`; // DOS device namespace form of the SAME real dir
  const ntNativeCandidate = `\\??\\${drive}:${rest}`; // NT native namespace prefix of the SAME real dir
  const extendedLocalCandidate = `\\\\?\\${drive}:${rest}`; // the ONE exempt member — safe local form

  // Fixture sanity: each candidate is actually classified the way this test assumes.
  check("fixture precondition: isUnsafeToCanonicalize(UNC admin-share form) is true", isUnsafeToCanonicalize(uncCandidate));
  check("fixture precondition: isUnsafeToCanonicalize(DOS device form) is true", isUnsafeToCanonicalize(dosDeviceCandidate));
  check("fixture precondition: isUnsafeToCanonicalize(NT native namespace form) is true", isUnsafeToCanonicalize(ntNativeCandidate));
  check("fixture precondition: isUnsafeToCanonicalize(extended-length LOCAL form) is false (the one exempt member)", !isUnsafeToCanonicalize(extendedLocalCandidate));

  // (a)+(b)+(c) commitVault refuses a UNC-spelled vaultPath outright — the chokepoint every caller reaches.
  {
    const committed = await commitVault(uncCandidate, "loom: should never land");
    check("commitVault(UNC-spelled vaultPath, ...) returns false (refused)", committed.committed === false);
    check("commitVault did not git-init the real directory the UNC form names", !fs.existsSync(path.join(realVault, ".git")));
  }

  // (b) the writer path never COMMITS a device-form vaultPath — the actual defect this card closes in
  // commitVault (RED on pre-fix code: commitVault had no such check and would have reached its own
  // unguarded git discovery against the UNC-spelled path, via `vault/writer.ts`'s direct call).
  {
    const w = await writeVaultFile(uncCandidate, "notes/pwned.md", "should never be committed");
    check("writeVaultFile(UNC-spelled vaultPath, ...) never commits (ok:true, committed:false, or ok:false)", w.ok === false || w.committed === false);
    check("writeVaultFile did not git-init the real target dir", !fs.existsSync(path.join(realVault, ".git")));

    const c = await createVaultFile(uncCandidate, "notes/pwned2.md", "should never be committed");
    check("createVaultFile(UNC-spelled vaultPath, ...) never commits", c.ok === false || c.committed === false);
    check("createVaultFile did not git-init the real target dir", !fs.existsSync(path.join(realVault, ".git")));

    const d = await deleteVaultFile(uncCandidate, "notes/pwned.md");
    check("deleteVaultFile(UNC-spelled vaultPath, ...) does not throw/crash", d && typeof d.ok === "boolean");
    check("deleteVaultFile did not git-init the real target dir", !fs.existsSync(path.join(realVault, ".git")));
  }

  // (c) the DOS-device and NT-native-namespace forms are refused the same way — not just plain UNC.
  {
    const committedDos = await commitVault(dosDeviceCandidate, "loom: should never land (dos device)");
    check("commitVault(DOS-device-form vaultPath, ...) returns false (refused)", committedDos.committed === false);
    check("commitVault did not git-init the real directory via the DOS device form", !fs.existsSync(path.join(realVault, ".git")));

    const committedNt = await commitVault(ntNativeCandidate, "loom: should never land (nt native namespace)");
    check("commitVault(NT-native-namespace-form vaultPath, ...) returns false (refused)", committedNt.committed === false);
    check("commitVault did not git-init the real directory via the NT native namespace form", !fs.existsSync(path.join(realVault, ".git")));
  }

  // (d) NEGATIVE CONTROL: an ordinary, non-device-form vaultPath pointing at the EXACT SAME real directory
  // is completely unaffected — proves the refusal discriminates on SPELLING, not on the target directory.
  {
    initVault(realVault);
    const w = await writeVaultFile(realVault, "notes/hello.md", "# hello\n");
    check("negative control: an ordinary (non-device-form) vaultPath write to the SAME real dir still succeeds", w.ok === true && w.committed === true);
    check("negative control: the file actually landed on disk", fs.readFileSync(path.join(realVault, "notes", "hello.md"), "utf8").includes("hello"));
    check("negative control: .git WAS created for the ordinary-spelled vault", fs.existsSync(path.join(realVault, ".git")));
  }

  // (e) REGRESSION: the one exempt member of the family (`\\?\<drive>:\...`) never trips THIS card's new
  // check. Asserted narrowly via the warning text (never "commitVault succeeds") — see the module doc's
  // (e) bullet for why a plain success assertion here would be testing an unrelated, pre-existing quirk.
  {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    let result;
    try {
      result = await commitVault(extendedLocalCandidate, "loom: via extended-length local form");
    } finally {
      console.warn = origWarn;
    }
    check(
      "the extended-length LOCAL form never trips the new network/device-form warning (card 35dff468 regression)",
      !warnings.some((w) => w.includes("network/device form")),
    );
    check("commitVault did not THROW for the extended-length local form either", result && typeof result.committed === "boolean");
  }
}

console.log(failures === 0
  ? "\nALL PASS — a network/device-form vaultPath never reaches git init/commit via commitVault or the vault/writer.ts write path."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
