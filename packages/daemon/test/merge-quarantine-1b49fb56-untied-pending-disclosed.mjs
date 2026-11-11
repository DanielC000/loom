import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1b49fb56 — `clearMergeQuarantine`'s direct-ByKey route (the ordinary `!freshIsForeign` path)
// ran no pending pass, so an UNTIED same-identity pending entry (not the same object as the active entry,
// no shared armed key, no orphan ref, tokens not a subset of the active entry's) stayed pending and kept
// the claimant blocked — while the raw result read as a clean success (wasQuarantined:true,
// liftedRepoPaths:[], no stillQuarantined). The fix DISCLOSES (stillQuarantined + a followable reason); it
// never clears those entries (64119847 sc.4: the identity-wide sweep is clear-by-path's job).
//
// Shape S2 ("untied"), 2 claimants (W active + one pending P1) and 3 claimants (W + P1 + P2). For each:
//   * the RAW export `clearMergeQuarantine(y)` must report stillQuarantined:true, a reason naming the
//     clear-by-path route, and NEVER name y in liftedRepoPaths;
//   * the project-resolved wrapper `clearMergeQuarantineReporting(y)` (the real REST surface) must stay
//     truthful and not double-compose the reason;
//   * the named route (clear-by-path) really does release every claimant;
//   * a CLEAN full clear (no leftover pending) carries NO stillQuarantined (negative control).
// The reachability verdict (which of the raw export / Reporting reaches the shape) is printed as REACH lines.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-1b49fb56-untied-pending-disclosed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1b49fb56a-");
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

// An UNTIED pending twin: no armedKeys, no orphan ref, its OWN private token(s) only.
function injectUntiedP(repoPath, tag, tokens) {
  const entry = { repoPath, branch: `${tag}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens, armedKeys: [] };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: `pending-${tag}-test.json` }]);
}

function build(tag, nPending) {
  const y = path.join(os.tmpdir(), `loom-mq1b49fb56a-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  const k = canonicalRepoLockKey(y);
  parkWAt(k, y, `${tag}-w`, [`${tag}-w-token`]);
  const pTokens = [];
  for (let i = 1; i <= nPending; i++) { injectUntiedP(y, `${tag}-p${i}`, [`${tag}-p${i}-token`]); pTokens.push(`${tag}-p${i}-token`); }
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  return { y, k, pTokens };
}

const allTokens = () => listActiveMergeQuarantines().flatMap((e) => e.tokens);

for (const nPending of [1, 2]) {
  const claimants = nPending + 1;
  // ── RAW export ────────────────────────────────────────────────────────────────────────────────────
  {
    const tag = `raw${claimants}`;
    const { y, pTokens } = build(tag, nPending);
    // listActiveMergeQuarantines is a PURE read; never assertRepoNotQuarantined/activeMergeQuarantineFor
    // here (they can absorb P into W and destroy the setup).
    const pre = allTokens();
    check(`(${tag} precondition) W's token and every pending token are present`, pre.includes(`${tag}-w-token`) && pTokens.every((t) => pre.includes(t)));
    const r = clearMergeQuarantine(y);
    const post = allTokens();
    check(`(${tag}) W's own token is gone`, !post.includes(`${tag}-w-token`));
    check(`(${tag}) every untied pending token SURVIVES (fail-closed, 64119847 sc.4 unchanged)`, pTokens.every((t) => post.includes(t)));
    check(`*** ${tag} *** raw result reports stillQuarantined:true`, r.stillQuarantined === true);
    check(`*** ${tag} *** raw result's reason names the clear-by-path route`, typeof r.reason === "string" && r.reason.includes("/internal/merge-quarantine/clear-by-path"));
    check(`*** ${tag} *** liftedRepoPaths never names the still-blocked claimant`, !namesPath(r.liftedRepoPaths, y));
    check(`*** ${tag} *** releasedRepoPaths never names the still-blocked claimant`, !namesPath(r.releasedRepoPaths, y));
    check(`(${tag}) refusedBeforeClear is NOT set (this is not a pre-clear refusal)`, r.refusedBeforeClear === undefined);
    check(`(${tag}) the claimant really is blocked`, assertRepoNotQuarantined(y).ok === false);
    const follow = clearMergeQuarantineByRecordedPath(y);
    check(`*** ${tag} *** the NAMED route (clear-by-path) releases every claimant`, follow.wasQuarantined === true && assertRepoNotQuarantined(y).ok === true && !pTokens.some((t) => allTokens().includes(t)));
  }
  // ── Reporting (the REST surface) ──────────────────────────────────────────────────────────────────
  {
    const tag = `rep${claimants}`;
    const { y, pTokens } = build(tag, nPending);
    const r = clearMergeQuarantineReporting(y);
    const reaches = pTokens.some((t) => allTokens().includes(t));
    console.log(`REACH  S2 untied, ${claimants} claimants, via clearMergeQuarantineReporting: pending survives the clear = ${reaches}`);
    if (reaches) {
      check(`*** ${tag} *** Reporting stays truthful: wasQuarantined:true + a reason naming clear-by-path`, r.wasQuarantined === true && typeof r.reason === "string" && r.reason.includes("/internal/merge-quarantine/clear-by-path"));
      check(`(${tag}) Reporting does not double-compose the reason`, (r.reason.match(/this clear did not lift it|ANOTHER repo's own/g) ?? []).length === 1 && r.reason.split("to clear it directly").length === 2);
      check(`(${tag}) Reporting's liftedRepoPaths never names the claimant`, !namesPath(r.liftedRepoPaths, y));
      check(`(${tag}) the claimant really is blocked`, assertRepoNotQuarantined(y).ok === false);
    } else {
      check(`(${tag}) pending was folded/cleared by Reporting: claimant not blocked`, assertRepoNotQuarantined(y).ok === true);
    }
  }
}

// ── Negative control: a clean full clear must NOT claim stillQuarantined ─────────────────────────────
{
  const y = path.join(os.tmpdir(), `loom-mq1b49fb56a-clean-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  const k = canonicalRepoLockKey(y);
  parkWAt(k, y, "clean-w", ["clean-w-token"]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  const r = clearMergeQuarantine(y);
  check("(control) a clean clear (no leftover pending) carries NO stillQuarantined and no reason", r.stillQuarantined === undefined && r.reason === undefined);
  check("(control) a clean clear really unblocks", assertRepoNotQuarantined(y).ok === true && r.wasQuarantined === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
