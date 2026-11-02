import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 59e758e5, CR round 1 finding B1 (CRITICAL, triple fault). 0a9fc7fc's own unconditional
// unlink of writePendingDivertFile's stranded tmp (on a failed rename) ran regardless of whether a
// caller's own safety-tmp fallback ever got a chance to secure that content elsewhere. Under a TRIPLE
// fault — the rename AND the fallback's own `.tmp-safety-...` write ALSO failing (e.g. ENOSPC) — the
// unlink deleted the LAST durable copy before the fallback could even be attempted, a genuine data-loss
// fail-open: (A) a second raise's own newly-added token was lost on reboot; (B) a first raise's own
// ENTIRE identity went fully unblocked on reboot. The pre-0a9fc7fc control (never unlinking) kept both
// armed as a fail-closed duplicate.
//
// @decision 59e758e5 — a stranded tmp must never be unlinked before something secures its content
// elsewhere: unlinking it first, on a triple fault, is a real data-loss fail-open, not a cleanup.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-59e758e5-triple-fault-no-loss.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq59e758-tf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR } = mod;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID_TFC = "-c user.email=mq59e758tfc@loom -c user.name=mq59e758tfc";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Forces BOTH the primary rename AND the safety-tmp fallback's own write to fail — the TRIPLE fault this
// finding is about. `suppressUnlink`, when true, additionally suppresses every ordinary (non-safety)
// stranded-tmp unlink — the reviewer's PRE-UNLINK CONTROL shape, standing in for the pre-0a9fc7fc code
// this probes against, to confirm the EXPECTED (no-loss) outcome is reachable by never unlinking at all.
function injectTripleFault({ suppressUnlink = false } = {}) {
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  const realUnlink = fs.unlinkSync;
  let renameHits = 0;
  let openHits = 0;
  fs.renameSync = () => { renameHits++; throw Object.assign(new Error("EPERM: simulated triple-fault rename failure"), { code: "EPERM" }); };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(".tmp-safety-")) {
      openHits++;
      throw Object.assign(new Error("ENOSPC: simulated triple-fault safety-tmp open failure"), { code: "ENOSPC" });
    }
    return realOpen(p, ...rest);
  };
  if (suppressUnlink) {
    fs.unlinkSync = (p) => {
      if (/\.json\.tmp-\d+-[0-9a-f]+$/.test(String(p))) return; // suppressed — pre-0a9fc7fc control shape
      return realUnlink(p);
    };
  }
  return {
    restore: () => { fs.renameSync = realRename; fs.openSync = realOpen; fs.unlinkSync = realUnlink; },
    hits: () => [renameHits, openHits],
  };
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A ("59e758e5-tf-a-mergeTokenIntoPendingEntries") — a SECOND raise on an always-unresolvable
// identity, triple-faulted. Pre-fix (9eb54fef/32f32040): t2 is genuinely lost on reboot (0a9fc7fc's own
// unlink deletes the only durable copy before the fallback, which itself fails, can secure it elsewhere).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq59e758tf-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/tf-a-1", "59e758e5-tf-a: first raise (t1)");

  const inject = injectTripleFault();
  let t2;
  try {
    t2 = enterMergeQuarantine(d, "loom/tf-a-2", "59e758e5-tf-a: second raise (t2), triple fault");
  } finally {
    inject.restore();
  }
  check("(tf-a precondition) both the rename AND the safety-tmp fallback's own write were actually forced to fail", JSON.stringify(inject.hits()) === JSON.stringify([1, 1]));
  check("(tf-a precondition) t2 is tracked in-memory right now, alongside t1", (mod.activeMergeQuarantineFor(d)?.tokens ?? []).includes(t1) && (mod.activeMergeQuarantineFor(d)?.tokens ?? []).includes(t2));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const allTokensAfterReboot = new Set(rb.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE CLAIM (tf-a) *** t1 survives a triple fault, across a reboot", allTokensAfterReboot.has(t1));
  check("*** B1 FIX (tf-a) *** t2 ALSO survives a triple fault, across a reboot — the stranded tmp was kept, never unlinked, until something could secure it (nothing did, so it stays as the accepted fail-closed duplicate)", allTokensAfterReboot.has(t2));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B ("59e758e5-tf-b-mintPendingDivert") — a FIRST-EVER raise on an always-unresolvable
// identity, triple-faulted. Pre-fix: the identity is fully UNBLOCKED on reboot (nothing durable was ever
// kept at all) — the worse of the two measured shapes.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq59e758tf-b-never-exists-${freshSfx()}`);

  const inject = injectTripleFault();
  let t1;
  try {
    t1 = enterMergeQuarantine(d, "loom/tf-b-1", "59e758e5-tf-b: first-ever raise, triple fault");
  } finally {
    inject.restore();
  }
  check("(tf-b precondition) both the rename AND the safety-tmp fallback's own write were actually forced to fail", JSON.stringify(inject.hits()) === JSON.stringify([1, 1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  check("*** THE CLAIM (tf-b) *** t1 survives a triple fault on the FIRST-EVER raise, across a reboot", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t1)));
  check("*** B1 FIX (tf-b) *** the identity is STILL blocked after reboot — not fully unblocked", rb.resolveQuarantineForTestOnly(d));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO C ("59e758e5-tf-c-divertRaiseEntry") — CR round 2 (reviewer 6aee1d61): scenario A/B above only
// cover `mergeTokenIntoPendingEntries`/`mintPendingDivert`'s own triple-fault-keep branches — neither
// exercises `divertRaiseEntry`'s OWN matched-indices branch (lines ~4342-4347), reached only when a
// VERIFIED (resolvable) repoPath must divert on EVERY raise (never the plain-unresolvable shape A/B
// use) and a pending record for it already exists. The reviewer's own mutant — adding an unlink to that
// one triple-fault `else` branch — passed all 13 pre-existing test files untouched (probe10); this
// scenario closes that gap directly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // A clean slate: tf-a/tf-b's own leftover residue in the SAME shared MERGE_QUARANTINE_DIR must never
  // interfere with this scenario's own hash-keyed lookups.
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  const y = path.join(os.tmpdir(), `loom-mq59e758tf-c-y-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  fs.writeFileSync(path.join(y, "README.md"), "# 59e758e5-tf-c\n");
  execSync("git init -q && git config user.email mq59e758tfc@loom && git config user.name mq59e758tfc", { cwd: y });
  commitAll(y, "init", GIT_ID_TFC);

  const Ky = canonicalRepoLockKey(y);
  const yFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Ky).digest("hex").slice(0, 24)}.json`);

  // Forces every read of y's OWN canonical key file to fail (EACCES) — "unknown", never confirmed safe
  // to overwrite — so EVERY raise on y must divert, even though y is fully VERIFIED/resolvable.
  const realReadFileSync = fs.readFileSync;
  const withForcedUnreadableFinal = (fn) => {
    fs.readFileSync = (p, ...rest) => {
      if (p === yFinalPath) throw Object.assign(new Error("EACCES: simulated read failure"), { code: "EACCES" });
      return realReadFileSync(p, ...rest);
    };
    try { return fn(); } finally { fs.readFileSync = realReadFileSync; }
  };

  const findSourceFileForY = () => fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === y; } catch { return false; }
  });

  const t1 = withForcedUnreadableFinal(() => enterMergeQuarantine(y, "loom/tf-c-1", "59e758e5-tf-c: first raise, verified but forced to divert"));
  const base1 = findSourceFileForY();
  check("(tf-c precondition) y's first diverted raise minted its own pending-divert record", typeof base1 === "string");
  const base1Path = path.join(MERGE_QUARANTINE_DIR, base1);

  // y's SECOND raise: ALSO forced to divert (same unreadable-final EACCES), landing in
  // `divertRaiseEntry`'s own MATCHED-indices branch (base1 already exists) — triple-fault it (the
  // matched write's own rename AND its safety-tmp fallback's own open both fail).
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let renameHits2 = 0, safetyHits2 = 0;
  fs.renameSync = (a, b) => { if (b === base1Path) { renameHits2++; throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" }); } return realRename(a, b); };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(".tmp-safety-")) { safetyHits2++; throw Object.assign(new Error("ENOSPC: simulated safety-tmp open failure"), { code: "ENOSPC" }); }
    return realOpen(p, ...rest);
  };
  let t2;
  try {
    t2 = withForcedUnreadableFinal(() => enterMergeQuarantine(y, "loom/tf-c-2", "59e758e5-tf-c: second raise, verified but forced to divert, triple fault"));
  } finally {
    fs.renameSync = realRename;
    fs.openSync = realOpen;
  }
  check("(tf-c precondition) the matched-branch rewrite's own rename AND its safety-tmp fallback were both forced to fail", renameHits2 >= 1 && safetyHits2 >= 1);
  // @decision 59e758e5 (round 3) — deliberately NOT calling `activeMergeQuarantineFor` here: on a
  // VERIFIED repoPath its own "lazy re-resolve on first query" self-heal durably migrates the pending
  // record the instant it's asked, masking the exact triple-fault loss this scenario proves.

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const allTokensAfterRebootC = new Set(rb.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("*** THE CLAIM (tf-c) *** t1 survives a triple fault at divertRaiseEntry's own matched branch, across a reboot", allTokensAfterRebootC.has(t1));
  check("*** B1 FIX (tf-c) *** t2 ALSO survives — divertRaiseEntry's own matched-branch triple fault keeps the stranded tmp, never unlinks it", allTokensAfterRebootC.has(t2));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PRE-UNLINK CONTROL (reviewer's own shape) — the SAME two constructions, but with the ordinary
// stranded-tmp unlink ALSO suppressed (standing in for pre-0a9fc7fc code): confirms the EXPECTED,
// no-loss outcome is genuinely reachable by "never unlink", not an artifact of this control's own
// construction. B1's real fix achieves the SAME outcome by deferring the unlink, never suppressing it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq59e758tf-ctrl-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/tf-ctrl-a-1", "59e758e5-tf-ctrl-a: first raise (t1)");
  const inject = injectTripleFault({ suppressUnlink: true });
  let t2;
  try {
    t2 = enterMergeQuarantine(d, "loom/tf-ctrl-a-2", "59e758e5-tf-ctrl-a: second raise (t2), triple fault, unlink suppressed");
  } finally {
    inject.restore();
  }
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const allTokens = new Set(rb.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("(pre-unlink control, scenario-A shape) both t1 and t2 survive when the stranded tmp is never unlinked at all", allTokens.has(t1) && allTokens.has(t2));
}
{
  const d = path.join(os.tmpdir(), `loom-mq59e758tf-ctrl-b-never-exists-${freshSfx()}`);
  const inject = injectTripleFault({ suppressUnlink: true });
  let t1;
  try {
    t1 = enterMergeQuarantine(d, "loom/tf-ctrl-b-1", "59e758e5-tf-ctrl-b: first-ever raise, triple fault, unlink suppressed");
  } finally {
    inject.restore();
  }
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  check("(pre-unlink control, scenario-B shape) t1 survives and the identity stays blocked when the stranded tmp is never unlinked at all", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t1)) && rb.resolveQuarantineForTestOnly(d));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a triple fault (rename AND the safety-tmp fallback's own write both failing) never loses a token, on the first raise (mintPendingDivert) or a later one (mergeTokenIntoPendingEntries): the stranded tmp is kept until something secures its content, never unlinked first."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
