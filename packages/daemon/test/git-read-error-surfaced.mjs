import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 60b53c8d: a failed git READ (branches/log, on the primary repo AND the reference/registered
// repo panels) must surface a NAMED cause, never render as a silent empty repo. Before this fix, all
// four routes let a genuine simple-git throw propagate raw to fastify's default error handler, which
// (verified against the actual fastify 5.8.5 source) sends `{error: "Internal Server Error", message:
// "<real cause>"}` — the generic HTTP reason phrase in `.error`, not the cause. The web client's
// `getErr()` reads `.error`, so pre-fix it would show the SAME boilerplate "Internal Server Error" on
// every failure, not the actual reason — indistinguishable from a bare 500 as far as the user is
// concerned. The fix catches in each route and rebuilds the body via the (now-exported) `gitError()`
// helper shared with the write side, so `.error` carries a real cause.
//
// Reuses the exact `notARepo` fixture proven in git-log-commitless-repo.mjs to make simple-git throw a
// GENUINE error (a real directory that is not a git repo at all) — distinct from the commitless-but-
// real-repo case that file covers, which must keep returning a clean empty array, not an error.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject).
//
// Run: 1) build (turbo builds shared first), 2) node test/git-read-error-surfaced.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-git-read-err-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45324";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// A real directory that is NOT a git repo at all — simple-git genuinely throws on every op against it
// (proven in git-log-commitless-repo.mjs's "pBroken" case), unlike a commitless-but-real `git init` repo.
const notARepo = path.join(os.tmpdir(), `loom-git-read-err-notarepo-${Date.now()}-${process.pid}`);
fs.mkdirSync(notARepo, { recursive: true });
fs.writeFileSync(path.join(notARepo, "file.txt"), "not a repo\n");

const now = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, "giterr.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  try {
    db.insertProject({
      id: "pBroken", name: "Broken", repoPath: notARepo, vaultPath: notARepo,
      config: {}, createdAt: now, archivedAt: null, reserved: false,
      referenceRepos: [notARepo],
      repos: [{ key: "svc-broken", path: notARepo }],
    });

    const routes = [
      ["primary log", "/api/projects/pBroken/git/log"],
      ["primary branches", "/api/projects/pBroken/git/branches"],
      ["reference-repo log", "/api/projects/pBroken/git/reference-repos/0/log"],
      ["registered-repo log", "/api/projects/pBroken/git/repos/0/log"],
    ];

    for (const [label, url] of routes) {
      const res = await app.inject({ method: "GET", url });
      check(`${label}: not a 200 (genuine failure still errors)`, res.statusCode !== 200);
      let body;
      try { body = res.json(); } catch { body = null; }
      const errText = body && typeof body.error === "string" ? body.error : "";
      // The negative assertion is what actually pins the bug: pre-fix, fastify's default error handler
      // puts the generic HTTP reason phrase in `.error` (the real cause sits in `.message`, which the
      // client never reads) — so this exact string is what a REGRESSION would reintroduce.
      check(`${label}: body.error is NOT the generic "Internal Server Error" boilerplate`, errText !== "Internal Server Error");
      check(`${label}: body.error names a real cause (not empty, not a bare URL echo)`, errText.length > 0 && !errText.includes(url));
      check(`${label}: body.error mentions the actual git failure ("repository")`, /repository/i.test(errText));
    }
  } finally {
    db.close();
  }
} finally {
  for (const d of [tmpHome, notARepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — all four git-read routes (primary log/branches, reference-repo log, registered-repo log) surface a NAMED cause on a genuine git failure instead of fastify's generic 'Internal Server Error' boilerplate or a bare URL echo; claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
