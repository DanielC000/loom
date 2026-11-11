import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision b6f573cf — every `{id}` route clearMergeQuarantine hands back in `stillBlockedCoOccupants`
// must be FOLLOWABLE through clearMergeQuarantineLatchFile. An ACTIVE entry that physically co-owns a
// pending sharer's file used to be stamped with the pending id (the id of the shared file), which the
// by-id route refuses as ambiguous (fd189d91) — a dead route handed out as a working one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqb6f5-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqb6f5@loom -c user.name=mqb6f5";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqb6f5-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-b6f573cf (${tag})\n`);
  execSync(`git init -q && git config user.email mqb6f5@loom && git config user.name mqb6f5`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let moduleCounter = 0;
async function freshModule() {
  moduleCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleCounter}`);
}

/**
 * Y is a real repo; Y/a and Y/b are ABSENT subdirs. A corrupt `{` sits at hash(Key(Y)).json, so a boot
 * re-entry of [Y/a, Y/b] diverts both to pending placeholders sharing that one sourceFile. With
 * `activeY`, an ACTIVE entry for Y is then armed at the same hash. Returns the clear result for Y/b.
 */
async function build({ activeY }) {
  const mod = await freshModule();
  const y = makeRepo(activeY ? "ya" : "yp");
  const a = path.join(y, "a");
  const b = path.join(y, "b");
  // Each fixture gets a PRISTINE quarantine dir: earlier fixtures' latches must not leak into this one.
  fs.rmSync(mod.MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const F = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(y))}.json`);
  fs.writeFileSync(F, "{");
  mod.reenterMergeQuarantinesAtBoot([a, b]);
  if (activeY) mod.enterMergeQuarantine(y, "br", "Y real");
  const result = mod.clearMergeQuarantine(b);
  return { mod, y, a, b, F, result };
}

const idRolesOf = (cos, y, a) => cos.filter((c) => c.route.id !== undefined).map((c) => (c.repoPath === y ? "Y" : c.repoPath === a ? "Y/a" : c.repoPath));

/** An id is FOLLOWABLE iff clearing by it succeeds AND lifts/clears something (not a refusal, not a no-op). */
function followable(res) {
  return res.ok === true && ((res.liftedRepoPaths?.length ?? 0) > 0 || (res.releasedRepoPaths?.length ?? 0) > 0);
}

try {
  // ── S1: ACTIVE owner co-occupying a pending sharer's file ──────────────────────────────────────────
  {
    const { mod, y, a, result } = await build({ activeY: true });
    const cos = result.stillBlockedCoOccupants ?? [];
    // 613e4592 round 2: Y/a's own pending entry sits BEHIND the foreign ACTIVE Y at the shared key, so clearing Y/a cannot release it; the claimant
    // classification (own entries excluded) therefore discloses it as content-kept with Y as the blocker, not as a co-occupant with a releasing route.
    // Round 4: the oracle says Y/a IS blocked (its own entry), so it stays a LIVE co-occupant with its id-less {repoPath} route AND records Y as the blocker.
    check("S1 *** round 4 *** clear(Y/b) names BOTH Y and Y/a as still-blocked co-occupants, Y/a with blockedBy Y and NOT content-kept", cos.some((c) => c.repoPath === y) && cos.some((c) => c.repoPath === a && c.route.id === undefined && c.route.repoPath === a) && (result.contentKeptBlockedBy ?? []).some((e) => e.repoPath === a && e.blockedBy.repoPath === y) && !(result.contentKeptRepoPaths ?? []).includes(a));
    check("S1 *** round 4 *** the first result's reason renders the order: Y first, then Y/a", (() => { const r = result.reason ?? ""; const i = r.indexOf(`clear '${y}' first`); return i >= 0 && r.indexOf(`THEN clear '${a}'`) > i; })());
    {
      // FOLLOW every step in the order the result gives it (blocker Y, then Y/a), on a fresh fixture.
      const fx = await build({ activeY: true });
      const aCo = fx.result.stillBlockedCoOccupants.find((c) => c.repoPath === fx.a);
      const bb = fx.result.contentKeptBlockedBy.find((e) => e.repoPath === fx.a).blockedBy;
      for (const s of [bb, aCo.route]) { if (s.id) fx.mod.clearMergeQuarantineLatchFile(s.id); else fx.mod.clearMergeQuarantine(s.repoPath); }
      check("S1 *** round 4 *** following every step releases Y/a (oracle undefined, not quarantined)", fx.mod.stillBlockedEntryFor(fx.a) === undefined && fx.mod.assertRepoNotQuarantined(fx.a).ok === true);
    }
    for (const c of cos) check(`S1 ${path.basename(c.repoPath)} keeps a {repoPath} route`, c.route.repoPath === c.repoPath);
    const yCo = cos.find((c) => c.repoPath === y);
    check("S1 *** the ACTIVE owner Y is not handed a dead {id} route ***", yCo !== undefined && (yCo.route.id === undefined));
    // Followability of EVERY returned id, each on a fresh fixture (following one id mutates state).
    // This loop is EMPTY on purpose under the fix (no id is handed out); it is the tripwire that does
    // real work the moment a future change hands out an id again.
    check("S1 (intentional) no id is returned, so the follow loop below has nothing to follow", idRolesOf(cos, y, a).length === 0);
    const roleOf = (fx, rp) => (rp === fx.y ? "Y" : rp === fx.a ? "Y/a" : rp);
    const idRoles = idRolesOf(cos, y, a);
    for (const role of idRoles) {
      const fx = await build({ activeY: true });
      const co = fx.result.stillBlockedCoOccupants.find((c) => roleOf(fx, c.repoPath) === role);
      const followed = fx.mod.clearMergeQuarantineLatchFile(co.route.id);
      check(`S1 every returned {id} is FOLLOWABLE (${role})`, followable(followed));
    }
    // Neither co-occupant can be followed by id while Y is active at the same hash (the id is ambiguous).
    check("S1 no co-occupant carries a dead {id} (the shared id is ambiguous while Y is active)", cos.every((c) => c.route.id === undefined));
    // The {repoPath} route of the active owner really works.
    const fy = await build({ activeY: true });
    const byPath = fy.mod.clearMergeQuarantine(fy.y);
    check("S1 Y's {repoPath} route lifts Y", byPath.liftedRepoPaths.includes(fy.y));
  }

  // ── S2: pure pending sharer (no active owner) — the working id route must NOT regress ─────────────
  {
    const { mod, a, result } = await build({ activeY: false });
    const cos = result.stillBlockedCoOccupants ?? [];
    const aCo = cos.find((c) => c.repoPath === a);
    check("S2 the pending sharer Y/a is named as a co-occupant", aCo !== undefined);
    check("S2 *** the pending sharer keeps its {id} route ***", aCo !== undefined && typeof aCo.route.id === "string");
    if (aCo?.route.id) {
      const followed = mod.clearMergeQuarantineLatchFile(aCo.route.id);
      check("S2 following the pending sharer's id lifts it", followable(followed) && mod.assertRepoNotQuarantined(a).ok);
    }
  }

  // ── S3: the by-id clear's own pending branch (clearMergeQuarantineLatchFile) — same pattern? ────────
  // With an active owner sharing the id, the by-id route refuses before its pending branch runs (the
  // fd189d91 ambiguity), so that branch cannot build a co-occupant list for this shape. This checks a
  // PREMISE of the fix and passes on pre-fix code too; it is not itself a RED.
  {
    const { mod, y, a, b, F } = await build({ activeY: true });
    const refused = mod.clearMergeQuarantineLatchFile(path.basename(F, ".json"));
    check("S3 by-id clear on an active+pending-shared id is refused as ambiguous", refused.ok === false && /BOTH an active quarantine/.test(refused.reason));
    check("S3 the refusal cleared nothing", !mod.assertRepoNotQuarantined(y).ok && fs.existsSync(F));
    void a; void b;
  }

  // ── S4: relocatedCoOccupantsReason keeps the two-step warning in every id / no-id combination ───────
  // A dead id drops the ID, never the STEP (a single clear by repoPath does not lift both latches).
  {
    const mod = await freshModule();
    const X = "X-repo";
    const co = (routeId, keptId) => ({ repoPath: X, route: routeId ? { repoPath: X, id: routeId } : { repoPath: X }, alsoClear: keptId ? { repoPath: X, id: keptId } : { repoPath: X } });
    const both = mod.relocatedCoOccupantsReasonTestOnly([co("a".repeat(24), "b".repeat(24))]);
    check("S4 both ids followable: both named, FIRST/THEN", both.includes("a".repeat(24)) && both.includes("b".repeat(24)) && /FIRST/.test(both) && /THEN/.test(both));
    const deadKept = mod.relocatedCoOccupantsReasonTestOnly([co("a".repeat(24), undefined)]);
    check("S4 *** dead kept id: the second step and the re-quarantine warning are STILL rendered ***", /FIRST/.test(deadKept) && /THEN its OLD file/.test(deadKept) && /re-quarantined on the next restart/.test(deadKept) && deadKept.includes("a".repeat(24)));
    check("S4 dead kept id: never prints an undefined id", !/undefined/.test(deadKept));
    check("S4 *** dead kept id: factual, non-prescriptive — points at the list route, never says to clear another identity ***",
      /shared with another identity and cannot be followed by id/.test(deadKept) && /until that file is cleared/.test(deadKept)
      && deadKept.includes("GET /internal/merge-quarantine/list") && !/clear the other identity/.test(deadKept) && !/by repoPath\)/.test(deadKept));
    const deadRelocated = mod.relocatedCoOccupantsReasonTestOnly([co(undefined, "b".repeat(24))]);
    check("S4 dead relocated id: first step by repoPath, second by id", /clear 'X-repo' by repoPath FIRST/.test(deadRelocated) && deadRelocated.includes("b".repeat(24)) && !/undefined/.test(deadRelocated));
    const neither = mod.relocatedCoOccupantsReasonTestOnly([co(undefined, undefined)]);
    check("S4 neither id: both steps by repoPath/OLD file, warning kept", /FIRST/.test(neither) && /THEN its OLD file/.test(neither) && !/undefined/.test(neither));
  }

  console.log(failures === 0
    ? "\n✅ ALL SCENARIOS PASS — every {id} route clear returns is followable; the pure-pending-sharer id route still works."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces (or regresses the fix for) board card b6f573cf.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
