// Card 8b38b920: the human-only REST surface over the released/readopted mechanism — GET .../skills/
// released, GET .../skills/:name/released-diff (+ ?path=), POST .../skills/:name/readopt. Mirrors
// skills-provenance-integrity.mjs's own REST harness (buildServer + app.inject, a real Db, no booted
// daemon). Fully hermetic: useOwnLoomHome BEFORE importing dist. Run after build:
//   node test/skills-released-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = useOwnLoomHome("loom-8b38b920-rest-", { fresh: true }); // BEFORE importing dist
process.env.LOOM_PORT = String(hermeticPort());
const skillsDir = path.join(home, "skills");
fs.mkdirSync(path.join(skillsDir, "loom-x"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v1\n---\nV1 BODY");

const { injectSkills, fingerprintSkillDir } = await import("../dist/skills/inject.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// card 8b38b920 fix round 3 (nit): mirrors skills-released-readopt.mjs's own `buildMutant` — copy the
// REAL dist gateway/server.js into a sibling file with exactly one text substitution, import it (relative
// imports still resolve: the mutant sits alongside the original), and build a server from ITS exported
// `buildServer`. Proves the `|| r.code === "track-unknown"` clause in the readopt route's status-code
// mapping is load-bearing, not merely present.
const DIST_GATEWAY_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "gateway");
const REAL_SERVER = path.join(DIST_GATEWAY_DIR, "server.js");
const mutantFiles = [];
async function buildServerMutant(label, oldStr, newStr) {
  const src = fs.readFileSync(REAL_SERVER, "utf8");
  const occurrences = src.split(oldStr).length - 1;
  if (occurrences !== 1) throw new Error(`buildServerMutant(${label}): expected exactly 1 occurrence of oldStr, found ${occurrences}`);
  const mutated = src.replace(oldStr, newStr);
  const mutantPath = path.join(DIST_GATEWAY_DIR, `server.mutant-${label}-${Date.now()}-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(mutantPath, mutated);
  mutantFiles.push(mutantPath);
  return import(`file://${mutantPath.replace(/\\/g, "/")}`);
}
function cleanupMutants() { for (const p of mutantFiles) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } } mutantFiles.length = 0; }

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function initRepo(cwd) {
  execFileSync("git", ["init", "-q"], { cwd, env: GIT_ENV });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd, env: GIT_ENV });
  execFileSync("git", ["config", "user.name", "t"], { cwd, env: GIT_ENV });
}

const repoDir = mkdtempManaged("loom-8b38b920-rest-repo-"); // no real git — the ordinary tests below are untracked-by-construction (no .git anywhere up-tree ⇒ gitTrackedState's/batchGitTrackedStates' own fast path); the dedicated git-tracked REST scenario further down sets up its own real repo
const dbPath = path.join(os.tmpdir(), `loom-8b38b920-rest-db-${Date.now()}-${process.pid}.sqlite`);
const db = new Db(dbPath);
const now = new Date().toISOString();
db.insertProject({ id: "proj-rest", name: "Rest Test", repoPath: repoDir, vaultPath: repoDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
const vaultOnlyDir = path.join(os.tmpdir(), `loom-8b38b920-rest-vault-${Date.now()}-${process.pid}`);
db.insertProject({ id: "proj-vault-only", name: "Vault Only", repoPath: "", vaultPath: vaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false });

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

try {
  // Release "loom-x" at repoDir via the real mechanism (a live session claims it, then hand-edits).
  injectSkills(repoDir, "sess-rest", null, "manager");
  fs.writeFileSync(path.join(repoDir, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED VIA REST SCENARIO");
  injectSkills(repoDir, "sess-rest", null, "manager"); // releases it

  // --- GET .../skills/released ---
  const listRes = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/released" });
  check("GET released: 200", listRes.statusCode === 200);
  const listBody = listRes.json();
  check("GET released: lists loom-x with reason modified", listBody.released.some((r) => r.name === "loom-x" && r.reason === "modified"));
  check("GET released: tracked:\"untracked\" for an untracked repo", listBody.released.some((r) => r.name === "loom-x" && r.tracked === "untracked"));

  const listVaultOnly = await app.inject({ method: "GET", url: "/api/projects/proj-vault-only/skills/released" });
  check("GET released (vault-only project): 200, empty list", listVaultOnly.statusCode === 200 && listVaultOnly.json().released.length === 0);

  const listNoProj = await app.inject({ method: "GET", url: "/api/projects/nope/skills/released" });
  check("GET released: unknown project 404s", listNoProj.statusCode === 404);

  // --- GET .../skills/:name/released-diff ---
  const diffRes = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/loom-x/released-diff" });
  check("GET released-diff: 200", diffRes.statusCode === 200);
  const diffBody = diffRes.json();
  check("GET released-diff: reason + firstSeenAt + currentFingerprint", diffBody.reason === "modified" && typeof diffBody.firstSeenAt === "number" && typeof diffBody.currentFingerprint === "string");
  check("GET released-diff: tracked:\"untracked\" for an untracked repo", diffBody.tracked === "untracked");
  check("GET released-diff: files includes SKILL.md, differs", diffBody.files.some((f) => f.path === "SKILL.md" && f.differs === true));

  const diffFileRes = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/loom-x/released-diff?path=SKILL.md" });
  check("GET released-diff?path=: 200, onDisk reflects the hand edit", diffFileRes.statusCode === 200 && diffFileRes.json().onDisk === "HAND EDITED VIA REST SCENARIO");

  const diffBadName = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/not-a-valid-name!!/released-diff" });
  check("GET released-diff: invalid skill name 400s", diffBadName.statusCode === 400);

  const diffNotReleased = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/loom-y/released-diff" });
  check("GET released-diff: a name not currently released 404s", diffNotReleased.statusCode === 404);

  // card 8b38b920 CR fix round, item 3: REST-level path traversal — `releasedSkillDiffFile`'s own
  // membership check already closes this at the function layer (see skills-released-readopt.mjs), but
  // nothing until now proved the REST route itself refuses it end-to-end.
  const diffTraversal = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/loom-x/released-diff?path=" + encodeURIComponent("../../../../etc/passwd") });
  check("GET released-diff?path=: REST-level traversal 404s (not a tracked file)", diffTraversal.statusCode === 404);

  // --- POST .../skills/:name/readopt ---
  const refusedRes = await app.inject({ method: "POST", url: "/api/projects/proj-rest/skills/loom-x/readopt", payload: { fingerprint: "0".repeat(64) } });
  check("POST readopt: a stale/wrong fingerprint is REFUSED (409)", refusedRes.statusCode === 409);
  check("POST readopt: refusal leaves disk untouched", fs.readFileSync(path.join(repoDir, ".claude", "skills", "loom-x", "SKILL.md"), "utf8") === "HAND EDITED VIA REST SCENARIO");

  const noFingerprintRes = await app.inject({ method: "POST", url: "/api/projects/proj-rest/skills/loom-x/readopt", payload: {} });
  check("POST readopt: missing fingerprint 400s", noFingerprintRes.statusCode === 400);

  // card 8b38b920 CR fix round, item 3: REST-level invalid skill name on the readopt route itself.
  const readoptBadName = await app.inject({ method: "POST", url: "/api/projects/proj-rest/skills/not-a-valid-name!!/readopt", payload: { fingerprint: "0".repeat(64) } });
  check("POST readopt: invalid skill name 400s", readoptBadName.statusCode === 400);

  const okRes = await app.inject({ method: "POST", url: "/api/projects/proj-rest/skills/loom-x/readopt", payload: { fingerprint: diffBody.currentFingerprint } });
  check("POST readopt: the correct fingerprint succeeds (200)", okRes.statusCode === 200 && okRes.json().ok === true);
  const afterBody = fs.readFileSync(path.join(repoDir, ".claude", "skills", "loom-x", "SKILL.md"), "utf8");
  check("POST readopt: disk now reflects the current store copy", afterBody.includes("V1 BODY"));

  const afterListRes = await app.inject({ method: "GET", url: "/api/projects/proj-rest/skills/released" });
  check("GET released after readopt: no longer listed", !afterListRes.json().released.some((r) => r.name === "loom-x"));

  const secondReadoptRes = await app.inject({ method: "POST", url: "/api/projects/proj-rest/skills/loom-x/readopt", payload: { fingerprint: diffBody.currentFingerprint } });
  check("POST readopt: a second attempt on an already-resolved name 404s (not-released)", secondReadoptRes.statusCode === 404);

  // the bridge: a fresh live session must now claim the re-adopted name.
  const rClaim = injectSkills(repoDir, "fresh-sess-rest", null, "manager", false, () => true);
  check("the re-adopted name is claimed by the next live session", rClaim.claimedNames.includes("loom-x"));
  void fingerprintSkillDir; // imported for parity with the direct-function test; not independently asserted here

  // =====================================================================================================
  // card 8b38b920 CR fix round, item 4 (LEAD DECISION): a git-tracked released dir is refused via REST
  // too, mapped to 409 with code "tracked" — exercised at the REST layer, not just the direct function
  // (see skills-released-readopt.mjs's own section 10 for the mutant-proven direct-function coverage).
  // =====================================================================================================
  const trackedRepoDir = mkdtempManaged("loom-8b38b920-rest-tracked-");
  initRepo(trackedRepoDir);
  db.insertProject({ id: "proj-tracked", name: "Tracked Test", repoPath: trackedRepoDir, vaultPath: trackedRepoDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
  injectSkills(trackedRepoDir, "sess-tracked", null, "manager");
  const trackedSkillPath = path.join(trackedRepoDir, ".claude", "skills", "loom-x", "SKILL.md");
  fs.writeFileSync(trackedSkillPath, "HAND EDITED, THEN GIT-ADDED (REST)");
  execFileSync("git", ["add", "-f", trackedSkillPath], { cwd: trackedRepoDir, env: GIT_ENV });
  execFileSync("git", ["commit", "-m", "track the hand edit"], { cwd: trackedRepoDir, env: GIT_ENV });
  injectSkills(trackedRepoDir, "sess-tracked", null, "manager"); // releases it ("modified")

  const trackedDiffRes = await app.inject({ method: "GET", url: "/api/projects/proj-tracked/skills/loom-x/released-diff" });
  check("GET released-diff (tracked repo): tracked:\"tracked\"", trackedDiffRes.json().tracked === "tracked");

  const trackedReadoptRes = await app.inject({ method: "POST", url: "/api/projects/proj-tracked/skills/loom-x/readopt", payload: { fingerprint: trackedDiffRes.json().currentFingerprint } });
  check("POST readopt (tracked repo): refused (409)", trackedReadoptRes.statusCode === 409);
  check("POST readopt (tracked repo): refusal leaves disk untouched", fs.readFileSync(trackedSkillPath, "utf8") === "HAND EDITED, THEN GIT-ADDED (REST)");

  // =====================================================================================================
  // card 8b38b920 fix round 3 (nit): a "track-unknown" refusal (CR fix round 2, item 3's tri-state —
  // see skills-released-readopt.mjs's own section 11 for the direct-function coverage) had no REST case.
  // Same FILE-shaped `.git` (no trustedMainRoot) fail-closed shape — canonicalGit refuses outright, so the
  // tracked-check can never confirm either way.
  // =====================================================================================================
  const unknownRepoDir = mkdtempManaged("loom-8b38b920-rest-unknown-");
  fs.writeFileSync(path.join(unknownRepoDir, ".git"), "gitdir: ../nonexistent-main/.git\n");
  db.insertProject({ id: "proj-unknown", name: "Unknown Test", repoPath: unknownRepoDir, vaultPath: unknownRepoDir, config: {}, createdAt: now, archivedAt: null, reserved: false });
  injectSkills(unknownRepoDir, "sess-unknown", null, "manager");
  const unknownSkillPath = path.join(unknownRepoDir, ".claude", "skills", "loom-x", "SKILL.md");
  fs.writeFileSync(unknownSkillPath, "HAND EDITED, UNVERIFIABLE TRACKED STATE (REST)");
  injectSkills(unknownRepoDir, "sess-unknown", null, "manager"); // releases it ("modified")

  const unknownDiffRes = await app.inject({ method: "GET", url: "/api/projects/proj-unknown/skills/loom-x/released-diff" });
  check("GET released-diff (unverifiable repo): tracked:\"unknown\"", unknownDiffRes.json().tracked === "unknown");

  const unknownReadoptRes = await app.inject({ method: "POST", url: "/api/projects/proj-unknown/skills/loom-x/readopt", payload: { fingerprint: unknownDiffRes.json().currentFingerprint } });
  check("POST readopt (unverifiable repo): refused (409), code \"track-unknown\"", unknownReadoptRes.statusCode === 409);
  check("POST readopt (unverifiable repo): the refusal message is honest, never a false 'tracked' claim", /could not verify/.test(unknownReadoptRes.json().error));
  check("POST readopt (unverifiable repo): refusal leaves disk untouched", fs.readFileSync(unknownSkillPath, "utf8") === "HAND EDITED, UNVERIFIABLE TRACKED STATE (REST)");

  // *** MUTANT PROOF ***: drop `|| r.code === "track-unknown"` from the status-code mapping — the route's
  // `if (!r.ok)` branch still runs (the function + every other refusal code are untouched), but a
  // "track-unknown" result now falls through to the `: 500` default instead of 409, turning an honest,
  // disclosed refusal into an uncaught-looking 500. Proves that clause load-bearing, not merely present.
  const serverM = await buildServerMutant(
    "track-unknown",
    `r.code === "fingerprint-mismatch" || r.code === "tracked" || r.code === "track-unknown" ? 409 : 500;`,
    `r.code === "fingerprint-mismatch" || r.code === "tracked" ? 409 : 500; /* MUTANT: track-unknown dropped from the 409 bucket */`,
  );
  const appM = await serverM.buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const mutantReadoptRes = await appM.inject({ method: "POST", url: "/api/projects/proj-unknown/skills/loom-x/readopt", payload: { fingerprint: unknownDiffRes.json().currentFingerprint } });
    check("*** MUTANT PROOF ***: with \"track-unknown\" dropped from the 409 bucket, the same refusal now 500s", mutantReadoptRes.statusCode === 500);
  } finally {
    await appM.close();
    cleanupMutants();
  }

  // =====================================================================================================
  // card 8b38b920 CR fix round, item 2 (MAJOR): a `.claude` junction escaping the project's repoPath must
  // be refused on EVERY one of these three routes, never read or written through — mirrors
  // skills-inject-symlink-escape.mjs's own case (A) (a junction needs no elevation on Windows, so this
  // always runs, no host-privilege skip needed). The escaped target is seeded with real content (not
  // empty) so the checks below actually discriminate guarded-vs-unguarded.
  // @decision 8b38b920 — don't weaken either resolveSkillsTargetDir or perSkillDirEscapes because the
  // other also covers diff/readopt (defense in depth); this test accepts either refusal wording for them.
  // =====================================================================================================
  const jRoot = mkdtempManaged("loom-8b38b920-rest-junction-");
  const jRepo = path.join(jRoot, "repo");
  fs.mkdirSync(jRepo, { recursive: true });
  const jElsewhere = path.join(jRoot, "elsewhere");
  const jElsewhereSkills = path.join(jElsewhere, "skills");
  fs.mkdirSync(path.join(jElsewhereSkills, "loom-x"), { recursive: true });
  const jSeedSkillBody = "SEEDED AT THE ESCAPED TARGET — must never be read or overwritten through the junction";
  fs.writeFileSync(path.join(jElsewhereSkills, "loom-x", "SKILL.md"), jSeedSkillBody);
  const jSeedFingerprintsPath = path.join(jElsewhereSkills, ".loom-skills-fingerprints.json");
  fs.writeFileSync(jSeedFingerprintsPath, JSON.stringify({ __released: { "loom-x": { reason: "modified", firstSeenAt: Date.now() } } }));
  fs.symlinkSync(jElsewhere, path.join(jRepo, ".claude"), process.platform === "win32" ? "junction" : "dir");
  db.insertProject({ id: "proj-junction", name: "Junction Test", repoPath: jRepo, vaultPath: jRepo, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const jListRes = await app.inject({ method: "GET", url: "/api/projects/proj-junction/skills/released" });
  check("JUNCTION: GET released refuses cleanly (200, empty list — never reads the SEEDED release record through the escaped link)", jListRes.statusCode === 200 && jListRes.json().released.length === 0);

  const jDiffRes = await app.inject({ method: "GET", url: "/api/projects/proj-junction/skills/loom-x/released-diff" });
  check("JUNCTION: GET released-diff 404s (never reads the SEEDED record through the escaped link)", jDiffRes.statusCode === 404);

  const jReadoptRes = await app.inject({ method: "POST", url: "/api/projects/proj-junction/skills/loom-x/readopt", payload: { fingerprint: "0".repeat(64) } });
  // Two independent escape checks can refuse this: resolveSkillsTargetDir's own ancestor check (item 2,
  // "could not be safely resolved") or the per-name-dir check (item 5, "itself a symlink/junction
  // escaping") — either is a genuine escape refusal (code "copy-failed" -> 500); accept either wording,
  // but a "fingerprint-mismatch"/"tracked" 409 here would mean BOTH escape checks were bypassed.
  const jReadoptErr = jReadoptRes.json().error ?? "";
  check("JUNCTION: POST readopt refuses via an escape check (500 copy-failed), not merely a fingerprint mismatch against the seeded record", jReadoptRes.statusCode === 500 && (/could not be safely resolved/.test(jReadoptErr) || /itself a symlink\/junction escaping/.test(jReadoptErr)));
  check("JUNCTION: the seeded SKILL.md at the escaped target is byte-identical after every attempt (never read or overwritten through the junction)", fs.readFileSync(path.join(jElsewhereSkills, "loom-x", "SKILL.md"), "utf8") === jSeedSkillBody);
  check("JUNCTION: the seeded fingerprints sidecar at the escaped target is untouched (still shows loom-x released, never cleared by a bypassed readopt)", JSON.parse(fs.readFileSync(jSeedFingerprintsPath, "utf8")).__released["loom-x"].reason === "modified");

  console.log(failures === 0
    ? "\n✅ ALL PASS — the human-only REST surface over released/readopted skill copies lists, diffs, and (fingerprint- and tracked-gated) re-adopts correctly, scoped per project, and refuses a `.claude` junction escape on every route."
    : `\n❌ ${failures} FAILURE(S)`);
} finally {
  await app.close();
  db.close?.();
}
process.exit(failures === 0 ? 0 : 1);
