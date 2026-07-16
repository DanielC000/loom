import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Reference-repos epic Phase 5 (card f4888775, "Interpretation A"): a read-only git-log view PER
// reference repo, reusing the SAME GitReader the existing /api/projects/:id/git/log endpoint uses.
// Phases 1-4 are merged (the referenceRepos: string[] field, its REST validator, kickoff injection, and
// the Project-settings list editor). HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on
// reference-repos-rest.mjs (Db + buildServer via app.inject) + project-rebind.mjs.
//
// Proves the DoD's load-bearing security requirement — the new endpoint
// GET /api/projects/:id/git/reference-repos/:index/log serves a log ONLY for a repo that is a member of
// the project's OWN referenceRepos[], resolved SERVER-SIDE from a client-supplied INDEX (never a path):
//   (1) a valid index returns the SAME shape/content GitReader().log() returns for the primary repo.
//   (2) an out-of-range index (>= length), a negative index, and a non-integer index ALL 404 —
//       proven by observing there is no way for the response to reflect ANY repo's commits (the response
//       body carries the specific 404 reason, not a git log), so GitReader is never reached with a
//       client-controlled path.
//   (3) each reference repo resolves to its OWN distinct log (index 0 != index 1), confirming the index
//       is not just accepted but actually threaded through to the right path.
//   (4) a project with an EMPTY referenceRepos rejects every index, including 0.
//
// Run: 1) build (turbo builds shared first), 2) node test/reference-repos-git-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-refrepos-gitlog-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45322";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// --- Real temp git repos: a primary + two distinct reference repos (different commit messages, so a
// log mix-up between them is directly observable), plus a real dir that is NOT a git repo. ---
const mkRepo = (tag, msg) => {
  const r = path.join(os.tmpdir(), `loom-refrepos-gitlog-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m "${msg}"`, { cwd: r });
  return r;
};
const primary = mkRepo("primary", "primary init");
const refA = mkRepo("refA", "refA distinctive commit");
const refB = mkRepo("refB", "refB distinctive commit");

const now = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, "gitlog.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  try {
    db.insertProject({ id: "pBound", name: "Bound", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [refA, refB] });
    db.insertProject({ id: "pEmpty", name: "Empty", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [] });

    // (1) a valid index (0) returns refA's own log — same shape as the primary-repo endpoint.
    const logA = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/0/log" });
    check("(1) valid index 0 → 200", logA.statusCode === 200);
    const commitsA = logA.json();
    check("(1) response is an array of commits", Array.isArray(commitsA) && commitsA.length === 1);
    check("(1) commit shape matches GitReader().log() (hash/date/message/author)",
      typeof commitsA[0]?.hash === "string" && typeof commitsA[0]?.date === "string" &&
      typeof commitsA[0]?.message === "string" && typeof commitsA[0]?.author === "string");
    check("(1) log content is refA's OWN commit", commitsA[0].message === "refA distinctive commit");

    // (3) index 1 resolves to refB's DISTINCT log — proves the index is actually threaded to the right path.
    const logB = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/1/log" });
    check("(3) valid index 1 → 200", logB.statusCode === 200);
    const commitsB = logB.json();
    check("(3) index 1 returns refB's OWN (distinct) commit", commitsB[0]?.message === "refB distinctive commit");
    check("(3) refA and refB logs are NOT the same content", commitsA[0].hash !== commitsB[0].hash);

    // (2) SECURITY — every out-of-allowlist index is REJECTED, never reaching GitReader with a bad path.
    const outOfRange = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/2/log" });
    check("(2) out-of-range index (== length) → 404", outOfRange.statusCode === 404);
    check("(2) 404 names the reason, not a git log", /not found/.test(outOfRange.json().error ?? ""));

    const wayOutOfRange = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/99/log" });
    check("(2) far out-of-range index → 404", wayOutOfRange.statusCode === 404);

    const negative = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/-1/log" });
    check("(2) negative index → 404", negative.statusCode === 404);

    const nonInteger = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/1.5/log" });
    check("(2) non-integer index → 404", nonInteger.statusCode === 404);

    const nonNumeric = await app.inject({ method: "GET", url: "/api/projects/pBound/git/reference-repos/not-a-number/log" });
    check("(2) non-numeric index → 404", nonNumeric.statusCode === 404);

    // (4) a project with an EMPTY referenceRepos rejects even index 0 — there is nothing to serve.
    const emptyProject = await app.inject({ method: "GET", url: "/api/projects/pEmpty/git/reference-repos/0/log" });
    check("(4) index 0 on a project with an empty referenceRepos → 404", emptyProject.statusCode === 404);

    // Unknown project id still 404s the same way the primary-repo endpoint does.
    const unknownProject = await app.inject({ method: "GET", url: "/api/projects/does-not-exist/git/reference-repos/0/log" });
    check("unknown project id → 404", unknownProject.statusCode === 404);
  } finally {
    db.close();
  }
} finally {
  for (const d of [tmpHome, primary, refA, refB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the reference-repo git-log endpoint resolves a CLIENT-SUPPLIED INDEX into the project's OWN referenceRepos[] server-side (reusing GitReader), returns each bound repo's own distinct log, and REJECTS (404) every out-of-allowlist index — negative, non-integer, non-numeric, in-range-of-length, and any index against an empty referenceRepos — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
