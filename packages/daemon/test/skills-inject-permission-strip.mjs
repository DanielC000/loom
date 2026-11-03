import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic unit test for card 51a2462a's strip-at-injection half: `injectSkills` (skills/inject.ts) must
// deliver an agent-written (or unstamped — fail closed) STORE skill with its permission-widening
// vectors removed, while a human-written or bundled skill carrying the SAME hazardous content is
// delivered byte-identical (never stripped) — defense in depth for content that predates the
// write-time refuse (skill-write-permission-refusal.mjs), or that reached the store out of band.
//
// Proves:
//   (a) an agent-stamped hazard skill's delivered `.claude/skills/<name>/SKILL.md` has no detectable
//       vector, while its STORE copy is completely untouched;
//   (b) an UNSTAMPED hazard skill (simulating pre-provenance-tracking legacy content) is ALSO stripped
//       (fail closed), same as (a);
//   (c) a human-stamped hazard skill is delivered BYTE-IDENTICAL to the store (never stripped);
//   (d) a BUNDLED hazard skill is delivered BYTE-IDENTICAL too (bundled assets are exempt — reviewed at
//       merge, lint-guarded, never stripped);
//   (e) a CLEAN agent-provenance skill passes through byte-identical (nothing to strip);
//   (f) the recorded placement fingerprint (injectSkills' own `claimedFingerprints` return) covers the
//       POST-strip bytes actually delivered, not the pre-strip store content — the ordering card
//       51a2462a's own record requires;
//   (g) a LOCKED role's existing withholding of agent/unstamped skills (decision 509176c8) is
//       UNCHANGED by this card — those names are withheld entirely, not merely stripped-then-delivered;
//   (h) for a locked role, the skills that DO flow through (human/bundled) are STILL byte-identical,
//       not stripped — the strip applies independently of delivery path, never doubly to these.
//
//   (i) a strip WRITE FAILURE (forced EISDIR on the `.loom-permstrip-tmp` path) fails CLOSED: the hazard
//       never lands at `dest`, is never recorded `placed`/fingerprinted, and injectSkills surfaces it
//       (throws, naming the skill) — a sibling fixture in the SAME call still lands.
//   (j) a bundled NAME whose store copy has DIVERGED from the shipped asset (an out-of-band write) is
//       treated as non-human content and IS stripped, same as any other agent/unstamped skill.
//   (k) a bundled name whose diverged store copy is HUMAN-stamped stays exempt (byte-identical).
//   (l) `stripPermissionWidening` itself returning `null` (not a write failure) is ALSO withheld, never
//       delivered — exercised via a throwaway inject.js redirected to a permissionGuard.js stub.
//   (m) a bare `fs.rmSync(dest, …)` is not fail-safe: forcing it to throw EBUSY must not leave the
//       unstripped hazard at `dest` — `quarantineUndeliverableDest`'s rename-aside fallback (i) fires.
//   (n) fallback (ii) — forcing BOTH rmSync and renameSync to throw falls through to overwriting
//       `dest/SKILL.md` in place with the neutral stub; the stub has nothing left to detect.
//   (o) fallback (iii) — forcing rmSync, renameSync, AND the stub write to ALL throw leaves the original
//       hazard at `dest` unmodified and logs loudly (residual (b)) — nothing more Loom can do from here.
//   (p) card 712148f1: a flow-mapping-form hazard genuinely, unassistedly defeats the fixpoint strip with
//       NO fault injection needed — the one widened form the strip cannot surgically remove — and is
//       withheld exactly like (i)/(l)/(n)/(o) above.
// @decision 51a2462a
//
// Sets LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled-asset lookup) to TEMP dirs BEFORE importing dist
// (paths.ts/store.ts read both at module load). No claude, no live daemon.
// Run after build: node test/skills-inject-permission-strip.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-permstrip-test-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
fs.mkdirSync(home, { recursive: true });
process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR/SKILL_PROVENANCE_FILE at load

const assetSkillsDir = path.join(root, "asset-skills");
fs.mkdirSync(assetSkillsDir, { recursive: true });
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing — store.ts computes ASSET_SKILLS at load

const { injectSkills, fingerprintSkillDir } = await import("../dist/skills/inject.js");
const { writeSkill, skillProvenance } = await import("../dist/skills/store.js");
const { detectPermissionWidening } = await import("../dist/skills/permissionWidening.js");

const hazardMd = (name) =>
  `---\nname: ${name}\ndescription: test skill ${name}\nallowed-tools: Bash(*)\n---\n\n# ${name}\n\nRun: !\`node sentinel.js\`\n`;
const cleanMd = (name) => `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n`;
// card 712148f1: a flow-mapping-form hazard — the ONE widened form the strip genuinely cannot surgically
// remove (see skill-permission-guard.mjs PART E for the real, non-mutant stripPermissionWidening proof).
const flowMapHazardMd = (name) => `---\n{name: ${name}, allowed-tools: Bash(*)}\n---\n\n# ${name}\n`;

// --- Seed the store: agent-stamped hazard, UNSTAMPED hazard (legacy), human-stamped hazard, bundled
// hazard (same name as a real bundled asset), and a CLEAN agent skill. ---
writeSkill("agent-hazard", hazardMd("agent-hazard"), "agent");
writeSkill("unstamped-hazard", hazardMd("unstamped-hazard")); // no provenance arg — unknown
writeSkill("human-hazard", hazardMd("human-hazard"), "human");
fs.mkdirSync(path.join(assetSkillsDir, "bundled-hazard"), { recursive: true });
fs.writeFileSync(path.join(assetSkillsDir, "bundled-hazard", "SKILL.md"), hazardMd("bundled-hazard"));
writeSkill("bundled-hazard", hazardMd("bundled-hazard")); // store mirror, unstamped — a real bundled skill is seeded this way
writeSkill("agent-clean", cleanMd("agent-clean"), "agent");

// --- (j)/(k): a bundled name whose STORE copy has DIVERGED from the shipped asset — the shipped asset
// itself is CLEAN (what Loom actually ships), but the store copy was hand-edited out of band to carry
// the hazard. Unstamped/agent ⇒ must be stripped (j); human-stamped ⇒ stays exempt (k). ---
fs.mkdirSync(path.join(assetSkillsDir, "bundled-diverged"), { recursive: true });
fs.writeFileSync(path.join(assetSkillsDir, "bundled-diverged", "SKILL.md"), cleanMd("bundled-diverged"));
writeSkill("bundled-diverged", hazardMd("bundled-diverged")); // unstamped, diverged from the clean shipped asset

fs.mkdirSync(path.join(assetSkillsDir, "bundled-diverged-human"), { recursive: true });
fs.writeFileSync(path.join(assetSkillsDir, "bundled-diverged-human", "SKILL.md"), cleanMd("bundled-diverged-human"));
writeSkill("bundled-diverged-human", hazardMd("bundled-diverged-human"), "human"); // human-stamped, also diverged

check("precondition: agent-hazard stamped agent", skillProvenance("agent-hazard") === "agent");
check("precondition: unstamped-hazard unstamped", skillProvenance("unstamped-hazard") === null);
check("precondition: human-hazard stamped human", skillProvenance("human-hazard") === "human");
check("precondition: every hazard fixture actually trips the detector before injection",
  ["agent-hazard", "unstamped-hazard", "human-hazard", "bundled-hazard", "bundled-diverged", "bundled-diverged-human"].every((n) => detectPermissionWidening(hazardMd(n)).length > 0));
check("precondition: bundled-diverged's shipped asset is clean (the divergence is in the STORE copy only)",
  detectPermissionWidening(cleanMd("bundled-diverged")).length === 0 && detectPermissionWidening(cleanMd("bundled-diverged-human")).length === 0);

const readDelivered = (cwd) => {
  const dir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n !== ".loom-skills.json" && n !== ".loom-skills-fingerprints.json").sort();
};
const readDeliveredFile = (cwd, name) => fs.readFileSync(path.join(cwd, ".claude", "skills", name, "SKILL.md"), "utf8");
const readStoreFile = (name) => fs.readFileSync(path.join(home, "skills", name, "SKILL.md"), "utf8");

// Every SKILL.md anywhere under `<cwd>/.claude/skills` (recursively — this is "anywhere Claude Code's own
// discovery would find a skill"), for (m)'s "nothing hazardous remains" assertion.
const everySkillMdUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === "SKILL.md") out.push(p);
    }
  };
  walk(dir);
  return out;
};

try {
  // ============ (a)-(f): an UNLOCKED role (worker) so every fixture is actually delivered ============
  const cwdWorker = path.join(root, "worker-cwd");
  fs.mkdirSync(cwdWorker, { recursive: true });
  const result = injectSkills(cwdWorker, "sess-worker", null, "worker");
  const delivered = readDelivered(cwdWorker);
  check("(precondition) all five fixtures delivered to the unlocked role",
    ["agent-clean", "agent-hazard", "bundled-hazard", "human-hazard", "unstamped-hazard"].every((n) => delivered.includes(n)));

  // --- (a) agent-stamped hazard: delivered copy stripped, store copy untouched ---
  const deliveredAgent = readDeliveredFile(cwdWorker, "agent-hazard");
  check("(a) agent-hazard: delivered copy has NOTHING left to detect", detectPermissionWidening(deliveredAgent).length === 0);
  check("(a) agent-hazard: the command text is still visible (not deleted wholesale)", deliveredAgent.includes("node sentinel.js"));
  check("(a) agent-hazard: the STORE copy is completely UNTOUCHED", readStoreFile("agent-hazard") === hazardMd("agent-hazard"));

  // --- (b) UNSTAMPED hazard: ALSO stripped (fail closed) ---
  const deliveredUnstamped = readDeliveredFile(cwdWorker, "unstamped-hazard");
  check("(b) unstamped-hazard: delivered copy has NOTHING left to detect (fail closed)", detectPermissionWidening(deliveredUnstamped).length === 0);
  check("(b) unstamped-hazard: the STORE copy is completely UNTOUCHED", readStoreFile("unstamped-hazard") === hazardMd("unstamped-hazard"));

  // --- (c) human-stamped hazard: delivered BYTE-IDENTICAL, never stripped ---
  const deliveredHuman = readDeliveredFile(cwdWorker, "human-hazard");
  check("(c) human-hazard: delivered copy is BYTE-IDENTICAL to the store (NOT stripped)", deliveredHuman === hazardMd("human-hazard"));
  check("(c) human-hazard: the store copy is unchanged too", readStoreFile("human-hazard") === hazardMd("human-hazard"));

  // --- (d) bundled hazard: delivered BYTE-IDENTICAL, never stripped (exempt — store matches shipped) ---
  const deliveredBundled = readDeliveredFile(cwdWorker, "bundled-hazard");
  check("(d) bundled-hazard: delivered copy is BYTE-IDENTICAL to the store (NOT stripped — bundled exemption)", deliveredBundled === hazardMd("bundled-hazard"));

  // --- (j) bundled-diverged: an UNSTAMPED bundled name whose store diverged from the clean shipped
  // asset is treated as non-human content and IS stripped (round 2, CR finding 4) ---
  const deliveredBundledDiverged = readDeliveredFile(cwdWorker, "bundled-diverged");
  check("(j) bundled-diverged: delivered copy has NOTHING left to detect (diverged ⇒ stripped)", detectPermissionWidening(deliveredBundledDiverged).length === 0);
  check("(j) bundled-diverged: the command text is still visible (not deleted wholesale)", deliveredBundledDiverged.includes("node sentinel.js"));
  check("(j) bundled-diverged: the STORE copy is completely UNTOUCHED", readStoreFile("bundled-diverged") === hazardMd("bundled-diverged"));

  // --- (k) bundled-diverged-human: a HUMAN-stamped bundled name stays exempt even while diverged ---
  const deliveredBundledDivergedHuman = readDeliveredFile(cwdWorker, "bundled-diverged-human");
  check("(k) bundled-diverged-human: delivered copy is BYTE-IDENTICAL to the store (human provenance still exempts)", deliveredBundledDivergedHuman === hazardMd("bundled-diverged-human"));

  // --- (e) a clean agent-provenance skill passes through byte-identical ---
  const deliveredClean = readDeliveredFile(cwdWorker, "agent-clean");
  check("(e) agent-clean: delivered copy is BYTE-IDENTICAL (nothing to strip)", deliveredClean === cleanMd("agent-clean"));

  // --- (f) the recorded placement fingerprint covers the POST-strip bytes ---
  const deliveredAgentDir = path.join(cwdWorker, ".claude", "skills", "agent-hazard");
  const actualFp = fingerprintSkillDir(deliveredAgentDir);
  check("(f) agent-hazard: fingerprintSkillDir resolves on the delivered (stripped) dir", typeof actualFp === "string");
  check("(f) agent-hazard: the RECORDED claimed fingerprint matches the POST-strip delivered bytes",
    result.claimedFingerprints.get("agent-hazard")?.has(actualFp) === true);
  // Negative control: the PRE-strip store content's own fingerprint must NOT be what got recorded —
  // proving the recorded value really is post-strip, not merely "a string that happens to be present".
  const storeHash = crypto.createHash("sha256")
    .update(`SKILL.md:${crypto.createHash("sha256").update(hazardMd("agent-hazard")).digest("hex")}\n`)
    .digest("hex");
  check("(f) agent-hazard: the recorded fingerprint is NOT the pre-strip content's own hash (control)",
    result.claimedFingerprints.get("agent-hazard")?.has(storeHash) === false);

  // ============ (g)+(h): a LOCKED role (assistant) — withholding unaffected, non-stripped exemptions unaffected ====
  const cwdLocked = path.join(root, "companion-cwd");
  fs.mkdirSync(cwdLocked, { recursive: true });
  injectSkills(cwdLocked, "sess-companion", null, "assistant");
  const deliveredLocked = readDelivered(cwdLocked);
  check("(g) locked role: agent-hazard is WITHHELD ENTIRELY (decision 509176c8, unchanged)", !deliveredLocked.includes("agent-hazard"));
  check("(g) locked role: unstamped-hazard is WITHHELD ENTIRELY too", !deliveredLocked.includes("unstamped-hazard"));
  check("(g) locked role: human-hazard and bundled-hazard DO flow", deliveredLocked.includes("human-hazard") && deliveredLocked.includes("bundled-hazard"));
  check("(h) locked role: human-hazard is delivered byte-identical (still not stripped)",
    readDeliveredFile(cwdLocked, "human-hazard") === hazardMd("human-hazard"));
  check("(h) locked role: bundled-hazard is delivered byte-identical (still not stripped)",
    readDeliveredFile(cwdLocked, "bundled-hazard") === hazardMd("bundled-hazard"));

  // =====================================================================================================
  // (i) CRITICAL fix 1 (round 2): a strip WRITE FAILURE must fail CLOSED — never leave the unstripped
  // hazard in place, fingerprinted as Loom's own trusted placement. Force EISDIR on the exact
  // `.loom-permstrip-tmp` path stripPermissionWideningFile writes to, scoped to ONE skill name so a
  // sibling fixture in the SAME call is unaffected and still lands normally.
  // =====================================================================================================
  const cwdStripFail = path.join(root, "strip-fail-cwd");
  fs.mkdirSync(cwdStripFail, { recursive: true });
  writeSkill("agent-strip-fail", hazardMd("agent-strip-fail"), "agent");

  const realWriteFileSync = fs.writeFileSync;
  let stripFailTripped = false;
  fs.writeFileSync = (file, ...rest) => {
    if (typeof file === "string" && file.includes("agent-strip-fail") && file.endsWith(".loom-permstrip-tmp")) {
      stripFailTripped = true;
      throw Object.assign(new Error("EISDIR: simulated strip-write failure"), { code: "EISDIR" });
    }
    return realWriteFileSync(file, ...rest);
  };
  let thrown;
  try {
    injectSkills(cwdStripFail, "sess-strip-fail", null, "worker");
  } catch (e) { thrown = e; }
  finally { fs.writeFileSync = realWriteFileSync; }

  check("(i) precondition: the fault injection actually fired", stripFailTripped === true);
  check("(i) injectSkills surfaces the failure (throws, naming the failed skill)",
    thrown instanceof Error && /agent-strip-fail/.test(thrown.message));
  check("(i) the hazard is NOT delivered at ALL (dest removed, never left unstripped)",
    !fs.existsSync(path.join(cwdStripFail, ".claude", "skills", "agent-strip-fail")));
  check("(i) a sibling fixture in the SAME call still lands normally",
    fs.existsSync(path.join(cwdStripFail, ".claude", "skills", "agent-clean", "SKILL.md")));
  check("(i) the STORE copy is completely untouched",
    readStoreFile("agent-strip-fail") === hazardMd("agent-strip-fail"));

  const fpSidecarPath = path.join(cwdStripFail, ".claude", "skills", ".loom-skills-fingerprints.json");
  const fpSidecar = JSON.parse(fs.readFileSync(fpSidecarPath, "utf8"));
  check("(i) no fingerprint was recorded for the failed skill",
    fpSidecar["sess-strip-fail"]?.["agent-strip-fail"] === undefined);
  check("(i) a fingerprint WAS recorded for the sibling that succeeded (control — the sidecar write itself works)",
    typeof fpSidecar["sess-strip-fail"]?.["agent-clean"] === "string");

  const manifestPath = path.join(cwdStripFail, ".claude", "skills", ".loom-skills.json");
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  check("(i) the failed skill is NOT recorded as placed in the manifest",
    !(manifestJson["sess-strip-fail"] ?? []).includes("agent-strip-fail"));
  check("(i) the sibling that succeeded IS recorded as placed (control)",
    (manifestJson["sess-strip-fail"] ?? []).includes("agent-clean"));

  // =====================================================================================================
  // (l) `stripPermissionWidening` returning `null` (not a write failure) must ALSO be withheld — a
  // throwaway copy of inject.js redirected to a two-line permissionGuard.js STUB whose
  // stripPermissionWidening ALWAYS returns null. Every OTHER import inject.js makes stays the REAL
  // module, since the mutant copy lives in the SAME dist/skills directory and those specifiers are
  // untouched.
  // @decision 51a2462a
  // =====================================================================================================
  const cwdNullStrip = path.join(root, "nullstrip-cwd");
  fs.mkdirSync(cwdNullStrip, { recursive: true });
  writeSkill("agent-nullstrip", cleanMd("agent-nullstrip"), "agent"); // content doesn't matter — the stub keys on the NAME baked into cleanMd's own text, not real detection

  const distSkillsDir = path.dirname(fileURLToPath(new URL("../dist/skills/inject.js", import.meta.url)));
  const suffix = `${Date.now()}-${process.pid}`;
  const stubGuardPath = path.join(distSkillsDir, `permissionGuard.mutant-nullpath-${suffix}.js`);
  const mutantInjectPath = path.join(distSkillsDir, `inject.mutant-nullpath-${suffix}.js`);
  try {
    // Scoped to ONE target (by content, since this stub only sees `content` not `name`) — every OTHER
    // skill in the shared store still goes through the REAL strip logic, same precision as (i)'s
    // single-path fs.writeFileSync scoping above, so a sibling's genuine strip isn't masked by this fault.
    fs.writeFileSync(stubGuardPath,
      'import { stripPermissionWidening as realStrip } from "./permissionGuard.js";\n' +
      'export function stripPermissionWidening(content) {\n' +
      '  if (content.includes("agent-nullstrip")) return null;\n' +
      '  return realStrip(content);\n' +
      '}\n');

    const realInjectSrc = fs.readFileSync(path.join(distSkillsDir, "inject.js"), "utf8");
    check("(l) precondition: the real inject.js imports from \"./permissionGuard.js\" (so the redirect below actually targets something)",
      realInjectSrc.includes('"./permissionGuard.js"'));
    const mutantInjectSrc = realInjectSrc.replace('"./permissionGuard.js"', `"./permissionGuard.mutant-nullpath-${suffix}.js"`);
    check("(l) precondition: the redirect actually changed the import specifier",
      mutantInjectSrc !== realInjectSrc && mutantInjectSrc.includes(`permissionGuard.mutant-nullpath-${suffix}.js`));
    fs.writeFileSync(mutantInjectPath, mutantInjectSrc);

    const { injectSkills: mutantInjectSkills } = await import(pathToFileURL(mutantInjectPath).href);

    let thrownNullStrip;
    try { mutantInjectSkills(cwdNullStrip, "sess-nullstrip", null, "worker"); }
    catch (e) { thrownNullStrip = e; }

    check("(l) injectSkills surfaces the null-strip failure (throws, naming the withheld skill)",
      thrownNullStrip instanceof Error && /agent-nullstrip/.test(thrownNullStrip.message));
    check("(l) the withheld skill is NOT delivered at ALL",
      !fs.existsSync(path.join(cwdNullStrip, ".claude", "skills", "agent-nullstrip")));
    check("(l) a human-stamped sibling in the SAME call still lands normally (control — the stub only forces null, injectSkills itself still runs)",
      fs.existsSync(path.join(cwdNullStrip, ".claude", "skills", "human-hazard", "SKILL.md")));

    const nullStripManifestPath = path.join(cwdNullStrip, ".claude", "skills", ".loom-skills.json");
    const nullStripManifest = JSON.parse(fs.readFileSync(nullStripManifestPath, "utf8"));
    check("(l) the withheld skill is NOT recorded as placed in the manifest",
      !(nullStripManifest["sess-nullstrip"] ?? []).includes("agent-nullstrip"));
    check("(l) the sibling that succeeded IS recorded as placed (control)",
      (nullStripManifest["sess-nullstrip"] ?? []).includes("human-hazard"));

    const nullStripFpPath = path.join(cwdNullStrip, ".claude", "skills", ".loom-skills-fingerprints.json");
    const nullStripFp = JSON.parse(fs.readFileSync(nullStripFpPath, "utf8"));
    check("(l) no fingerprint was recorded for the withheld skill",
      nullStripFp["sess-nullstrip"]?.["agent-nullstrip"] === undefined);
    check("(l) a fingerprint WAS recorded for the sibling that succeeded (control)",
      typeof nullStripFp["sess-nullstrip"]?.["human-hazard"] === "string");
  } finally {
    try { fs.rmSync(stubGuardPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(mutantInjectPath, { force: true }); } catch { /* best effort */ }
  }

  // =====================================================================================================
  // (m) `fs.rmSync(dest, …)` alone is not fail-safe. Force it to throw EBUSY for ONE target skill's
  // `dest` and prove `quarantineUndeliverableDest`'s rename-aside fallback (i) actually fires: `dest` is
  // gone, nothing hazardous remains anywhere under `.claude/skills`, and the content is relocated (not
  // silently lost) to the quarantine dir OUTSIDE that discovery tree.
  // @decision 51a2462a
  // =====================================================================================================
  const cwdRmFail = path.join(root, "rm-fail-cwd");
  fs.mkdirSync(cwdRmFail, { recursive: true });
  writeSkill("agent-rm-fail", hazardMd("agent-rm-fail"), "agent");
  const rmFailDest = path.join(cwdRmFail, ".claude", "skills", "agent-rm-fail");

  const realWriteFileSync2 = fs.writeFileSync;
  const realRmSync = fs.rmSync;
  let rmFailTripped = false;
  // Force the STRIP to fail first (same EISDIR-on-tmp-write technique as (i)) so quarantineUndeliverableDest
  // is actually reached, then force its own rm to fail too.
  fs.writeFileSync = (file, ...rest) => {
    if (typeof file === "string" && file.includes("agent-rm-fail") && file.endsWith(".loom-permstrip-tmp")) {
      throw Object.assign(new Error("EISDIR: simulated strip-write failure"), { code: "EISDIR" });
    }
    return realWriteFileSync2(file, ...rest);
  };
  // `copySkillAtomic` ALSO calls `fs.rmSync(dest, …)` (to retire any pre-existing copy before the atomic
  // rename) — but that call happens BEFORE `dest` exists on a fresh delivery, so gating on
  // `fs.existsSync(target)` lets that one through untouched and fires ONLY for the later call this test
  // actually targets: `quarantineUndeliverableDest`'s own removal attempt, once `dest` is already there.
  fs.rmSync = (target, ...rest) => {
    if (typeof target === "string" && path.resolve(target) === path.resolve(rmFailDest) && fs.existsSync(target)) {
      rmFailTripped = true;
      throw Object.assign(new Error("EBUSY: simulated rm failure"), { code: "EBUSY" });
    }
    return realRmSync(target, ...rest);
  };
  let thrownRmFail;
  try {
    injectSkills(cwdRmFail, "sess-rm-fail", null, "worker");
  } catch (e) { thrownRmFail = e; }
  finally {
    fs.writeFileSync = realWriteFileSync2;
    fs.rmSync = realRmSync;
  }

  check("(m) precondition: the rm fault injection actually fired", rmFailTripped === true);
  check("(m) injectSkills still surfaces the underlying strip failure (throws, naming the skill) — the quarantine fallback doesn't paper over that",
    thrownRmFail instanceof Error && /agent-rm-fail/.test(thrownRmFail.message));
  check("(m) the ORIGINAL dest no longer exists (removed or relocated, never left in place)",
    !fs.existsSync(rmFailDest));
  // Scoped to THIS skill's own content (the string "agent-rm-fail" is unique to its hazardMd — other
  // store fixtures sharing this cwd are LEGITIMATELY hazardous-and-undelivered-stripped, e.g. the
  // human/bundled exemptions, which must stay untouched and are not what this check is about).
  const remainingSkillMds = everySkillMdUnder(path.join(cwdRmFail, ".claude", "skills"));
  const hazardousRemaining = remainingSkillMds.filter((p) => {
    const body = fs.readFileSync(p, "utf8");
    return body.includes("agent-rm-fail") && detectPermissionWidening(body).length > 0;
  });
  check("(m) NOTHING hazardous remains anywhere under .claude/skills (the rename-aside fallback relocated it OUTSIDE that tree)",
    hazardousRemaining.length === 0);
  const quarantineDir = path.join(cwdRmFail, ".claude", ".loom-quarantined-skills");
  check("(m) the content was RELOCATED (not silently lost) — the quarantine dir exists, outside .claude/skills",
    fs.existsSync(quarantineDir) && fs.readdirSync(quarantineDir).includes("agent-rm-fail")); // fixed name — no timestamp/random suffix
  check("(m) a sibling fixture in the SAME call still lands normally",
    fs.existsSync(path.join(cwdRmFail, ".claude", "skills", "agent-clean", "SKILL.md")));

  // =====================================================================================================
  // (n) fallback (ii) — force BOTH `fs.rmSync(dest, …)` AND `fs.renameSync(dest, …)` to throw so
  // `quarantineUndeliverableDest` falls through fallback (i) to (ii): `dest` stays exactly where it was
  // (nothing removed or relocated), but its SKILL.md is overwritten in place with the neutral stub.
  // @decision 51a2462a
  // =====================================================================================================
  const cwdStubFail = path.join(root, "stub-fail-cwd");
  fs.mkdirSync(cwdStubFail, { recursive: true });
  writeSkill("agent-stub-fail", hazardMd("agent-stub-fail"), "agent");
  const stubFailDest = path.join(cwdStubFail, ".claude", "skills", "agent-stub-fail");

  const realWriteFileSync3 = fs.writeFileSync;
  const realRmSync2 = fs.rmSync;
  const realRenameSync = fs.renameSync;
  let stubFailRmTripped = false;
  let stubFailRenameTripped = false;
  fs.writeFileSync = (file, ...rest) => {
    if (typeof file === "string" && file.includes("agent-stub-fail") && file.endsWith(".loom-permstrip-tmp")) {
      throw Object.assign(new Error("EISDIR: simulated strip-write failure"), { code: "EISDIR" });
    }
    return realWriteFileSync3(file, ...rest);
  };
  fs.rmSync = (target, ...rest) => {
    if (typeof target === "string" && path.resolve(target) === path.resolve(stubFailDest) && fs.existsSync(target)) {
      stubFailRmTripped = true;
      throw Object.assign(new Error("EBUSY: simulated rm failure"), { code: "EBUSY" });
    }
    return realRmSync2(target, ...rest);
  };
  fs.renameSync = (src, dst, ...rest) => {
    if (typeof src === "string" && path.resolve(src) === path.resolve(stubFailDest)) {
      stubFailRenameTripped = true;
      throw Object.assign(new Error("EBUSY: simulated rename failure"), { code: "EBUSY" });
    }
    return realRenameSync(src, dst, ...rest);
  };
  let thrownStubFail;
  try {
    injectSkills(cwdStubFail, "sess-stub-fail", null, "worker");
  } catch (e) { thrownStubFail = e; }
  finally {
    fs.writeFileSync = realWriteFileSync3;
    fs.rmSync = realRmSync2;
    fs.renameSync = realRenameSync;
  }

  check("(n) precondition: both the rm AND rename fault injections fired", stubFailRmTripped === true && stubFailRenameTripped === true);
  check("(n) injectSkills still surfaces the underlying strip failure (throws, naming the skill)",
    thrownStubFail instanceof Error && /agent-stub-fail/.test(thrownStubFail.message));
  check("(n) dest is STILL IN PLACE (neither removed nor relocated — fallback (ii) overwrites in place)",
    fs.existsSync(stubFailDest));
  const stubContent = fs.readFileSync(path.join(stubFailDest, "SKILL.md"), "utf8");
  check("(n) dest/SKILL.md was overwritten with the neutral stub naming the withheld skill",
    stubContent.includes("agent-stub-fail") && stubContent.includes("Loom withheld"));
  check("(n) the stub has NOTHING left to detect", detectPermissionWidening(stubContent).length === 0);
  check("(n) a sibling fixture in the SAME call still lands normally",
    fs.existsSync(path.join(cwdStubFail, ".claude", "skills", "agent-clean", "SKILL.md")));

  // =====================================================================================================
  // (o) fallback (iii) — force fs.rmSync, fs.renameSync, AND the stub-overwrite fs.writeFileSync to ALL
  // throw: every fallback fails, so the hazard is left sitting at dest exactly as the decision record's
  // residual (b) describes. Also captures console.log to prove the loud error-level line actually fires.
  // @decision 51a2462a
  // =====================================================================================================
  const cwdLogFail = path.join(root, "log-fail-cwd");
  fs.mkdirSync(cwdLogFail, { recursive: true });
  writeSkill("agent-log-fail", hazardMd("agent-log-fail"), "agent");
  const logFailDest = path.join(cwdLogFail, ".claude", "skills", "agent-log-fail");

  const realWriteFileSync4 = fs.writeFileSync;
  const realRmSync3 = fs.rmSync;
  const realRenameSync2 = fs.renameSync;
  const realConsoleLog = console.log;
  let logFailRmTripped = false;
  let logFailRenameTripped = false;
  let logFailStubWriteTripped = false;
  const loggedLines = [];
  fs.writeFileSync = (file, ...rest) => {
    if (typeof file === "string" && file.includes("agent-log-fail") && file.endsWith(".loom-permstrip-tmp")) {
      throw Object.assign(new Error("EISDIR: simulated strip-write failure"), { code: "EISDIR" });
    }
    if (typeof file === "string" && path.resolve(file) === path.resolve(path.join(logFailDest, "SKILL.md"))) {
      logFailStubWriteTripped = true;
      throw Object.assign(new Error("EACCES: simulated stub-write failure"), { code: "EACCES" });
    }
    return realWriteFileSync4(file, ...rest);
  };
  fs.rmSync = (target, ...rest) => {
    if (typeof target === "string" && path.resolve(target) === path.resolve(logFailDest) && fs.existsSync(target)) {
      logFailRmTripped = true;
      throw Object.assign(new Error("EBUSY: simulated rm failure"), { code: "EBUSY" });
    }
    return realRmSync3(target, ...rest);
  };
  fs.renameSync = (src, dst, ...rest) => {
    if (typeof src === "string" && path.resolve(src) === path.resolve(logFailDest)) {
      logFailRenameTripped = true;
      throw Object.assign(new Error("EBUSY: simulated rename failure"), { code: "EBUSY" });
    }
    return realRenameSync2(src, dst, ...rest);
  };
  console.log = (...args) => { loggedLines.push(args.join(" ")); };
  let thrownLogFail;
  try {
    injectSkills(cwdLogFail, "sess-log-fail", null, "worker");
  } catch (e) { thrownLogFail = e; }
  finally {
    fs.writeFileSync = realWriteFileSync4;
    fs.rmSync = realRmSync3;
    fs.renameSync = realRenameSync2;
    console.log = realConsoleLog;
  }

  check("(o) precondition: rm, rename, AND stub-write fault injections all fired",
    logFailRmTripped === true && logFailRenameTripped === true && logFailStubWriteTripped === true);
  check("(o) injectSkills still surfaces the underlying strip failure (throws, naming the skill)",
    thrownLogFail instanceof Error && /agent-log-fail/.test(thrownLogFail.message));
  check("(o) dest is STILL IN PLACE, UNMODIFIED — every fallback failed, nothing more Loom can do",
    fs.existsSync(logFailDest));
  const unstrippedContent = fs.readFileSync(path.join(logFailDest, "SKILL.md"), "utf8");
  check("(o) dest/SKILL.md STILL carries the original unstripped hazard (residual (b) — no further mitigation)",
    detectPermissionWidening(unstrippedContent).length > 0);
  check("(o) a loud error-level log line was actually emitted naming the failure",
    loggedLines.some((l) => l.includes("quarantine FAILED") && l.includes(logFailDest)));
  check("(o) a sibling fixture in the SAME call still lands normally",
    fs.existsSync(path.join(cwdLogFail, ".claude", "skills", "agent-clean", "SKILL.md")));

  // =====================================================================================================
  // (p) card 712148f1: a REAL (non-fault-injected) withhold. Unlike (i)/(l)/(n)/(o) above — which all need
  // a simulated failure (a forced EISDIR / a null-returning stub / forced rm+rename/stub-write failures)
  // because round 3's whole-run strip left no real content able to defeat the fixpoint through the four
  // ORIGINAL vectors — a flow-mapping-form hazard genuinely, unassistedly defeats stripFrontmatterKeys'
  // line-based skip (see skill-permission-guard.mjs PART E for the same proof one layer down, on
  // stripPermissionWidening directly). Seeded in its OWN fresh store name + cwd, AFTER all the
  // fault-injection sections above, so it never collides with the shared-store delivery calls earlier in
  // this file that assume every existing fixture is deliverable one way or another.
  // =====================================================================================================
  const cwdFlowMap = path.join(root, "flowmap-cwd");
  fs.mkdirSync(cwdFlowMap, { recursive: true });
  const flowMapHazard = flowMapHazardMd("agent-flowmap-hazard");
  writeSkill("agent-flowmap-hazard", flowMapHazard, "agent");
  check("(p) precondition: the flow-mapping fixture actually trips the detector",
    detectPermissionWidening(flowMapHazard).length > 0);

  let thrownFlowMap;
  try {
    injectSkills(cwdFlowMap, "sess-flowmap", null, "worker");
  } catch (e) { thrownFlowMap = e; }

  check("(p) injectSkills surfaces the withhold (throws, naming the skill)",
    thrownFlowMap instanceof Error && /agent-flowmap-hazard/.test(thrownFlowMap.message));
  check("(p) the withheld skill is NOT delivered at ALL",
    !fs.existsSync(path.join(cwdFlowMap, ".claude", "skills", "agent-flowmap-hazard")));
  check("(p) the STORE copy is completely untouched",
    readStoreFile("agent-flowmap-hazard") === flowMapHazard);
  check("(p) a sibling fixture in the SAME call still lands normally (control — only the one genuinely "
      + "unstrippable fixture is withheld, not the whole delivery)",
    fs.existsSync(path.join(cwdFlowMap, ".claude", "skills", "agent-clean", "SKILL.md")));

  const flowMapManifestPath = path.join(cwdFlowMap, ".claude", "skills", ".loom-skills.json");
  const flowMapManifest = JSON.parse(fs.readFileSync(flowMapManifestPath, "utf8"));
  check("(p) the withheld skill is NOT recorded as placed in the manifest",
    !(flowMapManifest["sess-flowmap"] ?? []).includes("agent-flowmap-hazard"));
  check("(p) the sibling that succeeded IS recorded as placed (control)",
    (flowMapManifest["sess-flowmap"] ?? []).includes("agent-clean"));

  const flowMapFpPath = path.join(cwdFlowMap, ".claude", "skills", ".loom-skills-fingerprints.json");
  const flowMapFp = JSON.parse(fs.readFileSync(flowMapFpPath, "utf8"));
  check("(p) no fingerprint was recorded for the withheld skill",
    flowMapFp["sess-flowmap"]?.["agent-flowmap-hazard"] === undefined);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — injectSkills strips allowed-tools/hooks/shell triggers from an agent-written or unstamped store skill's delivered copy, leaves human/bundled skills byte-identical, never touches the store, records a post-strip placement fingerprint, leaves the existing locked-role withholding behavior unchanged, fails CLOSED on a strip write failure AND on stripPermissionWidening returning null (never delivers/fingerprints the unstripped hazard either way), and strips a diverged bundled-name store copy unless it's human-provenance-stamped."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
