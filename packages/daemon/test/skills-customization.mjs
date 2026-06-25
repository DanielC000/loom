import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic guard for end-user skill customization: the THIRD version (`base` snapshot) + the precise
// state booleans (customized / updateAvailable) + the non-destructive 3-way adopt-update merge + the
// adopt/reset/update-diff REST + the fail-closed edition gate on publish.
//
// PART A — store level (direct dist/skills/store.js + inject.js calls; fast, no server):
//   • base lives OUTSIDE SKILLS_DIR (<LOOM_HOME>/skill-base/<name>.md) and is NEVER injected into a session.
//   • seedBaseSnapshots() backfills base = current shipped, seed-if-absent (never clobbers an existing base).
//   • the state matrix: pristine / customized / update-available / both — from mine vs base vs shipped.
//   • mergeSkillContent: trivial fast-forward (mine==base), non-overlapping clean merge, overlapping conflict.
//   • adoptSkillUpdate sets base=shipped AND preserves the user's edit; resetSkillToBundled discards + resets base.
// PART B — REST via the REAL buildServer driven by app.inject (network-free):
//   • GET merge-preview {clean,merged} / {clean:false,conflicts,merged}; 409 when no update available.
//   • POST adopt: clean one-click (empty body), conflict-needs-content (409), resolved-content path.
//   • GET update-diff {base,shipped}. POST publish: 403 when NOT isLoomDev; ok when LOOM_DEV=1.
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist (paths.ts/store.ts read both at load). NEVER touches ~/.loom, :4317, or the real repo asset.
// Run after build: node test/skills-customization.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-cust-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;                 // edition gate defaults OFF unless a test sets it explicitly
process.env.LOOM_HOME = home;                // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45418";
process.env.LOOM_ASSET_SKILLS = assetDir;    // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;       // Windows
process.env.HOME = sandboxHome;              // POSIX

const store = await import("../dist/skills/store.js");
const { listSkills, writeSkill, readSkill, resetSkillToBundled, publishSkillToBundled,
  seedBaseSnapshots, mergeSkillContent, previewSkillMerge, adoptSkillUpdate, skillUpdateDiff, skillUpdateAvailable } = store;
const { injectSkills } = await import("../dist/skills/inject.js");
const { SKILLS_DIR, SKILL_BASE_DIR } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// SKILL.md builder: frontmatter + a body of distinct lines so diff3 has line granularity to work with.
const skill = (name, lines) => `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n\n${lines.join("\n")}\n`;
const writeAsset = (name, content) => { fs.mkdirSync(path.join(assetDir, name), { recursive: true }); fs.writeFileSync(path.join(assetDir, name, "SKILL.md"), content); };
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };
const readBaseFile = (name) => fs.readFileSync(path.join(baseDir, `${name}.md`), "utf8");
const state = (name) => { const s = listSkills().find((x) => x.name === name); return { customized: s?.customized, updateAvailable: s?.updateAvailable }; };

try {
  // ===================================================================================================
  // PART A — store level
  // ===================================================================================================

  // --- base lives OUTSIDE SKILLS_DIR and is never injected -------------------------------------------
  check("SKILL_BASE_DIR is a sibling of SKILLS_DIR (not nested inside it)",
    SKILL_BASE_DIR !== SKILLS_DIR && !SKILL_BASE_DIR.startsWith(SKILLS_DIR + path.sep));

  // --- seedBaseSnapshots: backfill = current shipped, seed-if-absent ---------------------------------
  writeAsset("alpha", skill("alpha", ["Line one.", "Line two.", "Line three."]));
  writeSkill("alpha", skill("alpha", ["Line one.", "Line two.", "Line three."])); // mine == shipped (pristine seed)
  check("no base file before seeding", !fs.existsSync(path.join(baseDir, "alpha.md")));
  const seeded = seedBaseSnapshots();
  check("seedBaseSnapshots backfilled alpha", seeded.includes("alpha"));
  check("base file now exists at <LOOM_HOME>/skill-base/alpha.md", fs.existsSync(path.join(baseDir, "alpha.md")));
  check("backfilled base == current shipped asset", readBaseFile("alpha") === fs.readFileSync(path.join(assetDir, "alpha", "SKILL.md"), "utf8"));
  // seed-if-absent: a second seed never clobbers an existing (possibly behind) base.
  writeAsset("alpha", skill("alpha", ["Line one.", "Line two.", "Line three CHANGED."])); // shipped moves ahead
  const seeded2 = seedBaseSnapshots();
  check("second seed does NOT re-backfill an existing base (seed-if-absent)", !seeded2.includes("alpha"));
  check("existing base left UNTOUCHED behind the new shipped (this is the update signal)",
    readBaseFile("alpha").includes("Line three.") && !readBaseFile("alpha").includes("CHANGED"));

  // --- the state matrix (mine vs base vs shipped) ----------------------------------------------------
  // alpha right now: mine==base (pristine pair), shipped moved ahead → update-available only.
  check("[matrix] update-available: customized:false, updateAvailable:true", state("alpha").customized === false && state("alpha").updateAvailable === true);

  // pristine: mine==base==shipped
  writeAsset("beta", skill("beta", ["B1", "B2"]));
  writeSkill("beta", skill("beta", ["B1", "B2"]));
  writeBaseFile("beta", skill("beta", ["B1", "B2"]));
  check("[matrix] pristine: customized:false, updateAvailable:false", state("beta").customized === false && state("beta").updateAvailable === false);

  // customized only: mine != base, base == shipped
  writeAsset("gamma", skill("gamma", ["G1", "G2"]));
  writeBaseFile("gamma", skill("gamma", ["G1", "G2"]));
  writeSkill("gamma", skill("gamma", ["G1 EDITED", "G2"]));
  check("[matrix] customized: customized:true, updateAvailable:false", state("gamma").customized === true && state("gamma").updateAvailable === false);

  // both: mine != base AND base != shipped
  writeAsset("delta", skill("delta", ["D1", "D2 NEW"]));
  writeBaseFile("delta", skill("delta", ["D1", "D2"]));
  writeSkill("delta", skill("delta", ["D1 EDITED", "D2"]));
  check("[matrix] both: customized:true, updateAvailable:true", state("delta").customized === true && state("delta").updateAvailable === true);

  // a user-created (non-bundled) skill carries NEITHER flag
  writeSkill("local-z", skill("local-z", ["Z1"]));
  const lz = listSkills().find((s) => s.name === "local-z");
  check("non-bundled skill: bundled:false, no customized/updateAvailable flags",
    lz?.bundled === false && lz?.customized === undefined && lz?.updateAvailable === undefined);

  // --- 3-way merge engine ----------------------------------------------------------------------------
  const base3 = skill("m", ["Line one.", "Line two.", "Line three."]);
  // (1) trivial clean fast-forward: mine == base, shipped changed → whole update applies, merged == shipped.
  const ffShipped = skill("m", ["Line one.", "Line two.", "Line three CHANGED."]);
  const ff = mergeSkillContent(base3, base3, ffShipped);
  check("[merge] mine==base fast-forward is clean", ff.clean === true && !ff.conflicts);
  check("[merge] fast-forward merged equals shipped", ff.merged.replace(/\r\n?/g, "\n").trim() === ffShipped.replace(/\r\n?/g, "\n").trim());
  // (2) non-overlapping clean merge: mine edits line one, shipped edits line three → clean union.
  const mineA = skill("m", ["Line one EDITED.", "Line two.", "Line three."]);
  const shippedC = skill("m", ["Line one.", "Line two.", "Line three CHANGED."]);
  const clean = mergeSkillContent(base3, mineA, shippedC);
  check("[merge] non-overlapping edits merge clean", clean.clean === true && !clean.conflicts);
  check("[merge] clean merge preserves the user's edit AND the shipped change",
    clean.merged.includes("Line one EDITED.") && clean.merged.includes("Line three CHANGED."));
  // (3) overlapping conflict: mine and shipped both edit line two differently → conflict hunk returned.
  const mineB = skill("m", ["Line one.", "Line two MINE.", "Line three."]);
  const shippedB = skill("m", ["Line one.", "Line two SHIPPED.", "Line three."]);
  const conf = mergeSkillContent(base3, mineB, shippedB);
  check("[merge] overlapping edits conflict (clean:false)", conf.clean === false);
  check("[merge] conflict list carries mine/base/shipped hunk text",
    Array.isArray(conf.conflicts) && conf.conflicts.length >= 1 &&
    conf.conflicts[0].mine.includes("MINE") && conf.conflicts[0].shipped.includes("SHIPPED") && conf.conflicts[0].base.includes("Line two."));
  check("[merge] conflicted merged carries git-style markers", conf.merged.includes("<<<<<<< mine") && conf.merged.includes(">>>>>>> shipped"));

  // --- adopt (store level): sets base=shipped + preserves edits ---------------------------------------
  // epsilon: mine edits a non-overlapping region; shipped changed another → clean update available.
  writeAsset("epsilon", skill("epsilon", ["E1", "E2", "E3 NEW"]));
  writeBaseFile("epsilon", skill("epsilon", ["E1", "E2", "E3"]));
  writeSkill("epsilon", skill("epsilon", ["E1 EDITED", "E2", "E3"]));
  check("[adopt] precondition: update available", skillUpdateAvailable("epsilon") === true);
  const pv = previewSkillMerge("epsilon");
  check("[adopt] preview is clean for a non-overlapping update", pv.clean === true);
  const adopted = adoptSkillUpdate("epsilon", pv.merged);
  check("[adopt] adopt returns the new skill", adopted?.name === "epsilon");
  check("[adopt] adopted store keeps the user's edit AND takes the shipped change",
    adopted.content.includes("E1 EDITED") && adopted.content.includes("E3 NEW"));
  check("[adopt] base advanced to shipped (updateAvailable now false)", state("epsilon").updateAvailable === false);
  check("[adopt] base file now equals the shipped asset", readBaseFile("epsilon") === fs.readFileSync(path.join(assetDir, "epsilon", "SKILL.md"), "utf8"));
  check("[adopt] still customized (mine != base, the edit survived)", state("epsilon").customized === true);

  // --- reset: discards mine AND resets base ----------------------------------------------------------
  // zeta: customized + an update pending; reset must wipe BOTH (mine=base=shipped).
  writeAsset("zeta", skill("zeta", ["Z1 NEW", "Z2"]));
  writeBaseFile("zeta", skill("zeta", ["Z1", "Z2"]));
  writeSkill("zeta", skill("zeta", ["Z1", "Z2 EDITED"]));
  check("[reset] precondition: both customized and update-available", state("zeta").customized === true && state("zeta").updateAvailable === true);
  check("[reset] resetSkillToBundled returns true", resetSkillToBundled("zeta") === true);
  check("[reset] store now == shipped asset", readSkill("zeta").content.includes("Z1 NEW") && !readSkill("zeta").content.includes("EDITED"));
  check("[reset] base file re-synced to shipped", readBaseFile("zeta") === fs.readFileSync(path.join(assetDir, "zeta", "SKILL.md"), "utf8"));
  check("[reset] state cleared: pristine", state("zeta").customized === false && state("zeta").updateAvailable === false);

  // --- base never lands in an injected session's skills dir ------------------------------------------
  writeAsset("inj", skill("inj", ["I1"]));
  writeSkill("inj", skill("inj", ["I1"]));
  writeBaseFile("inj", skill("inj", ["I1"]));
  const cwd = path.join(root, "session-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  injectSkills(cwd, "sess-1");
  check("[inject] the skill DIR is delivered to the session", fs.existsSync(path.join(cwd, ".claude", "skills", "inj", "SKILL.md")));
  check("[inject] the base flat-file is NOT copied into the session", !fs.existsSync(path.join(cwd, ".claude", "skills", "inj.md")));
  check("[inject] no skill-base dir leaked into the session skills tree", !fs.existsSync(path.join(cwd, ".claude", "skills", "skill-base")));
  check("[inject] base name never appears as a skill in listSkills", !listSkills().some((s) => s.name === "inj.md"));

  // ===================================================================================================
  // PART B — REST via buildServer + app.inject
  // ===================================================================================================
  const db = new Db(path.join(home, "rest.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  // rest-clean: a clean (non-overlapping) update available, for merge-preview + one-click adopt.
  writeAsset("rest-clean", skill("rest-clean", ["R1", "R2", "R3 NEW"]));
  writeBaseFile("rest-clean", skill("rest-clean", ["R1", "R2", "R3"]));
  writeSkill("rest-clean", skill("rest-clean", ["R1 EDITED", "R2", "R3"]));

  const mp = await app.inject({ method: "GET", url: "/api/skills/rest-clean/merge-preview" });
  const mpBody = mp.json();
  check("[rest] GET merge-preview 200 + clean:true + merged", mp.statusCode === 200 && mpBody.clean === true && typeof mpBody.merged === "string");

  const ud = await app.inject({ method: "GET", url: "/api/skills/rest-clean/update-diff" });
  const udBody = ud.json();
  check("[rest] GET update-diff 200 + {base, shipped}", ud.statusCode === 200 && udBody.base.includes("R3") && udBody.shipped.includes("R3 NEW"));

  const adoptClean = await app.inject({ method: "POST", url: "/api/skills/rest-clean/adopt", payload: {} });
  const acBody = adoptClean.json();
  check("[rest] POST adopt (empty body, clean) 200 + edit preserved + shipped change taken",
    adoptClean.statusCode === 200 && acBody.content.includes("R1 EDITED") && acBody.content.includes("R3 NEW"));
  check("[rest] after clean adopt no update remains (409 on re-preview)",
    (await app.inject({ method: "GET", url: "/api/skills/rest-clean/merge-preview" })).statusCode === 409);

  // rest-conf: an overlapping update → preview conflicts; empty-body adopt refused; resolved-content adopt OK.
  writeAsset("rest-conf", skill("rest-conf", ["C1", "C2 SHIPPED", "C3"]));
  writeBaseFile("rest-conf", skill("rest-conf", ["C1", "C2", "C3"]));
  writeSkill("rest-conf", skill("rest-conf", ["C1", "C2 MINE", "C3"]));
  const mpc = await app.inject({ method: "GET", url: "/api/skills/rest-conf/merge-preview" });
  check("[rest] merge-preview reports conflicts for an overlapping update", mpc.statusCode === 200 && mpc.json().clean === false && mpc.json().conflicts.length >= 1);
  const adoptNoContent = await app.inject({ method: "POST", url: "/api/skills/rest-conf/adopt", payload: {} });
  check("[rest] POST adopt with no content on a conflict → 409", adoptNoContent.statusCode === 409);
  const resolved = skill("rest-conf", ["C1", "C2 RESOLVED", "C3"]);
  const adoptResolved = await app.inject({ method: "POST", url: "/api/skills/rest-conf/adopt", payload: { content: resolved } });
  check("[rest] POST adopt with resolved content → 200 + writes the resolution",
    adoptResolved.statusCode === 200 && adoptResolved.json().content.includes("C2 RESOLVED"));
  check("[rest] after resolved adopt, update cleared", skillUpdateAvailable("rest-conf") === false);

  // merge-preview 409 when there is no update available (pristine).
  writeAsset("rest-pristine", skill("rest-pristine", ["P1"]));
  writeBaseFile("rest-pristine", skill("rest-pristine", ["P1"]));
  writeSkill("rest-pristine", skill("rest-pristine", ["P1"]));
  check("[rest] merge-preview 409 when no update available", (await app.inject({ method: "GET", url: "/api/skills/rest-pristine/merge-preview" })).statusCode === 409);

  // --- publish edition gate (fail-closed) ------------------------------------------------------------
  writeAsset("rest-pub", skill("rest-pub", ["U1"]));
  writeBaseFile("rest-pub", skill("rest-pub", ["U1"]));
  writeSkill("rest-pub", skill("rest-pub", ["U1 EDITED"]));
  delete process.env.LOOM_DEV; // end-user edition
  const pubDenied = await app.inject({ method: "POST", url: "/api/skills/rest-pub/publish" });
  check("[rest] POST publish 403 when NOT isLoomDev (fail-closed)", pubDenied.statusCode === 403);
  check("[rest] denied publish did NOT write the asset", !fs.readFileSync(path.join(assetDir, "rest-pub", "SKILL.md"), "utf8").includes("EDITED"));
  process.env.LOOM_DEV = "1"; // dev/self-host edition (read at call time by isLoomDev)
  const pubOk = await app.inject({ method: "POST", url: "/api/skills/rest-pub/publish" });
  check("[rest] POST publish 200 when isLoomDev", pubOk.statusCode === 200 && pubOk.json().ok === true);
  check("[rest] dev publish wrote the store edit into the asset", fs.readFileSync(path.join(assetDir, "rest-pub", "SKILL.md"), "utf8").includes("U1 EDITED"));
  delete process.env.LOOM_DEV;

  await app.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — base snapshot + precise state + 3-way merge + adopt/reset/update-diff REST + fail-closed publish gate."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
