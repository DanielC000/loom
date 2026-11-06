import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Pins the SAFETY properties of clearing a RESOLVABLE pending entry P while a tmp residue misfiled under an
// unrelated repo R's hash also holds P's just-cleared token `tok`. The residue is either FOREIGN (X = P/ghost,
// a different identity that collapses onto P's canonical key) or P's OWN identity.
//
// Why it is safe, and why this file exists: the durable cleared-token tombstone is IDENTITY-SCOPED twice over.
//  (1) The clear's token-holder scan (`identityHasAnyPhysicalRecordHoldingToken`) skips any file whose repoPath
//      identity differs from the clearing identity (its `directPathIdentity(repoPath) !== identity` skip), so
//      a foreign X never withholds P's tombstone — and an own-identity residue always does.
//  (2) The boot filter (`filterBootTombstonedTokens` -> `tokenTombstonedForIdentity`) drops a tombstoned token
//      only from a record of the tombstone's OWN identity, so a foreign X keeps `tok` across a reboot.
// Properties pinned: (a) foreign X holding [xTok, tok] re-arms with BOTH tokens after a reboot and neither X
// nor P is admitted; (b) a residue holding ONLY tok is swept and nothing is left blocked after a reboot;
// (c) an own-identity residue withholds the tombstone, survives, and re-arms after a reboot.
// The tombstone's own state is pinned for the RECORDED route only in the foreign shapes. The by-path route's
// tombstone state there is deliberately NOT pinned: it is policy another card is changing, a pin would churn.
//
// @decision 7aa9c406 — a foreign residue's keep never feeds the cleared identity's own tombstone decision.
//
// @decision d2592cd5 — the tombstone and its boot filter stay identity-scoped, never widened across identities.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqc3a1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mqc3a1@loom -c user.name=mqc3a1";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

function initRepoAt(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-c3a1cfd7 (${tag})\n`);
  execSync(`git init -q && git config user.email mqc3a1@loom && git config user.name mqc3a1`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

const sidecarHasToken = (tok) => {
  const sp = path.join(process.env.LOOM_HOME, "merge-quarantine-cleared-tokens.dat");
  return fs.existsSync(sp) && Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(sp, "utf8")), tok);
};
const clearDir = () => { for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f)); };

const ROUTES = {
  path: (p) => mod.clearMergeQuarantine(p),
  recorded: (p) => mod.clearMergeQuarantineByRecordedPath(p),
};

// P pending + resolvable now; R is an unrelated repo whose hash the residue is misfiled under.
// `residueIdentity`: "foreign" -> repoPath = P/ghost; "own" -> repoPath = P itself.
function setup(route, shape, residueIdentity, residueTokens) {
  const p = path.join(os.tmpdir(), `loom-mqc3a1-p-${route}-${shape}-${freshSfx()}`);
  const tok = mod.enterMergeQuarantine(p, "loom/p-branch", "p's own raise, while its path did not resolve");
  initRepoAt(p, `p-${route}-${shape}`);
  const r = path.join(os.tmpdir(), `loom-mqc3a1-r-${route}-${shape}-${freshSfx()}`);
  initRepoAt(r, `r-${route}-${shape}`);
  const x = residueIdentity === "foreign" ? path.join(p, `ghost-${route}-${shape}`) : p;
  if (residueIdentity === "foreign") fs.mkdirSync(x, { recursive: true });
  const xTok = randomUUID();
  const tokens = residueTokens(xTok, tok);
  const tmp = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(r))}.json.tmp-83${route.length}77-cafec3a1`);
  fs.writeFileSync(tmp, JSON.stringify({ repoPath: x, branch: "loom/x-branch", reason: "misfiled residue", enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
  return { p, r, x, tok, xTok, tmp };
}

try {
  for (const [route, clear] of Object.entries(ROUTES)) {
    // ═══ (a) foreign X holds [xTok, tok]: re-armed with BOTH after a reboot; neither X nor P admitted.
    {
      const { p, r, x, tok, xTok } = setup(route, "a", "foreign", (xt, t) => [xt, t]);
      clear(p);
      const inProcess = mod.stillBlockedEntryFor(x);
      check(`(a ${route}) in-process: X armed with its own token AND tok`, inProcess !== undefined && inProcess.tokens.includes(xTok) && inProcess.tokens.includes(tok));
      if (route === "recorded") check(`(a ${route}) tok IS durably tombstoned (pinned for the recorded route only)`, sidecarHasToken(tok));
      // by-path: tok's tombstone state is deliberately unpinned here (policy under change elsewhere).
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      const reboot = fresh.stillBlockedEntryFor(x);
      check(`*** (a ${route}) *** after a reboot X is armed with its own token AND tok (tombstone is identity-scoped)`, reboot !== undefined && reboot.tokens.includes(xTok) && reboot.tokens.includes(tok));
      check(`*** (a ${route}) *** after a reboot assertRepoNotQuarantined(X) is refused`, fresh.assertRepoNotQuarantined(x).ok === false);
      check(`*** (a ${route}) *** after a reboot assertRepoNotQuarantined(P) is refused`, fresh.assertRepoNotQuarantined(p).ok === false);
      clearDir();
    }

    // ═══ (b) the residue holds ONLY tok: swept, and nothing is left blocked after a reboot.
    {
      const { p, r, x, tmp } = setup(route, "b", "foreign", (_xt, t) => [t]);
      clear(p);
      check(`(b ${route}) in-process: X is not armed`, mod.stillBlockedEntryFor(x) === undefined);
      check(`(b ${route}) the tok-only residue was swept`, !fs.existsSync(tmp));
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      check(`*** (b ${route}) *** after a reboot X is not armed`, fresh.stillBlockedEntryFor(x) === undefined);
      check(`*** (b ${route}) *** after a reboot X and P are both admitted`, fresh.assertRepoNotQuarantined(x).ok === true && fresh.assertRepoNotQuarantined(p).ok === true);
      clearDir();
    }

    // ═══ (c) the residue claims P's OWN identity: tombstone withheld, residue survives, re-armed after a reboot.
    {
      const { p, r, tok, xTok, tmp } = setup(route, "c", "own", (xt, t) => [xt, t]);
      clear(p);
      check(`*** (c ${route}) *** tok is NOT tombstoned while an own-identity residue still holds it`, !sidecarHasToken(tok));
      check(`(c ${route}) the own-identity residue survives the clear`, fs.existsSync(tmp));
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      const reboot = fresh.stillBlockedEntryFor(p);
      check(`*** (c ${route}) *** after a reboot P is re-armed with its own token AND tok`, reboot !== undefined && reboot.tokens.includes(xTok) && reboot.tokens.includes(tok));
      check(`*** (c ${route}) *** after a reboot assertRepoNotQuarantined(P) is refused`, fresh.assertRepoNotQuarantined(p).ok === false);
      clearDir();
    }
  }
} catch (err) {
  console.log(`FAIL  unexpected throw: ${err?.stack ?? err}`);
  failures++;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
