import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a090d65c — a token clear whose durable tombstone was WITHHELD (a kept file still physically holds the token) must
// say `durable:false`: the in-process lift is real, but a reboot re-arms the token. Found by card ab04d8ab's fuzz (seed 2160).
//
// Fixture: a pending claimant Z (unresolvable path) whose ONLY latch file is `<hash(K(W))>.json`, i.e. W's own key file
// (W = a real repo). `clearMergeQuarantine(W)` keeps that file (`latchKept`, Z still depends on it), then Z's tokens are
// cleared by token.
//   full   : clear path W, clear Z-t0, clear Z-t1  -> both token results durable:false; Z unblocked in-process; reboot re-blocks Z
//   nobt0  : clear path W, clear Z-t1 only         -> durable:false; reboot re-blocks Z with BOTH tokens (Z-t1 comes back)
//   nopath : NO clear path W (control)             -> file removed + tombstoned: `durable` ABSENT on both, reboot gives Z unblocked
//
// Not covered: a REAL process restart (the "reboot" re-imports the module with a cache-busting query, so module state is
// rebuilt from disk but the process is the same); whether `durable:false` also appears for a foreign co-occupant holding the
// token (same code path, not separately pinned here).
//
// Each scenario runs in its own child process with its own fresh LOOM_HOME. Run: node test/merge-quarantine-a090d65c-withheld-tombstone-is-not-durable.mjs
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
const SCENARIOS = ["full", "nobt0", "nopath"];
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
useOwnLoomHome(`loom-mqa09-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mq = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const h24 = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
let reboots = 0;
const freshBoot = async () => import(`${href}?b=${++reboots}`);

const w = fs.mkdtempSync(path.join(os.tmpdir(), "mqa09-w-"));
fs.writeFileSync(path.join(w, "r.md"), "x");
execSync("git init -q && git config user.email a@b && git config user.name a && git add . && git commit -qm i", { cwd: w });
const z = path.join(w, "gone-c");
const wKey = canonicalRepoLockKey(w);
fs.mkdirSync(mq.MERGE_QUARANTINE_DIR, { recursive: true });
const wFile = path.join(mq.MERGE_QUARANTINE_DIR, `${h24(wKey)}.json`);
fs.writeFileSync(wFile, JSON.stringify({ repoPath: z, branch: "b-Z", reason: "probe", enteredAt: Date.now(), tokens: ["Z-t0", "Z-t1"] }, null, 2) + "\n");
mq.reenterMergeQuarantinesAtBootTestOnly([], []);

const blockedTokens = (m) => { const e = m.stillBlockedEntryFor(z); return e ? [...e.tokens].sort() : null; };
check("fixture: Z is blocked by both tokens after boot", JSON.stringify(blockedTokens(mq)) === JSON.stringify(["Z-t0", "Z-t1"]));

if (scenarioName !== "nopath") {
  const r = mq.clearMergeQuarantine(w);
  check("clear path W keeps Z's file and discloses it (latchKept)", r.latchKept === true && r.referencingRepoPaths?.includes(z));
}
let results;
if (scenarioName === "nobt0") results = [mq.clearMergeQuarantineByToken(w, "Z-t1")];
else results = [mq.clearMergeQuarantineByToken(w, "Z-t0"), mq.clearMergeQuarantineByToken(w, "Z-t1")];

const m2 = await freshBoot();
m2.reenterMergeQuarantinesAtBootTestOnly([], []);
const post = (() => { const e = m2.stillBlockedEntryFor(z); return e ? [...e.tokens].sort() : null; })();

if (scenarioName === "full") {
  check("every token result is lifted:true", results.every((r) => r.lifted === true && r.matched === true));
  check("*** every token result says durable:false ***", results.every((r) => r.durable === false));
  check("Z reads unblocked in-process", blockedTokens(mq) === null);
  check("*** a reboot re-blocks Z with both tokens (the in-process lift did not survive) ***", JSON.stringify(post) === JSON.stringify(["Z-t0", "Z-t1"]));
} else if (scenarioName === "nobt0") {
  check("the Z-t1 result is lifted:true", results[0].lifted === true && results[0].matched === true);
  check("*** the Z-t1 result says durable:false ***", results[0].durable === false);
  check("Z is still blocked in-process by Z-t0 only", JSON.stringify(blockedTokens(mq)) === JSON.stringify(["Z-t0"]));
  check("*** a reboot re-arms BOTH tokens, including the cleared Z-t1 ***", JSON.stringify(post) === JSON.stringify(["Z-t0", "Z-t1"]));
} else {
  check("control: every token result is lifted:true", results.every((r) => r.lifted === true && r.matched === true));
  check("*** control: `durable` is ABSENT (nothing withheld) ***", results.every((r) => !("durable" in r)));
  check("control: Z reads unblocked in-process", blockedTokens(mq) === null);
  check("control: a reboot leaves Z unblocked", post === null);
  check("control: the file is gone", !fs.existsSync(wFile));
}

process.exit(failures === 0 ? 0 : 1);
