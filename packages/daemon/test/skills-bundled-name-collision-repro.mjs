// Regression suite for card 9a3dea30 (decision record: docs/decisions/9a3dea30-rename-aside-agent-
// collision-at-seed-time.md). Originally a pure repro (RED on main); now exercises the shipped fix —
// `renameAsideAgentCollision` in skills/store.ts, called from seedGlobalSkills()'s per-entry loop before
// its existing seed-if-absent check — end to end, including crash-safety fault injection and the two
// non-regression cases round 2 of card 509176c8 broke, PLUS round 2 of THIS card (code review of commit
// 2b89bbd3): the self-host live-asset window (item 1), every bundled-name write path clearing a stale
// "agent" stamp (item 2), the fault-tolerant skip-seed-this-boot behavior (item 3), and the renamed-aside
// skill's own frontmatter `name:` no longer colliding with the bundled name (item 4).
//
// Sections:
//  1. Basic collision, now fixed: the agent content is renamed aside and correctly withheld from a
//     locked role; the bundled name itself gets fresh shipped content. Includes the round-2 self-host
//     live-asset-window check (item 1) and the frontmatter-rename check (item 4).
//  2. Idempotency across reboots: a second seedGlobalSkills() call is a clean no-op.
//  3. Fault injection — crash between stamping the new name and moving the directory.
//  4. Fault injection — crash between moving the directory and clearing the old stamp.
//  5. Non-regression — a legitimately customized (human-stamped) bundled skill is never touched.
//  6. Non-regression — a pristine bundled skill lagging behind a freshly-advanced asset (not yet
//     reseeded) is never touched, independent of content lag.
//  7. Documented residual — a legacy UNSTAMPED agent-written collision (predates provenance tracking)
//     still passes through. Asserted as the known, accepted limitation, not treated as a failure.
//  8. Round 2, item 2 — every write path that lands genuinely-bundled content under a name must clear a
//     stale "agent" stamp: resetSkillToBundled, adoptSkillUpdate, and the loom-platform bundled-asset
//     skill_write (skillWriteData with allowBundledAsset:true).
//  9. Round 2, item 3 — fault injection on the crash-safety step-3 stamp clear itself (the one store.ts
//     ~597 of commit 2b89bbd3 silently ignored): seedGlobalSkills() must skip fresh-seeding that name
//     THIS boot, then self-heal and seed it on the very next boot.
//
// Sets LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled-asset lookup) to TEMP dirs BEFORE importing dist
// (paths.ts/store.ts/seed.ts all read both at module load). No claude, no live daemon, nothing outside the
// two temp dirs created here.
// Run after build: node test/skills-bundled-name-collision-repro.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-bundled-collision-repro-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
fs.mkdirSync(home, { recursive: true });
process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR/SKILL_BASE_DIR/SKILL_PROVENANCE_FILE at load

const assetSkillsDir = path.join(root, "asset-skills");
fs.mkdirSync(assetSkillsDir, { recursive: true });
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing — store.ts/seed.ts compute ASSET_SKILLS at load

const { injectSkills } = await import("../dist/skills/inject.js");
const {
  writeSkill, skillProvenance, isBundledSkill, readSkill, listSkills, renameAsideAgentCollision,
  resetSkillToBundled, adoptSkillUpdate,
} = await import("../dist/skills/store.js");
const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { skillWriteData } = await import("../dist/mcp/skillTools.js");
const { SKILL_PROVENANCE_FILE } = await import("../dist/paths.js");

const SKILLS_DIR = path.join(home, "skills");

const skillBody = (name, tag) => `---\nname: ${name}\ndescription: ${tag}\n---\n\n# ${name}\n\n${tag}\n`;
const shipAsset = (name, content) => {
  fs.mkdirSync(path.join(assetSkillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(assetSkillsDir, name, "SKILL.md"), content);
};

const readDelivered = (cwd) => {
  const dir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n !== ".loom-skills.json").sort();
};
const readDeliveredContent = (cwd, name) => {
  try { return fs.readFileSync(path.join(cwd, ".claude", "skills", name, "SKILL.md"), "utf8"); }
  catch { return null; }
};
let cwdCounter = 0;
const freshCwd = (label) => {
  const cwd = path.join(root, `cwd-${label}-${++cwdCounter}`);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
};
const injectLocked = (name, cwd) => injectSkills(cwd, `sess-${path.basename(cwd)}`, null, "assistant");

// Frontmatter helpers for the item-4 (rename-aside rewrites its own declared name) assertions: compare
// everything EXCEPT the `name:` line (proving the rest of the file is untouched), and read the declared
// name separately (proving it now matches the new directory, not the old one).
const frontmatterName = (content) => {
  if (content == null) return null;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const nm = m?.[1]?.match(/^name:\s*(.*)$/m);
  return (nm?.[1] ?? "").trim();
};
const withRedactedName = (content) => (content ?? "").replace(/^name:.*$/m, "name: <REDACTED>");

try {
  // =====================================================================================================
  // 1. Basic collision, fixed — plus round 2 item 1 (self-host live-asset window) and item 4 (frontmatter
  //    rename).
  // =====================================================================================================
  const N1 = "collision-basic";
  const R1 = `${N1}-agent-renamed`;
  const AGENT1 = skillBody(N1, "agent content v1");
  const SHIPPED1 = skillBody(N1, "shipped doctrine v1");

  writeSkill(N1, AGENT1, "agent");
  check("[1] setup: provenance stamped agent", skillProvenance(N1) === "agent");
  check("[1] setup: not yet a bundled name", isBundledSkill(N1) === false);

  const cwdPre = freshCwd("pre");
  injectLocked(N1, cwdPre);
  check("[1] pre-collision: locked role withholds the agent-written skill", !readDelivered(cwdPre).includes(N1));

  shipAsset(N1, SHIPPED1);
  check("[1][round2 item1] self-host live-asset window: isBundledSkill flips true the instant the asset ships, with NO reseed yet", isBundledSkill(N1) === true && readSkill(N1)?.content === AGENT1);
  const cwdLiveWindow = freshCwd("livewindow");
  injectLocked(N1, cwdLiveWindow);
  check("[1][round2 item1] self-host live-asset window: locked role STILL withholds the agent collision even though isBundledSkill is already true (no reseed yet)", !readDelivered(cwdLiveWindow).includes(N1));

  seedGlobalSkills(); // "reboot" #1 — this is where the collision would have landed on old code

  check("[1] fixed: the bundled name now holds the SHIPPED content, not the agent's", readSkill(N1)?.content === SHIPPED1);
  check("[1] fixed: the bundled name's provenance stamp is cleared (no longer agent)", skillProvenance(N1) === null);
  check("[1] fixed: listSkills reports it pristine (not customized) now that it's genuinely fresh-seeded", listSkills().find((s) => s.name === N1)?.customized === false);
  check("[1][round2 item4] fixed: the agent content survives at the renamed-aside name, byte-identical except its OWN frontmatter name", withRedactedName(readSkill(R1)?.content) === withRedactedName(AGENT1));
  check("[1][round2 item4] fixed: the renamed-aside skill's frontmatter now declares ITS OWN new name, not the bundled name it collided with", frontmatterName(readSkill(R1)?.content) === R1);
  check("[1] fixed: the renamed-aside name carries the agent stamp", skillProvenance(R1) === "agent");

  const cwdPost = freshCwd("post");
  injectLocked(N1, cwdPost);
  const deliveredPost = readDelivered(cwdPost);
  check("[9a3dea30] fixed: the bundled name IS delivered to a locked role (genuinely bundled now)", deliveredPost.includes(N1));
  check("[9a3dea30] fixed: the renamed-aside agent skill is STILL withheld from a locked role", !deliveredPost.includes(R1));
  check("[9a3dea30] fixed: what the locked role receives under the bundled name is the SHIPPED content, never the agent's", readDeliveredContent(cwdPost, N1) === SHIPPED1);

  // =====================================================================================================
  // 2. Idempotency across reboots.
  // =====================================================================================================
  const directNoop = renameAsideAgentCollision(N1);
  check("[2] idempotent: a direct call post-fix is a no-op (provenance already cleared)", directNoop === null);
  seedGlobalSkills(); // "reboot" #2
  check("[2] idempotent: no second renamed-aside name was minted", !fs.existsSync(path.join(SKILLS_DIR, `${R1}-2`)));
  check("[2] idempotent: the bundled name is still the shipped content", readSkill(N1)?.content === SHIPPED1);
  check("[2] idempotent: the renamed-aside skill is unchanged (frontmatter already rewritten once, stable thereafter)", withRedactedName(readSkill(R1)?.content) === withRedactedName(AGENT1) && frontmatterName(readSkill(R1)?.content) === R1 && skillProvenance(R1) === "agent");

  // =====================================================================================================
  // 3. Fault injection — crash between stamping the NEW name and moving the directory (step A done,
  //    step B not yet). Simulated by stamping the target name "agent" and then removing ONLY its
  //    directory (the provenance entry is left dangling with nothing on disk, mirroring exactly what a
  //    real crash right after the stamp write — before the renameSync — would leave behind).
  // =====================================================================================================
  const N2 = "collision-crash-ab";
  const R2 = `${N2}-agent-renamed`;
  const AGENT2 = skillBody(N2, "agent content v2");
  const SHIPPED2 = skillBody(N2, "shipped doctrine v2");

  writeSkill(N2, AGENT2, "agent");
  writeSkill(R2, "placeholder — simulates step A's stamp landing before step B's move", "agent");
  fs.rmSync(path.join(SKILLS_DIR, R2), { recursive: true, force: true }); // dir gone, stamp still "agent" — step-A-only state
  check("[3] fault-injected pre-state: old dir still has the agent content", readSkill(N2)?.content === AGENT2);
  check("[3] fault-injected pre-state: new name is stamped but has no dir", skillProvenance(R2) === "agent" && !fs.existsSync(path.join(SKILLS_DIR, R2)));

  shipAsset(N2, SHIPPED2);
  seedGlobalSkills(); // the "next boot" that must complete the interrupted move

  check("[3] self-healed: old name now holds the shipped bundled content", readSkill(N2)?.content === SHIPPED2);
  check("[3] self-healed: old name's stamp is cleared", skillProvenance(N2) === null);
  // This fault state (SKILL.md still present under N2) takes the FULL rename path, not the crash-recovery-
  // only shortcut — so it goes through item 4's frontmatter rewrite too, same as section 1.
  check("[3] self-healed: the agent content landed intact at the renamed-aside name (frontmatter name rewritten, rest unchanged)", withRedactedName(readSkill(R2)?.content) === withRedactedName(AGENT2) && frontmatterName(readSkill(R2)?.content) === R2 && skillProvenance(R2) === "agent");

  // =====================================================================================================
  // 4. Fault injection — crash between moving the directory and clearing the old stamp (step B done,
  //    step C not yet). Simulated by placing the agent content at BOTH the old and new names (both
  //    stamped "agent"), then deleting only the OLD directory — exactly what remains once the move has
  //    happened but the old stamp was never cleared.
  // =====================================================================================================
  const N3 = "collision-crash-bc";
  const R3 = `${N3}-agent-renamed`;
  const AGENT3 = skillBody(N3, "agent content v3");
  const SHIPPED3 = skillBody(N3, "shipped doctrine v3");

  writeSkill(N3, AGENT3, "agent");
  writeSkill(R3, AGENT3, "agent"); // the move has "already happened" — content now lives at R3 too
  fs.rmSync(path.join(SKILLS_DIR, N3), { recursive: true, force: true }); // old dir gone; old stamp left dangling
  check("[4] fault-injected pre-state: old dir is gone but its stamp is still agent", skillProvenance(N3) === "agent" && !fs.existsSync(path.join(SKILLS_DIR, N3, "SKILL.md")));
  check("[4] fault-injected pre-state: new name already holds the agent content", readSkill(R3)?.content === AGENT3);

  shipAsset(N3, SHIPPED3);
  seedGlobalSkills(); // the "next boot" that must finish the stamp cleanup BEFORE fresh-seeding N3

  check("[4] self-healed: the old name's dangling stamp is cleared", skillProvenance(N3) === null);
  check("[4] self-healed: the old name is freshly seeded with the shipped content (not re-renamed)", readSkill(N3)?.content === SHIPPED3);
  check("[4] self-healed: the renamed-aside name is untouched by a second, erroneous rename", readSkill(R3)?.content === AGENT3 && skillProvenance(R3) === "agent");

  const cwdCrash = freshCwd("crash");
  injectLocked(N3, cwdCrash);
  const deliveredCrash = readDelivered(cwdCrash);
  check("[4] end-to-end after self-heal: bundled name delivered to locked role", deliveredCrash.includes(N3));
  check("[4] end-to-end after self-heal: renamed agent skill still withheld", !deliveredCrash.includes(R3));

  // =====================================================================================================
  // 5. Non-regression — a legitimately CUSTOMIZED bundled skill (human-stamped) is never touched by the
  //    new gate, regardless of how far its content diverges from shipped.
  // =====================================================================================================
  const N5 = "customized-legit-bundled";
  const SHIPPED5 = skillBody(N5, "shipped v1");
  const CUSTOM5 = skillBody(N5, "a human's own customization, diverging from shipped by design");

  shipAsset(N5, SHIPPED5);
  seedGlobalSkills(); // seed it fresh, pristine, bundled — no agent stamp involved at all
  check("[5] setup: seeded fresh and pristine", readSkill(N5)?.content === SHIPPED5 && skillProvenance(N5) === null);

  writeSkill(N5, CUSTOM5, "human"); // mirrors PUT /api/skills/:name — stamps "human" even for a bundled name
  check("[5] setup: now customized and human-stamped", skillProvenance(N5) === "human" && isBundledSkill(N5) === true);

  const directNoop5 = renameAsideAgentCollision(N5);
  check("[5] non-regression: direct call is a no-op (gate is agent-only, never human/customized)", directNoop5 === null);
  seedGlobalSkills(); // another reboot — must not touch it either
  check("[5] non-regression: the human customization survives untouched after a reboot", readSkill(N5)?.content === CUSTOM5);
  check("[5] non-regression: it was never renamed aside", !fs.existsSync(path.join(SKILLS_DIR, `${N5}-agent-renamed`)));

  const cwdCustom = freshCwd("custom");
  injectLocked(N5, cwdCustom);
  check("[5] non-regression: still delivered to a locked role, with the human's own content", readDeliveredContent(cwdCustom, N5) === CUSTOM5);

  // =====================================================================================================
  // 6. Non-regression — the "advanced-asset-before-reseed" window: a pristine bundled skill whose shipped
  //    asset has advanced (a merged doctrine fix, assets are read LIVE) but hasn't been reseeded into the
  //    store yet. Never agent-stamped, so the new gate must never fire here regardless of the content lag.
  //    Tested as a DIRECT call (not a full reboot) to isolate the gate's own behavior from the pre-
  //    existing, unrelated auto-fast-forward mechanism that would otherwise resolve the lag in the same
  //    seedGlobalSkills() call.
  // =====================================================================================================
  const N6 = "pristine-lag-bundled";
  const SHIPPED6_INITIAL = skillBody(N6, "shipped v1 (initial)");
  const SHIPPED6_ADVANCED = skillBody(N6, "shipped v2 (advanced, not yet reseeded)");

  shipAsset(N6, SHIPPED6_INITIAL);
  seedGlobalSkills(); // seed fresh, pristine (mine == base == shipped == v1)
  check("[6] setup: seeded fresh and pristine, no stamp", readSkill(N6)?.content === SHIPPED6_INITIAL && skillProvenance(N6) === null);

  fs.writeFileSync(path.join(assetSkillsDir, N6, "SKILL.md"), SHIPPED6_ADVANCED); // the asset "advances" — store/base lag behind
  check("[6] setup: the asset is now ahead of the store (the window)", readSkill(N6)?.content === SHIPPED6_INITIAL);

  const directNoop6 = renameAsideAgentCollision(N6);
  check("[6] non-regression: direct call during the lag window is a no-op (never agent-stamped)", directNoop6 === null);
  check("[6] non-regression: nothing was renamed aside during the window", !fs.existsSync(path.join(SKILLS_DIR, `${N6}-agent-renamed`)));
  check("[6] non-regression: the pristine skill's content is untouched by the gate itself", readSkill(N6)?.content === SHIPPED6_INITIAL);

  // =====================================================================================================
  // 7. Documented residual (decision record 9a3dea30) — a legacy UNSTAMPED agent-written collision
  //    (predates provenance tracking entirely) is NOT caught by this fix: the gate is `=== "agent"`,
  //    and an unstamped name reads null. This is the accepted, out-of-scope cost of direction (a) — not
  //    a bug for this card. Asserted as the KNOWN outcome, not reported as a failure. Still true under
  //    round 2's inject.ts guard (`skillProvenance(n) !== "agent"` — null still passes), since round 2
  //    only tightens the "agent" case, never the unstamped one.
  //
  // NOTE: this call to seedGlobalSkills() also resolves N6's lag window above (autoFastForwardPristineSkills
  // is global, not scoped to one name) — accepted, pre-existing interaction; nothing after this point
  // depends on N6 staying lagged.
  // =====================================================================================================
  const N7 = "legacy-unstamped-collision";
  const AGENT7 = skillBody(N7, "a pre-provenance-tracking agent skill — never stamped");
  const SHIPPED7 = skillBody(N7, "shipped doctrine, same name");

  writeSkill(N7, AGENT7); // no provenance arg — exactly a legacy, pre-tracking write
  check("[7] setup: unstamped (legacy)", skillProvenance(N7) === null);

  shipAsset(N7, SHIPPED7);
  seedGlobalSkills();

  check("[7] documented residual: NOT renamed aside (gate never fires on an unstamped name)", readSkill(N7)?.content === AGENT7);
  check("[7] documented residual: isBundledSkill still flips true over it", isBundledSkill(N7) === true);
  const cwdLegacy = freshCwd("legacy");
  injectLocked(N7, cwdLegacy);
  check("[7] documented residual: still passes through to a locked role as 'bundled' (known, accepted gap — see decision record)", readDelivered(cwdLegacy).includes(N7));

  // =====================================================================================================
  // 8. Round 2, item 2 — every write path that lands genuinely-BUNDLED content under a name must clear a
  //    stale "agent" stamp, or round 2's own inject.ts guard (item 1) would wrongly withhold it from a
  //    locked role forever after. Simulated by stamping "agent" directly over already-bundled content
  //    (the state a round-1-era collision could have left behind), then exercising each write path.
  // =====================================================================================================

  // 8a. resetSkillToBundled.
  const N8A = "item2-reset-stale-stamp";
  const SHIPPED8A = skillBody(N8A, "shipped v1");
  shipAsset(N8A, SHIPPED8A);
  seedGlobalSkills();
  check("[8a] setup: seeded fresh and pristine", readSkill(N8A)?.content === SHIPPED8A && skillProvenance(N8A) === null);
  writeSkill(N8A, SHIPPED8A, "agent"); // simulate a stale leftover "agent" stamp over genuinely-bundled content
  check("[8a] setup: now carries a stale agent stamp despite being genuinely bundled", skillProvenance(N8A) === "agent" && isBundledSkill(N8A) === true);
  const cwd8aPre = freshCwd("item2a-pre");
  injectLocked(N8A, cwd8aPre);
  check("[8a] pre-fix: round2 item1's guard wrongly withholds it from a locked role under the stale stamp", !readDelivered(cwd8aPre).includes(N8A));
  check("[8a] resetSkillToBundled succeeds", resetSkillToBundled(N8A) === true);
  check("[8a] fixed: resetSkillToBundled clears the stale stamp", skillProvenance(N8A) === null);
  const cwd8aPost = freshCwd("item2a-post");
  injectLocked(N8A, cwd8aPost);
  check("[8a] fixed: now delivered to a locked role", readDelivered(cwd8aPost).includes(N8A));

  // 8b. adoptSkillUpdate.
  const N8B = "item2-adopt-stale-stamp";
  const SHIPPED8B = skillBody(N8B, "shipped v1");
  shipAsset(N8B, SHIPPED8B);
  seedGlobalSkills();
  check("[8b] setup: seeded fresh and pristine", readSkill(N8B)?.content === SHIPPED8B && skillProvenance(N8B) === null);
  writeSkill(N8B, SHIPPED8B, "agent"); // same stale-stamp simulation
  check("[8b] setup: now carries a stale agent stamp despite being genuinely bundled", skillProvenance(N8B) === "agent" && isBundledSkill(N8B) === true);
  const cwd8bPre = freshCwd("item2b-pre");
  injectLocked(N8B, cwd8bPre);
  check("[8b] pre-fix: round2 item1's guard wrongly withholds it from a locked role under the stale stamp", !readDelivered(cwd8bPre).includes(N8B));
  const adopted8b = adoptSkillUpdate(N8B, SHIPPED8B);
  check("[8b] adoptSkillUpdate succeeds", adopted8b?.content === SHIPPED8B);
  check("[8b] fixed: adoptSkillUpdate clears the stale stamp", skillProvenance(N8B) === null);
  const cwd8bPost = freshCwd("item2b-post");
  injectLocked(N8B, cwd8bPost);
  check("[8b] fixed: now delivered to a locked role", readDelivered(cwd8bPost).includes(N8B));

  // 8c. skillWriteData with allowBundledAsset:true (the loom-platform Lead's bundled-asset skill_write).
  const N8C = "item2-lead-publish-stale-stamp";
  const SHIPPED8C = skillBody(N8C, "shipped v1");
  shipAsset(N8C, SHIPPED8C);
  seedGlobalSkills();
  check("[8c] setup: seeded fresh and pristine", readSkill(N8C)?.content === SHIPPED8C && skillProvenance(N8C) === null);
  writeSkill(N8C, SHIPPED8C, "agent"); // same stale-stamp simulation
  check("[8c] setup: now carries a stale agent stamp despite being genuinely bundled", skillProvenance(N8C) === "agent" && isBundledSkill(N8C) === true);
  const cwd8cPre = freshCwd("item2c-pre");
  injectLocked(N8C, cwd8cPre);
  check("[8c] pre-fix: round2 item1's guard wrongly withholds it from a locked role under the stale stamp", !readDelivered(cwd8cPre).includes(N8C));
  const writeResult8c = skillWriteData({ name: N8C, content: SHIPPED8C, confirm: true }, { allowBundledAsset: true });
  check("[8c] skillWriteData (Lead bundled-asset path) succeeds", writeResult8c?.ok === true && writeResult8c?.bundled === true);
  check("[8c] fixed: skillWriteData's bundled-asset path clears the stale stamp", skillProvenance(N8C) === null);
  const cwd8cPost = freshCwd("item2c-post");
  injectLocked(N8C, cwd8cPost);
  check("[8c] fixed: now delivered to a locked role", readDelivered(cwd8cPost).includes(N8C));

  // =====================================================================================================
  // 9. Round 2, item 3 — fault injection on the crash-safety step-3 stamp clear itself. seedGlobalSkills()
  //    must skip fresh-seeding the colliding name THIS boot (never seed fresh bundled content while the
  //    OLD name's "agent" stamp still dangles — that is exactly the state that makes a LATER boot mistake
  //    the by-then-legitimate bundled copy for the original agent content and rename it away again), then
  //    self-heal and seed it on the very next boot.
  //
  //    Fault injected by monkey-patching fs.writeFileSync to throw on the SECOND write to the provenance
  //    map's tmp file that mentions the (unique) renamed-aside name — step 1 (stamp the new name "agent")
  //    and step 3 (clear the old name) are the only two writes in this flow that ever mention it, and no
  //    other skill's provenance write can ever contain this unique string, so the count is immune to
  //    whatever else seedGlobalSkills() does for unrelated skills in the same call.
  // =====================================================================================================
  const N9 = "item3-final-clear-fault";
  const R9 = `${N9}-agent-renamed`;
  const AGENT9 = skillBody(N9, "agent content (fault)");
  const SHIPPED9 = skillBody(N9, "shipped doctrine (fault)");

  writeSkill(N9, AGENT9, "agent");
  shipAsset(N9, SHIPPED9);

  const PROV_TMP = `${SKILL_PROVENANCE_FILE}.tmp`;
  let r9Writes = 0;
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(file, data, ...rest) {
    if (file === PROV_TMP && typeof data === "string" && data.includes(R9)) {
      r9Writes++;
      if (r9Writes === 2) throw new Error("fault-injected: simulated failure on the crash-safety step-3 stamp clear");
    }
    return origWriteFileSync.call(fs, file, data, ...rest);
  };
  let faultySeeded;
  try { faultySeeded = seedGlobalSkills(); } // "boot" with the fault injected
  finally { fs.writeFileSync = origWriteFileSync; }

  check("[9] fault: the content was still moved to the renamed-aside name (steps 1-2 completed before the fault at step 3)", readSkill(R9)?.content != null);
  check("[9] fault: the renamed-aside skill's frontmatter was still rewritten before the fault", frontmatterName(readSkill(R9)?.content) === R9);
  check("[9] fault: the old name's stamp is STILL agent — the clear failed", skillProvenance(N9) === "agent");
  check("[9] fault: the old name was NOT fresh-seeded this boot (skipped, per round2 item3)", !fs.existsSync(path.join(SKILLS_DIR, N9, "SKILL.md")));
  check("[9] fault: seedGlobalSkills did not report N9 as freshly seeded this boot", !faultySeeded.includes(N9));

  const cwdFaulty = freshCwd("faulty");
  injectLocked(N9, cwdFaulty);
  const deliveredFaulty = readDelivered(cwdFaulty);
  check("[9] fault: a locked role gets NEITHER name (old has no content at all; renamed-aside is still agent-stamped)", !deliveredFaulty.includes(N9) && !deliveredFaulty.includes(R9));

  // Next boot (no fault injected): the dangling stamp clears via the crash-recovery branch, and N9 is
  // THEN freshly seeded with the shipped content — never re-renaming the (not-yet-existing) bundled copy.
  const seededNext = seedGlobalSkills();
  check("[9] self-healed: the old name's stamp is cleared on the next boot", skillProvenance(N9) === null);
  check("[9] self-healed: the old name is freshly seeded with the shipped content on the next boot", readSkill(N9)?.content === SHIPPED9);
  check("[9] self-healed: reported as freshly seeded on THIS (the next) boot", seededNext.includes(N9));
  check("[9] self-healed: the renamed-aside agent content is untouched by any of this", readSkill(R9)?.content != null && frontmatterName(readSkill(R9)?.content) === R9);

  const cwdHealed = freshCwd("healed");
  injectLocked(N9, cwdHealed);
  const deliveredHealed = readDelivered(cwdHealed);
  check("[9] self-healed end-to-end: bundled name now delivered to a locked role", deliveredHealed.includes(N9));
  check("[9] self-healed end-to-end: the renamed-aside agent skill is still withheld", !deliveredHealed.includes(R9));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — round 1 fix (basic collision, idempotency, both fault-injection points, both non-regression cases, the documented residual) AND round 2 (self-host live-asset window, every bundled-write-path stamp clear, the fault-tolerant skip-seed-this-boot behavior, and the frontmatter rename) all verified end to end."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
