import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ad66e57e. An UNARMABLE tmp (parses, names X's absolute repoPath, lacks `branch`) whose real tokens are ALL
// durably tombstoned for X must be disposed of at boot, not fail-closed as a fresh-token X placeholder.
// Controls: partial tombstone, a DIFFERENT identity's tombstone, tokenless, non-string tokens must stay blocked.
//
// @decision ad66e57e
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqad66-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqad66@loom -c user.name=mqad66";
let seq = 0;
const freshSfx = () => `${Date.now()}-${seq++}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqad66-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ad66e57e ${tag}\n`);
  execSync(`git init -q && git config user.email mqad66@loom && git config user.name mqad66`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}
const reboot = async () => import(`${href}?b=${++seq}`);
const plant = (hashKey, record, suffix) => {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const p = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(hashKey)}.json.tmp-${suffix}`);
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n");
  return p;
};
const wipe = () => { for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f)); };
// Raise then clear by token: the clear's confirmed write durably tombstones the token for that identity.
function raiseAndClear(repo) {
  mod.enterMergeQuarantine(repo, "loom/b", "raise");
  const tok = mod.stillBlockedEntryFor(repo)?.tokens?.[0];
  mod.clearMergeQuarantineByToken(repo, tok);
  return tok;
}

try {
  // (MAIN) every token tombstoned for X: X open, R open, tmp disposed.
  {
    const r = makeRepo("main-r"), x = makeRepo("main-x");
    const t = raiseAndClear(x);
    check("(main pre) X open after its clear", mod.stillBlockedEntryFor(x) === undefined);
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t] }, "9101-aaaa0001");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("*** THE FIX (main) *** X stays OPEN (no spurious placeholder)", f.stillBlockedEntryFor(x) === undefined);
    check("(main) R open", f.stillBlockedEntryFor(r) === undefined);
    check("(main) tmp disposed", !fs.existsSync(tmp));
    check("(main) nothing pending for X", !f.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === x));
    wipe();
  }
  // (LEGACY single `token` field) same disposition.
  {
    const r = makeRepo("leg-r"), x = makeRepo("leg-x");
    const t = raiseAndClear(x);
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, token: t }, "9102-aaaa0002");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(legacy token) X open and tmp disposed", f.stillBlockedEntryFor(x) === undefined && !fs.existsSync(tmp));
    wipe();
  }
  // (NAMES-OTHER-REPO) the tmp sits beside R's already-CLEAN final but names X; all of X's tokens tombstoned.
  {
    const r = makeRepo("nor-r"), x = makeRepo("nor-x");
    const t = raiseAndClear(x);
    mod.enterMergeQuarantine(r, "loom/r", "R's own real raise (clean final)");
    const rTokens = JSON.stringify([...mod.stillBlockedEntryFor(r).tokens].sort());
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t] }, "9109-ffff0009");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(names-other-repo) X stays open and tmp disposed", f.stillBlockedEntryFor(x) === undefined && !fs.existsSync(tmp));
    check("(names-other-repo) R keeps exactly its own tokens", JSON.stringify([...f.stillBlockedEntryFor(r).tokens].sort()) === rTokens);
    f.clearMergeQuarantine(r); mod.clearMergeQuarantine(r);
    wipe();
  }
  // (TOKENS-WINS) `tokens:[tombstoned]` plus a legacy `token:<live>`: the `tokens` array wins (the shared reader's
  // existing convention, readSurvivingOnDiskTokens), so the file is disposed. Pins today's behaviour, not a new rule.
  {
    const r = makeRepo("tw-r"), x = makeRepo("tw-x");
    const t = raiseAndClear(x);
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t], token: "33333333-3333-4333-8333-333333333333" }, "9110-ffff0010");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(tokens-wins) `tokens` array wins over a legacy `token`: X open, tmp disposed", f.stillBlockedEntryFor(x) === undefined && !fs.existsSync(tmp));
    wipe();
  }
  // (CASE, win32 only) a differently-cased repoPath whose tombstone still matches X's identity.
  if (process.platform === "win32") {
    const r = makeRepo("case-r"), x = makeRepo("case-x");
    const t = raiseAndClear(x);
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x.toUpperCase(), reason: "x", enteredAt: 1, tokens: [t] }, "9111-ffff0011");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(case, win32) differently-cased repoPath still matches the tombstone: X open, tmp disposed", f.stillBlockedEntryFor(x) === undefined && !fs.existsSync(tmp));
    wipe();
  }
  // (UNRESOLVABLE-X) all tombstoned for an unresolvable X: no pending entry, tmp disposed.
  {
    const r = makeRepo("unres-r");
    const x = path.join(os.tmpdir(), `loom-mqad66-never-exists-${freshSfx()}`);
    const t = raiseAndClear(x);
    const tmp = plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t] }, "9103-aaaa0003");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r]);
    check("*** THE FIX (unres) *** no pending entry for unresolvable X", !f.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === x));
    check("(unres) R open and tmp disposed", f.stillBlockedEntryFor(r) === undefined && !fs.existsSync(tmp));
    wipe();
  }
  // (B control) partially tombstoned: still attributed to X, tmp not discarded blind.
  {
    const r = makeRepo("b-r"), x = makeRepo("b-x");
    const t = raiseAndClear(x);
    plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t, "22222222-2222-4222-8222-222222222222"] }, "9104-bbbb0004");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(B control) partially tombstoned: X still blocked", f.stillBlockedEntryFor(x) !== undefined);
    check("(B control) R open", f.stillBlockedEntryFor(r) === undefined);
    wipe();
  }
  // (C control) token tombstoned for a DIFFERENT identity Y only: irrelevant to X.
  {
    const r = makeRepo("c-r"), x = makeRepo("c-x"), y = makeRepo("c-y");
    const t = raiseAndClear(y);
    plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [t] }, "9105-cccc0005");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x, y]);
    check("(C control) other identity's tombstone: X still blocked", f.stillBlockedEntryFor(x) !== undefined);
    wipe();
  }
  // (D control) tokenless record.
  {
    const r = makeRepo("d-r"), x = makeRepo("d-x");
    plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1 }, "9106-dddd0006");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(D control) tokenless: X still blocked", f.stillBlockedEntryFor(x) !== undefined);
    wipe();
  }
  // (E control) non-string / empty token arrays are not a token list.
  {
    const r = makeRepo("e-r"), x = makeRepo("e-x");
    plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [1, 2] }, "9107-eeee0007");
    plant(canonicalRepoLockKey(r), { repoPath: x, reason: "x", enteredAt: 1, tokens: [] }, "9108-eeee0008");
    const f = await reboot(); f.reenterMergeQuarantinesAtBoot([r, x]);
    check("(E control) non-string / empty tokens: X still blocked", f.stillBlockedEntryFor(x) !== undefined);
    wipe();
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
