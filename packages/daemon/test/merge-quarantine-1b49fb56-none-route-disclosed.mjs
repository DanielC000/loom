import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1b49fb56, shape S3: `clearMergeQuarantine`'s "none" route (`ownMatchesElsewhere` — the
// claimant also owns an independent ACTIVE record at a different key). That route sweeps no pending by
// design (3b1944b6's AJ regression), so an untied same-identity pending entry survives it and used to be
// invisible in the raw result — the card's premise. VERIFIED FALSE for this route: `negative-control --ref
// ec88046d` shows this file GREEN on the pre-fix code, because `tryClearMergeQuarantineByOwnIdentityBody`
// already composes `stillQuarantined` from its own re-resolve. This file is therefore a PIN (the "none"
// route stays truthful), not a RED proof; only the ordinary `!freshIsForeign` route needed the fix.
//
// 2 claimants (W at the fresh key + W2 elsewhere, plus one untied pending P1) and 3 claimants (… + P2).
// A negative control (no pending leftover on the same route) must stay clean.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-1b49fb56-none-route-disclosed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1b49fb56c-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { clearMergeQuarantine, clearMergeQuarantineByRecordedPath, reenterMergeQuarantinesAtBootTestOnly, setActiveQuarantineTestOnly, listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR } =
  await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const norm = (p) => path.resolve(p).toLowerCase();
const namesPath = (list, p) => (list ?? []).some((x) => norm(x) === norm(p));

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function build(tag, nPending) {
  const y = path.join(os.tmpdir(), `loom-mq1b49fb56c-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  const k = canonicalRepoLockKey(y);
  const k2 = `${tag}-k2-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`), JSON.stringify({
    repoPath: y, branch: `${tag}-w-branch`, reason: `${tag}: real latch`, tokens: [`${tag}-w-token`], enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
  const pTokens = [];
  for (let i = 1; i <= nPending; i++) {
    const entry = { repoPath: y, branch: `${tag}-p${i}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens: [`${tag}-p${i}-token`], armedKeys: [] };
    reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: `pending-${tag}-p${i}-test.json` }]);
    pTokens.push(`${tag}-p${i}-token`);
  }
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // W2: an independent ACTIVE record of the same identity at a DIFFERENT key (in-memory only), which is
  // what routes `clearMergeQuarantine` through `ownMatchesElsewhere` -> the "none" route.
  setActiveQuarantineTestOnly(k2, { repoPath: y, branch: `${tag}-w2-branch`, reason: `${tag}: second active`, enteredAt: Date.now() - 10_000, tokens: [`${tag}-w2-token`], armedKeys: [k2] });
  return { y, pTokens };
}
const allTokens = () => listActiveMergeQuarantines().flatMap((e) => e.tokens);

for (const nPending of [1, 2]) {
  const claimants = nPending + 2;
  const tag = `none${claimants}`;
  const { y, pTokens } = build(tag, nPending);
  check(`(${tag} precondition) both active records and every pending token are present (pure read)`, allTokens().includes(`${tag}-w-token`) && allTokens().includes(`${tag}-w2-token`) && pTokens.every((t) => allTokens().includes(t)));
  const r = clearMergeQuarantine(y);
  const post = allTokens();
  check(`(${tag}) both active records' tokens are gone`, !post.includes(`${tag}-w-token`) && !post.includes(`${tag}-w2-token`));
  check(`(${tag}) every untied pending token survives (the "none" route never sweeps pending)`, pTokens.every((t) => post.includes(t)));
  check(`*** ${tag} *** raw result reports stillQuarantined:true`, r.stillQuarantined === true);
  check(`*** ${tag} *** raw reason names the clear-by-path route`, typeof r.reason === "string" && r.reason.includes("/internal/merge-quarantine/clear-by-path"));
  check(`*** ${tag} *** liftedRepoPaths never names the still-blocked claimant`, !namesPath(r.liftedRepoPaths, y));
  check(`(${tag}) refusedBeforeClear is NOT set`, r.refusedBeforeClear === undefined);
  check(`(${tag}) the claimant really is blocked`, assertRepoNotQuarantined(y).ok === false);
  const follow = clearMergeQuarantineByRecordedPath(y);
  check(`*** ${tag} *** the NAMED route releases every claimant`, follow.wasQuarantined === true && assertRepoNotQuarantined(y).ok === true && !pTokens.some((t) => allTokens().includes(t)));
}

// Negative control: the same "none" route with NO pending leftover must stay clean.
{
  const { y, pTokens } = build("noneclean", 0);
  const r = clearMergeQuarantine(y);
  check("(control) the none route with no pending leftover carries NO stillQuarantined", r.stillQuarantined === undefined && pTokens.length === 0 && assertRepoNotQuarantined(y).ok === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
