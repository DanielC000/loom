// Hermetic unit test for card 31f997e7: skills/inject.ts's generic capability-bound-skill delivery gate.
// The full CR history lives in docs/decisions/31f997e7-*.md — not restated here. The contract this file
// proves:
// injectSkills(cwd, sid, subset, role, obsidianEnabled, isSessionLive, grantedCapabilities, capabilityBindings):
//   - a skill named in capabilityBindings is withheld from the no-subset deliver-all default unless BOTH
//     (a) cwd is worktree-isolated (isWorktreeCwd) AND (b) grantedCapabilities includes its slug;
//   - an EXPLICIT non-empty subset naming a bound skill still delivers it, bypassing BOTH checks;
//   - a skill NOT in capabilityBindings is byte-identical regardless of grantedCapabilities/cwd;
//   - capabilityBindings is read via Object.hasOwn, never bracket access (no prototype leak);
//   - the locked-role provenance filter and the capability gate are a real AND, not an OR;
//   - isWorktreeCwd is a precise ancestor check (not a naive string-prefix match) against WORKTREES_DIR,
//     correct in BOTH directions (rejects every near-miss, accepts a genuine "..foo"-named descendant);
//   - in an isolated cwd, a dead session's manifest-claimed dirs (ALL of them, not just bound ones) are
//     cleaned up, closing the worktree-reuse orphan — but ONLY when the dir's current content fingerprint
//     still matches what Loom recorded at placement; a hand edit, an added file, or a legacy claim with
//     no recorded fingerprint all skip the delete and survive; a dir never recorded in any session's
//     manifest (a user/repo skill) is never even a candidate;
//   - resume re-evaluates the gate and prunes via the EXISTING myPrev-vs-want loop;
//   - the subset path's interaction with the locked-role provenance filter (509176c8) is unchanged;
//   - a cheap source-text + behavioral check that the legacy browserTesting flag reaches injectSkills as
//     the "browser-testing" slug via host.ts's createPty wiring.
//
// useOwnLoomHome sets up a managed temp LOOM_HOME with guaranteed cleanup; WORKTREES_DIR (a SIBLING of
// LOOM_HOME, not nested under it) is separately registered for the same cleanup. dist is imported only
// AFTER useOwnLoomHome, per the load-bearing import-ordering rule.
// Run after build: node test/skills-capability-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

useOwnLoomHome("loom-cap-bound-");
const { injectSkills } = await import("../dist/skills/inject.js");
const { writeSkill } = await import("../dist/skills/store.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");
const { resolveProfileCapabilities } = await import("@loom/shared");

registerForCleanup(WORKTREES_DIR); // a sibling of LOOM_HOME, not nested under it — clean it up too

const skillsDir = path.join(process.env.LOOM_HOME, "skills");
fs.mkdirSync(skillsDir, { recursive: true });

const skillMd = (name) => `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n`;

// Store: a plain unbound control skill + a skill we'll bind via the test-injected override (NOT the real
// shipped CAPABILITY_BOUND_SKILLS map, which stays empty in this card — see inject.ts).
for (const n of ["plain-skill", "bound-skill"]) {
  fs.mkdirSync(path.join(skillsDir, n), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), skillMd(n));
}

const BINDINGS = { "bound-skill": "needs-slug" };

const readDelivered = (cwd) => {
  const dir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n !== ".loom-skills.json" && n !== ".loom-skills-fingerprints.json").sort();
};
const readManifestClaims = (cwd, sid) => {
  const p = path.join(cwd, ".claude", "skills", ".loom-skills.json");
  if (!fs.existsSync(p)) return [];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  return m[sid] ?? [];
};
// CR round 3: fingerprints live in a SEPARATE sidecar file, never merged into the manifest's own shape.
const readManifestFingerprint = (cwd, sid, name) => {
  const p = path.join(cwd, ".claude", "skills", ".loom-skills-fingerprints.json");
  if (!fs.existsSync(p)) return undefined;
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  return m[sid]?.[name];
};

// Two kinds of fresh cwd: an ISOLATED one, nested under the REAL WORKTREES_DIR (mirrors a real worker's
// `cwd: worktreePath` — isWorktreeCwd() === true), and a SHARED one that is NOT (mirrors
// `project.repoPath` — every manager/platform/setup/auditor/plain/assistant session).
let seq = 0;
const isolatedCwd = (sub) => { const d = path.join(WORKTREES_DIR, "proj", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sharedCwd = (sub) => { const d = path.join(process.env.LOOM_HOME, "shared-cwds", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };

try {
  // --- (1) a granted worker in its OWN worktree DOES receive the bound skill. --------------------------
  {
    const cwd = isolatedCwd("case1-granted-isolated");
    injectSkills(cwd, "sess1", null, "worker", false, undefined, ["needs-slug"], BINDINGS);
    const d = readDelivered(cwd);
    check("(1) granted + isolated worktree cwd: bound-skill delivered", d.includes("bound-skill"));
    check("(1) granted + isolated worktree cwd: unbound control still delivered", d.includes("plain-skill"));
  }

  // --- (2) a granted SHARED-cwd session does NOT receive the bound skill, no matter the grant —
  //     isolation is required on top of it. -------------------------------------------------------------
  {
    const cwd = sharedCwd("case2-granted-shared");
    injectSkills(cwd, "sess2", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    const d = readDelivered(cwd);
    check("(2) granted + SHARED cwd: bound-skill ABSENT (isolation required even when granted)", !d.includes("bound-skill"));
    check("(2) granted + SHARED cwd: unbound control still delivered (unaffected)", d.includes("plain-skill"));
  }

  // --- (3) ungranted + isolated cwd: still absent (the grant check still applies when isolated). --------
  {
    const cwd = isolatedCwd("case3-ungranted-isolated");
    injectSkills(cwd, "sess3", null, "worker", false, undefined, [], BINDINGS);
    check("(3) ungranted + isolated worktree cwd: bound-skill ABSENT", !readDelivered(cwd).includes("bound-skill"));
  }

  // --- (4)-(5) an EXPLICIT subset naming the bound skill bypasses BOTH checks — granted or not, isolated
  //     or not (tested at a SHARED cwd specifically, since that's the interesting case: subset is the one
  //     path that can still deliver a bound skill into a shared cwd — see "what remains" in the record). -
  {
    const cwd = sharedCwd("case4-granted-subset-shared");
    injectSkills(cwd, "sess4", ["bound-skill"], "manager", false, undefined, ["needs-slug"], BINDINGS);
    check("(4) granted + subset naming it + SHARED cwd: delivered (subset bypasses isolation too)", readDelivered(cwd).includes("bound-skill"));
  }
  {
    const cwd = sharedCwd("case5-ungranted-subset-shared");
    injectSkills(cwd, "sess5", ["bound-skill"], "manager", false, undefined, [], BINDINGS);
    check("(5) ungranted + subset naming it + SHARED cwd: delivered anyway (subset wins over both checks)", readDelivered(cwd).includes("bound-skill"));
  }

  // --- (6) default params (grantedCapabilities/capabilityBindings both omitted) == today's behavior, via
  //     the REAL (empty) shipped map: nothing is gated, byte-identical to before this card, even at a
  //     SHARED cwd (isolation only matters once a skill is actually bound). -------------------------------
  {
    const cwd = sharedCwd("case6-real-default-map");
    injectSkills(cwd, "sess6", null, "manager");
    const d = readDelivered(cwd);
    check("(6) omitted grantedCapabilities/capabilityBindings, SHARED cwd: bound-skill still delivered (real map is empty)", d.includes("bound-skill"));
    check("(6) omitted grantedCapabilities/capabilityBindings: plain-skill still delivered", d.includes("plain-skill"));
  }

  // --- (7) resume re-evaluation + pruning, at an ISOLATED (worker) cwd throughout — the SAME session,
  //     re-injected after the skill becomes bound and this session's pinned grants don't cover it, loses
  //     the skill via the EXISTING myPrev-vs-want prune loop (no new pruning mechanism). ------------------
  {
    const cwd = isolatedCwd("case7-resume-prune");
    // First "spawn": no binding at all yet (today's unbound world) — bound-skill delivered like any other.
    injectSkills(cwd, "sess7", null, "worker", false, undefined, [], {});
    check("(7) pre-binding spawn: bound-skill delivered", readDelivered(cwd).includes("bound-skill"));
    check("(7) pre-binding spawn: manifest claims it", readManifestClaims(cwd, "sess7").includes("bound-skill"));
    // "Resume" (same cwd, same session id) after an upgrade adds the binding — this session's own grants
    // (still []) don't cover it.
    injectSkills(cwd, "sess7", null, "worker", false, undefined, [], BINDINGS);
    const dAfter = readDelivered(cwd);
    check("(7) resume after binding added, still ungranted: bound-skill PRUNED from disk", !dAfter.includes("bound-skill"));
    check("(7) resume: manifest no longer claims it", !readManifestClaims(cwd, "sess7").includes("bound-skill"));
    check("(7) resume: unbound control untouched", dAfter.includes("plain-skill"));
  }

  // --- (8) a store skill literally named "constructor" is NOT wrongly withheld. Exercises the REAL
  //     shipped (empty) CAPABILITY_BOUND_SKILLS map — a bracket-access bug
  //     (`capabilityBindings["constructor"]`) would resolve to Object's own constructor function (truthy,
  //     not undefined) and wrongly withhold it even though nothing binds it; Object.hasOwn must read it as
  //     genuinely absent. ------------------------------------------------------------------------------
  {
    fs.mkdirSync(path.join(skillsDir, "constructor"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "constructor", "SKILL.md"), skillMd("constructor"));
    const cwd = sharedCwd("case8-constructor-prototype");
    injectSkills(cwd, "sess8", null, "manager"); // default params — the REAL empty map, no override
    check('(8) a store skill named "constructor" is delivered under the real empty map (not prototype-leaked)', readDelivered(cwd).includes("constructor"));
  }

  // --- (9) the locked-role provenance filter and the capability gate are a real AND, not an OR — an
  //     AGENT-STAMPED bound skill stays withheld from a locked role even when BOTH the isolation check
  //     AND the grant would otherwise pass it. Uses an isolated cwd + a real grant specifically so
  //     passesCapabilityGate() alone WOULD succeed, isolating that it's the provenance check that fires. --
  {
    writeSkill("agent-bound-skill", skillMd("agent-bound-skill"), "agent"); // mirrors skillWriteData's user-skill branch
    const AGENT_BINDINGS = { "agent-bound-skill": "needs-slug-2" };
    const cwd = isolatedCwd("case9-locked-role-and-gate");
    injectSkills(cwd, "sess9", null, "assistant", false, undefined, ["needs-slug-2"], AGENT_BINDINGS); // "assistant" is a LOCKED_PROFILE_ROLES member
    check("(9) locked role + isolated cwd + granted + agent-stamped bound skill: still WITHHELD (AND, not OR)", !readDelivered(cwd).includes("agent-bound-skill"));
  }

  // --- (10) the subset path's interaction with the locked-role provenance filter (card 509176c8) is
  //     UNCHANGED by this card: an explicit subset naming an AGENT-written (unbound) skill still delivers
  //     it to a locked role, exactly like before — the capability gate never touches the subset branch. --
  {
    writeSkill("agent-written-unbound", skillMd("agent-written-unbound"), "agent");
    const cwd = sharedCwd("case10-subset-locked-role-unchanged");
    injectSkills(cwd, "sess10", ["agent-written-unbound"], "assistant");
    check("(10) locked role + explicit subset naming an agent-written (unbound) skill: still delivered (unchanged)", readDelivered(cwd).includes("agent-written-unbound"));
  }

  // --- (11) reproduce the reviewer's (a)-(c) permanent-orphan sequence directly, at a SHARED cwd, and
  //     show the bound skill is NEVER placed on disk at any step — the fix prevents the sequence from
  //     ever getting off the ground, rather than cleaning up after it. -------------------------------------
  {
    const cwd = sharedCwd("case11-orphan-sequence");
    // (a) granted manager A injects into the shared cwd.
    injectSkills(cwd, "mgr-A", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    check("(11a) granted manager A at shared cwd: bound-skill never placed on disk", !readDelivered(cwd).includes("bound-skill"));
    check("(11a) manager A's own manifest never claims it", !readManifestClaims(cwd, "mgr-A").includes("bound-skill"));
    // (b) A "dies" — a different, ungranted session B spawns at the same cwd, with an isSessionLive
    //     predicate reporting A as NOT live, exercising the dead-session manifest prune (card 9d73e537).
    const isSessionLiveAIsDead = (sid) => sid !== "mgr-A";
    injectSkills(cwd, "mgr-B", null, "manager", false, isSessionLiveAIsDead, [], BINDINGS);
    check("(11b) after A 'dies' + ungranted B's inject: bound-skill still never on disk", !readDelivered(cwd).includes("bound-skill"));
    check("(11b) B's own manifest never claims it", !readManifestClaims(cwd, "mgr-B").includes("bound-skill"));
    // (c) A "resumes", still granted, at the SAME shared cwd — under the original (grant-only) gate this
    //     is exactly where the permanent orphan would have been created; under the fix, nothing changes.
    injectSkills(cwd, "mgr-A", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    check("(11c) A resumes granted, still shared cwd: bound-skill STILL never placed on disk (no orphan ever created)", !readDelivered(cwd).includes("bound-skill"));
    check("(11c) unbound control delivered throughout (the shared-cwd mechanism itself is unaffected)", readDelivered(cwd).includes("plain-skill"));
  }

  // --- (12) host.ts wiring: the legacy `browserTesting` boolean reaches `injectSkills` as the
  //     "browser-testing" slug. (a) resolveProfileCapabilities itself bridges the boolean to that slug —
  //     capability-registry.mjs already proves this in depth; re-asserted here minimally for a
  //     self-contained wiring story. (b) a cheap source-text check that host.ts's createPty actually
  //     feeds resolveProfileCapabilities(opts)'s result into the SAME injectSkills call. ------------------
  {
    check('(12a) resolveProfileCapabilities({browserTesting:true}) bridges to the "browser-testing" slug',
      JSON.stringify(resolveProfileCapabilities({ browserTesting: true })) === JSON.stringify([{ slug: "browser-testing" }]));
    const hostTs = fs.readFileSync(path.join(__dirname, "..", "src", "pty", "host.ts"), "utf8");
    check("(12b) host.ts computes grantedCapabilitySlugs via resolveProfileCapabilities(opts) before the injectSkills call",
      hostTs.includes("const grantedCapabilitySlugs = resolveProfileCapabilities(opts).map((g) => g.slug);"));
    check("(12b) host.ts's injectSkills call passes grantedCapabilitySlugs through",
      hostTs.includes("injectSkills(opts.cwd, opts.sessionId, opts.skills ?? null, opts.role, obsidianEnabled, this.isSessionLive, grantedCapabilitySlugs)"));
  }

  // --- (13) CR round 2 NIT: near-miss cwd fixtures for isWorktreeCwd — pins the precise ancestor check
  //     against a regression to a naive `cwd.startsWith(WORKTREES_DIR)` string match. ------------------
  {
    injectSkills(WORKTREES_DIR, "sess13a", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    check("(13a) cwd === WORKTREES_DIR itself (no subpath): NOT isolated, bound-skill absent", !readDelivered(WORKTREES_DIR).includes("bound-skill"));

    const trailing = WORKTREES_DIR + path.sep;
    injectSkills(trailing, "sess13b", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    check("(13b) cwd === WORKTREES_DIR + trailing separator: NOT isolated, bound-skill absent", !readDelivered(trailing).includes("bound-skill"));

    const siblingRoot = `${WORKTREES_DIR}-x`;
    const sibling = path.join(siblingRoot, "sub");
    fs.mkdirSync(sibling, { recursive: true });
    registerForCleanup(siblingRoot);
    check("(13c) regression fixture: a NAIVE cwd.startsWith(WORKTREES_DIR) string check WOULD wrongly match this sibling", sibling.startsWith(WORKTREES_DIR));
    injectSkills(sibling, "sess13c", null, "manager", false, undefined, ["needs-slug"], BINDINGS);
    check(`(13c) the real path.relative-based check correctly treats the sibling ${path.basename(siblingRoot)} as NOT isolated`, !readDelivered(sibling).includes("bound-skill"));
  }

  // --- (14) CR round 2 MAJOR: the dead-session cleanup applies to ALL skills in an isolated cwd, not
  //     just capability-bound ones — a plain, never-bound skill that only the dead session's own subset
  //     wanted is removed too, rather than calcifying as "repo's own" the instant its claim is gone. ----
  {
    const cwd = isolatedCwd("case14-all-skills-cleaned");
    const live = new Set(["X"]);
    const isLive = (sid) => live.has(sid);
    injectSkills(cwd, "X", ["plain-skill"], "worker", false, isLive); // X's subset wants ONLY plain-skill
    check("(14) dead-session-X spawn: plain-skill delivered", readDelivered(cwd).includes("plain-skill"));
    live.delete("X"); live.add("Y"); // X dies; Y re-dispatches with a DISJOINT subset (doesn't want plain-skill)
    injectSkills(cwd, "Y", ["bound-skill"], "worker", false, isLive, ["needs-slug"], BINDINGS);
    check("(14) after X dies + Y's disjoint subset: plain-skill REMOVED, not left as a stale 'repo's own' artifact", !readDelivered(cwd).includes("plain-skill"));
  }

  // --- (15) CR round 2 MAJOR: reproduce the reviewer's exact WORKTREE-REUSE sequence (the actual bug
  //     class this fix closes — a stopped/rejected worker's worktree reused by a re-dispatch) at an
  //     ISOLATED cwd: bound is gone after the ungranted re-dispatch and never reappears; a SUBSEQUENT
  //     granted re-dispatch to the SAME worktree still gets it fresh; a user/repo dir in the same
  //     worktree (never recorded in any session's manifest) survives the whole sequence untouched. -----
  {
    const cwd = isolatedCwd("case15-worktree-reuse");
    const userDir = path.join(cwd, ".claude", "skills", "user-own-skill");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "SKILL.md"), "# not loom's\n");
    const userDirIntact = () => fs.existsSync(userDir) && fs.readFileSync(path.join(userDir, "SKILL.md"), "utf8") === "# not loom's\n";

    const live = new Set(["A"]);
    const isLive = (sid) => live.has(sid);

    // (a) granted worker A injects `bound-skill` on this worktree (e.g. a Web Designer rig with shadcn).
    injectSkills(cwd, "A", null, "worker", false, isLive, ["needs-slug"], BINDINGS);
    check("(15a) granted worker A: bound-skill delivered", readDelivered(cwd).includes("bound-skill"));
    check("(15a) user-own-skill untouched", userDirIntact());

    // (b) A is stopped (worktree RETAINED, per git/worktrees.ts's existsSync reuse branch); the task is
    //     re-dispatched to an UNGRANTED worker B on the SAME worktree path. Before this fix, A's dead
    //     manifest key being pruned would leave bound-skill to calcify as "repo's own" right here.
    live.delete("A"); live.add("B");
    injectSkills(cwd, "B", null, "worker", false, isLive, [], BINDINGS);
    check("(15b) ungranted re-dispatch B: bound-skill REMOVED (dead session's claim cleaned up, not orphaned)", !readDelivered(cwd).includes("bound-skill"));
    check("(15b) B's own manifest never claims it", !readManifestClaims(cwd, "B").includes("bound-skill"));
    check("(15b) user-own-skill still untouched (never in any manifest, so never a cleanup candidate)", userDirIntact());

    // (c) B resumes, still ungranted — it never reappears, and B's own resume never gets stuck either.
    injectSkills(cwd, "B", null, "worker", false, isLive, [], BINDINGS);
    check("(15c) B resumes ungranted: bound-skill still absent", !readDelivered(cwd).includes("bound-skill"));

    // (d) B is stopped; the task is re-dispatched AGAIN, this time to a GRANTED worker C on the SAME
    //     worktree — a granted re-dispatch must still receive it, freshly copied.
    live.delete("B"); live.add("C");
    injectSkills(cwd, "C", null, "worker", false, isLive, ["needs-slug"], BINDINGS);
    check("(15d) granted re-dispatch C: bound-skill delivered fresh", readDelivered(cwd).includes("bound-skill"));
    check("(15d) C's own manifest claims it", readManifestClaims(cwd, "C").includes("bound-skill"));
    check("(15d) user-own-skill survived the WHOLE sequence untouched", userDirIntact());
    check("(15d) C's own placement recorded a real fingerprint for bound-skill", typeof readManifestFingerprint(cwd, "C", "bound-skill") === "string" && readManifestFingerprint(cwd, "C", "bound-skill").length > 0);
  }

  // --- (16) CR round 3 MAJOR fix: the reviewer's probe (b) — a worker HAND-EDITS an injected SKILL.md
  //     and adds an extra uncommitted file; A dies; B arrives with a DISJOINT subset (never wants this
  //     skill at all). The whole dir, edits included, MUST survive: its current content fingerprint no
  //     longer matches what Loom recorded, so the cleanup skips it rather than destroy unfinished work. -
  {
    const cwd = isolatedCwd("case16-hand-edit-survives");
    const live = new Set(["A"]);
    const isLive = (sid) => live.has(sid);
    injectSkills(cwd, "A", null, "worker", false, isLive); // deliver-all, no binding needed — plain-skill lands
    const skillMdPath = path.join(cwd, ".claude", "skills", "plain-skill", "SKILL.md");
    const notesPath = path.join(cwd, ".claude", "skills", "plain-skill", "notes.md");
    fs.writeFileSync(skillMdPath, "# hand edit, uncommitted\n");
    fs.writeFileSync(notesPath, "extra file\n");
    live.delete("A"); live.add("B");
    injectSkills(cwd, "B", ["bound-skill"], "worker", false, isLive, ["needs-slug"], BINDINGS); // never wants plain-skill
    // CR round 4 nit: existsSync-guarded so a RED run (the dir deleted outright) reports a named FAIL
    // instead of an uncaught ENOENT that aborts the whole script before reaching case (17)/(18) below.
    check("(16) hand-edited SKILL.md SURVIVES (fingerprint mismatch skips the delete)", fs.existsSync(skillMdPath) && fs.readFileSync(skillMdPath, "utf8") === "# hand edit, uncommitted\n");
    check("(16) the extra notes.md file SURVIVES too", fs.existsSync(notesPath));
  }

  // --- (17) CR round 3: a LEGACY (pre-fingerprint) claim has NO recorded fingerprint ⇒ kept, not
  //     deleted — "cannot verify" fails toward keeping, even though nothing was actually hand-edited. --
  {
    const cwd = isolatedCwd("case17-legacy-no-fingerprint");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsDest, "plain-skill"), { recursive: true });
    fs.cpSync(path.join(skillsDir, "plain-skill"), path.join(skillsDest, "plain-skill"), { recursive: true });
    fs.writeFileSync(path.join(skillsDest, ".loom-skills.json"), JSON.stringify({ A: ["plain-skill"] })); // OLD flat-map shape, no fingerprints
    const live = new Set(["B"]); // A is already dead when B's first inject runs
    const isLive = (sid) => live.has(sid);
    injectSkills(cwd, "B", ["bound-skill"], "worker", false, isLive, ["needs-slug"], BINDINGS); // disjoint subset
    check("(17) legacy no-fingerprint claim: KEPT (not deleted)", fs.existsSync(path.join(skillsDest, "plain-skill")));
  }

  // --- (18) CR round 2 NIT, missing fixture: a genuine worktree subdirectory literally named "..foo" IS
  //     correctly recognized as isolated — complements (13)'s false-POSITIVE (escape) fixtures with the
  //     false-NEGATIVE direction. A revert to the naive `rel.startsWith("..")` check fails this case. ----
  {
    const cwd = path.join(WORKTREES_DIR, "..foo", "wt");
    fs.mkdirSync(cwd, { recursive: true });
    injectSkills(cwd, "sess18", null, "worker", false, undefined, ["needs-slug"], BINDINGS);
    check('(18) a genuine descendant literally named "..foo" IS isolated: bound-skill delivered', readDelivered(cwd).includes("bound-skill"));
  }

  // --- (19) CR round 4 MINOR fix: two DIFFERENT dead sids claimed the SAME name with DIFFERENT recorded
  //     fingerprints, present simultaneously in the manifest/fingerprints files. The delete must fire
  //     when current content matches EITHER one, in BOTH possible manifest-key insertion orders — a
  //     last-writer-wins Map would have made the outcome depend on JS object key order. ----------------
  {
    // Generate two REAL fingerprints for two distinct contents of "plain-skill", via throwaway probe
    // placements, restoring the shared store's real content immediately after.
    const origPlainSkillMd = fs.readFileSync(path.join(skillsDir, "plain-skill", "SKILL.md"), "utf8");
    const probe = (content, label) => {
      fs.writeFileSync(path.join(skillsDir, "plain-skill", "SKILL.md"), content);
      const cwd = isolatedCwd(`case19-probe-${label}`);
      injectSkills(cwd, `probe-${label}`, ["plain-skill"], "worker", false, undefined);
      return { fp: readManifestFingerprint(cwd, `probe-${label}`, "plain-skill"), cwd };
    };
    const v1 = probe("# v1 content\n", "v1");
    const v2 = probe("# v2 content\n", "v2");
    fs.writeFileSync(path.join(skillsDir, "plain-skill", "SKILL.md"), origPlainSkillMd); // restore immediately
    check("(19) precondition: v1 and v2 fingerprints are real and DIFFERENT", typeof v1.fp === "string" && typeof v2.fp === "string" && v1.fp !== v2.fp);

    const runOrder = (sub, sidOrder) => {
      const cwd = isolatedCwd(sub);
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "plain-skill"), { recursive: true });
      fs.cpSync(path.join(v2.cwd, ".claude", "skills", "plain-skill"), path.join(skillsDest, "plain-skill"), { recursive: true }); // current content matches v2/B's fp
      const manifestObj = {};
      const fpObj = {};
      for (const sid of sidOrder) {
        manifestObj[sid] = ["plain-skill"];
        fpObj[sid] = { "plain-skill": sid === "A" ? v1.fp : v2.fp };
      }
      fs.writeFileSync(path.join(skillsDest, ".loom-skills.json"), JSON.stringify(manifestObj));
      fs.writeFileSync(path.join(skillsDest, ".loom-skills-fingerprints.json"), JSON.stringify(fpObj));
      injectSkills(cwd, "C", ["bound-skill"], "worker", false, () => false, ["needs-slug"], BINDINGS); // neither A nor B live; disjoint subset
      return !fs.existsSync(path.join(skillsDest, "plain-skill"));
    };
    check("(19a) manifest key order [A,B]: current content (matches B's fp) is still cleaned", runOrder("case19-orderAB", ["A", "B"]));
    check("(19b) manifest key order [B,A]: current content (matches B's fp) is still cleaned", runOrder("case19-orderBA", ["B", "A"]));
  }
} catch (e) {
  console.log(`FAIL  unexpected throw: ${e.stack}`);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — capability-bound skill delivery requires BOTH worktree isolation and the grant, subset still bypasses both, resume re-evaluates + prunes, isWorktreeCwd rejects every near-miss and accepts every genuine descendant, a dead session's claimed dirs (any skill, in an isolated cwd) are cleaned up ONLY when their content fingerprint matches ANY dead claimant's recorded one (order-independent across two different dead claimants), a hand edit / extra file / legacy no-fingerprint claim all survive, the worktree-reuse sequence never orphans a bound skill, and the legacy-flag-to-slug wiring is intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
