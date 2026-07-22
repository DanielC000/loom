import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c01fd791 — the per-file compare/resolve surface for a bundled skill's reference/script files.
//
// PREDECESSOR (75a0755d) taught the DAEMON to track the whole skill directory, but left the compare VIEW
// SKILL.md-only. That produced three residual states, of which the third was a genuine dead end: a
// reference file that is BOTH customized AND has a shipped update shows a badge, but Adopt advances
// nothing (advancePristineExtraFiles correctly refuses to overwrite a user edit) — so THE BADGE NEVER
// CLEARS, and the only escape was Reset, a whole-directory discard. These files have no editor, so the
// user could not even see what a discard would take.
//
// THE FIX under test here:
//  - `skillUpdateDiff` additionally reports `files` — a content-free per-file {path, customized,
//    updateAvailable} summary across the WHOLE directory (SKILL.md first). Content stays out of it on
//    purpose: `listSkills` already walks each skill dir, so the compare read must not inflate too.
//  - `skillFileDiff(name, relPath)` serves ONE file's three versions on demand (the content tier), plus
//    a `shippedHash` identity token.
//  - `resolveSkillFile(name, relPath, take, hash)` resolves ONE file:
//      take:"mine"    -> base := shipped ONLY; `mine` stays BYTE-IDENTICAL. Nothing is discarded, so it
//                        must ALSO leave NO .pre-ff-backups entry — a backup there would misrepresent
//                        itself as a copy of something overwritten. THIS is state 3's escape hatch.
//      take:"shipped" -> advanceExtraFile (takes the pre-overwrite backup first). One file, never the dir.
//
// TOCTOU (the reason `shippedHash` is required, not an optimization): per CLAUDE.md, `assets/**` is read
// LIVE from the package dir, so an asset merge takes effect with NO daemon restart. Between the user
// reading a diff and clicking a button, `shipped` can change underneath them — and take:"shipped" would
// then overwrite `mine` with content the displayed diff never showed. That is a discard behind a diff
// that no longer shows what is being discarded: precisely the defect this card closes, reappearing as a
// race. Guarded for BOTH takes (take:"mine" writes base := shipped, so it can otherwise silently record
// a base the user never saw — same class, lower stakes). Exercised for real below by mutating the asset
// between the read and the resolve.
//
// PATH VALIDATION is a MEMBERSHIP test against the live server-derived tracked-file set, never string
// sanitization — the caller names a choice from a set, not a path. Traversal, absolute paths, and merely-
// untracked files all fail the same check. Pinned below, including a traversal attempt through the REST
// route (the one an attacker would actually reach).
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-filediff-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
const backupDir = path.join(baseDir, ".pre-ff-backups");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45437";
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { listSkills, skillUpdateDiff, skillFileDiff, resolveSkillFile } = store;
const { buildServer } = await import("../dist/gateway/server.js");
const { Db } = await import("../dist/db.js");

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
const fileEntry = (name, relPath) => (skillUpdateDiff(name)?.files ?? []).find((f) => f.path === relPath);

// A bundled skill whose SKILL.md is fully pristine, with one reference file in a caller-chosen state.
const makeSkill = (name, { mine, base, shipped }) => {
  const md = `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n`;
  writeFile(assetPath(name, "SKILL.md"), md);
  writeFile(storePath(name, "SKILL.md"), md);
  writeFile(skillMdBasePath(name), md);
  writeFile(assetPath(name, "references/doc.md"), shipped);
  writeFile(storePath(name, "references/doc.md"), mine);
  if (base !== undefined) writeFile(basePath(name, "references/doc.md"), base);
};

try {
  // ===================================================================================================
  // (a) THE SUMMARY TIER — per-file flags, and NO file content riding along.
  // ===================================================================================================
  makeSkill("fdsummary", { mine: "USER EDITED.\n", base: "ORIGINAL.\n", shipped: "NEW SHIPPED.\n" });

  const summary = skillUpdateDiff("fdsummary");
  check("[a] skillUpdateDiff still returns SKILL.md's base/shipped (existing banners keep working)",
    typeof summary?.base === "string" && typeof summary?.shipped === "string");
  check("[a] it now also names the specific diverged file", !!fileEntry("fdsummary", "references/doc.md"));
  check("[a] SKILL.md is listed first, and reads pristine (its own pair, not the aggregate)",
    summary.files[0]?.path === "SKILL.md" && summary.files[0]?.customized === false && summary.files[0]?.updateAvailable === false);
  check("[a] the reference file reports BOTH of its own flags (state 3 — the dead-end state)",
    fileEntry("fdsummary", "references/doc.md").customized === true && fileEntry("fdsummary", "references/doc.md").updateAvailable === true);
  check("[a] PAYLOAD: the summary carries flags ONLY — no base/mine/shipped content per file",
    summary.files.every((f) => Object.keys(f).sort().join(",") === "customized,path,updateAvailable"));

  // ===================================================================================================
  // (b) THE CONTENT TIER — one file's three versions, on demand.
  // ===================================================================================================
  const d = skillFileDiff("fdsummary", "references/doc.md");
  check("[b] file-diff returns all three versions, so BOTH sides of the divergence are showable",
    d?.base === "ORIGINAL.\n" && d?.mine === "USER EDITED.\n" && d?.shipped === "NEW SHIPPED.\n");
  check("[b] it carries a shippedHash (the resolve identity token)", typeof d?.shippedHash === "string" && d.shippedHash.length > 0);
  check("[b] SKILL.md is READABLE here too (so the file list renders uniformly)",
    typeof skillFileDiff("fdsummary", "SKILL.md")?.shipped === "string");

  // ===================================================================================================
  // (c) PATH VALIDATION — membership in the server-derived set, not string sanitization.
  // ===================================================================================================
  check("[c] traversal is rejected", skillFileDiff("fdsummary", "../../../../etc/passwd") === null);
  check("[c] a Windows-style traversal is rejected too", skillFileDiff("fdsummary", "..\\..\\secrets.txt") === null);
  check("[c] an absolute path is rejected", skillFileDiff("fdsummary", "/etc/passwd") === null);
  check("[c] a merely-untracked (nonexistent) file is rejected by the SAME check",
    skillFileDiff("fdsummary", "references/not-a-real-file.md") === null);
  check("[c] a './'-prefixed spelling of a real tracked file is rejected — membership is EXACT, not a\n         path-normalizing comparison that could be talked into resolving something else",
    skillFileDiff("fdsummary", "./references/doc.md") === null);
  check("[c] an empty path is rejected", skillFileDiff("fdsummary", "") === null);

  // ===================================================================================================
  // (d) take:"mine" — THE NON-DESTRUCTIVE ESCAPE from state 3. This is the card's core acceptance case:
  //     the badge must clear WITHOUT discarding the user's edit.
  // ===================================================================================================
  makeSkill("fdkeepmine", { mine: "MY EDIT.\n", base: "ORIGINAL.\n", shipped: "NEW SHIPPED.\n" });
  check("[d] precondition: the file is BOTH customized and updateAvailable (the stuck state)",
    fileEntry("fdkeepmine", "references/doc.md").customized === true && fileEntry("fdkeepmine", "references/doc.md").updateAvailable === true);
  check("[d] precondition: the aggregate badge is lit", state("fdkeepmine").updateAvailable === true);

  const keepHash = skillFileDiff("fdkeepmine", "references/doc.md").shippedHash;
  const keepRes = resolveSkillFile("fdkeepmine", "references/doc.md", "mine", keepHash);
  check("[d] resolve take:'mine' succeeds", keepRes.ok === true);
  check("[d] THE POINT: the user's file is left BYTE-IDENTICAL — nothing is discarded",
    fs.readFileSync(storePath("fdkeepmine", "references/doc.md"), "utf8") === "MY EDIT.\n");
  check("[d] base advanced to shipped, so updateAvailable CLEARS — the stuck badge can finally go",
    fileEntry("fdkeepmine", "references/doc.md").updateAvailable === false);
  check("[d] customized STAYS true — honest: their copy really does still differ from shipped",
    fileEntry("fdkeepmine", "references/doc.md").customized === true);
  check("[d] the aggregate 'update available' badge clears too (the user-visible dead end is gone)",
    state("fdkeepmine").updateAvailable === false);
  check("[d] NO .pre-ff-backups entry is written — nothing was overwritten, so a backup would lie",
    !fs.existsSync(backupPath("fdkeepmine", "references/doc.md")));

  // ===================================================================================================
  // (e) take:"shipped" — the destructive option: ONE file, and recoverable.
  // ===================================================================================================
  makeSkill("fdtakeship", { mine: "MY EDIT.\n", base: "ORIGINAL.\n", shipped: "NEW SHIPPED.\n" });
  const shipHash = skillFileDiff("fdtakeship", "references/doc.md").shippedHash;
  const shipRes = resolveSkillFile("fdtakeship", "references/doc.md", "shipped", shipHash);
  check("[e] resolve take:'shipped' succeeds", shipRes.ok === true);
  check("[e] the file is now the shipped content", fs.readFileSync(storePath("fdtakeship", "references/doc.md"), "utf8") === "NEW SHIPPED.\n");
  check("[e] the overwritten content IS recoverable from .pre-ff-backups",
    fs.readFileSync(backupPath("fdtakeship", "references/doc.md"), "utf8") === "MY EDIT.\n");
  check("[e] the file reads fully in-sync afterwards",
    fileEntry("fdtakeship", "references/doc.md").customized === false && fileEntry("fdtakeship", "references/doc.md").updateAvailable === false);
  check("[e] SKILL.md was NOT touched — this resolves ONE file, never the directory",
    state("fdtakeship").mdCustomized === false && fs.existsSync(storePath("fdtakeship", "SKILL.md")));

  // ===================================================================================================
  // (f) THE TOCTOU GUARD — the required addition. Mutate the asset BETWEEN the read and the resolve,
  //     exactly as a live asset merge would (assets/** is read live, no restart).
  // ===================================================================================================
  makeSkill("fdstale", { mine: "MY EDIT.\n", base: "ORIGINAL.\n", shipped: "SHIPPED v1.\n" });
  const staleHash = skillFileDiff("fdstale", "references/doc.md").shippedHash; // what the user SAW
  writeFile(assetPath("fdstale", "references/doc.md"), "SHIPPED v2 — landed after the diff was read.\n");

  const staleShip = resolveSkillFile("fdstale", "references/doc.md", "shipped", staleHash);
  check("[f] take:'shipped' against a stale hash is REFUSED", staleShip.ok === false && staleShip.code === "stale-shipped");
  check("[f] THE POINT: the user's file was NOT overwritten with content the diff never showed",
    fs.readFileSync(storePath("fdstale", "references/doc.md"), "utf8") === "MY EDIT.\n");
  check("[f] the refusal hands back the CURRENT hash so the UI can re-open the diff",
    typeof staleShip.shippedHash === "string" && staleShip.shippedHash.length > 0);

  const staleMine = resolveSkillFile("fdstale", "references/doc.md", "mine", staleHash);
  check("[f] take:'mine' is guarded by the SAME check (it writes base := shipped, so it can record a base the user never saw)",
    staleMine.ok === false && staleMine.code === "stale-shipped");
  check("[f] and no base was recorded from the unseen content",
    fs.readFileSync(basePath("fdstale", "references/doc.md"), "utf8") === "ORIGINAL.\n");

  // A re-read yields a FRESH hash, and the resolve then goes through — the guard is a speed bump for a
  // real race, not a permanent wedge.
  const freshHash = skillFileDiff("fdstale", "references/doc.md").shippedHash;
  check("[f] re-reading the diff yields a DIFFERENT hash (the guard actually tracks content)", freshHash !== staleHash);
  check("[f] and the resolve then succeeds — the guard is recoverable, not a dead end",
    resolveSkillFile("fdstale", "references/doc.md", "mine", freshHash).ok === true);

  // ===================================================================================================
  // (g) REFUSALS — SKILL.md is not resolvable here, and an in-sync file has nothing to resolve.
  // ===================================================================================================
  const mdHash = skillFileDiff("fdsummary", "SKILL.md").shippedHash;
  const mdRes = resolveSkillFile("fdsummary", "SKILL.md", "shipped", mdHash);
  check("[g] SKILL.md is REJECTED by per-file resolve (it has its own adopt/reset flow — one notion of 'resolved')",
    mdRes.ok === false && mdRes.code === "invalid");

  makeSkill("fdinsync", { mine: "SAME.\n", base: "SAME.\n", shipped: "SAME.\n" });
  const syncHash = skillFileDiff("fdinsync", "references/doc.md").shippedHash;
  check("[g] an already-in-sync file 409s rather than doing a pointless write",
    resolveSkillFile("fdinsync", "references/doc.md", "mine", syncHash).code === "not-diverged");

  // ===================================================================================================
  // (h) THE REST ROUTES end-to-end — the surface the web actually calls, including the status codes the
  //     UI branches on and the traversal attempt an attacker would actually reach.
  // ===================================================================================================
  makeSkill("fdrest", { mine: "MY REST EDIT.\n", base: "ORIGINAL.\n", shipped: "NEW REST SHIPPED.\n" });
  const db = new Db(path.join(home, "rest-filediff.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const diffRes = await app.inject({ method: "GET", url: "/api/skills/fdrest/file-diff?path=references%2Fdoc.md" });
  check("[h] GET /file-diff 200s and returns the three versions", diffRes.statusCode === 200 && diffRes.json().mine === "MY REST EDIT.\n");
  const restHash = diffRes.json().shippedHash;

  const travRes = await app.inject({ method: "GET", url: "/api/skills/fdrest/file-diff?path=..%2F..%2F..%2F..%2Fetc%2Fpasswd" });
  check("[h] GET /file-diff 404s a traversal attempt (membership check, no content leak)", travRes.statusCode === 404);
  const noPathRes = await app.inject({ method: "GET", url: "/api/skills/fdrest/file-diff" });
  check("[h] GET /file-diff 400s with no path", noPathRes.statusCode === 400);

  const badTake = await app.inject({ method: "POST", url: "/api/skills/fdrest/file-resolve", payload: { path: "references/doc.md", take: "whatever", shippedHash: restHash } });
  check("[h] POST /file-resolve 400s an unknown `take`", badTake.statusCode === 400);
  const noHash = await app.inject({ method: "POST", url: "/api/skills/fdrest/file-resolve", payload: { path: "references/doc.md", take: "mine" } });
  check("[h] POST /file-resolve 400s with no shippedHash (the guard can't be skipped by omission)", noHash.statusCode === 400);
  const staleRest = await app.inject({ method: "POST", url: "/api/skills/fdrest/file-resolve", payload: { path: "references/doc.md", take: "shipped", shippedHash: "deadbeefdeadbeef" } });
  check("[h] POST /file-resolve 409s a stale shippedHash", staleRest.statusCode === 409);
  check("[h] and the file survived that refusal untouched", fs.readFileSync(storePath("fdrest", "references/doc.md"), "utf8") === "MY REST EDIT.\n");

  const okRest = await app.inject({ method: "POST", url: "/api/skills/fdrest/file-resolve", payload: { path: "references/doc.md", take: "mine", shippedHash: restHash } });
  check("[h] POST /file-resolve 200s on the happy path", okRest.statusCode === 200 && okRest.json().take === "mine");
  check("[h] END-TO-END: the badge clears through the real route while the edit survives",
    state("fdrest").updateAvailable === false && fs.readFileSync(storePath("fdrest", "references/doc.md"), "utf8") === "MY REST EDIT.\n");

  const listAfter = await app.inject({ method: "GET", url: "/api/skills" });
  check("[h] GET /api/skills is UNCHANGED — no per-file payload leaked into the hot list read",
    listAfter.statusCode === 200 && listAfter.json().every((s) => !("files" in s)));
  await app.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the compare view names the specific diverged file and shows both sides; a customized reference file with a pending update resolves NON-DESTRUCTIVELY (badge clears, edit survives, no misleading backup); the shipped-changed-underneath race is refused; and the skills list read is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
