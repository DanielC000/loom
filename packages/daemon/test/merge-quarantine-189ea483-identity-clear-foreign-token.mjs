import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 189ea483 — a human identity-scoped clear stranding a foreign orphan's own token share is BY
// DESIGN, not a defect: always disclosed, never silent, and recoverable via a token clear or a direct
// clear of the orphan — never widen an identity-scoped clear to sweep by token value to "fix" this.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq189ea-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq189ea@loom -c user.name=mq189ea";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq189ea-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-189ea483 (${tag})\n`);
  execSync(`git init -q && git config user.email mq189ea@loom && git config user.name mq189ea`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 1dd00dca's/028837ad's/5d0820c7's/97a5b64f's own test files: fold `orphanBasename`
// into `repoPath`'s own on-disk final JSON BEFORE `orphanBasename` itself exists.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule, extra = {}) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (a) A active; orphan O (unresolvable) holds [tA, tF] via A's own orphanLatchFiles back-reference.
  // Human clearMergeQuarantine(A) — lift-by-identity, never by-token. Pins: A is fully/durably lifted; O
  // is STRANDED holding BOTH tokens, in-process AND after a reboot; the strand is NEVER silent — the
  // production route (clearMergeQuarantineReporting, the real handler behind POST
  // /internal/merge-quarantine/clear) composes a `reason` that NAMES O and the remediation.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (a) human identity-clear strands a foreign orphan's token, but discloses it ===");
  let O_a, tA_a, tF_a, orphanBasename_a;
  {
    const A = makeRepo("a-a");
    tA_a = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (189ea483 scenario a)");
    orphanBasename_a = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    check("(a) precondition: A is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A)?.orphanLatchFiles ?? []).includes(orphanBasename_a));

    O_a = path.join(os.tmpdir(), `loom-mq189ea-orphan-o-a-never-exists-${freshSfx()}`);
    tF_a = randomUUID();
    writeOrphanContent(orphanBasename_a, O_a, "loom/o-branch", "merge in progress for O (189ea483 scenario a)", [tA_a, tF_a], booted);
    check("(a) precondition: O is unresolvable", !fs.existsSync(O_a));

    const reportingResult = booted.clearMergeQuarantineReporting(A);
    check("(a) A's own quarantine is reported lifted via the PRODUCTION route", reportingResult.wasQuarantined === true && reportingResult.liftedRepoPaths.includes(A));
    check("(a) A reads genuinely unquarantined afterward", booted.assertRepoNotQuarantined(A).ok === true);

    const oEntry = booted.activeMergeQuarantineFor(O_a);
    check("*** STRAND (a) *** O's foreign union STILL holds BOTH tA and tF after A's identity-scoped clear — not reduced",
      !!oEntry && oEntry.tokens.includes(tA_a) && oEntry.tokens.includes(tF_a) && oEntry.tokens.length === 2);

    // *** THE DISCLOSURE ASSERTION — matches a STABLE substring of the composed reason, never the full
    // prose (which is free to reword): it must NAME the orphan's own repoPath and point at the
    // clear-by-path/clear-by-id remediation route.
    check("*** DISCLOSED, NEVER SILENT (a) *** clearMergeQuarantineReporting's own `reason` names O and the remediation route",
      typeof reportingResult.reason === "string"
        && reportingResult.reason.includes(O_a)
        && reportingResult.reason.includes("clear-by-path")
        && reportingResult.latchKept === true);

    // Durability leg: an independent reboot re-derives the SAME strand from disk alone.
    const freshRightAfter = await freshBootModule();
    freshRightAfter.reenterMergeQuarantinesAtBoot([A, O_a]);
    const oEntryPostReboot = freshRightAfter.activeMergeQuarantineFor(O_a);
    check("*** DURABLE STRAND (a) *** a reboot taken right after A's identity-clear agrees — O still holds [tA,tF] on disk too",
      !!oEntryPostReboot && oEntryPostReboot.tokens.includes(tA_a) && oEntryPostReboot.tokens.includes(tF_a) && oEntryPostReboot.tokens.length === 2);
    check("(a) A itself reads genuinely unquarantined after the SAME reboot", freshRightAfter.assertRepoNotQuarantined(A).ok === true);
  }
} catch (e) {
  console.error("(a) THREW:", e);
  failures++;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (a-control) POSITIVE CONTROL for (a)'s disclosure assertion: a PLAIN clear with no foreign co-occupant
  // at all must NOT compose a co-occupant-naming reason — proves the assertion in (a) can genuinely FAIL,
  // not just happen to pass on any output. Never a latchKept, never a reason mentioning any OTHER repo.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (a-control) positive control — no co-occupant means no disclosure to find ===");
  {
    const A = makeRepo("a-control");
    enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (189ea483 scenario a-control, no co-occupant)");
    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const plainResult = booted.clearMergeQuarantineReporting(A);
    check("(a-control) A's own quarantine is lifted, same as scenario (a)", plainResult.wasQuarantined === true && plainResult.liftedRepoPaths.includes(A));
    check("*** CONTROL (a-control) *** with no foreign co-occupant, the result carries NO latchKept and an empty stillBlockedCoOccupants — proving (a)'s own disclosure assertion is not vacuous",
      plainResult.latchKept !== true && (plainResult.stillBlockedCoOccupants ?? []).length === 0);
    check("*** CONTROL (a-control) *** and the reason (if any) is empty/absent, never a co-occupant-shaped message",
      plainResult.reason === undefined || plainResult.reason === "");
  }
} catch (e) {
  console.error("(a-control) THREW:", e);
  failures++;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (b) THE LIVE-RAISER RECOURSE: after the human's identity-clear already stranded O, A's own raiser
  // later calls clearMergeQuarantineByToken(A, tA) — a TOKEN-value match, identity-independent — and
  // reaches O via the pre-loop pending pass, reducing it to [tF] only. O's own later clear(tF) then fully
  // lifts it: no permanent strand once this recourse is actually exercised.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (b) live-raiser recourse: clearMergeQuarantineByToken still reaches O ===");
  {
    const A = makeRepo("b-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (189ea483 scenario b)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);
    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const O = path.join(os.tmpdir(), `loom-mq189ea-orphan-o-b-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, O, "loom/o-branch", "merge in progress for O (189ea483 scenario b)", [tA, tF], booted);

    booted.clearMergeQuarantine(A); // the human identity-clear, strands O exactly as in (a)
    check("(b) precondition: O is stranded holding [tA,tF] exactly like scenario (a)", (booted.activeMergeQuarantineFor(O)?.tokens ?? []).length === 2);

    booted.clearMergeQuarantineByToken(A, tA);
    const oEntryAfterTokenClear = booted.activeMergeQuarantineFor(O);
    check("*** RECOURSE (b) *** a LIVE raiser's clearMergeQuarantineByToken(A,tA) reaches O via the pre-loop pending pass, reducing it to [tF] only",
      !!oEntryAfterTokenClear && oEntryAfterTokenClear.tokens.length === 1 && oEntryAfterTokenClear.tokens[0] === tF);

    booted.clearMergeQuarantineByToken(O, tF);
    check("*** NO PERMANENT STRAND (b) *** O's own later clear(tF) fully lifts it", booted.assertRepoNotQuarantined(O).ok === true);
  }
} catch (e) {
  console.error("(b) THREW:", e);
  failures++;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (c) THE DEAD-RAISER RECOURSE: nobody ever calls clearMergeQuarantineByToken(A,tA). A human recovers
  // the strand by clearing O DIRECTLY, via each of the three human routes — clearMergeQuarantine (routes
  // to clear-by-recorded-path since O is unresolvable), clearMergeQuarantineByRecordedPath called
  // directly, and clearMergeQuarantineLatchFile (clear-by-id, addressed at O's own latch file).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (c) dead-raiser recourse: clearing O directly, via each human route ===");

  async function buildStrandedO(tag) {
    const A = makeRepo(`c-${tag}-a`);
    const tA = enterMergeQuarantine(A, "loom/a-branch", `merge in progress for A (189ea483 scenario c-${tag})`);
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);
    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const O = path.join(os.tmpdir(), `loom-mq189ea-orphan-o-c-${tag}-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, O, "loom/o-branch", `merge in progress for O (189ea483 scenario c-${tag})`, [tA, tF], booted);

    booted.clearMergeQuarantine(A); // human identity-clear, strands O
    return { booted, A, O, tA, tF, orphanBasename };
  }

  {
    const { booted, O } = await buildStrandedO("identity");
    const result = booted.clearMergeQuarantine(O); // unresolvable O routes internally to clear-by-recorded-path
    check("*** RECOURSE (c, clearMergeQuarantine on O directly) *** fully lifts O — both tokens gone",
      result.wasQuarantined === true && booted.assertRepoNotQuarantined(O).ok === true);
  }
  {
    const { booted, O } = await buildStrandedO("byrecordedpath");
    const result = booted.clearMergeQuarantineByRecordedPath(O);
    check("*** RECOURSE (c, clearMergeQuarantineByRecordedPath on O directly) *** fully lifts O — both tokens gone",
      result.wasQuarantined === true && booted.assertRepoNotQuarantined(O).ok === true);
  }
  {
    const { booted, O, orphanBasename } = await buildStrandedO("byid");
    const id = orphanBasename.replace(/\.json$/, "");
    const result = booted.clearMergeQuarantineLatchFile(id);
    check("*** RECOURSE (c, clearMergeQuarantineLatchFile by O's own id) *** fully lifts O — both tokens gone",
      result.ok === true && result.wasQuarantined === true && booted.assertRepoNotQuarantined(O).ok === true);
  }
} catch (e) {
  console.error("(c) THREW:", e);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a human identity-scoped clear strands (but always discloses) a foreign "
    + "orphan's share of the cleared token; recoverable via a live raiser's own by-token clear, or a "
    + "human clearing the orphan's own identity directly, via any of the three human clear routes."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces (or regresses the documented by-design behavior of) board card 189ea483.`);
process.exitCode = failures === 0 ? 0 : 1;
