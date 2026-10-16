import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 150aed7b — round-3 Code Review (`5220fda9`) of `43cf3b26` flagged: `detectUnknownProvenance`
// (merge-quarantine.ts ~:498) reads only the SCALAR `resolvedKey`. An array-only record (plural
// `resolvedKeys`, no scalar at all) with `tokens.length > 1`, no `provenanceTracked`, and a hash mismatch
// would NOT get `provenanceUnknown`, where the SAME record shaped with a scalar would. Confirmed
// reachable (this card's own INVESTIGATE-FIRST pass) at all three call sites that construct `entry` from
// raw parsed JSON — PASS 1 (the primary `.json` loop), PASS 1b (`.json.tmp-<n>` residue recovery), and
// the safety-tmp recovery pass (`.json.tmp-safety-<n>-<hex>`) — all three parse `resolvedKey` (scalar)
// and `resolvedKeys` (plural) as SEPARATE fields straight off the raw JSON and call
// `detectUnknownProvenance` immediately after, before any other derivation.
//
// THE FIX: generalized the scalar-only gate to `informativeKeysFor(entry).length === 0` and the hash
// check to `informativeKeysFor(entry).some((k) => quarantineHashForKey(k) !== hash)` — the SAME per-key
// semantics the scalar case already had (with exactly one key, "some" reduces to the original check
// byte-for-byte), now also applied when there's more than one.
//
// CR FOLLOW-UP ROUND (same card): manager required precision/coverage scenarios beyond the two originals
// (`scalar`, `array-only`) — provenanceTracked still short-circuits an array-only record; tokens.length
// === 1 still never flags one; a SELF-REFERENCING scalar (hashes to its OWN physical file, so it alone
// would never trip the OLD scalar-only check) plus a genuinely FOREIGN plural key must still flag, AND
// the refusal text must name the foreign key, not the self-reference; PASS 1b and safety-tmp coverage.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME, since PASS 1 runs once per
// boot and this needs a truly fresh module/boot per shape (mirrors every sibling merge-quarantine*.mjs).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-unknown-provenance-array-only-150aed7b.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "scalar",
  "array-only",
  "provenance-tracked-array-only-unaffected",
  "single-token-array-only-unaffected",
  "self-ref-scalar-plus-foreign-plural-flagged",
  "array-only-pass1b-tmp-residue",
  "array-only-safety-tmp",
  "remediation-array-only-names-foreign-key",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], {
        env: envWithoutLoomHome, stdio: "inherit",
      });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? `\n✅ ALL ${SCENARIOS.length} SCENARIOS PASS — card 150aed7b's own fix (array-only records reach the hash check too, precisely) holds.`
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mquparr150-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mquparr150@loom -c user.name=mquparr150";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mquparr150-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "R.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mquparr150@loom && git config user.name mquparr150`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}
function hashForKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
function foreignKeyPath(tag) { return path.join(os.tmpdir(), `loom-mquparr150-foreign-${tag}-${freshSfx()}`); }

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

const r = makeRepo("r");
const kr = canonicalRepoLockKey(r);
const krHash = hashForKey(kr);
const finalPath = path.join(MERGE_QUARANTINE_DIR, `${krHash}.json`);

if (scenarioName === "scalar" || scenarioName === "array-only") {
  // The two ORIGINAL scenarios — unchanged. A record filed AT r's own key (hash matches r's canonical
  // key -- no PASS1 migrate branch), tokens>1 (union-shaped), no provenanceTracked, and a "secondary key"
  // that does NOT hash to krHash -- the exact static signature detectUnknownProvenance's own doc says it
  // detects (pre-82032b5c defect-A shape).
  const common = {
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- :501 array-only repro",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"],
  };
  if (scenarioName === "scalar") {
    fs.writeFileSync(finalPath, JSON.stringify({ ...common, resolvedKey: "bogus-secondary-key-never-hashes-to-kr" }, null, 2) + "\n");
  } else {
    fs.writeFileSync(finalPath, JSON.stringify({ ...common, resolvedKeys: ["bogus-secondary-key-never-hashes-to-kr"] }, null, 2) + "\n");
  }
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check(`(precondition, ${scenarioName}) R is armed in memory after boot`, !!entry);
  check(`*** THE FIX (${scenarioName}) *** a hash-mismatching key flags provenanceUnknown:true, scalar or array alike`, entry?.provenanceUnknown === true);

} else if (scenarioName === "provenance-tracked-array-only-unaffected") {
  // PRECISION: the IDENTICAL array-only shape as "array-only" above, but with provenanceTracked:true —
  // the precision guard must still short-circuit BEFORE the generalized informativeKeysFor gate is ever
  // reached, exactly as it already does for the scalar case.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- provenanceTracked precision check",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"],
    resolvedKeys: ["bogus-secondary-key-never-hashes-to-kr"], provenanceTracked: true,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot", !!entry);
  check("*** PRECISION *** provenanceTracked:true short-circuits an array-only record too (never flagged)", entry?.provenanceUnknown !== true);

} else if (scenarioName === "single-token-array-only-unaffected") {
  // PRECISION: the IDENTICAL array-only shape, but with only ONE token — "one raise mints exactly one
  // token" is load-bearing per detectUnknownProvenance's own doc; a single-token entry can never be a
  // union regardless of every other condition, array-shaped keys included.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- tokens.length===1 precision check",
    enteredAt: Date.now(), tokens: ["tok-1"],
    resolvedKeys: ["bogus-secondary-key-never-hashes-to-kr"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot", !!entry);
  check("*** PRECISION *** a single-token array-only record is never flagged", entry?.provenanceUnknown !== true);

} else if (scenarioName === "self-ref-scalar-plus-foreign-plural-flagged") {
  // COVERAGE: a scalar resolvedKey that is SELF-REFERENTIAL (hashes to krHash — the file's OWN physical
  // location) would NEVER trip the OLD scalar-only check on its own (quarantineHashForKey(kr) === hash,
  // no mismatch). Pairing it with a genuinely FOREIGN plural key (which DOES mismatch) is exactly the
  // shape the OLD code would silently miss — informativeKeysFor(entry) must still catch it via the
  // foreign key, even though the scalar alone names nothing suspicious.
  const foreign = foreignKeyPath("self-ref");
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- self-ref scalar must not mask a foreign plural key",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"],
    resolvedKey: kr, resolvedKeys: [kr, foreign],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot", !!entry);
  check("(precondition) the scalar really is self-referential (would NOT mismatch alone)", entry?.resolvedKey === kr);
  check("*** COVERAGE *** a self-ref scalar plus a genuinely foreign plural key IS flagged (the foreign key, not the scalar, trips it)", entry?.provenanceUnknown === true);

  // Item 3 (remediation text): the refusal must name the FOREIGN key, never just the self-reference
  // (which would tell a human to confirm no process is running under the entry's OWN already-listed path
  // — useless — while staying silent about the genuinely different repo the bytes also implicate).
  const refusal = clearMergeQuarantineLatchFile(krHash);
  check("(precondition) the bare-id clear is refused (ambiguous — unknownProvenance)", refusal.ok === false);
  check("*** THE FIX (remediation text) *** the refusal names the FOREIGN key, not just the self-referencing scalar", refusal.ok === false && refusal.reason.includes(foreign));

} else if (scenarioName === "array-only-pass1b-tmp-residue") {
  // COVERAGE: PASS 1b (tmp-residue recovery) shares the identical resolvedKey/resolvedKeys raw-JSON
  // parse pattern as PASS 1 — reach it with a BARE `.json.tmp-<n>` residue and no `.json` final at all
  // (hashToRepo is always empty here since reenterMergeQuarantinesAtBoot([]) never registers anything,
  // so PASS 1b's own "stale residue, skip" branch can never fire in this suite).
  const foreign = foreignKeyPath("pass1b");
  fs.writeFileSync(`${finalPath}.tmp-999`, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- PASS 1b array-only coverage",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"], resolvedKeys: [foreign],
  }, null, 2) + "\n");
  check("(precondition) no .json final exists — this can only be read by PASS 1b, never PASS 1", !fs.existsSync(finalPath));
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot (via the tmp residue)", !!entry);
  check("*** COVERAGE (PASS 1b) *** an array-only tmp residue is flagged provenanceUnknown:true too", entry?.provenanceUnknown === true);

} else if (scenarioName === "array-only-safety-tmp") {
  // COVERAGE: the safety-tmp recovery pass shares the identical parse pattern too — reach it with a bare
  // `.json.tmp-safety-<n>-<hex>` residue and no `.json` final.
  const foreign = foreignKeyPath("safety");
  fs.writeFileSync(`${finalPath}.tmp-safety-1-abcdef123456`, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- safety-tmp array-only coverage",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"], resolvedKeys: [foreign],
  }, null, 2) + "\n");
  check("(precondition) no .json final exists — this can only be read by the safety-tmp recovery pass", !fs.existsSync(finalPath));
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot (via the safety-tmp residue)", !!entry);
  check("*** COVERAGE (safety-tmp) *** an array-only safety-tmp residue is flagged provenanceUnknown:true too", entry?.provenanceUnknown === true);

} else if (scenarioName === "remediation-array-only-names-foreign-key") {
  // Item 3 (remediation text), pure array-only case: NO scalar at all, only resolvedKeys. The OLD text
  // builder read only the scalar (always undefined here), so it ALWAYS took the "nothing to name"
  // fallback branch regardless of whether a real foreign key existed to name.
  const foreign = foreignKeyPath("remediation");
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "card 150aed7b -- remediation text, pure array-only",
    enteredAt: Date.now(), tokens: ["tok-1", "tok-2"], resolvedKeys: [foreign],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(r);
  check("(precondition) R is armed in memory after boot", !!entry);
  check("(precondition) entry carries no scalar resolvedKey at all (array-only)", entry?.resolvedKey === undefined);
  check("(precondition) entry is flagged provenanceUnknown:true", entry?.provenanceUnknown === true);

  const refusal = clearMergeQuarantineLatchFile(krHash);
  check("(precondition) the bare-id clear is refused (ambiguous — unknownProvenance)", refusal.ok === false);
  check("*** THE FIX (remediation text) *** the refusal names the array-only foreign key", refusal.ok === false && refusal.reason.includes(foreign));
  check("*** THE FIX (remediation text) *** the refusal does NOT fall back to the 'nothing to name' text when a real key exists", refusal.ok === false && !refusal.reason.includes("not recorded (or is not itself a path)"));

} else {
  throw new Error(`unknown scenario: ${scenarioName}`);
}

process.exit(failures === 0 ? 0 : 1);
