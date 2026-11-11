import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1b49fb56, shape S1 ("reduce"): a same-identity pending twin tied to the active entry W by a
// shared armed key but holding a PRIVATE token W does not. `clearMergeQuarantine(y)`'s key-addressed clear
// REDUCES the twin (64119847 sc.4: its private token correctly survives — fail-closed, unchanged here) so y
// stays blocked, yet the raw result used to read as a clean success. The fix DISCLOSES it
// (stillQuarantined:true + a reason naming clear-by-path); it never clears the twin.
//
// 2 claimants (W + one reduced twin P1) and 3 claimants (W + P1 + P2, both reduced in one call). For each:
// raw result truthful, Reporting (REST surface) truthful and not double-composed, the named route releases
// everything, and a clean clear stays clean (negative control). REACH lines print which surface reaches it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-1b49fb56-reduced-twin-disclosed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1b49fb56b-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { clearMergeQuarantine, clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath, reenterMergeQuarantinesAtBootTestOnly, listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR } =
  await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const norm = (p) => path.resolve(p).toLowerCase();
const namesPath = (list, p) => (list ?? []).some((x) => norm(x) === norm(p));

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function parkWAt(key, repoPath, tag, tokens) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
}

// A TIED twin: shares W's key via armedKeys, holds W's token AND a private one.
function injectTiedP(repoPath, tag, tokens, armedKeys) {
  const entry = { repoPath, branch: `${tag}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens, armedKeys };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: `pending-${tag}-test.json` }]);
}

function build(tag, nPending) {
  const y = path.join(os.tmpdir(), `loom-mq1b49fb56b-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  const k = canonicalRepoLockKey(y);
  const wToken = `${tag}-w-token`;
  parkWAt(k, y, `${tag}-w`, [wToken]);
  const privates = [];
  for (let i = 1; i <= nPending; i++) { injectTiedP(y, `${tag}-p${i}`, [wToken, `${tag}-p${i}-private`], [k]); privates.push(`${tag}-p${i}-private`); }
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  return { y, k, wToken, privates };
}

const allTokens = () => listActiveMergeQuarantines().flatMap((e) => e.tokens);

for (const nPending of [1, 2]) {
  const claimants = nPending + 1;
  {
    const tag = `raw${claimants}`;
    const { y, wToken, privates } = build(tag, nPending);
    check(`(${tag} precondition) W's token and every private token are present (pure read)`, allTokens().includes(wToken) && privates.every((t) => allTokens().includes(t)));
    const r = clearMergeQuarantine(y);
    const post = allTokens();
    check(`(${tag}) the cleared token is gone everywhere`, !post.includes(wToken));
    check(`(${tag}) every private token SURVIVES (64119847 sc.4 unchanged: fail-closed)`, privates.every((t) => post.includes(t)));
    check(`*** ${tag} *** raw result reports stillQuarantined:true`, r.stillQuarantined === true);
    check(`*** ${tag} *** raw reason names the clear-by-path route`, typeof r.reason === "string" && r.reason.includes("/internal/merge-quarantine/clear-by-path"));
    check(`*** ${tag} *** liftedRepoPaths never names the still-blocked claimant`, !namesPath(r.liftedRepoPaths, y));
    check(`*** ${tag} *** releasedRepoPaths never names the still-blocked claimant`, !namesPath(r.releasedRepoPaths, y));
    check(`(${tag}) refusedBeforeClear is NOT set`, r.refusedBeforeClear === undefined);
    check(`(${tag}) the claimant really is blocked`, assertRepoNotQuarantined(y).ok === false);
    const follow = clearMergeQuarantineByRecordedPath(y);
    check(`*** ${tag} *** the NAMED route (clear-by-path) releases every claimant`, follow.wasQuarantined === true && assertRepoNotQuarantined(y).ok === true && !privates.some((t) => allTokens().includes(t)));
  }
  {
    const tag = `rep${claimants}`;
    const { y, privates } = build(tag, nPending);
    const r = clearMergeQuarantineReporting(y);
    const reaches = privates.some((t) => allTokens().includes(t));
    console.log(`REACH  S1 reduced twin, ${claimants} claimants, via clearMergeQuarantineReporting: private token survives the clear = ${reaches}`);
    if (reaches) {
      check(`*** ${tag} *** Reporting stays truthful: wasQuarantined:true + a reason naming clear-by-path`, r.wasQuarantined === true && typeof r.reason === "string" && r.reason.includes("/internal/merge-quarantine/clear-by-path"));
      check(`(${tag}) Reporting does not double-compose the reason`, r.reason.split("to clear it directly").length === 2);
      check(`(${tag}) Reporting's liftedRepoPaths never names the claimant`, !namesPath(r.liftedRepoPaths, y));
      check(`(${tag}) the claimant really is blocked`, assertRepoNotQuarantined(y).ok === false);
    } else {
      check(`(${tag}) Reporting folded/cleared the twin: claimant not blocked`, assertRepoNotQuarantined(y).ok === true);
    }
  }
}

{
  const y = path.join(os.tmpdir(), `loom-mq1b49fb56b-clean-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  parkWAt(canonicalRepoLockKey(y), y, "clean-w", ["clean-w-token"]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  const r = clearMergeQuarantine(y);
  check("(control) a clean clear carries NO stillQuarantined and no reason", r.stillQuarantined === undefined && r.reason === undefined);
  check("(control) a clean clear really unblocks", assertRepoNotQuarantined(y).ok === true && r.wasQuarantined === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
