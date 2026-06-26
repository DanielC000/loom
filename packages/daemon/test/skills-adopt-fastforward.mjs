import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for the adopt-staleness bug (board card dd940682): adopting a shipped update on a
// skill the user NEVER edited must fast-forward `mine` to EXACTLY shipped — no dropped additions, no
// phantom conflict — and the "mine behind BOTH base and shipped" state must have a reachable
// reset/sync recovery.
//
// ROOT CAUSE: customizationState compares with normalizeForCompare (ignores CRLF/CR, trailing per-line
// whitespace, trailing newlines) so a skill with only those cosmetic differences reads "not customized"
// (mine == base). But mergeSkillContent's diff3 normalized only with toLf, so those SAME cosmetic
// differences read to diff3 as a user edit — and shipped's additions adjacent to them got DROPPED or
// thrown into a conflict. adopt then advanced base=shipped while writing a STALE `mine` (missing shipped
// lines) → 5 bundled skills served outdated doctrine while the UI showed a false "customized".
//
// THE FIX: mergeSkillContent fast-forwards to `shipped` VERBATIM whenever normalizeForCompare(mine) ==
// normalizeForCompare(base) — the SAME notion of "no user edit" the state model uses — so a clean skill
// can never drop additions on adopt.
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-ff-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45419";
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { listSkills, writeSkill, readSkill, resetSkillToBundled,
  mergeSkillContent, previewSkillMerge, adoptSkillUpdate, skillUpdateAvailable } = store;
const { buildServer } = await import("../dist/gateway/server.js");
const { Db } = await import("../dist/db.js");

// normalizeForCompare is module-internal — mirror it here so assertions mean "no SEMANTIC difference"
// (the comparison the state model uses), tolerating the cosmetic skews the bug hinged on.
const norm = (s) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");

const writeAsset = (name, content) => { fs.mkdirSync(path.join(assetDir, name), { recursive: true }); fs.writeFileSync(path.join(assetDir, name, "SKILL.md"), content); };
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };
const state = (name) => { const s = listSkills().find((x) => x.name === name); return { customized: s?.customized, updateAvailable: s?.updateAvailable }; };

try {
  // ===================================================================================================
  // CORE: a no-user-edit skill (mine == base modulo cosmetics) adopts to EXACTLY shipped, additions kept.
  // ===================================================================================================
  // The DoD's literal "base == mine" works even unfixed when they're byte-identical — the bug needs the
  // REALISTIC skew: `mine` is the store SKILL.md (Windows: CRLF, may carry a trailing space / no final
  // newline) while `base` is the LF asset snapshot. Cosmetically different, semantically identical.
  const baseLf = "---\nname: ff\ndescription: ff desc\n---\n\n# ff\n\nIntro line.\nMiddle line.\nClosing line.\n";
  // mine: SAME content, but CRLF, a trailing space on one line, and NO final newline — exactly the skew
  // normalizeForCompare discounts but diff3-over-toLf would treat as edits.
  const mineSkew = baseLf.replace(/\n/g, "\r\n").replace("Middle line.", "Middle line.  ").replace(/\r\n$/, "");
  // shipped: adds a block in the MIDDLE and at the END — the additions that were getting dropped.
  const shipped = "---\nname: ff\ndescription: ff desc\n---\n\n# ff\n\nIntro line.\nNEW middle A.\nNEW middle B.\nMiddle line.\nClosing line.\nNEW tail one.\nNEW tail two.\n";

  // (1) mergeSkillContent: fast-forward is clean and yields shipped VERBATIM — no dropped additions.
  const m = mergeSkillContent(baseLf, mineSkew, shipped);
  check("[merge] cosmetic-only skew fast-forwards clean (no phantom conflict)", m.clean === true && !m.conflicts);
  check("[merge] merged == shipped VERBATIM (additions preserved, nothing dropped)", m.merged === shipped);
  check("[merge] every shipped-added line is present in merged",
    ["NEW middle A.", "NEW middle B.", "NEW tail one.", "NEW tail two."].every((l) => m.merged.includes(l)));

  // (2) full adopt flow on the store: clean skew + shipped additions → mine becomes shipped, state pristine.
  writeAsset("ff", shipped);
  writeBaseFile("ff", baseLf);   // base = the prior shipped (LF snapshot)
  writeSkill("ff", mineSkew);    // mine = the user's never-edited store copy (CRLF skew)
  check("[adopt] precondition: update available (base != shipped)", skillUpdateAvailable("ff") === true);
  check("[adopt] precondition: NOT customized (mine == base, cosmetics aside)", state("ff").customized === false);
  const pv = previewSkillMerge("ff");
  check("[adopt] preview is a clean fast-forward", pv.clean === true);
  const adopted = adoptSkillUpdate("ff", pv.merged);
  check("[adopt] adopt returns the skill", adopted?.name === "ff");
  check("[adopt] mine == shipped after adopt (no dropped additions — THE bug)", norm(adopted.content) === norm(shipped));
  check("[adopt] all shipped additions landed in the served store copy",
    ["NEW middle A.", "NEW middle B.", "NEW tail one.", "NEW tail two."].every((l) => readSkill("ff").content.includes(l)));
  check("[adopt] state is now pristine — no false 'customized', no lingering update",
    state("ff").customized === false && state("ff").updateAvailable === false);

  // (3) GUARD THE OTHER DIRECTION — a GENUINE non-overlapping user edit must still be PRESERVED on adopt
  // (the fast-forward must not swallow real edits).
  const gBase = "---\nname: gg\ndescription: gg desc\n---\n\n# gg\n\nAlpha.\nBeta.\nGamma.\n";
  const gMine = gBase.replace("Alpha.", "Alpha EDITED BY USER.");          // real edit at the top
  const gShipped = gBase.replace("Gamma.", "Gamma.\nDELTA SHIPPED.");       // shipped adds at the bottom
  const gm = mergeSkillContent(gBase, gMine, gShipped);
  check("[guard] a real non-overlapping edit still merges clean (not fast-forwarded away)", gm.clean === true);
  check("[guard] merge keeps BOTH the user's edit AND the shipped addition",
    gm.merged.includes("Alpha EDITED BY USER.") && gm.merged.includes("DELTA SHIPPED."));

  // ===================================================================================================
  // RECOVERY: the "mine behind BOTH base and shipped" state — reachable reset/sync even with NO update.
  // ===================================================================================================
  // This is the state the owner's 5 skills are stuck in: mine is OLD, base == shipped (current). It reads
  // customized:true, updateAvailable:false — so adopt is gated off. reset must still sync mine=base=shipped.
  const oldMine = "---\nname: stuck\ndescription: stuck desc\n---\n\n# stuck\n\nOld doctrine only.\n";
  const current = "---\nname: stuck\ndescription: stuck desc\n---\n\n# stuck\n\nOld doctrine only.\nNEW safety guidance.\nNEW injection defense.\n";
  writeAsset("stuck", current);
  writeBaseFile("stuck", current); // base already advanced to shipped (the bug's end state)
  writeSkill("stuck", oldMine);    // mine left behind at the old content
  check("[stuck] reads customized:true, updateAvailable:false (adopt is gated off)",
    state("stuck").customized === true && state("stuck").updateAvailable === false);
  check("[stuck] merge-preview is unreachable here (no update available)", skillUpdateAvailable("stuck") === false);
  // reset is the recovery — NOT gated on updateAvailable; it discards mine and re-syncs base → mine==base==shipped.
  check("[stuck] resetSkillToBundled succeeds", resetSkillToBundled("stuck") === true);
  check("[stuck] after reset the served copy carries the current shipped safety lines",
    readSkill("stuck").content.includes("NEW safety guidance.") && readSkill("stuck").content.includes("NEW injection defense."));
  check("[stuck] after reset state is pristine (stale content recovered)",
    state("stuck").customized === false && state("stuck").updateAvailable === false);

  // REST: update-diff (the endpoint the UI uses to render the divergence) is reachable for a customized
  // skill even when NO update is available — so the web can show "your copy differs from shipped" + sync.
  const db = new Db(path.join(home, "rest.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  writeAsset("diverged", current);
  writeBaseFile("diverged", current);   // base == shipped → updateAvailable:false
  writeSkill("diverged", oldMine);      // mine behind both
  const ud = await app.inject({ method: "GET", url: "/api/skills/diverged/update-diff" });
  check("[rest] update-diff is reachable (200) when mine is behind shipped but no update is pending",
    ud.statusCode === 200 && ud.json().shipped.includes("NEW safety guidance."));
  const mp = await app.inject({ method: "GET", url: "/api/skills/diverged/merge-preview" });
  check("[rest] merge-preview is correctly 409 here (no update available — adopt is not the path)", mp.statusCode === 409);
  const rst = await app.inject({ method: "POST", url: "/api/skills/diverged/reset" });
  check("[rest] POST reset recovers the stale state (200 + content == shipped)",
    rst.statusCode === 200 && rst.json().content.includes("NEW injection defense.") && !rst.json().content.includes("Old doctrine only.\n---"));
  await app.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no-user-edit adopt fast-forwards to shipped (no dropped additions) + reachable reset/sync for the mine-behind-both state."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
