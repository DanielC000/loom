import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for board card 75a0755d: a bundled skill's update path only ever advanced SKILL.md —
// every other file in a skill dir (references/**, scripts/**) was seeded once (cpSync force:false) and
// then frozen forever, so an edit to an already-seeded reference file never reached an existing install
// even for a PRISTINE (customized:false) skill. Proven live: store web-design/references/anti-patterns.md
// (5,610B) vs the bundled asset (7,879B) — a real, already-shipped doctrine edit that silently never
// propagated.
//
// THE FIX (store.ts): per-file base-snapshot tracking (SKILL_BASE_DIR/<name>/<relPath>, mirroring the
// skill tree, sibling of the existing flat <name>.md used for SKILL.md) extends the SAME pristine-only
// fast-forward SKILL.md already gets to every other file in the skill dir — gated PER FILE, not per
// skill, so a customized SKILL.md never blocks a still-pristine reference file's own advance, and vice
// versa. Both autoFastForwardPristineSkills (boot) and adoptSkillUpdate (the manual "Adopt update" UI
// action) now cover the whole directory, not just SKILL.md.
//
// base:=MINE (not base:=shipped, unlike SKILL.md's own precedent): every skill write route
// (PUT/POST /api/skills/:name, /adopt, /reset, /publish) touches SKILL.md only — there is NO product
// surface that can ever edit a references/**/scripts/** file — so on first sight, current store content
// can only be an old seed, never a legitimate edit. base:=shipped would instead read every already-
// stale file as "legacy-customized" and freeze it forever, defeating the fix's own acceptance case.
//
// EOL POLICY (settled explicitly, not left implicit): file comparison uses the SAME normalizeForCompare
// SKILL.md already uses everywhere (CRLF/CR -> LF, trailing per-line whitespace, trailing newlines all
// ignored) — never a byte-exact comparison. A reference file that differs from shipped ONLY by line
// ending must read as NOT updateAvailable and must never be touched (see "EOL-ONLY" below) — otherwise
// every boot would re-"advance" it forever (a rewrite that changes nothing but keeps looking like a
// change), the churn-loop this suite explicitly guards against via the two-pass idempotency check.
//
// RECOVERABILITY: advancing a file for the first time takes a ONE-TIME backup of what's about to be
// overwritten (SKILL_BASE_DIR/.pre-ff-backups/<name>/<relPath>) before writing shipped over it — the
// hedge against the one residual risk of base:=mine (a rare, unsupported, out-of-band hand-edit made
// before this fix shipped could be misread as "the base" and get overwritten in the same pass). Asserted
// below both for the file that DOES get advanced (backup exists, holds the pre-overwrite content) and
// for the EOL-only file that never gets advanced (no backup — an untouched file must not spawn one).
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-refff-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
const backupDir = path.join(baseDir, ".pre-ff-backups");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45421";
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { listSkills, readSkill, seedFileBaseSnapshots, autoFastForwardPristineSkills, adoptSkillUpdate, resetSkillToBundled, skillUpdateAvailable } = store;
const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Db } = await import("../dist/db.js");
// NOTE: seed.ts computes its own ASSET_SKILLS constant that is NOT LOOM_ASSET_SKILLS-overridable
// (unlike store.ts's — see skills-codescape-reconcile.mjs's own note on this same pre-existing,
// documented gap), so seedGlobalSkills()'s cpSync-new-file-backfill loop always reads the REAL repo
// assets, not this test's synthetic ones. Harmless noise for scenarios that only need store.ts's own
// LOOM_ASSET_SKILLS-aware functions (seedFileBaseSnapshots / autoFastForwardPristineSkills / listSkills
// / adoptSkillUpdate, used throughout below) — but scenario (c) below deliberately calls those directly
// instead of seedGlobalSkills(), simulating cpSync having already copied a brand-new file (that
// unrelated, unmodified mechanism is covered elsewhere, e.g. skills-store-durability.mjs).

// normalizeForCompare is module-internal — mirror it here (matches store.ts exactly).
const norm = (s) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");

const writeFile = (p, content) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const assetPath = (name, relPath) => path.join(assetDir, name, ...relPath.split("/"));
const storePath = (name, relPath) => path.join(skillsDir, name, ...relPath.split("/"));
const basePath = (name, relPath) => path.join(baseDir, name, ...relPath.split("/"));
const backupPath = (name, relPath) => path.join(backupDir, name, ...relPath.split("/"));
const skillMdBasePath = (name) => path.join(baseDir, `${name}.md`);
const state = (name) => {
  const s = listSkills().find((x) => x.name === name);
  return { customized: s?.customized, updateAvailable: s?.updateAvailable, mdCustomized: s?.mdCustomized, mdUpdateAvailable: s?.mdUpdateAvailable };
};

try {
  // ===================================================================================================
  // (a) PRISTINE reference file advances on the normal boot path — the DoD's core acceptance case.
  // ===================================================================================================
  const skillMd = "---\nname: refpristine\ndescription: d\n---\n\n# refpristine\n";
  writeFile(assetPath("refpristine", "SKILL.md"), skillMd);
  writeFile(assetPath("refpristine", "references/doc.md"), "OLD doctrine.\n");   // stale asset snapshot, updated below
  writeFile(storePath("refpristine", "SKILL.md"), skillMd);                     // SKILL.md itself pristine
  writeFile(storePath("refpristine", "references/doc.md"), "OLD doctrine.\n");  // frozen at the old seed (the bug)
  writeFile(skillMdBasePath("refpristine"), skillMd);
  // No base file for the reference file yet — this is exactly the pre-fix state: base tracking for
  // references/** is brand new, so every existing install starts with none recorded.
  // Now "ship" a doctrine edit — the reference file changes in the bundle, mirroring anti-patterns.md.
  writeFile(assetPath("refpristine", "references/doc.md"), "NEW doctrine — safety guidance added.\n");

  seedGlobalSkills(); // the real boot pipeline: cpSync backfill -> base backfill -> retire -> auto-FF

  check("[a] pristine reference file advances to shipped on the normal update path",
    readSkill("refpristine") && fs.readFileSync(storePath("refpristine", "references/doc.md"), "utf8") === "NEW doctrine — safety guidance added.\n");
  check("[a] base advanced to shipped too (no lingering updateAvailable)",
    fs.readFileSync(basePath("refpristine", "references/doc.md"), "utf8") === "NEW doctrine — safety guidance added.\n");
  check("[a] state reads pristine, no update pending", state("refpristine").customized === false && state("refpristine").updateAvailable === false);
  check("[a] a one-time backup of the pre-overwrite content was written",
    fs.existsSync(backupPath("refpristine", "references/doc.md")) && fs.readFileSync(backupPath("refpristine", "references/doc.md"), "utf8") === "OLD doctrine.\n");

  // ===================================================================================================
  // (b) A user-edited reference file is NEVER silently clobbered — the one outcome worse than staleness.
  // ===================================================================================================
  // Simulate a file that's already customized (base != mine) — the same shape skills-autoff-boot.mjs
  // uses for a customized SKILL.md, applied to a reference file instead.
  const skillMd2 = "---\nname: refedited\ndescription: d\n---\n\n# refedited\n";
  writeFile(assetPath("refedited", "SKILL.md"), skillMd2);
  writeFile(assetPath("refedited", "references/doc.md"), "ORIGINAL doctrine.\n");
  writeFile(storePath("refedited", "SKILL.md"), skillMd2);
  writeFile(skillMdBasePath("refedited"), skillMd2);
  writeFile(storePath("refedited", "references/doc.md"), "ORIGINAL doctrine, EDITED.\n"); // mine
  writeFile(basePath("refedited", "references/doc.md"), "ORIGINAL doctrine.\n");           // base != mine -> customized
  writeFile(assetPath("refedited", "references/doc.md"), "NEW shipped doctrine.\n");        // shipped moved too

  autoFastForwardPristineSkills();

  check("[b] a diverged (customized) reference file is left byte-for-byte UNCHANGED",
    fs.readFileSync(storePath("refedited", "references/doc.md"), "utf8") === "ORIGINAL doctrine, EDITED.\n");
  check("[b] no backup is written for a file that was never overwritten",
    !fs.existsSync(backupPath("refedited", "references/doc.md")));
  check("[b] aggregate state reads customized:true (visible, not swallowed)", state("refedited").customized === true);

  // ===================================================================================================
  // (c) A brand-new reference file still backfills as today — unaffected regression check. seed.ts's
  //     cpSync(force:false) (unchanged by this fix, covered elsewhere e.g. skills-store-durability.mjs)
  //     is what actually copies a brand-new asset file into an existing store install; what THIS fix
  //     adds is the base-tracking layer that runs AFTER that copy. Simulate its outcome directly (mine
  //     already == shipped, freshly copied, no base yet) and prove the new layer treats it correctly:
  //     backfills a matching base and does NOT touch the file (nothing to fast-forward, no backup).
  // ===================================================================================================
  const skillMd3 = "---\nname: refnew\ndescription: d\n---\n\n# refnew\n";
  writeFile(assetPath("refnew", "SKILL.md"), skillMd3);
  writeFile(assetPath("refnew", "references/brand-new.md"), "BRAND NEW CONTENT.\n");
  writeFile(storePath("refnew", "SKILL.md"), skillMd3);
  writeFile(skillMdBasePath("refnew"), skillMd3);
  writeFile(storePath("refnew", "references/brand-new.md"), "BRAND NEW CONTENT.\n"); // as if cpSync just ran

  seedFileBaseSnapshots();
  autoFastForwardPristineSkills();

  check("[c] the freshly-copied file is left byte-for-byte untouched",
    fs.readFileSync(storePath("refnew", "references/brand-new.md"), "utf8") === "BRAND NEW CONTENT.\n");
  check("[c] its base is backfilled to match (mine==base==shipped, freshly copied)",
    fs.readFileSync(basePath("refnew", "references/brand-new.md"), "utf8") === "BRAND NEW CONTENT.\n");
  check("[c] state reads pristine (mine==shipped, freshly copied)",
    state("refnew").customized === false && state("refnew").updateAvailable === false);
  check("[c] no backup is generated for a file that was never overwritten",
    !fs.existsSync(backupPath("refnew", "references/brand-new.md")));

  // ===================================================================================================
  // (d) MIXED CASE — the direct proof of per-file granularity: a customized SKILL.md must NOT block a
  //     still-pristine reference file's own advance, and the reference advance must NOT touch SKILL.md.
  // ===================================================================================================
  const mixedBase = "---\nname: mixed\ndescription: d\n---\n\n# mixed\n\nOriginal.\n";
  const mixedShipped = "---\nname: mixed\ndescription: d\n---\n\n# mixed\n\nOriginal.\nNEW shipped SKILL.md line.\n";
  const mixedMine = mixedBase.replace("Original.", "Original — EDITED BY USER.");
  writeFile(assetPath("mixed", "SKILL.md"), mixedShipped);
  writeFile(storePath("mixed", "SKILL.md"), mixedMine);
  writeFile(skillMdBasePath("mixed"), mixedBase); // SKILL.md: mine != base -> customized:true, updateAvailable:true
  writeFile(assetPath("mixed", "references/doc.md"), "NEW reference content.\n");
  writeFile(storePath("mixed", "references/doc.md"), "OLD reference content.\n"); // no base yet -> pristine on first sight

  const advanced = autoFastForwardPristineSkills();

  check("[d] customized SKILL.md is left UNTOUCHED (never auto-advanced)",
    fs.readFileSync(storePath("mixed", "SKILL.md"), "utf8") === mixedMine);
  check("[d] the still-pristine reference file advances DESPITE the customized SKILL.md",
    fs.readFileSync(storePath("mixed", "references/doc.md"), "utf8") === "NEW reference content.\n");
  check("[d] the skill is reported as advanced (the reference file counts)", advanced.includes("mixed"));
  check("[d] aggregate customized:true still surfaces (SKILL.md still needs manual adopt)", state("mixed").customized === true);

  // ===================================================================================================
  // (e) The manual "Adopt update" path (adoptSkillUpdate) ALSO fast-forwards pristine reference files —
  //     not just the boot auto-FF path.
  // ===================================================================================================
  const manualBase = "---\nname: manualadopt\ndescription: d\n---\n\n# manualadopt\n\nOriginal.\n";
  const manualShipped = "---\nname: manualadopt\ndescription: d\n---\n\n# manualadopt\n\nOriginal.\nSHIPPED addition.\n";
  const manualMine = manualBase.replace("Original.", "Original — user edit.");
  const manualResolved = manualShipped.replace("Original.", "Original — user edit."); // what a human resolved via the merge UI
  writeFile(assetPath("manualadopt", "SKILL.md"), manualShipped);
  writeFile(storePath("manualadopt", "SKILL.md"), manualMine);
  writeFile(skillMdBasePath("manualadopt"), manualBase);
  writeFile(assetPath("manualadopt", "references/doc.md"), "NEW manual-adopt doctrine.\n");
  writeFile(storePath("manualadopt", "references/doc.md"), "OLD manual-adopt doctrine.\n");

  const adopted = adoptSkillUpdate("manualadopt", manualResolved);

  check("[e] adopt writes the human-resolved SKILL.md content", adopted?.content === manualResolved);
  check("[e] adopt ALSO fast-forwards the pristine reference file",
    fs.readFileSync(storePath("manualadopt", "references/doc.md"), "utf8") === "NEW manual-adopt doctrine.\n");

  // ===================================================================================================
  // (f) EOL-ONLY divergence must never read as an update, and must never be touched — the churn-loop
  //     hazard: comparison normalizes EOL (matches SKILL.md's own normalizeForCompare everywhere).
  // ===================================================================================================
  const eolLf = "---\nname: refeol\ndescription: d\n---\n\n# refeol\n";
  writeFile(assetPath("refeol", "SKILL.md"), eolLf);
  writeFile(storePath("refeol", "SKILL.md"), eolLf);
  writeFile(skillMdBasePath("refeol"), eolLf);
  const refBodyLf = "Line one.\nLine two.\nLine three.\n";
  writeFile(assetPath("refeol", "references/doc.md"), refBodyLf);                          // shipped: LF
  writeFile(storePath("refeol", "references/doc.md"), refBodyLf.replace(/\n/g, "\r\n"));    // mine: CRLF, semantically identical
  check("[f] precondition: mine != shipped byte-for-byte (real CRLF skew)",
    fs.readFileSync(storePath("refeol", "references/doc.md"), "utf8") !== fs.readFileSync(assetPath("refeol", "references/doc.md"), "utf8"));
  check("[f] but normalized they ARE equal (pure EOL skew, no semantic difference)",
    norm(fs.readFileSync(storePath("refeol", "references/doc.md"), "utf8")) === norm(fs.readFileSync(assetPath("refeol", "references/doc.md"), "utf8")));

  const beforeEol = fs.readFileSync(storePath("refeol", "references/doc.md"), "utf8");
  seedGlobalSkills(); // backfills base := mine (CRLF) on first sight
  const afterFirst = fs.readFileSync(storePath("refeol", "references/doc.md"), "utf8");
  check("[f] EOL-only file is NOT rewritten (updateAvailable reads false once normalized)", afterFirst === beforeEol);
  check("[f] no backup is generated for a file that was never advanced", !fs.existsSync(backupPath("refeol", "references/doc.md")));
  check("[f] state reads no pending update for the EOL-only skill", state("refeol").updateAvailable === false);

  // ===================================================================================================
  // (g) IDEMPOTENCY — running the fast-forward pass twice must make the second pass a strict no-op.
  //     Pinned by a test, not reasoned about: if the write path and the comparison ever disagree about
  //     line endings, every boot would re-advance every file forever.
  // ===================================================================================================
  const secondPassAdvanced = autoFastForwardPristineSkills();
  check("[g] second pass advances NOTHING (already-advanced files are stable)", secondPassAdvanced.length === 0);
  check("[g] refpristine's reference file is unchanged on the second pass",
    fs.readFileSync(storePath("refpristine", "references/doc.md"), "utf8") === "NEW doctrine — safety guidance added.\n");
  check("[g] refpristine's backup is still exactly one file, unchanged (never refreshed)",
    fs.readFileSync(backupPath("refpristine", "references/doc.md"), "utf8") === "OLD doctrine.\n");
  check("[g] the EOL-only file is STILL untouched after a second boot pass",
    fs.readFileSync(storePath("refeol", "references/doc.md"), "utf8") === beforeEol && !fs.existsSync(backupPath("refeol", "references/doc.md")));

  // ===================================================================================================
  // (h) RESET-PATH — Code Review M1: resetSkillToBundled must re-sync EVERY file's base, not just
  //     SKILL.md's. Before the fix, cpSync rewrote `mine` for a reference file but left its base behind
  //     — reading customized:true + updateAvailable:true FOREVER after, with no user-reachable recovery
  //     (this card's own bug, reintroduced through the one action whose job is "discard and re-sync").
  // ===================================================================================================
  const resetSkillMd = "---\nname: refreset\ndescription: d\n---\n\n# refreset\n";
  writeFile(assetPath("refreset", "SKILL.md"), resetSkillMd);
  writeFile(storePath("refreset", "SKILL.md"), resetSkillMd);
  writeFile(skillMdBasePath("refreset"), resetSkillMd);
  writeFile(assetPath("refreset", "references/doc.md"), "SHIPPED reset content.\n");
  // mine diverged (a "customized" reference file, base pre-dating reset) — reset must discard this too.
  writeFile(storePath("refreset", "references/doc.md"), "USER edited content.\n");
  writeFile(basePath("refreset", "references/doc.md"), "OLD base content.\n");

  check("[h] precondition: reads customized (mine != base for the reference file)", state("refreset").customized === true);
  const resetOk = resetSkillToBundled("refreset");
  check("[h] resetSkillToBundled succeeds", resetOk === true);
  check("[h] the reference file is rewritten to shipped (cpSync, unchanged by this fix)",
    fs.readFileSync(storePath("refreset", "references/doc.md"), "utf8") === "SHIPPED reset content.\n");
  check("[h] THE FIX: the reference file's base is ALSO advanced to shipped (not left behind)",
    fs.readFileSync(basePath("refreset", "references/doc.md"), "utf8") === "SHIPPED reset content.\n");
  check("[h] state reads fully pristine after reset — no permanently-stuck customized/updateAvailable",
    state("refreset").customized === false && state("refreset").updateAvailable === false);
  // Running the boot pass again must find nothing left to do — proof there's no lingering mismatch.
  const afterResetAdvanced = autoFastForwardPristineSkills();
  check("[h] nothing left to advance after reset (base and mine now agree everywhere)",
    !afterResetAdvanced.includes("refreset"));

  // ===================================================================================================
  // (i) DISPLAY-VS-ACTION PARITY — Code Review M2: the REST guard (`skillUpdateAvailable`, used by both
  //     /merge-preview and /adopt) must permit exactly what the OR'd `updateAvailable` flag claims —
  //     otherwise the badge + Adopt button render but the click 409s "no update available".
  // ===================================================================================================
  const parityBase = "---\nname: refparity\ndescription: d\n---\n\n# refparity\n";
  writeFile(assetPath("refparity", "SKILL.md"), parityBase);
  writeFile(storePath("refparity", "SKILL.md"), parityBase);      // SKILL.md itself fully pristine, no update
  writeFile(skillMdBasePath("refparity"), parityBase);
  writeFile(assetPath("refparity", "references/doc.md"), "NEW parity doctrine.\n");
  writeFile(storePath("refparity", "references/doc.md"), "OLD parity doctrine.\n"); // only the ref file has an update
  seedFileBaseSnapshots(); // backfill base:=mine for the reference file so its own updateAvailable is real, not a fluke of a missing base

  check("[i] SKILL.md itself has no update (a stricter precondition than the aggregate)",
    state("refparity").mdUpdateAvailable === false);
  check("[i] aggregate updateAvailable is true (from the reference file alone)", state("refparity").updateAvailable === true);
  check("[i] the REST/adopt guard (skillUpdateAvailable) agrees — reachable, not a phantom flag",
    skillUpdateAvailable("refparity") === true);

  // Exercise the actual REST route end-to-end: before the fix this would 409 despite the true flag above.
  const db = new Db(path.join(home, "rest-parity.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const adoptRes = await app.inject({ method: "POST", url: "/api/skills/refparity/adopt", payload: {} });
  check("[i] POST /adopt is REACHABLE (200, not 409) when only a reference file has an update", adoptRes.statusCode === 200);
  check("[i] and it actually advanced the reference file", fs.readFileSync(storePath("refparity", "references/doc.md"), "utf8") === "NEW parity doctrine.\n");
  await app.close();

  // Regression check in the other direction: a skill with NO update anywhere still correctly 409s.
  const db2 = new Db(path.join(home, "rest-noupdate.db"));
  const app2 = await buildServer({ db: db2, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const noUpdateRes = await app2.inject({ method: "POST", url: "/api/skills/refparity/adopt", payload: {} });
  check("[i] a second adopt with nothing left to adopt correctly 409s (guard isn't just always-true now)", noUpdateRes.statusCode === 409);
  await app2.close();

  // ===================================================================================================
  // (j) DELETIONS — pinning the "leave it" decision: a store file with NO shipped counterpart (removed
  //     from a later bundle) must be left exactly alone — never touched, never removed, and never made
  //     to falsely read as customized/updateAvailable (there's nothing to compare it against).
  // ===================================================================================================
  const orphanSkillMd = "---\nname: reforphan\ndescription: d\n---\n\n# reforphan\n";
  writeFile(assetPath("reforphan", "SKILL.md"), orphanSkillMd);
  writeFile(storePath("reforphan", "SKILL.md"), orphanSkillMd);
  writeFile(skillMdBasePath("reforphan"), orphanSkillMd);
  writeFile(storePath("reforphan", "references/removed-from-bundle.md"), "Still here, orphaned.\n"); // asset side deliberately absent

  const beforeOrphan = fs.readFileSync(storePath("reforphan", "references/removed-from-bundle.md"), "utf8");
  seedFileBaseSnapshots();
  const orphanAdvanced = autoFastForwardPristineSkills();
  check("[j] an orphaned (store-only) file is left BYTE-FOR-BYTE untouched",
    fs.readFileSync(storePath("reforphan", "references/removed-from-bundle.md"), "utf8") === beforeOrphan);
  check("[j] it still exists — 'leave it', never silently removed", fs.existsSync(storePath("reforphan", "references/removed-from-bundle.md")));
  check("[j] it never gets a base snapshot recorded (nothing to compare it against)",
    !fs.existsSync(basePath("reforphan", "references/removed-from-bundle.md")));
  check("[j] it doesn't falsely surface as customized/updateAvailable", state("reforphan").customized === false && state("reforphan").updateAvailable === false);
  check("[j] and it's never reported as 'advanced' (nothing happened to it)", !orphanAdvanced.includes("reforphan"));

  // ===================================================================================================
  // (k) BINARY-FILE SAFETY (cheap fix #3) — a file that looks binary (a NUL byte in its content) must
  //     never be read/rewritten as utf8 text: that would mangle it AND write the same mangled bytes as
  //     the "recoverable" backup, defeating the safety net precisely when it's needed. Left untouched.
  // ===================================================================================================
  const binSkillMd = "---\nname: refbinary\ndescription: d\n---\n\n# refbinary\n";
  writeFile(assetPath("refbinary", "SKILL.md"), binSkillMd);
  writeFile(storePath("refbinary", "SKILL.md"), binSkillMd);
  writeFile(skillMdBasePath("refbinary"), binSkillMd);
  const binOld = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // NUL-bearing, "binary-looking"
  const binNew = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]); // a "shipped update" to it
  fs.mkdirSync(path.dirname(storePath("refbinary", "assets/icon.png")), { recursive: true });
  fs.writeFileSync(storePath("refbinary", "assets/icon.png"), binOld);
  fs.mkdirSync(path.dirname(assetPath("refbinary", "assets/icon.png")), { recursive: true });
  fs.writeFileSync(assetPath("refbinary", "assets/icon.png"), binNew);

  seedFileBaseSnapshots();
  check("[k] no base snapshot is recorded for a binary file (never tracked)", !fs.existsSync(basePath("refbinary", "assets/icon.png")));
  autoFastForwardPristineSkills();
  check("[k] a binary file is left byte-for-byte untouched (never utf8-mangled)",
    Buffer.compare(fs.readFileSync(storePath("refbinary", "assets/icon.png")), binOld) === 0);
  check("[k] no backup is generated for a binary file either", !fs.existsSync(backupPath("refbinary", "assets/icon.png")));

  // ===================================================================================================
  // (l) mdCustomized PIN (CR round 2 Minor #1) — the exact banner-suppression condition M3 relies on:
  //     SKILL.md pristine, but a reference file IS customized (the user's edit is real and preserved).
  //     Before this pin, `mdCustomized` had zero coverage — a later refactor that collapsed it back to
  //     the OR'd `customized` aggregate would re-land M3 (the destructive "sync to shipped" banner
  //     offered behind an empty SKILL.md diff) with a fully green suite. Pinned here, not inferred.
  // ===================================================================================================
  const mdSkillMd = "---\nname: refmdpin\ndescription: d\n---\n\n# refmdpin\n";
  writeFile(assetPath("refmdpin", "SKILL.md"), mdSkillMd);
  writeFile(storePath("refmdpin", "SKILL.md"), mdSkillMd); // SKILL.md itself fully pristine
  writeFile(skillMdBasePath("refmdpin"), mdSkillMd);
  writeFile(assetPath("refmdpin", "references/doc.md"), "ORIGINAL doctrine.\n");
  writeFile(storePath("refmdpin", "references/doc.md"), "ORIGINAL doctrine, USER EDITED.\n"); // mine
  writeFile(basePath("refmdpin", "references/doc.md"), "ORIGINAL doctrine.\n");                // base != mine -> customized

  check("[l] the aggregate reads customized:true (the reference edit is visible, not swallowed)",
    state("refmdpin").customized === true);
  check("[l] THE PIN: mdCustomized reads false — SKILL.md itself is untouched (the banner-suppression condition)",
    state("refmdpin").mdCustomized === false);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — reference/script files fast-forward per-file on both the boot and manual-adopt paths, user edits are preserved, EOL-only skew never churns, and a first-time advance leaves a recoverable backup."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
