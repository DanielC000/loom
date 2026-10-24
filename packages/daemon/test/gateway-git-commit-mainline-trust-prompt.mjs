import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40646822 — `POST /api/projects/:id/git/commit` (gateway/server.ts) now carries
// `willFreezeMainlineTrust: true` on an OK response when the commit just landed on the branch the
// mainline watermark for (projectId, "primary") currently trusts (see
// docs/decisions/40646822-rest-commit-mainline-trust-freeze-prompt.md, following card 8418479f's
// decision that the REST commit route must NOT itself become a trust writer). This is a pure UX
// signal: the route never writes a trust/ledger row of its own — it only READS the same two sources
// the mainline-watermark/reset route and `Db.purgeMainlineWatermarkState` already read
// (`readMainlineHead` for the live checked-out branch, the watermark row for the trusted branch) and
// compares them.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject, modeled on
// gateway-reserved-home-git-refusal.mjs). Own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv) —
// NEVER the real ~/.loom. No pty/session spawn of any kind (stub pty/sessions), so no first-run marker
// is needed.
//
// Covers:
//   (S1) POSITIVE: watermark established on the LIVE checked-out branch ⇒ an ok commit's response
//        carries `willFreezeMainlineTrust: true`.
//   (S2) NEGATIVE — no watermark yet (first sight, nothing to freeze): field is ABSENT (not merely
//        falsy) on an ok commit.
//   (S3) NEGATIVE — watermark exists but for a DIFFERENT branch than the one actually checked out (the
//        separate branch-diverted hazard, out of this card's scope): field is ABSENT.
//   (S4) NEGATIVE — a failed commit (nothing to commit): `ok:false`, field ABSENT, and no git read was
//        even attempted to produce it.
// Run: 1) build (pnpm build), 2) node test/gateway-git-commit-mainline-trust-prompt.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-gw-mtp-", { fresh: true }));

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const IDENT = { GIT_AUTHOR_NAME: "mtp", GIT_AUTHOR_EMAIL: "mtp@loom", GIT_COMMITTER_NAME: "mtp", GIT_COMMITTER_EMAIL: "mtp@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "mtp@loom");
  git(dir, "config", "user.name", "mtp");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}

const fixturesRoot = fs.realpathSync(mkdtempManaged("loom-gw-mtp-fixtures-"));
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const MW = await import("../dist/git/mainline-watch.js");

const now = new Date().toISOString();
const db = new Db();
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

function makeProject(id, repoPath) {
  db.insertProject({ id, name: id, repoPath, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
}

try {
  // ===== (S1) POSITIVE: watermark on the live checked-out branch =====
  const repo1 = path.join(fixturesRoot, "repo1");
  initRepo(repo1);
  const head1 = git(repo1, "rev-parse", "HEAD");
  makeProject("pS1", repo1);
  db.setMeta(MW.mainlineWatermarkKey("pS1", "primary"), JSON.stringify({ branch: "main", sha: head1 }));
  fs.writeFileSync(path.join(repo1, "change.txt"), "s1\n");
  const r1 = (await app.inject({ method: "POST", url: "/api/projects/pS1/git/commit", payload: { message: "s1 commit" } })).json();
  check("(S1) commit succeeds", r1.ok === true && typeof r1.hash === "string");
  check("(S1) willFreezeMainlineTrust is present and true", r1.willFreezeMainlineTrust === true);

  // ===== (S2) NEGATIVE: no watermark established yet =====
  const repo2 = path.join(fixturesRoot, "repo2");
  initRepo(repo2);
  makeProject("pS2", repo2);
  // Deliberately NO db.setMeta call for pS2's watermark — first sight.
  fs.writeFileSync(path.join(repo2, "change.txt"), "s2\n");
  const r2 = (await app.inject({ method: "POST", url: "/api/projects/pS2/git/commit", payload: { message: "s2 commit" } })).json();
  check("(S2) commit succeeds", r2.ok === true && typeof r2.hash === "string");
  check("(S2) willFreezeMainlineTrust is ABSENT (no watermark yet ⇒ nothing to freeze)", !("willFreezeMainlineTrust" in r2));

  // ===== (S3) NEGATIVE: watermark exists but names a DIFFERENT branch (branch-diverted, not this card) =====
  const repo3 = path.join(fixturesRoot, "repo3");
  initRepo(repo3);
  const head3 = git(repo3, "rev-parse", "HEAD");
  makeProject("pS3", repo3);
  db.setMeta(MW.mainlineWatermarkKey("pS3", "primary"), JSON.stringify({ branch: "some-other-branch", sha: head3 }));
  fs.writeFileSync(path.join(repo3, "change.txt"), "s3\n");
  const r3 = (await app.inject({ method: "POST", url: "/api/projects/pS3/git/commit", payload: { message: "s3 commit" } })).json();
  check("(S3) commit succeeds", r3.ok === true && typeof r3.hash === "string");
  check("(S3) willFreezeMainlineTrust is ABSENT (live branch \"main\" != watermark's \"some-other-branch\")", !("willFreezeMainlineTrust" in r3));

  // ===== (S4) NEGATIVE: a failed commit (clean tree, nothing staged) never carries the field =====
  const repo4 = path.join(fixturesRoot, "repo4");
  initRepo(repo4);
  const head4 = git(repo4, "rev-parse", "HEAD");
  makeProject("pS4", repo4);
  db.setMeta(MW.mainlineWatermarkKey("pS4", "primary"), JSON.stringify({ branch: "main", sha: head4 }));
  // No file change made — the working tree is clean, so GitWriter.commit refuses before any git-write.
  const r4 = (await app.inject({ method: "POST", url: "/api/projects/pS4/git/commit", payload: { message: "nothing to commit" } })).json();
  check("(S4) commit fails as expected (clean tree)", r4.ok === false && typeof r4.error === "string");
  check("(S4) willFreezeMainlineTrust is ABSENT on a failed commit", !("willFreezeMainlineTrust" in r4));
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — POST .../git/commit carries willFreezeMainlineTrust:true exactly when the commit landed on the branch the mainline watermark currently trusts; absent on first-sight (no watermark), on a branch-diverted watermark, and on a failed commit."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
