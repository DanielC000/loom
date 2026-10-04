import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix-round regression guard for card 509176c8 (Code Review round 2 on branch tip 522148e4):
//
//  1. ORDERING fail-open: writeSkill used to write SKILL.md content FIRST and the provenance stamp
//     SECOND, with the stamp write's own failure silently swallowed — a human-stamped skill overwritten
//     by an agent write, where the stamp write itself fails (EISDIR on the provenance file's own .tmp
//     path), landed the agent's content on disk while the stamp still read "human". Fixed: the "agent"
//     branch downgrades the stamp FIRST and aborts the whole write if that fails.
//  2. CORRUPT provenance map: a corrupt file used to be read as {} in memory with the corrupt bytes left
//     on disk — the next write would then overwrite the corrupt file with a near-empty reconstructed
//     map, destroying every real stamp it held. Fixed: the corrupt file is renamed aside (timestamped)
//     BEFORE returning {}, so a later write can never clobber it.
//  2b. ROUND 3 nitpick: if THAT rename-aside itself fails (e.g. EPERM), the corrupt file stays at the live
//      path — `writeProvenanceMap` now independently re-checks it for corruption and refuses to write
//      rather than trusting the rename to have cleared the path.
//  3. ROUND 3 SCOPE CUT: round 2's `isTrustedBundledContent` (content-equality-or-human-stamp gate on top
//     of `isBundledSkill`) was removed — delta review (0c5a7646) reproduced that it withheld two LEGITIMATE
//     cases from a locked role: (A) a pre-provenance customization (content diverges, never stamped) and
//     (B) a pristine store copy ahead of an advanced shipped asset. The bundled-name collision it was meant
//     to close moves to card 9a3dea30. Locked-role trust is back to bare `isBundledSkill(n) || "human"`.
//  4. `skillProvenance("constructor")` (a syntactically valid skill name) used to return the INHERITED
//     `Object.prototype.constructor` function instead of `null`, because the provenance map was a plain
//     `{}` read via bracket-access + `??`. Fixed: `Object.create(null)` + an explicit `Object.hasOwn` check.
//  5. Drives `skillWriteData` (not just `writeSkill` directly), the REST POST/PUT "human" stamp, the
//     human→agent overwrite re-stamp, and `deleteSkill` clearing the stamp.
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build:
//   node test/skills-provenance-integrity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-provenance-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;              // BEFORE import — paths.ts computes SKILLS_DIR/SKILL_PROVENANCE_FILE at load
process.env.LOOM_PORT = String(hermeticPort());
process.env.LOOM_ASSET_SKILLS = assetDir;  // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;     // Windows
process.env.HOME = sandboxHome;            // POSIX

const store = await import("../dist/skills/store.js");
const { writeSkill, deleteSkill, skillProvenance, isBundledSkill, listSkills, adoptSkillUpdate, resetSkillToBundled, stampSkillProvenanceHuman, publishSkillToBundled, skillUpdateAvailable } = store;
const { injectSkills } = await import("../dist/skills/inject.js");
const { SKILL_PROVENANCE_FILE } = await import("../dist/paths.js");
const { skillWriteData } = await import("../dist/mcp/skillTools.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const skillMd = (name, tag = "") => `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n${tag}\n`;
const writeAsset = (name, content) => { fs.mkdirSync(path.join(assetDir, name), { recursive: true }); fs.writeFileSync(path.join(assetDir, name, "SKILL.md"), content); };
const readStoreFile = (name) => fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
const baseDir = path.join(home, "skill-base"); // mirrors paths.ts's SKILL_BASE_DIR = join(LOOM_HOME, "skill-base")
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };

try {
  // =====================================================================================================
  // (1) ORDERING — an agent write must never land content while a stamp-write failure leaves it unstamped
  //     or stuck on a stale "human" stamp.
  // =====================================================================================================
  const V1 = skillMd("ord-test", "V1");
  const V2 = skillMd("ord-test", "V2");
  check("precondition: human write succeeds", writeSkill("ord-test", V1, "human") === true);
  check("precondition: provenance is human", skillProvenance("ord-test") === "human");

  // Force the provenance write to fail: atomicWriteFile writes to `<file>.tmp` first — make that path a
  // DIRECTORY so fs.writeFileSync throws EISDIR instead of landing the new map.
  const provTmp = `${SKILL_PROVENANCE_FILE}.tmp`;
  fs.mkdirSync(provTmp, { recursive: true });
  try {
    const result = writeSkill("ord-test", V2, "agent");
    check("(1) agent write ABORTS when the stamp downgrade fails", result === false);
    check("(1) content UNCHANGED (still V1, never touched)", readStoreFile("ord-test") === V1);
    check("(1) provenance UNCHANGED (still human, never downgraded)", skillProvenance("ord-test") === "human");
  } finally {
    fs.rmSync(provTmp, { recursive: true, force: true }); // unblock — prove this is recoverable, not a permanent wedge
  }

  // Self-heal: the SAME write, now that the stamp path is clear, must succeed cleanly.
  check("(1) agent write SUCCEEDS once unblocked", writeSkill("ord-test", V2, "agent") === true);
  check("(1) content now V2", readStoreFile("ord-test") === V2);
  check("(1) provenance now agent (clean downgrade)", skillProvenance("ord-test") === "agent");

  // =====================================================================================================
  // (2) CORRUPT provenance map — must never be silently overwritten by the next write.
  // =====================================================================================================
  check("precondition: corrupt-a stamped human", writeSkill("corrupt-a", skillMd("corrupt-a"), "human") === true);
  check("precondition: corrupt-b stamped agent", writeSkill("corrupt-b", skillMd("corrupt-b"), "agent") === true);

  const GARBAGE = "{not valid json at all";
  fs.writeFileSync(SKILL_PROVENANCE_FILE, GARBAGE);
  check("(2) corrupt map reads as unknown (fail closed)", skillProvenance("corrupt-a") === null);

  const dirAfterCorruptRead = fs.readdirSync(home);
  const backupName = dirAfterCorruptRead.find((n) => n.startsWith("skill-provenance.json.corrupt-"));
  check("(2) corrupt file was renamed aside to a timestamped backup", !!backupName);
  check("(2) backup preserves the ORIGINAL corrupt bytes exactly", backupName && fs.readFileSync(path.join(home, backupName), "utf8") === GARBAGE);
  check("(2) the live provenance path no longer holds the corrupt bytes", !fs.existsSync(SKILL_PROVENANCE_FILE));

  // A write AFTER the corruption must create a fresh file, never resurrect/overwrite the backup.
  check("(2) a write after corruption succeeds (fresh file)", writeSkill("corrupt-c", skillMd("corrupt-c"), "human") === true);
  check("(2) new provenance file stamps the new write", skillProvenance("corrupt-c") === "human");
  check("(2) backup STILL holds the original corrupt bytes (never overwritten)", fs.readFileSync(path.join(home, backupName), "utf8") === GARBAGE);

  // Valid JSON that isn't an object (e.g. an array) is corrupt too, not silently {}. Sleep a tick first so
  // the backup's Date.now()-keyed filename can't collide with the first corruption's backup above.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  fs.writeFileSync(SKILL_PROVENANCE_FILE, "[1,2,3]");
  check("(2) non-object JSON also reads as unknown (fail closed)", skillProvenance("corrupt-c") === null);
  const backupsAfterArray = fs.readdirSync(home).filter((n) => n.startsWith("skill-provenance.json.corrupt-"));
  check("(2) non-object JSON ALSO gets moved aside (a second backup exists)", backupsAfterArray.length >= 2);

  // =====================================================================================================
  // (2b) Nitpick fixed in round 3: if the rename-aside ITSELF fails, a later write must still refuse to
  //      overwrite the corrupt file rather than clobbering it — fail closed, not permissive-by-fallback.
  // =====================================================================================================
  const GARBAGE2 = "{also not valid json";
  const originalRenameSync = fs.renameSync;
  // Only block the rename-aside call itself (SKILL_PROVENANCE_FILE -> its timestamped backup) — every
  // other rename, incl. writeSkill's own SKILL.md content write (atomicWriteFile's tmp+rename), must keep
  // working so the "human branch still lands content" check below is testing the right thing.
  fs.renameSync = (src, dest) => {
    if (src === SKILL_PROVENANCE_FILE) throw new Error("simulated EPERM — rename-aside blocked");
    return originalRenameSync(src, dest);
  };
  try {
    fs.writeFileSync(SKILL_PROVENANCE_FILE, GARBAGE2);
    check("(2b) read still fails closed even when the rename-aside itself fails", skillProvenance("corrupt-c") === null);
    check("(2b) corrupt file is STILL at the live path (rename was blocked)", fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8") === GARBAGE2);

    const agentResult = writeSkill("blocked-agent", skillMd("blocked-agent"), "agent");
    check("(2b) agent write ABORTS rather than overwrite the still-corrupt file", agentResult === false);
    check("(2b) corrupt bytes UNCHANGED after the refused agent write", fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8") === GARBAGE2);

    const humanResult = writeSkill("blocked-human", skillMd("blocked-human"), "human");
    check("(2b) human write still lands SKILL.md content (best-effort)", humanResult === true);
    check("(2b) corrupt bytes UNCHANGED after the refused human stamp", fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8") === GARBAGE2);
    check("(2b) the skipped human stamp reads unknown, not a false 'human'", skillProvenance("blocked-human") === null);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  check("(2b) once rename-aside works again, the next read cleans up the corrupt file", (() => { skillProvenance("blocked-human"); return !fs.existsSync(SKILL_PROVENANCE_FILE); })());

  // =====================================================================================================
  // (2c) card 35099271 round 2 — SALVAGE: a TRUNCATED (not byte-scrambled) corrupt file — the common real-
  //      world shape — still containing recognizable "agent" entries must recover them, since the stamp
  //      loss is otherwise PERMANENT (the renamed-aside backup is never read back by anything else).
  //      "human" entries are NEVER salvaged (see the decision record's corrupt-map residual section for
  //      why only "agent" is safe to recover from untrusted corrupt bytes).
  // =====================================================================================================
  check("precondition: salvage-agent stamped agent", writeSkill("salvage-agent", skillMd("salvage-agent"), "agent") === true);
  check("precondition: salvage-human stamped human", writeSkill("salvage-human", skillMd("salvage-human"), "human") === true);
  const goodMapText = fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8");
  check("precondition: the real map really does contain both entries", goodMapText.includes('"salvage-agent":"agent"') && goodMapText.includes('"salvage-human":"human"'));
  // Drop the trailing closing brace and leave a dangling key so JSON.parse throws, while every entry's own
  // text (including both of the above) survives intact.
  const truncated = `${goodMapText.slice(0, -1)}, "dangling":`;
  fs.writeFileSync(SKILL_PROVENANCE_FILE, truncated);
  check("(2c) salvage: the agent stamp is recovered, not read as unknown", skillProvenance("salvage-agent") === "agent");
  check("(2c) salvage: the human stamp is NEVER recovered (fail-closed, unchanged from round 1)", skillProvenance("salvage-human") === null);
  // The recovery must be PERSISTED (not just returned for the triggering call) — a later, independent read
  // must still see it without re-parsing a backup that no longer exists at the live path.
  check("(2c) salvage persisted: a later independent read still sees the recovered agent stamp", skillProvenance("salvage-agent") === "agent");

  // =====================================================================================================
  // (2c) card 35099271 round 3, item 1 — AMBIGUOUS NAMES: corrupt bytes can hold the SAME name claiming
  //      both "agent" and "human" — a duplicate key from one malformed write, or two write "generations"
  //      glued together by the corruption. Salvaging "agent" there would be wrong: for a bundled name it
  //      would make the next boot's renameAsideAgentCollision DISPLACE a human's real copy, not merely
  //      withhold a skill. Any name matching both must be skipped (reads unknown), while an unambiguous
  //      sibling name in the SAME corrupt bytes must still be recovered.
  // =====================================================================================================

  // Shape 1: a literal duplicate key within what looks like one object — "foo" claims BOTH values, "bar"
  // claims only "agent" (unambiguous) — plus a dangling trailing key so JSON.parse still throws.
  const dupKeyCorrupt = '{"foo":"agent","bar":"agent","foo":"human","dangling":';
  fs.writeFileSync(SKILL_PROVENANCE_FILE, dupKeyCorrupt);
  check("(2c) duplicate-key shape: the ambiguous name ('foo') is SKIPPED, not salvaged as agent", skillProvenance("foo") === null);
  check("(2c) duplicate-key shape: the UNAMBIGUOUS sibling name ('bar') is still recovered", skillProvenance("bar") === "agent");
  check("(2c) duplicate-key shape: ambiguous skip persists on a later independent read", skillProvenance("foo") === null);

  // Shape 2: two write "generations" glued together by the corruption — e.g. a stale write's bytes
  // immediately followed by a newer write's bytes, never forming one coherent JSON document. "alpha" claims
  // "agent" in the first generation and "human" in the second (ambiguous); "gamma" claims only "agent" in
  // the second generation (unambiguous).
  const concatGenCorrupt = '{"alpha":"agent"}{"alpha":"human","gamma":"agent","dangling":';
  fs.writeFileSync(SKILL_PROVENANCE_FILE, concatGenCorrupt);
  check("(2c) concatenated-generations shape: the ambiguous name ('alpha') is SKIPPED, not salvaged as agent", skillProvenance("alpha") === null);
  check("(2c) concatenated-generations shape: the UNAMBIGUOUS name ('gamma') is still recovered", skillProvenance("gamma") === "agent");
  check("(2c) concatenated-generations shape: ambiguous skip persists on a later independent read", skillProvenance("alpha") === null);

  // =====================================================================================================
  // (2c) card 35099271 round 3, item 2 — SALVAGE FROM IN-MEMORY TEXT: when the rename-aside itself fails
  //      (e.g. EPERM), no backup file is ever written to `backupPath` — the salvage must still recover an
  //      unambiguous "agent" entry from the bytes `readProvenanceMap` already holds in memory, not give up
  //      because there is nothing at `backupPath` to re-read. Same fs.renameSync fault injection as (2b).
  // =====================================================================================================
  const epermCorrupt = '{"eperm-agent":"agent","dangling":';
  const originalRenameSync2 = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (src === SKILL_PROVENANCE_FILE) throw new Error("simulated EPERM — rename-aside blocked");
    return originalRenameSync2(src, dest);
  };
  try {
    fs.writeFileSync(SKILL_PROVENANCE_FILE, epermCorrupt);
    check("(2c) EPERM + salvage: an unambiguous agent stamp is STILL recovered despite the blocked rename-aside", skillProvenance("eperm-agent") === "agent");
    check("(2c) EPERM + salvage: the corrupt file is still live at the original path (rename was blocked)", fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8") === epermCorrupt);
  } finally {
    fs.renameSync = originalRenameSync2;
  }
  // Once rename-aside can succeed again, the corrupt file moves aside for real and — because this backup
  // DOES contain a recoverable entry (unlike (2b)'s GARBAGE2, which has none) — the salvaged map is
  // persisted into a fresh, valid live file.
  skillProvenance("eperm-agent");
  let freshMapText = null;
  try { freshMapText = fs.readFileSync(SKILL_PROVENANCE_FILE, "utf8"); } catch { /* checked below */ }
  check("(2c) EPERM + salvage: once rename-aside works again, the recovered stamp is persisted to a fresh, valid file", (() => { try { return freshMapText !== null && JSON.parse(freshMapText)["eperm-agent"] === "agent"; } catch { return false; } })());

  // =====================================================================================================
  // (4) Prototype-pollution-shaped read: a skill literally named "constructor" is a VALID name (NAME_RE).
  // =====================================================================================================
  check("precondition: 'constructor' is a syntactically valid skill name", (() => { try { return writeSkill("constructor", skillMd("constructor")) === true; } catch { return false; } })());
  const ctorProv = skillProvenance("constructor");
  check("(4) unstamped 'constructor' reads null, not the inherited Function", ctorProv === null);
  check("(4) unstamped 'constructor' is not a function", typeof ctorProv !== "function");
  check("(4) deleteSkill('constructor') does not throw and returns true", deleteSkill("constructor") === true);
  check("(4) 'constructor' still reads null after delete", skillProvenance("constructor") === null);

  // =====================================================================================================
  // (5a) Drive skillWriteData (not just writeSkill directly) — the real MCP skill_write handler path.
  // =====================================================================================================
  const wd = skillWriteData({ name: "mcp-written", content: skillMd("mcp-written"), confirm: true }, { allowBundledAsset: false });
  check("(5a) skillWriteData user-skill write: ok:true", wd.ok === true && wd.bundled === false);
  check("(5a) skillWriteData user-skill write stamps agent", skillProvenance("mcp-written") === "agent");

  // =====================================================================================================
  // (5c) human -> agent overwrite re-stamp (clean path, no fault injection).
  // =====================================================================================================
  check("precondition: flip-test starts human", writeSkill("flip-test", skillMd("flip-test", "H"), "human") === true);
  check("precondition: flip-test provenance human", skillProvenance("flip-test") === "human");
  check("(5c) agent overwrite succeeds", writeSkill("flip-test", skillMd("flip-test", "A"), "agent") === true);
  check("(5c) flip-test now stamped agent", skillProvenance("flip-test") === "agent");
  check("(5c) flip-test content updated", readStoreFile("flip-test").includes("A"));

  // =====================================================================================================
  // (5d) deleteSkill clears the stamp.
  // =====================================================================================================
  check("precondition: del-test stamped human", writeSkill("del-test", skillMd("del-test"), "human") === true);
  check("precondition: del-test provenance human before delete", skillProvenance("del-test") === "human");
  check("(5d) deleteSkill returns true", deleteSkill("del-test") === true);
  check("(5d) provenance cleared after delete (unknown, not stale 'human')", skillProvenance("del-test") === null);

  // =====================================================================================================
  // (3) ROUND 3 SCOPE CUT — bare isBundledSkill (plus "human") gates locked-role trust again. These two
  // cases must be RED on tip 7ed50c2c (round 2's isTrustedBundledContent wrongly withheld both) and GREEN
  // here: a legitimate bundled skill must still reach a locked role even when its content doesn't match
  // the currently-shipped asset. The bundled-NAME-COLLISION case this can't catch is tracked on 9a3dea30.
  // =====================================================================================================

  // (A) a pre-provenance customization: a hand-edited bundled skill whose content diverges from the
  // shipped asset, never stamped at all (predates provenance tracking) — must still reach a locked role.
  writeAsset("custom-legacy", skillMd("custom-legacy", "SHIPPED"));
  check("precondition: custom-legacy customized, unstamped", writeSkill("custom-legacy", skillMd("custom-legacy", "HAND-EDITED")) === true);
  check("precondition: custom-legacy resolves bundled", isBundledSkill("custom-legacy") === true);
  check("precondition: custom-legacy content diverges from shipped", readStoreFile("custom-legacy") !== fs.readFileSync(path.join(assetDir, "custom-legacy", "SKILL.md"), "utf8"));
  check("precondition: custom-legacy has no provenance stamp", skillProvenance("custom-legacy") === null);
  const cwdCustomLegacy = path.join(root, "locked-cwd-a");
  fs.mkdirSync(cwdCustomLegacy, { recursive: true });
  injectSkills(cwdCustomLegacy, "sess-locked-a", null, "assistant");
  check("(3A) a locked role's deliver-all default DELIVERS a customized, unstamped bundled skill", fs.existsSync(path.join(cwdCustomLegacy, ".claude", "skills", "custom-legacy")));

  // (B) a pristine store copy ahead of an advanced shipped asset: the store was seeded pristine (matches
  // the OLD shipped version), then Loom ships a NEWER asset version without a reseed landing it — must
  // still reach a locked role even though the store no longer matches the CURRENT shipped content.
  writeAsset("advance-test", skillMd("advance-test", "V1"));
  check("precondition: advance-test pristine against V1", writeSkill("advance-test", skillMd("advance-test", "V1")) === true);
  writeAsset("advance-test", skillMd("advance-test", "V2")); // simulate Loom shipping an advanced asset, no reseed
  check("precondition: advance-test resolves bundled", isBundledSkill("advance-test") === true);
  check("precondition: advance-test content diverges from the now-current shipped asset", readStoreFile("advance-test") !== fs.readFileSync(path.join(assetDir, "advance-test", "SKILL.md"), "utf8"));
  const cwdAdvanceTest = path.join(root, "locked-cwd-b");
  fs.mkdirSync(cwdAdvanceTest, { recursive: true });
  injectSkills(cwdAdvanceTest, "sess-locked-b", null, "assistant");
  check("(3B) a locked role's deliver-all default DELIVERS a pristine copy ahead of an advanced asset", fs.existsSync(path.join(cwdAdvanceTest, ".claude", "skills", "advance-test")));

  // =====================================================================================================
  // listSkills() surfaces `provenance` for user skills, omits it for bundled ones.
  // =====================================================================================================
  const summaries = listSkills();
  const flipSummary = summaries.find((s) => s.name === "flip-test");
  check("listSkills: user skill carries provenance", flipSummary?.provenance === "agent");
  const bundledSummary = summaries.find((s) => s.name === "custom-legacy");
  check("listSkills: bundled skill omits provenance", bundledSummary && !("provenance" in bundledSummary));

  // =====================================================================================================
  // (5b) REST POST/PUT "human" stamp — a regression pin: dropping `"human"` from gateway/server.ts's
  // writeSkill calls (~POST/PUT /api/skills) must fail this test.
  // =====================================================================================================
  const db = new Db(path.join(home, "rest.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const postRes = await app.inject({ method: "POST", url: "/api/skills", payload: { name: "rest-created", content: skillMd("rest-created") } });
  check("(5b) POST /api/skills creates the skill", postRes.statusCode === 201);
  check("(5b) POST /api/skills stamps human", skillProvenance("rest-created") === "human");

  // Make it agent-stamped first (simulating a prior MCP write), then PUT via the human REST route and
  // confirm the human stamp re-asserts itself — the overwrite-direction regression pin.
  check("precondition: rest-created forced to agent before PUT", writeSkill("rest-created", skillMd("rest-created", "pre-put"), "agent") === true);
  check("precondition: rest-created now agent", skillProvenance("rest-created") === "agent");
  const putRes = await app.inject({ method: "PUT", url: "/api/skills/rest-created", payload: { content: skillMd("rest-created", "via-put") } });
  check("(5b) PUT /api/skills/:name succeeds", putRes.statusCode === 200);
  check("(5b) PUT /api/skills/:name re-stamps human", skillProvenance("rest-created") === "human");

  // =====================================================================================================
  // (6) card 35099271 item 1 — adoptSkillUpdate / resetSkillToBundled / skillWriteData's bundled-asset
  //     publish branch must each surface a failed provenance-stamp write as its OWN distinct outcome,
  //     never silently proceed as if the write succeeded. Same EISDIR fault injection as section (1).
  // =====================================================================================================
  const provTmp2 = `${SKILL_PROVENANCE_FILE}.tmp`;

  // (6a) adoptSkillUpdate: content lands (write-then-stamp ordering), but the stamp write fails.
  writeAsset("adopt-stamp-fail", skillMd("adopt-stamp-fail", "SHIPPED"));
  check("(6a) precondition: existing store copy", writeSkill("adopt-stamp-fail", skillMd("adopt-stamp-fail", "OLD")) === true);
  fs.mkdirSync(provTmp2, { recursive: true });
  try {
    const adoptResult = adoptSkillUpdate("adopt-stamp-fail", skillMd("adopt-stamp-fail", "NEW"));
    check("(6a) adoptSkillUpdate returns {error:\"provenance-stamp-failed\"}, not the skill, not null", adoptResult !== null && typeof adoptResult === "object" && adoptResult.error === "provenance-stamp-failed");
    check("(6a) the content WAS written despite the stamp failure", readStoreFile("adopt-stamp-fail").includes("NEW"));
  } finally {
    fs.rmSync(provTmp2, { recursive: true, force: true });
  }
  const adoptOk = adoptSkillUpdate("adopt-stamp-fail", skillMd("adopt-stamp-fail", "NEW2"));
  check("(6a) adopt succeeds once unblocked", adoptOk?.content?.includes("NEW2") === true);
  check("(6a) provenance now human", skillProvenance("adopt-stamp-fail") === "human");

  // (6b) resetSkillToBundled: content IS discarded+restored, but the stamp write fails.
  writeAsset("reset-stamp-fail", skillMd("reset-stamp-fail", "SHIPPED"));
  check("(6b) precondition: existing store copy", writeSkill("reset-stamp-fail", skillMd("reset-stamp-fail", "OLD")) === true);
  fs.mkdirSync(provTmp2, { recursive: true });
  try {
    const resetResult = resetSkillToBundled("reset-stamp-fail");
    check("(6b) resetSkillToBundled returns {error:\"provenance-stamp-failed\"}, not true", resetResult !== true && typeof resetResult === "object" && resetResult.error === "provenance-stamp-failed");
    check("(6b) the content WAS reset despite the stamp failure", readStoreFile("reset-stamp-fail").includes("SHIPPED") && !readStoreFile("reset-stamp-fail").includes("OLD"));
  } finally {
    fs.rmSync(provTmp2, { recursive: true, force: true });
  }
  const resetOk = resetSkillToBundled("reset-stamp-fail");
  check("(6b) reset succeeds once unblocked", resetOk === true);
  check("(6b) provenance now human", skillProvenance("reset-stamp-fail") === "human");

  // (6c) skillWriteData's bundled-asset publish branch (the Lead's agent-driven skill_write) must return
  // an { error } when its clearSkillProvenance fails — never silently { ok: true }. clearSkillProvenance
  // short-circuits to true (no write attempted) when nothing is stamped, so pre-stamp "agent" first —
  // otherwise this would pass vacuously without ever exercising the write-failure path.
  //
  // Card 35099271 round 2: clear-first, abort-BEFORE-write ordering (mirrors writeSkill's own "agent"
  // branch, @decision 509176c8) — the fault-injected clear must now fail BEFORE any content lands, so the
  // store copy stays at its PRE-CALL content, never the new content under an unresolved stamp failure.
  writeAsset("lead-publish-stamp-fail", skillMd("lead-publish-stamp-fail", "OLD"));
  check("(6c) precondition: pre-stamped agent so clearSkillProvenance has something to clear", writeSkill("lead-publish-stamp-fail", skillMd("lead-publish-stamp-fail", "OLD"), "agent") === true);
  fs.mkdirSync(provTmp2, { recursive: true });
  try {
    const swResult = skillWriteData({ name: "lead-publish-stamp-fail", content: skillMd("lead-publish-stamp-fail", "NEW"), confirm: true }, { allowBundledAsset: true });
    check("(6c) skill_write returns an error when clearSkillProvenance fails", typeof swResult.error === "string" && !swResult.ok);
    check("(6c) fixed: clear-first ordering means the new content was NEVER written while the clear is unresolved", readStoreFile("lead-publish-stamp-fail").includes("OLD") && !readStoreFile("lead-publish-stamp-fail").includes("NEW"));
    check("(6c) the stale \"agent\" stamp is still present (clear never ran to completion)", skillProvenance("lead-publish-stamp-fail") === "agent");
  } finally {
    fs.rmSync(provTmp2, { recursive: true, force: true });
  }
  const swOk = skillWriteData({ name: "lead-publish-stamp-fail", content: skillMd("lead-publish-stamp-fail", "NEW2"), confirm: true }, { allowBundledAsset: true });
  check("(6c) skill_write succeeds once unblocked", swOk.ok === true);
  check("(6c) unblocked write actually landed the new content", readStoreFile("lead-publish-stamp-fail").includes("NEW2"));
  check("(6c) fixed: the stamp is left null, never \"human\" — an agent actor is never entitled to that", skillProvenance("lead-publish-stamp-fail") === null);

  // =====================================================================================================
  // (7) card 35099271 item 2 — the HUMAN REST publish route stamps "human", and fails the response (not
  //     a silent 200) when that stamp write fails. The agent-driven skill_write path above (6c) is
  //     deliberately NOT affected — it stays on clearSkillProvenance, never "human".
  // =====================================================================================================
  writeAsset("rest-publish-human", skillMd("rest-publish-human", "OLD"));
  check("(7) precondition: rest-publish-human stamped agent (simulating a prior MCP write)", writeSkill("rest-publish-human", skillMd("rest-publish-human", "EDITED"), "agent") === true);
  process.env.LOOM_DEV = "1"; // dev/self-host edition (read at call time by isLoomDev)
  try {
    const pubRes = await app.inject({ method: "POST", url: "/api/skills/rest-publish-human/publish" });
    check("(7) POST /api/skills/:name/publish 200", pubRes.statusCode === 200 && pubRes.json().ok === true);
    check("(7) publish actually pushed the store edit into the asset", fs.readFileSync(path.join(assetDir, "rest-publish-human", "SKILL.md"), "utf8").includes("EDITED"));
    check("(7) publish stamps human (even though the pre-existing stamp was agent)", skillProvenance("rest-publish-human") === "human");

    // Stamp-write failure path: the publish itself (asset write) must still succeed; only the
    // provenance record lags — the route must fail loudly (500), never a silent 200.
    fs.mkdirSync(provTmp2, { recursive: true });
    try {
      const pubFailRes = await app.inject({ method: "POST", url: "/api/skills/rest-publish-human/publish" });
      check("(7) publish 500s when the human-stamp write fails (not a silent 200)", pubFailRes.statusCode === 500);
      check("(7) the asset WAS still published despite the stamp failure", fs.readFileSync(path.join(assetDir, "rest-publish-human", "SKILL.md"), "utf8").includes("EDITED"));
    } finally {
      fs.rmSync(provTmp2, { recursive: true, force: true });
    }
  } finally {
    delete process.env.LOOM_DEV;
  }

  // =====================================================================================================
  // (8) card 35099271 round 2, item 1 — adopt ORDERING through REST: content → stamp → writeBase, never
  //     writeBase before the stamp. A failed stamp must leave `updateAvailable` TRUE (writeBase never ran),
  //     so the route's own "retry to re-stamp it" advice is actually true — the retry must land 200, not
  //     409 "no update available". This is the shape that would go RED if writeBase ran before the stamp.
  // =====================================================================================================
  writeAsset("adopt-rest-order", skillMd("adopt-rest-order", "SHIPPED"));
  writeBaseFile("adopt-rest-order", skillMd("adopt-rest-order", "OLD")); // base behind shipped -> update available
  check("(8) precondition: existing store copy (mine == base, clean fast-forward)", writeSkill("adopt-rest-order", skillMd("adopt-rest-order", "OLD")) === true);
  check("(8) precondition: update is available", skillUpdateAvailable("adopt-rest-order") === true);
  fs.mkdirSync(provTmp2, { recursive: true });
  try {
    const adoptFailRes = await app.inject({ method: "POST", url: "/api/skills/adopt-rest-order/adopt", payload: { content: skillMd("adopt-rest-order", "SHIPPED") } });
    check("(8) adopt 500s when the stamp write fails (not a silent 200)", adoptFailRes.statusCode === 500);
    check("(8) fixed: updateAvailable STAYS true after a failed stamp — writeBase never ran ahead of it", skillUpdateAvailable("adopt-rest-order") === true);
  } finally {
    fs.rmSync(provTmp2, { recursive: true, force: true });
  }
  const adoptRetryRes = await app.inject({ method: "POST", url: "/api/skills/adopt-rest-order/adopt", payload: { content: skillMd("adopt-rest-order", "SHIPPED") } });
  check("(8) fixed: retry succeeds 200, never 409 \"no update available\"", adoptRetryRes.statusCode === 200);
  check("(8) retry actually adopted the content", readStoreFile("adopt-rest-order").includes("SHIPPED"));
  check("(8) retry stamps human", skillProvenance("adopt-rest-order") === "human");
  check("(8) update is now resolved", skillUpdateAvailable("adopt-rest-order") === false);

  // =====================================================================================================
  // (9) /reset REST coverage for the same stamp-failure shape (6b already drove resetSkillToBundled
  //     directly; this drives it through the REST route). resetSkillToBundled's own order (stamp before
  //     writeBase) was ALREADY correct — this is coverage, not a behavior change.
  // =====================================================================================================
  writeAsset("reset-rest-order", skillMd("reset-rest-order", "SHIPPED"));
  check("(9) precondition: existing divergent store copy", writeSkill("reset-rest-order", skillMd("reset-rest-order", "OLD")) === true);
  fs.mkdirSync(provTmp2, { recursive: true });
  try {
    const resetFailRes = await app.inject({ method: "POST", url: "/api/skills/reset-rest-order/reset" });
    check("(9) reset 500s when the stamp write fails (not a silent 200)", resetFailRes.statusCode === 500);
    check("(9) the content WAS still reset despite the stamp failure", readStoreFile("reset-rest-order").includes("SHIPPED") && !readStoreFile("reset-rest-order").includes("OLD"));
  } finally {
    fs.rmSync(provTmp2, { recursive: true, force: true });
  }
  const resetRetryRes = await app.inject({ method: "POST", url: "/api/skills/reset-rest-order/reset" });
  check("(9) retry succeeds 200", resetRetryRes.statusCode === 200);
  check("(9) retry stamps human", skillProvenance("reset-rest-order") === "human");

  await app.close();
  db.close();
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — provenance write ordering, corrupt-map safety, bare-isBundledSkill locked-role trust, the Object.prototype read bug, card 35099271's stamp-failure outcomes (adopt/reset/skill_write/publish), and round 2's adopt/reset REST ordering are all fixed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
