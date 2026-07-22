import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for board card 00d506f3: shipping `/codescape` as a BUNDLED Loom skill (mirroring `/graphify`)
// must cleanly RECONCILE a pre-existing USER-store copy — the doctrine was authored straight into the
// live fleet's user skill store (~/.loom/skills/codescape) BEFORE the asset existed. Once
// packages/daemon/assets/skills/codescape/SKILL.md ships, the store's "bundled" state is entirely
// COMPUTED (store.ts › bundledNames(): any store dir whose name matches an asset dir) — there is no
// separate manifest to register and no second "user copy" record to collide with; the same directory
// just starts reading as bundled. This test proves that computed reconciliation end-to-end via the REAL
// boot seeder (seedGlobalSkills), against the REAL codescape asset this card ships (not a synthetic
// stand-in), landing on exactly ONE skill: bundled:true, customized:false, no shadow/duplicate.
//
// SCOPE NOTE (card 187873f9): codescape was later moved to DEV_ONLY_SKILLS — omitted from the
// *published* npm bundle while staying canonical in this repo's own assets/skills/ (dev/self-host still
// ships it, uncurated). This test exercises exactly that still-bundled path (seed.ts's ASSET_SKILLS is
// hardcoded to the real dist-relative dir — never LOOM_ASSET_SKILLS-overridable — so it always sees the
// genuine, uncurated asset set) and remains correct unchanged. The COMPLEMENTARY case — an end-user
// install upgrading past a release that curated codescape out, left with an orphaned pristine store
// copy — is covered separately by skills-codescape-unbundle-retire.mjs (retireOrphanedBundledSkillDirs,
// which DOES read the LOOM_ASSET_SKILLS-overridable store.ts ASSET_SKILLS); the two can't share one test
// process because seed.ts's and store.ts's ASSET_SKILLS would then disagree about what's bundled.
//
// seed.ts's ASSET_SKILLS is NOT LOOM_ASSET_SKILLS-overridable (unlike store.ts) — it always resolves to
// the real dist-relative assets/skills dir. So this test only fakes LOOM_HOME (the store side); the
// asset side is the genuine shipped codescape doctrine. Fully hermetic on the store: a temp LOOM_HOME +
// sandboxed HOME, never touches ~/.loom or :4317. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-codescape-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });

process.env.LOOM_HOME = home; // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45422";
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { listSkills, readSkill } = await import("../dist/skills/store.js");

// The REAL shipped asset (this card's own deliverable) — read directly off disk, never re-typed here,
// so the test can never drift from the actual doctrine content.
const realAssetPath = path.join(__dirname, "..", "assets", "skills", "codescape", "SKILL.md");
const shippedContent = fs.readFileSync(realAssetPath, "utf8");

try {
  check("precondition: the codescape asset ships in this repo", fs.existsSync(realAssetPath));

  // Simulate the pre-existing Lead-authored USER-store row: written straight into the store, BEFORE any
  // boot seed ever ran for it — byte-identical to the shipped doctrine, exactly the state described on
  // the card (authored into the live fleet ahead of the bundled asset).
  fs.mkdirSync(path.join(skillsDir, "codescape"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "codescape", "SKILL.md"), shippedContent);
  check("precondition: no base snapshot yet (never previously a bundled skill)",
    !fs.existsSync(path.join(baseDir, "codescape.md")));
  // NOTE: `bundled` is computed purely from asset-dir presence (store.ts › bundledNames()), and this test
  // deliberately runs against the REAL shipped asset — so listSkills() already reads bundled:true here,
  // before seedGlobalSkills() ever runs. That's the whole point of the reconciliation design: there is no
  // separate "is this registered as bundled" step to run: only the base-snapshot / customization state
  // (asserted below, pre- and post-seed) actually changes across the seed call.
  const pre = listSkills().find((s) => s.name === "codescape");
  check("precondition: pre-seed store row exists and already reads bundled (asset-dir presence alone)",
    !!pre && pre.bundled === true);
  check("precondition: pre-seed row reads customized:false (content already matches shipped)",
    pre?.customized === false);

  // --- run the REAL boot seeder (asset auto-discovery — the same call the daemon makes at boot) -------
  seedGlobalSkills();

  const rows = listSkills().filter((s) => s.name === "codescape");
  check("exactly ONE codescape row after seeding (no shadow/duplicate)", rows.length === 1);
  const row = rows[0];
  check("bundled:true", row?.bundled === true);
  check("customized:false", row?.customized === false);
  check("updateAvailable:false", row?.updateAvailable === false);

  check("store content unchanged (still the pre-existing, byte-identical copy)",
    readSkill("codescape")?.content === shippedContent);
  check("base snapshot now backfilled and equals shipped",
    fs.readFileSync(path.join(baseDir, "codescape.md"), "utf8") === shippedContent);
  check("no orphaned sibling entries under the store dir for codescape",
    fs.readdirSync(skillsDir).filter((n) => n === "codescape").length === 1);

  // Idempotent: a second boot-seed changes nothing further.
  seedGlobalSkills();
  const rows2 = listSkills().filter((s) => s.name === "codescape");
  check("idempotent: still exactly ONE row after a second seed", rows2.length === 1);
  check("idempotent: still bundled:true, customized:false, updateAvailable:false",
    rows2[0]?.bundled === true && rows2[0]?.customized === false && rows2[0]?.updateAvailable === false);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — shipping the codescape asset cleanly reconciles a pre-existing user-store copy into a single bundled:true, customized:false skill, no shadow/duplicate."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
