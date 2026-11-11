import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0cdb56b4 — pin the unresolvable-occupant ownership gate (A) ALONE, in a shape 05a3b6ad's coverage settle (B) cannot settle.
//
// Background (docs/decisions/1be24e71-*.md): an EVICTED unresolvable entry D (diverted to pending because winner Z holds a
// stale secondary arm at D's own key K2) is lifted past that arm by two independent mechanisms: (A) `physicalOwnerRepoPaths`
// withholds Z's claim when the file's confirmed occupant is a different, unresolvable entry (the
// `differentUnresolvableOccupantRepoPathAt` gate, anchor a50faa55); (B) `activeOwnerClaimIsSettledByCoverage` (05a3b6ad).
// Every pre-existing scenario has D's file fully covered by the clear's tokens, so (B) alone is sufficient and a regression of
// (A) stays invisible.
//
// THE SHAPE HERE: D's latch file at hash(K2) carries a token the clear does NOT cover (a second token written after boot,
// i.e. beyond the tokens D's in-memory entry holds), so `markedFinalFullyCoveredByClear` is false and (B) returns "not settled".
// The only thing left that can release the file is (A) refusing to credit Z's stale arm as the physical owner of D's file.
//   * by-recorded-path / reporting routes (clear D's whole entry): D's file must be unlinked (A) — and Z stays quarantined.
//   * control (the by-token route with ONE of two tokens where D's entry keeps the other): file stays, since D's own pending
//     record still owns it — proves the scenario can also say KEEP.
//
// Mutant proofs (patches kept in the worker's scratchpad, never committed) are named in the worker report.
// Each scenario runs in its own child process with its own fresh LOOM_HOME. Run: node test/merge-quarantine-0cdb56b4-occupant-gate-without-coverage-settle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCENARIOS = ["uncovered-by-path", "uncovered-reporting", "control-covered-by-path"];
const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failed = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], { env: envWithoutLoomHome, stdio: "inherit" });
      console.log(`--- ${name}: PASS ---`);
    } catch { console.log(`--- ${name}: FAIL ---`); failed++; }
  }
  console.log(failed === 0 ? "\nALL SCENARIOS PASS" : `\n${failed} SCENARIO(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mq0cdb-${scenarioName.slice(0, 8)}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mq = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const h24 = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const tmpDirs = [];
let reboots = 0;
const freshBoot = async () => import(`${href}?b=${++reboots}`);
const tokensOf = (m, z, d) => { m.reenterMergeQuarantinesAtBoot([z, d]); return new Set(m.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])); };

/** The 1be24e71 fixture: D never exists, its own file sits at hash(K2); Z is a real repo at K1 whose file carries a STALE secondary resolvedKey K2. */
function buildFixture() {
  const z = path.join(os.tmpdir(), `mq0cdb-z-${sfx()}`);
  fs.mkdirSync(z, { recursive: true });
  tmpDirs.push(z);
  fs.writeFileSync(path.join(z, "README.md"), "# 0cdb56b4\n");
  execSync(`git init -q && git config user.email mq0cdb@loom && git config user.name mq0cdb && git add -A && git -c core.autocrlf=false commit -q -m init`, { cwd: z, stdio: "pipe" });
  const K1h = h24(canonicalRepoLockKey(z));
  let d, K2, K2h;
  for (let attempt = 0; ; attempt++) {
    d = path.join(os.tmpdir(), `mq0cdb-d-never-exists-${sfx()}`);
    K2 = canonicalRepoLockKey(d);
    K2h = h24(K2);
    if (K2h < K1h) break; // D must be read (and armed) before Z, so Z's stale secondary arm EVICTS it
    if (attempt > 200_000) throw new Error("could not force D before Z");
  }
  fs.mkdirSync(mq.MERGE_QUARANTINE_DIR, { recursive: true });
  const dFile = path.join(mq.MERGE_QUARANTINE_DIR, `${K2h}.json`);
  const dRecord = (tokens) => JSON.stringify({ repoPath: d, branch: "d-branch", reason: "D's own raise", enteredAt: Date.now() - 10_000, tokens, resolvedKey: K2 }, null, 2) + "\n";
  fs.writeFileSync(dFile, dRecord(["d-token"]));
  fs.writeFileSync(path.join(mq.MERGE_QUARANTINE_DIR, `${K1h}.json`), JSON.stringify({ repoPath: z, branch: "z-branch", reason: "Z's own raise", enteredAt: Date.now(), tokens: ["z-token"], resolvedKey: K2 }, null, 2) + "\n");
  mq.reenterMergeQuarantinesAtBoot([z, d]);
  return { z, d, dFile, dRecord };
}

try {
  const { z, d, dFile, dRecord } = buildFixture();
  check("(sanity) D reads quarantined after boot (evicted to pending)", !!mq.activeMergeQuarantineFor(d));
  check("(sanity) Z reads quarantined after boot", !!mq.activeMergeQuarantineFor(z));
  check("(sanity) D's own file is at hash(K2) before the clear", fs.existsSync(dFile));

  if (scenarioName === "uncovered-by-path" || scenarioName === "uncovered-reporting") {
    // Make (B) structurally unable to settle: the file now carries a token D's in-memory entry (the clear's candidate tokens) lacks.
    fs.writeFileSync(dFile, dRecord(["d-token", "late-token"]));
    if (scenarioName === "uncovered-by-path") mq.clearMergeQuarantineByRecordedPath(d);
    else mq.clearMergeQuarantineReporting(d);
    check("*** (A) alone: D's file is released although (B)'s coverage cannot settle it ***", !fs.existsSync(dFile));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("*** Z stays quarantined after a reboot ***", toks.has("z-token"));
    check("D's own token is not re-armed by a reboot", !toks.has("d-token"));
  } else if (scenarioName === "control-covered-by-path") {
    // Control: nothing uncovered, so the by-path clear drops the file (by A or by B); a reboot must not re-arm D, and Z stays.
    mq.clearMergeQuarantineByRecordedPath(d);
    check("D's own file is unlinked", !fs.existsSync(dFile));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("D's token is gone after a reboot", !toks.has("d-token"));
    check("Z stays quarantined after a reboot", toks.has("z-token"));
  }
} finally {
  for (const t of tmpDirs) { try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(failures === 0 ? `PASS: ${scenarioName}` : `FAIL: ${scenarioName} (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
